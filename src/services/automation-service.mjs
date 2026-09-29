// Lifecycle automations (M9) — a gym's messages that send themselves when
// something happens to a member: their membership starts, is about to end,
// has ended, a payment fails, or they stop coming.
//
// Every gym gets the default automations below, switched OFF until the
// owner reviews them (the platform renewal reminder covers members until
// then — D4). Each is a trigger, a template and channels.
//
// How a message gets sent (fire):
//   1. an AutomationRun row is inserted for (automation, member, occurrence),
//      e.g. "2026-10-14:T-7". That key is UNIQUE, so the same occurrence can
//      never send twice — not on a retried job, a double cron, or an event
//      and the sweep both seeing it;
//   2. in the same transaction its CommunicationMessage ledger rows are
//      queued (or skipped with a reason), one per channel; the M5
//      dispatcher then delivers them, with its own retries;
//   3. a per-member lock and a daily limit keep a member to at most one
//      automation message per gym per day; anything held back is tried
//      again on a later run while its window lasts.
//
// When triggers are checked:
//   - events (a payment approved or rejected, an owner adding or renewing
//     a member, Selcom) fire at once;
//   - an hourly sweep checks every trigger again — expiry dates, lapsed
//     members, and the last two days of activations and failed payments —
//     so a lost event or a failed run is caught up. Scheduled triggers
//     send only between 08:00 and 20:00 East Africa Time.
//   - Windows, not exact days: "7 days before expiry" fires when 6–7 days
//     are left, so one missed run doesn't lose the message; inactivity
//     fires when a member crosses 14 days without a visit, not for everyone
//     who stopped coming long ago.
//   - An automation that would message more than `maxPerRun` members at
//     once is paused and the owner told why, rather than sending.
import { randomUUID } from 'node:crypto';
import { AUTOMATION_TRIGGERS, CHANNELS, categoryForPurpose } from '../shared/communications.mjs';
import { systemTemplateId } from '../shared/communication-templates.mjs';
import { renderMessage, whatsappMessage } from '../shared/message-render.mjs';
import { addDays, localDay, MEMBER_UTC_OFFSET_MINUTES } from '../shared/member-progress.mjs';
import { ownerGymIds } from '../shared/member-status.mjs';
import { assertGymRecipients } from '../shared/communication-tenancy.mjs';

/** The automations every gym starts with (all switched off). */
export const DEFAULT_AUTOMATIONS = Object.freeze([
  { key: 'welcome', name: 'Welcome new members', trigger: 'membership_activated', offsetDays: 0, template: 'welcome_member', conditions: { firstMembershipOnly: true } },
  { key: 'expiring_7', name: 'Membership ends in 7 days', trigger: 'membership_expiring', offsetDays: 7, template: 'membership_expiring' },
  { key: 'expiring_3', name: 'Membership ends in 3 days', trigger: 'membership_expiring', offsetDays: 3, template: 'renewal_reminder' },
  { key: 'expiring_1', name: 'Membership ends tomorrow', trigger: 'membership_expiring', offsetDays: 1, template: 'membership_final_reminder' },
  { key: 'expired', name: 'Membership has ended', trigger: 'membership_expired', offsetDays: 0, template: 'membership_expired' },
  { key: 'payment_failed', name: 'Payment didn\'t go through', trigger: 'payment_failed', offsetDays: 0, template: 'payment_failed' },
  { key: 'inactive_14', name: 'No visit for 14 days', trigger: 'member_inactive', offsetDays: 14, template: 'we_miss_you' },
]);
export const DEFAULT_CHANNELS = ['in_app', 'push', 'whatsapp'];
export const AUTOMATION_STATUSES = ['enabled', 'disabled', 'paused'];
// Checked in this order each run, so when a member qualifies for several
// on one day the most urgent one wins the day's single message.
const PRIORITY = ['payment_failed', 'membership_expiring', 'membership_expired', 'membership_activated', 'member_inactive'];
const RECENT_MS = 48 * 3_600_000;
const LOCK_KEY = 7_203_911; // the hourly run: one server at a time
const LIVE = ['active', 'expiring_soon'];
// The membership itself must be in force (not cancelled, suspended or
// waiting on a payment) for reminders about it.
const inForce = (f) => f.subscriptionStatus == null || f.subscriptionStatus === 'active';

