// Trainer session outcomes — read-only reconciliation (re-review of #231, finding 5).
//
// A booking's status is written in one locked transaction; what follows from it
// runs after commit and may fail on its own (B2B benefit consumption, the
// sponsor refund, a cancellation refund, the notification). This compares the
// three records that must agree and lists where they don't. It reads only;
// nothing is changed. Run: node scripts/trainer-outcome-reconcile.mjs
const HAPPENED = ['completed', 'no_show'];
const SAMPLE = 50;

export function createTrainerOutcomeReconciliation({ db }) {
  const liveRefund = q => q.from('Refund as r').whereRaw('r."bookingId" = b.id').where('r.kind', 'trainer_booking').whereNot('r.status', 'rejected').select(db.raw('1'));
  const liveLine = q => q.from('TrainerSettlementLine as l').join('TrainerSettlement as s', 's.id', 'l.trainerSettlementId')
    .whereRaw('l."bookingId" = b.id').where('l.voided', false).whereNot('s.status', 'voided').select(db.raw('1'));
  const usage = (q, status = 'approved') => q.from('B2BBenefitConsumption as u').whereRaw('u."sourceId" = b.id')
    .where({ 'u.sourceType': 'trainer_booking', 'u.status': status });

  const CHECKS = [
    {
      key: 'sponsor_usage_without_outcome', severity: 'high',
      description: 'Sponsor charged (approved trainer usage) for a booking that is missing or not completed/no-show',
      query: () => db('B2BBenefitConsumption as u').leftJoin('TrainerBooking as b', 'b.id', 'u.sourceId')
        .where({ 'u.sourceType': 'trainer_booking', 'u.status': 'approved' })
        .where(q => q.whereNull('b.id').orWhereNotIn('b.status', HAPPENED)).select('u.sourceId as bookingId'),
    },
    {
      key: 'sponsored_outcome_without_refund', severity: 'high',
      description: 'Completed/no-show session the sponsor pays for, but the member has no live refund of what they paid',
      query: () => db('TrainerBooking as b').whereIn('b.status', HAPPENED).where('b.amountTzs', '>', 0)
        .whereExists(q => usage(q).where('u.sponsorTzs', '>', 0).select(db.raw('1')))
        .whereNotExists(liveRefund).select('b.id as bookingId'),
    },
    {
      key: 'outcome_with_member_refund', severity: 'high',
      description: 'Completed/no-show session (trainer paid) with a live refund to the member for another reason than the sponsor paying',
      query: () => db('TrainerBooking as b').whereIn('b.status', HAPPENED)
        .whereExists(q => liveRefund(q).whereNot('r.reasonCode', 'sponsor_paid')).select('b.id as bookingId'),
    },
    {
      key: 'cancelled_on_statement', severity: 'high',
      description: 'Cancelled session still on a live trainer statement line',
      query: () => db('TrainerBooking as b').where('b.status', 'cancelled').whereExists(liveLine).select('b.id as bookingId'),
    },
    {
      key: 'cancelled_paid_without_refund', severity: 'medium',
      description: 'Cancelled session whose payment was approved, with no live refund',
      query: () => db('TrainerBooking as b').join('PaymentRequest as p', 'p.id', 'b.paymentRequestId')
        .where({ 'b.status': 'cancelled', 'p.status': 'approved' }).where('b.amountTzs', '>', 0)
        .whereNotExists(liveRefund).select('b.id as bookingId'),
    },
    {
      key: 'released_usage_still_happened', severity: 'medium',
      description: 'Completed/no-show session whose sponsor usage was reversed and none is live (benefit given back while the session stands)',
      query: () => db('TrainerBooking as b').whereIn('b.status', HAPPENED)
        .whereExists(q => usage(q, 'reversed').select(db.raw('1')))
        .whereNotExists(q => usage(q).select(db.raw('1'))).select('b.id as bookingId'),
    },
  ];

  /** → { checkedAt, ok, checks: [{ key, severity, description, count, sample: bookingId[] }] } */
  async function run({ only = null } = {}) {
    const checks = [];
    for (const c of CHECKS) {
      if (only && !only.includes(c.key)) continue;
      const rows = await c.query();
      const ids = [...new Set(rows.map(r => r.bookingId))];
      checks.push({ key: c.key, severity: c.severity, description: c.description, count: ids.length, sample: ids.slice(0, SAMPLE) });
    }
    return { checkedAt: new Date().toISOString(), ok: checks.every(c => c.count === 0), checks };
  }

  return { run, keys: CHECKS.map(c => c.key) };
}
