// The WhatsApp channel of the communication module, on top of the provider
// seam (src/integrations/whatsapp/provider.mjs):
//
// - delivery: the dispatcher hands it queued WhatsApp ledger rows. Right
//   before sending it checks again that WhatsApp is on, the member still
//   allows it, has a usable number, and the provider template is still
//   approved — otherwise the message is skipped, never failed;
// - the provider's webhook: delivery receipts move the ledger forward, and
//   a member replying STOP / ACHA is opted out of all WhatsApp messages
//   (START / ANZA lifts it);
// - the admin side: status, the kill switch
//   (PlatformSettings.communications.whatsappEnabled), the registry of
//   provider-approved templates, and a test send.
//
// Nothing here knows which provider is behind it.
import { randomUUID } from 'node:crypto';
import { channelAllowed, LOCALES, TEMPLATE_VARIABLES, variablesIn } from '../shared/communications.mjs';
import { SYSTEM_TEMPLATES } from '../shared/communication-templates.mjs';
import { maskPhone, storedDigitVariants } from '../shared/phone.mjs';
import { ERRORS } from '../integrations/whatsapp/provider.mjs';
import { whatsappParameter } from '../shared/message-render.mjs';

export const WHATSAPP_CATEGORIES = ['utility', 'marketing', 'authentication'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'paused'];
export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'ACHA', 'SITISHA'];
export const START_WORDS = ['START', 'ANZA', 'UNSTOP'];

// Replies to STOP / START, in the member's language when we know it.
const REPLIES = {
  stop: {
    en: 'You won\'t get WhatsApp messages from FitFlex or your gym any more. Reply START to hear from us again.',
    sw: 'Hutapokea tena ujumbe wa WhatsApp kutoka FitFlex au jimu yako. Jibu ANZA ili upokee tena.',
  },
  start: {
    en: 'You\'ll get service messages from FitFlex and your gym on WhatsApp again. Offers stay off unless you turn them on in the app.',
    sw: 'Utapokea tena ujumbe wa huduma kutoka FitFlex na jimu yako kwenye WhatsApp. Ofa zitabaki zimezimwa hadi uziwashe kwenye programu.',
  },
};

const RANK = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3, clicked: 4 };
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const PROVIDER_NAME_RE = /^[a-z0-9_]{1,40}$/;
const id = (p) => `${p}_${randomUUID().slice(0, 12)}`;
const keyword = (text) => String(text || '').trim().toUpperCase().replace(/[^A-Z]/g, '');