const id = (p) => `${p}_${randomUUID().slice(0, 12)}`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function createAutomationService({
  db,
  segmentService,
  templateService,
  auditLog = null,
  now = () => new Date(),
  renewalLink = null,
  maxPerRun = 300,
  sendHours = { from: 8, to: 20 },
  marketingWeeklyCap = 2,
  logger = console,
}) {
  // ── defaults and reading ─────────────────────────────────────────────────

  let templatesReady = null;
  const ensureTemplates = () => (templatesReady ??= templateService.syncSystemTemplates().catch((e) => { templatesReady = null; throw e; }));

  /** Creates a gym's default automations if it doesn't have them (idempotent). */
  async function ensureDefaults(gymId) {
    await ensureTemplates();
    const at = now();
    await db('CommunicationAutomation').insert(DEFAULT_AUTOMATIONS.map(d => ({
      id: `aut_${gymId}_${d.key}`, senderType: 'gym', gymId, name: d.name, trigger: d.trigger,
      offsetDays: d.offsetDays, conditions: d.conditions ?? null, templateId: systemTemplateId(d.template),
      channels: DEFAULT_CHANNELS, status: 'disabled', createdAt: at, updatedAt: at,
    }))).onConflict(['gymId', 'trigger', 'offsetDays']).ignore();
  }

  function gymsOf(sender, gymId) {
    if (sender?.senderType !== 'gym') return { error: 'gyms_only', status: 403 };
    const mine = ownerGymIds(sender.owner);
    if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    if (!mine.length) return { error: 'owner_has_no_gyms', status: 400 };
    return { gymIds: gymId != null ? [gymId] : mine };
  }

  function view(a, stats = null) {
    const conditions = typeof a.conditions === 'string' ? JSON.parse(a.conditions) : a.conditions;
    return {
      id: a.id, gymId: a.gymId, name: a.name, trigger: a.trigger, offsetDays: a.offsetDays,
      conditions: conditions || null, channels: a.channels || [], status: a.status,
      pausedReason: a.pausedReason || null,
      template: a.templateId ? { id: a.templateId, key: a.templateKey ?? null, name: a.templateName ?? null, system: a.templateGymId == null, purpose: a.templatePurpose ?? null } : null,
      lastRunAt: iso(a.lastRunAt), updatedAt: iso(a.updatedAt),
      ...(stats ? { stats } : {}),
    };
  }

  const withTemplate = () => db('CommunicationAutomation as a')
    .leftJoin('CommunicationTemplate as t', 't.id', 'a.templateId')
    .select('a.*', 't.key as templateKey', 't.name as templateName', 't.gymId as templateGymId', 't.purpose as templatePurpose', 't.status as templateStatus');

  /** Last 30 days per automation: members messaged, and how it went. */
  async function statsFor(automationIds) {
    const since = new Date(+now() - 30 * 86_400_000);
    const [runs, msgs] = await Promise.all([
      db('AutomationRun').whereIn('automationId', automationIds).where('createdAt', '>=', since)
        .groupBy('automationId', 'status').select('automationId', 'status').count({ n: '*' }),
      db('CommunicationMessage as m').join('AutomationRun as r', 'r.id', 'm.automationRunId')
        .whereIn('r.automationId', automationIds).where('r.createdAt', '>=', since)
        .groupBy('r.automationId').select('r.automationId')
        .count({ messages: '*' })
        .select(db.raw(`count(*) filter (where m.status in ('sent','delivered','read','clicked')) as reached`))
        .select(db.raw(`count(*) filter (where m.status = 'failed') as failed`))
        .count({ opened: 'm.openedAt' }),
    ]);
    const out = new Map(automationIds.map(a => [a, { fired: 0, skipped: 0, messages: 0, reached: 0, failed: 0, opened: 0 }]));
    for (const r of runs) {
      const s = out.get(r.automationId);
      if (r.status === 'queued') s.fired += Number(r.n); else s.skipped += Number(r.n);
    }
    for (const m of msgs) Object.assign(out.get(m.automationId), {
      messages: Number(m.messages), reached: Number(m.reached), failed: Number(m.failed), opened: Number(m.opened),
    });
    return out;
  }

  async function list(sender, { gymId = null } = {}) {
    const g = gymsOf(sender, gymId);
    if (g.error) return g;
    for (const gid of g.gymIds) await ensureDefaults(gid);
    const rows = await withTemplate().whereIn('a.gymId', g.gymIds).orderBy([{ column: 'a.gymId' }, { column: 'a.trigger' }, { column: 'a.offsetDays', order: 'desc' }]);
    rows.sort((x, y) => PRIORITY.indexOf(x.trigger) - PRIORITY.indexOf(y.trigger) || y.offsetDays - x.offsetDays);
    const stats = await statsFor(rows.map(r => r.id));
    return { automations: rows.map(r => view(r, stats.get(r.id))) };
  }

  async function load(sender, automationId) {
    const g = gymsOf(sender, null);
    if (g.error) return null;
    const row = await withTemplate().where('a.id', automationId).first();
    return row && g.gymIds.includes(row.gymId) ? row : null;
  }

  async function get(sender, automationId) {
    const row = await load(sender, automationId);
    if (!row) return { error: 'not_found', status: 404 };
    return { automation: view(row, (await statsFor([row.id])).get(row.id)) };
  }

  // Values an automation can fill in itself; offers need a person to type them.
  const SENDER_ONLY = ['offer_name', 'discount'];

  /** Switch on or off, change channels or template. Turning on clears a pause. */
  async function update(sender, automationId, body = {}) {
    const row = await load(sender, automationId);
    if (!row) return { error: 'not_found', status: 404 };
    const patch = {};
    if (body.status !== undefined) {
      if (!['enabled', 'disabled'].includes(body.status)) return { error: 'invalid_status', status: 400 };
      patch.status = body.status;
      patch.pausedReason = null;
    }
    if (body.channels !== undefined) {
      if (!Array.isArray(body.channels) || !body.channels.length || !body.channels.every(c => CHANNELS.includes(c))) {
        return { error: 'invalid_channels', status: 400 };
      }
      patch.channels = [...new Set(body.channels)];
    }
    if (body.templateId !== undefined) {
      const tpl = await templateService.load({ senderType: 'gym', owner: { gymIds: [row.gymId] } }, body.templateId);
      if (!tpl || tpl.status !== 'active') return { error: 'template_not_found', status: 404 };
      const needs = (tpl.variables || []).filter(v => SENDER_ONLY.includes(v) || (v === 'amount' && row.trigger !== 'payment_failed'));
      if (needs.length) return { error: 'template_needs_values', status: 400, detail: needs.join(',') };
      patch.templateId = tpl.id;
    }
    if (!Object.keys(patch).length) return get(sender, automationId);
    await db('CommunicationAutomation').where({ id: row.id })
      .update({ ...patch, updatedBy: sender.actorId || null, updatedAt: now() });
    audit(sender.actorId, 'automation_updated', row.id, { status: row.status, channels: row.channels, templateId: row.templateId }, patch);
    return get(sender, automationId);
  }

  /** Recent firings: who, why, and how the messages went. */
  async function runs(sender, automationId, { limit = 20, before = null } = {}) {
    const row = await load(sender, automationId);
    if (!row) return { error: 'not_found', status: 404 };
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const q = db('AutomationRun as r').leftJoin('User as u', 'u.id', 'r.memberId')
      .where('r.automationId', row.id).orderBy('r.createdAt', 'desc').limit(size)
      .select('r.*', 'u.displayName as memberName');
    if (before) {
      const d = new Date(before);
      if (Number.isNaN(+d)) return { error: 'invalid_filter', status: 400, detail: 'before' };
      q.where('r.createdAt', '<', d);
    }
    const list = await q;
    const msgs = list.length
      ? await db('CommunicationMessage').whereIn('automationRunId', list.map(r => r.id)).select('id', 'automationRunId', 'channel', 'status', 'skipReason', 'failureReason')
      : [];
    return {
      runs: list.map(r => ({
        id: r.id, memberId: r.memberId, memberName: r.memberName ?? null, occurrenceKey: r.occurrenceKey,
        status: r.status, context: typeof r.context === 'string' ? JSON.parse(r.context) : r.context || null,
        createdAt: iso(r.createdAt),
        channels: msgs.filter(m => m.automationRunId === r.id)
          .sort((x, y) => CHANNELS.indexOf(x.channel) - CHANNELS.indexOf(y.channel))
          .map(m => ({ id: m.id, channel: m.channel, status: m.status, reason: m.failureReason || m.skipReason || null })),
      })),
    };
  }

  async function preview(sender, automationId) {
    const row = await load(sender, automationId);
    if (!row) return { error: 'not_found', status: 404 };
    if (!row.templateId) return { error: 'template_not_found', status: 404 };
    return templateService.preview({ senderType: 'gym', owner: { gymIds: [row.gymId] } }, { templateId: row.templateId, gymId: row.gymId });
  }

  function audit(actor, action, target, before, after) {
    auditLog?.insertAsync?.({ id: randomUUID(), at: now().toISOString(), actor: actor || null, action, target, before, after })
      ?.catch?.(() => {});
  }

  // ── firing ─────────────────────────────────────────────────────────────

  const startOfToday = (at) => new Date(Date.parse(`${localDay(at)}T00:00:00Z`) - MEMBER_UTC_OFFSET_MINUTES * 60_000);

  async function factsFor(gymId, memberId) {
    const [f] = await segmentService.gymMemberFacts([gymId], { memberIds: [memberId] });
    if (f) return f;
    const u = await db('User').where({ id: memberId }).first('id', 'displayName', 'phone');
    return u ? { memberId: u.id, displayName: u.displayName || null, phone: u.phone || null } : null;
  }

  async function atMarketingCap(memberId) {
    if (marketingWeeklyCap <= 0) return true;
    const since = new Date(+now() - 7 * 86_400_000);
    const r = await db('CommunicationMessage').where({ memberId, category: 'marketing' }).whereNot('status', 'skipped')
      .where('createdAt', '>=', since).countDistinct({ n: db.raw('coalesce("campaignId", "automationRunId")') }).first();
    return Number(r?.n || 0) >= marketingWeeklyCap;
  }

  /**
   * Sends one automation to one member for one occurrence. Returns
   * 'fired' | 'already' (this occurrence was sent before) | 'deferred'
   * (they had an automation message today; try again later) | 'unavailable'
   * (template gone — the automation is paused).
   */
  async function fire(automation, facts, { occurrenceKey, subscriptionId = null, context = null }) {
    const at = now();
    const gymId = automation.gymId;
    const memberId = facts.memberId;
    const tpl = await db('CommunicationTemplate').where({ id: automation.templateId }).first();
    if (!tpl || tpl.status !== 'active') {
      await db('CommunicationAutomation').where({ id: automation.id, status: 'enabled' })
        .update({ status: 'paused', pausedReason: 'template_unavailable', updatedAt: at });
      return 'unavailable';
    }
    const sender = { senderType: 'gym', owner: { gymIds: [gymId] } };
    const { content } = await templateService.contentFromTemplate(sender, tpl.id, {
      locale: 'en', values: { amountTzs: context?.amountTzs },
    });
    const category = categoryForPurpose(tpl.purpose);
    const channels = (automation.channels || []).filter(c => CHANNELS.includes(c));
    const [reach, locales, gym, mapping, capped] = await Promise.all([
      segmentService.reachByMember([facts], category, channels),
      segmentService.localesByMember([memberId]),
      db('Gym').where({ id: gymId }).first('name'),
      channels.includes('whatsapp') ? templateService.whatsappMapping(tpl) : new Map(),
      category === 'marketing' ? atMarketingCap(memberId) : false,
    ]);
    const gymName = gym?.name || '';
    const locale = locales.get(memberId);
    const msg = renderMessage(content, facts, { gymName, renewalLink, locale });
    const runId = id('run');
    const rows = channels.map(ch => {
      let copy = msg;
      let payload = null;
      let reason = capped ? 'marketing_cap' : reach.get(memberId)?.[ch] ?? null;
      if (ch === 'whatsapp' && !reason) {
        const wa = whatsappMessage(content, facts, { gymName, renewalLink, locale: locale || msg.locale, mapping });
        if (!wa) reason = 'whatsapp_template_not_approved';
        else ({ copy, payload } = wa);
      }
      return {
        id: id('cmm'), automationRunId: runId, senderType: 'gym', gymId, memberId, channel: ch,
        category, messageType: tpl.purpose, title: copy.title, body: copy.body, deepLink: copy.deepLink,
        locale: copy.locale, ...(payload ? { payload } : {}),
        status: reason ? 'skipped' : 'queued', skipReason: reason, attempts: 0,
        nextAttemptAt: reason ? null : at, createdAt: at, updatedAt: at,
      };
    });
    const reachable = rows.some(r => r.status === 'queued');

    return db.transaction(async (trx) => {
      // One member at a time per gym, so two runs can't both slip past the
      // daily limit.
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`automation:${gymId}:${memberId}`]);
      const sent = await trx('AutomationRun').where({ automationId: automation.id, memberId, occurrenceKey }).first('id');
      if (sent) return 'already';
      if (reachable) {
        const today = await trx('AutomationRun').where({ gymId, memberId, status: 'queued' })
          .where('createdAt', '>=', startOfToday(at)).first('id');
        if (today) return 'deferred';
      }
      const inserted = await trx('AutomationRun').insert({
        id: runId, automationId: automation.id, gymId, memberId, occurrenceKey,
        status: reachable ? 'queued' : 'skipped', subscriptionId, context, createdAt: at,
      }).onConflict(['automationId', 'memberId', 'occurrenceKey']).ignore().returning('id');
      if (!inserted.length) return 'already';
      if (rows.length) {
        await assertGymRecipients(trx, rows);
        await trx('CommunicationMessage').insert(rows);
      }
      await trx('CommunicationAutomation').where({ id: automation.id }).update({ lastRunAt: at });
      return 'fired';
    });
  }

  function isFirstMembership(sub, others) {
    const start = sub.cycleStartedAt || sub.startedAt;
    return !others.some(o => o.id !== sub.id) && (!sub.startedAt || localDay(start) === localDay(sub.startedAt));
  }

  async function enabledFor(gymId, trigger) {
    return db('CommunicationAutomation').where({ gymId, trigger, status: 'enabled', senderType: 'gym' }).select('*');
  }

  async function activatedFor(automation, sub) {
    const conditions = typeof automation.conditions === 'string' ? JSON.parse(automation.conditions) : automation.conditions;
    if (conditions?.firstMembershipOnly) {
      const others = await db('Subscription').where({ memberId: sub.memberId, homeGymId: sub.homeGymId, type: 'direct_sub' }).select('id');
      if (!isFirstMembership(sub, others)) return null;
    }
    return { occurrenceKey: `${sub.id}:activated:${localDay(sub.cycleStartedAt || sub.startedAt || now())}`, subscriptionId: sub.id };
  }

  // ── events ─────────────────────────────────────────────────────────────

  /**
   * A lifecycle event from elsewhere in the app. Never throws — sending a
   * message must never break a payment or a registration.
   *   { type: 'membership_activated', subscription }
   *   { type: 'payment_failed', subscription, paymentRequestId?, reference?, amountTzs? }
   */
  async function handleEvent(event) {
    try {
      const sub = event?.subscription;
      if (!sub || sub.type !== 'direct_sub' || !sub.homeGymId || !AUTOMATION_TRIGGERS.includes(event.type)) return { fired: 0 };
      let fired = 0;
      for (const a of await enabledFor(sub.homeGymId, event.type)) {
        let occurrence;
        if (event.type === 'membership_activated') occurrence = await activatedFor(a, sub);
        else {
          const ref = event.paymentRequestId || event.reference;
          if (!ref) continue;
          occurrence = { occurrenceKey: `payment:${ref}`, subscriptionId: sub.id, context: event.amountTzs != null ? { amountTzs: Number(event.amountTzs) } : null };
        }
        if (!occurrence) continue;
        const facts = await factsFor(sub.homeGymId, sub.memberId);
        if (facts && (await fire(a, facts, occurrence)) === 'fired') fired += 1;
      }
      return { fired };
    } catch (err) {
      logger.error?.(`[automations] ${event?.type} failed: ${err.message}`);
      return { fired: 0, error: err.message };
    }
  }

  // ── the hourly run ─────────────────────────────────────────────────────

  function inSendHours(at) {
    const hour = new Date(+at + MEMBER_UTC_OFFSET_MINUTES * 60_000).getUTCHours();
    return hour >= sendHours.from && hour < sendHours.to;
  }

  /** Who an automation is due for right now, with each occurrence's key. */
  async function candidates(a, facts, today, at) {
    const n = a.offsetDays;
    const out = [];
    if (a.trigger === 'membership_expiring') {
      const low = Math.max(1, n - 1);
      for (const f of facts) {
        if (LIVE.includes(f.status) && inForce(f) && f.daysUntilExpiry != null && f.daysUntilExpiry <= n && f.daysUntilExpiry >= low) {
          out.push({ facts: f, occurrenceKey: `${f.expiresOn}:T-${n}`, subscriptionId: f.subscriptionId });
        }
      }
    } else if (a.trigger === 'membership_expired') {
      for (const f of facts) {
        if (f.status === 'expired' && inForce(f) && f.daysSinceExpiry >= 1 && f.daysSinceExpiry <= 2) {
          out.push({ facts: f, occurrenceKey: `${f.expiresOn}:expired`, subscriptionId: f.subscriptionId });
        }
      }
    } else if (a.trigger === 'member_inactive') {
      for (const f of facts) {
        if (!LIVE.includes(f.status) || !inForce(f)) continue;
        if (f.lastVisitDaysAgo != null) {
          if (f.lastVisitDaysAgo >= n && f.lastVisitDaysAgo <= n + 1) {
            out.push({ facts: f, occurrenceKey: `inactive:${addDays(today, -f.lastVisitDaysAgo)}` });
          }
        } else if (f.joinedDaysAgo != null && f.joinedDaysAgo >= n && f.joinedDaysAgo <= n + 1) {
          out.push({ facts: f, occurrenceKey: `inactive:never:${addDays(today, -f.joinedDaysAgo)}` });
        }
      }
    } else if (a.trigger === 'membership_activated') {
      const since = new Date(+at - RECENT_MS);
      const subs = await db('Subscription').where({ type: 'direct_sub', homeGymId: a.gymId, status: 'active' })
        .where(b => b.where('cycleStartedAt', '>=', since).orWhere('startedAt', '>=', since)).select('*');
      const byMember = new Map(facts.map(f => [f.memberId, f]));
      for (const sub of subs) {
        const occurrence = await activatedFor(a, sub);
        const f = byMember.get(sub.memberId);
        if (occurrence && f) out.push({ facts: f, ...occurrence });
      }
    } else if (a.trigger === 'payment_failed') {
      const since = new Date(+at - RECENT_MS);
      const failed = await db('PaymentRequest as p').join('Subscription as s', 's.id', 'p.subscriptionId')
        .where({ 'p.status': 'rejected', 's.type': 'direct_sub', 's.homeGymId': a.gymId })
        .where('p.decidedAt', '>=', since).select('p.id', 'p.memberId', 'p.amountTzs', 'p.subscriptionId');
      for (const p of failed) {
        const f = facts.find(x => x.memberId === p.memberId) || (await factsFor(a.gymId, p.memberId));
        if (f) out.push({ facts: f, occurrenceKey: `payment:${p.id}`, subscriptionId: p.subscriptionId, context: { amountTzs: Number(p.amountTzs) } });
      }
    }
    return out;
  }

  /**
   * One run over every gym with enabled automations (or just `gymIds`).
   * Safe to repeat or overlap: only one server runs it at a time, and every
   * send is keyed. Never throws; records a JobRun.
   */
  async function runDue({ gymIds = null } = {}) {
    const at = now();
    const stats = { gyms: 0, candidates: 0, fired: 0, already: 0, deferred: 0, paused: 0, errors: 0, outsideSendHours: false };
    const runId = id('job');
    let ran = false;
    await db.transaction(async (lock) => {
      const { rows: [{ ok }] } = await lock.raw('select pg_try_advisory_xact_lock(?) as ok', [LOCK_KEY]);
      if (!ok) return;
      ran = true;
      await db('JobRun').insert({ id: runId, job: 'communication_automations', status: 'running', startedAt: at }).catch(() => {});
      try {
        stats.outsideSendHours = !inSendHours(at);
        if (stats.outsideSendHours) return;
        const q = db('CommunicationAutomation').where({ status: 'enabled', senderType: 'gym' });
        if (gymIds) q.whereIn('gymId', gymIds);
        const enabled = await q.select('*');
        const byGym = new Map();
        for (const a of enabled) (byGym.get(a.gymId) || byGym.set(a.gymId, []).get(a.gymId)).push(a);
        const today = localDay(at);
        for (const [gymId, list] of byGym) {
          stats.gyms += 1;
          try {
            const facts = await segmentService.gymMemberFacts([gymId]);
            list.sort((x, y) => PRIORITY.indexOf(x.trigger) - PRIORITY.indexOf(y.trigger) || x.offsetDays - y.offsetDays);
            for (const a of list) {
              const due = await candidates(a, facts, today, at);
              stats.candidates += due.length;
              if (due.length > maxPerRun) {
                await db('CommunicationAutomation').where({ id: a.id, status: 'enabled' })
                  .update({ status: 'paused', pausedReason: `too_many_members:${due.length}`, updatedAt: at });
                audit(null, 'automation_paused', a.id, null, { reason: 'too_many_members', members: due.length, limit: maxPerRun });
                logger.warn?.(`[automations] paused ${a.id}: ${due.length} members due (limit ${maxPerRun})`);
                stats.paused += 1;
                continue;
              }
              for (const d of due) {
                const r = await fire(a, d.facts, d);
                if (r === 'fired') stats.fired += 1;
                else if (r === 'already') stats.already += 1;
                else if (r === 'deferred') stats.deferred += 1;
                else if (r === 'unavailable') { stats.paused += 1; break; }
              }
            }
          } catch (err) {
            stats.errors += 1;
            logger.error?.(`[automations] gym ${gymId} failed: ${err.message}`);
          }
        }
      } finally {
        await db('JobRun').where({ id: runId })
          .update({ status: stats.errors ? 'failed' : 'ok', finishedAt: now(), stats: JSON.stringify(stats) }).catch(() => {});
      }
    });
    return { ran, ...stats };
  }

  /** Gyms whose own expiry reminders replace the platform one (D4). */
  async function gymsWithReminders() {
    const rows = await db('CommunicationAutomation')
      .where({ trigger: 'membership_expiring', status: 'enabled', senderType: 'gym' }).distinct('gymId');
    return new Set(rows.map(r => r.gymId));
  }

  return {
    ensureDefaults, list, get, update, runs, preview, handleEvent, runDue, fire, candidates,
    gymsWithReminders, inSendHours,
  };
}
