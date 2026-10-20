// B2B billing route guards as bfast-function really mounts them: app.use(path, onGuard) for every
// guard (method ignored, path matched as a prefix), then app[method](path, onRequest). Before this fix
// the `b2b` guard of GET/POST /admin/b2b/organizations and GET /admin/b2b/programs also ran on every
// /organizations/:id/* and /programs/:programId/* route, a read route also ran its write sibling's
// guard (agreements, billing-account, payment-instructions), and /admin/b2b/analytics' `b2b` guard ran
// on /analytics/data-quality. So the separate billing grants (b2b_billing, b2b_billing_approve,
// b2b_payments) did not work on their own. Each route now admits exactly who its own guard admits;
// the two-person rules stay in the services (an invoice's issuer cannot record its payment).
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
import { b2bService, b2bBillingService as billing, b2bFinanceService as finance } from '../src/bootstrap/services.mjs';
import { localDay } from '../src/shared/member-progress.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const PERIOD = localDay(new Date()).slice(0, 7);

const functionsDir = path.join(root, 'functions');
const functions = {};
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(path.join(functionsDir, file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const guarded = Object.keys(functions).filter(k => functions[k].onGuard);
const http = Object.keys(functions).filter(k => functions[k].onRequest);
const b2bRoutes = http.filter(k => k.startsWith('b2b.mjs:') && functions[k].path);

const real = express();
real.use(express.json());
mountGuards(guarded, functions, real);
mountHttpRoutes(http, functions, real);
const stubbed = express();
mountGuards(guarded, functions, stubbed);
for (const k of http) {
  const d = functions[k];
  if (d.path) stubbed[(d.method || 'all').toLowerCase()](d.path, (_req, res) => res.status(200).json({ route: k }));
}
const own = express();
for (const k of http) {
  const d = functions[k];
  if (d.path) own[(d.method || 'all').toLowerCase()](d.path, ...[d.onGuard].flat().filter(Boolean), (_req, res) => res.status(200).json({ route: k }));
}
const servers = [];
function listen(app) {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const realUrl = listen(real);
const stubUrl = listen(stubbed);
const ownUrl = listen(own);

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

const made = { users: [], orgs: [] };
async function admin(scopes) {
  const id = uid('adm');
  await db('User').insert({ id, userType: 'admin', displayName: `B2B ${scopes.join('+')}`, portalUser: true, aclPermissions: scopes, updatedAt: new Date() });
  made.users.push(id);
  return { sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes };
}
const portal = scopes => ({ sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: scopes });
const acl = scope => ({ error: 'acl_forbidden', requiredScope: scope });

async function sponsor(actorId) {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Guard Sponsor ${uid('o')}`, email: 'office@guard.test' }, actorId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId });
  return organization.id;
}

after(async () => {
  for (const s of servers) s.close();
  await purgeB2BBilling(db, made.orgs);
  if (made.orgs.length) {
    await db('AuditLog').whereIn('target', made.orgs).del();
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
  await db.destroy();
});

test('every b2b.mjs guard runs only for its own route\'s method', () => {
  assert.ok(b2bRoutes.length >= 100, `found ${b2bRoutes.length} b2b routes`);
  for (const k of b2bRoutes) {
    const d = functions[k];
    for (const g of [d.onGuard].flat().filter(Boolean)) {
      assert.ok(Array.isArray(g.routeMethods), `${k}: guard not wrapped with routeGuard`);
      assert.ok(g.routeMethods.includes(d.method.toUpperCase()), `${k}: guard scoped to ${g.routeMethods} not ${d.method}`);
    }
  }
});

test('every b2b.mjs route: as mounted by bfast-function, it lets in exactly who its own guard lets in', async () => {
  const principals = [
    ['anon', null],
    ...['member', 'trainer', 'gym_operator', 'vendor', 'corporate_hr', 'admin'].map(t => [t, { sub: uid(t), userType: t }]),
    ['admin[]', portal([])],
    ...['b2b', 'b2b_billing', 'b2b_billing_approve', 'b2b_payments', 'corporate', 'payments'].map(s => [`admin[${s}]`, portal([s])]),
    ['admin[b2b_billing,b2b_payments]', portal(['b2b_billing', 'b2b_payments'])],
  ];
  const mismatches = [];
  for (const k of b2bRoutes) {
    const d = functions[k];
    const method = (d.method || 'get').toUpperCase();
    const url = d.path.replace(/:[A-Za-z0-9_]+/g, 'p1');
    const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : {};
    for (const [name, claims] of principals) {
      const [mounted, alone] = await Promise.all([hit(stubUrl, method, url, claims, body), hit(ownUrl, method, url, claims, body)]);
      if ((mounted.status === 200) !== (alone.status === 200)) mismatches.push(`${method} ${d.path} as ${name}: mounted ${mounted.status} ${JSON.stringify(mounted.body)} / own ${alone.status}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('billing grants work on their own: biller raises the agreement and fee invoice, the cashier records the payment; the issuer still cannot record its own invoice\'s payment', async () => {
  const biller = await admin(['b2b_billing']);
  const cashier = await admin(['b2b_payments']);
  const approver = await admin(['b2b_billing_approve']);
  const billerCashier = await admin(['b2b_billing', 'b2b_payments']);
  const orgId = await sponsor(biller.sub);
  const org = `/admin/b2b/organizations/${orgId}`;

  // Agreement: created by a biller without `b2b` (was 403 requiredScope b2b).
  const created = await hit(realUrl, 'POST', `${org}/agreements`, biller, { effectiveFrom: `${PERIOD}-01`, platformFeeTzs: 50000 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(await hit(realUrl, 'POST', `${org}/agreements`, portal(['b2b']), {}), { status: 403, body: acl('b2b_billing') });
  for (const reader of [portal(['b2b']), portal(['b2b_billing']), portal(['b2b_billing_approve']), portal(['b2b_payments'])]) {
    const list = await hit(realUrl, 'GET', `${org}/agreements`, reader);
    assert.equal(list.status, 200, `${reader.aclPermissions}: ${JSON.stringify(list.body)}`);
  }
  const live = await finance.activateAgreement({ agreementId: created.body.agreement.id, version: new Date(created.body.agreement.updatedAt).toISOString(), actorId: approver.sub });
  assert.ok(live.agreement, JSON.stringify(live));

  // Fee invoice: prepared over HTTP by `billerCashier`, who then issues it.
  const prepared = await hit(realUrl, 'POST', `${org}/invoices/prepare-fee`, billerCashier, { period: PERIOD });
  assert.ok([200, 201].includes(prepared.status), JSON.stringify(prepared.body));
  const issued = await billing.issueInvoice({ invoiceId: prepared.body.invoice.id, vatRateBps: 0, actorId: billerCashier.sub });
  assert.equal(issued.invoice?.status, 'issued', JSON.stringify(issued));
  const invoiceId = issued.invoice.id;
  const total = issued.invoice.totalTzs;

  // Payments: a biller without `b2b_payments` is refused by the route; the issuer is refused by the service.
  const body = ref => ({ amountTzs: total, method: 'bank_transfer', reference: ref, allocations: [{ invoiceId, amountTzs: total }] });
  assert.deepEqual(await hit(realUrl, 'POST', `${org}/payments`, biller, body(uid('ref'))), { status: 403, body: acl('b2b_payments') });
  const own = await hit(realUrl, 'POST', `${org}/payments`, billerCashier, body(uid('ref')));
  assert.deepEqual([own.status, own.body.error], [403, 'cannot_settle_own_invoice'], JSON.stringify(own.body));
  const paid = await hit(realUrl, 'POST', `${org}/payments`, cashier, body(uid('ref')));
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal((await db('B2BSponsorInvoice').where({ id: invoiceId }).first()).status, 'paid');

  // Reads open to any billing grant.
  for (const reader of [cashier, approver, biller]) {
    assert.equal((await hit(realUrl, 'GET', `${org}/statement`, reader)).status, 200, `statement as ${reader.aclPermissions}`);
    assert.equal((await hit(realUrl, 'GET', `${org}/billing-account`, reader)).status, 200, `billing-account as ${reader.aclPermissions}`);
  }
  // Billing account write: `b2b_billing` (was also `b2b`).
  const account = await hit(realUrl, 'PUT', `${org}/billing-account`, biller, { billingEmail: 'ap@guard.test' });
  assert.equal(account.status, 200, JSON.stringify(account.body));
  assert.deepEqual(await hit(realUrl, 'PUT', `${org}/billing-account`, cashier, {}), { status: 403, body: acl('b2b_billing') });

  // Billing hold: `b2b_billing_approve` only.
  const hold = await hit(realUrl, 'POST', `${org}/billing-hold`, approver, { onHold: true, reason: 'route guard spec' });
  assert.equal(hold.status, 200, JSON.stringify(hold.body));
  assert.deepEqual(await hit(realUrl, 'POST', `${org}/billing-hold`, biller, { onHold: false }), { status: 403, body: acl('b2b_billing_approve') });
});

test('payment instructions: any billing grant reads them (was b2b_billing_approve only); writing still needs b2b_billing_approve', async () => {
  for (const scope of ['b2b', 'b2b_billing', 'b2b_billing_approve', 'b2b_payments']) {
    const got = await hit(realUrl, 'GET', '/admin/b2b/payment-instructions', portal([scope]));
    assert.equal(got.status, 200, `${scope}: ${JSON.stringify(got.body)}`);
  }
  for (const scope of ['b2b', 'b2b_billing', 'b2b_payments']) {
    assert.deepEqual(await hit(realUrl, 'PUT', '/admin/b2b/payment-instructions', portal([scope]), {}), { status: 403, body: acl('b2b_billing_approve') }, scope);
  }
});

test('programme billing and data quality: billing grants reach them without `b2b`; the organisation and programme admin routes keep `b2b`', async () => {
  const missing = `/admin/b2b/programs/${uid('none')}`;
  for (const scope of ['b2b_billing', 'b2b_billing_approve', 'b2b_payments']) {
    const ents = await hit(realUrl, 'GET', `${missing}/entitlements`, portal([scope]));
    assert.notEqual(ents.status, 403, `${scope}: ${JSON.stringify(ents.body)}`);
    const dq = await hit(realUrl, 'GET', '/admin/b2b/analytics/data-quality', portal([scope]));
    assert.equal(dq.status, 200, `${scope}: ${JSON.stringify(dq.body)}`);
    assert.deepEqual(await hit(realUrl, 'GET', '/admin/b2b/organizations', portal([scope])), { status: 403, body: acl('b2b') }, scope);
    assert.deepEqual(await hit(realUrl, 'GET', '/admin/b2b/analytics', portal([scope])), { status: 403, body: acl('b2b') }, scope);
  }
  const prep = await hit(realUrl, 'POST', `${missing}/invoices/prepare`, portal(['b2b_billing']), { period: PERIOD });
  assert.notEqual(prep.status, 403, JSON.stringify(prep.body));
  assert.deepEqual(await hit(realUrl, 'POST', `${missing}/invoices/prepare`, portal(['b2b']), { period: PERIOD }), { status: 403, body: acl('b2b_billing') });
});
