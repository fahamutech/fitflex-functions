// B2B Phase 7, slice 1 against the CI database: job slots, locks, run
// records, catch-up and retry limits, pausing, exception records and their
// lifecycle, the real billing and integrity jobs, and who may do what.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bBillingService as billing, b2bFinanceService as finance,
  b2bCollectionsService, b2bAnalyticsService, b2bSponsorRefundService, signJwt as sign,
} from '../src/bootstrap/services.mjs';
import { b2bPrograms } from '../src/bootstrap/collections.mjs';
import { createOpsService, slotAt, nextDue, backoffMinutes, MAX_ATTEMPTS, MAX_MANUAL_RETRIES } from '../src/services/ops-service.mjs';
import { registerB2BJobs } from '../src/services/b2b-jobs.mjs';
import { monthBounds } from '../src/shared/b2b-programs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import {
  adminB2BOpsOverview, adminRunB2BJob, adminPauseB2BJob, adminListB2BExceptions, adminSetB2BExceptionStatus, adminRetryB2BException, adminB2BJobRuns,
} from '../functions/b2b.mjs';
import * as jobFunctions from '../functions/jobs.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], jobs: [] };
const TODAY = localDay(new Date());
const PERIOD = TODAY.slice(0, 7);
const LAST = (() => { const [y, m] = PERIOD.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const quiet = { warn() {}, error() {}, log() {} };

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Automation ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const OPERATOR = await user('admin');
const ADMIN = { userType: 'admin', userId: OPERATOR };
const access = organizationId => b2bService.resolveAccess({ organizationId, ...ADMIN });

/** An operations service on a clock the test moves, with one job of its own. */
function harness({ at = '2026-10-07T21:30:00.000Z', schedule = { type: 'daily', utc: '21:20' }, domain = 'operations', quietJob = false } = {}) {
  const clock = { now: new Date(at) };
  const ops = createOpsService({ db, now: () => clock.now, logger: quiet });
  const name = uid('t_job');
  made.jobs.push(name);
  const job = { calls: 0, impl: async () => ({ processed: 1 }) };
  ops.register({ name, title: 'Test job', schedule, domain, quiet: quietJob, run: async (ctx) => { job.calls += 1; return job.impl(ctx); } });
  const advance = (minutes) => { clock.now = new Date(+clock.now + minutes * 60_000); };
  const runs = () => db('JobRun').where({ job: name }).orderBy('startedAt');
  const live = () => db('OpsException').where({ job: name }).whereIn('status', ['open', 'investigating', 'retrying', 'permanently_failed']);
  return { ops, name, job, clock, advance, runs, live };
}

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  const jobNames = [...made.jobs, 'b2b-sponsor-billing', 'b2b-integrity-check'];
  await db('OpsException').whereIn('job', made.jobs).del();
  await db('OpsException').whereIn('organizationId', made.orgs).del();
  await db('OpsException').where('dedupeKey', 'like', 'dq:%').whereIn('jobRunId', db('JobRun').whereIn('triggeredBy', [...made.users]).select('id')).del();
  await db('JobRun').whereIn('job', made.jobs).del();
  await db('JobRun').whereIn('triggeredBy', made.users).del();
  await db('JobControl').whereIn('job', jobNames).del();
  await purgeB2BBilling(db, made.orgs);
  if (made.orgs.length) await db('B2BOrganization').whereIn('id', made.orgs).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-sponsor-billing']).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('rules: the slot a moment belongs to, when a job is next due, and how long to wait between attempts', () => {
  const daily = { type: 'daily', utc: '21:20' };
  assert.deepEqual([slotAt(daily, '2026-10-07T21:19:59Z').slot, slotAt(daily, '2026-10-07T21:20:00Z').slot, slotAt(daily, '2026-10-08T06:00:00Z').slot],
    ['2026-10-06T21:20Z', '2026-10-07T21:20Z', '2026-10-07T21:20Z']);
  assert.equal(slotAt(daily, '2026-01-01T00:00:00Z').slot, '2025-12-31T21:20Z');                 // across a year
  assert.equal(nextDue(daily, '2026-10-07T21:30:00Z').toISOString(), '2026-10-08T21:20:00.000Z');
  const every = { type: 'every', minutes: 5 };
  assert.deepEqual([slotAt(every, '2026-10-07T14:37:12Z').slot, nextDue(every, '2026-10-07T14:37:12Z').toISOString()], ['2026-10-07T14:35Z', '2026-10-07T14:40:00.000Z']);
  assert.deepEqual([1, 2, 3].map(backoffMinutes), [5, 15, 45]);
  assert.deepEqual([MAX_ATTEMPTS, MAX_MANUAL_RETRIES], [3, 5]);
});

