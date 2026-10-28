// Marathon & running events · S1 — the pure domain rules: the state machines (PRD §9, ORG-003, ORG-006)
// and order pricing from a snapshot (D4). No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLES, LIFECYCLE_KINDS, canTransition, assertTransition, allowedTransitions, isFinal,
  ORGANIZER_STATUSES, EVENT_STATUSES, ORDER_STATUSES, PAYMENT_ATTEMPT_STATUSES, REGISTRATION_STATUSES, TICKET_STATUSES, KIT_STATUSES, RESULT_STATUSES,
} from '../src/shared/events-lifecycle.mjs';
import { quoteLines, normaliseFeeRule, NO_FEE } from '../src/shared/events-pricing.mjs';

test('the status sets are exactly the PRD §9 / ORG-003 / ORG-006 sets', () => {
  assert.deepEqual(LIFECYCLE_KINDS, ['organizer', 'event', 'order', 'paymentAttempt', 'registration', 'ticket', 'kit', 'result']);
  assert.deepEqual(ORGANIZER_STATUSES, ['draft', 'pending_review', 'active', 'rejected', 'suspended']);
  assert.deepEqual(EVENT_STATUSES, ['draft', 'submitted', 'published', 'registration_closed', 'in_progress', 'completed', 'cancelled', 'archived']);
  assert.deepEqual(ORDER_STATUSES, ['draft', 'awaiting_payment', 'confirmed', 'partially_cancelled', 'cancelled', 'expired', 'refund_pending', 'refunded']);
  assert.deepEqual(PAYMENT_ATTEMPT_STATUSES, ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'reversed', 'reconciliation_required']);
  assert.deepEqual(REGISTRATION_STATUSES, ['draft', 'reserved', 'confirmed', 'cancelled', 'transferred', 'refunded', 'disqualified']);
  assert.deepEqual(TICKET_STATUSES, ['not_issued', 'active', 'revoked', 'used_for_entry']);
  assert.deepEqual(KIT_STATUSES, ['not_ready', 'ready', 'collected', 'exception']);
  assert.deepEqual(RESULT_STATUSES, ['not_submitted', 'pending_verification', 'verified', 'rejected', 'corrected', 'disqualified', 'dnf', 'dns']);
});

test('every allowed transition of every kind passes, and only names known statuses', () => {
  let count = 0;
  for (const kind of LIFECYCLE_KINDS) {
    const { statuses, moves } = LIFECYCLES[kind];
    for (const from of statuses) {
      for (const to of moves[from]) {
        assert.ok(statuses.includes(to), `${kind}: ${from} → ${to} names a known status`);
        assert.equal(canTransition(kind, from, to), true, `${kind}: ${from} → ${to}`);
        assert.deepEqual(assertTransition(kind, from, to), { ok: true, kind, from, to });
        count += 1;
      }
    }
  }
  assert.ok(count >= 60, `${count} transitions covered`);
});

test('staying put is not a transition, and an unknown status has no way out', () => {
  for (const kind of LIFECYCLE_KINDS) {
    for (const s of LIFECYCLES[kind].statuses) assert.equal(canTransition(kind, s, s), false, `${kind}: ${s} → ${s}`);
    assert.deepEqual(allowedTransitions(kind, 'nope'), []);
    assert.equal(assertTransition(kind, 'nope', LIFECYCLES[kind].statuses[0]).error, 'invalid_transition');
  }
  assert.throws(() => canTransition('invoice', 'a', 'b'), /unknown lifecycle kind/);
});

test('disallowed moves come back as invalid_transition with what would have been allowed (never thrown)', () => {
  const cases = [
    ['organizer', 'draft', 'active', ['pending_review']],
    ['organizer', 'rejected', 'active', ['pending_review']],
    ['event', 'draft', 'published', ['submitted', 'archived']],
    ['event', 'completed', 'cancelled', ['archived']],
    ['event', 'archived', 'draft', []],
    ['order', 'confirmed', 'expired', ['partially_cancelled', 'cancelled', 'refund_pending']],
    ['order', 'confirmed', 'awaiting_payment', ['partially_cancelled', 'cancelled', 'refund_pending']],
    ['order', 'expired', 'cancelled', ['confirmed']],      // S4: expired → confirmed only through rehold
    ['order', 'refunded', 'confirmed', []],
    ['paymentAttempt', 'succeeded', 'pending', ['reversed']],
    ['paymentAttempt', 'failed', 'pending', ['succeeded', 'reconciliation_required']],  // S4: failed → succeeded (manual, two-person change)
    ['paymentAttempt', 'reversed', 'succeeded', []],
    ['registration', 'reserved', 'transferred', ['confirmed', 'cancelled']],
    ['registration', 'disqualified', 'confirmed', []],
    ['ticket', 'revoked', 'active', []],
    ['ticket', 'not_issued', 'used_for_entry', ['active', 'revoked']],
    ['kit', 'not_ready', 'collected', ['ready']],
    ['result', 'not_submitted', 'verified', ['pending_verification', 'dnf', 'dns']],
    ['result', 'verified', 'rejected', ['corrected', 'disqualified']],
  ];
  for (const [kind, from, to, allowed] of cases) {
    assert.equal(canTransition(kind, from, to), false, `${kind}: ${from} → ${to}`);
    assert.deepEqual(assertTransition(kind, from, to), { error: 'invalid_transition', status: 409, kind, from, to, allowed });
  }
});

