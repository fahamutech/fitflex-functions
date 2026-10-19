// Settlement route guards as bfast-function really mounts them: app.use(path, onGuard) for every guard
// (method ignored, path matched as a prefix), then app[method](path, onRequest). Before this fix the
// `payments` guard of GET /admin/settlements/runs, GET /admin/settlements/statements[/:id] and
// GET /admin/{trainer,vendor}-settlements/:id also ran on every POST under those paths, so admins with
// split duties (settlements_prepare / _approve / _pay without `payments`) were refused, and starting a
// run needed both `payments` and `settlements_prepare`. Who may do what is still each route's own
// guard; the two-person rules stay in the services (submitter can't approve, requester can't void).
// Against the CI database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const MODULES = ['admin-settlements.mjs', 'trainer-settlements.mjs', 'vendor-settlements.mjs'];

const functionsDir = path.join(root, 'functions');
const functions = {};
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(path.join(functionsDir, file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const guarded = Object.keys(functions).filter(k => functions[k].onGuard);
const http = Object.keys(functions).filter(k => functions[k].onRequest);
const settlementRoutes = http.filter(k => MODULES.includes(k.split(':')[0]) && functions[k].path);

/** The real server: every guard and every real handler. */
const real = express();
real.use(express.json());
mountGuards(guarded, functions, real);
mountHttpRoutes(http, functions, real);
/** Same guards, but each handler only says which route it is (no side effects). */
const stubbed = express();
mountGuards(guarded, functions, stubbed);
for (const k of http) {
  const d = functions[k];
  if (d.path) stubbed[(d.method || 'all').toLowerCase()](d.path, (_req, res) => res.status(200).json({ route: k }));
}
const servers = [];
function listen(app) {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const realUrl = listen(real);
const stubUrl = listen(stubbed);

async function hit(base, method, url, claims, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const madeUsers = [];
const madeTrainerStatements = [];
const madeVendorStatements = [];
async function admin(scopes) {
  const id = uid('adm');
  await db('User').insert({ id, userType: 'admin', displayName: `Settle ${scopes.join('+')}`, portalUser: true, aclPermissions: scopes, updatedAt: new Date() });
  madeUsers.push(id);
  return { sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes };
}
const portal = scopes => ({ sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: scopes });
const PAY = { error: 'acl_forbidden', requiredScope: 'payments' };
const acl = scope => ({ error: 'acl_forbidden', requiredScope: scope });

after(async () => {
  for (const s of servers) s.close();
  // Voided statements are final by design and stay; drafts go.
  if (madeTrainerStatements.length) await db('TrainerSettlement').whereIn('id', madeTrainerStatements).where({ status: 'draft' }).del();
  if (madeVendorStatements.length) await db('VendorSettlement').whereIn('id', madeVendorStatements).where({ status: 'draft' }).del();
  if (madeUsers.length) {
    await db('AuditLog').whereIn('actor', madeUsers).del();
    await db('User').whereIn('id', madeUsers).del();
  }
  await db.destroy();
});

// A Monday far in the future: prepare refuses it with 400 week_not_ended, so reaching the handler has no side effects.
const FUTURE_MONDAY = '2099-01-05';
// A Monday no other spec uses, for statements made here.
const OLD_WEEK = { periodStartDate: '2020-01-06', periodEndDate: '2020-01-12' };

test('every settlement guard runs only for its own route\'s method', () => {
  assert.ok(settlementRoutes.length >= 45, `found ${settlementRoutes.length} settlement routes`);
  for (const k of settlementRoutes) {
    const d = functions[k];
    for (const g of [d.onGuard].flat()) {
      assert.ok(Array.isArray(g.routeMethods), `${k}: guard not wrapped with routeGuard`);
      assert.ok(g.routeMethods.includes(d.method.toUpperCase()), `${k}: guard scoped to ${g.routeMethods} not ${d.method}`);
    }
  }
});

test('every settlement route: as mounted by bfast-function, it lets in exactly who its own guard lets in', async () => {
  const principals = [
    ['anon', null],
    ['member', { sub: uid('m'), userType: 'member' }],
    ['trainer', { sub: uid('t'), userType: 'trainer' }],
    ['vendor', { sub: uid('v'), userType: 'vendor' }],
    ['gym_operator', { sub: uid('g'), userType: 'gym_operator' }],
    ['admin', { sub: uid('a'), userType: 'admin' }],
    ['admin[]', portal([])],
    ['admin[payments]', portal(['payments'])],
    ['admin[settlements_prepare]', portal(['settlements_prepare'])],
    ['admin[settlements_approve]', portal(['settlements_approve'])],
    ['admin[settlements_pay]', portal(['settlements_pay'])],
    ['admin[settlements_prepare,settlements_approve]', portal(['settlements_prepare', 'settlements_approve'])],
    ['admin[payments,settlements_prepare,settlements_approve,settlements_pay]', portal(['payments', 'settlements_prepare', 'settlements_approve', 'settlements_pay'])],
  ];
  // Reference: the same routes with nothing but their own guards, mounted per route and method.
  const own = express();
  for (const k of http) {
    const d = functions[k];
    if (d.path) own[(d.method || 'all').toLowerCase()](d.path, ...[d.onGuard].flat().filter(Boolean), (_req, res) => res.status(200).json({ route: k }));
  }
  const ownUrl = listen(own);
  const mismatches = [];
  for (const k of settlementRoutes) {
    const d = functions[k];
    const method = (d.method || 'get').toUpperCase();
    const url = d.path.replace(/:[A-Za-z0-9_]+/g, 'p1');
    for (const [name, claims] of principals) {
      const body = method === 'GET' ? undefined : {};
      const [mounted, alone] = await Promise.all([hit(stubUrl, method, url, claims, body), hit(ownUrl, method, url, claims, body)]);
      if ((mounted.status === 200) !== (alone.status === 200)) mismatches.push(`${method} ${d.path} as ${name}: mounted ${mounted.status} ${JSON.stringify(mounted.body)} / own ${alone.status}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('gym settlement runs: listing needs `payments` only; starting a run needs `settlements_prepare` only (was both)', async () => {
  const viewer = portal(['payments']);
  const preparer = portal(['settlements_prepare']);
  const runs = await hit(realUrl, 'GET', '/admin/settlements/runs', viewer);
  assert.equal(runs.status, 200, JSON.stringify(runs.body));
  assert.equal((await hit(stubUrl, 'GET', '/admin/settlements/runs/p1', viewer)).status, 200);
  assert.deepEqual(await hit(realUrl, 'GET', '/admin/settlements/runs', preparer), { status: 403, body: PAY });
  // Reaches the handler (an invalid month answers before anything is calculated).
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/settlements/runs', preparer, { month: 'nope' }), { status: 400, body: { error: 'invalid_month' } });
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/settlements/runs', viewer, { month: 'nope' }), { status: 403, body: acl('settlements_prepare') });
});

test('gym statement actions and the clawback sweep need only their own settlement scope (no `payments`)', async () => {
  const cases = [
    ['submit', 'settlements_prepare'], ['hold', 'settlements_prepare'], ['adjustments', 'settlements_prepare'],
    ['approve', 'settlements_approve'], ['reject', 'settlements_approve'], ['release', 'settlements_approve'], ['void', 'settlements_approve'],
    ['payable', 'settlements_pay'], ['pay', 'settlements_pay'],
    ['void-request', 'settlements_prepare'], ['void-request', 'settlements_approve'],
    ['void-request/cancel', 'settlements_prepare'], ['void-request/cancel', 'settlements_approve'],
  ];
  const missing = `/admin/settlements/statements/${uid('gst')}`;
  for (const [action, scope] of cases) {
    const got = await hit(realUrl, 'POST', `${missing}/${action}`, portal([scope]), { reason: 'spec', paymentReference: 'X', amountTzs: -1000, type: 'manual' });
    assert.notEqual(got.status, 403, `${action} as ${scope}: ${JSON.stringify(got.body)}`);
    assert.equal(got.status, 404, `${action} as ${scope} reaches the handler: ${JSON.stringify(got.body)}`);
    // `payments` alone still opens none of them.
    const viewer = await hit(realUrl, 'POST', `${missing}/${action}`, portal(['payments']), {});
    assert.equal(viewer.status, 403, `${action} as payments`);
    assert.equal(viewer.body.error, 'acl_forbidden');
  }
  assert.equal((await hit(stubUrl, 'POST', '/admin/settlements/clawbacks/sweep', portal(['settlements_prepare']))).status, 200);
  assert.deepEqual(await hit(stubUrl, 'POST', '/admin/settlements/clawbacks/sweep', portal(['payments'])), { status: 403, body: acl('settlements_prepare') });
  // Reading statements still needs `payments`.
  assert.deepEqual(await hit(realUrl, 'GET', missing, portal(['settlements_approve'])), { status: 403, body: PAY });
  assert.deepEqual(await hit(realUrl, 'GET', '/admin/settlements/statements', portal(['settlements_prepare'])), { status: 403, body: PAY });
});

for (const kind of ['trainer', 'vendor']) {
  const base = `/admin/${kind}-settlements`;
  const table = kind === 'trainer' ? 'TrainerSettlement' : 'VendorSettlement';

  test(`${kind} settlements: prepare and every /:id action need only their own scope (the GET /:id \`payments\` guard no longer runs on them)`, async () => {
    const preparer = portal(['settlements_prepare']);
    assert.deepEqual(await hit(realUrl, 'POST', `${base}/prepare`, preparer, { periodStart: FUTURE_MONDAY }),
      { status: 400, body: { error: 'week_not_ended', periodEndDate: '2099-01-11' } });
    assert.deepEqual(await hit(realUrl, 'POST', `${base}/prepare`, portal(['payments']), { periodStart: FUTURE_MONDAY }), { status: 403, body: acl('settlements_prepare') });
    for (const [action, scope] of [['submit', 'settlements_prepare'], ['hold', 'settlements_prepare'], ['approve', 'settlements_approve'], ['reject', 'settlements_approve'],
      ['release', 'settlements_approve'], ['void', 'settlements_approve'], ['payable', 'settlements_pay'], ['pay', 'settlements_pay'],
      ['void-request', 'settlements_prepare'], ['void-request/cancel', 'settlements_approve']]) {
      const got = await hit(realUrl, 'POST', `${base}/${uid('none')}/${action}`, portal([scope]), { reason: 'spec', paymentReference: 'X' });
      assert.deepEqual([got.status, got.body.error], [404, 'statement_not_found'], `${action} as ${scope}`);
    }
    // Views keep `payments`.
    assert.deepEqual(await hit(realUrl, 'GET', `${base}/${uid('none')}`, preparer), { status: 403, body: PAY });
    assert.deepEqual(await hit(realUrl, 'GET', base, preparer), { status: 403, body: PAY });
  });

  test(`${kind} settlements: split-duty admins run the two-person flow; the submitter still can't approve and the requester still can't void`, async () => {
    const preparer = await admin(['settlements_prepare']);
    const approver = await admin(['settlements_approve']);
    const both = await admin(['settlements_prepare', 'settlements_approve']);
    const viewer = await admin(['payments']);
    const id = `${kind === 'trainer' ? 'tst' : 'vst'}_${randomUUID().slice(0, 12)}`;
    const owner = kind === 'trainer' ? { trainerId: uid('trn'), sessionCount: 1 } : { vendorId: uid('vnd'), orderCount: 1 };
    await db(table).insert({ id, ...owner, ...OLD_WEEK, finalNetTzs: 17000, commissionTzs: 3000, status: 'draft', preparedBy: preparer.sub, updatedAt: new Date() });
    (kind === 'trainer' ? madeTrainerStatements : madeVendorStatements).push(id);

    // `payments` alone can read but not act.
    assert.equal((await hit(realUrl, 'GET', `${base}/${id}`, viewer)).status, 200);
    assert.deepEqual(await hit(realUrl, 'POST', `${base}/${id}/submit`, viewer), { status: 403, body: acl('settlements_prepare') });

    const submitted = await hit(realUrl, 'POST', `${base}/${id}/submit`, both);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.statement.status, 'submitted');
    assert.deepEqual(await hit(realUrl, 'POST', `${base}/${id}/approve`, preparer), { status: 403, body: acl('settlements_approve') });
    const own = await hit(realUrl, 'POST', `${base}/${id}/approve`, both);
    assert.deepEqual([own.status, own.body.error], [403, 'cannot_approve_own_submission']);
    const approved = await hit(realUrl, 'POST', `${base}/${id}/approve`, approver);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.statement.status, 'approved');

    const requested = await hit(realUrl, 'POST', `${base}/${id}/void-request`, both, { reason: 'route guard spec' });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const ownVoid = await hit(realUrl, 'POST', `${base}/${id}/void`, both);
    assert.deepEqual([ownVoid.status, ownVoid.body.error], [403, 'cannot_void_own_request']);
    assert.deepEqual(await hit(realUrl, 'POST', `${base}/${id}/void`, preparer), { status: 403, body: acl('settlements_approve') });
    const voided = await hit(realUrl, 'POST', `${base}/${id}/void`, approver);
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    const row = await db(table).where({ id }).first();
    assert.deepEqual([row.status, row.submittedBy, row.approvedBy, row.voidRequestedBy, row.voidedBy], ['voided', both.sub, approver.sub, both.sub, approver.sub]);
  });
}
