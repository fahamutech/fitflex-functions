// Trainer interface business rules — gym access for trainers (trainer passes
// with a member-plan fallback), social handles and the bookable schedule.
// Pure logic — no I/O.

export const TRAINER_PASS_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);
export const SOCIAL_PLATFORMS = Object.freeze(['instagram', 'facebook', 'twitter']);
export const MAX_SCHEDULE_DAYS = 31;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Dar_es_Salaam, no DST

const positiveTzs = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ── Trainer passes ────────────────────────────────────────────────────────────

/**
 * Gym.trainerPass as `{ enabled, options: { daily?, weekly?, monthly? } }`
 * (fees in TZS). The legacy single-period shape `{ enabled, feeTzs, period }`
 * is read as a one-option pass. Options without a positive fee are dropped.
 */
export function normalizeTrainerPassConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const options = {};
  if (src.options && typeof src.options === 'object') {
    for (const period of TRAINER_PASS_PERIODS) {
      const fee = positiveTzs(src.options[period]);
      if (fee) options[period] = fee;
    }
  } else if (TRAINER_PASS_PERIODS.includes(src.period)) {
    const fee = positiveTzs(src.feeTzs);
    if (fee) options[src.period] = fee;
  }
  return { enabled: Boolean(src.enabled), options };
}

/** The trainer-pass periods a gym currently sells, cheapest-period first. */
export function trainerPassOptions(gym) {
  const cfg = normalizeTrainerPassConfig(gym?.trainerPass);
  if (!cfg.enabled) return [];
  return TRAINER_PASS_PERIODS
    .filter(p => cfg.options[p])
    .map(period => ({ kind: 'trainer_pass', period, feeTzs: cfg.options[period] }));
}

/** The gym's own member plans (direct_sub) — the fallback when no trainer pass is sold. */
export function memberPlanOptions(gym) {
  const rates = { daily: gym?.ratePerDay, weekly: gym?.ratePerWeek, monthly: gym?.ratePerMonth };
  return TRAINER_PASS_PERIODS
    .filter(p => positiveTzs(rates[p]))
    .map(period => ({ kind: 'member_plan', period, feeTzs: positiveTzs(rates[period]) }));
}

/**
 * How a trainer gets into a gym:
 *   home          — linked to the gym (owner-approved): free, no pass needed
 *   trainer_pass  — the gym sells trainer passes: only those are offered
 *   member_plan   — no trainer pass: the gym's member plans apply
 *   unavailable   — neither
 */
export function trainerGymAccess({ trainer, gym }) {
  if (trainer && gym && (trainer.gymIds || []).includes(gym.id)) return { access: 'home', options: [] };
  const passes = trainerPassOptions(gym);
  if (passes.length) return { access: 'trainer_pass', options: passes };
  const plans = memberPlanOptions(gym);
  if (plans.length) return { access: 'member_plan', options: plans };
  return { access: 'unavailable', options: [] };
}

/** Members never see trainer-pass pricing: strip it from any gym they receive. */
export function hideTrainerPass(gym) {
  if (!gym || typeof gym !== 'object' || !('trainerPass' in gym)) return gym;
  const { trainerPass, ...rest } = gym;
  return rest;
}

/** Viewers allowed to see Gym.trainerPass on public gym endpoints. */
export const canSeeTrainerPass = (userType) => userType === 'trainer' || userType === 'admin';

// ── Social handles ────────────────────────────────────────────────────────────

const HANDLE_RE = /^[A-Za-z0-9._-]{1,50}$/;
const HOSTS = {
  instagram: ['instagram.com', 'instagr.am'],
  facebook: ['facebook.com', 'fb.com', 'm.facebook.com'],
  twitter: ['twitter.com', 'x.com', 'mobile.twitter.com'],
};

/**
 * Accepts `handle`, `@handle` or a profile URL and returns the bare handle,
 * '' for an empty value, or null when it is not a valid handle. Facebook
 * numeric profiles are kept as `profile.php?id=<digits>`.
 */
export function normalizeSocialHandle(platform, value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  if (/^(https?:\/\/)?(www\.)?[a-z.]+\.[a-z]{2,}\//i.test(v)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!(HOSTS[platform] || []).includes(host)) return null;
    if (platform === 'facebook' && url.pathname === '/profile.php') {
      const id = url.searchParams.get('id');
      return id && /^\d{1,30}$/.test(id) ? `profile.php?id=${id}` : null;
    }
    v = url.pathname.split('/').filter(Boolean)[0] || '';
  }
  if (platform === 'facebook' && /^profile\.php\?id=\d{1,30}$/.test(v)) return v;
  v = v.replace(/^@/, '');
  return HANDLE_RE.test(v) ? v : null;
}

/**
 * Clean `{ instagram?, facebook?, twitter? }`. Empty values are removed.
 * @returns {{ links: object, invalid: string[] }}
 */
export function normalizeSocialLinks(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const links = {};
  const invalid = [];
  for (const platform of SOCIAL_PLATFORMS) {
    if (src[platform] === undefined || src[platform] === null) continue;
    const handle = normalizeSocialHandle(platform, src[platform]);
    if (handle === null) invalid.push(platform);
    else if (handle) links[platform] = handle;
  }
  return { links, invalid };
}

