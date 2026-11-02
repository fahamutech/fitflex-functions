// Admin-portal audit S2/S3 (slice B): audit viewer, append-only AuditLog, required reasons (ADMIN_REASONS_REQUIRED).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { users, subscriptions, platformSettings, auditLog as auditCollection } from '../src/bootstrap/services.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { createAuditLogService, AUDIT_PAGE_MAX } from '../src/services/audit-log-service.mjs';
import { redactAuditForDisplay, isSecretLookingKey } from '../src/shared/audit-redact.mjs';
import { readFileSync } from 'node:fs';
import { createAdminMemberService } from '../src/services/admin-member-service.mjs';
import { createAdminOwnerService } from '../src/services/admin-owner-service.mjs';
import { createSettingsService } from '../src/services/settings-service.mjs';
import { adminListAuditLog } from '../functions/admin-audit-log.mjs';
import { adminDeleteGymOwner } from '../functions/admin-owners.mjs';
import { adminSetMemberStatus } from '../functions/admin-members.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { memoryPlatformSettings, TEST_TIERS } from './fixtures/tier-settings.mjs';

const run = randomUUID().slice(0, 8);
const ACTOR = `spec_audit_${run}`;
const ids = [];
const staffId = `usr_auditspec_${run}`;
after(async () => {
  delete process.env.ADMIN_REASONS_REQUIRED;
  await db('AuditLog').whereIn('id', ids).del();   // test bypass (CI database only)
  await db('User').where({ id: staffId }).del();
});

async function put(over = {}) {
  const id = `${run}-${String(ids.length).padStart(3, '0')}`;
  ids.push(id);
  await db('AuditLog').insert({
    id, at: new Date(Date.UTC(2031, 0, 1, 0, 0, ids.length)), actor: ACTOR, action: 'spec_a', target: `t_${run}`,
    before: null, after: null, ...over,
  });
  return id;
}

// ── append-only trigger ──────────────────────────────────────────────────────
// The pooled connections carry the CI test bypass; each check switches it off for its own transaction.
const strict = async fn => { const trx = await db.transaction(); try { await trx.raw(`SET LOCAL fitflex.audit_test_bypass = 'off'`); return await fn(trx); } finally { await trx.rollback(); } };
const refused = async (fn, re = /append-only/) => strict(async trx => { await assert.rejects(async () => { await fn(trx); }, re); });

test('migration: trigger refuses UPDATE, DELETE and TRUNCATE on AuditLog', async () => {
  const id = await put();
  const { rows: [{ db: name }] } = await db.raw('select current_database() as db');
  assert.match(name, /_ci/, 'runs on a CI database only');
  await refused(t => t.raw(`UPDATE "AuditLog" SET action = 'x' WHERE id = ?`, [id]));
  await refused(t => t.raw(`UPDATE "AuditLog" SET before = '{}'::jsonb WHERE id = ?`, [id]));
  await refused(t => t.raw(`DELETE FROM "AuditLog" WHERE id = ?`, [id]));
  await refused(t => t.raw(`TRUNCATE "AuditLog"`));
  assert.ok(await db('AuditLog').where({ id }).first(), 'row survives');
});

test('migration: INSERT works and reason is stored; scrub switch allows before/after changes only', async () => {
  const id = await put({ reason: 'because', before: { email: 'a@x.test', phone: '1' } });
  assert.equal((await db('AuditLog').where({ id }).first()).reason, 'because');
  await strict(async trx => {
    await trx.raw(`SELECT set_config('fitflex.audit_scrub', 'on', true)`);
    await trx.raw(`UPDATE "AuditLog" SET before = before - 'phone' WHERE id = ?`, [id]);
    assert.deepEqual((await trx('AuditLog').where({ id }).first()).before, { email: 'a@x.test' });
    await assert.rejects(trx.raw(`UPDATE "AuditLog" SET action = 'tampered' WHERE id = ?`, [id]), /append-only/);
  });
});

// ── viewer ───────────────────────────────────────────────────────────────────
const viewer = createAuditLogService({ db });

