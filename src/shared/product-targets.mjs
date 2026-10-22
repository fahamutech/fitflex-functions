// Optional vendor tags on a product: who it is made for (docs/shop-personalisation-api.md).
// They only reorder products for adult members in member mode (never filter, never in a title)
// and are never shown on buyer-facing rows.

export const TARGET_GENDERS = Object.freeze(['women', 'men']);
export const TARGET_AGE_BANDS = Object.freeze(['18_29', '30_44', '45_59', '60_plus']);
export const TARGET_FIELDS = Object.freeze(['targetGender', 'targetAgeBands']);

/**
 * The target fields in a vendor body → { patch } (only the fields that were sent) or { error }.
 * `targetGender`: 'women' | 'men' | null. `targetAgeBands`: unique known bands ([] = all ages).
 */
export function parseProductTargets(body = {}) {
  const patch = {};
  if (body.targetGender !== undefined) {
    if (body.targetGender !== null && !TARGET_GENDERS.includes(body.targetGender)) {
      return { error: 'invalid_field', status: 400, field: 'targetGender', allowed: [...TARGET_GENDERS, null] };
    }
    patch.targetGender = body.targetGender;
  }
  if (body.targetAgeBands !== undefined) {
    const v = body.targetAgeBands;
    const ok = Array.isArray(v) && v.every(b => TARGET_AGE_BANDS.includes(b)) && new Set(v).size === v.length;
    if (!ok) return { error: 'invalid_field', status: 400, field: 'targetAgeBands', allowed: [...TARGET_AGE_BANDS] };
    // Stored in the fixed band order so the same choice always reads back the same.
    patch.targetAgeBands = TARGET_AGE_BANDS.filter(b => v.includes(b));
  }
  return { patch };
}

/** A row without the target fields (buyer-facing rows never carry them). */
export function withoutTargets(row) {
  if (!row || (!('targetGender' in row) && !('targetAgeBands' in row))) return row;
  const { targetGender, targetAgeBands, ...rest } = row;
  return rest;
}

/** The target fields of a stored row, normalised: { targetGender, targetAgeBands }. */
export function targetsOf(row) {
  return {
    targetGender: TARGET_GENDERS.includes(row?.targetGender) ? row.targetGender : null,
    targetAgeBands: Array.isArray(row?.targetAgeBands) ? row.targetAgeBands.filter(b => TARGET_AGE_BANDS.includes(b)) : [],
  };
}

/** Age in whole years → band, or null under 18 / unknown. */
export function ageBandOf(age) {
  if (!Number.isInteger(age) || age < 18) return null;
  if (age < 30) return '18_29';
  if (age < 45) return '30_44';
  if (age < 60) return '45_59';
  return '60_plus';
}
