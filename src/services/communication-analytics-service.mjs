// Communication analytics (M10) — how a campaign or automation did, in
// three groups, all from records that already exist:
//
//   Delivery    the CommunicationMessage ledger: recipients, sent,
//               delivered, failed, skipped (with reasons);
//   Engagement  the ledger's openedAt / clickedAt (inbox read, push opened,
//               WhatsApp read receipt; button taps), and "CTA completed" —
//               the member did what the button led to (paid, renewed,
//               visited the gym) within 7 days of tapping it;
//   Business    approved PaymentRequests: renewed, payments completed and
//               attributed revenue.
//
// Attribution is last touch: a payment belongs to the last message the
// member TAPPED in the 7 days before paying, or failing that the last one
// they OPENED in the 3 days before. Every message the same sender sent
// that member competes, so a payment is credited to one campaign or
// automation only. A gym's messages are credited with payments for
// memberships at that gym; FitFlex's with FitFlex pass payments.
//
// Nothing is estimated. Where there's no data source the value is null
// (shown as "—"): push has no delivery receipt, and a message whose button
// only opens the message has no CTA to complete.
import { ownerGymIds } from '../shared/member-status.mjs';

export const ATTRIBUTION = Object.freeze({ model: 'last_touch', clickWindowDays: 7, openWindowDays: 3 });
const DAY = 86_400_000;
const REACHED = ['sent', 'delivered', 'read', 'clicked'];
const CHANNELS = ['in_app', 'push', 'whatsapp', 'sms'];
// Where a button leads, and what finishing it means.
const PAYMENT_GOALS = ['renewal', 'membership', 'payment'];
const CONVERSION_LIST_MAX = 50;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const ms = (d) => (d ? +new Date(d) : null);

