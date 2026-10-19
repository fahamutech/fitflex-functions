// Slice A3: database lookups for payment references (transaction IDs).
// Keys are letters+digits, upper case (see referenceKey in shared/manual-payment.mjs);
// the SQL below computes the same key from an admin- or provider-entered `reference`
// and is served by the expression index paymentrequest_reference_key_idx.
import { REFERENCE_HOLDING_STATUSES, DUPLICATE_ATTEMPT_ACTION } from '../shared/manual-payment.mjs';

const REFERENCE_KEY_SQL = `regexp_replace(upper(reference), '[^A-Z0-9]', '', 'g')`;

export function createPaymentReferenceStore({ db }) {
  return {
    /** Other pending/approved requests holding `key`, as a member ID or as a reference. */
    async holders(key, { excludeId = null } = {}) {
      if (!key) return [];
      const q = db('PaymentRequest').select('id', 'status', 'memberId')
        .whereIn('status', REFERENCE_HOLDING_STATUSES)
        .andWhere(b => b.where('memberReferenceKey', key)
          .orWhereRaw(`(reference IS NOT NULL AND ${REFERENCE_KEY_SQL} = ?)`, [key]));
      if (excludeId) q.andWhereNot('id', excludeId);
      return q;
    },
    /** Refused duplicates this member made since `since` (audit log; indexed on actor). */
    async duplicateAttemptsSince(memberId, since) {
      const [{ n }] = await db('AuditLog').where({ actor: memberId, action: DUPLICATE_ATTEMPT_ACTION })
        .andWhere('at', '>=', since).count({ n: '*' });
      return Number(n);
    },
  };
}