test('viewer: redacts credentials and cuts whole user rows down before returning', async () => {
  const id = await put({
    action: 'spec_redact',
    before: { passwordHash: 'scrypt:SECRET1', nested: { pinHash: 'SECRET2', ok: 1 } },
    after: { id: 'u1', userType: 'member', email: 'm@x.test', firebaseUid: 'FBUID', memberProfile: { dateOfBirth: '1990-05-01', gender: 'female' } },
  });
  const { items } = await viewer.list({ actor: ACTOR, action: 'spec_redact' });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  const text = JSON.stringify(items[0]);
  for (const leak of ['SECRET1', 'SECRET2', 'FBUID', '1990-05-01', 'female']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  assert.equal(items[0].before.nested.ok, 1);
  assert.equal(items[0].after.email, 'm@x.test');
  assert.deepEqual(Object.keys(items[0]).sort(), ['action', 'actor', 'after', 'at', 'before', 'id', 'reason', 'target']);
});

test('viewer: filters by actor, action, target and date range', async () => {
  const other = `${ACTOR}_o`;
  const a = await put({ action: 'spec_f1', target: `x_${run}`, at: new Date('2031-02-01T00:00:00Z') });
  await put({ action: 'spec_f2', actor: other, at: new Date('2031-02-02T00:00:00Z') });
  assert.deepEqual((await viewer.list({ actor: ACTOR, action: 'spec_f1' })).items.map(i => i.id), [a]);
  assert.deepEqual((await viewer.list({ target: `x_${run}` })).items.map(i => i.id), [a]);
  assert.equal((await viewer.list({ actor: other })).items.length, 1);
  assert.equal((await viewer.list({ actor: other, from: '2031-02-01T12:00:00Z', to: '2031-02-03T00:00:00Z' })).items.length, 1);
  assert.equal((await viewer.list({ actor: ACTOR, action: 'spec_f1', from: '2031-02-01T12:00:00Z' })).items.length, 0);
  assert.equal((await viewer.list({ from: 'nonsense' })).error, 'invalid_filter');
  assert.equal((await viewer.list({ cursor: '!!' })).error, 'invalid_filter');
  await db('AuditLog').where({ actor: other }).del();
});

test('viewer: keyset pagination walks every row once, newest first, even with equal timestamps; limit capped at 200', async () => {
  const actor = `${ACTOR}_pg`;
  const same = new Date('2032-03-03T03:03:03.000Z');
  const made = [];
  for (let i = 0; i < 7; i++) made.push(await put({ actor, action: 'spec_pg', at: i < 4 ? same : new Date(+same + i * 1000) }));
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await viewer.list({ actor, limit: 3, cursor });
    assert.ok(page.items.length <= 3);
    seen.push(...page.items.map(i => i.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual([...seen].sort(), [...made].sort());
  const times = (await viewer.list({ actor, limit: 10 })).items.map(i => i.at);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal((await viewer.list({ actor, limit: 10 })).nextCursor, null);
  // cap
  assert.equal(AUDIT_PAGE_MAX, 200);
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: `${run}-cap-${i}`, at: new Date(Date.UTC(2033, 0, 1, 0, 0, i)), actor: `${actor}_cap`, action: 'spec_cap', target: 't' }));
  await db.batchInsert('AuditLog', rows, 100);
  ids.push(...rows.map(r => r.id));
  const big = await viewer.list({ actor: `${actor}_cap`, limit: 5000 });
  assert.equal(big.items.length, 200);
  assert.ok(big.nextCursor);
});

// ── route + scope ────────────────────────────────────────────────────────────
async function guardPasses(ep, token) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { method: String(ep.method).toUpperCase(), headers: { authorization: `Bearer ${token}` }, params: {}, query: {}, body: {} };
  for (const g of [ep.onGuard].flat()) {
    let ok = false;
    await g(req, res, () => { ok = true; });
    if (!ok) return { passed: false, status: res.statusCode, body: res.body };
  }
  return { passed: true };
}

