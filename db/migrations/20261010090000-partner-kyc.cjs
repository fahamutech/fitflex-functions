// Partner KYC/KYB — the data foundation for verifying gym owners, trainers,
// vendors and corporate partners, and the accounts FitFlex pays them into.
//
// How the target model maps onto the schema (existing records are reused;
// only what has no home today is new):
//
//   Partner ........................ EXISTING: User (gym_operator | trainer | vendor)
//                                    or CorporateAccount. No Partner table.
//   PartnerProfile ................. EXISTING: Gym + owner User, TrainerProfile,
//                                    User.vendorProfile, CorporateAccount. Unchanged.
//   KYC Case ....................... NEW PartnerKycCase: exactly one per partner,
//                                    the anchor every row below hangs off. Its
//                                    status drives the existing User.approvalStatus.
//   BusinessProfile ................ NEW columns on PartnerKycCase (legal name, entity
//                                    type, registration no., TIN). One per partner,
//                                    so no table of its own. Trading details stay
//                                    in the existing profiles.
//   IndividualIdentity ............. NEW PartnerPerson, role 'principal'
//   BeneficialOwner ................ PartnerPerson, role 'beneficial_owner'
//   AuthorisedRepresentative ....... PartnerPerson, role 'authorised_representative'
//                                    (and 'director'). One table for every natural
//                                    person, so an ID number is checked the same way.
//   Documents ...................... NEW PartnerDocument (metadata; the file itself
//                                    lives in private, access-controlled storage)
//   Verification ................... NEW PartnerCheck: one result row per check, for
//   Settlement Account Verification  the case, a person, a document, a settlement
//   Operational Verification ....... account or a gym (site visit). One table.
//                                    Checks are manual for now; a registry lookup
//                                    (NIDA, BRELA, TRA) is method 'provider' with the
//                                    registry's returned details kept in evidence.
//   Settlement Accounts ............ NEW PartnerSettlementAccount. Supersedes the free
//                                    text Gym.paymentBank/paymentNumber and
//                                    User.vendorProfile.settlementAccount, which are
//                                    left in place for now and migrated later.
//   Agreements ..................... NEW PartnerAgreement (acceptance records;
//                                    commercial terms stay on Gym / CorporateAccount)
//   Review History + Status History  NEW PartnerKycEvent: one append-only timeline.
//                                    AuditLog keeps getting its usual rows too.
//
// Identifiers (ID numbers, TIN, account numbers, document numbers) are stored
// as plain text, normalised (upper case, no spaces or dashes) so the same
// number on two partners can be found. They are for FitFlex admins and staff
// only; the API must never return them to members or other partners.
//
// Rows cascade from the partner's User / CorporateAccount. Retention of KYC
// records after account deletion is a later decision; the stored files must
// be purged by the same path that deletes these rows.

const PARTNER_TYPES = ['gym_owner', 'trainer', 'vendor', 'corporate'];
const CASE_STATUSES = ['draft', 'submitted', 'in_review', 'info_requested', 'approved', 'rejected', 'suspended'];
const ENTITY_TYPES = ['individual', 'sole_proprietor', 'partnership', 'company', 'ngo', 'government'];
const PERSON_ROLES = ['principal', 'director', 'beneficial_owner', 'authorised_representative'];
const ID_TYPES = ['nida', 'passport', 'driving_licence', 'voter_id'];
const PERSON_STATUSES = ['pending', 'verified', 'rejected'];
const DOCUMENT_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'superseded'];
const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const CHECK_TYPES = ['identity', 'business_registration', 'tax', 'licence', 'certification', 'insurance',
  'site_visit', 'settlement_account', 'sanctions', 'document'];
const CHECK_TARGETS = ['case', 'person', 'document', 'settlement_account', 'gym'];
const CHECK_METHODS = ['manual', 'provider', 'site_visit', 'name_match', 'test_deposit'];
const CHECK_RESULTS = ['pending', 'passed', 'failed', 'inconclusive'];
const CHECK_PROVIDERS = ['nida', 'brela', 'tra'];
const SETTLEMENT_METHODS = ['bank', 'mobile_money'];
const SETTLEMENT_STATUSES = ['pending_verification', 'verified', 'rejected', 'disabled'];
const AGREEMENT_TYPES = ['platform_terms', 'partner_agreement', 'commission_schedule', 'data_processing', 'kyc_consent'];
const AGREEMENT_STATUSES = ['accepted', 'superseded', 'revoked'];
const EVENT_TYPES = ['status_changed', 'document_uploaded', 'document_reviewed', 'person_updated', 'check_recorded',
  'settlement_account_changed', 'agreement_accepted', 'reviewer_assigned', 'note'];

