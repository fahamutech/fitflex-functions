// Unit tests for the trainer review system.
// Run with: node --test specs/trainer-review.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerReviewService } from '../src/services/trainer-review-service.mjs';
import {
  MIN_RATING,
  MAX_RATING,
  MIN_REVIEWS_FOR_ACTION,
  REVIEW_STATUS,
  QUALIFYING_BOOKING_STATUSES
} from '../src/shared/trainer-review-constants.mjs';

// ─── Mock store ──────────────────────────────────────────────────────────────
function createStore() {
  const data = { users: [], trainers: [], bookings: [], trainer_reviews: [] };
  function collection(name) {
    return {
      _data: data[name],
      all: () => data[name],
      find: pred => data[name].find(pred),
      filter: pred => data[name].filter(pred),
      some: pred => data[name].some(pred),
      insert: row => { data[name].push(row); return row; },
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

  data.trainers = [{
    id: 'tr_001',
    userId: 'usr_trainer1',
    name: 'John Doe',
    status: 'active',
    rating: null,
    reviewCount: 0
  }];

  data.users = [{
    id: 'usr_member1',
    displayName: 'Aisha Juma',
    userType: 'member'
  }];

  data.bookings = [{
    id: 'bk_001',
    memberId: 'usr_member1',
    trainerId: 'tr_001',
    status: 'completed'
  }];

  const svc = createTrainerReviewService({
    users: collection('users'),
    trainers: collection('trainers'),
    bookings: collection('bookings'),
    trainerReviews: collection('trainer_reviews')
  });

  return { data, svc };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('Member with completed booking can submit a review', () => {
  const { svc } = setupTestEnv();
  const result = svc.submitReview({
    memberId: 'usr_member1',
    trainerId: 'tr_001',
    rating: 5,
    text: 'John was excellent — very patient and knowledgeable.'
  });
  assert.ok(result.ok);
  assert.equal(result.review.rating, 5);
  assert.equal(result.review.text, 'John was excellent — very patient and knowledgeable.');
  assert.equal(result.review.status, 'published');
  assert.equal(result.trainerRating.averageRating, 5);
  assert.equal(result.trainerRating.reviewCount, 1);
});

test('Member without completed booking cannot review', () => {
  const { data, svc } = setupTestEnv();

  // Add a member with no completed booking
  data.users.push({ id: 'usr_nobooking', displayName: 'No Booking', userType: 'member' });

  const result = svc.submitReview({
    memberId: 'usr_nobooking',
    trainerId: 'tr_001',
    rating: 4
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'no_completed_booking');
});

test('Member with only a pending booking cannot review', () => {
  const { data, svc } = setupTestEnv();

  data.users.push({ id: 'usr_pending', displayName: 'Pending Member', userType: 'member' });
  data.bookings.push({
    id: 'bk_pending',
    memberId: 'usr_pending',
    trainerId: 'tr_001',
    status: 'pending'
  });

  const result = svc.submitReview({
    memberId: 'usr_pending',
    trainerId: 'tr_001',
    rating: 4
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'no_completed_booking');
});

test('Member with a no-show booking CAN review (trainer still got paid)', () => {
  const { data, svc } = setupTestEnv();

  data.users.push({ id: 'usr_noshow', displayName: 'No Show Member', userType: 'member' });
  data.bookings.push({
    id: 'bk_noshow',
    memberId: 'usr_noshow',
    trainerId: 'tr_001',
    status: 'no_show'
  });

  const result = svc.submitReview({
    memberId: 'usr_noshow',
    trainerId: 'tr_001',
    rating: 3,
    text: 'I missed the session but the booking process was smooth.'
  });
  assert.ok(result.ok);
  assert.equal(result.review.rating, 3);
});

test('Member with only a cancelled booking cannot review', () => {
  const { data, svc } = setupTestEnv();

  data.users.push({ id: 'usr_cancelled', displayName: 'Cancelled Member', userType: 'member' });
  data.bookings.push({
    id: 'bk_cancelled',
    memberId: 'usr_cancelled',
    trainerId: 'tr_001',
    status: 'cancelled_member'
  });

  const result = svc.submitReview({
    memberId: 'usr_cancelled',
    trainerId: 'tr_001',
    rating: 4
  });
  assert.ok(!result.ok);
});

test('One review per member per trainer — re-reviewing replaces', () => {
  const { svc } = setupTestEnv();

  const r1 = svc.submitReview({
    memberId: 'usr_member1', trainerId: 'tr_001', rating: 3, text: 'It was okay'
  });
  assert.ok(r1.ok);
  const firstId = r1.review.id;

  const r2 = svc.submitReview({
    memberId: 'usr_member1', trainerId: 'tr_001', rating: 5, text: 'Actually it was great!'
  });
  assert.ok(r2.ok);
  assert.equal(r2.review.id, firstId);
  assert.equal(r2.review.rating, 5);
  assert.equal(r2.trainerRating.reviewCount, 1);
  assert.equal(r2.trainerRating.averageRating, 5);
});

test('Rating must be 1-5 integer', () => {
  const { svc } = setupTestEnv();
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 0 }).ok);
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 6 }).ok);
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 3.5 }).ok);
  assert.ok(svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 1 }).ok);
  assert.ok(svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 }).ok);
});

