// Trainer review domain service. Async (Knex/PostgreSQL), DI-injected. A member
// who has completed (or no-showed) a booking with a trainer may leave one 1-5
// star review with optional text. Rolling average + reviewCount are denormalized
// onto TrainerProfile.
import { randomUUID } from 'node:crypto';

const MIN_RATING = 1;
const MAX_RATING = 5;
const MIN_TEXT = 3;
const MAX_TEXT = 1000;
const QUALIFYING_BOOKING_STATUSES = new Set(['completed', 'no_show', 'fulfilled']);

const makeId = () => `trev_${randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

export function createTrainerReviewService({ trainerReviews, trainers, trainerBookings, users, auditLog }) {
  function validate(rating, text) {
    if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
      return { error: 'rating_must_be_integer_1_to_5', status: 400 };
    }
    if (text != null && text !== '') {
      if (typeof text !== 'string') return { error: 'text_must_be_string', status: 400 };
      if (text.trim().length < MIN_TEXT) return { error: 'text_too_short', status: 400 };
      if (text.length > MAX_TEXT) return { error: 'text_too_long', status: 400 };
    }
    return { ok: true, text: text ? text.trim() : null };
  }

  async function isEligible(memberId, trainerId) {
    const bookings = await trainerBookings.filterAsync(b =>
      b.memberId === memberId && b.trainerId === trainerId && QUALIFYING_BOOKING_STATUSES.has(b.status));
    return bookings.length > 0
      ? { eligible: true, reason: 'completed_booking' }
      : { eligible: false, reason: 'no_completed_booking' };
  }

  async function recalcRating(trainerId) {
    const published = await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.status === 'published');
    const count = published.length;
    const average = count ? Math.round((published.reduce((s, r) => s + Number(r.rating), 0) / count) * 10) / 10 : 0;
    const patch = { rating: average, reviewCount: count };
    // trainers is primed: a row created on another instance after priming isn't
    // in this cache, so updateAsync misses it — write through to the DB.
    if (!(await trainers.updateAsync(t => t.id === trainerId, patch))) await trainers.persistUpdateByIdAsync(trainerId, patch);
    return { trainerId, averageRating: average, reviewCount: count };
  }

  async function submit({ memberId, trainerId, rating, text }) {
    const trainer = await trainers.findByIdAsync(trainerId);
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    const v = validate(rating, text);
    if (v.error) return v;
    const eligibility = await isEligible(memberId, trainerId);
    if (!eligibility.eligible) return { error: eligibility.reason, status: 403 };

    const existing = (await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.memberId === memberId))[0] || null;
    const now = nowIso();
    let review;
    if (existing) {
      await trainerReviews.updateByIdAsync(existing.id, { rating, text: v.text, status: 'published', updatedAt: now });
      review = { ...existing, rating, text: v.text, status: 'published', updatedAt: now };
    } else {
      review = { id: makeId(), trainerId, memberId, rating, text: v.text, status: 'published', createdAt: now, updatedAt: now };
      await trainerReviews.insertAsync(review);
    }
    const trainerRating = await recalcRating(trainerId);
    return { review, trainerRating, updated: Boolean(existing) };
  }

  async function myReview(memberId, trainerId) {
    return (await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.memberId === memberId))[0] || null;
  }

  async function remove({ memberId, trainerId }) {
    const existing = (await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.memberId === memberId))[0];
    if (!existing) return { error: 'review_not_found', status: 404 };
    await trainerReviews.removeAsync(r => r.id === existing.id);
    const trainerRating = await recalcRating(trainerId);
    return { ok: true, trainerRating };
  }

  async function listForTrainer(trainerId, { sortBy = 'recent', limit = 50 } = {}) {
    let rows = await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.status === 'published');
    if (sortBy === 'highest') rows.sort((a, b) => b.rating - a.rating);
    else if (sortBy === 'lowest') rows.sort((a, b) => a.rating - b.rating);
    else rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    rows = rows.slice(0, limit);
    return Promise.all(rows.map(async r => {
      const u = await users.findByIdAsync(r.memberId);
      return { ...r, memberName: u?.displayName || null, memberPhotoUrl: u?.photoUrl || null };
    }));
  }

  async function summary(trainerId) {
    const published = await trainerReviews.filterAsync(r => r.trainerId === trainerId && r.status === 'published');
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of published) distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    const count = published.length;
    const average = count ? Math.round((published.reduce((s, r) => s + Number(r.rating), 0) / count) * 10) / 10 : null;
    return { trainerId, averageRating: average, reviewCount: count, distribution };
  }

  async function moderate({ reviewId, action, adminId }) {
    const map = { hide: 'hidden', flag: 'flagged', restore: 'published' };
    if (!map[action]) return { error: 'invalid_action', status: 400 };
    const review = (await trainerReviews.filterAsync(r => r.id === reviewId))[0];
    if (!review) return { error: 'review_not_found', status: 404 };
    await trainerReviews.updateByIdAsync(reviewId, { status: map[action], moderatedBy: adminId, moderatedAt: nowIso() });
    await recalcRating(review.trainerId);
    auditLog?.insert?.({ id: randomUUID(), at: nowIso(), actor: adminId, action: `trainer_review_${action}`, target: reviewId });
    return { ok: true, reviewId, status: map[action] };
  }

  async function flagged() {
    const rows = await trainerReviews.filterAsync(r => r.status === 'flagged');
    return Promise.all(rows.map(async r => {
      const u = await users.findByIdAsync(r.memberId);
      const t = await trainers.findByIdAsync(r.trainerId);
      return { ...r, memberName: u?.displayName || null, trainerName: t?.displayName || null };
    }));
  }

  return { submit, myReview, remove, listForTrainer, summary, moderate, flagged, isEligible, recalcRating };
}