export function createWhatsAppChannelService({
  db,
  provider,
  auditLog = null,
  env = process.env,
  now = () => new Date(),
  settingsTtlMs = 30_000,
  logger = console,
}) {
  // ── kill switch ────────────────────────────────────────────────────────
  // Read from the database at most every `settingsTtlMs`, so every server
  // follows an admin's switch within that time. Until first read: on.
  let enabledCache = { value: true, at: 0 };

  async function readEnabled() {
    const row = await db('PlatformSettings').where({ id: 'platform' }).first('communications');
    const c = typeof row?.communications === 'string' ? JSON.parse(row.communications) : row?.communications;
    return c?.whatsappEnabled !== false;
  }

  async function isEnabled({ fresh = false } = {}) {
    if (fresh || +now() - enabledCache.at >= settingsTtlMs) {
      try {
        enabledCache = { value: await readEnabled(), at: +now() };
      } catch (err) {
        logger.warn?.(`[whatsapp] couldn't read the kill switch: ${err.message}`);
      }
    }
    return enabledCache.value;
  }

  /** Whether WhatsApp messages can go out right now (sync; last known switch). */
  const available = () => Boolean(provider.configured && enabledCache.value);

  async function setEnabled(actorId, enabled) {
    if (typeof enabled !== 'boolean') return { error: 'invalid_enabled', status: 400 };
    const before = await isEnabled({ fresh: true });
    const patch = JSON.stringify({ whatsappEnabled: enabled });
    const updated = await db('PlatformSettings').where({ id: 'platform' })
      .update({ communications: db.raw(`coalesce("communications", '{}'::jsonb) || ?::jsonb`, [patch]) });
    if (!updated) return { error: 'settings_missing', status: 409 };
    enabledCache = { value: enabled, at: +now() };
    audit(actorId, 'whatsapp_enabled_changed', 'whatsapp', { enabled: before }, { enabled });
    return status();
  }

  function audit(actor, action, target, before, after) {
    auditLog?.insertAsync?.({ id: randomUUID(), at: now().toISOString(), actor: actor || null, action, target, before, after })
      ?.catch?.(() => {});
  }

  // ── delivery ───────────────────────────────────────────────────────────

  const approvedRow = (templateName, language) => db('WhatsAppTemplate')
    .where({ provider: provider.name, providerTemplateName: templateName, language, approvalStatus: 'approved' })
    .first('id', 'variables');

  /**
   * Sends one queued WhatsApp ledger row. Returns what the dispatcher
   * records: { status: 'sent', providerMessageId } | { skipped: reason }
   * | { temporary: true, reason } | { permanent: true, reason }.
   */
  async function deliver(msg) {
    if (!provider.configured) return { skipped: ERRORS.notConfigured };
    if (!(await isEnabled())) return { skipped: 'whatsapp_disabled' };
    const [member, prefs] = await Promise.all([
      db('User').where({ id: msg.memberId }).first('id', 'phone'),
      db('CommunicationPreference').where({ id: msg.memberId }).first(),
    ]);
    const allowed = channelAllowed(prefs, 'whatsapp', msg.category);
    if (!allowed.allowed) return { skipped: allowed.reason };
    const recipient = provider.validateRecipient(member?.phone);
    if (!recipient.ok) return { skipped: recipient.reason };
    const p = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
    if (!p?.templateName || !p?.language) return { permanent: true, reason: 'whatsapp_template_missing' };
    if (!(await approvedRow(p.templateName, p.language))) return { skipped: 'whatsapp_template_not_approved' };

    const r = await provider.sendTemplate({
      to: recipient.to, templateName: p.templateName, language: p.language,
      parameters: (p.parameters || []).map(whatsappParameter), category: msg.category, reference: msg.id,
    });
    if (r.ok) return { status: 'sent', providerMessageId: r.providerMessageId };
    if (r.error === ERRORS.optedOut) {
      await optOutMembers([msg.memberId], 'provider');
      return { skipped: 'whatsapp_opted_out' };
    }
    if (r.error === ERRORS.notConfigured) return { skipped: ERRORS.notConfigured };
    return r.retryable ? { temporary: true, reason: r.error } : { permanent: true, reason: r.error };
  }

  // ── opt-out / opt-in ───────────────────────────────────────────────────

  async function membersByPhone(e164) {
    const variants = storedDigitVariants(e164);
    if (!variants.length) return [];
    return db('User')
      .whereRaw(`regexp_replace(coalesce("phone", ''), '\\D', '', 'g') = ANY(?)`, [variants])
      .select('id');
  }

  async function upsertPrefs(userId, patch) {
    const at = now();
    await db('CommunicationPreference')
      .insert({ id: userId, ...patch, createdAt: at, updatedAt: at })
      .onConflict('id').merge({ ...patch, updatedAt: at });
  }

  /** Stops every WhatsApp message to these members, including ones already queued. */
  async function optOutMembers(userIds, source) {
    const at = now();
    for (const userId of userIds) {
      await upsertPrefs(userId, { whatsappOptedOutAt: at, whatsappMarketing: false, whatsappTransactional: false });
      await db('CommunicationMessage').where({ memberId: userId, channel: 'whatsapp', status: 'queued' })
        .update({ status: 'skipped', skipReason: 'whatsapp_opted_out', nextAttemptAt: null, updatedAt: at });
      audit(userId, 'whatsapp_opt_out', userId, null, { source });
    }
  }

  async function optInMembers(userIds, source) {
    for (const userId of userIds) {
      // Service messages come back; offers stay off until the member turns
      // them on in the app, which records their consent.
      await upsertPrefs(userId, { whatsappOptedOutAt: null, whatsappTransactional: true });
      audit(userId, 'whatsapp_opt_in', userId, null, { source });
    }
  }

  async function reply(to, userIds, kind) {
    try {
      const pref = userIds.length ? await db('CommunicationPreference').where({ id: userIds[0] }).first('locale') : null;
      const lang = LOCALES.includes(pref?.locale) ? pref.locale : 'en';
      await provider.sendMessage({ to, text: REPLIES[kind][lang] });
    } catch (err) {
      logger.warn?.(`[whatsapp] couldn't confirm ${kind} to ${maskPhone(to)}: ${err.message}`);
    }
  }

  // ── webhook ────────────────────────────────────────────────────────────

  async function applyStatus(s) {
    const rows = await db('CommunicationMessage')
      .where({ providerMessageId: s.providerMessageId, channel: 'whatsapp' })
      .select('id', 'status', 'deliveredAt', 'openedAt');
    for (const r of rows) {
      const at = s.at || now();
      const patch = { updatedAt: now() };
      if (s.status === 'failed') {
        // A late failure never undoes a message the member already got.
        if ((RANK[r.status] ?? -1) >= RANK.delivered || r.status === 'failed') continue;
        Object.assign(patch, { status: 'failed', failedAt: at, failurePermanent: true, failureReason: s.error || 'provider_failed' });
      } else {
        if (s.status === 'delivered' && !r.deliveredAt) patch.deliveredAt = at;
        if (s.status === 'read') {
          if (!r.deliveredAt) patch.deliveredAt = at;
          if (!r.openedAt) patch.openedAt = at;
        }
        if ((RANK[r.status] ?? -1) >= 0 && RANK[s.status] > RANK[r.status]) patch.status = s.status;
      }
      if (Object.keys(patch).length > 1) await db('CommunicationMessage').where({ id: r.id }).update(patch);
    }
    return rows.length;
  }

  /** Handles one webhook call from the provider (delivery receipts and replies). */
  async function handleWebhook(request) {
    let parsed;
    try {
      parsed = provider.parseWebhook(request);
    } catch (err) {
      return { error: 'bad_webhook', status: 400, detail: String(err.message).slice(0, 100) };
    }
    const stats = { statuses: 0, unknown: 0, optedOut: 0, optedIn: 0, ignored: 0 };
    for (const s of parsed.statuses || []) {
      if (await applyStatus(s)) stats.statuses += 1;
      else stats.unknown += 1;
    }
    for (const m of parsed.inbound || []) {
      const word = keyword(m.text);
      const stop = STOP_WORDS.includes(word);
      const start = START_WORDS.includes(word);
      if (!stop && !start) { stats.ignored += 1; continue; }
      const recipient = provider.validateRecipient(m.from);
      if (!recipient.ok) { stats.ignored += 1; continue; }
      const ids = (await membersByPhone(recipient.to)).map(u => u.id);
      if (stop) { await optOutMembers(ids, 'whatsapp_reply'); stats.optedOut += ids.length; }
      else { await optInMembers(ids, 'whatsapp_reply'); stats.optedIn += ids.length; }
      // Confirm even when the number isn't a member's: they still asked.
      await reply(recipient.to, ids, stop ? 'stop' : 'start');
    }
    return { ok: true, ...stats };
  }

  // ── admin: status and templates ────────────────────────────────────────

  async function status() {
    const enabled = await isEnabled({ fresh: true });
    const count = async (q) => Number((await q.count({ n: '*' }).first())?.n || 0);
    const since = new Date(+now() - 7 * 86_400_000);
    const [withPhone, marketingOptedIn, optedOut, byApproval, byStatus] = await Promise.all([
      count(db('User').where({ userType: 'member' }).whereNotNull('phone').whereNot('phone', '')),
      count(db('CommunicationPreference').where({ whatsappMarketing: true }).whereNull('whatsappOptedOutAt')),
      count(db('CommunicationPreference').whereNotNull('whatsappOptedOutAt')),
      db('WhatsAppTemplate').where({ provider: provider.name }).groupBy('approvalStatus').select('approvalStatus').count({ n: '*' }),
      db('CommunicationMessage').where({ channel: 'whatsapp' }).where('createdAt', '>=', since)
        .groupBy('status').select('status').count({ n: '*' }),
    ]);
    return {
      provider: {
        name: provider.name, configured: Boolean(provider.configured),
        ...(provider.setup ? { setup: provider.setup } : {}),
      },
      enabled,
      available: Boolean(provider.configured && enabled),
      webhook: { path: '/webhooks/whatsapp/status', secretSet: Boolean(env.WHATSAPP_WEBHOOK_SECRET) },
      members: { withPhone, marketingOptedIn, optedOut },
      templates: Object.fromEntries(APPROVAL_STATUSES.map(s => [s, Number(byApproval.find(r => r.approvalStatus === s)?.n || 0)])),
      last7Days: Object.fromEntries(byStatus.map(r => [r.status, Number(r.n)])),
    };
  }

  const registryView = (r) => ({
    id: r.id, provider: r.provider, providerTemplateName: r.providerTemplateName, language: r.language,
    category: r.category, variables: r.variables || [], approvalStatus: r.approvalStatus,
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  });

  /**
   * The registry, and for each FitFlex template and language the provider
   * template it needs (name, category, variables in order) and its status.
   */
  async function registry() {
    const rows = await db('WhatsAppTemplate').orderBy([{ column: 'providerTemplateName' }, { column: 'language' }]).select('*');
    const current = rows.filter(r => r.provider === provider.name);
    const expected = SYSTEM_TEMPLATES.flatMap(t => Object.entries(t.bodies).map(([language, b]) => {
      const row = current.find(r => r.providerTemplateName === t.whatsapp.name && r.language === language);
      return {
        templateKey: t.key, providerTemplateName: t.whatsapp.name, language, category: t.whatsapp.category,
        variables: variablesIn(b.body), body: b.body,
        registered: row ? { id: row.id, approvalStatus: row.approvalStatus } : null,
      };
    }));
    return { provider: provider.name, templates: rows.map(registryView), expected };
  }

  function templateFields(body, { partial }) {
    const out = {};
    if (!partial || body.providerTemplateName !== undefined) {
      if (!TEMPLATE_NAME_RE.test(body.providerTemplateName || '')) return { error: 'invalid_template_name', status: 400 };
      out.providerTemplateName = body.providerTemplateName;
    }
    if (!partial || body.language !== undefined) {
      if (!LOCALES.includes(body.language)) return { error: 'invalid_language', status: 400 };
      out.language = body.language;
    }
    if (!partial || body.category !== undefined) {
      if (!WHATSAPP_CATEGORIES.includes(body.category)) return { error: 'invalid_category', status: 400 };
      out.category = body.category;
    }
    if (body.variables !== undefined) {
      if (!Array.isArray(body.variables) || !body.variables.every(v => TEMPLATE_VARIABLES.includes(v))) {
        return { error: 'invalid_variables', status: 400 };
      }
      out.variables = body.variables;
    }
    if (body.approvalStatus !== undefined) {
      if (!APPROVAL_STATUSES.includes(body.approvalStatus)) return { error: 'invalid_approval_status', status: 400 };
      out.approvalStatus = body.approvalStatus;
    }
    return { fields: out };
  }

  /** Registers (or updates) a provider template, e.g. after the provider approved it. */
  async function registerTemplate(actorId, body = {}) {
    const f = templateFields(body, { partial: false });
    if (f.error) return f;
    const providerName = body.provider ?? (provider.configured ? provider.name : null);
    if (!PROVIDER_NAME_RE.test(providerName || '')) return { error: 'provider_required', status: 400 };
    const at = now();
    const [row] = await db('WhatsAppTemplate')
      .insert({ id: id('wat'), provider: providerName, variables: [], approvalStatus: 'pending', ...f.fields, createdAt: at, updatedAt: at })
      .onConflict(['provider', 'providerTemplateName', 'language'])
      .merge({ ...f.fields, updatedAt: at })
      .returning('*');
    audit(actorId, 'whatsapp_template_registered', row.id, null, registryView(row));
    return { template: registryView(row) };
  }

  async function updateTemplate(actorId, templateId, body = {}) {
    const f = templateFields(body, { partial: true });
    if (f.error) return f;
    const before = await db('WhatsAppTemplate').where({ id: templateId }).first();
    if (!before) return { error: 'not_found', status: 404 };
    if (!Object.keys(f.fields).length) return { template: registryView(before) };
    const [row] = await db('WhatsAppTemplate').where({ id: templateId })
      .update({ ...f.fields, updatedAt: now() }).returning('*');
    audit(actorId, 'whatsapp_template_updated', row.id, registryView(before), registryView(row));
    return { template: registryView(row) };
  }

  /** Pulls template approval statuses from the provider into the registry. */
  async function syncTemplates(actorId) {
    if (!provider.configured) return { error: ERRORS.notConfigured, status: 409 };
    const r = await provider.listTemplates();
    if (r.error) return { error: r.error, status: 502 };
    const at = now();
    let synced = 0;
    for (const t of r.templates || []) {
      if (!TEMPLATE_NAME_RE.test(t.name || '') || !LOCALES.includes(t.language)) continue;
      const fields = {
        approvalStatus: APPROVAL_STATUSES.includes(t.status) ? t.status : 'pending',
        category: WHATSAPP_CATEGORIES.includes(t.category) ? t.category : 'utility',
        ...(Array.isArray(t.variables) && t.variables.every(v => TEMPLATE_VARIABLES.includes(v)) ? { variables: t.variables } : {}),
        lastSyncedAt: at, updatedAt: at,
      };
      await db('WhatsAppTemplate')
        .insert({ id: id('wat'), provider: provider.name, providerTemplateName: t.name, language: t.language, variables: [], ...fields, createdAt: at })
        .onConflict(['provider', 'providerTemplateName', 'language']).merge(fields);
      synced += 1;
    }
    audit(actorId, 'whatsapp_templates_synced', 'whatsapp', null, { provider: provider.name, synced });
    return { synced, ...(await registry()) };
  }

  /** Sends one approved template to a number — the go-live sandbox check. */
  async function sendTest(actorId, { phone, templateName, language, parameters = [] } = {}) {
    if (!provider.configured) return { error: ERRORS.notConfigured, status: 409 };
    if (!(await isEnabled({ fresh: true }))) return { error: 'whatsapp_disabled', status: 409 };
    const recipient = provider.validateRecipient(phone);
    if (!recipient.ok) return { error: recipient.reason, status: 400 };
    if (!Array.isArray(parameters) || !parameters.every(p => typeof p === 'string' && p.length <= 200)) {
      return { error: 'invalid_parameters', status: 400 };
    }
    if (!(await approvedRow(templateName, language))) return { error: 'whatsapp_template_not_approved', status: 400 };
    const r = await provider.sendTemplate({ to: recipient.to, templateName, language, parameters: parameters.map(whatsappParameter), category: 'utility', reference: id('watest') });
    audit(actorId, 'whatsapp_test_sent', 'whatsapp', null, { to: maskPhone(recipient.to), templateName, language, ok: Boolean(r.ok), error: r.error || null });
    return r.ok ? { ok: true, providerMessageId: r.providerMessageId } : { error: r.error, status: 502 };
  }

  return {
    provider, available, isEnabled, setEnabled, deliver, handleWebhook,
    optOutMembers, status, registry, registerTemplate, updateTemplate, syncTemplates, sendTest,
  };
}
