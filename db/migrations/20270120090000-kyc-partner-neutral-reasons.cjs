// KYC privacy (owner decision 2026-10-22): partners never see a sensitive
// reason (suspected_fraud, duplicate_partner, or any code that is not a known
// partner-safe one) nor the reviewer's note that came with it.
//
// The service now keeps such a note out of User.approvalNote, which the
// partner sees (sign-in refusal profile_rejected, their own profile). This
// clears the notes already copied there by earlier rejections. The reviewer's
// note itself stays on PartnerKycCase.reasonNote (and PartnerKycEvent.note)
// for admins.
//
// Data only, no schema change. Reversible: down copies the case's note back
// into User.approvalNote where it is still empty.

// Kept in step with REASON_CODES minus SENSITIVE_REASON_CODES in
// src/shared/partner-kyc.mjs (a .cjs migration can't import the ES module).
const PARTNER_SAFE = [
  'document_unreadable', 'document_expired', 'document_mismatch', 'identity_unverified',
  'business_unverified', 'tax_unverified', 'site_visit_failed', 'settlement_unverified',
  'incomplete_submission', 'other',
];

const sensitiveRejectedUsers = knex => knex('PartnerKycCase')
  .select('userId')
  .where('status', 'rejected')
  .whereNotNull('userId')
  .whereNotNull('reasonCode')
  .whereNotIn('reasonCode', PARTNER_SAFE);

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cleared = await knex('User')
    .whereIn('id', sensitiveRejectedUsers(knex))
    .whereNotNull('approvalNote')
    .update({ approvalNote: null });
  if (cleared) console.log(`[migrate] kyc neutral reasons: ${cleared} partner approval note(s) cleared`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE "User" u SET "approvalNote" = c."reasonNote"
      FROM "PartnerKycCase" c
     WHERE c."userId" = u.id
       AND c.status = 'rejected'
       AND c."reasonCode" IS NOT NULL
       AND c."reasonCode" <> ALL (?::text[])
       AND c."reasonNote" IS NOT NULL
       AND u."approvalNote" IS NULL`, [PARTNER_SAFE]);
};
