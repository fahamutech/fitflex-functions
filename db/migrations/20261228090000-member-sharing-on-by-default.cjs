// Member sharing on by default (owner decision 2026-10-19). Applies to
// everyone, existing members included: a one-time switch-on of current
// settings. Members can switch any of it off again afterwards.
//
//   TrainerMemberRelationship.permissions  all eight keys on, every row.
//   GymMemberSharing.permissions           all three keys on, every row (no
//                                          row already means all on).
//   ChallengeParticipant.leaderboardOptIn  on, every row.
//   SocialProfile.publicProfile            on, every row.
//   SocialProfile.defaultShare             Public + every group the member is
//                                          in (`allGroups`), every row.
//
// Activity.shareWith is NOT rewritten: past activities keep who they were
// shared with. Column defaults change too, so raw inserts match the app.
//
// Down: restores the old column defaults only. The members' previous
// choices are overwritten by `up` and cannot be restored.

const TRAINER_ON = {
  steps: true, distance: true, activeMinutes: true, workoutHistory: true,
  workoutDetails: true, goals: true, streaks: true, challenges: true,
};
const GYM_ON = { classAttendance: true, gymWorkouts: true, challenges: true };
// Same as DEFAULT_SHARE in src/services/social-service.mjs.
const DEFAULT_SHARE = { friends: false, followers: false, public: true, groups: [], company: false, allGroups: true };

const json = v => `'${JSON.stringify(v)}'::jsonb`;

async function setDefault(knex, table, column, sql) {
  if (await knex.schema.hasColumn(table, column)) {
    await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT ${sql}`);
  }
}

async function dropDefault(knex, table, column) {
  if (await knex.schema.hasColumn(table, column)) {
    await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`);
  }
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('TrainerMemberRelationship', 'permissions')) {
    await knex('TrainerMemberRelationship').update({ permissions: JSON.stringify(TRAINER_ON) });
  }
  if (await knex.schema.hasColumn('GymMemberSharing', 'permissions')) {
    await knex('GymMemberSharing').update({ permissions: JSON.stringify(GYM_ON) });
  }
  if (await knex.schema.hasColumn('ChallengeParticipant', 'leaderboardOptIn')) {
    await knex('ChallengeParticipant').update({ leaderboardOptIn: true });
  }
  if (await knex.schema.hasColumn('SocialProfile', 'publicProfile')) {
    await knex('SocialProfile').update({ publicProfile: true, defaultShare: JSON.stringify(DEFAULT_SHARE) });
  }

  await setDefault(knex, 'TrainerMemberRelationship', 'permissions', json(TRAINER_ON));
  await setDefault(knex, 'GymMemberSharing', 'permissions', json(GYM_ON));
  await setDefault(knex, 'ChallengeParticipant', 'leaderboardOptIn', 'true');
  await setDefault(knex, 'SocialProfile', 'publicProfile', 'true');
  await setDefault(knex, 'SocialProfile', 'defaultShare', json(DEFAULT_SHARE));
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  // Defaults only — the data switched on by `up` stays as it is.
  await setDefault(knex, 'TrainerMemberRelationship', 'permissions', `'{}'::jsonb`);
  await setDefault(knex, 'GymMemberSharing', 'permissions', `'{}'::jsonb`);
  await setDefault(knex, 'ChallengeParticipant', 'leaderboardOptIn', 'false');
  await setDefault(knex, 'SocialProfile', 'publicProfile', 'false');
  await dropDefault(knex, 'SocialProfile', 'defaultShare');
};