// ── Job execution ────────────────────────────────────────────────────────────

test('a slot runs once: the record carries what happened, a second scheduled run is refused, a manual run still works', async () => {
  const h = harness();
  h.job.impl = async () => ({ processed: 7, failed: 2, note: 'kept' });
  const first = await h.ops.runJob(h.name);
  assert.deepEqual([first.status, first.slot, first.attempt, first.processed, first.succeeded, first.failed], ['ok', '2026-10-07T21:20Z', 1, 7, 5, 2]);
  const [row] = await h.runs();
  assert.deepEqual([row.status, row.slot, row.trigger, row.triggeredBy, row.attempt, row.processed, row.succeeded, row.failed, row.stats.note, !!row.finishedAt],
    ['ok', '2026-10-07T21:20Z', 'schedule', `system:${h.name}`, 1, 7, 5, 2, 'kept', true]);

  // The scheduler fires again (a second server, a restart): nothing runs.
  assert.deepEqual([(await h.ops.runJob(h.name)).skipped, (await h.ops.runJob(h.name, { trigger: 'catch_up' })).skipped, h.job.calls], ['already_ran', 'already_ran', 1]);
  // An operator can still run it by hand; that is recorded against them and audited.
  assert.equal((await h.ops.runJob(h.name, { trigger: 'manual' })).error, 'actor_required');
  const manual = await h.ops.runJob(h.name, { trigger: 'manual', actorId: OPERATOR });
  assert.deepEqual([manual.status, h.job.calls], ['ok', 2]);
  const rows = await h.runs();
  assert.deepEqual(rows.map(r => [r.trigger, r.slot, r.triggeredBy]), [['schedule', '2026-10-07T21:20Z', `system:${h.name}`], ['manual', null, OPERATOR]]);
  // Run by hand before the schedule got to it, the manual run is that slot's run: the scheduler and the sweeper then leave it.
  const early = harness();
  assert.equal((await early.ops.runJob(early.name, { trigger: 'manual', actorId: OPERATOR })).status, 'ok');
  assert.deepEqual([(await early.ops.runJob(early.name)).skipped, (await early.ops.sweep()).ran, early.job.calls, (await early.runs()).map(r => [r.trigger, r.slot])], ['already_ran', [], 1, [['manual', '2026-10-07T21:20Z']]]);
  assert.equal((await db('AuditLog').where({ action: 'ops.job.run', target: h.name, actor: OPERATOR })).length, 1);
  // The next day is a new slot.
  h.advance(24 * 60);
  assert.deepEqual([(await h.ops.runJob(h.name)).slot, h.job.calls], ['2026-10-08T21:20Z', 3]);
  assert.equal((await h.ops.runJob('no-such-job')).error, 'unknown_job');
});

test('two servers firing at the same moment: one run, one record', async () => {
  const h = harness();
  let release;
  const gate = new Promise((r) => { release = r; });
  h.job.impl = async () => { await gate; return { processed: 1 }; };
  const a = h.ops.runJob(h.name);
  await new Promise(r => setTimeout(r, 150));          // the first has the lock and is working
  const b = await h.ops.runJob(h.name);
  assert.equal(b.skipped, 'running_elsewhere');
  release();
  assert.equal((await a).status, 'ok');
  assert.deepEqual([h.job.calls, (await h.runs()).length], [1, 1]);
  // Ten at once: still one.
  h.advance(24 * 60);
  const many = await Promise.all(Array.from({ length: 10 }, () => h.ops.runJob(h.name)));
  assert.deepEqual([many.filter(r => r.status === 'ok').length, h.job.calls, (await h.runs()).filter(r => r.status === 'ok').length], [1, 2, 2]);
});

