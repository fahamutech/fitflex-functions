import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { harness, s6On, db } from './fixtures/events-s6.mjs';

await ensureInit();
const h = harness();
after(async () => { await h.cleanup(); await db.destroy(); });

test('smoke: import, verify, release, myResult', async () => {
  s6On();
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n: 3 });
  const a = h.actors(o);
  const imp = await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:55:00', ''], ['1003', 'dnf', '', '']]));
  assert.equal(imp.status, 201, JSON.stringify(imp));
  const row = await h.current(f.regs[0].id);
  assert.equal(row.verificationStatus, 'pending_verification');
  const v = await h.service.verify({ actor: a.owner, organizerId: o.id, eventId: f.event.id, resultId: row.id, key: h.key(), body: { expectedRevision: 1 } });
  assert.equal(v.status, 200, JSON.stringify(v));
  const sum = await h.service.summary({ actor: a.owner, organizerId: o.id, eventId: f.event.id });
  console.log(JSON.stringify(sum.perCategory[0]));
  const prev = await h.service.releasePreview({ actor: a.owner, organizerId: o.id, eventId: f.event.id, body: { stage: 'provisional' } });
  console.log(JSON.stringify(prev));
  const rel = await h.service.release({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { stage: 'provisional', previewHash: prev.previewHash } });
  assert.equal(rel.status, 200, JSON.stringify(rel));
  const mine = await h.service.myResult({ userId: f.regs[0].userId, registrationId: f.regs[0].id });
  console.log(JSON.stringify(mine).slice(0, 900));
  const list = await h.service.list({ actor: a.owner, organizerId: o.id, eventId: f.event.id, query: {} });
  assert.equal(list.items.length, 3);
  console.log(JSON.stringify(list.items[0]));
});
