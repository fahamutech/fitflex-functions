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