test('a failed run is recorded and raised, retried further apart each time, and cleared when it gets through', async () => {
  const h = harness({ domain: 'finance' });
  h.job.impl = async () => { throw new Error('database went away'); };
  const failed = await h.ops.runJob(h.name);
  assert.deepEqual([failed.status, failed.error, failed.attempt], ['failed', 'database went away', 1]);
  let [x] = await h.live();
  assert.deepEqual([x.type, x.severity, x.status, x.occurrences, x.detail.error, x.entityId], ['job_failed', 'high', 'open', 1, 'database went away', h.name]);

  // Too soon: the sweeper waits five minutes before the second attempt.
  h.advance(3);
  assert.deepEqual([(await h.ops.sweep()).waiting, h.job.calls], [[h.name], 1]);
  h.advance(3);
  assert.deepEqual([(await h.ops.sweep()).ran, h.job.calls], [[{ job: h.name, status: 'failed' }], 2]);
  [x] = await h.live();
  assert.deepEqual([x.occurrences, x.detail.attempt, (await h.live()).length], [2, 2, 1]);                // the same exception, seen twice
  // Then fifteen.
  h.advance(10);
  assert.equal((await h.ops.sweep()).waiting[0], h.name);
  h.job.impl = async () => ({ processed: 3 });
  h.advance(6);
  assert.deepEqual((await h.ops.sweep()).ran, [{ job: h.name, status: 'ok' }]);
  assert.deepEqual((await h.runs()).map(r => [r.status, r.trigger, r.attempt]), [['failed', 'schedule', 1], ['failed', 'retry', 2], ['ok', 'retry', 3]]);
  assert.equal((await h.live()).length, 0);
  const closed = await db('OpsException').where({ job: h.name }).first();
  assert.deepEqual([closed.status, closed.resolvedBy, !!closed.resolvedAt], ['resolved', `system:${h.name}`, true]);
  // Done for this slot: the sweeper leaves it alone.
  assert.deepEqual([(await h.ops.sweep()).ran, h.job.calls], [[], 3]);
});

test('after three failed attempts the slot is left for a person; a missed slot is caught up; a paused job is not', async () => {
  const h = harness();
  h.job.impl = async () => { throw new Error('still broken'); };
  await h.ops.runJob(h.name);
  h.advance(6); await h.ops.sweep();
  h.advance(16); await h.ops.sweep();
  assert.equal(h.job.calls, 3);
  h.advance(60);
  const gaveUp = await h.ops.sweep();
  assert.deepEqual([gaveUp.gaveUp, gaveUp.ran, h.job.calls, (await h.live())[0].status], [[h.name], [], 3, 'permanently_failed']);
  h.advance(600);
  assert.deepEqual([(await h.ops.sweep()).ran, h.job.calls], [[], 3]);                                    // no endless retrying
  const status = (await h.ops.jobStatus()).find(j => j.name === h.name);
  assert.deepEqual([status.state, status.currentSlotDone, status.attemptsThisSlot, status.lastRun.status, status.lastRun.error], ['failed', false, 3, 'failed', 'still broken']);

  // A server that was down at the scheduled minute: the sweeper runs the slot, but not within the first two minutes.
  const m = harness({ at: '2026-10-07T21:21:00.000Z' });
  assert.deepEqual([(await m.ops.sweep()).ran, m.job.calls], [[], 0]);
  m.advance(5);
  assert.deepEqual([(await m.ops.sweep()).ran, m.job.calls], [[{ job: m.name, status: 'ok' }], 1]);
  assert.deepEqual((await m.runs()).map(r => [r.trigger, r.status]), [['catch_up', 'ok']]);
  assert.equal((await m.ops.jobStatus()).find(j => j.name === m.name).state, 'ok');

  // Paused: the scheduler and the sweeper both skip it; an operator can still run it.
  const p = harness();
  assert.equal((await p.ops.setPaused({ name: p.name, paused: true, actorId: OPERATOR })).error, 'reason_required');
  await p.ops.setPaused({ name: p.name, paused: true, reason: 'Investigating', actorId: OPERATOR });
  assert.deepEqual([(await p.ops.runJob(p.name)).skipped, (await p.ops.sweep()).ran, p.job.calls], ['paused', [], 0]);
  assert.deepEqual((await p.ops.jobStatus()).find(j => j.name === p.name).state, 'paused');
  assert.equal((await p.ops.runJob(p.name, { trigger: 'manual', actorId: OPERATOR })).status, 'ok');
  await p.ops.setPaused({ name: p.name, paused: false, actorId: OPERATOR });
  p.advance(24 * 60);
  assert.equal((await p.ops.runJob(p.name)).status, 'ok');
  assert.deepEqual((await db('AuditLog').where({ target: p.name }).whereIn('action', ['ops.job.pause', 'ops.job.resume']).orderBy('at')).map(a => a.action), ['ops.job.pause', 'ops.job.resume']);
  made.jobs.push(p.name);
});

