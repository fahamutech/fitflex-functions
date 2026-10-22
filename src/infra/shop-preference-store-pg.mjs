// Postgres store for the "Personalised shop" switch (ShopPreference) and its AuditLog rows.
// A change and its audit row are written in one transaction, under a row lock, so two saves of the
// same person cannot both record "before" as the same value.
import { randomUUID } from 'node:crypto';

const fromDb = r => (r ? {
  personId: r.personId, subjectType: r.subjectType, personalised: Boolean(r.personalised), source: r.source ?? null,
  updatedBy: r.updatedBy ?? null, updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt ?? null,
} : null);

export function createPgShopPreferenceStore({ db }) {
  return {
    async get(personId) {
      return fromDb(await db('ShopPreference').where({ personId }).first());
    },
    /**
     * Save the switch. → { preference, changed }. No audit row and no write when the value is
     * already the stored one (no row counts as on).
     */
    async save({ personId, subjectType, personalised, source, actorId, at }) {
      return db.transaction(async (trx) => {
        // Serialise saves of one person, also when no row exists yet.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`shop_preference:${personId}`]);
        const prior = fromDb(await trx('ShopPreference').where({ personId }).first());
        const before = prior ? prior.personalised : true;
        if (before === personalised) return { preference: prior, changed: false };
        const row = { personId, subjectType, personalised, source, updatedBy: actorId, updatedAt: at };
        if (prior) await trx('ShopPreference').where({ personId }).update(row);
        else await trx('ShopPreference').insert({ ...row, createdAt: at });
        await trx('AuditLog').insert({
          id: randomUUID(), at, actor: actorId, action: 'shop_preference_changed', target: personId,
          before: JSON.stringify({ personalised: before }), after: JSON.stringify({ personalised, source }),
        });
        return { preference: fromDb(await trx('ShopPreference').where({ personId }).first()), changed: true };
      });
    },
  };
}

/**
 * Identity link / merge (identity-link-service): personas moved from `fromPersonId` to `toPersonId`.
 * The switch follows them, and an opt-out on either side wins (the merged person stays opted out).
 * When the old Person becomes a tombstone (`removeFrom`), its row is deleted. Runs inside the link
 * transaction; does nothing when the table does not exist yet (code deployed before the migration).
 * Each change of the target's value is audited (source 'identity_link').
 */
export async function carryShopPreference(trx, { fromPersonId, toPersonId, removeFrom = false, actorId = null }) {
  if (!fromPersonId || !toPersonId || fromPersonId === toPersonId) return { changed: false };
  const exists = await trx.raw('SELECT to_regclass(\'"ShopPreference"\') AS t');
  if (!exists.rows?.[0]?.t) return { changed: false };
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`shop_preference:${toPersonId}`]);
  const from = await trx('ShopPreference').where({ personId: fromPersonId }).first();
  const to = await trx('ShopPreference').where({ personId: toPersonId }).first();
  let changed = false;
  if (from && from.personalised === false && (!to || to.personalised !== false)) {
    const at = new Date().toISOString();
    const row = { personalised: false, source: 'identity_link', updatedBy: actorId, updatedAt: at };
    if (to) await trx('ShopPreference').where({ personId: toPersonId }).update(row);
    else await trx('ShopPreference').insert({ personId: toPersonId, subjectType: 'person', createdAt: at, ...row });
    await trx('AuditLog').insert({
      id: randomUUID(), at, actor: actorId || 'system', action: 'shop_preference_changed', target: toPersonId,
      before: JSON.stringify({ personalised: to ? Boolean(to.personalised) : true }),
      after: JSON.stringify({ personalised: false, source: 'identity_link', fromPersonId }),
    });
    changed = true;
  }
  if (removeFrom && from) await trx('ShopPreference').where({ personId: fromPersonId }).del();
  return { changed };
}

/** Account deleted: drop the switch once its Person (or the account itself) has nothing left. */
export async function forgetShopPreference(db, { userId, personId }) {
  const exists = await db.raw('SELECT to_regclass(\'"ShopPreference"\') AS t');
  if (!exists.rows?.[0]?.t) return;
  if (userId) await db('ShopPreference').where({ personId: userId, subjectType: 'user' }).del();
  if (!personId) return;
  const left = await db('User').where({ personId }).first('id');
  if (!left) await db('ShopPreference').where({ personId }).del();
}

/** In memory (unit specs). `audit` collects the audit rows. */
export function createMemoryShopPreferenceStore() {
  const rows = new Map();
  const audit = [];
  return {
    rows, audit,
    async get(personId) { return rows.get(personId) || null; },
    async save({ personId, subjectType, personalised, source, actorId, at }) {
      const prior = rows.get(personId) || null;
      const before = prior ? prior.personalised : true;
      if (before === personalised) return { preference: prior, changed: false };
      const row = { personId, subjectType, personalised, source, updatedBy: actorId, updatedAt: at };
      rows.set(personId, row);
      audit.push({ id: randomUUID(), at, actor: actorId, action: 'shop_preference_changed', target: personId, before: { personalised: before }, after: { personalised, source } });
      return { preference: row, changed: true };
    },
  };
}
