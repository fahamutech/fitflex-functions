// Communications — the shared vocabulary and rules for gym and FitFlex
// (platform) messages to members. Pure functions only; services and the
// segment/dispatch code build on these so every path applies the same rules.

export const SENDER_TYPES = ['gym', 'platform'];
export const CHANNELS = ['in_app', 'push', 'whatsapp'];
export const CATEGORIES = ['transactional', 'marketing'];

// What a campaign is for. Promotions and engagement nudges are marketing;
// renewals, payments and announcements are service messages the member
// can't switch off in-app.
export const PURPOSE_CATEGORY = Object.freeze({
  promotion: 'marketing',
  engagement: 'marketing',
  general: 'marketing',
  renewal: 'transactional',
  payment: 'transactional',
  announcement: 'transactional',
});
export const PURPOSES = Object.keys(PURPOSE_CATEGORY);

export function categoryForPurpose(purpose) {
  return PURPOSE_CATEGORY[purpose] ?? null;
}

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'failed', 'cancelled'];

// Allowed campaign status changes. Anything not listed is refused, so a
// sent campaign can never be re-sent or edited back into a draft.
const CAMPAIGN_TRANSITIONS = Object.freeze({
  draft: ['scheduled', 'sending', 'cancelled'],
  scheduled: ['draft', 'sending', 'cancelled'],
  sending: ['sent', 'partially_failed', 'failed'],
  sent: [],
  partially_failed: [],
  failed: [],
  cancelled: [],
});

export function canTransitionCampaign(from, to) {
  return (CAMPAIGN_TRANSITIONS[from] || []).includes(to);
}

export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'clicked', 'failed', 'skipped'];

export const AUTOMATION_TRIGGERS = [
  'membership_activated',
  'membership_expiring',   // offsetDays = days before expiry (7, 3, 1)
  'membership_expired',
  'payment_failed',
  'member_inactive',       // offsetDays = days without a check-in (14)
];

export const TEMPLATE_VARIABLES = [
  'member_name', 'gym_name', 'plan_name', 'expiry_date',
  'amount', 'discount', 'offer_name', 'renewal_link',
];

export const LOCALES = ['en', 'sw'];

// A gym's campaign or automation always names its gym; a FitFlex one never does.
export function validSender(senderType, gymId) {
  if (senderType === 'gym') return Boolean(gymId);
  if (senderType === 'platform') return gymId == null;
  return false;
}

// Defaults for a member with no preference row. WhatsApp marketing stays off
// until the member opts in; everything else is on.
export const DEFAULT_PREFERENCES = Object.freeze({
  inAppMarketing: true,
  pushMarketing: true,
  whatsappTransactional: true,
  whatsappMarketing: false,
  whatsappOptedOutAt: null,
  locale: null,
});

export function effectivePreferences(row) {
  const prefs = { ...DEFAULT_PREFERENCES };
  if (!row) return prefs;
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    if (row[key] !== undefined && row[key] !== null) prefs[key] = row[key];
  }
  return prefs;
}

/**
 * Whether a member's preferences let a message go out on a channel.
 * Transactional in-app and push can't be switched off. Opting out of
 * WhatsApp (STOP) blocks every WhatsApp message.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function channelAllowed(prefsRow, channel, category) {
  if (!CHANNELS.includes(channel)) return { allowed: false, reason: 'unknown_channel' };
  if (!CATEGORIES.includes(category)) return { allowed: false, reason: 'unknown_category' };
  const p = effectivePreferences(prefsRow);
  const marketing = category === 'marketing';
  if (channel === 'in_app') {
    return !marketing || p.inAppMarketing ? { allowed: true } : { allowed: false, reason: 'in_app_marketing_off' };
  }
  if (channel === 'push') {
    return !marketing || p.pushMarketing ? { allowed: true } : { allowed: false, reason: 'push_marketing_off' };
  }
  if (p.whatsappOptedOutAt) return { allowed: false, reason: 'whatsapp_opted_out' };
  if (marketing) {
    return p.whatsappMarketing ? { allowed: true } : { allowed: false, reason: 'whatsapp_marketing_not_opted_in' };
  }
  return p.whatsappTransactional ? { allowed: true } : { allowed: false, reason: 'whatsapp_transactional_off' };
}

// ── Message content ────────────────────────────────────────────────────────

// Where a message's button takes the member in the app. `message` just
// opens the message itself.
export const DEEP_LINKS = ['message', 'membership', 'renewal', 'payment', 'gym'];

export const CONTENT_LIMITS = Object.freeze({ title: 65, body: 1000, ctaLabel: 25, offerName: 60, discount: 20 });

// Values the sender types in once for the whole campaign; the rest come
// from each member's own record.
const SENDER_VALUES = { offer_name: 'offerName', discount: 'discount', amount: 'amountTzs' };

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Variable names used in a text, e.g. "Hi {{member_name}}" → ['member_name']. */
export function variablesIn(text) {
  return [...new Set([...String(text || '').matchAll(VARIABLE_RE)].map(m => m[1]))];
}