test('a run cut short by a server stopping is marked interrupted; a quiet job only keeps runs that did something', async () => {
  const h = harness();
  await db('JobRun').insert({ id: uid('run'), job: h.name, status: 'running', startedAt: new Date('2026-10-06T21:20:01Z'), slot: '2026-10-06T21:20Z', trigger: 'schedule', triggeredBy: `system:${h.name}`, attempt: 1 });
  assert.equal((await h.ops.runJob(h.name)).status, 'ok');
  assert.deepEqual((await h.runs()).map(r => [r.slot, r.status, r.error]), [['2026-10-06T21:20Z', 'failed', 'Interrupted: the server stopped during this run.'], ['2026-10-07T21:20Z', 'ok', null]]);

  const q = harness({ schedule: { type: 'every', minutes: 5 }, quietJob: true });
  q.job.impl = async () => ({ processed: 0 });
  await q.ops.runJob(q.name);
  assert.equal((await q.runs()).length, 0);
  q.advance(5);
  q.job.impl = async () => ({ processed: 4, failed: 1 });
  await q.ops.runJob(q.name);
  q.advance(5);
  q.job.impl = async () => { throw new Error('boom'); };
  await q.ops.runJob(q.name);
  assert.deepEqual((await q.runs()).map(r => [r.status, r.processed, r.failed]), [['ok', 4, 1], ['failed', null, 0]]);
  assert.equal((await q.ops.sweep()).checked >= 0, true);                                               // an every-N job is not caught up: its next tick does that
  assert.equal(q.job.calls, 3);
});

// ── Exceptions ───────────────────────────────────────────────────────────────

test('an item a job cannot handle becomes one exception, however often it recurs, and clears when the item goes through', async () => {
  const h = harness({ domain: 'finance' });
  const orgId = uid('org');
  let broken = true;
  h.job.impl = async (ctx) => {
    for (const id of ['prog_a', 'prog_b']) {
      const item = { entityType: 'program', entityId: id, key: 'usage:2026-09' };
      if (id === 'prog_b' && broken) await ctx.itemFailed({ ...item, organizationId: orgId, title: 'Could not prepare the invoice', error: new Error('rate missing') });
      else await ctx.itemOk(item);
    }
    return { processed: 2 };
  };
  const first = await h.ops.runJob(h.name);
  assert.deepEqual([first.status, first.processed, first.failed, first.succeeded], ['ok', 2, 1, 1]);     // the job finished; one item did not
  let [x] = await h.live();
  assert.deepEqual([x.type, x.severity, x.entityType, x.entityId, x.organizationId, x.detail.error, x.occurrences, x.jobRunId], ['job_item_failed', 'high', 'program', 'prog_b', orgId, 'rate missing', 1, first.runId]);
  h.advance(24 * 60);
  const second = await h.ops.runJob(h.name);
  [x] = await h.live();
  assert.deepEqual([(await h.live()).length, x.occurrences, x.jobRunId], [1, 2, second.runId]);
  broken = false;
  h.advance(24 * 60);
  await h.ops.runJob(h.name);
  assert.equal((await h.live()).length, 0);
  made.orgs.push(orgId);
});

