// Phase B · B3a — existing gym staff whose PIN their owner chose must change it
// too (owner decision 2026-10-20).
//
// Marks User.passwordChangeRequired = true (the column from functions#219) on
// every gym_staff row an owner made, and writes one AuditLog row per marked
// profile (action gym_staff.pin_change_required_marked, actor
// system:migration), so who was held, when and why can be read back.
//
// Dormant: the mark holds a staff member's sessions only while
// STAFF_PIN_CHANGE_REQUIRED is on (src/shared/credential-change.mjs). With
// the switch off nothing a staff member sees or can do changes.
//
// Which rows ("owner-made"): userType gym_staff, with a Firebase sign-in, not
// yet marked, and NOT made by accepting an invitation (those people chose
// their own credentials). Origin = the earliest of the row's gym_staff_created
// (target = row) and invitation_accepted (after.personaId = row) audit rows,
// so an owner-made row whose person later accepted an invitation is marked. Unknown origin counts as owner-made (fail closed: the worst case
// is someone choosing a new PIN once). Staff who already completed the change
// (AuditLog gym_staff.pin_changed) are skipped, so re-running is a no-op.
// New owner-made staff are marked by POST /owner/staff itself.
//
// Down: unmarks only the rows this migration marked that are still marked
// and were not reset by their owner since, and audits each unmark.

const MARKED = 'gym_staff.pin_change_required_marked';
const UNMARKED = 'gym_staff.pin_change_required_unmarked';
const ACTOR = 'system:migration';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('User', 'passwordChangeRequired'))) return;
  await knex.transaction(async (trx) => {
    const rows = await trx('User as u')
      .where('u.userType', 'gym_staff')
      .whereNotNull('u.firebaseUid')
      .where('u.passwordChangeRequired', false)
      // How the row came to be is the EARLIEST of its gym_staff_created and
      // invitation_accepted audit rows (review of #260, finding 3): an owner-made
      // staff member who later accepted an invitation keeps the owner's PIN. On a
      // tie the owner-made reading wins (fail closed); no row at all = owner-made.
      .whereRaw(`coalesce((
        SELECT a.action FROM "AuditLog" a
        WHERE (a.action = 'gym_staff_created' AND a.target = u.id)
           OR (a.action = 'invitation_accepted' AND a."after"->>'personaId' = u.id)
        ORDER BY a.at ASC, (a.action = 'invitation_accepted') ASC
        LIMIT 1), 'unknown') <> 'invitation_accepted'`)
      .whereNotExists(q => q.select(1).from('AuditLog as a')
        .where('a.action', 'gym_staff.pin_changed')
        .whereRaw('a.target = u.id'))
      .select('u.id', 'u.email', 'u.gymIds');
    if (!rows.length) {
      console.log('[migrate] staff PIN change: 0 owner-made staff marked');
      return;
    }
    const ids = rows.map(r => r.id);
    await trx('User').whereIn('id', ids).update({ passwordChangeRequired: true });
    await trx('AuditLog').insert(rows.map(r => ({
      id: `aud_${r.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(),
      actor: ACTOR,
      action: MARKED,
      target: r.id,
      before: JSON.stringify({ passwordChangeRequired: false }),
      after: JSON.stringify({ passwordChangeRequired: true, reason: 'owner_chosen_pin', gymIds: r.gymIds || [] }),
    })));
    console.log(`[migrate] staff PIN change: ${rows.length} owner-made staff marked (held only while STAFF_PIN_CHANGE_REQUIRED is on)`);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('User', 'passwordChangeRequired'))) return;
  await knex.transaction(async (trx) => {
    const rows = await trx('User as u')
      .where('u.userType', 'gym_staff')
      .where('u.passwordChangeRequired', true)
      .whereExists(q => q.select(1).from('AuditLog as a').where('a.action', MARKED).whereRaw('a.target = u.id'))
      .whereNotExists(q => q.select(1).from('AuditLog as a').where('a.action', 'gym_staff.pin_reset').whereRaw('a.target = u.id'))
      .select('u.id');
    if (!rows.length) return;
    await trx('User').whereIn('id', rows.map(r => r.id)).update({ passwordChangeRequired: false });
    await trx('AuditLog').insert(rows.map(r => ({
      id: `aud_${r.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(), actor: ACTOR, action: UNMARKED, target: r.id,
      before: JSON.stringify({ passwordChangeRequired: true }),
      after: JSON.stringify({ passwordChangeRequired: false }),
    })));
  });
};

exports._internal = { MARKED, UNMARKED, ACTOR };
