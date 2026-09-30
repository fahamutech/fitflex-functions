// Identity V2 · I1 — Person + LoginIdentifier foundation.
//
// Adds a permanent Person above the existing User rows. Every User row stays
// exactly as it is (same id, same history); it only gains `personId`, and
// becomes one persona of that Person. Nothing is merged, re-keyed or deleted.
//
//   Person           the FitFlex identity (psn_…)
//   LoginIdentifier  email / phone / firebase_uid, verified or not
//   IdentityConflict evidence that must be reviewed, never auto-merged
//   User.personId    persona → Person (kept stable by the user_person_guard trigger)
//   User.publicId    today's computed FM/FT/FO code, frozen so it can't renumber
//
// Backfill here is offline and deterministic: one Person per Firebase uid
// (rows sharing a uid are one Firebase account), otherwise one per row, with a
// verified firebase_uid identifier. The database cannot prove an email or
// phone is verified, so those are handled by scripts/identity-reconcile.mjs,
// which asks Firebase. Re-running this migration's backfill is a no-op.

const PERSON_STATUSES = ['active', 'suspended', 'closed', 'merged'];
const IDENTIFIER_TYPES = ['email', 'phone', 'firebase_uid'];

const newId = (prefix, knexRandom) => `${prefix}_${knexRandom().replace(/-/g, '').slice(0, 12)}`;

/** Same ordering and prefixes as identity-service publicUserId(). */
function publicCode(userType, index) {
  const prefix = userType === 'trainer' ? 'FT' : userType === 'gym_operator' ? 'FO' : 'FM';
  return `${prefix}${String(index + 1).padStart(3, '0')}`;
}