test('exception lifecycle: investigating, resolved or ignored with a reason, reopened; retried at most five times; all audited', async () => {
  const h = harness();
  h.job.impl = async () => { throw new Error('upstream timeout'); };
  await h.ops.runJob(h.name);
  const [{ id }] = await h.live();
  const set = (status, resolution) => h.ops.setExceptionStatus({ id, status, resolution, actorId: OPERATOR });

  assert.equal((await set('investigating')).exception.status, 'investigating');
  assert.equal((await set('resolved')).error, 'resolution_required');
  assert.equal((await set('ignored', '  ')).error, 'resolution_required');
  assert.equal((await set('permanently_failed', 'x')).error, 'invalid_status');
  assert.equal((await h.ops.setExceptionStatus({ id, status: 'resolved', resolution: 'x' })).error, 'actor_required');
  const ignored = await set('ignored', 'Known outage at the provider, nothing to do');
  assert.deepEqual([ignored.exception.status, ignored.exception.resolvedBy, ignored.exception.resolution, !!ignored.exception.resolvedAt], ['ignored', OPERATOR, 'Known outage at the provider, nothing to do', true]);
  assert.equal((await h.ops.retryException({ id, actorId: OPERATOR })).error, 'exception_closed');
  const reopened = await set('open');
  assert.deepEqual([reopened.exception.status, reopened.exception.resolvedAt, reopened.exception.resolution], ['open', null, null]);
  assert.equal((await set('open')).unchanged, true);

  // Retrying runs the job; while it still fails the exception stays, and the count is capped.
  for (let i = 1; i <= MAX_MANUAL_RETRIES; i += 1) {
    const r = await h.ops.retryException({ id, actorId: OPERATOR });
    assert.deepEqual([r.run.status, r.exception.status, r.exception.retryCount], ['failed', 'open', i]);
  }
  assert.equal((await h.ops.retryException({ id, actorId: OPERATOR })).error, 'retry_limit_reached');
  assert.equal((await h.live()).length, 1);
  // Fixed underneath: the next run clears it without anyone closing it.
  h.job.impl = async () => ({ processed: 1 });
  await h.ops.runJob(h.name, { trigger: 'manual', actorId: OPERATOR });
  assert.equal((await db('OpsException').where({ id }).first()).status, 'resolved');
  assert.equal((await h.ops.setExceptionStatus({ id: 'opx_none', status: 'resolved', resolution: 'x', actorId: OPERATOR })).error, 'exception_not_found');

  const trail = (await db('AuditLog').where({ target: id, actor: OPERATOR }).orderBy('at')).map(a => a.action);
  assert.deepEqual(trail.filter(a => a !== 'ops.exception.retry'), ['ops.exception.investigating', 'ops.exception.ignored', 'ops.exception.open']);
  assert.equal(trail.filter(a => a === 'ops.exception.retry').length, MAX_MANUAL_RETRIES);
  const list = await h.ops.listExceptions({ query: { job: h.name, status: 'all' } });
  assert.deepEqual([list.total, list.items[0].status], [1, 'resolved']);
  assert.equal((await h.ops.listExceptions({ query: { job: h.name } })).total, 0);                       // live only by default
});

// ── The real jobs ────────────────────────────────────────────────────────────

