// Marathon & running events · S1 (foundation) — event organizers.
// Design: docs/marathon/reuse-map.md §5.1, decisions D2 (FitFlex collects, organizer paid through the
// partner-statement workflow with a per-organizer commission) and D3 (vendor-style organizer identity).
//
// - EventOrganizer: the business that puts on events. ownerUserId is the FitFlex user who created it
//   (an organizer persona in S2). status draft → pending_review → active | rejected; active ⇄ suspended
//   (ORG-003; the rules live in src/shared/events-lifecycle.mjs). kycCaseId points at its PartnerKycCase
//   (partnerType event_organizer) and settlementAccountId at the verified account it is paid into — both
//   nullable because they are made later in onboarding. commissionPct is a whole percent (D2: a value of
//   configuration, never code); null = the platform default. timezone is the IANA zone its events are
//   scheduled in (dates are stored in UTC, shown in this zone).
// - EventOrganizerStaff: people who act for an organizer in a role (owner/admin/ops/finance/timing).
//   One active row per (organizer, user); a removed row is kept as history.
// - Existing CHECKs widened, nothing else touched: OrgMembership.orgType also accepts 'organizer' and
//   PartnerKycCase.partnerType also accepts 'event_organizer'. The companion org_membership_one_org_check
//   and _role_check are NOT widened here: an organizer membership row still cannot be written until S2
//   adds the organizer link to OrgMembership (called out in the PR).
//
// Dormant: no route reads these tables (EVENTS_MODULE off).
// Down: drops both tables and restores the two CHECKs exactly as they were. It refuses while a row uses
// one of the new values, because restoring the old CHECK would fail on it.

const ORGANIZER_STATUSES = ['draft', 'pending_review', 'active', 'rejected', 'suspended'];
const STAFF_ROLES = ['owner', 'admin', 'ops', 'finance', 'timing'];
const STAFF_STATUSES = ['active', 'removed'];
const list = values => values.map(v => `'${v}'`).join(', ');

// The constraints as their own migrations wrote them (20261105090000-org-membership.cjs,
// 20261010090000-partner-kyc.cjs); down puts these back.
const ORG_TYPES_BEFORE = ['gym', 'vendor'];
const PARTNER_TYPES_BEFORE = ['gym_owner', 'trainer', 'vendor', 'corporate'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('EventOrganizer', (t) => {
    t.text('id').primary();
    t.text('ownerUserId').notNullable().references('id').inTable('User').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('legalName');
    t.text('contactPhone');
    t.text('contactEmail');
    t.text('status').notNullable().defaultTo('draft');
    t.text('statusReason');
    t.text('kycCaseId').references('id').inTable('PartnerKycCase').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('settlementAccountId').references('id').inTable('PartnerSettlementAccount').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('commissionPct');
    t.text('timezone').notNullable().defaultTo('Africa/Dar_es_Salaam');
    stamps(t);
    t.index(['ownerUserId']);
    t.index(['status']);
  });
  await knex.raw(`ALTER TABLE "EventOrganizer"
    ADD CONSTRAINT eventorganizer_status_check CHECK (status IN (${list(ORGANIZER_STATUSES)})),
    ADD CONSTRAINT eventorganizer_name_length_check CHECK (char_length(name) BETWEEN 1 AND 160),
    ADD CONSTRAINT eventorganizer_commission_range_check CHECK ("commissionPct" IS NULL OR ("commissionPct" BETWEEN 0 AND 100)),
    ADD CONSTRAINT eventorganizer_status_reason_check CHECK (status NOT IN ('rejected', 'suspended') OR "statusReason" IS NOT NULL)`);

  await knex.schema.createTable('EventOrganizerStaff', (t) => {
    t.text('id').primary();
    t.text('organizerId').notNullable().references('id').inTable('EventOrganizer').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('role').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.text('addedBy');
    t.timestamp('removedAt', { precision: 3 });
    stamps(t);
    t.index(['userId', 'status']);
  });
  await knex.raw(`ALTER TABLE "EventOrganizerStaff"
    ADD CONSTRAINT eventorganizerstaff_role_check CHECK (role IN (${list(STAFF_ROLES)})),
    ADD CONSTRAINT eventorganizerstaff_status_check CHECK (status IN (${list(STAFF_STATUSES)})),
    ADD CONSTRAINT eventorganizerstaff_removed_check CHECK ((status = 'removed') = ("removedAt" IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventorganizerstaff_active_unique ON "EventOrganizerStaff" ("organizerId", "userId") WHERE status = 'active'`);

  // Widen the two existing type CHECKs (same names, one more value each).
  await knex.raw(`ALTER TABLE "OrgMembership" DROP CONSTRAINT IF EXISTS org_membership_org_type_check`);
  await knex.raw(`ALTER TABLE "OrgMembership" ADD CONSTRAINT org_membership_org_type_check CHECK ("orgType" IN (${list([...ORG_TYPES_BEFORE, 'organizer'])}))`);
  await knex.raw(`ALTER TABLE "PartnerKycCase" DROP CONSTRAINT IF EXISTS partner_kyc_case_type_chk`);
  await knex.raw(`ALTER TABLE "PartnerKycCase" ADD CONSTRAINT partner_kyc_case_type_chk CHECK ("partnerType" IN (${list([...PARTNER_TYPES_BEFORE, 'event_organizer'])}))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const memberships = (await knex.raw(`SELECT count(*)::int AS n FROM "OrgMembership" WHERE "orgType" = 'organizer'`)).rows[0].n;
  if (memberships) throw new Error(`events-organizers down: ${memberships} OrgMembership row(s) have orgType organizer; the old CHECK cannot be restored over them`);
  const cases = (await knex.raw(`SELECT count(*)::int AS n FROM "PartnerKycCase" WHERE "partnerType" = 'event_organizer'`)).rows[0].n;
  if (cases) throw new Error(`events-organizers down: ${cases} PartnerKycCase row(s) have partnerType event_organizer; the old CHECK cannot be restored over them`);

  await knex.raw(`ALTER TABLE "PartnerKycCase" DROP CONSTRAINT IF EXISTS partner_kyc_case_type_chk`);
  await knex.raw(`ALTER TABLE "PartnerKycCase" ADD CONSTRAINT partner_kyc_case_type_chk CHECK ("partnerType" IN (${list(PARTNER_TYPES_BEFORE)}))`);
  await knex.raw(`ALTER TABLE "OrgMembership" DROP CONSTRAINT IF EXISTS org_membership_org_type_check`);
  await knex.raw(`ALTER TABLE "OrgMembership" ADD CONSTRAINT org_membership_org_type_check CHECK ("orgType" IN (${list(ORG_TYPES_BEFORE)}))`);

  await knex.schema.dropTableIfExists('EventOrganizerStaff');
  await knex.schema.dropTableIfExists('EventOrganizer');
};