test('route: GET /admin/audit-log needs scope `audit`; the scope is grantable', async () => {
  assert.ok(PORTAL_ACL_SCOPES.includes('audit'));
  assert.equal(adminListAuditLog.path, '/admin/audit-log');
  await users.upsertAsync(u => u.id === staffId, {
    id: staffId, userType: 'admin', email: `${staffId}@example.com`, displayName: staffId, accountStatus: 'active',
    approvalStatus: 'approved', onboardingCompleted: true, portalUser: true, aclPermissions: [], createdAt: new Date().toISOString(),
  });
  const none = await guardPasses(adminListAuditLog, sign({ sub: staffId, userType: 'admin', portalUser: true, aclPermissions: ['gyms', 'settings'] }));
  assert.equal(none.passed, false);
  assert.equal(none.status, 403);
  assert.equal(none.body.error, 'acl_forbidden');
  assert.equal(none.body.requiredScope, 'audit');
  assert.equal((await guardPasses(adminListAuditLog, sign({ sub: staffId, userType: 'admin', portalUser: true, aclPermissions: ['audit'] }))).passed, true);
  assert.equal((await guardPasses(adminListAuditLog, sign({ sub: staffId, userType: 'admin' }))).passed, true, 'super-admin');
  // The handler itself, with a stubbed response.
  let body;
  await adminListAuditLog.onRequest({ query: { actor: ACTOR, limit: '2' } }, { json: b => { body = b; } });
  assert.ok(Array.isArray(body.items) && 'nextCursor' in body);
  let bad;
  await adminListAuditLog.onRequest({ query: { from: 'zzz' } }, { status(c) { bad = { c }; return this; }, json(b) { bad.b = b; } });
  assert.equal(bad.c, 400);
});

// ── reasons ──────────────────────────────────────────────────────────────────
function store(rows = []) {
  return {
    rows,
    async findAsync(p) { return rows.find(p) || null; },
    async filterAsync(p) { return rows.filter(p); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v); },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); rows[i] = { ...rows[i], ...patch }; return rows[i]; },
    async removeAsync(p) { const i = rows.findIndex(p); return i >= 0 ? rows.splice(i, 1)[0] : null; },
  };
}
const sink = ({ fail = false } = {}) => { const entries = []; return { entries, insertAsync: async e => { if (fail) throw new Error('audit down'); entries.push(e); return e; } }; };
const member = () => ({ id: 'usr_m1', userType: 'member', email: 'm@x.test', accountStatus: 'active' });
const memberSvc = auditLog => {
  const users = store([member()]);
  return { users, svc: createAdminMemberService({ users, subscriptions: store(), paymentRequests: store(), checkins: store(), gyms: [], auditLog, issueQr: () => 'qr' }) };
};

test('reasons OFF: optional, stored when given', async () => {
  delete process.env.ADMIN_REASONS_REQUIRED;
  const a = sink();
  const { svc } = memberSvc(a);
  assert.equal((await svc.setStatus({ memberId: 'usr_m1', status: 'suspended', actorId: 'a' })).error, undefined);
  assert.equal(a.entries[0].reason, null);
  assert.equal((await svc.setStatus({ memberId: 'usr_m1', status: 'active', actorId: 'a', reason: '  fixed  ' })).error, undefined);
  assert.equal(a.entries[1].reason, 'fixed');
});

test('reasons ON: suspending a member needs a reason; activating does not', async () => {
  process.env.ADMIN_REASONS_REQUIRED = 'on';
  try {
    const a = sink();
    const { svc, users } = memberSvc(a);
    for (const r of [undefined, '', '   ', 42]) {
      assert.deepEqual(await svc.setStatus({ memberId: 'usr_m1', status: 'suspended', actorId: 'a', reason: r }), { error: 'reason_required', status: 400 });
    }
    assert.equal(users.rows[0].accountStatus, 'active');
    assert.equal(a.entries.length, 0);
    assert.equal((await svc.setStatus({ memberId: 'usr_m1', status: 'suspended', actorId: 'a', reason: 'chargeback' })).error, undefined);
    assert.equal(a.entries[0].reason, 'chargeback');
    assert.equal((await svc.setStatus({ memberId: 'usr_m1', status: 'active', actorId: 'a' })).error, undefined);
  } finally { delete process.env.ADMIN_REASONS_REQUIRED; }
});

