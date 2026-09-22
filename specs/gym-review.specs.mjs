// Unit tests for the gym review system.
// Run with: node --test specs/gym-review.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymReviewService } from '../src/services/gym-review-service.mjs';
import {
  MIN_RATING,
  MAX_RATING,
  MIN_REVIEWS_FOR_TIER_ACTION,
  REVIEW_STATUS,
  TIER_RATING_THRESHOLDS
} from '../src/shared/gym-review-constants.mjs';

// ─── Mock store helpers ─────────────────────────────────────────────────────
function createStore() {
  const data = { users: [], gyms: [], subscriptions: [], checkins: [], reviews: [] };
  function collection(name) {
    return {
      _data: data[name],
      all: () => data[name],
      find: pred => data[name].find(pred),
      filter: pred => data[name].filter(pred),
      some: pred => data[name].some(pred),
      insert: row => { data[name].push(row); return row; },
      upsert: (pred, row) => {
        const i = data[name].findIndex(pred);
        if (i >= 0) data[name][i] = { ...data[name][i], ...row };
        else data[name].push(row);
        return data[name].find(pred);
      },
      update: (pred, patch) => {
        const i = data[name].findIndex(pred);
        if (i >= 0) data[name][i] = { ...data[name][i], ...patch };
        return data[name].find(pred);
      },
      remove: pred => {
        const i = data[name].findIndex(pred);
        if (i >= 0) return data[name].splice(i, 1)[0];
        return null;
      }
    };
  }
  return { data, collection };
}

function setupTestEnv() {
  const { data, collection } = createStore();

  // Seed a gym
  data.gyms = [{
    id: 'gym_001',
    name: 'Power Gym Mikocheni',
    tier: 'standard',
    status: 'active',
    rating: null,
    reviewCount: 0
  }];

  // Seed a member
  data.users = [{
    id: 'usr_member1',
    displayName: 'Aisha Juma',
    userType: 'member',
    phone: '+255712111222'
  }];

  // Seed a check-in (member visited the gym)
  data.checkins = [{
    id: 'chk_1',
    memberId: 'usr_member1',
    gymId: 'gym_001',
    timestamp: new Date().toISOString(),
    visitConsumed: true
  }];

  const svc = createGymReviewService({
    users: collection('users'),
    gyms: collection('gyms'),
    subscriptions: collection('subscriptions'),
    checkins: collection('checkins'),
    reviews: collection('reviews')
  });

  return { data, svc };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('Member with check-in can submit a review', () => {
  const { svc } = setupTestEnv();
  const result = svc.submitReview({
    memberId: 'usr_member1',
    gymId: 'gym_001',
    rating: 5,
    text: 'Excellent gym, clean equipment!'
  });
  assert.ok(result.ok);
  assert.equal(result.review.rating, 5);
  assert.equal(result.review.text, 'Excellent gym, clean equipment!');
  assert.equal(result.review.status, 'published');
  assert.equal(result.gymRating.averageRating, 5);
  assert.equal(result.gymRating.reviewCount, 1);
});

test('Member without check-in or direct sub cannot review', () => {
  const { data, svc, collection } = setupTestEnv();

  // Add a member with no check-in at this gym
  data.users.push({ id: 'usr_nomember', displayName: 'New Guy', userType: 'member' });

  const result = svc.submitReview({
    memberId: 'usr_nomember',
    gymId: 'gym_001',
    rating: 4
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'no_checkin_or_direct_subscription');
});

test('Member with direct subscription can review (no check-in needed)', () => {
  const { data, svc } = setupTestEnv();

  // Add a member with direct sub but no check-in
  data.users.push({ id: 'usr_directsub', displayName: 'Direct Sub Member', userType: 'member' });
  data.subscriptions.push({
    id: 'sub_ds',
    memberId: 'usr_directsub',
    type: 'direct_sub',
    homeGymId: 'gym_001',
    status: 'active'
  });

  const result = svc.submitReview({
    memberId: 'usr_directsub',
    gymId: 'gym_001',
    rating: 4,
    text: 'Great direct subscription experience'
  });
  assert.ok(result.ok);
  assert.equal(result.review.rating, 4);
});

test('One review per member per gym — re-reviewing replaces the old one', () => {
  const { svc } = setupTestEnv();

  // First review
  const r1 = svc.submitReview({
    memberId: 'usr_member1', gymId: 'gym_001', rating: 3, text: 'It was okay'
  });
  assert.ok(r1.ok);
  const firstId = r1.review.id;

  // Second review (should replace the first)
  const r2 = svc.submitReview({
    memberId: 'usr_member1', gymId: 'gym_001', rating: 5, text: 'Actually it was great!'
  });
  assert.ok(r2.ok);
  assert.equal(r2.review.id, firstId); // same ID — it was an update
  assert.equal(r2.review.rating, 5);
  assert.equal(r2.gymRating.reviewCount, 1); // still 1, not 2
  assert.equal(r2.gymRating.averageRating, 5); // average is now 5 (replaced the 3)
});

test('Rating must be 1-5 integer', () => {
  const { svc } = setupTestEnv();

  assert.ok(!svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 0 }).ok);
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 6 }).ok);
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 3.5 }).ok);
  assert.ok(svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 1 }).ok);
  assert.ok(svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 5 }).ok);
});