test('final statuses', () => {
  for (const [kind, finals] of [
    ['order', ['cancelled', 'refunded']],
    ['paymentAttempt', ['cancelled', 'expired', 'reversed']],
    ['registration', ['transferred', 'refunded', 'disqualified']],
    ['event', ['archived']],
    ['ticket', ['revoked']],
  ]) {
    for (const s of LIFECYCLES[kind].statuses) assert.equal(isFinal(kind, s), finals.includes(s), `${kind}: ${s}`);
  }
  // A confirmed payment is never edited back to pending (PRD §9 payment safety).
  assert.equal(canTransition('paymentAttempt', 'succeeded', 'pending'), false);
  assert.equal(canTransition('paymentAttempt', 'succeeded', 'created'), false);
  // A provider timeout is not a failure.
  assert.equal(canTransition('paymentAttempt', 'pending', 'reconciliation_required'), true);
  assert.equal(canTransition('paymentAttempt', 'reconciliation_required', 'succeeded'), true);
});

// ── pricing ──────────────────────────────────────────────────────────────────

const snapshot = [
  { id: 'ett_a', priceTzs: 25000, currency: 'TZS', name: '21K early', categoryId: 'evc_21k' },
  { id: 'ett_b', priceTzs: 15000, currency: 'TZS', name: '5K', categoryId: 'evc_5k' },
  { id: 'ett_free', priceTzs: 0, currency: 'TZS', name: 'Kids', categoryId: 'evc_kids' },
];

test('quoteLines: whole-integer totals, no fee by default, lines priced from the snapshot', () => {
  const q = quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 2 }, { ticketTypeId: 'ett_b', quantity: 3 }, { ticketTypeId: 'ett_free', quantity: 1 }]);
  assert.equal(q.error, undefined);
  assert.equal(q.currency, 'TZS');
  assert.deepEqual(q.lines, [
    { ticketTypeId: 'ett_a', quantity: 2, unitPriceTzs: 25000, discountTzs: 0, feesTzs: 0, lineTotalTzs: 50000 },
    { ticketTypeId: 'ett_b', quantity: 3, unitPriceTzs: 15000, discountTzs: 0, feesTzs: 0, lineTotalTzs: 45000 },
    { ticketTypeId: 'ett_free', quantity: 1, unitPriceTzs: 0, discountTzs: 0, feesTzs: 0, lineTotalTzs: 0 },
  ]);
  assert.equal(q.subtotalTzs, 95000);
  assert.equal(q.discountTzs, 0);
  assert.equal(q.feesTzs, 0);
  assert.equal(q.totalTzs, 95000);
  assert.deepEqual(q.snapshot.feeRule, NO_FEE);
  assert.equal(q.snapshot.ticketTypes.length, 3);
  for (const v of [q.subtotalTzs, q.discountTzs, q.feesTzs, q.totalTzs, ...q.lines.flatMap(l => [l.unitPriceTzs, l.discountTzs, l.feesTzs, l.lineTotalTzs])]) assert.ok(Number.isInteger(v));
});

test('quoteLines: the snapshot is used, not a live price', () => {
  const live = [{ id: 'ett_a', priceTzs: 99000 }];
  const frozen = [{ id: 'ett_a', priceTzs: 25000 }];
  assert.equal(quoteLines(frozen, [{ ticketTypeId: 'ett_a', quantity: 1 }]).totalTzs, 25000);
  assert.equal(quoteLines(live, [{ ticketTypeId: 'ett_a', quantity: 1 }]).totalTzs, 99000);
  // The quote carries the snapshot it was priced from, so an order can be re-priced identically later.
  const q = quoteLines(frozen, [{ ticketTypeId: 'ett_a', quantity: 1 }]);
  assert.deepEqual(quoteLines(q.snapshot.ticketTypes, [{ ticketTypeId: 'ett_a', quantity: 1 }], { feeRule: q.snapshot.feeRule }).totalTzs, 25000);
});

