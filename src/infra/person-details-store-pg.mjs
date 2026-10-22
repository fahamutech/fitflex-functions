// Person.dateOfBirth / Person.gender (partner DOB slice 2, docs/partner-dob-api.md): the pieces the
// identity merge and account deletion need. Nothing here reads KYC (the KYC person records) — by owner
// decision 2026-10-22 the declared date of birth and the KYC one are never mixed.

export const PERSON_GENDERS = Object.freeze(['male', 'female', 'other']);

// Until the migration has run the columns are not there; sign-in and account deletion must keep
// working, so these helpers then do nothing. Only a positive answer is remembered.
let columnsKnown = false;
export async function personDetailsColumnsExist(q) {
  if (columnsKnown) return true;
  const r = await q.raw(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Person'
      AND column_name IN ('dateOfBirth', 'gender', 'declaredProfileUpdatedAt')`);
  columnsKnown = Number(r.rows?.[0]?.n) === 3;
  return columnsKnown;
}
/** Specs only: forget the remembered answer. */
export const resetPersonDetailsColumnsCache = () => { columnsKnown = false; };

/** A Person's declared date of birth ("YYYY-MM-DD" text, never a JS Date) and gender, or null. */
export async function readPersonDetails(q, personId) {
  if (!personId || !(await personDetailsColumnsExist(q))) return null;
  const row = await q('Person').where({ id: personId })
    .first(q.raw(`to_char("dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth"`), 'gender', 'declaredProfileUpdatedAt');
  return row || null;
}

/**
 * Identity merge (identity-link-service): the surviving Person takes the date of birth and the gender
 * from the merged-in one only where it has none of its own. When the merged-in Person is left empty
 * (a tombstone) it keeps neither.
 */
export async function carryPersonDetails(trx, { fromPersonId, toPersonId, clearFrom = false }) {
  if (!fromPersonId || !toPersonId || fromPersonId === toPersonId) return { changed: false };
  if (!(await personDetailsColumnsExist(trx))) return { changed: false };
  const from = await readPersonDetails(trx, fromPersonId);
  const fields = [];
  // Each field only where the survivor still has none at write time (WHERE … IS NULL), so a
  // concurrent write on the survivor is never overwritten.
  for (const field of ['dateOfBirth', 'gender']) {
    if (!from?.[field]) continue;
    const n = await trx('Person').where({ id: toPersonId }).whereNull(field)
      .update({ [field]: from[field], declaredProfileUpdatedAt: trx.fn.now(), updatedAt: trx.fn.now() });
    if (n) fields.push(field);
  }
  if (clearFrom && (from?.dateOfBirth || from?.gender)) {
    await trx('Person').where({ id: fromPersonId })
      .update({ dateOfBirth: null, gender: null, declaredProfileUpdatedAt: null, updatedAt: trx.fn.now() });
  }
  return { changed: fields.length > 0, fields };
}

/** Account deleted: once the Person has no personas left, its date of birth and gender go too. */
export async function forgetPersonDetails(db, { personId }) {
  if (!personId || !(await personDetailsColumnsExist(db))) return;
  const left = await db('User').where({ personId }).first('id');
  if (left) return;
  await db('Person').where({ id: personId })
    .update({ dateOfBirth: null, gender: null, declaredProfileUpdatedAt: null, updatedAt: db.fn.now() });
}