const DAY = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const ref = (t, col, table, { onDelete = 'CASCADE', required = false } = {}) => {
    const c = t.text(col);
    if (required) c.notNullable();
    c.references('id').inTable(table).onDelete(onDelete).onUpdate('CASCADE');
  };
  const table = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };
  // A normalised identifier, indexed so duplicates across partners show up.
  const identifier = (t, col) => {
    t.text(col);
    t.index(col);
  };
  const caseRef = (t) => ref(t, 'caseId', 'PartnerKycCase', { required: true });

  await table('PartnerKycCase', (t) => {
    t.text('id').primary();
    t.text('partnerType').notNullable();
    ref(t, 'userId', 'User');                   // gym_owner | trainer | vendor
    ref(t, 'corporateId', 'CorporateAccount');  // corporate
    t.text('status').notNullable().defaultTo('draft');
    t.integer('tier').notNullable();            // 2 | 3 (canon KYC tiers); 0 = legacy, approved before KYC
    t.integer('round').notNullable().defaultTo(1);
    // Business profile (legal entity). Empty for an individual trainer.
    t.text('legalName');
    t.text('tradingName');
    t.text('entityType');
    identifier(t, 'registrationNumber');
    t.text('registrationAuthority');            // e.g. BRELA
    t.text('incorporatedOn');                   // YYYY-MM-DD
    t.jsonb('registeredAddress');
    identifier(t, 'tin');
    // Review
    ts(t, 'submittedAt');
    ref(t, 'reviewerId', 'User', { onDelete: 'SET NULL' });
    ts(t, 'decidedAt');
    ref(t, 'decidedBy', 'User', { onDelete: 'SET NULL' });
    t.text('reasonCode');
    t.text('reasonNote');
    ts(t, 'reverifyAt');                        // when an approved case must be reviewed again
    stamps(t);
    t.index(['partnerType', 'status']);
    t.index('status');
  });

  await table('PartnerPerson', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.text('role').notNullable();
    ref(t, 'userId', 'User', { onDelete: 'SET NULL' }); // when the person is also a FitFlex user
    t.text('fullName').notNullable();
    t.text('dateOfBirth');                      // YYYY-MM-DD
    t.text('nationality').notNullable().defaultTo('TZ');
    t.text('idType');
    identifier(t, 'idNumber');
    t.text('idExpiresOn');                      // YYYY-MM-DD
    t.text('phone');
    t.text('email');
    t.text('position');                         // for directors and representatives
    t.double('ownershipPct');                   // for beneficial owners
    t.boolean('isPoliticallyExposed').notNullable().defaultTo(false);
    t.text('status').notNullable().defaultTo('pending');
    stamps(t);
    t.index(['caseId', 'role']);
  });

  await table('PartnerSettlementAccount', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.text('method').notNullable();
    t.text('provider').notNullable();           // bank name or mpesa | airtel_money | mixx | halopesa
    t.text('accountName').notNullable();
    identifier(t, 'accountNumber');
    t.text('branch');
    t.text('swiftCode');
    t.text('currency').notNullable().defaultTo('TZS');
    t.text('status').notNullable().defaultTo('pending_verification');
    t.boolean('isPrimary').notNullable().defaultTo(false);
    ref(t, 'requestedBy', 'User', { onDelete: 'SET NULL' });
    ref(t, 'verifiedBy', 'User', { onDelete: 'SET NULL' });
    ts(t, 'verifiedAt');
    ts(t, 'cooldownUntil');
    ts(t, 'disabledAt');
    t.text('legacySource');                     // 'gym.paymentNumber' | 'vendorProfile.settlementAccount' when migrated
    stamps(t);
    t.index(['caseId', 'status']);
  });

  await table('PartnerDocument', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.integer('round').notNullable().defaultTo(1);
    t.text('requirementKey').notNullable();
    t.text('docType').notNullable();
    ref(t, 'personId', 'PartnerPerson', { onDelete: 'SET NULL' });
    ref(t, 'settlementAccountId', 'PartnerSettlementAccount', { onDelete: 'SET NULL' });
    ref(t, 'gymId', 'Gym', { onDelete: 'SET NULL' });
    t.text('storageProvider').notNullable();
    t.text('storageKey').notNullable();
    t.text('fileName');
    t.text('mimeType').notNullable();
    t.integer('sizeBytes').notNullable();
    t.text('sha256').notNullable();
    identifier(t, 'documentNumber');
    t.text('issuedOn');                         // YYYY-MM-DD
    t.text('expiresOn');                        // YYYY-MM-DD
    t.text('status').notNullable().defaultTo('pending');
    ref(t, 'supersedesId', 'PartnerDocument', { onDelete: 'SET NULL' });
    t.text('reviewNote');
    ref(t, 'reviewedBy', 'User', { onDelete: 'SET NULL' });
    ts(t, 'reviewedAt');
    ref(t, 'uploadedBy', 'User', { onDelete: 'SET NULL' });
    stamps(t);
    t.index(['caseId', 'requirementKey']);
    t.index('sha256');
    t.index('expiresOn');
  });

  await table('PartnerCheck', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.integer('round').notNullable().defaultTo(1);
    t.text('checkType').notNullable();
    t.text('targetType').notNullable();
    t.text('targetId');                         // person / document / settlement account / gym id; null for the case
    t.text('method').notNullable();
    t.text('provider');                         // external verifier, when method = 'provider'
    t.text('result').notNullable().defaultTo('pending');
    t.jsonb('evidence').notNullable().defaultTo('{}'); // e.g. the details a registry returned
    t.text('note');
    ref(t, 'performedBy', 'User', { onDelete: 'SET NULL' });
    ts(t, 'performedAt');
    ts(t, 'expiresAt');
    stamps(t);
    t.index(['caseId', 'checkType']);
    t.index(['targetType', 'targetId']);
  });

  await table('PartnerAgreement', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.text('agreementType').notNullable();
    t.text('version').notNullable();
    t.text('status').notNullable().defaultTo('accepted');
    ref(t, 'acceptedBy', 'User', { onDelete: 'SET NULL' });
    ts(t, 'acceptedAt').notNullable();
    t.text('acceptedIp');
    t.text('acceptedUserAgent');
    ref(t, 'signedDocumentId', 'PartnerDocument', { onDelete: 'SET NULL' });
    ts(t, 'effectiveFrom');
    ts(t, 'expiresAt');
    ts(t, 'revokedAt');
    stamps(t);
    t.unique(['caseId', 'agreementType', 'version']);
  });

  await table('PartnerKycEvent', (t) => {
    t.text('id').primary();
    caseRef(t);
    t.integer('round').notNullable();
    t.text('eventType').notNullable();
    t.text('fromStatus');
    t.text('toStatus');
    t.text('targetType');
    t.text('targetId');
    ref(t, 'actorId', 'User', { onDelete: 'SET NULL' });
    t.text('actorRole');                        // partner | admin | system
    t.text('reasonCode');
    t.text('note');
    t.jsonb('data').notNullable().defaultTo('{}'); // masked values only
    ts(t, 'at').notNullable().defaultTo(knex.fn.now());
    t.index(['caseId', 'at']);
  });

  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;
  const checks = [
    ['PartnerKycCase', 'partner_kyc_case_type_chk', inList('partnerType', PARTNER_TYPES)],
    ['PartnerKycCase', 'partner_kyc_case_status_chk', inList('status', CASE_STATUSES)],
    ['PartnerKycCase', 'partner_kyc_case_entity_chk', `"entityType" IS NULL OR ${inList('entityType', ENTITY_TYPES)}`],
    ['PartnerKycCase', 'partner_kyc_case_tier_chk', `"tier" IN (0, 2, 3)`],
    ['PartnerKycCase', 'partner_kyc_case_round_chk', `"round" >= 1`],
    ['PartnerKycCase', 'partner_kyc_case_incorporated_chk', `"incorporatedOn" IS NULL OR "incorporatedOn" ~ ${DAY}`],
    // A corporate partner is a CorporateAccount; every other partner is a User.
    ['PartnerKycCase', 'partner_kyc_case_subject_chk',
      `("partnerType" = 'corporate' AND "corporateId" IS NOT NULL AND "userId" IS NULL)
       OR ("partnerType" <> 'corporate' AND "userId" IS NOT NULL AND "corporateId" IS NULL)`],
    // Rejections, info requests and suspensions must say why.
    ['PartnerKycCase', 'partner_kyc_case_reason_chk',
      `"status" NOT IN ('rejected', 'info_requested', 'suspended') OR "reasonCode" IS NOT NULL`],
    ['PartnerPerson', 'partner_person_role_chk', inList('role', PERSON_ROLES)],
    ['PartnerPerson', 'partner_person_id_type_chk', `"idType" IS NULL OR ${inList('idType', ID_TYPES)}`],
    ['PartnerPerson', 'partner_person_status_chk', inList('status', PERSON_STATUSES)],
    ['PartnerPerson', 'partner_person_ownership_chk', `"ownershipPct" IS NULL OR ("ownershipPct" > 0 AND "ownershipPct" <= 100)`],
    ['PartnerPerson', 'partner_person_beneficial_owner_chk', `"role" <> 'beneficial_owner' OR "ownershipPct" IS NOT NULL`],
    ['PartnerPerson', 'partner_person_dates_chk',
      `("dateOfBirth" IS NULL OR "dateOfBirth" ~ ${DAY}) AND ("idExpiresOn" IS NULL OR "idExpiresOn" ~ ${DAY})`],
    ['PartnerSettlementAccount', 'partner_settlement_method_chk', inList('method', SETTLEMENT_METHODS)],
    ['PartnerSettlementAccount', 'partner_settlement_status_chk', inList('status', SETTLEMENT_STATUSES)],
    // Only a verified account can be the one payouts go to.
    ['PartnerSettlementAccount', 'partner_settlement_primary_chk', `NOT "isPrimary" OR "status" = 'verified'`],
    ['PartnerSettlementAccount', 'partner_settlement_number_chk', `"accountNumber" IS NOT NULL AND "accountNumber" <> ''`],
    ['PartnerDocument', 'partner_document_status_chk', inList('status', DOCUMENT_STATUSES)],
    ['PartnerDocument', 'partner_document_mime_chk', inList('mimeType', DOCUMENT_MIME_TYPES)],
    ['PartnerDocument', 'partner_document_size_chk', `"sizeBytes" > 0 AND "sizeBytes" <= ${10 * 1024 * 1024}`],
    ['PartnerDocument', 'partner_document_dates_chk',
      `("issuedOn" IS NULL OR "issuedOn" ~ ${DAY}) AND ("expiresOn" IS NULL OR "expiresOn" ~ ${DAY})`],
    ['PartnerCheck', 'partner_check_type_chk', inList('checkType', CHECK_TYPES)],
    ['PartnerCheck', 'partner_check_target_chk', inList('targetType', CHECK_TARGETS)],
    ['PartnerCheck', 'partner_check_target_id_chk', `("targetType" = 'case') = ("targetId" IS NULL)`],
    ['PartnerCheck', 'partner_check_method_chk', inList('method', CHECK_METHODS)],
    // A registry lookup names the registry it asked.
    ['PartnerCheck', 'partner_check_provider_chk', `"method" <> 'provider' OR ("provider" IS NOT NULL AND ${inList('provider', CHECK_PROVIDERS)})`],
    ['PartnerCheck', 'partner_check_result_chk', inList('result', CHECK_RESULTS)],
    // A finished check records who did it and when.
    ['PartnerCheck', 'partner_check_performed_chk', `"result" = 'pending' OR "performedAt" IS NOT NULL`],
    ['PartnerAgreement', 'partner_agreement_type_chk', inList('agreementType', AGREEMENT_TYPES)],
    ['PartnerAgreement', 'partner_agreement_status_chk', inList('status', AGREEMENT_STATUSES)],
    ['PartnerKycEvent', 'partner_kyc_event_type_chk', inList('eventType', EVENT_TYPES)],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw(`ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??`, [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }

  // One case per partner, and at most one payout account per partner.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS partner_kyc_case_user_uq
    ON "PartnerKycCase" ("partnerType", "userId") WHERE "userId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS partner_kyc_case_corporate_uq
    ON "PartnerKycCase" ("corporateId") WHERE "corporateId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS partner_settlement_primary_uq
    ON "PartnerSettlementAccount" ("caseId") WHERE "isPrimary"`);

  // The timeline is append-only: rows can be added, and removed with their
  // case, but never rewritten.
  await knex.raw(`CREATE OR REPLACE FUNCTION partner_kyc_event_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'PartnerKycEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS partner_kyc_event_no_update ON "PartnerKycEvent"`);
  await knex.raw(`CREATE TRIGGER partner_kyc_event_no_update
    BEFORE UPDATE ON "PartnerKycEvent"
    FOR EACH ROW EXECUTE FUNCTION partner_kyc_event_immutable()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS partner_kyc_event_no_update ON "PartnerKycEvent"`);
  await knex.raw('DROP FUNCTION IF EXISTS partner_kyc_event_immutable()');
  for (const name of [
    'PartnerKycEvent', 'PartnerAgreement', 'PartnerCheck', 'PartnerDocument',
    'PartnerSettlementAccount', 'PartnerPerson', 'PartnerKycCase',
  ]) {
    await knex.schema.dropTableIfExists(name);
  }
};