export function createCommunicationAnalyticsService({ db, now = () => new Date() }) {
  // ── scope ──────────────────────────────────────────────────────────────

  function scopeFor(sender, gymId = null) {
    if (sender?.senderType === 'platform') return { platform: true, apply: (q, t = 'm') => q.where(`${t}.senderType`, 'platform') };
    if (sender?.senderType !== 'gym') return { error: 'forbidden', status: 403 };
    const mine = ownerGymIds(sender.owner);
    if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const gymIds = gymId != null ? [gymId] : mine;
    return { platform: false, gymIds, apply: (q, t = 'm') => q.where(`${t}.senderType`, 'gym').whereIn(`${t}.gymId`, gymIds) };
  }

  const COLUMNS = ['m.id', 'm.memberId', 'm.gymId', 'm.channel', 'm.status', 'm.deepLink', 'm.campaignId', 'm.automationRunId',
    'm.createdAt', 'm.deliveredAt', 'm.openedAt', 'm.clickedAt', 'm.failureReason', 'm.skipReason', 'r.automationId'];
  const ledger = () => db('CommunicationMessage as m').leftJoin('AutomationRun as r', 'r.id', 'm.automationRunId');
  const sourceOf = (row) => (row.campaignId ? `campaign:${row.campaignId}` : row.automationId ? `automation:${row.automationId}` : null);

  // ── delivery and engagement ────────────────────────────────────────────

  function funnel(rows) {
    const byMember = new Map();
    for (const r of rows) (byMember.get(r.memberId) || byMember.set(r.memberId, []).get(r.memberId)).push(r);
    const members = { recipients: byMember.size, sent: 0, delivered: 0, failed: 0, opened: 0, clicked: 0 };
    for (const list of byMember.values()) {
      const reached = list.some(r => REACHED.includes(r.status));
      if (reached) members.sent += 1;
      else if (list.some(r => r.status === 'failed')) members.failed += 1;
      if (list.some(r => r.deliveredAt)) members.delivered += 1;
      if (list.some(r => r.openedAt)) members.opened += 1;
      if (list.some(r => r.clickedAt)) members.clicked += 1;
    }
    const channels = {};
    for (const ch of CHANNELS) {
      const list = rows.filter(r => r.channel === ch);
      if (!list.length) continue;
      channels[ch] = {
        messages: list.length,
        sent: list.filter(r => REACHED.includes(r.status)).length,
        // Push can't confirm delivery: no data, not zero.
        delivered: ch === 'push' ? null : list.filter(r => r.deliveredAt).length,
        opened: list.filter(r => r.openedAt).length,
        clicked: list.filter(r => r.clickedAt).length,
        failed: list.filter(r => r.status === 'failed').length,
        skipped: list.filter(r => r.status === 'skipped').length,
        pending: list.filter(r => ['queued', 'sending'].includes(r.status)).length,
      };
    }
    const reasons = { failed: {}, skipped: {} };
    for (const r of rows) {
      if (r.status === 'failed' && r.failureReason) reasons.failed[r.failureReason] = (reasons.failed[r.failureReason] || 0) + 1;
      if (r.status === 'skipped' && r.skipReason) reasons.skipped[r.skipReason] = (reasons.skipped[r.skipReason] || 0) + 1;
    }
    // Delivery confirmation exists only for in-app and WhatsApp.
    if (!rows.some(r => r.channel !== 'push')) members.delivered = null;
    return { members, channels, reasons };
  }

  // ── attribution ────────────────────────────────────────────────────────

  /**
   * Approved payments by these members in [from, to], each credited (last
   * touch) to one of the sender's messages — or to nothing.
   */
  async function attribute(scope, memberIds, from, to) {
    if (!memberIds.length) return [];
    const clickMs = ATTRIBUTION.clickWindowDays * DAY;
    const openMs = ATTRIBUTION.openWindowDays * DAY;
    const paidAt = db.raw('coalesce(p."decidedAt", p."requestedAt")');
    const payments = await db('PaymentRequest as p').join('Subscription as s', 's.id', 'p.subscriptionId')
      .where('p.status', 'approved').whereIn('p.memberId', memberIds)
      .where(paidAt, '>=', from).where(paidAt, '<=', to)
      .modify(q => (scope.platform ? q.where('s.type', 'platform_pass') : q.where('s.type', 'direct_sub').whereIn('s.homeGymId', scope.gymIds)))
      .select('p.id', 'p.memberId', 'p.amountTzs', 'p.subscriptionId', { paidAt }, 's.homeGymId', 's.startedAt as subStartedAt');
    if (!payments.length) return [];
    const touches = await scope.apply(ledger())
      .whereIn('m.memberId', [...new Set(payments.map(p => p.memberId))])
      .where(b => b.whereNotNull('m.clickedAt').orWhereNotNull('m.openedAt'))
      .where(b => b.where('m.clickedAt', '>=', new Date(+from - clickMs)).orWhere('m.openedAt', '>=', new Date(+from - clickMs)))
      .select(COLUMNS);
    // To tell a renewal from a first payment: earlier memberships at the
    // gym, and earlier approved payments on the same membership (an owner's
    // "Renew" extends the same subscription).
    const [earlier, paidBefore] = await Promise.all([
      db('Subscription').whereIn('memberId', [...new Set(payments.map(p => p.memberId))])
        .modify(q => (scope.platform ? q.where('type', 'platform_pass') : q.where('type', 'direct_sub').whereIn('homeGymId', scope.gymIds)))
        .select('id', 'memberId', 'homeGymId', 'startedAt'),
      db('PaymentRequest').where('status', 'approved').whereIn('subscriptionId', [...new Set(payments.map(p => p.subscriptionId))])
        .select('id', 'subscriptionId', { at: db.raw('coalesce("decidedAt", "requestedAt")') }),
    ]);
    const out = [];
    for (const p of payments) {
      const at = ms(p.paidAt);
      const mine = touches.filter(t => t.memberId === p.memberId && (scope.platform || t.gymId === p.homeGymId));
      const last = (key, window) => mine
        .filter(t => t[key] && ms(t[key]) <= at && ms(t[key]) >= at - window)
        .sort((a, b) => ms(b[key]) - ms(a[key]))[0];
      const click = last('clickedAt', clickMs);
      const touch = click || last('openedAt', openMs);
      if (!touch) continue;
      const touchAt = ms(click ? touch.clickedAt : touch.openedAt);
      const renewal = earlier.some(s => s.memberId === p.memberId && s.id !== p.subscriptionId && ms(s.startedAt) < at)
        || paidBefore.some(x => x.subscriptionId === p.subscriptionId && x.id !== p.id && ms(x.at) < at)
        || (p.subStartedAt && ms(p.subStartedAt) < touchAt);
      out.push({
        paymentId: p.id, memberId: p.memberId, amountTzs: Number(p.amountTzs || 0), paidAt: iso(p.paidAt),
        source: sourceOf(touch), via: click ? 'click' : 'open', touchAt: iso(touchAt), renewal: Boolean(renewal),
      });
    }
    return out;
  }

  /**
   * Members who did what the button led to, within 7 days of tapping it:
   * paid or renewed (renewal / membership / payment buttons) or visited
   * the gym (gym button). Null when no message had such a button.
   */
  async function ctaCompleted(scope, rows) {
    const clicked = rows.filter(r => r.clickedAt && r.deepLink && r.deepLink !== 'message');
    if (!rows.some(r => r.deepLink && r.deepLink !== 'message')) return null;
    if (!clicked.length) return 0;
    const members = [...new Set(clicked.map(r => r.memberId))];
    const from = new Date(Math.min(...clicked.map(r => ms(r.clickedAt))));
    const to = new Date(Math.max(...clicked.map(r => ms(r.clickedAt))) + ATTRIBUTION.clickWindowDays * DAY);
    const paidAt = db.raw('coalesce(p."decidedAt", p."requestedAt")');
    const [paid, visits] = await Promise.all([
      clicked.some(r => PAYMENT_GOALS.includes(r.deepLink))
        ? db('PaymentRequest as p').join('Subscription as s', 's.id', 'p.subscriptionId').where('p.status', 'approved')
          .whereIn('p.memberId', members).where(paidAt, '>=', from).where(paidAt, '<=', to)
          .modify(q => (scope.platform ? q.where('s.type', 'platform_pass') : q.where('s.type', 'direct_sub').whereIn('s.homeGymId', scope.gymIds)))
          .select('p.memberId', { at: paidAt }, 's.homeGymId')
        : [],
      clicked.some(r => r.deepLink === 'gym')
        ? db('Checkin').whereIn('memberId', members).where('timestamp', '>=', from).where('timestamp', '<=', to)
          .modify(q => (scope.platform ? q : q.whereIn('gymId', scope.gymIds))).select('memberId', 'timestamp as at', 'gymId')
        : [],
    ]);
    const done = new Set();
    for (const r of clicked) {
      const start = ms(r.clickedAt);
      const end = start + ATTRIBUTION.clickWindowDays * DAY;
      const pool = r.deepLink === 'gym' ? visits : PAYMENT_GOALS.includes(r.deepLink) ? paid : [];
      if (pool.some(x => x.memberId === r.memberId && ms(x.at) >= start && ms(x.at) <= end
        && (scope.platform || (x.homeGymId ?? x.gymId) === r.gymId))) done.add(r.memberId);
    }
    return done.size;
  }

  async function report(scope, rows, { source, from = null, to = null, withConversions = true }) {
    const f = funnel(rows);
    const memberIds = [...new Set(rows.filter(r => r.openedAt || r.clickedAt).map(r => r.memberId))];
    const firstTouch = rows.reduce((min, r) => Math.min(min, ms(r.openedAt) ?? Infinity, ms(r.clickedAt) ?? Infinity), Infinity);
    const credited = Number.isFinite(firstTouch)
      ? (await attribute(scope, memberIds, new Date(firstTouch), to ?? now())).filter(a => a.source === source)
      : [];
    const names = withConversions && credited.length
      ? new Map((await db('User').whereIn('id', [...new Set(credited.map(c => c.memberId))]).select('id', 'displayName')).map(u => [u.id, u.displayName]))
      : new Map();
    return {
      ...(from ? { period: { from: iso(from), to: iso(to ?? now()) } } : {}),
      attribution: ATTRIBUTION,
      members: {
        ...f.members,
        ctaCompleted: await ctaCompleted(scope, rows),
        renewed: new Set(credited.filter(c => c.renewal).map(c => c.memberId)).size,
        paid: new Set(credited.map(c => c.memberId)).size,
      },
      revenue: {
        currency: 'TZS',
        attributedTzs: credited.reduce((s, c) => s + c.amountTzs, 0),
        payments: credited.length,
      },
      channels: f.channels,
      reasons: f.reasons,
      ...(withConversions ? {
        conversions: credited.sort((a, b) => ms(b.paidAt) - ms(a.paidAt)).slice(0, CONVERSION_LIST_MAX)
          .map(c => ({ ...c, memberName: names.get(c.memberId) ?? null, source: undefined })),
      } : {}),
    };
  }

  // ── per campaign, per automation, overview ─────────────────────────────

  async function campaign(sender, campaignId) {
    const scope = scopeFor(sender);
    if (scope.error) return scope;
    const c = await scope.apply(db('CommunicationCampaign as c'), 'c').where('c.id', campaignId).first('c.id', 'c.name', 'c.status', 'c.sentAt', 'c.createdAt');
    if (!c) return { error: 'not_found', status: 404 };
    const rows = await scope.apply(ledger()).where('m.campaignId', c.id).select(COLUMNS);
    return {
      campaign: { id: c.id, name: c.name, status: c.status, sentAt: iso(c.sentAt) },
      ...(await report(scope, rows, { source: `campaign:${c.id}` })),
    };
  }

  const periodOf = (days) => {
    const d = Number(days ?? 30);
    if (!Number.isInteger(d) || d < 1 || d > 365) return { error: 'invalid_days', status: 400 };
    const to = now();
    return { from: new Date(+to - d * DAY), to, days: d };
  };

  async function automation(sender, automationId, { days = 30 } = {}) {
    const scope = scopeFor(sender);
    if (scope.error) return scope;
    const p = periodOf(days);
    if (p.error) return p;
    const a = await db('CommunicationAutomation').where({ id: automationId }).first('id', 'name', 'trigger', 'offsetDays', 'gymId', 'senderType');
    if (!a || (scope.platform ? a.senderType !== 'platform' : !scope.gymIds.includes(a.gymId))) return { error: 'not_found', status: 404 };
    const rows = await scope.apply(ledger()).where('r.automationId', a.id).where('m.createdAt', '>=', p.from).select(COLUMNS);
    return {
      automation: { id: a.id, name: a.name, trigger: a.trigger, offsetDays: a.offsetDays },
      ...(await report(scope, rows, { source: `automation:${a.id}`, from: p.from, to: p.to })),
    };
  }

  /**
   * Totals for the last `days`, and each campaign and automation that sent
   * in that time with its numbers — newest first.
   */
  async function overview(sender, { days = 30, gymId = null } = {}) {
    const scope = scopeFor(sender, gymId);
    if (scope.error) return scope;
    const p = periodOf(days);
    if (p.error) return p;
    const rows = await scope.apply(ledger()).where('m.createdAt', '>=', p.from).select(COLUMNS);
    const f = funnel(rows);
    const memberIds = [...new Set(rows.filter(r => r.openedAt || r.clickedAt).map(r => r.memberId))];
    const credited = await attribute(scope, memberIds, p.from, p.to);
    const bySource = new Map();
    for (const r of rows) {
      const key = sourceOf(r);
      if (key) (bySource.get(key) || bySource.set(key, []).get(key)).push(r);
    }
    const campaignIds = [...bySource.keys()].filter(k => k.startsWith('campaign:')).map(k => k.slice(9));
    const automationIds = [...bySource.keys()].filter(k => k.startsWith('automation:')).map(k => k.slice(11));
    const [campaigns, automations] = await Promise.all([
      campaignIds.length ? db('CommunicationCampaign').whereIn('id', campaignIds).select('id', 'name', 'purpose', 'status', 'sentAt', 'createdAt') : [],
      automationIds.length ? db('CommunicationAutomation').whereIn('id', automationIds).select('id', 'name', 'trigger', 'offsetDays') : [],
    ]);
    const sources = [...bySource.entries()].map(([key, list]) => {
      const [type, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const meta = type === 'campaign' ? campaigns.find(c => c.id === id) : automations.find(a => a.id === id);
      const mine = credited.filter(c => c.source === key);
      const s = funnel(list).members;
      return {
        type, id, name: meta?.name ?? null,
        ...(type === 'campaign' ? { purpose: meta?.purpose ?? null, sentAt: iso(meta?.sentAt) } : { trigger: meta?.trigger ?? null, offsetDays: meta?.offsetDays ?? null }),
        lastSentAt: iso(Math.max(...list.map(r => ms(r.createdAt)))),
        recipients: s.recipients, sent: s.sent, opened: s.opened, clicked: s.clicked,
        paid: new Set(mine.map(c => c.memberId)).size, attributedTzs: mine.reduce((t, c) => t + c.amountTzs, 0),
      };
    }).sort((a, b) => ms(b.lastSentAt) - ms(a.lastSentAt));
    return {
      period: { from: iso(p.from), to: iso(p.to), days: p.days },
      attribution: ATTRIBUTION,
      members: {
        ...f.members,
        ctaCompleted: await ctaCompleted(scope, rows),
        renewed: new Set(credited.filter(c => c.renewal).map(c => c.memberId)).size,
        paid: new Set(credited.map(c => c.memberId)).size,
      },
      revenue: { currency: 'TZS', attributedTzs: credited.reduce((t, c) => t + c.amountTzs, 0), payments: credited.length },
      channels: f.channels,
      sources,
    };
  }

  return { campaign, automation, overview, attribute, funnel };
}
