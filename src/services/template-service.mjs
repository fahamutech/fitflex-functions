// Message templates — FitFlex's ready-made messages (system) plus each
// gym's own. Owners browse them by group, preview them in English and
// Swahili on each channel, copy a system template to adapt it, and start a
// campaign from one. FitFlex admins use the system templates.
//
// System templates live in code (shared/communication-templates.mjs) and are
// synced into CommunicationTemplate the first time templates are needed, so
// a deploy that changes their wording updates them everywhere. Gyms can't
// edit them; they copy them.
//
// Templates use the campaign variables and rules (validateContent), so
// anything a template holds can be sent. WhatsApp is only possible through
// a provider-approved WhatsApp template (WhatsAppTemplate registry, M7).
import { randomUUID } from 'node:crypto';
import {
  PURPOSES, DEEP_LINKS, LOCALES, categoryForPurpose, validateContent, variablesIn,
  messageValues, renderText,
} from '../shared/communications.mjs';
import {
  SYSTEM_TEMPLATES, TEMPLATE_GROUPS, systemTemplateId, SAMPLE_MEMBER, PUSH_TITLE_MAX, PUSH_BODY_PREVIEW,
} from '../shared/communication-templates.mjs';
import { ownerGymIds } from '../shared/member-status.mjs';
import { localDay, addDays } from '../shared/member-progress.mjs';

const NAME_MAX = 60;
const CHANNELS_ALL = ['in_app', 'push', 'whatsapp'];