test('reasons ON: deleting a gym owner needs a reason (400), nothing deleted without it', async () => {
  process.env.ADMIN_REASONS_REQUIRED = 'on';
  try {
    const a = sink();
    const users = store([{ id: 'usr_o1', userType: 'gym_operator', gymId: null, gymIds: [] }]);
    const svc = createAdminOwnerService({ users, gyms: [], checkins: store(), auditLog: a, gymService: { slimGymRef: g => g } });
    assert.deepEqual(await svc.remove({ id: 'usr_o1', actorId: 'a' }), { error: 'reason_required', status: 400 });
    assert.equal(users.rows.length, 1);
    assert.equal((await svc.remove({ id: 'usr_o1', actorId: 'a', reason: 'duplicate account' })).error, undefined);
    assert.equal(users.rows.length, 0);
    assert.equal(a.entries[0].reason, 'duplicate account');
  } finally { delete process.env.ADMIN_REASONS_REQUIRED; }
});

function settings(auditLog) {
  const platformSettings = memoryPlatformSettings(TEST_TIERS);
  return { platformSettings, s: createSettingsService({ platformSettings, auditLog, tierHolders: async () => 0 }) };
}

test('reasons: pricing/payment settings need a reason when ON, cosmetic ones do not; OFF stores it when given', async () => {
  const a = sink();
  const { s } = settings(a);
  delete process.env.ADMIN_REASONS_REQUIRED;
  assert.equal((await s.adminUpdate({ body: { paymentPeriodDays: 14 }, actorId: 'a', }) ).error, undefined);
  assert.equal(a.entries[0].reason, null);
  assert.equal((await s.adminUpdate({ body: { paymentPeriodDays: 15, reason: 'agreed with finance' }, actorId: 'a' })).error, undefined);
  assert.equal(a.entries[1].reason, 'agreed with finance');
  process.env.ADMIN_REASONS_REQUIRED = 'on';
  try {
    for (const body of [{ paymentPeriodDays: 21 }, { currency: 'TZS' }, { payoutModel: 'x' }, { payoutBands: [] }, { subscriptionTiers: TEST_TIERS, reason: ' ' }]) {
      assert.deepEqual(await s.adminUpdate({ body, actorId: 'a' }), { error: 'reason_required', status: 400 }, JSON.stringify(Object.keys(body)));
    }
    assert.equal(a.entries.length, 2, 'refused updates wrote nothing');
    assert.equal((await s.adminUpdate({ body: { paymentPeriodDays: 21, reason: 'quarterly review' }, actorId: 'a' })).error, undefined);
    assert.equal(a.entries[2].reason, 'quarterly review');
    // Cosmetic: no sensitive key in the body.
    assert.equal((await s.adminUpdate({ body: { trainerSpecialties: ['Yoga'] }, actorId: 'a' })).error, undefined);
  } finally { delete process.env.ADMIN_REASONS_REQUIRED; }
});

