// Partner KYC requirements — the few fields the per-partner requirements need
// that neither the KYC tables nor the existing records hold yet.
//
// - PartnerPerson: postal address, relationship to the business (gym owner's
//   principal) and signing authority (vendor / company representative).
// - PartnerKycCase: business activity (corporate KYB).
// - PartnerDocument: issuer (certification body, insurer, licensing
//   authority) and type-specific details. A document's details can now be
//   recorded before its file is uploaded: the storage columns are optional,
//   but set all together or not at all.
// - CorporateAccount: billing contact, next to the existing HR contact.
// - Agreements gain 'corporate_contract'; events gain 'profile_updated' and
//   'document_updated'.
// - The append-only timeline lets exactly one change through: clearing the
//   actor when that user is deleted (the foreign key's ON DELETE SET NULL).
//   Before this, deleting any user who had acted on a case failed.
//
// Everything else the requirements need already exists: gym profile, rate
// card, location and tier on Gym; trainer specialisation on TrainerProfile;
// vendor contact, categories and delivery (and now returns) in
// User.vendorProfile; seats, pass tier, subsidy and billing cycle on
// CorporateAccount.

const RELATIONSHIPS = ['owner', 'co_owner', 'director', 'manager', 'employee', 'other'];
const AUTHORITIES = ['sole_signatory', 'joint_signatory', 'delegated'];
const AGREEMENT_TYPES = ['platform_terms', 'partner_agreement', 'commission_schedule', 'data_processing', 'kyc_consent',
  'corporate_contract'];
const EVENT_TYPES = ['status_changed', 'document_uploaded', 'document_reviewed', 'person_updated', 'check_recorded',
  'settlement_account_changed', 'agreement_accepted', 'reviewer_assigned', 'note', 'profile_updated', 'document_updated'];
const PREVIOUS_AGREEMENT_TYPES = AGREEMENT_TYPES.filter(t => t !== 'corporate_contract');
const PREVIOUS_EVENT_TYPES = EVENT_TYPES.filter(t => t !== 'profile_updated' && t !== 'document_updated');
const STORAGE_COLUMNS = ['storageProvider', 'storageKey', 'mimeType', 'sizeBytes', 'sha256'];

const IMMUTABLE_WITH_ACTOR_CLEAR = `
  BEGIN
    IF OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
       AND (to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PartnerKycEvent rows are append-only' USING ERRCODE = 'P0001';
  END;`;
const IMMUTABLE = `
  BEGIN
    RAISE EXCEPTION 'PartnerKycEvent rows are append-only' USING ERRCODE = 'P0001';
  END;`;
const setTimelineTrigger = (knex, body) => knex.raw(
  `CREATE OR REPLACE FUNCTION partner_kyc_event_immutable() RETURNS trigger AS $$${body}$$ LANGUAGE plpgsql`);

const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;

async function setCheck(knex, table, name, expr) {
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, name]);
  if (expr) await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [table, name]);
}

async function addColumns(knex, table, columns) {
  for (const [name, add] of Object.entries(columns)) {
    if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, add);
  }
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await addColumns(knex, 'PartnerPerson', {
    address: t => t.jsonb('address'),
    relationship: t => t.text('relationship'),
    authority: t => t.text('authority'),
  });
  await addColumns(knex, 'PartnerKycCase', {
    businessActivity: t => t.text('businessActivity'),
  });
  await addColumns(knex, 'PartnerDocument', {
    issuer: t => t.text('issuer'),
    details: t => t.jsonb('details').notNullable().defaultTo('{}'),
  });
  await addColumns(knex, 'CorporateAccount', {
    billingContactName: t => t.text('billingContactName'),
    billingContactPhone: t => t.text('billingContactPhone'),
    billingContactEmail: t => t.text('billingContactEmail'),
  });

  for (const col of STORAGE_COLUMNS) {
    await knex.raw('ALTER TABLE "PartnerDocument" ALTER COLUMN ?? DROP NOT NULL', [col]);
  }
  const allNull = STORAGE_COLUMNS.map(c => `"${c}" IS NULL`).join(' AND ');
  const allSet = STORAGE_COLUMNS.map(c => `"${c}" IS NOT NULL`).join(' AND ');
  await setCheck(knex, 'PartnerDocument', 'partner_document_file_chk', `(${allNull}) OR (${allSet})`);
  // Only a document with its file can be accepted.
  await setCheck(knex, 'PartnerDocument', 'partner_document_accept_chk', `"status" <> 'accepted' OR "storageKey" IS NOT NULL`);

  await setCheck(knex, 'PartnerPerson', 'partner_person_relationship_chk', `"relationship" IS NULL OR ${inList('relationship', RELATIONSHIPS)}`);
  await setCheck(knex, 'PartnerPerson', 'partner_person_authority_chk', `"authority" IS NULL OR ${inList('authority', AUTHORITIES)}`);
  await setCheck(knex, 'PartnerAgreement', 'partner_agreement_type_chk', inList('agreementType', AGREEMENT_TYPES));
  await setCheck(knex, 'PartnerKycEvent', 'partner_kyc_event_type_chk', inList('eventType', EVENT_TYPES));
  await setTimelineTrigger(knex, IMMUTABLE_WITH_ACTOR_CLEAR);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await setTimelineTrigger(knex, IMMUTABLE);
  // Rows of the new types can't exist under the old checks.
  await knex('PartnerKycEvent').whereIn('eventType', ['profile_updated', 'document_updated']).del();
  await knex('PartnerAgreement').where('agreementType', 'corporate_contract').del();
  await setCheck(knex, 'PartnerKycEvent', 'partner_kyc_event_type_chk', inList('eventType', PREVIOUS_EVENT_TYPES));
  await setCheck(knex, 'PartnerAgreement', 'partner_agreement_type_chk', inList('agreementType', PREVIOUS_AGREEMENT_TYPES));
  await setCheck(knex, 'PartnerPerson', 'partner_person_authority_chk', null);
  await setCheck(knex, 'PartnerPerson', 'partner_person_relationship_chk', null);
  await setCheck(knex, 'PartnerDocument', 'partner_document_accept_chk', null);
  await setCheck(knex, 'PartnerDocument', 'partner_document_file_chk', null);
  // Documents recorded without a file can't survive the old NOT NULL columns.
  await knex('PartnerDocument').whereNull('storageKey').del();
  for (const col of STORAGE_COLUMNS) {
    await knex.raw('ALTER TABLE "PartnerDocument" ALTER COLUMN ?? SET NOT NULL', [col]);
  }
  const drop = async (table, cols) => {
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) await knex.schema.alterTable(table, t => t.dropColumn(col));
    }
  };
  await drop('CorporateAccount', ['billingContactEmail', 'billingContactPhone', 'billingContactName']);
  await drop('PartnerDocument', ['details', 'issuer']);
  await drop('PartnerKycCase', ['businessActivity']);
  await drop('PartnerPerson', ['authority', 'relationship', 'address']);
};
