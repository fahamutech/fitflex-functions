// FitFlex Af — WhatsApp Integration Hooks for fitflex-functions backend
//
// This module exports helper functions that the existing backend (index.mjs)
// can call to trigger WhatsApp notifications. It makes HTTP calls to the
// standalone fitflex-whatsapp service.
//
// To wire this into index.mjs:
//   1. Import at the top:
//      import { createWhatsAppHooks } from '../src/integrations/whatsapp-hooks.mjs';
//
//   2. Initialize after collections are set up:
//      const whatsapp = createWhatsAppHooks({
//        apiBase: process.env.WHATSAPP_SERVICE_URL || 'http://localhost:3002',
//        internalToken: process.env.FITFLEX_INTERNAL_TOKEN || 'fitflex-internal-dev'
//      });
//
//   3. Call from existing endpoints:
//      await whatsapp.notifyCheckIn({ user, gym, visit });
//      await whatsapp.notifyBookingConfirmed({ booking, trainer });
//      await whatsapp.notifySubscriptionRenewal({ subscription, daysRemaining });
//      await whatsapp.sendOtp({ phone, code });

const BASE_TIMEOUT = 5000; // 5s timeout — notifications are fire-and-forget

async function post(url, token, body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BASE_TIMEOUT);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);
    return await response.json();
  } catch (err) {
    // Never throw — notifications are fire-and-forget.
    // Log and swallow so the primary operation is unaffected.
    console.error('[WhatsApp hook] failed:', err.message);
    return { ok: false, error: err.message, swallowed: true };
  }
}

