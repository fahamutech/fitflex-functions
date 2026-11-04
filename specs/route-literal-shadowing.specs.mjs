// Literal routes hidden behind a parameter route (functions#<this PR>).
//
// bfast-function loads every file under functions/ and mounts each file's exports in ALPHABETICAL order (a module
// namespace object lists its exports sorted by name), guards first (app.use(path, guard)), then the handlers
// (app[method](path, handler)). So in one file, GET /events/:idOrSlug (`eventDetail`) is mounted before
// GET /events/options (`eventsOptions`), and the parameter route answers the literal one — guard included.
// Declaring the literal route first in the file does not help.
//
// 1. The inventory: every literal route that a parameter route of the same method, in the same file, would answer
//    first. Each one must handle the fixed word itself (and is listed here once that is checked). A new pair fails
//    this spec until its parameter route handles the word.
// 2. The real mount: the functions are mounted the way bfast-function mounts them and the two routes fixed here are
//    requested over HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getFunctions, extractGuards, extractHttpFunctions, mountGuards, mountHttpRoutes } from 'bfast-function';
import { sign } from '../src/auth/jwt.mjs';

const FUNCTIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'functions');

// Reviewed pairs: the parameter route's handler gives the fixed word its own meaning (and the guards agree).
const HANDLED = new Set([
  'GET /admin/events/organizers <- /admin/events/:id',
  'GET /events/options <- /events/:idOrSlug',
  'GET /me/training-plans/offers <- /me/training-plans/:id',
  'GET /organizer/events/:id/results/imports <- /organizer/events/:id/results/:registrationId',
  'GET /organizer/events/:id/results/summary <- /organizer/events/:id/results/:registrationId',
]);

const routeRe = path => new RegExp(`^${path.replace(/\/:[^/]+/g, '/[^/]+')}/?$`);
const literalCount = path => path.split('/').filter(s => s && !s.startsWith(':')).length;

test('every literal route that a same-file parameter route would answer first is handled by that route', async () => {
  const found = [];
  for (const file of readdirSync(FUNCTIONS).filter(f => f.endsWith('.mjs')).sort()) {
    const mod = await import(join(FUNCTIONS, file));
    // Object.keys of a module namespace: the order bfast-function mounts them in.
    const routes = Object.keys(mod).map(name => ({ name, r: mod[name] }))
      .filter(({ r }) => r && typeof r === 'object' && typeof r.onRequest === 'function' && typeof r.path === 'string')
      .map(({ name, r }) => ({ name, method: String(r.method || 'all').toUpperCase(), path: r.path }));
    routes.forEach((param, i) => {
      if (!param.path.includes('/:')) return;
      for (const lit of routes.slice(i + 1)) {
        if (lit.path === param.path || (lit.method !== param.method && param.method !== 'ALL')) continue;
        if (literalCount(lit.path) <= literalCount(param.path)) continue;
        if (!routeRe(param.path).test(lit.path.replace(/\/:[^/]+/g, '/p'))) continue;
        found.push(`${lit.method} ${lit.path} <- ${param.path}`);
      }
    });
  }
  const unhandled = found.filter(x => !HANDLED.has(x));
  assert.deepEqual(unhandled, [], `make the parameter route handle the fixed word (see events-public.mjs eventDetail), then list it:\n${unhandled.join('\n')}`);
  assert.deepEqual([...HANDLED].filter(x => !found.includes(x)), [], 'a listed pair no longer exists: remove it from HANDLED');
});

let server;
after(async () => { if (server) await new Promise(r => server.close(r)); });

async function mounted() {
  if (server) return server.address().port;
  const app = express();
  app.use(express.json());
  const fns = await getFunctions({ functionsDirPath: FUNCTIONS });
  mountGuards(extractGuards(fns), fns, app);
  mountHttpRoutes(extractHttpFunctions(fns), fns, app);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  return server.address().port;
}

test('mounted as bfast-function mounts it: GET /events/options answers the probe, with the events module on or off', async () => {
  const port = await mounted();
  const prior = process.env.EVENTS_MODULE;
  try {
    process.env.EVENTS_MODULE = 'true';
    const on = await fetch(`http://127.0.0.1:${port}/events/options`);
    assert.equal(on.status, 200);
    assert.equal((await on.json()).discovery, true);
    delete process.env.EVENTS_MODULE;
    const off = await fetch(`http://127.0.0.1:${port}/events/options`);
    assert.equal(off.status, 200, 'the probe never 404s');
    assert.equal((await off.json()).discovery, false);
    // A real event id or slug still goes to the detail route (module off: its guard answers).
    const detail = await fetch(`http://127.0.0.1:${port}/events/no-such-event`);
    assert.equal(detail.status, 404);
    assert.equal((await detail.json()).error, 'feature_disabled');
  } finally {
    if (prior === undefined) delete process.env.EVENTS_MODULE; else process.env.EVENTS_MODULE = prior;
  }
});

test('mounted as bfast-function mounts it: GET /admin/events/organizers lists organizers and keeps the admin guard', async () => {
  const port = await mounted();
  const prior = process.env.EVENTS_MODULE;
  try {
    process.env.EVENTS_MODULE = 'true';
    const admin = sign({ sub: 'usr_route_shadow_admin', userType: 'admin' });
    const ok = await fetch(`http://127.0.0.1:${port}/admin/events/organizers`, { headers: { authorization: `Bearer ${admin}` } });
    const body = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.items), 'the organizer list, not event_not_found');
    const member = sign({ sub: 'usr_route_shadow_member', userType: 'member' });
    const refused = await fetch(`http://127.0.0.1:${port}/admin/events/organizers`, { headers: { authorization: `Bearer ${member}` } });
    assert.equal(refused.status, 403);
    const none = await fetch(`http://127.0.0.1:${port}/admin/events/organizers`);
    assert.equal(none.status, 401);
  } finally {
    if (prior === undefined) delete process.env.EVENTS_MODULE; else process.env.EVENTS_MODULE = prior;
  }
});
