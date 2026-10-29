// Marathon & running events · S4 — the refund policy model (spec §3.12.1, §3.13). Pure: no I/O, no clocks of its
// own (the caller passes `now`), nothing thrown for a business refusal.
//
// An organizer picks one of five presets when the event is submitted; the choice is frozen in
// Event.refundPolicySnapshot (S2). Four of them can be evaluated by a machine; `custom` is free text that a
// person handles. All deadlines are INSTANTS (timestamps); the event's time zone only matters for display, so
// there is no daylight-saving arithmetic anywhere here.
//
//   no_refund            0% always
//   refund_until_close   100% while now < the category's (else the event's) registrationClosesAt
//   full_until_days      100% while now <= startsAt − days × 24 h                       { days 1..365 }
//   tiered               first tier (largest daysBefore first) whose time has not passed  { tiers 1..3 of { daysBefore, percent } }
//   custom               not evaluable: manual review
//
// Money is whole TZS. The only division is the percent step, and it never rounds up:
//   refundTzs = floor(paidTzs × percent / 100)  (paid < 2^31, so the product is exact in a double).

export const POLICY_PRESETS = Object.freeze(['no_refund', 'refund_until_close', 'full_until_days', 'tiered', 'custom']);
/** The two machine-evaluable presets S4 adds to the S2 set. */
export const NEW_POLICY_PRESETS = Object.freeze(['full_until_days', 'tiered']);
export const MAX_TIERS = 3;
export const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

const isInt = n => Number.isInteger(n);

/** The structured fields a stored policy carries, defaulting what is missing; unknown keys are dropped. */
export function normalisePolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { preset: typeof r.preset === 'string' ? r.preset : null, text: { en: r.text?.en ?? null, sw: r.text?.sw ?? null } };
  if (r.preset === 'full_until_days') out.days = r.days;
  if (r.preset === 'tiered') out.tiers = Array.isArray(r.tiers) ? r.tiers.map(t => ({ daysBefore: t?.daysBefore, percent: t?.percent })) : [];
  return out;
}

/**
 * Problems with a policy as [{ field, code }] (empty when fine). Codes: required, range, order.
 * Used by the document validator (S2 wizard Terms step) and again by evaluateRefund's callers.
 */
export function validatePolicy(policy) {
  const problems = [];
  const p = policy || {};
  if (!POLICY_PRESETS.includes(p.preset)) return [{ field: 'refundPolicy.preset', code: 'required' }];
  if (p.preset === 'full_until_days') {
    if (!isInt(p.days)) problems.push({ field: 'refundPolicy.days', code: 'required' });
    else if (p.days < 1 || p.days > MAX_DAYS) problems.push({ field: 'refundPolicy.days', code: 'range', min: 1, max: MAX_DAYS });
  }
  if (p.preset === 'tiered') {
    const tiers = Array.isArray(p.tiers) ? p.tiers : null;
    if (!tiers || tiers.length < 1) problems.push({ field: 'refundPolicy.tiers', code: 'required' });
    else if (tiers.length > MAX_TIERS) problems.push({ field: 'refundPolicy.tiers', code: 'range', min: 1, max: MAX_TIERS });
    else {
      tiers.forEach((t, i) => {
        if (!isInt(t?.daysBefore) || t.daysBefore < 1 || t.daysBefore > MAX_DAYS) problems.push({ field: `refundPolicy.tiers[${i}].daysBefore`, code: 'range', min: 1, max: MAX_DAYS });
        if (!isInt(t?.percent) || t.percent < 1 || t.percent > 100) problems.push({ field: `refundPolicy.tiers[${i}].percent`, code: 'range', min: 1, max: 100 });
        if (i > 0 && isInt(t?.daysBefore) && isInt(tiers[i - 1]?.daysBefore) && t.daysBefore >= tiers[i - 1].daysBefore) problems.push({ field: `refundPolicy.tiers[${i}].daysBefore`, code: 'order' });
        if (i > 0 && isInt(t?.percent) && isInt(tiers[i - 1]?.percent) && t.percent > tiers[i - 1].percent) problems.push({ field: `refundPolicy.tiers[${i}].percent`, code: 'order' });
      });
    }
  }
  return problems;
}

/** The plain line generated from the structured fields, EN and SW (so the preset and the words cannot disagree). null for custom. */
export function describePolicy(policy) {
  const p = normalisePolicy(policy);
  switch (p.preset) {
    case 'no_refund': return { en: 'No refund after you register.', sw: 'Hakuna marejesho baada ya kujisajili.' };
    case 'refund_until_close': return { en: 'Full refund until registration closes.', sw: 'Marejesho kamili hadi usajili ufungwe.' };
    case 'full_until_days': return isInt(p.days)
      ? { en: `Full refund until ${p.days} ${p.days === 1 ? 'day' : 'days'} before the event.`, sw: `Marejesho kamili hadi siku ${p.days} kabla ya tukio.` }
      : null;
    case 'tiered': {
      const tiers = (p.tiers || []).filter(t => isInt(t.daysBefore) && isInt(t.percent));
      if (!tiers.length) return null;
      const en = tiers.map(t => `${t.percent}% until ${t.daysBefore} ${t.daysBefore === 1 ? 'day' : 'days'} before`).join(', then ');
      const sw = tiers.map((t, i) => `${i === 0 ? 'marejesho ya asilimia' : 'asilimia'} ${t.percent} hadi siku ${t.daysBefore} kabla ya tukio`).join(', kisha ');
      return { en: `${en[0].toUpperCase()}${en.slice(1)}, then no refund.`, sw: `${sw[0].toUpperCase()}${sw.slice(1)}, kisha hakuna marejesho.` };
    }
    default: return null;
  }
}