export function createWhatsAppHooks({ apiBase, internalToken }) {
  if (!apiBase) {
    console.warn('[WhatsApp hooks] No apiBase configured — hooks will be no-ops');
  }

  const base = apiBase || 'http://localhost:3002';
  const token = internalToken || 'fitflex-internal-dev';

  // ─── Check-in Notifications ──────────────────────────────────────────────

  async function notifyCheckIn({ user, gym, visit, visitsUsed, visitCap }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'checkin_receipt',
      language: user.language || 'en',
      params: {
        gymName: gym.name,
        date: visit.date,
        time: visit.time,
        visitsUsed: String(visitsUsed),
        visitCap: visitCap ? String(visitCap) : '∞'
      },
      metadata: { type: 'checkin', memberId: user.id, gymId: gym.id }
    });
  }

  async function notifyCheckInFailed({ user, gymName, reason }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'checkin_failed',
      language: user.language || 'en',
      params: { gymName, reason },
      metadata: { type: 'checkin_failed', memberId: user.id }
    });
  }

  // ─── Booking Notifications ──────────────────────────────────────────────

  async function notifyBookingPending({ member, booking, trainerName }) {
    return post(`${base}/internal/notify`, token, {
      to: member.phone,
      templateKey: 'booking_pending',
      language: member.language || 'en',
      params: {
        trainerName,
        date: booking.sessionDate,
        time: booking.sessionTime
      },
      metadata: { type: 'booking_pending', bookingId: booking.id }
    });
  }

  async function notifyBookingConfirmed({ member, booking, trainerName }) {
    return post(`${base}/internal/notify`, token, {
      to: member.phone,
      templateKey: 'booking_confirmed',
      language: member.language || 'en',
      params: {
        trainerName,
        date: booking.sessionDate,
        time: booking.sessionTime,
        bookingId: booking.id
      },
      metadata: { type: 'booking_confirmed', bookingId: booking.id }
    });
  }

  async function notifyBookingCancelled({ member, booking, trainerName, reason }) {
    return post(`${base}/internal/notify`, token, {
      to: member.phone,
      templateKey: 'booking_cancelled',
      language: member.language || 'en',
      params: {
        trainerName,
        date: booking.sessionDate,
        time: booking.sessionTime,
        reason: reason || 'N/A'
      },
      metadata: { type: 'booking_cancelled', bookingId: booking.id }
    });
  }

  async function notifyBookingReminder({ member, booking, trainerName, location }) {
    return post(`${base}/internal/notify`, token, {
      to: member.phone,
      templateKey: 'booking_reminder',
      language: member.language || 'en',
      params: { trainerName, time: booking.sessionTime, location: location || 'TBD' },
      metadata: { type: 'booking_reminder', bookingId: booking.id }
    });
  }

  async function notifyTrainerBookingCompleted({ trainer, booking, memberName, monthCount }) {
    return post(`${base}/internal/notify`, token, {
      to: trainer.phone,
      templateKey: 'booking_completed_trainer',
      language: 'en',
      params: {
        memberName,
        payoutAmount: String(booking.payout?.trainerPayout || 0),
        payoutRef: booking.payoutRef || 'N/A',
        monthCount: String(monthCount)
      },
      metadata: { type: 'trainer_payout', bookingId: booking.id }
    });
  }

  // ─── Subscription Notifications ─────────────────────────────────────────

  async function notifySubscriptionActivated({ user, subscription, visitCap }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'subscription_activated',
      language: user.language || 'en',
      params: {
        tier: subscription.tier,
        visitCap: visitCap ? String(visitCap) : 'Unlimited',
        renewalDate: subscription.renewsAt?.split('T')[0] || 'N/A'
      },
      metadata: { type: 'subscription_activated', subscriptionId: subscription.id }
    });
  }

  async function notifySubscriptionRenewal({ user, subscription, daysRemaining }) {
    let templateKey;
    if (daysRemaining === 3) templateKey = 'subscription_renewal_t3';
    else if (daysRemaining === 1) templateKey = 'subscription_renewal_t1';
    else if (daysRemaining === 0) templateKey = 'subscription_renewal_success';
    else return { ok: false, skipped: true };

    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey,
      language: user.language || 'en',
      params: {
        tier: subscription.tier,
        renewalDate: subscription.renewsAt?.split('T')[0] || 'N/A',
        nextRenewalDate: subscription.renewsAt?.split('T')[0] || 'N/A'
      },
      metadata: { type: 'subscription_renewal', subscriptionId: subscription.id, daysRemaining }
    });
  }

  async function notifySubscriptionPaymentFailed({ user, subscription }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'subscription_payment_failed',
      language: user.language || 'en',
      params: { tier: subscription.tier },
      metadata: { type: 'payment_failed', subscriptionId: subscription.id }
    });
  }

  async function notifySubscriptionExpired({ user, subscription }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'subscription_expired',
      language: user.language || 'en',
      params: {
        tier: subscription.tier,
        reactivationLink: 'https://fitflex.app/renew'
      },
      metadata: { type: 'subscription_expired', subscriptionId: subscription.id }
    });
  }

  // ─── Payout Notifications ───────────────────────────────────────────────

  async function notifyGymPayout({ operator, amount, walletName, reference, visitCount, band }) {
    return post(`${base}/internal/notify`, token, {
      to: operator.phone,
      templateKey: 'payout_gym_owner',
      language: 'en',
      params: {
        amount: String(amount),
        walletName,
        reference,
        visitCount: String(visitCount),
        band: String(band)
      },
      metadata: { type: 'gym_payout', gymId: operator.gymId }
    });
  }

  async function notifyTrainerPayout({ trainer, amount, sessionCount, reference }) {
    return post(`${base}/internal/notify`, token, {
      to: trainer.phone,
      templateKey: 'payout_trainer',
      language: 'en',
      params: {
        amount: String(amount),
        sessionCount: String(sessionCount),
        reference
      },
      metadata: { type: 'trainer_payout', trainerId: trainer.id }
    });
  }

  // ─── Credits Wallet Notifications ───────────────────────────────────────

  async function notifyCreditsTopup({ user, amount, newBalance, expiryDate }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'credits_topup',
      language: user.language || 'en',
      params: {
        amount: String(amount),
        newBalance: String(newBalance),
        expiryDate
      },
      metadata: { type: 'credits_topup', memberId: user.id }
    });
  }

  async function notifyCreditsDeducted({ user, amount, reason, newBalance }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'credits_deducted',
      language: user.language || 'en',
      params: { amount: String(amount), reason, newBalance: String(newBalance) },
      metadata: { type: 'credits_deducted', memberId: user.id }
    });
  }

  async function notifyCreditsExpiryWarning({ user, daysRemaining, expiryDate }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'credits_expiry_warning',
      language: user.language || 'en',
      params: {
        daysRemaining: String(daysRemaining),
        expiryDate
      },
      metadata: { type: 'credits_expiry', memberId: user.id }
    });
  }

  // ─── Re-engagement (Marketing) ───────────────────────────────────────────

  async function notifyStreakNudge({ user, days, deeplink }) {
    const templateKey = days >= 10 ? 'streak_nudge_10d' : 'streak_nudge_5d';
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey,
      language: user.language || 'en',
      params: {
        memberName: user.displayName || 'there',
        deeplink: deeplink || 'https://fitflex.app/gyms'
      },
      metadata: { type: 'streak_nudge', memberId: user.id, days }
    });
  }

  async function notifyLowVisitsNudge({ user, visitsRemaining, deeplink }) {
    return post(`${base}/internal/notify`, token, {
      to: user.phone,
      templateKey: 'low_visits_nudge',
      language: user.language || 'en',
      params: {
        memberName: user.displayName || 'there',
        visitsRemaining: String(visitsRemaining),
        deeplink: deeplink || 'https://fitflex.app/gyms'
      },
      metadata: { type: 'low_visits_nudge', memberId: user.id }
    });
  }

  // ─── OTP ─────────────────────────────────────────────────────────────────

  async function sendOtp({ phone, code, language = 'en' }) {
    return post(`${base}/internal/otp`, token, {
      to: phone,
      code,
      language
    });
  }

  // ─── Corporate ───────────────────────────────────────────────────────────

  async function notifyCorporateMonthlyReport({ hrPhone, companyName, stats }) {
    return post(`${base}/internal/notify`, token, {
      to: hrPhone,
      templateKey: 'corporate_monthly_report',
      language: 'en',
      params: {
        companyName,
        staffEnrolled: String(stats.staffEnrolled),
        engagementRate: String(stats.engagementRate),
        absenteeismDrop: String(stats.absenteeismDrop),
        monthVisits: String(stats.monthVisits)
      },
      metadata: { type: 'corporate_report', companyName }
    });
  }

  return {
    // Check-in
    notifyCheckIn,
    notifyCheckInFailed,
    // Booking
    notifyBookingPending,
    notifyBookingConfirmed,
    notifyBookingCancelled,
    notifyBookingReminder,
    notifyTrainerBookingCompleted,
    // Subscription
    notifySubscriptionActivated,
    notifySubscriptionRenewal,
    notifySubscriptionPaymentFailed,
    notifySubscriptionExpired,
    // Payouts
    notifyGymPayout,
    notifyTrainerPayout,
    // Credits
    notifyCreditsTopup,
    notifyCreditsDeducted,
    notifyCreditsExpiryWarning,
    // Re-engagement
    notifyStreakNudge,
    notifyLowVisitsNudge,
    // OTP
    sendOtp,
    // Corporate
    notifyCorporateMonthlyReport,
  };
}