// ── Schedule (EAT) ────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** `9:00` → `09:00`; null when not a time of day. */
export function normalizeSlot(value) {
  const m = SLOT_RE.exec(String(value ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/** Today's calendar date in EAT as YYYY-MM-DD. */
export function eatToday(now = new Date()) {
  return new Date(+now + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(isoDate) {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()];
}

/** How long before a session a member may still cancel it for a refund (Member Terms 6). */
export const MEMBER_CANCEL_NOTICE_HOURS = 24;

/** When the slot `HH:MM` on `date` (EAT) starts, in epoch ms (NaN if malformed). */
export const slotStartMs = (date, slot) => Date.parse(`${date}T${slot}:00.000+03:00`);

/**
 * Whether a member can still cancel this booking, and until when. A booking
 * not yet paid for can be cancelled until it starts; a paid one until the
 * notice period before it, and is then refunded in full.
 */
export function memberCancellation(booking, now = new Date()) {
  const start = slotStartMs(booking.date, booking.slot);
  const open = ['payment_pending', 'confirmed'].includes(booking.status) && !Number.isNaN(start) && start > +now;
  if (!open) return { canCancel: false, refundable: false, cancelBy: null };
  if (booking.status === 'payment_pending') return { canCancel: true, refundable: false, cancelBy: new Date(start).toISOString() };
  const deadline = start - MEMBER_CANCEL_NOTICE_HOURS * 3_600_000;
  return { canCancel: deadline >= +now, refundable: Number(booking.amountTzs) > 0, cancelBy: new Date(deadline).toISOString() };
}

/** The slot `HH:MM` on `date` (EAT) has already started. */
export function isPastSlot(date, slot, now = new Date()) {
  const start = Date.parse(`${date}T${slot}:00.000+03:00`);
  return Number.isNaN(start) || start <= +now;
}

function canonicalDay(value) {
  const v = String(value || '').trim().toLowerCase();
  if (ISO_DATE_RE.test(v)) return v;
  return WEEKDAYS.find(d => d === v || d.slice(0, 3) === v) || null;
}

/**
 * Clean an availability list: `day` is a weekday name or an exact date
 * (legacy `date` entries are folded into `day`); slots are unique `HH:MM`.
 * Entries without a valid day or slots are dropped.
 */
export function normalizeAvailability(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const day = canonicalDay(entry.day ?? entry.date);
    const slots = [...new Set((Array.isArray(entry.slots) ? entry.slots : []).map(normalizeSlot).filter(Boolean))].sort();
    if (!day || !slots.length) continue;
    out.push({ day, ...(entry.gymId ? { gymId: String(entry.gymId) } : {}), slots });
  }
  return out;
}

/** Slots offered on `date` (optionally at `gymId`), with the gym each is offered at. */
function offeredSlots(availability, date, gymId) {
  const weekday = weekdayOf(date);
  const bySlot = new Map();
  for (const entry of normalizeAvailability(availability)) {
    if (entry.day !== weekday && entry.day !== date) continue;
    if (gymId && entry.gymId && entry.gymId !== gymId) continue;
    for (const slot of entry.slots) {
      if (!bySlot.has(slot)) bySlot.set(slot, new Set());
      if (entry.gymId) bySlot.get(slot).add(entry.gymId);
    }
  }
  return bySlot;
}

/**
 * Expand weekly availability into dated hourly slots.
 * @param {object} args
 * @param {Array}  args.availability trainer availability
 * @param {Array}  args.bookings     slot-holding bookings `{ date, slot, ... }`
 * @param {string} [args.from]       first date (default: today EAT; never before today)
 * @param {number} [args.days]       number of days (1..MAX_SCHEDULE_DAYS, default 21)
 * @param {string} [args.gymId]      only slots offered at this gym
 * @param {(b:object)=>object} [args.describeBooking] adds booking detail to a booked slot
 * @returns {Array<{ date, weekday, slots: Array<{ slot, status, gymIds, booking? }> }>}
 */
export function buildTrainerSchedule({
  availability, bookings = [], from, days = 21, gymId, now = new Date(), describeBooking,
}) {
  const today = eatToday(now);
  const start = ISO_DATE_RE.test(from || '') && from > today ? from : today;
  const count = Math.min(MAX_SCHEDULE_DAYS, Math.max(1, Math.floor(Number(days) || 21)));
  const held = new Map(bookings.map(b => [`${b.date}|${b.slot}`, b]));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const date = addDays(start, i);
    const slots = [...offeredSlots(availability, date, gymId)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slot, gyms]) => {
        const booking = held.get(`${date}|${slot}`);
        const status = booking ? 'booked' : (isPastSlot(date, slot, now) ? 'past' : 'available');
        return {
          slot,
          status,
          gymIds: [...gyms],
          ...(booking && describeBooking ? { booking: describeBooking(booking) } : {}),
        };
      });
    out.push({ date, weekday: weekdayOf(date), slots });
  }
  return out;
}