/** @param {import('knex').Knex} knex */
async function backfill(knex) {
  const { randomUUID } = require('node:crypto');
  const rows = await knex('User')
    .select('id', 'firebaseUid', 'userType', 'createdAt', 'personId', 'publicId')
    .orderBy([{ column: 'createdAt' }, { column: 'id' }]);

  await knex.transaction(async trx => {
    // Existing uid → Person, from identifiers already present (re-runs).
    const uidPerson = new Map(
      (await trx('LoginIdentifier').select('normalizedValue', 'personId')
        .where({ type: 'firebase_uid', status: 'active' }))
        .map(r => [r.normalizedValue, r.personId]),
    );
    for (const row of rows) {
      if (!row.firebaseUid || row.personId || uidPerson.has(row.firebaseUid)) continue;
      const sibling = rows.find(r => r.firebaseUid === row.firebaseUid && r.personId);
      if (sibling) uidPerson.set(row.firebaseUid, sibling.personId);
    }

    for (const row of rows) {
      if (row.personId) continue;
      let personId = row.firebaseUid ? uidPerson.get(row.firebaseUid) : null;
      if (!personId) {
        personId = newId('psn', randomUUID);
        await trx('Person').insert({ id: personId, status: 'active' });
        if (row.firebaseUid) uidPerson.set(row.firebaseUid, personId);
      }
      await trx('User').where({ id: row.id }).whereNull('personId').update({ personId });
      row.personId = personId;
    }

    for (const [uid, personId] of uidPerson) {
      const present = await trx('LoginIdentifier')
        .where({ type: 'firebase_uid', normalizedValue: uid, status: 'active' }).first('id');
      if (present) continue;
      await trx('LoginIdentifier').insert({
        id: newId('lid', randomUUID), personId, type: 'firebase_uid', value: uid,
        normalizedValue: uid, verifiedAt: trx.fn.now(), provider: 'firebase', firebaseUid: uid,
        status: 'active',
      });
    }

    // Freeze today's public codes (identity-service orders by createdAt ISO, then id).
    const byType = new Map();
    for (const row of rows) {
      const type = row.userType || 'member';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(row);
    }
    for (const [type, list] of byType) {
      list.sort((a, b) => String(a.createdAt ? new Date(a.createdAt).toISOString() : a.id)
        .localeCompare(String(b.createdAt ? new Date(b.createdAt).toISOString() : b.id)));
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].publicId) continue;
        await trx('User').where({ id: list[i].id }).whereNull('publicId')
          .update({ publicId: publicCode(type, i) });
      }
    }
  });
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('Person', t => {
    t.text('id').primary();
    t.text('status').notNullable().defaultTo('active');
    t.text('mergedIntoId').references('id').inTable('Person').onDelete('RESTRICT');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "Person"
    ADD CONSTRAINT person_status_check CHECK (status IN (${PERSON_STATUSES.map(s => `'${s}'`).join(', ')})),
    ADD CONSTRAINT person_merge_target_check CHECK ((status = 'merged') = ("mergedIntoId" IS NOT NULL)),
    ADD CONSTRAINT person_not_merged_into_self CHECK ("mergedIntoId" IS DISTINCT FROM id)`);

  await knex.schema.createTable('LoginIdentifier', t => {
    t.text('id').primary();
    t.text('personId').notNullable().references('id').inTable('Person').onDelete('RESTRICT');
    t.text('type').notNullable();
    t.text('value').notNullable();            // as observed
    t.text('normalizedValue').notNullable();  // what uniqueness and lookups use
    t.timestamp('verifiedAt', { useTz: true }); // null = unverified: never links anything
    t.text('provider');                        // who proved it: firebase, google.com, password, phone
    t.text('firebaseUid');                     // Firebase account the identifier was seen on
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['personId']);
    t.index(['type', 'normalizedValue']);
  });
  await knex.raw(`ALTER TABLE "LoginIdentifier"
    ADD CONSTRAINT login_identifier_type_check CHECK (type IN (${IDENTIFIER_TYPES.map(s => `'${s}'`).join(', ')})),
    ADD CONSTRAINT login_identifier_status_check CHECK (status IN ('active', 'revoked')),
    ADD CONSTRAINT login_identifier_uid_verified CHECK (type <> 'firebase_uid' OR "verifiedAt" IS NOT NULL),
    ADD CONSTRAINT login_identifier_email_normalized CHECK (type <> 'email' OR "normalizedValue" = lower(btrim("normalizedValue"))),
    ADD CONSTRAINT login_identifier_phone_e164 CHECK (type <> 'phone' OR "normalizedValue" ~ '^\\+[1-9][0-9]{7,14}$')`);
  // A verified identifier belongs to exactly one live Person.
  await knex.raw(`CREATE UNIQUE INDEX login_identifier_verified_unique
    ON "LoginIdentifier" (type, "normalizedValue")
    WHERE "verifiedAt" IS NOT NULL AND status = 'active'`);
  await knex.raw(`CREATE UNIQUE INDEX login_identifier_person_value_unique
    ON "LoginIdentifier" ("personId", type, "normalizedValue")
    WHERE status = 'active'`);

  await knex.schema.createTable('IdentityConflict', t => {
    t.text('id').primary();
    t.text('kind').notNullable();              // e.g. verified_identifier_collision, firebase_uid_split
    t.text('identifierType');
    t.text('normalizedValue');
    t.specificType('personIds', 'text[]').notNullable().defaultTo('{}');
    t.specificType('userIds', 'text[]').notNullable().defaultTo('{}');
    t.jsonb('details');
    t.text('status').notNullable().defaultTo('open');
    t.text('resolvedBy');
    t.timestamp('resolvedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['status']);
  });
  await knex.raw(`ALTER TABLE "IdentityConflict"
    ADD CONSTRAINT identity_conflict_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))`);
  await knex.raw(`CREATE UNIQUE INDEX identity_conflict_open_unique
    ON "IdentityConflict" (kind, "identifierType", "normalizedValue") WHERE status = 'open'`);

  await knex.schema.alterTable('User', t => {
    t.text('personId').references('id').inTable('Person').onDelete('RESTRICT');
    t.text('publicId');
    t.index(['personId']);
  });
  await knex.raw(`CREATE UNIQUE INDEX user_public_id_unique
    ON "User" ("userType", "publicId") WHERE "publicId" IS NOT NULL`);

  // Every User row gets a Person, whichever code path inserts it, and an
  // ordinary write can never clear or move User.personId. Relinking (I2)
  // must opt in with: SET LOCAL fitflex.identity_relink = 'on'.
  // BEFORE INSERT also fires for INSERT … ON CONFLICT DO UPDATE (the store's
  // upsert), so an existing row is left alone rather than given a new Person.
  // IDs use md5(random()) rather than gen_random_uuid(), which needs PG 13+.
  await knex.raw(`CREATE OR REPLACE FUNCTION user_person_guard() RETURNS trigger AS $$
    DECLARE
      existing_person text;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."personId" IS NOT NULL OR EXISTS (SELECT 1 FROM "User" WHERE id = NEW.id) THEN
          RETURN NEW;
        END IF;
        IF NEW."firebaseUid" IS NOT NULL THEN
          SELECT "personId" INTO existing_person FROM "LoginIdentifier"
            WHERE type = 'firebase_uid' AND "normalizedValue" = NEW."firebaseUid" AND status = 'active'
            LIMIT 1;
        END IF;
        IF existing_person IS NULL THEN
          existing_person := 'psn_' || substr(md5(random()::text || clock_timestamp()::text || NEW.id), 1, 12);
          INSERT INTO "Person" (id, status) VALUES (existing_person, 'active');
          IF NEW."firebaseUid" IS NOT NULL THEN
            INSERT INTO "LoginIdentifier"
              (id, "personId", type, value, "normalizedValue", "verifiedAt", provider, "firebaseUid", status)
            VALUES ('lid_' || substr(md5(random()::text || clock_timestamp()::text || NEW.id), 1, 12), existing_person,
              'firebase_uid', NEW."firebaseUid", NEW."firebaseUid", now(), 'firebase', NEW."firebaseUid", 'active');
          END IF;
        END IF;
        NEW."personId" := existing_person;
        RETURN NEW;
      END IF;
      -- UPDATE
      IF OLD."personId" IS NOT NULL AND NEW."personId" IS DISTINCT FROM OLD."personId" THEN
        IF NEW."personId" IS NULL THEN
          NEW."personId" := OLD."personId";
        ELSIF coalesce(current_setting('fitflex.identity_relink', true), '') <> 'on' THEN
          RAISE EXCEPTION 'User.personId is managed by identity linking' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS user_person_guard ON "User"');
  await knex.raw(`CREATE TRIGGER user_person_guard
    BEFORE INSERT OR UPDATE ON "User"
    FOR EACH ROW EXECUTE FUNCTION user_person_guard()`);

  await backfill(knex);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  // Nothing outside these objects reads them in I1, and no pre-existing
  // column or row was changed, so dropping them restores the prior schema.
  await knex.raw('DROP TRIGGER IF EXISTS user_person_guard ON "User"');
  await knex.raw('DROP FUNCTION IF EXISTS user_person_guard()');
  await knex.raw('DROP INDEX IF EXISTS user_public_id_unique');
  await knex.schema.alterTable('User', t => {
    t.dropIndex(['personId']);
    t.dropForeign(['personId']);
    t.dropColumn('personId');
    t.dropColumn('publicId');
  });
  await knex.schema.dropTableIfExists('IdentityConflict');
  await knex.schema.dropTableIfExists('LoginIdentifier');
  await knex.schema.dropTableIfExists('Person');
};

exports.backfill = backfill;
