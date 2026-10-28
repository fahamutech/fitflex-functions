// Marathon & running events · S4 — payments, ticket issuance and event refunds (spec
// docs/design/events-s4-payments-and-tickets.md §3.2). ADDITIVE: every column is nullable or defaulted,
// every new constraint holds for the rows that exist (S1 to S3 wrote no money rows).
//
// - EventPayment: denormalised eventId / organizerId, method (manual | provider | free), submittedAt,
//   rejectCode, lateOrder, refundId, settledNote, and for organisation payments organizationId / payerMethod /
//   paidOn. Two partial uniques make PAY-007 a database fact: one live attempt per order and ONE SUCCESS per
//   order (reconciliation_required counts as live so a held payment blocks a second prompt).
// - EventOrder: organizerId + commissionPctSnapshot (settlement seam, stamped at confirmation), hold
//   bookkeeping (holdCapAt, holdExtendedAt, holdExtensions), refundedTzs (moved when a refund is PAID),
//   paymentMethod, settlementStatementId (no FK: the settlement slice adds it).
// - EventRegistration: paidAmountTzs / paidAt (exact per-place money, set once), refundedTzs, refundId (the one
//   live refund covering the place).
// - EventTicket: tokenVersion, tokenKeyId, displayCode, rotatedAt, issuedForUserId. The token itself is derived
//   from EVENT_TICKET_SECRET and is never stored; tokenHash (existing, unique) stays the lookup key.
// - EventInventoryMovement.kind: + 'uncommit' (a paid place given back: sold - 1).
// - Event: event_refund_preset_check (S2) widened to the five presets (+ full_until_days, tiered). `down` fails closed while any
//   event uses one of the new presets.
// - Refund: kind CHECK (refund_ck) rewritten with identical predicates plus 'event_order'; event source columns,
//   scope, policySnapshot, batchId, eventPaymentId; live-unique partial indexes (one live refund per place, per
//   cancelled-event order, per unfulfilled payment).
//
// Dormant: nothing reads these until EVENTS_PAYMENTS_MANUAL / EVENTS_PAYMENTS_TUNZAA are on.
// Rule 6 callout: payments (EventPayment, PaymentRequest unchanged here) and Refund tables.
//
// DOWN FAILS CLOSED: it refuses while any money, ticket or event-refund row exists (money records are never
// deleted by a rollback). On an empty module it restores the S3 shape exactly.

const REFUND_STATUSES = ['requested', 'approved', 'paid', 'rejected'];
const OLD_PRESETS = ['no_refund', 'refund_until_close', 'custom'];
const PRESETS = ['no_refund', 'refund_until_close', 'full_until_days', 'tiered', 'custom'];
const PRESET_CK = presets => `CHECK ("refundPolicy" IS NULL OR "refundPolicy"->>'preset' IS NULL OR "refundPolicy"->>'preset' IN (${presets.map(v => `'${v}'`).join(', ')}))`;
const list = values => values.map(v => `'${v}'`).join(', ');