const at = v => (v ? new Date(v) : null);

/**
 * What a cancellation at `now` is worth.
 *   policy   the event's frozen refundPolicySnapshot
 *   event    { status, startsAt, registrationClosesAt }
 *   category { registrationClosesAt } (optional)
 *   paidTzs  what the place(s) cost (the total the caller wants evaluated)
 * → { mode: 'auto' | 'none' | 'manual_review' | 'closed', percent, refundTzs, deadlineAt, tierIndex, reason }
 *   auto           a refund is owed by the policy (refundTzs > 0)
 *   none           the policy gives nothing now
 *   manual_review  `custom`: a person decides; refundTzs is the most that can be granted (paidTzs)
 *   closed         the event has started, or is in progress / completed (cancellation_window_closed)
 */
export function evaluateRefund({ policy, event, category = null, now, paidTzs }) {
  const paid = Number(paidTzs);
  const base = { percent: 0, refundTzs: 0, deadlineAt: null, tierIndex: null };
  if (!isInt(paid) || paid < 0) return { ...base, mode: 'none', reason: 'invalid_paid' };
  const nowMs = +new Date(now);
  const startsMs = event?.startsAt ? +new Date(event.startsAt) : null;
  if (['in_progress', 'completed', 'archived'].includes(event?.status) || (startsMs !== null && nowMs >= startsMs)) {
    return { ...base, mode: 'closed', reason: 'cancellation_window_closed' };
  }
  const p = normalisePolicy(policy);
  const done = (percent, extra = {}) => {
    const refundTzs = Math.floor((paid * percent) / 100);
    return { mode: refundTzs > 0 ? 'auto' : 'none', percent, refundTzs, deadlineAt: null, tierIndex: null, reason: refundTzs > 0 ? 'policy' : 'policy_zero', ...extra };
  };
  switch (p.preset) {
    case 'no_refund': return done(0, { reason: 'no_refund' });
    case 'refund_until_close': {
      const deadline = at(category?.registrationClosesAt) ?? at(event?.registrationClosesAt);
      if (!deadline) return done(0, { reason: 'no_deadline' });
      return nowMs < +deadline ? done(100, { deadlineAt: deadline.toISOString() }) : done(0, { deadlineAt: deadline.toISOString(), reason: 'deadline_passed' });
    }
    case 'full_until_days': {
      if (!isInt(p.days) || p.days < 1 || startsMs === null) return done(0, { reason: 'invalid_policy' });
      const deadline = new Date(startsMs - p.days * DAY_MS);
      return nowMs <= +deadline ? done(100, { deadlineAt: deadline.toISOString() }) : done(0, { deadlineAt: deadline.toISOString(), reason: 'deadline_passed' });
    }
    case 'tiered': {
      if (validatePolicy(p).length || startsMs === null) return done(0, { reason: 'invalid_policy' });
      const tiers = [...p.tiers].sort((a, b) => b.daysBefore - a.daysBefore);
      for (let i = 0; i < tiers.length; i += 1) {
        const deadline = new Date(startsMs - tiers[i].daysBefore * DAY_MS);
        if (nowMs <= +deadline) return done(tiers[i].percent, { deadlineAt: deadline.toISOString(), tierIndex: i });
      }
      const last = new Date(startsMs - tiers[tiers.length - 1].daysBefore * DAY_MS);
      return done(0, { deadlineAt: last.toISOString(), reason: 'deadline_passed' });
    }
    case 'custom': return { mode: 'manual_review', percent: null, refundTzs: paid, deadlineAt: null, tierIndex: null, reason: 'custom_policy' };
    default: return done(0, { reason: 'no_policy' });
  }
}

/** floor(paid × percent / 100) per place, summed (the percent step never rounds up). */
export const refundFor = (paidTzs, percent) => Math.floor((Number(paidTzs) * Number(percent)) / 100);

/**
 * Split a line total T over q places: each gets floor(T / q) and the first T mod q places (in the order given,
 * registrations by id) get one extra shilling. The parts sum to T exactly.
 */
export function apportion(totalTzs, quantity) {
  const t = Number(totalTzs);
  const q = Number(quantity);
  if (!isInt(t) || !isInt(q) || t < 0 || q < 1) return [];
  const base = Math.floor(t / q);
  const extra = t - base * q;
  return Array.from({ length: q }, (_, i) => base + (i < extra ? 1 : 0));
}