// A real transaction: the audit insert fails, so the change must not survive in the database.
test('audit failure fails the action: member status and settings roll back in the database; owner is not deleted', async () => {
  const transaction = fn => db.transaction(fn);
  const failing = { ...auditCollection, insertTrxAsync: async () => { throw new Error('audit down'); }, insertAsync: async () => { throw new Error('audit down'); } };

  const memberId = `usr_atom_${run}`;
  const subId = `sub_atom_${run}`;
  await db('User').insert({ id: memberId, userType: 'member', displayName: 'Atomic', accountStatus: 'active', updatedAt: new Date() });
  await db('Subscription').insert({ id: subId, memberId, tier: 'basic', status: 'active', startDate: new Date(), endDate: new Date(Date.now() + 864e5), updatedAt: new Date() }).catch(() => {});
  try {
    const svc = createAdminMemberService({ users, subscriptions, paymentRequests: store(), checkins: store(), gyms: [], auditLog: failing, issueQr: () => 'qr', transaction });
    await assert.rejects(svc.setStatus({ memberId, status: 'suspended', actorId: 'a' }), /audit down/);
    assert.equal((await db('User').where({ id: memberId }).first()).accountStatus, 'active', 'suspension rolled back');
    const sub = await db('Subscription').where({ id: subId }).first();
    if (sub) assert.equal(sub.status, 'active', 'subscription rolled back');
    // And the happy path commits both with the audit row.
    const ok = createAdminMemberService({ users, subscriptions, paymentRequests: store(), checkins: store(), gyms: [], auditLog: auditCollection, issueQr: () => 'qr', transaction });
    assert.equal((await ok.setStatus({ memberId, status: 'suspended', actorId: ACTOR, reason: 'atomic ok' })).error, undefined);
    assert.equal((await db('User').where({ id: memberId }).first()).accountStatus, 'suspended');
    const row = await db('AuditLog').where({ target: memberId, action: 'member_suspended' }).first();
    assert.equal(row.reason, 'atomic ok');
  } finally {
    await db('AuditLog').where({ target: memberId }).del();
    await db('Subscription').where({ id: subId }).del();
    await db('User').where({ id: memberId }).del();
  }

  // Settings: the real platform row and its in-memory copy stay as they were.
  await primed();
  const live = platformSettings.find(r => r.id === 'platform');
  const rowBefore = await db('PlatformSettings').where({ id: 'platform' }).first();
  const settingsSvc = createSettingsService({ platformSettings, auditLog: failing, tierHolders: async () => 0, transaction });
  await assert.rejects(settingsSvc.adminUpdate({ body: { paymentPeriodDays: 99 }, actorId: 'a' }), /audit down/);
  const rowAfter = await db('PlatformSettings').where({ id: 'platform' }).first();
  assert.equal(rowAfter.paymentPeriodDays, rowBefore.paymentPeriodDays, 'database unchanged');
  assert.equal(platformSettings.find(r => r.id === 'platform').paymentPeriodDays, live.paymentPeriodDays, 'cache unchanged');
  assert.notEqual(rowAfter.paymentPeriodDays, 99);

  const owners = store([{ id: 'usr_o2', userType: 'gym_operator', gymId: null, gymIds: [] }]);
  const osvc = createAdminOwnerService({ users: owners, gyms: [], checkins: store(), auditLog: sink({ fail: true }), gymService: { slimGymRef: g => g } });
  await assert.rejects(osvc.remove({ id: 'usr_o2', actorId: 'a' }), /audit down/);
  assert.equal(owners.rows.length, 1, 'owner not deleted');
});

test('settings commit: the audit row and the new value land together, cache follows the commit', async () => {
  const transaction = fn => db.transaction(fn);
  await primed();
  const original = (await db('PlatformSettings').where({ id: 'platform' }).first()).paymentPeriodDays;
  const svc = createSettingsService({ platformSettings, auditLog: auditCollection, tierHolders: async () => 0, transaction });
  try {
    const res = await svc.adminUpdate({ body: { paymentPeriodDays: 17, reason: 'atomic settings' }, actorId: ACTOR });
    assert.equal(res.paymentPeriodDays, 17);
    assert.equal((await db('PlatformSettings').where({ id: 'platform' }).first()).paymentPeriodDays, 17);
    assert.equal(platformSettings.find(r => r.id === 'platform').paymentPeriodDays, 17);
    const row = await db('AuditLog').where({ actor: ACTOR, action: 'settings_updated' }).first();
    assert.equal(row.reason, 'atomic settings');
  } finally {
    await db('PlatformSettings').where({ id: 'platform' }).update({ paymentPeriodDays: original });
    platformSettings.find(r => r.id === 'platform').paymentPeriodDays = original;
    await db('AuditLog').where({ actor: ACTOR, action: 'settings_updated' }).del();
  }
});

// The platform row is primed into memory asynchronously at startup; make sure it is there (creating it on a fresh DB).
async function primed() {
  for (let i = 0; i < 50 && !platformSettings.find(r => r.id === 'platform'); i++) await new Promise(r => setTimeout(r, 100));
  createSettingsService({ platformSettings, auditLog: auditCollection }).ensureDefaultSettings();
  for (let i = 0; i < 50 && !(await db('PlatformSettings').where({ id: 'platform' }).first()); i++) await new Promise(r => setTimeout(r, 100));
}

