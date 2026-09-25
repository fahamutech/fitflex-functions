// Sharing activities between members.
// - Follow: one-way. Two members see what each other shares with
//   "followers" only when they follow each other (mutual).
// - Block: hides everything both ways and ends follows.
// - SocialGroup / SocialGroupMember: groups made by members, trainers,
//   gyms or companies. Only members inside a group see what's shared with
//   it; a trainer, gym or company that owns a group manages it and sees no
//   one's activity through it.
// - Activity.shareWith: who can see one activity —
//   { followers: bool, groups: [groupId], company: bool }; null = private.
// - SocialProfile: the member's default for new activities and their
//   invite code.
// - ActivityKudos / ActivityComment / SocialReport.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('Activity', 'shareWith'))) {
    await knex.schema.alterTable('Activity', (t) => t.jsonb('shareWith'));
  }
  const user = (t, col, nullable = false) => {
    const c = t.text(col);
    if (!nullable) c.notNullable();
    c.references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
  };
  const table = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };

  await table('Follow', (t) => {
    t.text('id').primary();
    user(t, 'followerId');
    user(t, 'followeeId');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['followerId', 'followeeId']);
    t.index('followeeId');
  });
  await table('Block', (t) => {
    t.text('id').primary();
    user(t, 'blockerId');
    user(t, 'blockedId');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['blockerId', 'blockedId']);
    t.index('blockedId');
  });
  await table('SocialProfile', (t) => {
    t.text('id').primary().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.jsonb('defaultShare');
    t.text('inviteCode').notNullable().unique();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await table('SocialGroup', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    // member | trainer | gym | corporate, and that owner's id.
    t.text('ownerType').notNullable();
    t.text('ownerId').notNullable();
    // Company groups are for that company's employees only.
    t.text('corporateId');
    // open (anyone with access joins) | approval (an admin approves).
    t.text('joinPolicy').notNullable().defaultTo('approval');
    // Listed in search, or only reachable with the invite code.
    t.boolean('discoverable').notNullable().defaultTo(false);
    t.text('inviteCode').notNullable().unique();
    t.text('status').notNullable().defaultTo('active');
    t.text('createdBy');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['ownerType', 'ownerId']);
  });
  await table('SocialGroupMember', (t) => {
    t.text('id').primary();
    t.text('groupId').notNullable().references('id').inTable('SocialGroup').onDelete('CASCADE').onUpdate('CASCADE');
    user(t, 'userId');
    // admin | member
    t.text('role').notNullable().defaultTo('member');
    // active | pending (waiting for approval)
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['groupId', 'userId']);
    t.index('userId');
  });
  await table('ActivityKudos', (t) => {
    t.text('id').primary();
    t.text('activityId').notNullable().references('id').inTable('Activity').onDelete('CASCADE').onUpdate('CASCADE');
    user(t, 'userId');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['activityId', 'userId']);
  });
  await table('ActivityComment', (t) => {
    t.text('id').primary();
    t.text('activityId').notNullable().references('id').inTable('Activity').onDelete('CASCADE').onUpdate('CASCADE');
    user(t, 'userId');
    t.text('text').notNullable();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('deletedAt', { precision: 3 });
    t.index('activityId');
  });
  await table('SocialReport', (t) => {
    t.text('id').primary();
    user(t, 'reporterId');
    // user | activity | comment | group
    t.text('targetType').notNullable();
    t.text('targetId').notNullable();
    t.text('reason');
    // open | actioned | dismissed
    t.text('status').notNullable().defaultTo('open');
    t.text('resolvedBy');
    t.timestamp('resolvedAt', { precision: 3 });
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index('status');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const t of ['SocialReport', 'ActivityComment', 'ActivityKudos', 'SocialGroupMember', 'SocialGroup', 'SocialProfile', 'Block', 'Follow']) {
    await knex.schema.dropTableIfExists(t);
  }
  if (await knex.schema.hasColumn('Activity', 'shareWith')) {
    await knex.schema.alterTable('Activity', (t) => t.dropColumn('shareWith'));
  }
};
