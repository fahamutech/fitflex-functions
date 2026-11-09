// Marathon & running events · S6 — the OrganizerIdempotency wrapper the S5 ops service carries inline, shared by the S6 services.
// Run `work` once per (caller, key, route): a 2xx answer is stored and replayed (200 + replayed: true); anything else releases
// the key so a corrected request can reuse it. The same key with another body is 409 idempotency_key_reused.
import { randomUUID } from 'node:crypto';
import { fingerprintOf, idempotencyKeyValid } from './events-ops-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row)) : null);

/** actor: { kind: 'staff' | 'admin', userId } | { kind: 'api', clientId }. */
export function createIdempotency({ db, now = () => new Date() }) {
  return async function idempotent({ actor, route, key, body }, work) {
    if (key === undefined || key === null || key === '') return fail('idempotency_key_required', 400);
    if (!idempotencyKeyValid(key)) return fail('invalid_idempotency_key', 400);
    const scopeType = actor.kind === 'api' ? 'api' : 'staff';
    const scopeId = actor.kind === 'api' ? actor.clientId : actor.userId;
    const fingerprint = fingerprintOf(body);
    const at = new Date(now());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = `oid_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const inserted = await db('OrganizerIdempotency').insert({ id, scopeType, scopeId, key, route, fingerprint, state: 'in_progress', createdAt: at, expiresAt: new Date(+at + 7 * 86_400_000) })
        .onConflict(['scopeType', 'scopeId', 'key', 'route']).ignore().returning('id');
      if (inserted.length) {
        let result;
        try { result = await work(); } catch (err) { await db('OrganizerIdempotency').where({ id }).del(); throw err; }
        if (!result || result.error || (Number.isInteger(result.status) && result.status >= 300)) { await db('OrganizerIdempotency').where({ id }).del(); return result; }
        const { status = 200, ...payload } = result;
        await db('OrganizerIdempotency').where({ id }).update({ state: 'done', status, response: JSON.stringify(payload) });
        return result;
      }
      const row = plain(await db('OrganizerIdempotency').where({ scopeType, scopeId, key, route }).first());
      if (!row) continue;
      if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused', 409);
      if (row.state === 'done') return { ...row.response, status: 200, replayed: true };
      if (+at - +new Date(row.createdAt) > 60_000) { await db('OrganizerIdempotency').where({ id: row.id, state: 'in_progress' }).del(); continue; }
      return fail('request_in_progress', 409);
    }
    return fail('request_in_progress', 409);
  };
}