const REFUND_CK = kinds => `CHECK ("amountTzs" > 0 AND (kind = ANY (ARRAY[${list(kinds)}])) AND (status = ANY (ARRAY[${list(REFUND_STATUSES)}])) AND ((status <> 'paid') OR (("paidAt" IS NOT NULL) AND ("paymentReference" IS NOT NULL))) AND ((status <> 'rejected') OR ("decisionNote" IS NOT NULL)))`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ── EventPayment ──────────────────────────────────────────────────────────
  await knex.schema.alterTable('EventPayment', (t) => {
    t.text('eventId');
    t.text('organizerId');
    t.timestamp('submittedAt', { precision: 3 });
    t.text('method');
    t.text('rejectCode');
    t.boolean('lateOrder').notNullable().defaultTo(false);
    t.text('refundId');
    t.text('settledNote');
    t.text('organizationId');
    t.text('payerMethod');
    t.date('paidOn');
    // The Idempotency-Key convention is `${orderId}:${key}` (the column is globally unique, the key is per order);
    // the fingerprint of the request body lives beside it so a replay can tell "same request" from "same key, other body".
    t.text('idempotencyFingerprint');
    t.index(['eventId']);
  });
  await knex.raw(`ALTER TABLE "EventPayment"
    ADD CONSTRAINT eventpayment_method_check CHECK (method IS NULL OR method IN ('manual', 'provider', 'free')),
    ADD CONSTRAINT eventpayment_payer_method_check CHECK ("payerMethod" IS NULL OR "payerMethod" IN ('bank_transfer', 'mobile_money')),
    ADD CONSTRAINT eventpayment_reject_code_check CHECK ("rejectCode" IS NULL OR "rejectCode" IN ('reference_not_found', 'amount_mismatch', 'wrong_account', 'duplicate_reference', 'other'))`);
  await knex.raw(`CREATE UNIQUE INDEX eventpayment_one_live_per_order ON "EventPayment" ("orderId") WHERE status IN ('created', 'pending', 'reconciliation_required')`);
  await knex.raw(`CREATE UNIQUE INDEX eventpayment_one_succeeded_per_order ON "EventPayment" ("orderId") WHERE status = 'succeeded'`);

  // ── EventOrder ────────────────────────────────────────────────────────────
  await knex.schema.alterTable('EventOrder', (t) => {
    t.text('organizerId');
    t.integer('commissionPctSnapshot');
    t.timestamp('holdCapAt', { precision: 3 });
    t.timestamp('holdExtendedAt', { precision: 3 });
    t.integer('holdExtensions').notNullable().defaultTo(0);
    t.integer('refundedTzs').notNullable().defaultTo(0);
    t.text('paymentMethod');
    t.text('settlementStatementId');
    t.index(['organizerId']);
  });
  await knex.raw(`ALTER TABLE "EventOrder"
    ADD CONSTRAINT eventorder_commission_check CHECK ("commissionPctSnapshot" IS NULL OR ("commissionPctSnapshot" BETWEEN 0 AND 100)),
    ADD CONSTRAINT eventorder_hold_extensions_check CHECK ("holdExtensions" >= 0),
    ADD CONSTRAINT eventorder_refunded_check CHECK ("refundedTzs" >= 0 AND "refundedTzs" <= "totalTzs"),
    ADD CONSTRAINT eventorder_payment_method_check CHECK ("paymentMethod" IS NULL OR "paymentMethod" IN ('manual', 'provider', 'free'))`);

  // ── EventRegistration ─────────────────────────────────────────────────────
  await knex.schema.alterTable('EventRegistration', (t) => {
    t.integer('paidAmountTzs');
    t.timestamp('paidAt', { precision: 3 });
    t.integer('refundedTzs').notNullable().defaultTo(0);
    t.text('refundId');
  });
  await knex.raw(`ALTER TABLE "EventRegistration"
    ADD CONSTRAINT eventregistration_paid_amount_check CHECK ("paidAmountTzs" IS NULL OR "paidAmountTzs" >= 0),
    ADD CONSTRAINT eventregistration_refunded_check CHECK ("refundedTzs" >= 0 AND "refundedTzs" <= COALESCE("paidAmountTzs", 0))`);

  // ── EventTicket ───────────────────────────────────────────────────────────
  await knex.schema.alterTable('EventTicket', (t) => {
    t.integer('tokenVersion').notNullable().defaultTo(1);
    t.text('tokenKeyId');
    t.text('displayCode');
    t.timestamp('rotatedAt', { precision: 3 });
    t.text('issuedForUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
  });
  await knex.raw(`ALTER TABLE "EventTicket"
    ADD CONSTRAINT eventticket_token_version_check CHECK ("tokenVersion" >= 1),
    ADD CONSTRAINT eventticket_revoke_reason_check CHECK ("revokeReason" IS NULL OR "revokeReason" IN ('cancelled', 'refunded', 'event_cancelled', 'admin', 'replaced'))`);

  // ── EventInventoryMovement: + uncommit ────────────────────────────────────
  await knex.raw(`ALTER TABLE "EventInventoryMovement" DROP CONSTRAINT eventinventorymovement_kind_check`);
  await knex.raw(`ALTER TABLE "EventInventoryMovement" ADD CONSTRAINT eventinventorymovement_kind_check CHECK (kind IN ('hold', 'release', 'commit', 'uncommit'))`);

  // ── Event: the two evaluable refund presets ───────────────────────────────
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_refund_preset_check`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_refund_preset_check ${PRESET_CK(PRESETS)}`);

  // ── Refund: kind 'event_order' ────────────────────────────────────────────
  await knex.raw(`ALTER TABLE "Refund" DROP CONSTRAINT refund_ck`);
  await knex.raw(`ALTER TABLE "Refund" ADD CONSTRAINT refund_ck ${REFUND_CK(['subscription', 'trainer_booking', 'shop_order', 'event_order'])}`);
  await knex.schema.alterTable('Refund', (t) => {
    t.text('eventId');
    t.text('eventOrderId');
    t.text('eventRegistrationId');
    t.text('organizerId');
    t.text('organizationId');
    t.text('scope');
    t.jsonb('policySnapshot');
    t.text('batchId');
    t.text('eventPaymentId');
    t.index(['eventId']);
    t.index(['batchId']);
  });
  await knex.raw(`ALTER TABLE "Refund"
    ADD CONSTRAINT refund_scope_check CHECK (scope IS NULL OR scope IN ('registration', 'order', 'event_cancelled', 'unfulfilled_payment')),
    ADD CONSTRAINT refund_event_kind_check CHECK (kind <> 'event_order' OR (scope IS NOT NULL AND "eventOrderId" IS NOT NULL AND "eventId" IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX refund_live_event_registration_ux ON "Refund" ("eventRegistrationId") WHERE kind = 'event_order' AND status <> 'rejected' AND scope = 'registration'`);
  await knex.raw(`CREATE UNIQUE INDEX refund_live_event_cancelled_order_ux ON "Refund" ("eventOrderId") WHERE kind = 'event_order' AND status <> 'rejected' AND scope = 'event_cancelled'`);
  await knex.raw(`CREATE UNIQUE INDEX refund_live_event_unfulfilled_order_ux ON "Refund" ("eventOrderId") WHERE kind = 'event_order' AND status <> 'rejected' AND scope = 'unfulfilled_payment'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async (sql) => (await knex.raw(sql)).rows[0].n;
  const guards = [
    [`SELECT count(*)::int AS n FROM "Refund" WHERE kind = 'event_order'`, 'event Refund row(s)'],
    [`SELECT count(*)::int AS n FROM "EventTicket"`, 'EventTicket row(s)'],
    [`SELECT count(*)::int AS n FROM "EventPayment"`, 'EventPayment row(s)'],
    [`SELECT count(*)::int AS n FROM "PaymentRequest" WHERE "eventOrderId" IS NOT NULL`, 'event PaymentRequest row(s)'],
    [`SELECT count(*)::int AS n FROM "EventInventoryMovement" WHERE kind = 'uncommit'`, 'uncommit movement(s)'],
    [`SELECT count(*)::int AS n FROM "Event" WHERE "refundPolicy"->>'preset' IN ('full_until_days', 'tiered') OR "refundPolicySnapshot"->>'preset' IN ('full_until_days', 'tiered')`, 'event(s) with a full_until_days or tiered refund policy'],
    [`SELECT count(*)::int AS n FROM "EventOrder" WHERE "holdExtensions" > 0 OR "organizerId" IS NOT NULL OR "refundedTzs" > 0 OR "holdCapAt" IS NOT NULL OR "paymentMethod" IS NOT NULL`, 'EventOrder row(s) with S4 money or hold data'],
    [`SELECT count(*)::int AS n FROM "EventRegistration" WHERE "paidAmountTzs" IS NOT NULL OR "refundedTzs" > 0 OR "refundId" IS NOT NULL`, 'EventRegistration row(s) with paid amounts'],
  ];
  for (const [sql, what] of guards) {
    const n = await count(sql);
    if (n) throw new Error(`events-payments-tickets down: ${n} ${what} exist; money and ticket records cannot be dropped`);
  }
  await knex.raw(`DROP INDEX IF EXISTS refund_live_event_unfulfilled_order_ux`);
  await knex.raw(`DROP INDEX IF EXISTS refund_live_event_cancelled_order_ux`);
  await knex.raw(`DROP INDEX IF EXISTS refund_live_event_registration_ux`);
  await knex.raw(`ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS refund_event_kind_check, DROP CONSTRAINT IF EXISTS refund_scope_check`);
  await knex.schema.alterTable('Refund', (t) => {
    t.dropIndex(['eventId']);
    t.dropIndex(['batchId']);
    for (const c of ['eventId', 'eventOrderId', 'eventRegistrationId', 'organizerId', 'organizationId', 'scope', 'policySnapshot', 'batchId', 'eventPaymentId']) t.dropColumn(c);
  });
  await knex.raw(`ALTER TABLE "Refund" DROP CONSTRAINT refund_ck`);
  await knex.raw(`ALTER TABLE "Refund" ADD CONSTRAINT refund_ck ${REFUND_CK(['subscription', 'trainer_booking', 'shop_order'])}`);
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_refund_preset_check`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_refund_preset_check ${PRESET_CK(OLD_PRESETS)}`);

  await knex.raw(`ALTER TABLE "EventInventoryMovement" DROP CONSTRAINT eventinventorymovement_kind_check`);
  await knex.raw(`ALTER TABLE "EventInventoryMovement" ADD CONSTRAINT eventinventorymovement_kind_check CHECK (kind IN ('hold', 'release', 'commit'))`);

  await knex.raw(`ALTER TABLE "EventTicket" DROP CONSTRAINT IF EXISTS eventticket_token_version_check, DROP CONSTRAINT IF EXISTS eventticket_revoke_reason_check`);
  await knex.schema.alterTable('EventTicket', (t) => {
    for (const c of ['tokenVersion', 'tokenKeyId', 'displayCode', 'rotatedAt', 'issuedForUserId']) t.dropColumn(c);
  });

  await knex.raw(`ALTER TABLE "EventRegistration" DROP CONSTRAINT IF EXISTS eventregistration_paid_amount_check, DROP CONSTRAINT IF EXISTS eventregistration_refunded_check`);
  await knex.schema.alterTable('EventRegistration', (t) => {
    for (const c of ['paidAmountTzs', 'paidAt', 'refundedTzs', 'refundId']) t.dropColumn(c);
  });

  await knex.raw(`ALTER TABLE "EventOrder" DROP CONSTRAINT IF EXISTS eventorder_commission_check, DROP CONSTRAINT IF EXISTS eventorder_hold_extensions_check, DROP CONSTRAINT IF EXISTS eventorder_refunded_check, DROP CONSTRAINT IF EXISTS eventorder_payment_method_check`);
  await knex.schema.alterTable('EventOrder', (t) => {
    t.dropIndex(['organizerId']);
    for (const c of ['organizerId', 'commissionPctSnapshot', 'holdCapAt', 'holdExtendedAt', 'holdExtensions', 'refundedTzs', 'paymentMethod', 'settlementStatementId']) t.dropColumn(c);
  });

  await knex.raw(`DROP INDEX IF EXISTS eventpayment_one_succeeded_per_order`);
  await knex.raw(`DROP INDEX IF EXISTS eventpayment_one_live_per_order`);
  await knex.raw(`ALTER TABLE "EventPayment" DROP CONSTRAINT IF EXISTS eventpayment_method_check, DROP CONSTRAINT IF EXISTS eventpayment_payer_method_check, DROP CONSTRAINT IF EXISTS eventpayment_reject_code_check`);
  await knex.schema.alterTable('EventPayment', (t) => {
    t.dropIndex(['eventId']);
    for (const c of ['eventId', 'organizerId', 'submittedAt', 'method', 'rejectCode', 'lateOrder', 'refundId', 'settledNote', 'organizationId', 'payerMethod', 'paidOn', 'idempotencyFingerprint']) t.dropColumn(c);
  });
};
