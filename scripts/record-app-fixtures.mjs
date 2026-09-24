#!/usr/bin/env node
// Records real API responses from a LOCAL backend for the mobile app's
// whole-app regression test (fitflex-mobile test/app_regression_test.dart).
//
//   node scripts/record-app-fixtures.mjs [path/to/fitflexmobile]
//
// Reads build/regression_requests.json (what each role asked for, written
// by the test in RECORD mode), signs in with the dev mock login, fetches
// each GET as that role, trims long lists and writes
// test/fixtures/regression.json. GET only; nothing is changed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to record from ${BASE}: local backends only.`);
  process.exit(2);
}
const app = resolve(process.argv[2] || '../fitflexmobile');
const reqFile = resolve(app, 'build/regression_requests.json');
const outFile = resolve(app, 'test/fixtures/regression.json');
const DEV_ROLE = { member: 'member', trainer: 'trainer', gym_operator: 'owner', vendor: 'vendor' };
const MAX_ITEMS = 12;

const requested = existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, 'utf8')) : {};
const fixtures = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};

/** Keep fixtures small: long lists (top level or one level down) trimmed. */
function trim(v) {
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? x.slice(0, MAX_ITEMS) : x]));
  }
  return v;
}

let added = 0;
for (const [role, devRole] of Object.entries(DEV_ROLE)) {
  const login = await fetch(`${BASE}/auth/dev/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: devRole }),
  }).then(r => r.json());
  const token = login.token;
  const wanted = new Set(['GET /me', ...(requested[role] ?? [])]);
  const out = (fixtures[role] ??= {});
  for (const entry of wanted) {
    if (!entry.startsWith('GET ')) continue;
    const pathWithQuery = entry.slice(4);
    const key = `GET ${pathWithQuery.split('?')[0]}`;
    if (out[key] !== undefined) continue;
    const res = await fetch(BASE + pathWithQuery, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(`  ${role} ${entry} → HTTP ${res.status} (not recorded)`); continue; }
    out[key] = trim(await res.json());
    added += 1;
  }
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(fixtures, null, 1) + '\n');
console.log(`recorded ${added} new responses → ${outFile}`);