// ── trigger details ──────────────────────────────────────────────────────────
test('trigger: the scrub can only remove data; the test bypass pattern is strict', async () => {
  const id = await put({ before: { email: 'a@x.test', phone: '1' }, after: { n: { a: 1, b: 2 } } });
  const scrub = async sql => strict(async trx => {
    await trx.raw(`SELECT set_config('fitflex.audit_scrub', 'on', true)`);
    return trx.raw(sql, [id]);
  });
  // adding a key, rewriting a value, or growing a nested object is refused
  await assert.rejects(scrub(`UPDATE "AuditLog" SET before = before || '{"new":1}'::jsonb WHERE id = ?`), /append-only/);
  await assert.rejects(scrub(`UPDATE "AuditLog" SET before = '{"email":"other@x.test"}'::jsonb WHERE id = ?`), /append-only/);
  await assert.rejects(scrub(`UPDATE "AuditLog" SET after = '{"n":{"a":1,"z":9}}'::jsonb WHERE id = ?`), /append-only/);
  await assert.rejects(scrub(`UPDATE "AuditLog" SET action = 'x', before = before - 'phone' WHERE id = ?`), /append-only/);
  // removing keys (also nested) is fine; the transaction is rolled back by strict()
  await scrub(`UPDATE "AuditLog" SET after = '{"n":{"a":1}}'::jsonb WHERE id = ?`);
  const src = readFileSync(new URL('../db/migrations/20270202090000-audit-log-append-only.cjs', import.meta.url), 'utf8');
  const pattern = src.match(/current_database\(\) ~ '([^']+)'/)[1];
  for (const [name, ok] of [['fitflex_ci', true], ['fitflex_ci_sliceB_1102', true], ['fitflex_ci_b2b', true], ['fitflex_circle', false],
    ['fitflex_city', false], ['prod_cicd', false], ['fitflex', false], ['fitflex_ci-prod', false], ['xfitflex_ci', false]]) {
    const { rows: [{ m }] } = await db.raw('select ? ~ ? as m', [name, pattern]);
    assert.equal(m, ok, name);
  }
});

// ── redaction ────────────────────────────────────────────────────────────────
test('viewer redaction: key patterns removed as whole words, account numbers masked', () => {
  for (const k of ['apiKey', 'api_key', 'clientSecret', 'accessToken', 'passwordHash', 'pin', 'otpCode', 'nationalId', 'national_id', 'tin', 'accountNumber', 'bankAccountNumber', 'tokenHash'])
    assert.ok(isSecretLookingKey(k), k);
  for (const k of ['shipping', 'mapping', 'displayName', 'action', 'timing', 'status', 'accountName', 'opinion'])
    assert.ok(!isSecretLookingKey(k), k);
  const out = redactAuditForDisplay({
    manualPayment: { lipaNamba: '5123456789', accountName: 'FitFlex', network: 'M-Pesa' },
    vendor: { tin: '123-456', bankAccountNumber: '0150123', nationalId: 'X', apiKey: 'k', shipping: 'ok' },
    list: [{ secretNote: 'x', fine: 1 }],
  });
  assert.equal(out.manualPayment.lipaNamba, '*******789');
  assert.equal(out.manualPayment.accountName, 'FitFlex');
  assert.deepEqual(out.vendor, { shipping: 'ok' });
  assert.deepEqual(out.list, [{ fine: 1 }]);
});

test('viewer: settings audit rows come back with the Lipa Namba masked', async () => {
  await put({ action: 'spec_mask', after: { manualPayment: { lipaNamba: '5123456', accountName: 'FitFlex' } } });
  const { items } = await viewer.list({ actor: ACTOR, action: 'spec_mask' });
  assert.equal(items[0].after.manualPayment.lipaNamba, '****456');
  assert.ok(!JSON.stringify(items).includes('5123456'));
});

test('routes pass body.reason through; the owner delete ignores ?reason=', () => {
  assert.match(String(adminDeleteGymOwner.onRequest), /req\.body\?\.reason/);
  assert.doesNotMatch(String(adminDeleteGymOwner.onRequest), /query/);
  assert.match(String(adminSetMemberStatus.onRequest), /reason/);
});
