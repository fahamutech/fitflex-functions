// Trainer and vendor statement actions: who acts comes from the token, which statement from the URL.
// Until this fix the shared `act` helper spread req.body after the server-set fields, so a body
// { "actorId": "<someone else>" } replaced the caller, and one admin could submit and approve, or
// request and confirm a void, as if they were two people; { "id": "<other>" } acted on another
// statement than the URL named. Real handlers, mounted as bfast-function mounts them, against the
// CI database. Super-admin tokens (no portal ACL) so this spec does not depend on guard scoping.
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

const functions = {};
for (const file of ['trainer-settlements.mjs', 'vendor-settlements.mjs']) {
  const mod = await import(path.join(root, 'functions', file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const app = express();
app.use(express.json());
mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function hit(method, url, claims, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sign(claims)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const madeUsers = [];
const made = { TrainerSettlement: [], VendorSettlement: [] };
async function superAdmin() {
  const id = uid('adm');
  await db('User').insert({ id, userType: 'admin', displayName: 'Actor spec admin', updatedAt: new Date() });
  madeUsers.push(id);
  return { sub: id, userType: 'admin' };
}

after(async () => {
  server.close();
  for (const [table, ids] of Object.entries(made)) if (ids.length) await db(table).whereIn('id', ids).where({ status: 'draft' }).del();
  if (madeUsers.length) {
    await db('AuditLog').whereIn('actor', madeUsers).del();
    await db('User').whereIn('id', madeUsers).del();
  }
  await db.destroy();
});

// Weeks no other spec uses.
const WEEKS = { trainer: ['2020-02-03', '2020-02-09'], vendor: ['2020-02-10', '2020-02-16'] };

for (const kind of ['trainer', 'vendor']) {
  const prefix = `/admin/${kind}-settlements`;
  const table = kind === 'trainer' ? 'TrainerSettlement' : 'VendorSettlement';
  async function draft() {
    const id = `${kind === 'trainer' ? 'tst' : 'vst'}_${randomUUID().slice(0, 12)}`;
    const owner = kind === 'trainer' ? { trainerId: uid('trn'), sessionCount: 1 } : { vendorId: uid('vnd'), orderCount: 1 };
    await db(table).insert({ id, ...owner, periodStartDate: WEEKS[kind][0], periodEndDate: WEEKS[kind][1], finalNetTzs: 17000, commissionTzs: 3000, status: 'draft', updatedAt: new Date() });
    made[table].push(id);
    return id;
  }

  test(`${kind} statements: a body actorId cannot stand in for a second person (approve, void), and the body cannot pick another statement`, async () => {
    const maker = await superAdmin();
    const checker = await superAdmin();
    const a = await draft();
    const b = await draft();

    // submit A, naming the checker as actor and B as the statement: both ignored.
    const submitted = await hit('POST', `${prefix}/${a}/submit`, maker, { actorId: checker.sub, id: b });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.statement.id, a);
    let row = await db(table).where({ id: a }).first();
    assert.deepEqual([row.status, row.submittedBy], ['submitted', maker.sub], 'submitted by the caller, not the body\'s actorId');
    assert.equal((await db(table).where({ id: b }).first()).status, 'draft', 'the statement in the body was not touched');

    // The submitter approving their own, claiming to be the checker: refused.
    const own = await hit('POST', `${prefix}/${a}/approve`, maker, { actorId: checker.sub });
    assert.deepEqual([own.status, own.body.error], [403, 'cannot_approve_own_submission']);
    assert.equal((await db(table).where({ id: a }).first()).status, 'submitted');

    // Request a void claiming to be the checker, then confirm it as the maker: refused.
    const requested = await hit('POST', `${prefix}/${a}/void-request`, maker, { actorId: checker.sub, reason: 'actor spec' });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    row = await db(table).where({ id: a }).first();
    assert.deepEqual([row.voidRequestedBy, row.voidRequestReason], [maker.sub, 'actor spec']);
    const ownVoid = await hit('POST', `${prefix}/${a}/void`, maker, { actorId: checker.sub });
    assert.deepEqual([ownVoid.status, ownVoid.body.error], [403, 'cannot_void_own_request']);
    assert.equal((await db(table).where({ id: a }).first()).status, 'submitted');

    // A real second person can; the body's actorId does not change who is recorded.
    const voided = await hit('POST', `${prefix}/${a}/void`, checker, { actorId: maker.sub, id: b });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    row = await db(table).where({ id: a }).first();
    assert.deepEqual([row.status, row.voidedBy], ['voided', checker.sub]);
    assert.equal((await db(table).where({ id: b }).first()).status, 'draft');

    // Fields the actions do read still come from the body: a rejection reason.
    assert.equal((await hit('POST', `${prefix}/${b}/submit`, maker, {})).status, 200);
    const rejected = await hit('POST', `${prefix}/${b}/reject`, checker, { reason: 'wrong week', actorId: maker.sub });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    row = await db(table).where({ id: b }).first();
    assert.deepEqual([row.status, row.rejectedBy, row.rejectReason], ['draft', checker.sub, 'wrong week']);
  });
}