test('billing drafts: a failure becomes an exception, the retry prepares the invoice once, and running twice never duplicates', async () => {
  const g = uid('gym');
  await gyms.insertAsync({ id: g, name: 'Automation Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(g);
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Automation ${uid('o')}` }, actorId: OPERATOR });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: OPERATOR });
  const a = await access(organization.id);
  const member = await user('member');
  await b2bService.enrollBeneficiary({ access: a, body: { userId: member, status: 'active' }, actorId: OPERATOR });
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Automation programme', startDate: '2026-01-01' }, actorId: OPERATOR });
  const { benefit } = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' }, actorId: OPERATOR });
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: benefit.id, status: 'active', actorId: OPERATOR });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: OPERATOR });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: OPERATOR });
  const { startDate } = monthBounds(LAST);
  for (const day of [startDate, addDays(startDate, 1)]) await usage.consume({ userId: member, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g, tier: 'standard' }, grossTzs: 5000, at: new Date(`${day}T09:00:00.000Z`) });

  // The same job definitions as production, over a billing service that fails for this programme until told otherwise,
  // and only this test's programme (other suites' data is not this test's to bill).
  let outage = true;
  const flaky = { ...billing, prepareUsage: async (args) => { if (outage && args.programId === program.id) throw new Error('connection reset'); return billing.prepareUsage(args); } };
  const ops = createOpsService({ db, logger: quiet });
  registerB2BJobs({ ops, db, programs: { filterByColumnAsync: async () => [await b2bPrograms.findByIdAsync(program.id)] },
    b2bProgramService, b2bConsumptionService: usage, b2bBillingService: flaky, b2bFinanceService: { prepareFeesDue: async () => ({ drafted: 0, failed: 0 }) },
    b2bSponsorRefundService: { repair: async () => ({ raised: 0 }) }, b2bCollectionsService, b2bAnalyticsService });
  const run = () => ops.runJob('b2b-sponsor-billing', { trigger: 'manual', actorId: OPERATOR });
  const invoices = () => db('B2BSponsorInvoice').where({ organizationId: organization.id, kind: 'usage', period: LAST });
  const live = () => db('OpsException').where({ organizationId: organization.id }).whereIn('status', ['open', 'retrying']);

  const first = await run();
  assert.deepEqual([first.status, first.failed >= 1, (await invoices()).length], ['ok', true, 0]);
  const [x] = await live();
  assert.deepEqual([x.type, x.severity, x.entityType, x.entityId, x.detail.error, x.detail.period, x.job], ['job_item_failed', 'high', 'program', program.id, 'connection reset', LAST, 'b2b-sponsor-billing']);

  // The operator retries from the exception once the outage is over.
  outage = false;
  const retried = await ops.retryException({ id: x.id, actorId: OPERATOR });
  assert.deepEqual([retried.run.status, retried.exception.status, retried.exception.retryCount], ['ok', 'resolved', 1]);
  const [invoice] = await invoices();
  assert.deepEqual([(await invoices()).length, invoice.status, invoice.totalTzs], [1, 'draft', 10000]);            // a draft: issuing stays with staff

  // The job again, and twice at once: one invoice, the same lines.
  await run();
  await Promise.all([run(), run()]);
  assert.deepEqual([(await invoices()).length, (await invoices())[0].totalTzs, (await db('B2BSponsorInvoiceLine').where({ invoiceId: invoice.id, active: true })).length], [1, 10000, 2]);
  assert.equal((await live()).length, 0);
  // Automated work is told apart from a person's: the draft is the job's, the run is the operator's.
  assert.deepEqual([(await db('JobRun').where({ job: 'b2b-sponsor-billing', triggeredBy: OPERATOR }))[0].trigger, invoice.createdBy], ['manual', 'system:b2b-sponsor-billing']);
});

test('the integrity check turns each data-quality problem into one exception and clears it when the check is clean again', async () => {
  const ops = createOpsService({ db, logger: quiet });
  let checks = [{ key: 'stale_holds', severity: 'medium', title: 'Usage still on hold after two days', count: 3, examples: ['c1', 'c2', 'c3'] }, { key: 'payment_over_allocated', severity: 'high', title: 'Payments over-allocated', count: 0, examples: [] }];
  registerB2BJobs({ ops, db, programs: b2bPrograms, b2bProgramService, b2bConsumptionService: usage, b2bBillingService: billing, b2bFinanceService: finance, b2bSponsorRefundService, b2bCollectionsService,
    b2bAnalyticsService: { ...b2bAnalyticsService, dataQuality: async () => ({ checkedAt: new Date().toISOString(), checks }) } });
  const key = `dq:stale_holds`;
  await db('OpsException').where({ dedupeKey: key }).whereIn('status', ['open', 'investigating', 'retrying', 'permanently_failed']).update({ status: 'resolved', resolvedAt: new Date(), resolvedBy: 'test', resolution: 'cleared for the test' });
  const run = () => ops.runJob('b2b-integrity-check', { trigger: 'manual', actorId: OPERATOR });
  const live = () => db('OpsException').where({ dedupeKey: key }).whereIn('status', ['open', 'investigating', 'retrying', 'permanently_failed']);

  const first = await run();
  assert.deepEqual([first.status, first.processed, first.failed, first.stats.issues], ['ok', 2, 0, 1]);            // finding problems is not the job failing
  let [x] = await live();
  assert.deepEqual([x.type, x.severity, x.title, x.detail.count, x.detail.examples, x.occurrences], ['data_quality', 'medium', 'Usage still on hold after two days: 3', 3, ['c1', 'c2', 'c3'], 1]);
  checks = [{ ...checks[0], count: 5, examples: ['c1'] }, checks[1]];
  await run();
  [x] = await live();
  assert.deepEqual([(await live()).length, x.title, x.detail.count, x.occurrences], [1, 'Usage still on hold after two days: 5', 5, 2]);
  // Nothing was repaired; the exception clears only when the check does.
  checks = [{ ...checks[0], count: 0, examples: [] }, checks[1]];
  await run();
  assert.equal((await live()).length, 0);
  await db('OpsException').where({ dedupeKey: key, resolvedBy: 'system:b2b-integrity-check' }).del();
});

// ── Scheduler wiring and security ────────────────────────────────────────────

test('the scheduler entries run through the operations service, and only staff with the right grant can act', async () => {
  for (const [fn, rule] of [['b2bProgramExpiry', '5 21 * * *'], ['b2bHoldReconciler', '*/5 * * * *'], ['b2bSponsorBilling', '20 21 * * *'], ['b2bCollections', '0 6 * * *'], ['b2bSponsorVisibilityNotice', '0 7 * * *'], ['b2bIntegrityCheck', '0 22 * * *'], ['b2bBeneficiaryInvites', '*/10 * * * *'], ['opsSweeper', '*/10 * * * *']]) {
    assert.deepEqual([jobFunctions[fn].rule, typeof jobFunctions[fn].onJob], [rule, 'function'], fn);
  }
  // The schedule the operations service believes matches the scheduler's own rule.
  const overview = await call(adminB2BOpsOverview, { claims: { sub: OPERATOR, userType: 'admin' } });
  assert.equal(overview.statusCode, 200);
  const byName = Object.fromEntries(overview.body.jobs.items.map(j => [j.name, j]));
  assert.deepEqual(Object.keys(byName).sort(), ['b2b-beneficiary-invites', 'b2b-collections', 'b2b-hold-reconciler', 'b2b-integrity-check', 'b2b-program-expiry', 'b2b-sponsor-billing', 'b2b-sponsor-visibility-notice', 'promotion-events-retention', 'promotion-lifecycle']);
  assert.deepEqual([byName['b2b-sponsor-billing'].schedule, byName['b2b-sponsor-billing'].domain, byName['b2b-hold-reconciler'].schedule], [{ type: 'daily', utc: '21:20' }, 'finance', { type: 'every', minutes: 5 }]);
  assert.deepEqual(Object.keys(overview.body.pending).sort(), ['billing', 'people', 'usage']);
  assert.ok(Number.isInteger(overview.body.pending.billing.draftInvoices) && Number.isInteger(overview.body.exceptions.live));

  const member = { sub: await user('member'), userType: 'member' };
  const staff = scopes => ({ sub: OPERATOR, userType: 'admin', portalUser: true, aclPermissions: scopes });
  for (const route of [adminB2BOpsOverview, adminListB2BExceptions, adminRunB2BJob, adminPauseB2BJob, adminSetB2BExceptionStatus, adminRetryB2BException, adminB2BJobRuns]) {
    assert.equal((await call(route, { claims: member, params: { job: 'b2b-program-expiry', exceptionId: 'x' } })).statusCode, 403, route.path);
    assert.equal((await call(route, { params: { job: 'b2b-program-expiry', exceptionId: 'x' } })).statusCode, 401, route.path);
  }
  // Billing staff can look; running, pausing and closing need the b2b grant.
  assert.equal((await call(adminB2BOpsOverview, { claims: staff(['b2b_payments']) })).statusCode, 200);
  assert.equal((await call(adminRunB2BJob, { claims: staff(['b2b_payments', 'b2b_billing']), params: { job: 'b2b-program-expiry' } })).body.requiredScope, 'b2b');
  assert.equal((await call(adminPauseB2BJob, { claims: staff(['b2b_billing_approve']), params: { job: 'b2b-program-expiry' }, body: { paused: true, reason: 'x' } })).body.requiredScope, 'b2b');
  assert.equal((await call(adminB2BOpsOverview, { claims: staff(['payments']) })).statusCode, 403);

  // A finance exception is closed or retried only by someone who may approve billing.
  const ops = createOpsService({ db, logger: quiet });
  const { exception: money } = await ops.raise({ type: 'data_quality', severity: 'high', title: 'Test finance problem', dedupeKey: uid('dq:test'), entityType: 'check', entityId: 'test' });
  const { exception: other } = await ops.raise({ type: 'job_item_failed', severity: 'low', title: 'Test operations problem', dedupeKey: uid('item:test'), job: 'b2b-program-expiry' });
  const close = (claims, id) => call(adminSetB2BExceptionStatus, { claims, params: { exceptionId: id }, body: { status: 'resolved', resolution: 'Checked by hand' } });
  assert.deepEqual([(await close(staff(['b2b']), money.id)).statusCode, (await close(staff(['b2b']), money.id)).body.requiredScope], [403, 'b2b_billing_approve']);
  assert.equal((await call(adminRetryB2BException, { claims: staff(['b2b']), params: { exceptionId: money.id } })).body.requiredScope, 'b2b_billing_approve');
  assert.equal((await close(staff(['b2b']), other.id)).body.exception.status, 'resolved');
  assert.equal((await close(staff(['b2b', 'b2b_billing_approve']), money.id)).body.exception.status, 'resolved');
  assert.equal((await close(staff(['b2b']), 'opx_missing')).statusCode, 404);
  const listed = await call(adminListB2BExceptions, { claims: staff(['b2b_billing']), query: { status: 'resolved', type: 'data_quality' } });
  assert.ok(listed.body.items.some(e => e.id === money.id && e.resolvedBy === OPERATOR));
  assert.equal((await call(adminB2BJobRuns, { claims: staff(['b2b']), params: { job: 'nope' } })).statusCode, 404);
  // A run's own outcome is in the body: a job that ran, or failed, is still a request that worked.
  const ran = await call(adminRunB2BJob, { claims: staff(['b2b']), params: { job: 'b2b-program-expiry' } });
  assert.deepEqual([ran.statusCode, ran.body.outcome, ran.body.failure, typeof ran.body.processed, 'status' in ran.body && ran.body.status !== undefined], [200, 'ok', null, 'number', false]);
  assert.equal((await call(adminRunB2BJob, { claims: staff(['b2b']), params: { job: 'nope' } })).statusCode, 404);
  await db('JobRun').where({ job: 'b2b-program-expiry', triggeredBy: OPERATOR }).del();
  await db('OpsException').whereIn('id', [money.id, other.id]).del();
});
