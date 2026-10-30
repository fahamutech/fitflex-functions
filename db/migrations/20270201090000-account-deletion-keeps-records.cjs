// Account deletion (owner decision 2026-10-30): payment and check-in records are kept, anonymised.
//
// 1. These five tables hold financial and access records and pointed at "User" with ON DELETE CASCADE,
//    so removing the account row silently destroyed them (and changed statements if a period was
//    recalculated). The foreign key goes; "memberId" stays as a plain, non-identifying reference to an
//    account that no longer exists. Every other table keeps its foreign key.
// 2. IdentityEvent and AccountRecoveryEvent are append-only and IdentityEvent stores a raw phone or email.
//    Their triggers now allow one change only: clearing that personal value (same idea as
//    PartnerKycEvent.actorId and RewardLedgerEntry.userId). Deleting a row stays refused.
//
// Reversible: down restores the triggers and re-adds the foreign keys as NOT VALID, so rows left by
// deletions that already happened do not stop the rollback. Those orphans stay; with the old cascade
// rule back, they are not cleaned up.
const KEPT = ['Subscription', 'PaymentRequest', 'Checkin', 'TrainerBooking', 'Refund'];

exports.up = async function up(knex) {
  for (const table of KEPT) {
    // By lookup, not by name: older databases may carry other constraint names.
    const { rows } = await knex.raw(`
      SELECT c.conname FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.conrelid = ?::regclass AND c.confrelid = '"User"'::regclass AND a.attname = 'memberId'`,
    [`"${table}"`]);
    for (const { conname } of rows) await knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [table, conname]);
  }

  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW."normalizedValue" IS NULL AND NEW.details IS NULL
         AND (to_jsonb(NEW) - 'normalizedValue' - 'details') = (to_jsonb(OLD) - 'normalizedValue' - 'details') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'IdentityEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE OR REPLACE FUNCTION account_recovery_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.detail IS NULL AND (to_jsonb(NEW) - 'detail') = (to_jsonb(OLD) - 'detail') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'AccountRecoveryEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
    $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'IdentityEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE OR REPLACE FUNCTION account_recovery_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'AccountRecoveryEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
    $$;
  `);
  for (const table of KEPT) {
    const rule = table === 'Refund' ? 'ON DELETE CASCADE' : 'ON UPDATE CASCADE ON DELETE CASCADE';
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? FOREIGN KEY ("memberId") REFERENCES "User"(id) ${rule} NOT VALID`,
      [table, `${table.toLowerCase()}_memberid_foreign`]);
  }
};