test('Text is optional but if provided must be 3-1000 chars', () => {
  const { svc } = setupTestEnv();
  assert.ok(svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 4 }).ok);
  assert.ok(!svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 4, text: 'ab' }).ok);
  assert.ok(svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 4, text: 'Great trainer' }).ok);
});

test('Average rating is correctly calculated across multiple reviews', () => {
  const { data, svc } = setupTestEnv();

  for (let i = 2; i <= 5; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.bookings.push({ id: `bk_${i}`, memberId: `usr_m${i}`, trainerId: 'tr_001', status: 'completed' });
  }

  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', trainerId: 'tr_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', trainerId: 'tr_001', rating: 3 });
  svc.submitReview({ memberId: 'usr_m4', trainerId: 'tr_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m5', trainerId: 'tr_001', rating: 5 });

  const summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.reviewCount, 5);
  assert.equal(summary.averageRating, 4.2);
  assert.equal(summary.distribution[5], 2);
  assert.equal(summary.distribution[4], 2);
  assert.equal(summary.distribution[3], 1);
});

test('Rating distribution is correct', () => {
  const { data, svc } = setupTestEnv();

  for (let i = 2; i <= 6; i++) {
    data.users.push({ id: `usr_m${i}`, displayName: `Member ${i}`, userType: 'member' });
    data.bookings.push({ id: `bk_${i}`, memberId: `usr_m${i}`, trainerId: 'tr_001', status: 'completed' });
  }

  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', trainerId: 'tr_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', trainerId: 'tr_001', rating: 3 });
  svc.submitReview({ memberId: 'usr_m4', trainerId: 'tr_001', rating: 2 });
  svc.submitReview({ memberId: 'usr_m5', trainerId: 'tr_001', rating: 1 });

  const summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.distribution[5], 1);
  assert.equal(summary.distribution[4], 1);
  assert.equal(summary.distribution[3], 1);
  assert.equal(summary.distribution[2], 1);
  assert.equal(summary.distribution[1], 1);
  assert.equal(summary.averageRating, 3);
});

test('Summary actionable flag is false with fewer than MIN_REVIEWS_FOR_ACTION', () => {
  const { data, svc } = setupTestEnv();

  // Only 1 review (below MIN_REVIEWS_FOR_ACTION = 3)
  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 });

  const summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.actionable, false);
});