test('Text is optional but if provided must be 3-1000 chars', () => {
  const { svc } = setupTestEnv();

  // No text — should work
  assert.ok(svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 4 }).ok);

  // Text too short
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 4, text: 'ab' }).ok);

  // Valid text
  assert.ok(svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 4, text: 'Good gym' }).ok);
});

test('Average rating is correctly calculated across multiple reviews', () => {
  const { data, svc } = setupTestEnv();

  // Add 4 more members with check-ins
  for (let i = 2; i <= 5; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.checkins.push({ id: `chk_${i}`, memberId: `usr_m${i}`, gymId: 'gym_001', visitConsumed: true });
  }

  // Submit reviews: 5, 4, 3, 4, 5 → avg = 21/5 = 4.2
  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', gymId: 'gym_001', rating: 3 });
  svc.submitReview({ memberId: 'usr_m4', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m5', gymId: 'gym_001', rating: 5 });

  const summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.reviewCount, 5);
  assert.equal(summary.averageRating, 4.2);
  assert.equal(summary.distribution[5], 2);
  assert.equal(summary.distribution[4], 2);
  assert.equal(summary.distribution[3], 1);
  assert.equal(summary.distribution[2], 0);
  assert.equal(summary.distribution[1], 0);
});

test('Tier signal: standard gym with low rating suggests downlift', () => {
  const { data, svc } = setupTestEnv();

  // Set gym tier to midtier and add 5 low reviews
  data.gyms[0].tier = 'midtier';
  for (let i = 2; i <= 5; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.checkins.push({ id: `chk_${i}`, memberId: `usr_m${i}`, gymId: 'gym_001', visitConsumed: true });
  }

  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 2 });
  svc.submitReview({ memberId: 'usr_m2', gymId: 'gym_001', rating: 2 });
  svc.submitReview({ memberId: 'usr_m3', gymId: 'gym_001', rating: 3 });
  svc.submitReview({ memberId: 'usr_m4', gymId: 'gym_001', rating: 2 });
  svc.submitReview({ memberId: 'usr_m5', gymId: 'gym_001', rating: 2 });

  const summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.tierSignal.action, 'consider_downlift');
  assert.equal(summary.tierSignal.suggestedTier, 'standard');
  assert.equal(summary.tierSignal.currentTier, 'midtier');
});

test('Tier signal: insufficient reviews returns insufficient_data', () => {
  const { svc } = setupTestEnv();

  // Only 1 review (below MIN_REVIEWS_FOR_TIER_ACTION = 5)
  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 1 });

  const summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.tierSignal.action, 'insufficient_data');
});

test('Tier signal: gym with good rating returns no_action', () => {
  const { data, svc } = setupTestEnv();

  for (let i = 2; i <= 5; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.checkins.push({ id: `chk_${i}`, memberId: `usr_m${i}`, gymId: 'gym_001', visitConsumed: true });
  }

  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', gymId: 'gym_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m4', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m5', gymId: 'gym_001', rating: 5 });

  const summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.tierSignal.action, 'no_action');
});

