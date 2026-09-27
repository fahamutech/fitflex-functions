// Gym reviews — eligibility (check-in or active direct sub), 1-5 rating,
// optional text, one-per-member upsert, rolling average, admin moderation,
// and advisory tier signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymReviewService } from '../src/services/gym-review-service.mjs';

// Minimal async in-memory store matching the knex-store collection API used by
// the service (filterAsync / findByIdAsync / insertAsync / updateByIdAsync /
// removeAsync).
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

// Primed collections (gyms, trainers, platform_settings, otps) expose
// updateAsync(pred, patch) + persistUpdateByIdAsync and no updateByIdAsync —
// mirror that here.
function primedStore(seed = []) {
  const { updateByIdAsync, ...s } = store(seed);
  return {
    ...s,
    updateAsync: async (pred, patch) => {
      const rows = s._rows();
      const i = rows.findIndex(pred);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
    persistUpdateByIdAsync: async (id, patch) => {
      const rows = s._rows();
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
}

function setup({ gymRows, checkinRows = [], subRows = [], userRows = [] } = {}) {
  const gymReviews = store();
  const gyms = primedStore(gymRows ?? [{ id: 'gym1', name: 'Power Gym', tier: 'midtier', status: 'active', rating: 0, reviewCount: 0 }]);
  const checkins = store(checkinRows);
  const subscriptions = store(subRows);
  const users = store(userRows.length ? userRows : [{ id: 'm1', displayName: 'Aisha' }]);
  const svc = createGymReviewService({ gymReviews, gyms, checkins, subscriptions, users, auditLog: { insert: () => {}, insertAsync: async () => {} } });
  return { svc, gymReviews, gyms, checkins, subscriptions, users };
}

test('member with a check-in can submit a review', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  const r = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 5, text: 'Great gym' });
  assert.ok(!r.error);
  assert.equal(r.review.rating, 5);
  assert.equal(r.gymRating.averageRating, 5);
  assert.equal(r.gymRating.reviewCount, 1);
});

test('member with an active direct subscription can review without a check-in', async () => {
  const { svc } = setup({ subRows: [{ id: 's1', memberId: 'm1', type: 'direct_sub', homeGymId: 'gym1', status: 'active' }] });
  const r = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 4 });
  assert.ok(!r.error);
  assert.equal(r.review.rating, 4);
});

test('member with neither a check-in nor a direct sub is rejected', async () => {
  const { svc } = setup();
  const r = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 4 });
  assert.equal(r.error, 'no_checkin_or_direct_subscription');
  assert.equal(r.status, 403);
});

test('rating must be an integer 1-5', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  assert.equal((await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 0 })).error, 'rating_must_be_integer_1_to_5');
  assert.equal((await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 6 })).error, 'rating_must_be_integer_1_to_5');
  assert.equal((await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 3.5 })).error, 'rating_must_be_integer_1_to_5');
});

test('re-reviewing replaces the previous review (one per member per gym)', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  const first = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 3 });
  const second = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 5 });
  assert.equal(second.review.id, first.review.id);
  assert.equal(second.updated, true);
  assert.equal(second.gymRating.reviewCount, 1);
  assert.equal(second.gymRating.averageRating, 5);
});

test('gym not found returns 404', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'ghost' }] });
  const r = await svc.submit({ memberId: 'm1', gymId: 'ghost', rating: 5 });
  assert.equal(r.status, 404);
});

test('member can delete own review; average recalculates', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 4 });
  const r = await svc.remove({ memberId: 'm1', gymId: 'gym1' });
  assert.ok(r.ok);
  assert.equal(r.gymRating.reviewCount, 0);
  assert.equal(r.gymRating.averageRating, 0);
});

test('average is computed across multiple members', async () => {
  const { svc } = setup({
    checkinRows: [
      { id: 'c1', memberId: 'm1', gymId: 'gym1' },
      { id: 'c2', memberId: 'm2', gymId: 'gym1' },
      { id: 'c3', memberId: 'm3', gymId: 'gym1' },
    ],
    userRows: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
  });
  await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 5 });
  await svc.submit({ memberId: 'm2', gymId: 'gym1', rating: 4 });
  const last = await svc.submit({ memberId: 'm3', gymId: 'gym1', rating: 3 });
  assert.equal(last.gymRating.averageRating, 4); // (5+4+3)/3
  assert.equal(last.gymRating.reviewCount, 3);
});

test('summary distribution + hidden reviews excluded from average', async () => {
  const { svc, gymReviews } = setup({
    checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }, { id: 'c2', memberId: 'm2', gymId: 'gym1' }],
    userRows: [{ id: 'm1' }, { id: 'm2' }],
  });
  await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 5 });
  const low = await svc.submit({ memberId: 'm2', gymId: 'gym1', rating: 1 });
  await svc.moderate({ reviewId: low.review.id, action: 'hide', adminId: 'admin' });
  const summary = await svc.summary('gym1');
  assert.equal(summary.reviewCount, 1); // hidden one excluded
  assert.equal(summary.averageRating, 5);
});

test('tier signal: midtier below 3.0 with >=5 reviews suggests downlift', async () => {
  const checkinRows = [];
  const userRows = [];
  for (let i = 1; i <= 5; i++) { checkinRows.push({ id: `c${i}`, memberId: `m${i}`, gymId: 'gym1' }); userRows.push({ id: `m${i}` }); }
  const { svc } = setup({ checkinRows, userRows });
  for (let i = 1; i <= 5; i++) await svc.submit({ memberId: `m${i}`, gymId: 'gym1', rating: 2 });
  const summary = await svc.summary('gym1');
  assert.equal(summary.tierSignal.action, 'consider_downlift');
  assert.equal(summary.tierSignal.suggestedTier, 'standard');
});

test('tier signal: fewer than 5 reviews is insufficient_data', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 1 });
  const summary = await svc.summary('gym1');
  assert.equal(summary.tierSignal.action, 'insufficient_data');
});

test('admin moderation hide/restore round-trips', async () => {
  const { svc } = setup({ checkinRows: [{ id: 'c1', memberId: 'm1', gymId: 'gym1' }] });
  const r = await svc.submit({ memberId: 'm1', gymId: 'gym1', rating: 5 });
  const hidden = await svc.moderate({ reviewId: r.review.id, action: 'hide', adminId: 'admin' });
  assert.equal(hidden.status, 'hidden');
  const restored = await svc.moderate({ reviewId: r.review.id, action: 'restore', adminId: 'admin' });
  assert.equal(restored.status, 'published');
});
