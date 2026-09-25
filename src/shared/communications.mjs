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