test('Member can delete their own review', () => {
  const { svc } = setupTestEnv();

  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 4 });
  const result = svc.deleteMyReview('usr_member1', 'gym_001');
  assert.ok(result.ok);
  assert.equal(result.gymRating.reviewCount, 0);
  assert.equal(result.gymRating.averageRating, null);
});

test('Admin can hide a review — hidden reviews dont count toward rating', () => {
  const { data, svc } = setupTestEnv();

  for (let i = 2; i <= 3; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.checkins.push({ id: `chk_${i}`, memberId: `usr_m${i}`, gymId: 'gym_001', visitConsumed: true });
  }

  // Submit 3 reviews: 5, 4, 1 → avg = 10/3 = 3.33
  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', gymId: 'gym_001', rating: 1 });

  let summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.reviewCount, 3);

  // Hide the 1-star review
  const oneStarReview = data.reviews.find(r => r.rating === 1);
  const hideResult = svc.moderateReview(oneStarReview.id, 'hide', 'admin_user');
  assert.ok(hideResult.ok);

  summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.reviewCount, 2); // hidden one doesn't count
  // avg of 5 and 4 = 4.5
  assert.equal(summary.averageRating, 4.5);
});

test('Eligibility check returns correct reason', () => {
  const { data, svc } = setupTestEnv();

  // Member with check-in
  const eligible = svc.isEligibleToReview('usr_member1', 'gym_001');
  assert.ok(eligible.eligible);
  assert.equal(eligible.reason, 'check_in_history');

  // Member without check-in
  data.users.push({ id: 'usr_nocheckin', displayName: 'No Checkin', userType: 'member' });
  const notEligible = svc.isEligibleToReview('usr_nocheckin', 'gym_001');
  assert.ok(!notEligible.eligible);
  assert.equal(notEligible.reason, 'no_checkin_or_direct_subscription');
});

test('Gym not found returns error', () => {
  const { svc } = setupTestEnv();
  const result = svc.submitReview({
    memberId: 'usr_member1', gymId: 'gym_nonexistent', rating: 5
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'gym_not_found');
});

test('Rating distribution is correct', () => {
  const { data, svc } = setupTestEnv();

  for (let i = 2; i <= 6; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.checkins.push({ id: `chk_${i}`, memberId: `usr_m${i}`, gymId: 'gym_001', visitConsumed: true });
  }

  // 1×5, 1×4, 1×3, 1×2, 1×1 → distribution { 1:1, 2:1, 3:1, 4:1, 5:1 }
  svc.submitReview({ memberId: 'usr_member1', gymId: 'gym_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', gymId: 'gym_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', gymId: 'gym_001', rating: 3 });
  svc.submitReview({ memberId: 'usr_m4', gymId: 'gym_001', rating: 2 });
  svc.submitReview({ memberId: 'usr_m5', gymId: 'gym_001', rating: 1 });

  const summary = svc.getGymRatingSummary('gym_001');
  assert.equal(summary.distribution[5], 1);
  assert.equal(summary.distribution[4], 1);
  assert.equal(summary.distribution[3], 1);
  assert.equal(summary.distribution[2], 1);
  assert.equal(summary.distribution[1], 1);
  assert.equal(summary.averageRating, 3); // (5+4+3+2+1)/5 = 3
});

test('Constants are correct', () => {
  assert.equal(MIN_RATING, 1);
  assert.equal(MAX_RATING, 5);
  assert.equal(MIN_REVIEWS_FOR_TIER_ACTION, 5);
  assert.equal(REVIEW_STATUS.PUBLISHED, 'published');
  assert.equal(REVIEW_STATUS.FLAGGED, 'flagged');
  assert.equal(REVIEW_STATUS.HIDDEN, 'hidden');
  assert.equal(TIER_RATING_THRESHOLDS.midtier.downliftBelow, 3.0);
  assert.equal(TIER_RATING_THRESHOLDS.premium.downliftBelow, 3.5);
  assert.equal(TIER_RATING_THRESHOLDS.luxury_executive.downliftBelow, 4.0);
});
