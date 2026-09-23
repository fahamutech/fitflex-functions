// Trainer reviews — eligibility (completed booking), 1-5 rating,
// optional text, one-per-member upsert, rolling average, admin moderation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerReviewService } from '../src/services/trainer-review-service.mjs';

function store(seed = []) {
  let rows = [...seed];
  return {
    _rows: () => rows,
    filterAsync: async pred => rows.filter(pred),
    findByIdAsync: async id => rows.find(r => r.id === id) || null,
    insertAsync: async row => { rows.push(row); return row; },
    updateByIdAsync: async (id, patch) => {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
    removeAsync: async pred => {
      const i = rows.findIndex(pred);
      if (i >= 0) return rows.splice(i, 1)[0];
      return null;
    },
  };
}

function setup({ trainerRows, bookingRows = [], userRows = [] } = {}) {
  const trainerReviews = store();
  const trainers = store(trainerRows ?? [{ id: 'trainer1', displayName: 'Coach Mike', rating: 0, reviewCount: 0 }]);
  const trainerBookings = store(bookingRows);
  const users = store(userRows.length ? userRows : [{ id: 'm1', displayName: 'Aisha' }]);
  const svc = createTrainerReviewService({ trainerReviews, trainers, trainerBookings, users, auditLog: { insert: () => {} } });
  return { svc, trainerReviews, trainers, trainerBookings, users };
}

test('member with a completed booking can submit a review', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5, text: 'Great session' });
  assert.ok(!r.error);
  assert.equal(r.review.rating, 5);
  assert.equal(r.trainerRating.averageRating, 5);
  assert.equal(r.trainerRating.reviewCount, 1);
});

test('member with a no_show booking can also review', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'no_show' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 2 });
  assert.ok(!r.error);
  assert.equal(r.review.rating, 2);
});

test('member with no completed booking is rejected', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'pending' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 4 });
  assert.equal(r.error, 'no_completed_booking');
  assert.equal(r.status, 403);
});

test('rating validation: must be integer 1-5', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  assert.equal((await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 0 })).error, 'rating_must_be_integer_1_to_5');
  assert.equal((await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 6 })).error, 'rating_must_be_integer_1_to_5');
  assert.equal((await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 3.5 })).error, 'rating_must_be_integer_1_to_5');
});

test('text too short (< 3 chars) is rejected', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5, text: 'ok' });
  assert.equal(r.error, 'text_too_short');
});

test('text over 1000 chars is rejected', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  const longText = 'x'.repeat(1001);
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5, text: longText });
  assert.equal(r.error, 'text_too_long');
});

test('re-review replaces the previous (one per member per trainer)', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  const first = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 3 });
  const second = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5 });
  assert.equal(second.review.id, first.review.id);
  assert.equal(second.updated, true);
  assert.equal(second.trainerRating.reviewCount, 1);
  assert.equal(second.trainerRating.averageRating, 5);
});

test('trainer not found returns 404', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'ghost', status: 'completed' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'ghost', rating: 5 });
  assert.equal(r.status, 404);
});

test('member can delete own review; average recalculates', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 4 });
  const r = await svc.remove({ memberId: 'm1', trainerId: 'trainer1' });
  assert.ok(r.ok);
  assert.equal(r.trainerRating.reviewCount, 0);
  assert.equal(r.trainerRating.averageRating, 0);
});

test('average computed across multiple members', async () => {
  const { svc } = setup({
    bookingRows: [
      { id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' },
      { id: 'b2', memberId: 'm2', trainerId: 'trainer1', status: 'completed' },
      { id: 'b3', memberId: 'm3', trainerId: 'trainer1', status: 'completed' },
    ],
    userRows: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
  });
  await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5 });
  await svc.submit({ memberId: 'm2', trainerId: 'trainer1', rating: 4 });
  const last = await svc.submit({ memberId: 'm3', trainerId: 'trainer1', rating: 3 });
  assert.equal(last.trainerRating.averageRating, 4); // (5+4+3)/3
  assert.equal(last.trainerRating.reviewCount, 3);
});

test('summary distribution + hidden reviews excluded', async () => {
  const { svc, trainerReviews } = setup({
    bookingRows: [
      { id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' },
      { id: 'b2', memberId: 'm2', trainerId: 'trainer1', status: 'completed' },
    ],
    userRows: [{ id: 'm1' }, { id: 'm2' }],
  });
  await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5 });
  const low = await svc.submit({ memberId: 'm2', trainerId: 'trainer1', rating: 1 });
  await svc.moderate({ reviewId: low.review.id, action: 'hide', adminId: 'admin' });
  const summary = await svc.summary('trainer1');
  assert.equal(summary.reviewCount, 1); // hidden one excluded
  assert.equal(summary.averageRating, 5);
  assert.deepEqual(summary.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
});

test('admin moderation hide/flag/restore', async () => {
  const { svc } = setup({ bookingRows: [{ id: 'b1', memberId: 'm1', trainerId: 'trainer1', status: 'completed' }] });
  const r = await svc.submit({ memberId: 'm1', trainerId: 'trainer1', rating: 5 });
  const hidden = await svc.moderate({ reviewId: r.review.id, action: 'hide', adminId: 'admin' });
  assert.equal(hidden.status, 'hidden');
  const flagged = await svc.moderate({ reviewId: r.review.id, action: 'flag', adminId: 'admin' });
  assert.equal(flagged.status, 'flagged');
  const restored = await svc.moderate({ reviewId: r.review.id, action: 'restore', adminId: 'admin' });
  assert.equal(restored.status, 'published');
});
