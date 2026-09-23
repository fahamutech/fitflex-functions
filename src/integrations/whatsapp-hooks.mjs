// WhatsApp notification hooks — thin client for the standalone
// fitflex-whatsapp service. Every notification is the same POST shape, so the
// catalogue below is data rather than one function per template.
//
// Delivery is fire-and-forget: a notification failure must never surface as an
// error on the member-facing operation that triggered it.

const REQUEST_TIMEOUT_MS = 5000;

// templateKey → params the service's message template interpolates.
export const NOTIFICATION_TEMPLATES = Object.freeze({
  checkin_receipt: ['gymName', 'date', 'time', 'visitsUsed', 'visitCap'],
  checkin_failed: ['gymName', 'reason'],
  booking_pending: ['trainerName', 'date', 'time'],
  booking_confirmed: ['trainerName', 'date', 'time', 'gymName'],
  booking_cancelled: ['trainerName', 'date', 'time', 'reason'],
  booking_reminder: ['trainerName', 'date', 'time', 'gymName'],
  trainer_booking_completed: ['memberName', 'date', 'amountTzs'],
  subscription_activated: ['tier', 'expiresAt', 'visitCap'],
  subscription_renewal: ['tier', 'daysRemaining', 'amountTzs'],
  subscription_payment_failed: ['tier', 'amountTzs', 'reason'],
  subscription_expired: ['tier', 'expiredAt'],
  gym_payout: ['gymName', 'amountTzs', 'periodStart', 'periodEnd', 'reference'],
  trainer_payout: ['amountTzs', 'periodStart', 'periodEnd', 'reference'],
  credits_topup: ['amountTzs', 'balanceTzs'],
  credits_deducted: ['amountTzs', 'balanceTzs', 'gymName'],
  credits_expiry_warning: ['amountTzs', 'expiresAt'],
  streak_nudge: ['streakDays'],
  low_visits_nudge: ['visitsRemaining', 'daysRemaining'],
  otp: ['code'],
  corporate_monthly_report: ['companyName', 'period', 'activeStaff', 'engagementRatePct'],
});

/**
 * @param {object}   config
 * @param {string}  [config.apiBase]        Base URL of fitflex-whatsapp. Unset = notifier disabled.
 * @param {string}  [config.internalToken]  Shared secret for the service's /internal routes.
 * @param {boolean} [config.isProd]
 * @param {Function}[config.fetchImpl]      Injectable for tests.
 */
export function createWhatsAppNotifier({
  apiBase = process.env.WHATSAPP_SERVICE_URL,
  internalToken = process.env.FITFLEX_INTERNAL_TOKEN,
  isProd = process.env.NODE_ENV === 'production',
  fetchImpl = globalThis.fetch,
} = {}) {
  const enabled = Boolean(apiBase);

  // Mirrors the JWT_SECRET contract in src/auth/jwt.mjs: never fall back to a
  // baked-in shared secret, or an unconfigured production deploy would
  // authenticate against the service with a publicly known token.
  if (enabled && !internalToken) {
    if (isProd) throw new Error('FATAL: FITFLEX_INTERNAL_TOKEN must be set when WHATSAPP_SERVICE_URL is configured');
    console.warn('[whatsapp] FITFLEX_INTERNAL_TOKEN unset — notifications will be rejected by the service');
  }
  if (!enabled) {
    console.warn('[whatsapp] WHATSAPP_SERVICE_URL unset — notifications are disabled');
  }

  async function notify({ to, templateKey, language = 'en', params = {}, metadata = {} }) {
    if (!enabled) return { ok: false, skipped: 'notifier_disabled' };
    if (!to) return { ok: false, skipped: 'no_recipient' };

    const expected = NOTIFICATION_TEMPLATES[templateKey];
    if (!expected) return { ok: false, skipped: 'unknown_template', templateKey };
    const missing = expected.filter(p => params[p] === undefined || params[p] === null);
    if (missing.length) return { ok: false, skipped: 'missing_params', templateKey, missing };

    // The service interpolates params into a text template, so send strings.
    const stringParams = Object.fromEntries(expected.map(p => [p, String(params[p])]));

    try {
      const response = await fetchImpl(`${apiBase}/internal/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
        body: JSON.stringify({ to, templateKey, language, params: stringParams, metadata }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(`[whatsapp] ${templateKey} rejected with ${response.status}`);
        return { ok: false, status: response.status };
      }
      return { ok: true, ...(await response.json().catch(() => ({}))) };
    } catch (err) {
      console.warn(`[whatsapp] ${templateKey} delivery failed:`, err?.message || err);
      return { ok: false, error: err?.message || 'delivery_failed' };
    }
  }

  return { enabled, notify, templates: NOTIFICATION_TEMPLATES };
}
