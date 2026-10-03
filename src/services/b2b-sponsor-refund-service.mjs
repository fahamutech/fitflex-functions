// A trainer session covered by a sponsor is paid for twice unless the member
// gets their money back: the member pays the booking in full when they book
// it (nobody knows yet whether a benefit will cover it), and the sponsor is
// invoiced for the session once it is completed.
//
//   session completed → benefit consumed (sponsor charged)
//                     → refund raised to the member for what the sponsor pays
//
// The refund goes through the ordinary refunds queue (refund-service): it is
// approved by policy, FitFlex staff pay it and record the reference. There is
// one live refund per booking, so a later cancellation of the same session
// finds this one instead of refunding it again.
export const SPONSOR_PAID = 'sponsor_paid';

export function createB2BSponsorRefundService({ db, refundService, trainerBookings, logger = console }) {
  /** A session was consumed on a benefit: the member is owed back what the sponsor pays, up to what they paid. */
  async function onSessionConsumed({ booking, consumption }) {
    const sponsorTzs = Number(consumption?.sponsorTzs) || 0;
    const paidTzs = Math.max(0, Math.round(Number(booking?.amountTzs) || 0));
    const amountTzs = Math.min(sponsorTzs, paidTzs);
    if (!booking?.id || amountTzs <= 0) return null;
    const out = await refundService.raise({
      memberId: booking.memberId, kind: 'trainer_booking', sourceId: booking.id, paymentRequestId: booking.paymentRequestId ?? null,
      amountTzs, currency: booking.currency || 'TZS', reasonCode: SPONSOR_PAID,
      note: 'Your sponsor covers this session, so what you paid for it is returned.',
      requestedBy: 'system:b2b', requestedRole: 'system', approved: true,
    });
    if (out.error) logger.warn(`[b2b-refund] not raised for booking ${booking.id}: ${out.error}`);
    return out.refund ?? null;
  }

  /**
   * A completed session was un-completed, so the sponsor is no longer charged.
   * A sponsor refund not yet paid is withdrawn. If the session was cancelled
   * the refund stays: the member is owed the same money back for that reason.
   */
  async function onSessionReleased({ booking, actorId = null }) {
    if (!booking?.id || booking.status === 'cancelled') return null;
    const out = await refundService.withdraw({
      kind: 'trainer_booking', sourceId: booking.id, reasonCode: SPONSOR_PAID,
      note: 'The session is no longer marked completed, so the sponsor does not cover it.', actorId,
    });
    if (out.alreadyPaid) logger.warn(`[b2b-refund] booking ${booking.id} is no longer covered but its sponsor refund ${out.refund.id} was already paid`);
    return out;
  }

  /**
   * Daily: raise any refund a completed, sponsor-covered session of the last
   * week is still missing (the hook failed after the benefit was consumed).
   */
  async function repair({ days = 7, now = new Date() } = {}) {
    const missing = await db('B2BBenefitConsumption as c')
      .leftJoin('Refund as r', function on() {
        this.on('r.bookingId', 'c.sourceId').andOn('r.kind', db.raw('?', ['trainer_booking'])).andOn('r.status', '<>', db.raw('?', ['rejected']));
      })
      .where({ 'c.sourceType': 'trainer_booking', 'c.status': 'approved' }).where('c.sponsorTzs', '>', 0)
      .where('c.consumedAt', '>=', new Date(+now - days * 86_400_000)).whereNull('r.id')
      .select('c.id', 'c.sourceId', 'c.sponsorTzs');
    let raised = 0;
    for (const c of missing) {
      const booking = await trainerBookings.findByIdAsync(c.sourceId);
      if (booking?.status !== 'completed') continue;
      try {
        if (await onSessionConsumed({ booking, consumption: c })) raised += 1;
      } catch (err) {
        logger.warn(`[b2b-refund] repair failed for booking ${c.sourceId}:`, err?.message);
      }
    }
    return { missing: missing.length, raised };
  }

  return { onSessionConsumed, onSessionReleased, repair };
}