const isBlank = (v) => v == null || (typeof v === 'string' && !v.trim());

/**
 * Checks a campaign's message and returns a clean copy.
 * `renewalLinkAvailable` says whether {{renewal_link}} has a URL to point at.
 * @returns {{ content: object } | { error: string, status: number, detail?: string }}
 */
export function validateContent(input, { renewalLinkAvailable = false } = {}) {
  const bad = (detail) => ({ error: 'invalid_content', status: 400, detail });
  if (!input || typeof input !== 'object') return bad('content_required');
  const text = (key) => (typeof input[key] === 'string' ? input[key].trim() : input[key]);
  const title = text('title');
  const body = text('body');
  if (isBlank(title)) return bad('title_required');
  if (isBlank(body)) return bad('body_required');
  if (typeof title !== 'string' || title.length > CONTENT_LIMITS.title) return bad('title_too_long');
  if (typeof body !== 'string' || body.length > CONTENT_LIMITS.body) return bad('body_too_long');

  const out = { title, body, deepLink: 'message' };
  const ctaLabel = text('ctaLabel');
  if (!isBlank(ctaLabel)) {
    if (typeof ctaLabel !== 'string' || ctaLabel.length > CONTENT_LIMITS.ctaLabel) return bad('cta_label_too_long');
    out.ctaLabel = ctaLabel;
  }
  if (input.deepLink != null) {
    if (!DEEP_LINKS.includes(input.deepLink)) return bad('unknown_deep_link');
    out.deepLink = input.deepLink;
  }
  const offerName = text('offerName');
  if (!isBlank(offerName)) {
    if (typeof offerName !== 'string' || offerName.length > CONTENT_LIMITS.offerName) return bad('offer_name_too_long');
    out.offerName = offerName;
  }
  const discount = text('discount');
  if (!isBlank(discount)) {
    if (typeof discount !== 'string' || discount.length > CONTENT_LIMITS.discount) return bad('discount_too_long');
    out.discount = discount;
  }
  if (input.amountTzs != null) {
    if (!Number.isInteger(input.amountTzs) || input.amountTzs < 0 || input.amountTzs > 100_000_000) return bad('bad_amount');
    out.amountTzs = input.amountTzs;
  }

  for (const name of variablesIn(`${title} ${body}`)) {
    if (!TEMPLATE_VARIABLES.includes(name)) return bad(`unknown_variable:${name}`);
    if (SENDER_VALUES[name] && out[SENDER_VALUES[name]] == null) return bad(`missing_value:${name}`);
    if (name === 'renewal_link' && !renewalLinkAvailable) return bad('variable_unavailable:renewal_link');
  }
  return { content: out };
}

const formatTzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;
// Numeric day/month/year reads the same in English and Swahili.
const formatDay = (day) => (day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : '');
const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/**
 * The values for one member's copy of a message.
 * @param {object} content  validated campaign content
 * @param {object} member   audience facts (displayName, plan, tier, expiresOn)
 * @param {{ gymName?: string, renewalLink?: string }} ctx
 */
export function messageValues(content, member, { gymName = '', renewalLink = '' } = {}) {
  return {
    member_name: member?.displayName || '',
    gym_name: gymName || 'FitFlex',
    plan_name: titleCase(member?.plan || member?.tier || ''),
    expiry_date: formatDay(member?.expiresOn),
    amount: content.amountTzs != null ? formatTzs(content.amountTzs) : '',
    discount: content.discount || '',
    offer_name: content.offerName || '',
    renewal_link: renewalLink,
  };
}

/** Fills {{variables}}; tidies the spaces an empty value leaves behind. */
export function renderText(text, values) {
  return String(text || '')
    .replace(VARIABLE_RE, (_, name) => values[name] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    .trim();
}
