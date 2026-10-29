// Shared fixture for the S6 specs (CI database only). It wraps the S5 harness: the five S6 flags, an organizer with staff of every role,
// an event that is IN PROGRESS with confirmed, claimed registrations that have bibs (two categories), and a cleanup that removes every S6
// row (results, releases, disputes, links, awards, tasks, artwork) before the S5/S4/S3 cleanups remove the registrations they point at.
// The reward ledger is append-only: a deleted user leaves anonymised rows behind (that is the design), so ledger specs filter by definition.
import { harness as harness5, s5On, s5Off, db, uid, phone, D, H } from './events-s5.mjs';
import { randomUUID } from 'node:crypto';
import { eventsResultsService } from '../../src/bootstrap/services.mjs';

export { uid, phone, D, H, db };
export const S6_ENV = ['EVENTS_RESULTS', 'EVENTS_RUNS', 'EVENTS_RESULTS_PUBLIC', 'EVENTS_REWARDS', 'EVENTS_MEDAL_ART', 'EVENTS_RUN_DISTANCE_TOLERANCE_BPS', 'EVENTS_RUN_LINK_MAX_DAYS_AFTER',
  'EVENTS_RESULTS_IMPORT_MAX_ROWS', 'EVENTS_RESULTS_DISPUTE_DEFAULT_HOURS', 'EVENTS_AWARD_BATCH', 'EVENTS_RESULTS_PUSH_MAX', 'EVENTS_MEDAL_ART_MAX_BYTES', 'EVENTS_MEDAL_ART_MAX_PIXELS',
  'EVENTS_MEDAL_ART_UPLOADS_PER_DAY', 'EVENTS_RESULTS_CONSENT_VERSIONS'];

/** The S5 flags plus the S6 ones asked for (results on by default). */
export function s6On({ results = true, runs = false, pub = false, rewards = false, medalArt = false, api = true } = {}) {
  s5On({ api, kit: true, webhooks: false });
  if (results) process.env.EVENTS_RESULTS = '1';
  if (runs) process.env.EVENTS_RUNS = '1';
  if (pub) process.env.EVENTS_RESULTS_PUBLIC = '1';
  if (rewards) process.env.EVENTS_REWARDS = '1';
  if (medalArt) process.env.EVENTS_MEDAL_ART = '1';
}
export function s6Off() {
  for (const k of S6_ENV) delete process.env[k];
  s5Off();
}

export function harness() {
  const base = harness5();
  const made6 = { events: [], users: [] };

  /**
   * An event in progress (started 2 h ago, ends in 4 h) with `n` confirmed, claimed registrations in the first category (10K) and `m` in the
   * second (5K), each with a bib 1001… (10K) and 2001… (5K). → { …kitEvent, regs10, regs5, all }.
   */
  async function resultsEvent({ n = 4, m = 0, eventOver = {}, organizer = null, categories = null } = {}) {
    const f = await base.kitEvent({ n, organizer, categories, eventOver });
    made6.events.push(f.event.id);
    const startsAt = eventOver.startsAt ?? new Date(Date.now() - 2 * H);
    await db('Event').where({ id: f.event.id }).update({ status: 'in_progress', startsAt, endsAt: eventOver.endsAt ?? new Date(+startsAt + 6 * H), publishedAt: new Date(+startsAt - 20 * D) });
    const regs5 = m ? await base.addRegistrations({ eventId: f.event.id, ticketType: f.categories[1].tickets[0], n: m }) : [];
    f.regs.forEach((r, i) => { r.bib = String(1001 + i); });
    regs5.forEach((r, i) => { r.bib = String(2001 + i); });
    for (const r of [...f.regs, ...regs5]) await db('EventRegistration').where({ id: r.id }).update({ bibNumber: r.bib, resultsVisibility: 'standard', consentTextVersion: 'spec-clause-v1' });
    process.env.EVENTS_RESULTS_CONSENT_VERSIONS = 'spec-clause-v1';
    return { ...f, regs10: f.regs, regs5, all: [...f.regs, ...regs5], categoryIds: f.categories.map(c => c.id) };
  }

  const user = async (opts = {}) => { const id = await base.user(opts); made6.users.push(id); return id; };

  /** The organizer actors the service takes (what the route builds from the JWT). */
  const actors = o => ({
    owner: { kind: 'staff', userId: o.ownerUserId, role: 'owner', requestId: 'req_spec_owner' },
    admin: { kind: 'staff', userId: o.admin.sub, role: 'admin', requestId: 'req_spec_admin' },
    timing: { kind: 'staff', userId: o.timing.sub, role: 'timing', requestId: 'req_spec_timing' },
    ops: { kind: 'staff', userId: o.ops.sub, role: 'ops', requestId: 'req_spec_ops' },
    finance: { kind: 'staff', userId: o.finance.sub, role: 'finance', requestId: 'req_spec_fin' },
  });
  const key = () => `k_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  /** Import a CSV and apply it as `actor` (preview first, like the portal). */
  async function importCsv(f, actor, csv, { sourceType = 'timing_provider', sourceLabel = 'ChipTime Ltd' } = {}) {
    const body = { csv, sourceType, sourceLabel };
    const preview = await eventsResultsService.importPreview({ actor, organizerId: f.organizer.id, eventId: f.event.id, body });
    if (preview.error) return preview;
    return eventsResultsService.importApply({ actor, organizerId: f.organizer.id, eventId: f.event.id, key: key(), body: { ...body, previewHash: preview.previewHash } });
  }
  const csvOf = rows => `bib,status,net_time,gun_time\n${rows.map(r => r.join(',')).join('\n')}\n`;

  const current = registrationId => db('EventResult').where({ registrationId, isCurrent: true }).first();

  async function cleanup() {
    const events = [...base.made.events];
    if (events.length) {
      const regIds = (await db('EventRegistration').whereIn('eventId', events).select('id')).map(r => r.id);
      const templateIds = (await db('EventMedalTemplate').whereIn('eventId', events).select('id')).map(r => r.id);
      await db('EventAwardTask').whereIn('eventId', events).del();
      if (templateIds.length) {
        await db('EventMedalTemplate').whereIn('id', templateIds).update({ artId: null });
        await db('EventMedalArtFile').whereIn('artId', db('EventMedalArt').whereIn('eventId', events).select('id')).del();
        await db('EventMedalArt').whereIn('eventId', events).del();
      }
      await db('EventMedalAward').whereIn('eventId', events).del();
      await db('EventMedalTemplate').whereIn('eventId', events).del();
      if (regIds.length) {
        await db('EventResultDispute').whereIn('registrationId', regIds).del();
        await db('EventResult').whereIn('registrationId', regIds).del();
        await db('EventActivityLink').whereIn('registrationId', regIds).del();
      }
      await db('EventResultImport').whereIn('eventId', events).del();
      await db.transaction(async (trx) => {
        await trx.raw('ALTER TABLE "EventResultRelease" DISABLE TRIGGER ALL');
        await trx('EventResultRelease').whereIn('eventId', events).del();
        await trx.raw('ALTER TABLE "EventResultRelease" ENABLE TRIGGER ALL');
      });
      await db('RewardDefinition').where('triggerEventId', 'in', events).update({ status: 'ended', triggerEventId: null }).catch(() => {});
    }
    await base.cleanup();
    s6Off();
  }

  return { ...base, user, resultsEvent, actors, key, importCsv, csvOf, current, cleanup, made6, service: eventsResultsService };
}