export function createTemplateService({ db, templates, gyms, now = () => new Date(), renewalLink = null }) {
  let synced = null;

  /** Writes the code's system templates into the table (idempotent). */
  async function syncSystemTemplates() {
    const at = now();
    for (const tpl of SYSTEM_TEMPLATES) {
      const row = {
        id: systemTemplateId(tpl.key), gymId: null, key: tpl.key, name: tpl.key,
        category: categoryForPurpose(tpl.purpose), purpose: tpl.purpose, group: tpl.group, deepLink: tpl.deepLink,
        channels: CHANNELS_ALL, bodies: JSON.stringify(tpl.bodies),
        variables: variablesIn(Object.values(tpl.bodies).map(b => `${b.title} ${b.body}`).join(' ')),
        status: 'active', updatedAt: at,
      };
      await db('CommunicationTemplate').insert({ ...row, createdAt: at })
        .onConflict('id').merge(['category', 'purpose', 'group', 'deepLink', 'channels', 'bodies', 'variables', 'status', 'updatedAt']);
    }
  }
  const ensureSynced = () => (synced ??= syncSystemTemplates().catch((err) => { synced = null; throw err; }));

  // ── access ───────────────────────────────────────────────────────────────

  function gymScope(sender) {
    return sender.senderType === 'gym' ? ownerGymIds(sender.owner) : [];
  }

  function mayRead(sender, row) {
    if (!row) return false;
    if (row.gymId == null) return true; // system templates are for everyone sending
    return sender.senderType === 'gym' && gymScope(sender).includes(row.gymId);
  }

  async function load(sender, templateId) {
    await ensureSynced();
    const row = await templates.findByIdAsync(templateId);
    return mayRead(sender, row) ? row : null;
  }

  // ── WhatsApp readiness ───────────────────────────────────────────────────

  const systemByKey = new Map(SYSTEM_TEMPLATES.map(t => [t.key, t]));

  /**
   * Whether a template can go out on WhatsApp, per language: only through a
   * WhatsApp template the provider has approved. Returns
   * { ready, byLocale: { en: {ready, reason?}, sw: … } }.
   */
  async function whatsappStatus(row) {
    const byLocale = {};
    const langs = LOCALES.filter(l => row.bodies?.[l]);
    let approved = [];
    if (row.whatsappTemplateId) {
      approved = await db('WhatsAppTemplate').where({ id: row.whatsappTemplateId }).select('language', 'approvalStatus');
    } else {
      const name = row.gymId == null ? systemByKey.get(row.key)?.whatsapp?.name : null;
      if (name) approved = await db('WhatsAppTemplate').where({ providerTemplateName: name }).select('language', 'approvalStatus');
    }
    for (const l of langs) {
      const match = approved.find(a => a.language === l);
      byLocale[l] = !match ? { ready: false, reason: 'not_registered' }
        : match.approvalStatus === 'approved' ? { ready: true } : { ready: false, reason: `whatsapp_${match.approvalStatus}` };
    }
    return { ready: Object.values(byLocale).some(s => s.ready), byLocale };
  }

  function view(row, extra = {}) {
    const bodies = typeof row.bodies === 'string' ? JSON.parse(row.bodies) : row.bodies;
    return {
      id: row.id, key: row.key, system: row.gymId == null, gymId: row.gymId, name: row.name,
      group: row.group, purpose: row.purpose, category: row.category, deepLink: row.deepLink,
      bodies, variables: row.variables || [], channels: row.channels || CHANNELS_ALL,
      status: row.status, basedOn: row.basedOn || null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      ...extra,
    };
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async function list(sender, { group = null, purpose = null, gymId = null } = {}) {
    await ensureSynced();
    const mine = gymScope(sender);
    if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const q = db('CommunicationTemplate').where('status', 'active')
      .where(b => { b.whereNull('gymId'); if (mine.length) b.orWhereIn('gymId', gymId != null ? [gymId] : mine); });
    if (group) q.where('group', group);
    if (purpose) q.where('purpose', purpose);
    const rows = await q.orderByRaw('"gymId" IS NULL, "updatedAt" DESC').select('*');
    // Gym templates first (newest first), then FitFlex's in catalogue order.
    const order = new Map(SYSTEM_TEMPLATES.map((t, i) => [t.key, i]));
    const gymRows = rows.filter(r => r.gymId != null);
    const systemRows = rows.filter(r => r.gymId == null).sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
    return { templates: [...gymRows, ...systemRows].map(r => view(r)), groups: TEMPLATE_GROUPS };
  }

  async function get(sender, templateId) {
    const row = await load(sender, templateId);
    if (!row) return { error: 'not_found', status: 404 };
    return { template: view(row, { whatsapp: await whatsappStatus(row) }) };
  }

  // ── writing (gyms only) ──────────────────────────────────────────────────

  function gymFor(sender, requested) {
    if (sender.senderType !== 'gym') return { error: 'gyms_only', status: 403 };
    const mine = gymScope(sender);
    if (!mine.length) return { error: 'owner_has_no_gyms', status: 400 };
    if (requested != null) return mine.includes(requested) ? { gymId: requested } : { error: 'not_your_gym', status: 403 };
    return mine.length === 1 ? { gymId: mine[0] } : { error: 'gym_required', status: 400 };
  }

  /** Validates whichever template fields are present. */
  function fields(body, { partial }) {
    const patch = {};
    if (body.name !== undefined || !partial) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > NAME_MAX) return { error: 'invalid_name', status: 400 };
      patch.name = name;
    }
    if (body.group !== undefined) {
      if (!TEMPLATE_GROUPS.includes(body.group)) return { error: 'invalid_group', status: 400 };
      patch.group = body.group;
    }
    if (body.purpose !== undefined || !partial) {
      if (!PURPOSES.includes(body.purpose)) return { error: 'invalid_purpose', status: 400 };
      patch.purpose = body.purpose;
      patch.category = categoryForPurpose(body.purpose);
    }
    if (body.deepLink !== undefined) {
      if (!DEEP_LINKS.includes(body.deepLink)) return { error: 'invalid_deep_link', status: 400 };
      patch.deepLink = body.deepLink;
    }
    if (body.bodies !== undefined || !partial) {
      const b = body.bodies;
      if (!b || typeof b !== 'object') return { error: 'bodies_required', status: 400 };
      const langs = Object.keys(b);
      if (!langs.length || !langs.every(l => LOCALES.includes(l))) return { error: 'invalid_bodies', status: 400 };
      const clean = {};
      for (const l of langs) {
        // Sample sender values let a template use {{discount}} and friends;
        // the real values are typed in when a campaign uses it.
        const v = validateContent({ ...b[l], offerName: 'x', discount: 'x', amountTzs: 0 }, { renewalLinkAvailable: Boolean(renewalLink) });
        if (v.error) return { ...v, detail: `${l}:${v.detail}` };
        clean[l] = { title: v.content.title, body: v.content.body, ...(v.content.ctaLabel ? { ctaLabel: v.content.ctaLabel } : {}) };
      }
      patch.bodies = clean;
      patch.variables = variablesIn(Object.values(clean).map(x => `${x.title} ${x.body}`).join(' '));
    }
    return { patch };
  }

  const store = (patch) => ({ ...patch, ...(patch.bodies ? { bodies: JSON.stringify(patch.bodies) } : {}) });

  async function create(sender, body = {}) {
    await ensureSynced();
    const gym = gymFor(sender, body.gymId ?? null);
    if (gym.error) return gym;
    const f = fields(body, { partial: false });
    if (f.error) return f;
    let basedOn = null;
    if (body.basedOn != null) {
      const src = await load(sender, body.basedOn);
      if (!src) return { error: 'not_found', status: 404 };
      basedOn = src.id;
    }
    const at = now();
    const row = {
      id: `tpl_${randomUUID().slice(0, 8)}`, gymId: gym.gymId, key: `gym_${randomUUID().slice(0, 8)}`,
      group: 'general', deepLink: 'message', channels: CHANNELS_ALL, status: 'active',
      basedOn, createdBy: sender.actorId || null, createdAt: at, updatedAt: at, ...f.patch,
    };
    await db('CommunicationTemplate').insert(store(row));
    return { template: view(await templates.findByIdAsync(row.id)) };
  }

  /** Copies any template the sender can see into one of their gym's own. */
  async function duplicate(sender, templateId, { gymId = null, name = null } = {}) {
    const src = await load(sender, templateId);
    if (!src) return { error: 'not_found', status: 404 };
    const bodies = typeof src.bodies === 'string' ? JSON.parse(src.bodies) : src.bodies;
    return create(sender, {
      // Apps pass the name in the owner's language; otherwise "we_miss_you" → "We miss you".
      gymId, name: (name?.trim() || (src.gymId == null
        ? src.key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
        : `${src.name} (copy)`)).slice(0, NAME_MAX),
      group: src.group, purpose: src.purpose, deepLink: src.deepLink, bodies, basedOn: src.id,
    });
  }

  async function ownGymTemplate(sender, templateId) {
    const row = await load(sender, templateId);
    if (!row) return { error: 'not_found', status: 404 };
    if (row.gymId == null) return { error: 'system_template_read_only', status: 403 };
    if (row.status !== 'active') return { error: 'template_archived', status: 409 };
    return { row };
  }

  async function update(sender, templateId, body = {}) {
    const own = await ownGymTemplate(sender, templateId);
    if (own.error) return own;
    const f = fields(body, { partial: true });
    if (f.error) return f;
    if (Object.keys(f.patch).length) {
      await db('CommunicationTemplate').where({ id: own.row.id }).update({ ...store(f.patch), updatedAt: now() });
    }
    return { template: view(await templates.findByIdAsync(own.row.id)) };
  }

  /** Hides a gym template. Campaigns that used it keep their own copy of the text. */
  async function archive(sender, templateId) {
    const own = await ownGymTemplate(sender, templateId);
    if (own.error) return own;
    await db('CommunicationTemplate').where({ id: own.row.id }).update({ status: 'archived', updatedAt: now() });
    return { ok: true };
  }

  // ── preview ──────────────────────────────────────────────────────────────

  async function senderName(sender, gymId) {
    if (sender.senderType === 'platform') return 'FitFlex';
    const id = gymId && gymScope(sender).includes(gymId) ? gymId : gymScope(sender)[0];
    return (id && (await gyms.findByIdAsync(id))?.name) || 'FitFlex';
  }

  /**
   * How a template (saved, or unsaved from `body`) looks on each channel in
   * each language, for a sample member at the sender's gym. Offer values
   * typed in so far can be passed as `values`.
   */
  async function preview(sender, { templateId = null, body = null, gymId = null, values = {} } = {}) {
    let row;
    if (templateId) {
      row = await load(sender, templateId);
      if (!row) return { error: 'not_found', status: 404 };
    } else {
      const f = fields(body || {}, { partial: false });
      if (f.error) return f;
      row = { ...f.patch, id: null, gymId: gymScope(sender)[0] ?? null, deepLink: f.patch.deepLink || 'message' };
    }
    const bodies = typeof row.bodies === 'string' ? JSON.parse(row.bodies) : row.bodies;
    const name = await senderName(sender, gymId);
    const member = { ...SAMPLE_MEMBER, expiresOn: addDays(localDay(now()), 5) };
    const content = {
      offerName: values.offerName || null, discount: values.discount || null,
      amountTzs: Number.isInteger(values.amountTzs) ? values.amountTzs : null,
    };
    const byLocale = {};
    for (const [lang, b] of Object.entries(bodies)) {
      const v = messageValues(content, member, { gymName: name, locale: lang });
      // Unfilled offer values show as a visible placeholder, not a blank.
      for (const k of ['offer_name', 'discount', 'amount']) if (!v[k]) v[k] = `[${k}]`;
      const title = renderText(b.title, v);
      const text = renderText(b.body, v);
      byLocale[lang] = {
        in_app: { title, body: text, ctaLabel: b.ctaLabel || null, deepLink: row.deepLink },
        push: {
          title: title.length > PUSH_TITLE_MAX ? `${title.slice(0, PUSH_TITLE_MAX - 1)}…` : title,
          body: text.length > PUSH_BODY_PREVIEW ? `${text.slice(0, PUSH_BODY_PREVIEW - 1)}…` : text,
          truncated: title.length > PUSH_TITLE_MAX || text.length > PUSH_BODY_PREVIEW,
        },
      };
    }
    const whatsapp = row.id ? await whatsappStatus(row) : { ready: false, byLocale: Object.fromEntries(Object.keys(bodies).map(l => [l, { ready: false, reason: 'not_registered' }])) };
    return { senderName: name, sampleMember: member.displayName, byLocale, whatsapp, needsValues: (row.variables || []).filter(k => ['offer_name', 'discount', 'amount'].includes(k)) };
  }

  /**
   * Campaign content from a template: the main text in `locale`, the other
   * language as a translation, plus the sender's offer values.
   */
  async function contentFromTemplate(sender, templateId, { locale = 'en', values = {} } = {}) {
    const row = await load(sender, templateId);
    if (!row || row.status !== 'active') return { error: 'template_not_found', status: 404 };
    const bodies = typeof row.bodies === 'string' ? JSON.parse(row.bodies) : row.bodies;
    const main = bodies[locale] ? locale : Object.keys(bodies)[0];
    const translations = Object.fromEntries(Object.entries(bodies).filter(([l]) => l !== main));
    return {
      template: row,
      content: {
        ...bodies[main], locale: main, deepLink: row.deepLink,
        ...(Object.keys(translations).length ? { translations } : {}),
        ...(values.offerName ? { offerName: values.offerName } : {}),
        ...(values.discount ? { discount: values.discount } : {}),
        ...(Number.isInteger(values.amountTzs) ? { amountTzs: values.amountTzs } : {}),
      },
    };
  }

  return {
    list, get, create, update, duplicate, archive, preview,
    contentFromTemplate, whatsappStatus, load, syncSystemTemplates: () => { synced = null; return ensureSynced(); },
  };
}