test('quoteLines: percent and flat fee rules round to the whole shilling; discounts come off before the fee', () => {
  const pct = quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1 }, { ticketTypeId: 'ett_b', quantity: 1, discountTzs: 5000 }], { feeRule: { type: 'percent', pct: 2.5 } });
  assert.equal(pct.lines[0].feesTzs, 625);          // 25000 × 2.5% = 625
  assert.equal(pct.lines[1].feesTzs, 250);          // (15000 − 5000) × 2.5% = 250
  assert.equal(pct.discountTzs, 5000);
  assert.equal(pct.feesTzs, 875);
  assert.equal(pct.totalTzs, 40000 - 5000 + 875);
  const odd = quoteLines([{ id: 'x', priceTzs: 1001 }], [{ ticketTypeId: 'x', quantity: 1 }], { feeRule: { type: 'percent', pct: 2.5 } });
  assert.equal(odd.feesTzs, 25);                    // 25.025 → 25
  const half = quoteLines([{ id: 'x', priceTzs: 1010 }], [{ ticketTypeId: 'x', quantity: 1 }], { feeRule: { type: 'percent', pct: 2.5 } });
  assert.equal(half.feesTzs, 25);                   // 25.25 → 25
  const up = quoteLines([{ id: 'x', priceTzs: 1030 }], [{ ticketTypeId: 'x', quantity: 1 }], { feeRule: { type: 'percent', pct: 2.5 } });
  assert.equal(up.feesTzs, 26);                     // 25.75 → 26
  const capped = quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 4 }], { feeRule: { type: 'percent', pct: 10, maxTzs: 5000 } });
  assert.equal(capped.feesTzs, 5000);
  const floored = quoteLines(snapshot, [{ ticketTypeId: 'ett_b', quantity: 1 }], { feeRule: { type: 'percent', pct: 1, minTzs: 500 } });
  assert.equal(floored.feesTzs, 500);
  const free = quoteLines(snapshot, [{ ticketTypeId: 'ett_free', quantity: 2 }], { feeRule: { type: 'percent', pct: 10, minTzs: 500 } });
  assert.equal(free.feesTzs, 0);                    // no fee on a free ticket
  const flat = quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 2 }, { ticketTypeId: 'ett_b', quantity: 1 }], { feeRule: { type: 'flat', perTicketTzs: 1000, perOrderTzs: 500 } });
  assert.deepEqual(flat.lines.map(l => l.feesTzs), [2000, 1000]);
  assert.equal(flat.feesTzs, 3500);
  assert.equal(flat.totalTzs, 65000 + 3500);
  assert.deepEqual(normaliseFeeRule(null), NO_FEE);
  assert.deepEqual(normaliseFeeRule({ type: 'none' }), NO_FEE);
  assert.deepEqual(normaliseFeeRule({ type: 'percent', pct: 100 }), { type: 'percent', pct: 100, minTzs: 0, maxTzs: null });
});

test('quoteLines: refusals are results, never thrown', () => {
  assert.deepEqual(quoteLines(snapshot, []), { error: 'invalid_lines', status: 400 });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_zzz', quantity: 1 }]), { error: 'ticket_type_not_found', status: 404, ticketTypeId: 'ett_zzz' });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 0 }]), { error: 'invalid_quantity', status: 400, ticketTypeId: 'ett_a' });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1.5 }]), { error: 'invalid_quantity', status: 400, ticketTypeId: 'ett_a' });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1 }, { ticketTypeId: 'ett_a', quantity: 1 }]), { error: 'duplicate_line', status: 400, ticketTypeId: 'ett_a' });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1, discountTzs: 25001 }]), { error: 'invalid_discount', status: 400, ticketTypeId: 'ett_a' });
  assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1, discountTzs: 10.5 }]), { error: 'invalid_discount', status: 400, ticketTypeId: 'ett_a' });
  assert.equal(quoteLines([{ id: 'x', priceTzs: 10.5 }], [{ ticketTypeId: 'x', quantity: 1 }]).error, 'invalid_price_snapshot');
  assert.equal(quoteLines([{ id: 'x', priceTzs: 10, currency: 'TZS' }, { id: 'y', priceTzs: 10, currency: 'KES' }], [{ ticketTypeId: 'x', quantity: 1 }]).error, 'currency_mismatch');
});

test('fee rules outside 0..100 % or of an unknown shape are refused, never silently turned into no fee (review #242)', () => {
  for (const [rule, reason] of [
    [{ type: 'percent', pct: -1 }, 'pct'], [{ type: 'percent', pct: 100.5 }, 'pct'], [{ type: 'percent', pct: 'ten' }, 'pct'], [{ type: 'percent', pct: Infinity }, 'pct'],
    [{ type: 'percent', pct: 5, minTzs: -1 }, 'minTzs'], [{ type: 'percent', pct: 5, minTzs: 100, maxTzs: 50 }, 'maxTzs'],
    [{ type: 'flat', perTicketTzs: 1.5 }, 'perTicketTzs'], [{ type: 'flat', perOrderTzs: -1 }, 'perOrderTzs'],
    [{ type: 'surprise' }, 'type'], ['percent', 'shape'], [5, 'shape'],
  ]) {
    assert.deepEqual(normaliseFeeRule(rule), { error: 'invalid_fee_rule', status: 400, reason }, JSON.stringify(rule));
    assert.deepEqual(quoteLines(snapshot, [{ ticketTypeId: 'ett_a', quantity: 1 }], { feeRule: rule }), { error: 'invalid_fee_rule', status: 400, reason });
  }
});