test('Summary actionable flag is true with enough reviews', () => {
  const { data, svc } = setupTestEnv();

  data.users.push({ id: 'usr_m2', displayName: 'M2', userType: 'member' });
  data.users.push({ id: 'usr_m3', displayName: 'M3', userType: 'member' });
  data.bookings.push({ id: 'bk_2', memberId: 'usr_m2', trainerId: 'tr_001', status: 'completed' });
  data.bookings.push({ id: 'bk_3', memberId: 'usr_m3', trainerId: 'tr_001', status: 'completed' });

  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', trainerId: 'tr_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', trainerId: 'tr_001', rating: 5 });

  const summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.actionable, true);
  assert.equal(summary.reviewCount, 3);
});

test('Member can delete their own review', () => {
  const { svc } = setupTestEnv();
  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 4 });

  const result = svc.deleteMyReview('usr_member1', 'tr_001');
  assert.ok(result.ok);
  assert.equal(result.trainerRating.reviewCount, 0);
  assert.equal(result.trainerRating.averageRating, null);
});

test('Admin can hide a review — hidden reviews dont count toward rating', () => {
  const { data, svc } = setupTestEnv();

  data.users.push({ id: 'usr_m2', displayName: 'M2', userType: 'member' });
  data.users.push({ id: 'usr_m3', displayName: 'M3', userType: 'member' });
  data.bookings.push({ id: 'bk_2', memberId: 'usr_m2', trainerId: 'tr_001', status: 'completed' });
  data.bookings.push({ id: 'bk_3', memberId: 'usr_m3', trainerId: 'tr_001', status: 'completed' });

  svc.submitReview({ memberId: 'usr_member1', trainerId: 'tr_001', rating: 5 });
  svc.submitReview({ memberId: 'usr_m2', trainerId: 'tr_001', rating: 4 });
  svc.submitReview({ memberId: 'usr_m3', trainerId: 'tr_001', rating: 1 });

  let summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.reviewCount, 3);

  // Hide the 1-star review
  const oneStar = data.trainer_reviews.find(r => r.rating === 1);
  const hideResult = svc.moderateReview(oneStar.id, 'hide', 'admin_user');
  assert.ok(hideResult.ok);

  summary = svc.getTrainerRatingSummary('tr_001');
  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.averageRating, 4.5);
});

test('Eligibility check returns correct reason', () => {
  const { data, svc } = setupTestEnv();

  const eligible = svc.isEligibleToReview('usr_member1', 'tr_001');
  assert.ok(eligible.eligible);
  assert.equal(eligible.reason, 'completed_booking');

  data.users.push({ id: 'usr_nobooking', displayName: 'No Booking', userType: 'member' });
  const notEligible = svc.isEligibleToReview('usr_nobooking', 'tr_001');
  assert.ok(!notEligible.eligible);
  assert.equal(notEligible.reason, 'no_completed_booking');
});

test('Trainer not found returns error', () => {
  const { svc } = setupTestEnv();
  const result = svc.submitReview({
    memberId: 'usr_member1', trainerId: 'tr_nonexistent', rating: 5
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'trainer_not_found');
});

test('Constants are correct', () => {
  assert.equal(MIN_RATING, 1);
  assert.equal(MAX_RATING, 5);
  assert.equal(MIN_REVIEWS_FOR_ACTION, 3);
  assert.equal(REVIEW_STATUS.PUBLISHED, 'published');
  assert.equal(REVIEW_STATUS.FLAGGED, 'flagged');
  assert.equal(REVIEW_STATUS.HIDDEN, 'hidden');
  assert.deepEqual(QUALIFYING_BOOKING_STATUSES, ['completed', 'no_show']);
});

test('All qualifying booking statuses allow reviews', () => {
  const { data, svc } = setupTestEnv();

  for (const status of QUALIFYING_BOOKING_STATUSES) {
    const memberId = `usr_${status}`;
    data.users.push({ id: memberId, displayName: `Member ${status}`, userType: 'member' });
    data.bookings.push({ id: `bk_${status}`, memberId, trainerId: 'tr_001', status });

    const result = svc.submitReview({ memberId, trainerId: 'tr_001', rating: 4, text: 'Good session' });
    assert.ok(result.ok, `Should be eligible with status: ${status}`);
  }
});
