// Marathon & running events · S6 — results (spec §3, §5.5, §6, §8.1–8.3). One service behind four front doors: the portal's organizer
// routes (a staff user), the FitFlex admin routes, the /v1 routes (an API client), and the member app. The caller is an `actor`:
//   { kind: 'staff', userId, role }      role from EventOrganizerStaff (owner | admin | ops | timing | finance)
//   { kind: 'admin', userId }            a FitFlex portal admin with the `events` scope (exception paths only, D59)
//   { kind: 'api', clientId, scopes }    scopes read from the ApiClient row on this very request
// Role and scope are checked HERE as well as in the route guard (least privilege).
//
// Rules this file owns:
//  - A result is a ROW of EventResult; a revision is a new row (the old one stops being current in the same transaction). Verified
//    and corrected rows need a human (the table's CHECK), so an import, an entry, a GPS submission or an API call can only ever
//    create `pending_verification` rows — plus settled DNF / DNS rows from a staff member (they carry no time).
//  - Release (provisional / official) is its own append-only history; ranks are computed by the server on official release and on
//    any change that alters a finished time. A file's own rank column is ignored (D52).
//  - Every state change writes its outbox row in the SAME transaction (result.verified | published | corrected | disputed), so a
//    failed outbox write rolls the change back. Write routes are idempotent through OrganizerIdempotency.
//  - Organizers never receive a phone, email, date of birth or route (D36): rows identify people by name (confirmed places only), bib and id.
import { randomUUID } from 'node:crypto';
import { assertTransition } from '../shared/events-lifecycle.mjs';
import {
  FINISH_STATUSES, IMPORT_SOURCES, REJECT_REASONS, CORRECT_REASONS, DQ_REASONS, DISPUTE_REASONS, VISIBILITIES, SETTLED_VERIFICATIONS, sha256hex,
  parseTime, rankingTime, deriveStage, registrationStatusOf, categoryStage, computeRanks, visibilityOf, boardName, boardTreatedAsMinor,
  policyOf, rulesOf, validateSettings, ANONYMOUS,
} from '../shared/events-results-rules.mjs';
import { parseResultsCsv, STATUS_WORDS } from '../shared/events-results-csv.mjs';
import { encodeCursor, decodeCursor, parseLimit, normaliseBib, cardName, neutralise } from '../shared/events-ops-rules.mjs';
import { createIdempotency } from '../shared/organizer-idempotency.mjs';
import { enqueueAwardTask, enqueueAwardTasks } from '../shared/events-award-queue.mjs';
import { COPY } from '../shared/events-results-copy.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const num = v => (v === null || v === undefined ? null : Number(v));
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const UNIQUE = '23505';
const OPEN_FOR_RESULTS = ['in_progress', 'completed'];
const LIVE_EVENT = ['published', 'registration_closed', 'in_progress', 'completed'];
const DAY = 86_400_000;
const STAFF_READ = ['owner', 'admin', 'timing'];
const STAFF_DECIDE = ['owner', 'admin'];
const PENDING = 'pending_verification';

export function createEventsResultsService({
  db, eventStore, notice = async () => {}, localeOf = async () => null, now = () => new Date(),
  importMaxRows = () => 5000, disputeDefaultHours = () => 168, pushMax = () => 500, clauseVersions = () => [], awardsOn = () => true, rewardsOn = () => false,
}) {
  const stamp = () => new Date(now());
  const idempotent = createIdempotency({ db, now });
  const actorKey = a => (a.kind === 'api' ? `api:${a.clientId}` : a.userId);

  const audit = (actor, action, target, before, after, q = db) => q('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: typeof actor === 'string' ? actor : actorKey(actor), action, target,
    before: before == null ? null : JSON.stringify(before),
    after: after == null ? null : JSON.stringify(typeof actor !== 'string' && actor.requestId ? { ...after, requestId: actor.requestId } : after),
  });
  const analytics = async (name, payload) => { try { await audit('system', `analytics.${name}`, payload.eventId ?? 'events', null, payload); } catch { /* best effort */ } };
  const outbox = (trx, event, type, aggregateType, aggregateId, payload) => eventStore.appendOutbox(trx, { type, aggregateType, aggregateId, organizerId: event.organizerId, eventId: event.id, payload });
  const lockEvent = (trx, eventId) => trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`evres:${eventId}`]);

  // ── Access ────────────────────────────────────────────────────────────────

  /** level: 'read' | 'submit' (import / enter) | 'decide' (verify, release, correct …). */
  function allowed(actor, level) {
    if (actor.kind === 'admin') return level === 'read';
    if (actor.kind === 'api') return level === 'read' ? actor.scopes?.includes('results:read') : level === 'submit' ? actor.scopes?.includes('results:write') : false;
    return level === 'decide' ? STAFF_DECIDE.includes(actor.role) : STAFF_READ.includes(actor.role);
  }

  /** The event of an organizer (or any event for a FitFlex admin), with its categories. */
  async function load({ organizerId = null, eventId, q: conn = db }) {
    const q = conn('Event').where({ id: String(eventId) });
    if (organizerId) q.where({ organizerId });
    const event = plain(await q.first());
    if (!event) return null;
    const categories = (await conn('EventCategory').where({ eventId: event.id }).orderBy('distanceMeters', 'desc').orderBy('name')).map(plain);
    return { event, categories };
  }

  const releaseRowsOf = async (q, eventId) => (await q('EventResultRelease').where({ eventId }).orderBy('seq')).map(plain);

  /** categoryId → 'none' | 'provisional' | 'official'. */
  async function stagesOf(q, event, categories) {
    const rows = await releaseRowsOf(q, event.id);
    return { rows, byCategory: new Map(categories.map(c => [c.id, categoryStage(rows, c.id)])) };
  }
  const latestRelease = (rows, categoryId) => {
    const own = rows.filter(r => r.categoryId === categoryId && r.action === 'release');
    const wide = rows.filter(r => !r.categoryId && r.action === 'release');
    const pick = [...own, ...wide].sort((a, b) => Number(b.seq) - Number(a.seq))[0] ?? null;
    return pick ? { stage: pick.stage, releasedAt: iso(pick.releasedAt), releasedBy: pick.releasedBy } : null;
  };

  const settingsOf = (event, categories) => {
    const policy = policyOf(event, disputeDefaultHours());
    const first = rulesOf(categories[0]);
    return { timeBasis: first.timeBasis, cutoffMinutes: first.cutoffMinutes, disputeWindowHours: policy.disputeWindowHours, publicNames: policy.publicNames };
  };

  // ── Writing a revision ────────────────────────────────────────────────────

  /**
   * Insert the next revision of a registration's result (the current row stops being current first), and mirror it on the
   * registration. Runs in the caller's transaction. `input`: { sourceType, sourceLabel, sourceReference, finishStatus, netMs, gunMs,
   * verificationStatus, verifiedBy, reasonCode, correctionReason, activityLinkId, distanceMeters, importId, submittedByUserId,
   * submittedByApiClientId, basis }.
   */
  async function writeRevision(trx, { category, reg, prev, input }) {
    const at = stamp();
    const rules = rulesOf(category);
    const elapsed = input.finishStatus === 'finished' || input.keepTimes ? rankingTime({ netMs: input.netMs ?? null, gunMs: input.gunMs ?? null }, input.basis ?? rules.timeBasis) : null;
    const settled = SETTLED_VERIFICATIONS.includes(input.verificationStatus) || input.verificationStatus === 'disqualified';
    const withinCutoff = input.finishStatus === 'finished' && rules.cutoffMinutes && elapsed !== null ? elapsed <= rules.cutoffMinutes * 60_000 : null;
    let revision = 1;
    if (prev) {
      const max = await trx('EventResult').where({ registrationId: reg.id }).max({ n: 'revision' }).first();
      revision = Number(max.n) + 1;
      await trx('EventResult').where({ id: prev.id }).update({ isCurrent: false, updatedAt: at });
    }
    const row = {
      id: newId('eres'), registrationId: reg.id, sourceType: input.sourceType, sourceReference: input.sourceReference ?? null, sourceLabel: input.sourceLabel ?? null,
      distanceMeters: input.distanceMeters ?? num(category.distanceMeters), elapsedMs: elapsed, netElapsedMs: input.netMs ?? null, gunElapsedMs: input.gunMs ?? null,
      finishStatus: input.finishStatus, verificationStatus: input.verificationStatus, verifiedBy: settled ? (input.verifiedBy ?? null) : null, verifiedAt: settled ? at : null,
      correctionReason: input.correctionReason ?? null, reasonCode: input.reasonCode ?? null, revision, isCurrent: true, withinCutoff,
      importId: input.importId ?? null, submittedByUserId: input.submittedByUserId ?? null, submittedByApiClientId: input.submittedByApiClientId ?? null,
      activityLinkId: input.activityLinkId ?? null, createdAt: at, updatedAt: at,
    };
    const [inserted] = await trx('EventResult').insert(row).returning('*');
    await trx('EventRegistration').where({ id: reg.id }).update({ resultStatus: registrationStatusOf(inserted), updatedAt: at });
    return plain(inserted);
  }

  /** Recompute ranks for the whole event (only categories with an official release get ranks). → registrations whose rank changed. */
  async function recomputeRanks(trx, event, categories) {
    const { byCategory } = await stagesOf(trx, event, categories);
    const official = new Set([...byCategory].filter(([, s]) => s === 'official').map(([id]) => id));
    const rows = (await trx('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').join('EventCategory as c', 'c.id', 'r.categoryId')
      .where('r.eventId', event.id).where('e.isCurrent', true).where('r.status', 'confirmed')
      .select('e.id', 'e.registrationId', 'e.overallRank', 'e.categoryRank', 'e.verificationStatus', 'e.finishStatus', 'e.elapsedMs', 'e.withinCutoff', 'r.categoryId', 'c.distanceMeters')).map(plain);
    const ranks = computeRanks(rows.map(r => ({ ...r, distanceMeters: r.distanceMeters })), official);
    const at = stamp();
    const changed = [];
    for (const r of rows) {
      const next = ranks.get(r.id);
      if (next.overallRank === r.overallRank && next.categoryRank === r.categoryRank) continue;
      await trx('EventResult').where({ id: r.id }).update({ overallRank: next.overallRank, categoryRank: next.categoryRank, ranksComputedAt: at, updatedAt: at });
      changed.push(r.registrationId);
    }
    return changed;
  }

  /** After a change to a finished time (or a verification) in a category that is already official: queue award tasks. */
  async function queueAwards(trx, event, registrationIds, reason = 'result_changed') {
    if (!registrationIds.length) return;
    await enqueueAwardTasks(trx, { eventId: event.id, registrationIds, reason, at: stamp() });
  }

  const regOf = (q, id, eventId) => q('EventRegistration').where({ id: String(id), eventId }).first();

  // ── Views ─────────────────────────────────────────────────────────────────

  const rowView = (row, reg, category, { stages, flags = [], disputeOpen = false, full = true }) => {
    const stage = deriveStage({ row, release: stages.get(reg.categoryId) ?? 'none', disputeOpen });
    return {
      registrationId: reg.id, displayName: full ? `${reg.firstName ?? ''} ${reg.lastName ?? ''}`.trim() : cardName(reg.firstName, reg.lastName), bibNumber: reg.bibNumber ?? null,
      categoryId: reg.categoryId, categoryName: category?.name ?? null,
      resultId: row?.id ?? null, revision: row?.revision ?? null, finishStatus: row?.finishStatus ?? null, verificationStatus: row?.verificationStatus ?? null, stage,
      sourceType: row?.sourceType ?? null, sourceLabel: row?.sourceLabel ?? null,
      netElapsedMs: num(row?.netElapsedMs), gunElapsedMs: num(row?.gunElapsedMs), elapsedMs: num(row?.elapsedMs),
      overallRank: row?.overallRank ?? null, categoryRank: row?.categoryRank ?? null, withinCutoff: row?.withinCutoff ?? null,
      flags, disputeOpen, updatedAt: iso(row?.updatedAt ?? reg.updatedAt),
    };
  };

  async function flagsFor(q, registrationIds) {
    if (!registrationIds.length) return new Map();
    const links = await q('EventActivityLink').whereIn('registrationId', registrationIds).where({ linkType: 'event_run' }).whereNull('unlinkedAt').whereNot({ matchStatus: 'rejected' }).select('registrationId', 'flags');
    return new Map(links.map(l => [l.registrationId, Array.isArray(l.flags) ? l.flags : []]));
  }
  async function openDisputes(q, registrationIds) {
    if (!registrationIds.length) return new Set();
    return new Set((await q('EventResultDispute').whereIn('registrationId', registrationIds).where({ status: 'open' }).select('registrationId')).map(r => r.registrationId));
  }

  // ── Organizer reads ───────────────────────────────────────────────────────

  async function summary({ actor, organizerId = null, eventId }) {
    if (!allowed(actor, 'read')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const { event, categories } = ctx;
    const { rows: releases, byCategory } = await stagesOf(db, event, categories);
    const counts = (await db('EventRegistration as r').leftJoin('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', event.id).where('r.status', 'confirmed').groupBy('r.categoryId')
      .select('r.categoryId')
      .count({ confirmed: 'r.id' })
      .select(db.raw(`count(*) FILTER (WHERE e."finishStatus" = 'finished' AND e."verificationStatus" IN ('verified','corrected')) AS finished`))
      .select(db.raw(`count(*) FILTER (WHERE e."finishStatus" = 'dnf' AND e."verificationStatus" = 'verified') AS dnf`))
      .select(db.raw(`count(*) FILTER (WHERE e."finishStatus" = 'dns' AND e."verificationStatus" = 'verified') AS dns`))
      .select(db.raw(`count(*) FILTER (WHERE e."verificationStatus" = 'disqualified' OR e."finishStatus" = 'dq') AS dq`))
      .select(db.raw(`count(*) FILTER (WHERE e."verificationStatus" = 'pending_verification') AS pending`))
      .select(db.raw(`count(*) FILTER (WHERE e."verificationStatus" = 'rejected') AS rejected`))
      .select(db.raw('count(*) FILTER (WHERE e.id IS NULL) AS "noResult"'))).map(plain);
    const byCat = new Map(counts.map(c => [c.categoryId, c]));
    const flaggedRows = await db('EventActivityLink as l').join('EventRegistration as r', 'r.id', 'l.registrationId').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', event.id).where('l.linkType', 'event_run').whereNull('l.unlinkedAt').where('e.verificationStatus', PENDING).whereRaw(`jsonb_array_length(l.flags) > 0`).select('r.categoryId');
    const flaggedBy = new Map();
    for (const f of flaggedRows) flaggedBy.set(f.categoryId, (flaggedBy.get(f.categoryId) ?? 0) + 1);
    const disputes = await db('EventResultDispute as d').join('EventRegistration as r', 'r.id', 'd.registrationId').where('r.eventId', event.id).where('d.status', 'open').groupBy('r.categoryId').select('r.categoryId').count({ n: 'd.id' });
    const disputesBy = new Map(disputes.map(d => [d.categoryId, Number(d.n)]));
    const names = new Map((await db('User').whereIn('id', releases.map(r => r.releasedBy).filter(Boolean)).select('id', 'displayName')).map(u => [u.id, u.displayName]));
    const perCategory = categories.map((c) => {
      const k = byCat.get(c.id) ?? {};
      const rel = latestRelease(releases, c.id);
      return {
        categoryId: c.id, name: c.name, distanceMeters: num(c.distanceMeters),
        confirmed: Number(k.confirmed ?? 0), finished: Number(k.finished ?? 0), dnf: Number(k.dnf ?? 0), dns: Number(k.dns ?? 0), dq: Number(k.dq ?? 0),
        pending: Number(k.pending ?? 0), rejected: Number(k.rejected ?? 0), noResult: Number(k.noResult ?? 0), flagged: flaggedBy.get(c.id) ?? 0,
        release: { stage: byCategory.get(c.id) ?? 'none', releasedAt: rel?.releasedAt ?? null, releasedBy: rel?.releasedBy ? { name: names.get(rel.releasedBy) ?? null } : null },
        disputesOpen: disputesBy.get(c.id) ?? 0, rules: rulesOf(c),
      };
    });
    const importsCount = Number((await db('EventResultImport').where({ eventId: event.id }).count({ n: '*' }).first()).n);
    return { eventId: event.id, eventStatus: event.status, eventType: event.eventType, perCategory, disputesOpen: perCategory.reduce((n, c) => n + c.disputesOpen, 0), importsCount, settings: settingsOf(event, categories) };
  }

  async function list({ actor, organizerId = null, eventId, query = {} }) {
    if (!allowed(actor, 'read')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const { event, categories } = ctx;
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('EventRegistration as r').leftJoin('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', event.id).where('r.status', 'confirmed');
    if (query.categoryId) q.where('r.categoryId', String(query.categoryId));
    const s = String(query.status ?? '');
    if (s === 'needs_review') q.where('e.verificationStatus', PENDING);
    else if (s === 'verified') q.whereIn('e.verificationStatus', ['verified', 'corrected']).where('e.finishStatus', 'finished');
    else if (s === 'rejected') q.where('e.verificationStatus', 'rejected');
    else if (s === 'dnf' || s === 'dns') q.where('e.finishStatus', s);
    else if (s === 'dq') q.where(function dq() { this.where('e.verificationStatus', 'disqualified').orWhere('e.finishStatus', 'dq'); });
    else if (s === 'no_result') q.whereNull('e.id');
    else if (s) return fail('invalid_request', 400, { field: 'status' });
    if (query.flag) q.whereExists(function f() { this.select(db.raw('1')).from('EventActivityLink as l').whereRaw('l."registrationId" = r.id').where('l.linkType', 'event_run').whereNull('l.unlinkedAt').whereRaw('l.flags @> ?::jsonb', [JSON.stringify([String(query.flag)])]); });
    if (query.q !== undefined && query.q !== '') {
      const term = String(query.q).trim();
      if (term.length < 2) return fail('query_too_short', 400);
      const like = `${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      q.where(function search() { this.whereRaw('upper(r."bibNumber") = ?', [term.toUpperCase()]).orWhere('r.firstName', 'ilike', like).orWhere('r.lastName', 'ilike', like); });
    }
    const total = Number((await q.clone().clearSelect().count({ n: 'r.id' }).first()).n);
    if (cursor?.after) q.where('r.id', '>', String(cursor.after));
    const rows = await q.orderBy('r.id').limit(limit + 1).select('r.*', db.raw('to_jsonb(e.*) AS "result"'));
    const page = rows.slice(0, limit);
    const { byCategory } = await stagesOf(db, event, categories);
    const regIds = page.map(r => r.id);
    const [flags, disputes] = await Promise.all([flagsFor(db, regIds), openDisputes(db, regIds)]);
    const catBy = new Map(categories.map(c => [c.id, c]));
    const items = page.map((r) => {
      const { result, ...reg } = r;
      return rowView(result && result.id ? plain(result) : null, plain(reg), catBy.get(reg.categoryId), { stages: byCategory, flags: flags.get(reg.id) ?? [], disputeOpen: disputes.has(reg.id) });
    });
    return { items, nextCursor: rows.length > limit ? encodeCursor({ after: page[page.length - 1].id }) : null, total };
  }

  async function detail({ actor, organizerId = null, eventId, registrationId }) {
    if (!allowed(actor, 'read')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const { event, categories } = ctx;
    const reg = plain(await regOf(db, registrationId, event.id));
    if (!reg || reg.status !== 'confirmed') return fail('registration_not_found', 404);
    const revisions = (await db('EventResult').where({ registrationId: reg.id }).orderBy('revision')).map(plain);
    const current = revisions.find(r => r.isCurrent) ?? null;
    const { byCategory } = await stagesOf(db, event, categories);
    const [flags, disputes] = await Promise.all([flagsFor(db, [reg.id]), openDisputes(db, [reg.id])]);
    const names = new Map((await db('User').whereIn('id', revisions.map(r => r.verifiedBy ?? r.submittedByUserId).filter(Boolean)).select('id', 'displayName')).map(u => [u.id, u.displayName]));
    const link = plain(await db('EventActivityLink').where({ registrationId: reg.id, linkType: 'event_run' }).whereNull('unlinkedAt').orderBy('createdAt', 'desc').first());
    const history = (await db('EventResultDispute').where({ registrationId: reg.id }).orderBy('createdAt', 'desc')).map(d => disputeView(plain(d)));
    const category = categories.find(c => c.id === reg.categoryId);
    return {
      result: rowView(current, reg, category, { stages: byCategory, flags: flags.get(reg.id) ?? [], disputeOpen: disputes.has(reg.id) }),
      revisions: revisions.map(r => ({
        revision: r.revision, finishStatus: r.finishStatus, verificationStatus: r.verificationStatus, netElapsedMs: num(r.netElapsedMs), gunElapsedMs: num(r.gunElapsedMs),
        sourceType: r.sourceType, reasonCode: r.reasonCode, note: r.correctionReason, by: { name: names.get(r.verifiedBy ?? r.submittedByUserId) ?? null }, at: iso(r.updatedAt),
      })),
      linkedRun: link ? { distanceMeters: link.distanceMeters, elapsedMs: num(link.elapsedMs), movingSeconds: link.movingSeconds, checks: link.checks, flags: link.flags } : null,
      disputes: history,
    };
  }

  // ── Import (CSV for staff, rows for API clients) ──────────────────────────

  /**
   * Turn parsed rows into a plan against the live data. Pure reads (the caller decides when to lock). → { items, totals, hash }.
   * item: { line, clientRef, status: 'ok' | 'problem', code, warnings[], action, reg, input, bib }.
   */
  async function planRows({ q = db, event, categories, rows, sourceType, sourceLabel, basis = null, actor = null }) {
    const bibs = [...new Set(rows.map(r => normaliseBib(r.bib)).filter(Boolean))];
    const ids = [...new Set(rows.map(r => r.registrationId).filter(Boolean))];
    const regs = (bibs.length || ids.length)
      ? (await q('EventRegistration').where({ eventId: event.id }).where(function m() { if (bibs.length) this.whereIn('bibNumber', bibs); if (ids.length) this.orWhereIn('id', ids); })).map(plain)
      : [];
    const byBib = new Map(regs.filter(r => r.bibNumber).map(r => [r.bibNumber, r]));
    const byId = new Map(regs.map(r => [r.id, r]));
    const currents = regs.length ? (await q('EventResult').whereIn('registrationId', regs.map(r => r.id)).where({ isCurrent: true })).map(plain) : [];
    const currentBy = new Map(currents.map(c => [c.registrationId, c]));
    const catBy = new Map(categories.map(c => [c.id, c]));
    const catByName = new Map(categories.map(c => [c.name.trim().toLowerCase(), c]));
    const seen = new Set();
    const items = rows.map((r) => {
      const item = { line: r.line, clientRef: r.clientRef ?? null, bib: normaliseBib(r.bib) ?? (r.bib || null), warnings: [], status: 'problem', action: null, reg: null, input: null };
      const bad = (code) => { item.code = code; return item; };
      if (r.bibInvalid) return bad('bib_invalid');
      const bib = normaliseBib(r.bib);
      if (r.bib && !bib) return bad('bib_invalid');
      if (!bib && !r.registrationId) return bad('bib_not_found');
      const reg = r.registrationId ? byId.get(String(r.registrationId)) : byBib.get(bib);
      if (!reg) return bad('bib_not_found');
      if (bib && r.registrationId && reg.bibNumber !== bib) return bad('bib_not_found');
      if (seen.has(reg.id)) return bad('bib_duplicate_in_file');
      seen.add(reg.id);
      if (reg.status !== 'confirmed') return bad('registration_not_confirmed');
      item.reg = reg;
      item.bib = reg.bibNumber ?? item.bib;
      const category = catBy.get(reg.categoryId);
      if (r.category) {
        const want = String(r.category).trim();
        const match = catBy.get(want) ?? catByName.get(want.toLowerCase());
        if (!match || match.id !== reg.categoryId) return bad('category_mismatch');
      }
      const statusWord = r.status || (r.net || r.gun ? 'finished' : '');
      if (!statusWord) return bad('status_invalid');
      if (!FINISH_STATUSES.includes(statusWord)) return bad('status_invalid');
      let netMs = null; let gunMs = null;
      if (statusWord === 'finished') {
        if (!r.net && !r.gun) return bad('time_missing_for_finisher');
        for (const [raw, which] of [[r.net, 'net'], [r.gun, 'gun']]) {
          if (!raw) continue;
          const t = parseTime(raw);
          if (t.error) return bad(t.error);
          if (which === 'net') netMs = t.ms; else gunMs = t.ms;
        }
      }
      const cur = currentBy.get(reg.id) ?? null;
      const curStatus = cur ? registrationStatusOf(cur) : 'not_submitted';
      if (['verified', 'corrected', 'disqualified'].includes(curStatus)) return bad('already_official');
      if (timingBlocked(actor, cur)) return bad('not_your_entry');
      if (r.rank) item.warnings.push('rank_ignored');
      const rules = rulesOf(category);
      const useBasis = basis ?? rules.timeBasis;
      if (statusWord === 'finished') {
        if (useBasis === 'gun' && gunMs === null) item.warnings.push('time_basis_missing');
        const elapsed = rankingTime({ netMs, gunMs }, useBasis);
        if (rules.cutoffMinutes && elapsed > rules.cutoffMinutes * 60_000) item.warnings.push('over_cutoff');
      }
      if (event.kitProvided && reg.kitStatus !== 'collected') item.warnings.push('kit_not_collected');
      const input = {
        sourceType, sourceLabel: sourceLabel ?? null, sourceReference: r.note ? neutralise(r.note) : null, finishStatus: statusWord, netMs, gunMs, basis: useBasis,
        keepTimes: false,
      };
      let action = 'created';
      if (cur) {
        const same = cur.verificationStatus === PENDING && cur.finishStatus === statusWord && num(cur.netElapsedMs) === netMs && num(cur.gunElapsedMs) === gunMs
          && cur.sourceType === sourceType && (cur.sourceLabel ?? null) === (sourceLabel ?? null) && (cur.sourceReference ?? null) === (input.sourceReference ?? null);
        const sameSettled = cur.verificationStatus === 'verified' && ['dnf', 'dns'].includes(statusWord) && cur.finishStatus === statusWord;
        action = same || sameSettled ? 'unchanged' : 'revised';
      }
      item.status = 'ok';
      item.action = action;
      item.input = input;
      item.current = cur;
      return item;
    });
    const hash = sha256hex(JSON.stringify([event.id, sourceType, sourceLabel ?? null, basis ?? null, items.map(i => [i.line, i.reg?.id ?? null, i.action, i.code ?? null, i.input?.finishStatus ?? null, i.input?.netMs ?? null, i.input?.gunMs ?? null, i.current?.revision ?? 0, i.reg?.bibNumber ?? null, i.reg?.status ?? null])]));
    const problems = items.filter(i => i.status === 'problem');
    const confirmed = Number((await q('EventRegistration').where({ eventId: event.id, status: 'confirmed' }).count({ n: '*' }).first()).n);
    const matched = items.filter(i => i.reg).length;
    return { items, problems, hash, matched, confirmed };
  }

  /** A timing partner may add and revise ITS OWN pending rows; a settled row or somebody else's pending row is the owner's / admin's to change (L4). */
  const timingBlocked = (actor, cur) => actor?.kind === 'staff' && actor.role === 'timing' && Boolean(cur)
    && !(cur.verificationStatus === 'rejected' || (cur.verificationStatus === PENDING && cur.submittedByUserId === actor.userId));

  const MESSAGES = {
    not_your_entry: 'This result was entered by someone else or is already settled. Ask an owner or admin to change it.',
    bib_not_found: 'No registered runner has this bib number.', bib_invalid: 'The bib number is not valid.', bib_duplicate_in_file: 'This runner appears more than once in the file.',
    registration_not_confirmed: 'This place is not confirmed.', category_mismatch: 'The category does not match the runner\'s registration.',
    time_missing_for_finisher: 'A finisher needs a time.', time_invalid: 'The time is not written as H:MM:SS.', time_out_of_range: 'The time must be more than zero and less than 24 hours.',
    status_invalid: 'The status must be finished, DNF, DNS or DQ.', already_official: 'This runner already has a verified result. Use a correction.', event_not_open_for_results: 'Results can be added once the event has started.',
  };

  function previewView(plan, { byStatus = true } = {}) {
    const counts = { total: plan.items.length, ok: plan.items.filter(i => i.status === 'ok').length, warnings: plan.items.filter(i => i.warnings.length).length, problems: plan.problems.length };
    const by = { finished: 0, dnf: 0, dns: 0, dq: 0 };
    for (const i of plan.items) if (i.status === 'ok') by[i.input.finishStatus] += 1;
    return {
      previewHash: plan.hash, rows: counts,
      willCreate: plan.items.filter(i => i.action === 'created').length, willRevise: plan.items.filter(i => i.action === 'revised').length, unchanged: plan.items.filter(i => i.action === 'unchanged').length,
      ...(byStatus ? { byStatus: by } : {}), unmatchedRegistrations: Math.max(0, plan.confirmed - plan.matched),
      problems: plan.problems.slice(0, 200).map(i => ({ line: i.line, bib: i.bib, code: i.code, message: MESSAGES[i.code] ?? i.code })),
      problemsTotal: plan.problems.length,
      warnings: plan.items.filter(i => i.warnings.length).slice(0, 200).flatMap(i => i.warnings.map(code => ({ line: i.line, bib: i.bib, code }))),
    };
  }

  function importSource(body) {
    const sourceType = body.sourceType ?? 'timing_provider';
    if (!IMPORT_SOURCES.includes(sourceType)) return { error: fail('validation_failed', 422, { fields: [{ path: 'sourceType', code: 'invalid' }] }) };
    const label = body.sourceLabel === undefined || body.sourceLabel === null || body.sourceLabel === '' ? null : String(body.sourceLabel).trim();
    if (label !== null && (label.length < 1 || label.length > 60)) return { error: fail('validation_failed', 422, { fields: [{ path: 'sourceLabel', code: 'too_long' }] }) };
    const basis = body.timeBasis === undefined || body.timeBasis === null || body.timeBasis === '' ? null : body.timeBasis;
    if (basis !== null && !['net', 'gun'].includes(basis)) return { error: fail('validation_failed', 422, { fields: [{ path: 'timeBasis', code: 'invalid' }] }) };
    return { sourceType, label: label === null ? null : neutralise(label), basis };
  }

  async function guardOpen(event, status = 422) {
    if (event.status === 'cancelled') return fail('event_cancelled', 409);
    if (!OPEN_FOR_RESULTS.includes(event.status)) return fail('event_not_open_for_results', status);
    return null;
  }

  async function importPreview({ actor, organizerId = null, eventId, body = {} }) {
    if (!allowed(actor, 'submit')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const refused = await guardOpen(ctx.event);
    if (refused) return refused;
    const src = importSource(body);
    if (src.error) return src.error;
    const parsed = parseResultsCsv(body.csv, { maxRows: importMaxRows() });
    if (parsed.error) return fail(parsed.error === 'too_large' ? 'payload_too_large' : parsed.error === 'too_many_rows' ? 'too_many_rows' : 'csv_invalid', parsed.error === 'too_large' ? 413 : parsed.error === 'too_many_rows' ? 413 : 422, { reason: parsed.error, ...(parsed.missing ? { missing: parsed.missing } : {}) });
    const plan = await planRows({ event: ctx.event, categories: ctx.categories, rows: parsed.rows, sourceType: src.sourceType, sourceLabel: src.label, basis: src.basis, actor });
    return previewView(plan);
  }

  /** Apply one planned item inside `trx`. → the new row or null (unchanged). */
  async function applyItem(trx, { event, category, item, actor, importId = null }) {
    if (item.action === 'unchanged') return null;
    const reg = plain(await trx('EventRegistration').where({ id: item.reg.id }).forUpdate().first());
    const prev = plain(await trx('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
    // only an owner / admin settles a DNF / DNS (a timing partner's rows wait for a human decision, like an API client's)
    const staffSettled = actor.kind === 'staff' && STAFF_DECIDE.includes(actor.role) && ['dnf', 'dns'].includes(item.input.finishStatus);
    const dq = item.input.finishStatus === 'dq';
    const input = {
      ...item.input, importId,
      verificationStatus: staffSettled ? 'verified' : PENDING, verifiedBy: staffSettled ? actor.userId : null,
      submittedByUserId: actor.kind === 'api' ? null : actor.userId, submittedByApiClientId: actor.kind === 'api' ? actor.clientId : null,
      keepTimes: dq,
    };
    return writeRevision(trx, { category, reg, prev, input });
  }

  async function importApply({ actor, organizerId = null, eventId, key, body = {} }) {
    if (!allowed(actor, 'submit')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const src = importSource(body);
    if (src.error) return src.error;
    const parsed = parseResultsCsv(body.csv, { maxRows: importMaxRows() });
    if (parsed.error) return fail(parsed.error === 'too_large' || parsed.error === 'too_many_rows' ? 'payload_too_large' : 'csv_invalid', parsed.error === 'too_large' || parsed.error === 'too_many_rows' ? 413 : 422, { reason: parsed.error });
    if (typeof body.previewHash !== 'string' || !body.previewHash) return fail('validation_failed', 422, { fields: [{ path: 'previewHash', code: 'required' }] });
    const contentSha256 = sha256hex(JSON.stringify([parsed.rows, src.sourceType, src.label, src.basis]));
    return idempotent({ actor, route: `results.import:${ctx.event.id}`, key, body: { csv: contentSha256, previewHash: body.previewHash } }, async () => {
      const prior = plain(await db('EventResultImport').where({ eventId: ctx.event.id, contentSha256 }).first());
      if (prior) return { ...(prior.summary?.response ?? { import: importViewOf(prior) }), status: 200, replayed: true };
      const refused = await guardOpen(ctx.event);
      if (refused) return refused;
      try {
        return await db.transaction(async (trx) => {
          await lockEvent(trx, ctx.event.id);
          const plan = await planRows({ q: trx, event: ctx.event, categories: ctx.categories, rows: parsed.rows, sourceType: src.sourceType, sourceLabel: src.label, basis: src.basis, actor });
          if (plan.hash !== body.previewHash) return fail('preview_stale', 409);
          if (plan.problems.length) return fail('import_has_errors', 409, { problems: plan.problems.length, rows: plan.problems.slice(0, 50).map(i => ({ line: i.line, bib: i.bib, code: i.code })) });
          const importId = newId('eimp');
          const catBy = new Map(ctx.categories.map(c => [c.id, c]));
          const touched = [];
          let created = 0; let revised = 0; let unchanged = 0;
          // The import row first: every result row points at it (importId).
          const counts = () => ({ createdCount: created, revisedCount: revised, unchangedCount: unchanged });
          await trx('EventResultImport').insert({
            id: importId, eventId: ctx.event.id, organizerId: ctx.event.organizerId, sourceType: src.sourceType, sourceLabel: src.label, fileName: text(body.fileName, 120),
            contentSha256, rowCount: plan.items.length, summary: JSON.stringify({}), createdBy: actor.userId, createdAt: stamp(),
          });
          for (const item of plan.items) {
            const row = await applyItem(trx, { event: ctx.event, category: catBy.get(item.reg.categoryId), item, actor, importId });
            if (!row) unchanged += 1; else { if (item.action === 'created') created += 1; else revised += 1; touched.push(item.reg.id); }
          }
          const view = {
            id: importId, fileName: text(body.fileName, 120), sourceType: src.sourceType, sourceLabel: src.label, rowCount: plan.items.length, createdCount: created, revisedCount: revised, unchangedCount: unchanged,
            createdBy: { name: null }, createdAt: iso(stamp()),
          };
          const response = { import: view };
          await trx('EventResultImport').where({ id: importId }).update({ ...counts(), summary: JSON.stringify({ counts: { created, revised, unchanged }, response }) });
          // Rows added after an official release (a late result) still need their medals once verified; nothing to rank yet.
          await audit(actor, 'events.results_imported', ctx.event.id, null, { importId, rows: plan.items.length, created, revised, unchanged, sourceType: src.sourceType }, trx);
          return { ...response, status: 201 };
        });
      } catch (err) {
        if (err.refusal) return err.refusal;
        if (err.code === UNIQUE) {
          const prior2 = plain(await db('EventResultImport').where({ eventId: ctx.event.id, contentSha256 }).first());
          if (prior2) return { ...(prior2.summary?.response ?? {}), status: 200, replayed: true };
          return fail('request_in_progress', 409);
        }
        throw err;
      }
    }).then(async (out) => { if (!out.error && out.status === 201) await analytics('events_results_imported', { eventId: ctx.event.id, rows: out.import.rowCount, ok: out.import.createdCount + out.import.revisedCount }); return out; });
  }
  function importViewOf(row) {
    return { id: row.id, fileName: row.fileName, sourceType: row.sourceType, sourceLabel: row.sourceLabel, rowCount: row.rowCount, createdCount: row.createdCount, revisedCount: row.revisedCount, unchangedCount: row.unchangedCount, createdBy: { name: null }, createdAt: iso(row.createdAt) };
  }

  async function importsList({ actor, organizerId = null, eventId, query = {} }) {
    if (!allowed(actor, 'read')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('EventResultImport').where({ eventId: ctx.event.id });
    if (cursor?.at) q.where(function k() { this.where('createdAt', '<', new Date(cursor.at)).orWhere(function t() { this.where('createdAt', new Date(cursor.at)).where('id', '<', cursor.id); }); });
    const rows = (await q.orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(limit + 1)).map(plain);
    const page = rows.slice(0, limit);
    const names = new Map((await db('User').whereIn('id', page.map(r => r.createdBy).filter(Boolean)).select('id', 'displayName')).map(u => [u.id, u.displayName]));
    return {
      items: page.map(r => ({ ...importViewOf(r), createdBy: { name: names.get(r.createdBy) ?? null } })),
      nextCursor: rows.length > limit ? encodeCursor({ at: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
    };
  }

  /** POST /v1 …/results/imports — rows from a timing system. Each row is its own transaction; the Idempotency-Key covers the call. */
  async function apiImport({ actor, organizerId, eventId, key, body = {}, dryRun = false }) {
    if (!allowed(actor, 'submit')) return fail('insufficient_scope', 403, { requiredScope: 'results:write' });
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length || rows.length > 500) return fail('validation_failed', 422, { fields: [{ path: 'rows', code: rows && rows.length > 500 ? 'too_many' : 'required' }] });
    const src = importSource({ sourceType: 'timing_provider', sourceLabel: body.sourceLabel, timeBasis: body.timeBasis });
    if (src.error) return src.error;
    const refused = await guardOpen(ctx.event, 409);
    if (refused) return refused;
    const planned = rows.map((r, i) => ({
      line: i + 1, clientRef: typeof r?.clientRef === 'string' ? r.clientRef.slice(0, 100) : `#${i + 1}`, bib: r?.bib === undefined || r?.bib === null ? '' : String(r.bib), bibInvalid: false,
      registrationId: typeof r?.registrationId === 'string' ? r.registrationId : '',
      status: typeof r?.status === 'string' && r.status.trim() ? (STATUS_WORDS[r.status.trim().toLowerCase()] ?? r.status.trim().toLowerCase().slice(0, 20)) : '',
      net: r?.netTime === undefined || r?.netTime === null ? '' : String(r.netTime), gun: r?.gunTime === undefined || r?.gunTime === null ? '' : String(r.gunTime),
      category: typeof r?.category === 'string' ? r.category : '', note: '', rank: '',
    }));
    const work = async () => {
      const plan = await planRows({ event: ctx.event, categories: ctx.categories, rows: planned, sourceType: 'timing_provider', sourceLabel: src.label, basis: src.basis });
      const results = [];
      const catBy = new Map(ctx.categories.map(c => [c.id, c]));
      for (const item of plan.items) {
        if (item.status === 'problem') { results.push({ clientRef: item.clientRef, ok: false, resultId: null, action: null, error: item.code }); continue; }
        if (dryRun || item.action === 'unchanged') { results.push({ clientRef: item.clientRef, ok: true, resultId: item.current?.id ?? null, action: item.action, error: null }); continue; }
        try {
          const row = await db.transaction(async (trx) => {
            await lockEvent(trx, ctx.event.id);
            // Re-plan this one row under the lock so a concurrent change cannot slip a stale revision in.
            const fresh = (await planRows({ q: trx, event: ctx.event, categories: ctx.categories, rows: [{ ...planned[item.line - 1] }], sourceType: 'timing_provider', sourceLabel: src.label, basis: src.basis })).items[0];
            if (fresh.status === 'problem') throw Object.assign(new Error(fresh.code), { refusal: { code: fresh.code } });
            if (fresh.action === 'unchanged') return { unchanged: true, id: fresh.current?.id ?? null };
            return applyItem(trx, { event: ctx.event, category: catBy.get(item.reg.categoryId), item: fresh, actor });
          });
          results.push({ clientRef: item.clientRef, ok: true, resultId: row?.id ?? null, action: row?.unchanged ? 'unchanged' : item.action, error: null });
        } catch (err) {
          results.push({ clientRef: item.clientRef, ok: false, resultId: null, action: null, error: err.refusal?.code ?? err.refusal?.error ?? 'internal_error' });
          if (!err.refusal) console.error(`[events-results] api row failed: ${err.message}`);
        }
      }
      const okRows = results.filter(r => r.ok && r.action !== 'unchanged').length;
      if (!dryRun) await audit(actor, 'events.results_imported', ctx.event.id, null, { via: 'api', rows: rows.length, ok: okRows }, db);
      return { results, status: 200 };
    };
    if (dryRun) return work();
    return idempotent({ actor, route: `results.api_import:${ctx.event.id}`, key, body }, work);
  }

  // ── Manual entry ──────────────────────────────────────────────────────────

  async function enter({ actor, organizerId = null, eventId, registrationId, key, body = {} }) {
    if (!allowed(actor, 'submit') || actor.kind === 'api') return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const refused = await guardOpen(ctx.event);
    if (refused) return refused;
    const finishStatus = String(body.finishStatus ?? '');
    if (!['finished', 'dnf', 'dns'].includes(finishStatus)) return fail('validation_failed', 422, { fields: [{ path: 'finishStatus', code: 'invalid' }] });
    let netMs = null; let gunMs = null;
    if (finishStatus === 'finished') {
      if (!body.netTime && !body.gunTime) return fail('validation_failed', 422, { fields: [{ path: 'netTime', code: 'required' }] });
      for (const [raw, which] of [[body.netTime, 'net'], [body.gunTime, 'gun']]) {
        if (!raw) continue;
        const t = parseTime(raw);
        if (t.error) return fail('validation_failed', 422, { fields: [{ path: which === 'net' ? 'netTime' : 'gunTime', code: t.error }] });
        if (which === 'net') netMs = t.ms; else gunMs = t.ms;
      }
    }
    const label = body.sourceLabel ? String(body.sourceLabel).trim().slice(0, 60) : null;
    return idempotent({ actor, route: `results.enter:${registrationId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const reg = plain(await trx('EventRegistration').where({ id: String(registrationId), eventId: ctx.event.id }).forUpdate().first());
      if (!reg || reg.status !== 'confirmed') return fail('registration_not_found', 404);
      const prev = plain(await trx('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
      const curStatus = prev ? registrationStatusOf(prev) : 'not_submitted';
      if (['verified', 'corrected', 'disqualified'].includes(curStatus)) return fail('already_official', 409, { hint: 'use_correction' });
      if (timingBlocked(actor, prev)) return fail('not_your_entry', 409);
      const settled = finishStatus !== 'finished' && STAFF_DECIDE.includes(actor.role);
      const category = ctx.categories.find(c => c.id === reg.categoryId);
      const row = await writeRevision(trx, {
        category, reg, prev,
        input: { sourceType: 'organizer_verified', sourceLabel: label ? neutralise(label) : null, sourceReference: null, finishStatus, netMs, gunMs, verificationStatus: settled ? 'verified' : PENDING, verifiedBy: settled ? actor.userId : null, submittedByUserId: actor.userId, reasonCode: null, correctionReason: text(body.reason, 300) },
      });
      await audit(actor, 'events.result_entered', ctx.event.id, prev ? { revision: prev.revision } : null, { registrationId: reg.id, revision: row.revision, finishStatus }, trx);
      return { result: { id: row.id, revision: row.revision, finishStatus: row.finishStatus, verificationStatus: row.verificationStatus, elapsedMs: num(row.elapsedMs) }, status: 200 };
    }));
  }

  // ── Verify, reject, bulk ──────────────────────────────────────────────────

  async function currentOf(trx, event, resultId) {
    const row = plain(await trx('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').where('e.id', String(resultId)).where('r.eventId', event.id).forUpdate().first('e.*'));
    return row;
  }
  const expectedRevision = body => (Number.isInteger(body.expectedRevision) && body.expectedRevision >= 1 ? body.expectedRevision : null);
  const needRevision = () => fail('validation_failed', 422, { fields: [{ path: 'expectedRevision', code: 'required' }] });

  async function afterChange(trx, event, categories, registrationIds, { ranksMayChange }) {
    const { byCategory } = await stagesOf(trx, event, categories);
    const regs = registrationIds.length ? (await trx('EventRegistration').whereIn('id', registrationIds).select('id', 'categoryId')).map(plain) : [];
    const anyOfficial = regs.some(r => byCategory.get(r.categoryId) === 'official');
    if (!anyOfficial) return;
    const changed = ranksMayChange ? await recomputeRanks(trx, event, categories) : [];
    await queueAwards(trx, event, [...new Set([...registrationIds.filter(id => regs.find(r => r.id === id && byCategory.get(r.categoryId) === 'official')), ...changed])]);
  }

  async function verify({ actor, organizerId = null, eventId, resultId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const want = expectedRevision(body);
    if (want === null) return needRevision();
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    return idempotent({ actor, route: `results.verify:${resultId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const row = await currentOf(trx, ctx.event, resultId);
      if (!row) return fail('result_not_found', 404);
      if (!row.isCurrent || row.revision !== want) return fail('result_changed', 409, { currentRevision: row.revision });
      if (row.verificationStatus !== PENDING) return fail('invalid_transition', 409, { from: row.verificationStatus, to: 'verified' });
      if (row.finishStatus === 'dq') return disqualifyIn(trx, { ctx, actor, row, body: { reasonCode: body.reasonCode, note: body.note ?? null }, via: 'verify' });
      const at = stamp();
      const nextReg = ['dnf', 'dns'].includes(row.finishStatus) ? row.finishStatus : 'verified';
      const move = assertTransition('result', 'pending_verification', nextReg);
      if (!move.ok) return fail('invalid_transition', 409, { from: move.from, to: move.to });
      await trx('EventResult').where({ id: row.id }).update({ verificationStatus: 'verified', verifiedBy: actor.userId, verifiedAt: at, updatedAt: at });
      await trx('EventRegistration').where({ id: row.registrationId }).update({ resultStatus: nextReg, updatedAt: at });
      if (row.activityLinkId) await trx('EventActivityLink').where({ id: row.activityLinkId }).update({ matchStatus: 'matched' });
      await afterChange(trx, ctx.event, ctx.categories, [row.registrationId], { ranksMayChange: true });
      await outbox(trx, ctx.event, 'result.verified', 'registration', row.registrationId, { registrationId: row.registrationId, resultId: row.id, revision: row.revision, finishStatus: row.finishStatus });
      await audit(actor, 'events.result_verified', ctx.event.id, { status: PENDING }, { registrationId: row.registrationId, resultId: row.id, revision: row.revision }, trx);
      return { result: { id: row.id, revision: row.revision, verificationStatus: 'verified', finishStatus: row.finishStatus }, status: 200 };
    }));
  }

  async function reject({ actor, organizerId = null, eventId, resultId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const want = expectedRevision(body);
    if (want === null) return needRevision();
    if (!REJECT_REASONS.includes(body.reasonCode)) return fail('validation_failed', 422, { fields: [{ path: 'reasonCode', code: 'invalid', allowed: REJECT_REASONS }] });
    const note = text(body.note, 120);
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    let notify = null;
    const out = await idempotent({ actor, route: `results.reject:${resultId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const row = await currentOf(trx, ctx.event, resultId);
      if (!row) return fail('result_not_found', 404);
      if (!row.isCurrent || row.revision !== want) return fail('result_changed', 409, { currentRevision: row.revision });
      if (row.verificationStatus !== PENDING) return fail('invalid_transition', 409, { from: row.verificationStatus, to: 'rejected' });
      const at = stamp();
      await trx('EventResult').where({ id: row.id }).update({ verificationStatus: 'rejected', reasonCode: body.reasonCode, correctionReason: note, updatedAt: at });
      await trx('EventRegistration').where({ id: row.registrationId }).update({ resultStatus: 'rejected', updatedAt: at });
      if (row.activityLinkId) await trx('EventActivityLink').where({ id: row.activityLinkId }).update({ matchStatus: 'rejected' });
      await audit(actor, 'events.result_rejected', ctx.event.id, { status: PENDING }, { registrationId: row.registrationId, resultId: row.id, reasonCode: body.reasonCode }, trx);
      if (row.sourceType === 'fitflex_gps') notify = { registrationId: row.registrationId, resultId: row.id, revision: row.revision };
      return { result: { id: row.id, revision: row.revision, verificationStatus: 'rejected' }, status: 200 };
    }));
    if (notify && !out.error) await tellParticipant(notify.registrationId, ctx.event, 'rejected', { id: `evrej:${notify.resultId}:${notify.revision}`, route: `/member/events/registrations/${notify.registrationId}/result` });
    return out;
  }

  async function bulkPreview({ actor, organizerId = null, eventId, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    if ((body.filter ?? 'pending_clean') !== 'pending_clean') return fail('validation_failed', 422, { fields: [{ path: 'filter', code: 'invalid' }] });
    const scope = await bulkScope(db, ctx.event, body.categoryId);
    if (scope.error) return scope;
    return { previewHash: scope.hash, count: scope.clean.length, excludedFlagged: scope.excluded };
  }
  async function bulkScope(q, event, categoryId) {
    const rowsQ = q('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').where('r.eventId', event.id).where('e.isCurrent', true).where('e.verificationStatus', PENDING).where('r.status', 'confirmed');
    if (categoryId) rowsQ.where('r.categoryId', String(categoryId));
    const rows = (await rowsQ.orderBy('e.id').select('e.id', 'e.revision', 'e.registrationId', 'e.finishStatus', 'e.sourceType', 'e.activityLinkId')).map(plain);
    const flags = await flagsFor(q, rows.map(r => r.registrationId));
    const clean = rows.filter(r => r.finishStatus !== 'dq' && !(flags.get(r.registrationId) ?? []).length);
    return { clean, excluded: rows.length - clean.length, hash: sha256hex(JSON.stringify([event.id, categoryId ?? null, clean.map(r => [r.id, r.revision])])) };
  }
  async function bulkApply({ actor, organizerId = null, eventId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    if (typeof body.previewHash !== 'string' || !body.previewHash) return fail('validation_failed', 422, { fields: [{ path: 'previewHash', code: 'required' }] });
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    return idempotent({ actor, route: `results.verify_bulk:${ctx.event.id}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const scope = await bulkScope(trx, ctx.event, body.categoryId);
      if (scope.error) return scope;
      if (scope.hash !== body.previewHash) return fail('preview_stale', 409);
      const at = stamp();
      for (const r of scope.clean) {
        const next = ['dnf', 'dns'].includes(r.finishStatus) ? r.finishStatus : 'verified';
        await trx('EventResult').where({ id: r.id }).update({ verificationStatus: 'verified', verifiedBy: actor.userId, verifiedAt: at, updatedAt: at });
        await trx('EventRegistration').where({ id: r.registrationId }).update({ resultStatus: next, updatedAt: at });
        if (r.activityLinkId) await trx('EventActivityLink').where({ id: r.activityLinkId }).update({ matchStatus: 'matched' });
        await outbox(trx, ctx.event, 'result.verified', 'registration', r.registrationId, { registrationId: r.registrationId, resultId: r.id, revision: r.revision, finishStatus: r.finishStatus });
      }
      await afterChange(trx, ctx.event, ctx.categories, scope.clean.map(r => r.registrationId), { ranksMayChange: true });
      await audit(actor, 'events.results_bulk_verified', ctx.event.id, null, { count: scope.clean.length, excludedFlagged: scope.excluded }, trx);
      return { verified: scope.clean.length, excludedFlagged: scope.excluded, status: 200 };
    }));
  }

  // ── Corrections and disqualification ──────────────────────────────────────

  function correctionInput(row, body) {
    const fields = [];
    let netMs = num(row.netElapsedMs); let gunMs = num(row.gunElapsedMs);
    let finishStatus = row.finishStatus === 'dq' ? 'finished' : row.finishStatus; // reinstating a disqualified runner
    if (body.finishStatus !== undefined) {
      if (!['finished', 'dnf', 'dns'].includes(body.finishStatus)) fields.push({ path: 'finishStatus', code: 'invalid' }); else finishStatus = body.finishStatus;
    }
    for (const [key, which] of [['netTime', 'net'], ['gunTime', 'gun']]) {
      if (body[key] === undefined) continue;
      if (body[key] === null || body[key] === '') { if (which === 'net') netMs = null; else gunMs = null; continue; }
      const t = parseTime(body[key]);
      if (t.error) fields.push({ path: key, code: t.error }); else if (which === 'net') netMs = t.ms; else gunMs = t.ms;
    }
    if (finishStatus === 'finished' && netMs === null && gunMs === null) fields.push({ path: 'netTime', code: 'required' });
    if (finishStatus !== 'finished') { netMs = null; gunMs = null; }
    return { fields, finishStatus, netMs, gunMs };
  }

  /** Correct inside a transaction the caller holds (also used by dispute resolution). */
  async function correctIn(trx, { ctx, actor, row, body, via = 'correct' }) {
    if (!CORRECT_REASONS.includes(body.reasonCode)) return fail('validation_failed', 422, { fields: [{ path: 'reasonCode', code: 'invalid', allowed: CORRECT_REASONS }] });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 10 || note.length > 300) return fail('validation_failed', 422, { fields: [{ path: 'note', code: note.length < 10 ? 'too_short' : 'too_long' }] });
    const cur = registrationStatusOf(row);
    if (!['verified', 'corrected', 'disqualified'].includes(cur)) return fail('invalid_transition', 409, { from: cur, to: 'corrected' });
    const next = correctionInput(row, body);
    if (next.fields.length) return fail('validation_failed', 422, { fields: next.fields });
    const unchanged = next.finishStatus === row.finishStatus && next.netMs === num(row.netElapsedMs) && next.gunMs === num(row.gunElapsedMs) && row.verificationStatus !== 'disqualified';
    if (unchanged) return fail('no_change', 422);
    if (cur !== 'corrected') { const move = assertTransition('result', cur, 'corrected'); if (!move.ok) return fail('invalid_transition', 409, { from: move.from, to: move.to }); }
    const reg = plain(await trx('EventRegistration').where({ id: row.registrationId }).forUpdate().first());
    const category = ctx.categories.find(c => c.id === reg.categoryId);
    const created = await writeRevision(trx, {
      category, reg, prev: row,
      input: {
        sourceType: row.sourceType, sourceLabel: row.sourceLabel, sourceReference: row.sourceReference, finishStatus: next.finishStatus, netMs: next.netMs, gunMs: next.gunMs,
        verificationStatus: 'corrected', verifiedBy: actor.userId, reasonCode: body.reasonCode, correctionReason: note, activityLinkId: row.activityLinkId, distanceMeters: num(row.distanceMeters),
        submittedByUserId: row.submittedByUserId, submittedByApiClientId: row.submittedByApiClientId, importId: row.importId,
      },
    });
    await afterChange(trx, ctx.event, ctx.categories, [reg.id], { ranksMayChange: true });
    await outbox(trx, ctx.event, 'result.corrected', 'registration', reg.id, { registrationId: reg.id, resultId: created.id, revision: created.revision, previousRevision: row.revision, finishStatus: created.finishStatus, material: true });
    await audit(actor, via === 'dispute' ? 'events.result_corrected' : (actor.kind === 'admin' ? 'events.admin_result_exception' : 'events.result_corrected'), ctx.event.id,
      { revision: row.revision, finishStatus: row.finishStatus, netElapsedMs: num(row.netElapsedMs), gunElapsedMs: num(row.gunElapsedMs) },
      { registrationId: reg.id, revision: created.revision, finishStatus: created.finishStatus, netElapsedMs: num(created.netElapsedMs), gunElapsedMs: num(created.gunElapsedMs), reasonCode: body.reasonCode, ...(actor.kind === 'admin' ? { action: 'correct' } : {}) }, trx);
    return { result: { id: created.id, revision: created.revision, verificationStatus: 'corrected', finishStatus: created.finishStatus, elapsedMs: num(created.elapsedMs) }, status: 200, _notify: { registrationId: reg.id, resultId: created.id, revision: created.revision } };
  }

  async function disqualifyIn(trx, { ctx, actor, row, body, via = 'disqualify' }) {
    if (!DQ_REASONS.includes(body.reasonCode)) return fail('validation_failed', 422, { fields: [{ path: 'reasonCode', code: 'invalid', allowed: DQ_REASONS }] });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note && note.length > 300) return fail('validation_failed', 422, { fields: [{ path: 'note', code: 'too_long' }] });
    if (via !== 'verify' && actor.kind === 'admin' && note.length < 10) return fail('validation_failed', 422, { fields: [{ path: 'note', code: 'too_short' }] });
    const cur = registrationStatusOf(row);
    if (cur === 'disqualified') return fail('invalid_transition', 409, { from: cur, to: 'disqualified' });
    const move = assertTransition('result', cur === 'rejected' ? 'pending_verification' : cur, 'disqualified');
    if (!move.ok || cur === 'rejected' || cur === 'dnf' || cur === 'dns') return fail('invalid_transition', 409, { from: cur, to: 'disqualified' });
    const reg = plain(await trx('EventRegistration').where({ id: row.registrationId }).forUpdate().first());
    const category = ctx.categories.find(c => c.id === reg.categoryId);
    const created = await writeRevision(trx, {
      category, reg, prev: row,
      input: {
        sourceType: row.sourceType, sourceLabel: row.sourceLabel, sourceReference: row.sourceReference, finishStatus: 'dq', netMs: num(row.netElapsedMs), gunMs: num(row.gunElapsedMs), keepTimes: true,
        verificationStatus: 'disqualified', verifiedBy: actor.userId, reasonCode: body.reasonCode, correctionReason: note || null, activityLinkId: row.activityLinkId, distanceMeters: num(row.distanceMeters),
        submittedByUserId: row.submittedByUserId, submittedByApiClientId: row.submittedByApiClientId, importId: row.importId,
      },
    });
    await afterChange(trx, ctx.event, ctx.categories, [reg.id], { ranksMayChange: true });
    await outbox(trx, ctx.event, 'result.corrected', 'registration', reg.id, { registrationId: reg.id, resultId: created.id, revision: created.revision, previousRevision: row.revision, finishStatus: 'dq', material: true });
    await audit(actor, actor.kind === 'admin' ? 'events.admin_result_exception' : 'events.result_disqualified', ctx.event.id, { revision: row.revision, status: row.verificationStatus },
      { registrationId: reg.id, revision: created.revision, reasonCode: body.reasonCode, ...(actor.kind === 'admin' ? { action: 'disqualify' } : {}) }, trx);
    return { result: { id: created.id, revision: created.revision, verificationStatus: 'disqualified', finishStatus: 'dq' }, status: 200, _notify: { registrationId: reg.id, resultId: created.id, revision: created.revision } };
  }

  async function correctOrDq(kind, { actor, organizerId = null, eventId, resultId, key, body = {} }) {
    const adminOk = actor.kind === 'admin';
    if (!adminOk && !allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId: adminOk ? null : organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const want = expectedRevision(body);
    if (want === null) return needRevision();
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    if (adminOk && (typeof body.note !== 'string' || body.note.trim().length < 10)) return fail('validation_failed', 422, { fields: [{ path: 'note', code: 'reason_required' }] });
    const out = await idempotent({ actor, route: `results.${kind}:${resultId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const row = await currentOf(trx, ctx.event, resultId);
      if (!row) return fail('result_not_found', 404);
      if (!row.isCurrent || row.revision !== want) return fail('result_changed', 409, { currentRevision: row.revision });
      if (adminOk) {
        // D59: FitFlex steps in only when the organizer cannot (not active) or a question has been open for more than 7 days.
        const organizer = plain(await trx('EventOrganizer').where({ id: ctx.event.organizerId }).first('status'));
        const stale = await trx('EventResultDispute').where({ registrationId: row.registrationId, status: 'open' }).where('createdAt', '<', new Date(+stamp() - 7 * DAY)).first('id');
        if (organizer?.status === 'active' && !stale) return fail('organizer_can_resolve', 409);
      }
      return kind === 'correct' ? correctIn(trx, { ctx, actor, row, body }) : disqualifyIn(trx, { ctx, actor, row, body });
    }));
    return afterCorrection(out, ctx, actor);
  }

  async function afterCorrection(out, ctx, actor) {
    if (out.error || !out._notify) return out;
    const { _notify: n, ...rest } = out;
    await tellParticipant(n.registrationId, ctx.event, 'corrected', { id: `evres:${n.resultId}:${n.revision}`, route: `/member/events/registrations/${n.registrationId}/result` });
    if (actor.kind === 'admin') await tellOrganizer(ctx.event, 'adminException', { id: `evadm:${n.resultId}:${n.revision}` });
    await analytics('events_result_corrected', { eventId: ctx.event.id });
    return rest;
  }
  const correct = args => correctOrDq('correct', args);
  const disqualify = args => correctOrDq('disqualify', args);

  // ── Release ───────────────────────────────────────────────────────────────

  async function releaseScope(q, event, categories, categoryId, stage) {
    if (categoryId !== null && categoryId !== undefined && categoryId !== '' && !categories.some(c => c.id === String(categoryId))) return fail('category_not_found', 404);
    const scopeCats = categoryId ? categories.filter(c => c.id === String(categoryId)) : categories;
    const ids = scopeCats.map(c => c.id);
    const regs = (await q('EventRegistration as r').leftJoin('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', event.id).where('r.status', 'confirmed').whereIn('r.categoryId', ids).orderBy('r.id')
      .select('r.id as registrationId', 'r.categoryId', 'e.id as resultId', 'e.revision', 'e.verificationStatus', 'e.finishStatus')).map(plain);
    const c = { finished: 0, dnf: 0, dns: 0, dq: 0, unsettled: 0, rejected: 0, noResult: 0 };
    for (const r of regs) {
      if (!r.resultId) c.noResult += 1;
      else if (r.verificationStatus === 'rejected') c.rejected += 1;
      else if (r.verificationStatus === PENDING) c.unsettled += 1;
      else if (r.verificationStatus === 'disqualified' || r.finishStatus === 'dq') c.dq += 1;
      else if (r.finishStatus === 'dnf') c.dnf += 1;
      else if (r.finishStatus === 'dns') c.dns += 1;
      else c.finished += 1;
    }
    const hash = sha256hex(JSON.stringify([event.id, categoryId ?? null, stage, regs.map(r => [r.registrationId, r.resultId, r.revision, r.verificationStatus])]));
    return { scopeCats, regs, counts: c, hash };
  }

  async function releasePreview({ actor, organizerId = null, eventId, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    if (!['provisional', 'official'].includes(body.stage)) return fail('validation_failed', 422, { fields: [{ path: 'stage', code: 'invalid' }] });
    const scope = await releaseScope(db, ctx.event, ctx.categories, body.categoryId ?? null, body.stage);
    if (scope.error) return scope;
    const { counts } = scope;
    return { previewHash: scope.hash, finished: counts.finished, dnf: counts.dnf, dns: counts.dns, dq: counts.dq, noResult: counts.noResult, unsettled: counts.unsettled, rejected: counts.rejected, willMarkDns: counts.noResult };
  }

  async function release({ actor, organizerId = null, eventId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const stage = body.stage;
    if (!['provisional', 'official'].includes(stage)) return fail('validation_failed', 422, { fields: [{ path: 'stage', code: 'invalid' }] });
    if (typeof body.previewHash !== 'string' || !body.previewHash) return fail('validation_failed', 422, { fields: [{ path: 'previewHash', code: 'required' }] });
    const refused = await guardOpen(ctx.event);
    if (refused) return refused;
    const categoryId = body.categoryId ? String(body.categoryId) : null;
    let published = null;
    const out = await idempotent({ actor, route: `results.release:${ctx.event.id}:${categoryId ?? '*'}:${stage}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const scope = await releaseScope(trx, ctx.event, ctx.categories, categoryId, stage);
      if (scope.error) return scope;
      if (scope.hash !== body.previewHash) return fail('preview_stale', 409);
      const { byCategory } = await stagesOf(trx, ctx.event, ctx.categories);
      if (scope.scopeCats.some(c => byCategory.get(c.id) === 'official')) return fail('already_released', 409);
      const { counts } = scope;
      if (stage === 'provisional' && counts.finished + counts.dnf + counts.dns + counts.dq + counts.unsettled < 1) return fail('no_results', 422);
      if (stage === 'official' && counts.unsettled > 0 && body.leaveUnsettledOut !== true) return fail('unsettled_results', 409, { unsettled: counts.unsettled });
      let marked = 0;
      if (stage === 'official' && body.markRemainingDns === true) {
        const catBy = new Map(ctx.categories.map(c => [c.id, c]));
        for (const r of scope.regs.filter(x => !x.resultId)) {
          const reg = plain(await trx('EventRegistration').where({ id: r.registrationId }).forUpdate().first());
          await writeRevision(trx, { category: catBy.get(reg.categoryId), reg, prev: null, input: { sourceType: 'organizer_verified', finishStatus: 'dns', verificationStatus: 'verified', verifiedBy: actor.userId, submittedByUserId: actor.userId, reasonCode: null } });
          marked += 1;
        }
      }
      const resultCount = counts.finished + counts.dnf + counts.dns + counts.dq + marked;
      const releaseId = newId('erel');
      const at = stamp();
      await trx('EventResultRelease').insert({ id: releaseId, eventId: ctx.event.id, categoryId, stage, action: 'release', resultCount, unsettledCount: counts.unsettled, releasedBy: actor.userId, releasedAt: at, note: null });
      if (stage === 'official') {
        await recomputeRanks(trx, ctx.event, ctx.categories);
        await enqueueAwardTask(trx, { eventId: ctx.event.id, reason: 'release', releaseId, at });
      }
      await outbox(trx, ctx.event, 'result.published', 'event', ctx.event.id, { eventId: ctx.event.id, categoryId, stage, releasedAt: at.toISOString(), resultCount });
      await audit(actor, 'events.results_released', ctx.event.id, null, { releaseId, categoryId, stage, resultCount, unsettled: counts.unsettled, markedDns: marked }, trx);
      published = { releaseId, categoryId, stage, scopeIds: scope.scopeCats.map(c => c.id) };
      return { release: { id: releaseId, stage, categoryId, resultCount, unsettledCount: counts.unsettled, releasedAt: at.toISOString(), markedDns: marked }, status: 200 };
    }));
    if (published && !out.error && !out.replayed) {
      await announceRelease(ctx.event, published);
      await analytics('events_results_released', { eventId: ctx.event.id, stage, count: out.release.resultCount });
    }
    return out;
  }

  async function withdraw({ actor, organizerId = null, eventId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const categoryId = body.categoryId ? String(body.categoryId) : null;
    if (categoryId && !ctx.categories.some(c => c.id === categoryId)) return fail('category_not_found', 404);
    return idempotent({ actor, route: `results.withdraw:${ctx.event.id}:${categoryId ?? '*'}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const { byCategory } = await stagesOf(trx, ctx.event, ctx.categories);
      const scopeCats = categoryId ? ctx.categories.filter(c => c.id === categoryId) : ctx.categories;
      if (scopeCats.some(c => byCategory.get(c.id) === 'official')) return fail('already_released', 409);
      if (!scopeCats.some(c => byCategory.get(c.id) === 'provisional')) return fail('nothing_to_withdraw', 409);
      const id = newId('erel');
      await trx('EventResultRelease').insert({ id, eventId: ctx.event.id, categoryId, stage: 'provisional', action: 'withdraw', resultCount: 0, unsettledCount: 0, releasedBy: actor.userId, releasedAt: stamp() });
      await audit(actor, 'events.results_withdrawn', ctx.event.id, null, { releaseId: id, categoryId }, trx);
      return { withdrawn: { id, categoryId }, status: 200 };
    }));
  }

  // ── Notices ───────────────────────────────────────────────────────────────

  /** An inbox row without a push (releases above EVENTS_RESULTS_PUSH_MAX). Title and body follow the person's language; both stay in data. */
  async function inboxOnly(userId, { id, type, en, sw, data }) {
    let locale = null;
    try { locale = await localeOf(userId); } catch { locale = null; }
    const t = locale === 'sw' ? sw : en;
    await db('Notification').insert({
      id: id.slice(0, 60), userId, type, title: t.title, body: t.body,
      data: JSON.stringify({ ...data, type, locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body }), createdAt: stamp(),
    }).onConflict('id').ignore();
  }

  async function tellParticipant(registrationId, event, kind, { id, route, outcome = null }) {
    try {
      const reg = plain(await db('EventRegistration').where({ id: registrationId }).first('participantUserId'));
      if (!reg?.participantUserId) return;
      const copy = kind === 'corrected' ? COPY.resultCorrected({ event: event.title }) : kind === 'rejected' ? COPY.resultRejected({ event: event.title }) : COPY.disputeUpdate({ outcome });
      const type = ({ corrected: 'event_result_corrected', rejected: 'event_result_rejected', dispute: 'event_dispute_update' })[kind];
      await notice(reg.participantUserId, { id, type, en: copy.en, sw: copy.sw, data: { eventId: event.id, registrationId, route, essential: true } });
    } catch (err) { console.warn('[events-results] notice skipped:', kind, err?.message); }
  }
  async function tellOrganizer(event, kind, { id, route = '/organizer/events', roles = ['owner', 'admin'] }) {
    try {
      const staff = await db('EventOrganizerStaff').where({ organizerId: event.organizerId, status: 'active' }).whereIn('role', roles).select('userId');
      const copy = kind === 'disputeOpened' ? COPY.disputeOpened({ event: event.title }) : COPY.adminException({ event: event.title });
      for (const s of staff) await notice(s.userId, { id: `${id}_${s.userId}`.slice(0, 60), type: kind === 'disputeOpened' ? 'event_dispute_update' : 'event_result_corrected', en: copy.en, sw: copy.sw, data: { eventId: event.id, organizerId: event.organizerId, route, essential: true } });
    } catch (err) { console.warn('[events-results] organizer notice skipped:', kind, err?.message); }
  }

  /** Push a "results are out" notice to claimed participants of the scope. Above EVENTS_RESULTS_PUSH_MAX the notices are in-app only. */
  async function announceRelease(event, { stage, scopeIds }) {
    try {
      const people = (await db('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
        .where('r.eventId', event.id).where('r.status', 'confirmed').whereIn('r.categoryId', scopeIds).whereNotNull('r.participantUserId')
        .whereNot('e.verificationStatus', 'rejected').select('r.id', 'r.participantUserId')).map(plain);
      const quiet = people.length > pushMax();
      const copy = COPY.resultPublished({ event: event.title, stage });
      for (const p of people) {
        const message = { id: `evres:${p.id}:${stage}`, type: 'event_result_published', en: copy.en, sw: copy.sw, data: { eventId: event.id, registrationId: p.id, route: `/member/events/registrations/${p.id}/result` } };
        if (quiet) await inboxOnly(p.participantUserId, message); else await notice(p.participantUserId, message);
      }
    } catch (err) { console.warn('[events-results] release notices skipped:', err?.message); }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async function updateSettings({ actor, organizerId = null, eventId, key, body = {} }) {
    if (!allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const v = validateSettings(body);
    if (v.fields) return fail('validation_failed', 422, { fields: v.fields });
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    return idempotent({ actor, route: `results.settings:${ctx.event.id}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const { rows } = await stagesOf(trx, ctx.event, ctx.categories);
      const locked = rows.some(r => r.stage === 'official' && r.action === 'release');
      const current = policyOf(ctx.event, disputeDefaultHours());
      const touchesRules = Boolean(v.categories) || Object.keys(v.all).length || (v.policy.publicNames !== undefined);
      if (locked) {
        if (touchesRules) return fail('settings_locked', 409);
        if (v.policy.disputeWindowHours !== undefined && v.policy.disputeWindowHours < current.disputeWindowHours) return fail('settings_locked', 409, { reason: 'window_cannot_shorten' });
      }
      const at = stamp();
      const nextPolicy = { ...(ctx.event.resultsPolicy ?? {}), ...v.policy };
      await trx('Event').where({ id: ctx.event.id }).update({ resultsPolicy: JSON.stringify(nextPolicy), updatedAt: at });
      const patches = new Map();
      for (const c of ctx.categories) if (Object.keys(v.all).length) patches.set(c.id, { ...v.all });
      for (const c of v.categories ?? []) {
        if (!ctx.categories.some(x => x.id === c.id)) return fail('category_not_found', 404);
        patches.set(c.id, { ...(patches.get(c.id) ?? {}), ...c.rules });
      }
      for (const [id, patch] of patches) {
        const cat = ctx.categories.find(c => c.id === id);
        const merged = { ...(cat.resultRules ?? {}), ...patch };
        for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
        await trx('EventCategory').where({ id }).update({ resultRules: JSON.stringify(merged), updatedAt: at });
      }
      await audit(actor, 'events.results_settings_changed', ctx.event.id, { policy: current }, { policy: v.policy, categories: [...patches.keys()] }, trx);
      const fresh = await load({ organizerId, eventId, q: trx });
      return { settings: settingsOf(fresh.event, fresh.categories), status: 200 };
    }));
  }

  // ── Disputes ──────────────────────────────────────────────────────────────

  const disputeView = d => ({
    id: d.id, registrationId: d.registrationId, resultId: d.resultId, reasonCode: d.reasonCode, note: d.note, status: d.status, resolutionNote: d.resolutionNote,
    createdAt: iso(d.createdAt), resolvedAt: iso(d.resolvedAt),
  });

  async function disputesList({ actor, organizerId = null, eventId, query = {} }) {
    if (!allowed(actor, 'read')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const status = query.status ? String(query.status) : null;
    if (status && !['open', 'upheld', 'rejected', 'withdrawn'].includes(status)) return fail('invalid_request', 400, { field: 'status' });
    const rows = (await db('EventResultDispute as d').join('EventRegistration as r', 'r.id', 'd.registrationId').where('r.eventId', ctx.event.id).modify((q) => { if (status) q.where('d.status', status); })
      .orderBy('d.createdAt', 'desc').limit(200).select('d.*', 'r.firstName', 'r.lastName', 'r.bibNumber')).map(plain);
    const policy = policyOf(ctx.event, disputeDefaultHours());
    const { rows: releases } = await stagesOf(db, ctx.event, ctx.categories);
    const regs = rows.length ? (await db('EventRegistration').whereIn('id', rows.map(r => r.registrationId)).select('id', 'categoryId')).map(plain) : [];
    const catOf = new Map(regs.map(r => [r.id, r.categoryId]));
    const links = rows.length ? (await db('EventActivityLink').whereIn('registrationId', rows.map(r => r.registrationId)).where({ linkType: 'event_run' }).whereNull('unlinkedAt').select('registrationId', 'distanceMeters', 'elapsedMs', 'movingSeconds')).map(plain) : [];
    const linkOf = new Map(links.map(l => [l.registrationId, l]));
    return {
      items: rows.map((d) => {
        const rel = latestRelease(releases, catOf.get(d.registrationId));
        const windowEndsAt = rel ? new Date(+new Date(rel.releasedAt) + policy.disputeWindowHours * 3_600_000).toISOString() : null;
        const l = linkOf.get(d.registrationId);
        return { ...disputeView(d), bibNumber: d.bibNumber, displayName: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim(), windowEndsAt, linkedRun: l ? { distanceMeters: l.distanceMeters, elapsedMs: num(l.elapsedMs), movingSeconds: l.movingSeconds } : null };
      }),
      disputesOpen: rows.filter(r => r.status === 'open').length,
    };
  }

  async function disputeResolve({ actor, organizerId = null, eventId, disputeId, key, body = {} }) {
    const isAdmin = actor.kind === 'admin';
    if (!isAdmin && !allowed(actor, 'decide')) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId: isAdmin ? null : organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    if (!['upheld', 'rejected'].includes(body.outcome)) return fail('validation_failed', 422, { fields: [{ path: 'outcome', code: 'invalid' }] });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 5 || note.length > 500) return fail('validation_failed', 422, { fields: [{ path: 'note', code: note.length < 5 ? 'too_short' : 'too_long' }] });
    let notify = null;
    const out = await idempotent({ actor, route: `results.dispute_resolve:${disputeId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const d = plain(await trx('EventResultDispute as d').join('EventRegistration as r', 'r.id', 'd.registrationId').where('d.id', String(disputeId)).where('r.eventId', ctx.event.id).forUpdate().first('d.*'));
      if (!d) return fail('dispute_not_found', 404);
      if (d.status !== 'open') return fail('dispute_closed', 409, { status: d.status });
      if (isAdmin) {
        const organizer = plain(await trx('EventOrganizer').where({ id: ctx.event.organizerId }).first('status'));
        const stale = +stamp() - +new Date(d.createdAt) > 7 * DAY;
        if (!stale && organizer?.status === 'active') return fail('organizer_can_resolve', 409);
      }
      const cur = await currentOf(trx, ctx.event, d.resultId);
      let resultAfter = null;
      if (body.outcome === 'upheld') {
        const correction = body.correction && typeof body.correction === 'object' ? body.correction : null;
        if (!correction) return fail('correction_required', 422);
        if (!cur || !cur.isCurrent) return fail('result_changed', 409);
        if (correction.expectedRevision !== undefined && correction.expectedRevision !== cur.revision) return fail('result_changed', 409, { currentRevision: cur.revision });
        const done = correction.action === 'disqualify' ? await disqualifyIn(trx, { ctx, actor, row: cur, body: correction, via: 'dispute' }) : await correctIn(trx, { ctx, actor, row: cur, body: correction, via: 'dispute' });
        if (done.error) return done;
        resultAfter = done.result.id;
      }
      const at = stamp();
      await trx('EventResultDispute').where({ id: d.id }).update({ status: body.outcome, resolutionNote: note, resolvedBy: actor.userId, resolvedAt: at, resultIdAfter: resultAfter, updatedAt: at });
      await outbox(trx, ctx.event, 'result.disputed', 'registration', d.registrationId, { registrationId: d.registrationId, resultId: d.resultId, disputeId: d.id, status: body.outcome });
      await audit(actor, 'events.dispute_resolved', ctx.event.id, { status: 'open' }, { disputeId: d.id, outcome: body.outcome, ...(isAdmin ? { actor: 'admin' } : {}) }, trx);
      notify = { registrationId: d.registrationId, disputeId: d.id, status: body.outcome };
      return { dispute: { id: d.id, status: body.outcome, resolvedAt: at.toISOString(), resultIdAfter: resultAfter }, status: 200 };
    }));
    if (notify && !out.error) await tellParticipant(notify.registrationId, ctx.event, 'dispute', { id: `evdis:${notify.disputeId}:${notify.status}`, route: `/member/events/registrations/${notify.registrationId}/result`, outcome: notify.status });
    return out;
  }

  // ── Participant (member app) ──────────────────────────────────────────────

  /** The registration a member may see a result of: the participant (full), or the purchaser (full while unclaimed, status only after the claim). */
  async function myRegistration(userId, registrationId) {
    const reg = plain(await db('EventRegistration').where({ id: String(registrationId) }).first());
    if (!reg) return null;
    if (reg.participantUserId === userId) return { reg, viewer: 'participant' };
    if (reg.purchaserUserId === userId) return { reg, viewer: reg.participantUserId ? 'purchaser_status_only' : 'participant' };
    return null;
  }

  const windowOf = (event, releases, categoryId) => {
    const policy = policyOf(event, disputeDefaultHours());
    const own = releases.filter(r => r.action === 'release' && (r.categoryId === categoryId || !r.categoryId));
    const official = own.filter(r => r.stage === 'official').sort((a, b) => Number(a.seq) - Number(b.seq))[0];
    const first = official ?? own.sort((a, b) => Number(a.seq) - Number(b.seq))[0];
    return first ? { startsAt: iso(first.releasedAt), endsAt: new Date(+new Date(first.releasedAt) + policy.disputeWindowHours * 3_600_000).toISOString() } : null;
  };

  async function personalBest(userId, event, category, row) {
    if (!row || row.finishStatus !== 'finished' || !['verified', 'corrected'].includes(row.verificationStatus)) return null;
    const others = (await db('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').join('EventCategory as c', 'c.id', 'r.categoryId')
      .where('r.participantUserId', userId).where('r.status', 'confirmed').whereNot('r.id', row.registrationId).where('e.isCurrent', true)
      .whereIn('e.verificationStatus', ['verified', 'corrected']).where('e.finishStatus', 'finished').where('c.distanceMeters', category.distanceMeters).whereRaw('c."routeType" IS NOT DISTINCT FROM ?', [category.routeType ?? null])
      .whereExists(function official() { this.select(db.raw('1')).from('EventResultRelease as x').whereRaw('x."eventId" = r."eventId"').where('x.stage', 'official').where('x.action', 'release').where(function scope() { this.whereRaw('x."categoryId" = r."categoryId"').orWhereNull('x.categoryId'); }); })
      .select('e.elapsedMs')).map(plain);
    const best = others.length ? Math.min(...others.map(o => Number(o.elapsedMs))) : null;
    return { isPersonalBest: best === null || Number(row.elapsedMs) < best, previousBestElapsedMs: best, basis: 'same_distance_and_route_type' };
  }

  async function medalsFor(registrationId) {
    // Defined by the award service (medal view); the result page asks through the injected hook so this file stays free of art logic.
    return hooks.medalsForRegistration ? hooks.medalsForRegistration(registrationId) : [];
  }
  const hooks = { medalsForRegistration: null, rewardsForRegistration: null, runLinksFor: null };

  async function myResult({ userId, registrationId }) {
    const found = await myRegistration(userId, registrationId);
    if (!found) return fail('registration_not_found', 404);
    const { reg, viewer } = found;
    const ctx = await load({ eventId: reg.eventId });
    const category = ctx.categories.find(c => c.id === reg.categoryId);
    const { rows: releases, byCategory } = await stagesOf(db, ctx.event, ctx.categories);
    const row = plain(await db('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
    const open = await openDisputes(db, [reg.id]);
    const stage = reg.status === 'confirmed' ? deriveStage({ row, release: byCategory.get(reg.categoryId) ?? 'none', disputeOpen: open.has(reg.id) }) : 'none';
    const base = { registrationId: reg.id, eventId: ctx.event.id, eventTitle: ctx.event.title, eventType: ctx.event.eventType, categoryId: reg.categoryId, categoryName: category?.name ?? null, distanceMeters: num(category?.distanceMeters), bibNumber: reg.bibNumber ?? null,
      registrationStatus: reg.status, eventCancelled: ctx.event.status === 'cancelled', claimNeeded: !reg.participantUserId };
    if (viewer === 'purchaser_status_only') return { ...base, stage, viewer, finishStatus: stage === 'none' ? null : (row?.finishStatus ?? null) };
    const release = latestRelease(releases, reg.categoryId);
    const visibleRow = row && stage !== 'none' ? row : null;
    let result = null;
    if (visibleRow) {
      const finishers = Number((await db('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').where('r.eventId', ctx.event.id).where('r.categoryId', reg.categoryId).where('e.isCurrent', true)
        .where('e.finishStatus', 'finished').whereIn('e.verificationStatus', ['verified', 'corrected']).whereNotNull('e.categoryRank').count({ n: '*' }).first()).n);
      result = {
        id: visibleRow.id, revision: visibleRow.revision, finishStatus: visibleRow.finishStatus, verificationStatus: visibleRow.verificationStatus, sourceType: visibleRow.sourceType, sourceLabel: visibleRow.sourceLabel,
        netElapsedMs: num(visibleRow.netElapsedMs), gunElapsedMs: num(visibleRow.gunElapsedMs), elapsedMs: stage === 'disqualified' ? null : num(visibleRow.elapsedMs),
        overallRank: ['official', 'corrected', 'disputed'].includes(stage) ? visibleRow.overallRank : null, categoryRank: ['official', 'corrected', 'disputed'].includes(stage) ? visibleRow.categoryRank : null,
        finishersInCategory: finishers, withinCutoff: visibleRow.withinCutoff, verifiedAt: iso(visibleRow.verifiedAt), correctedAt: visibleRow.verificationStatus === 'corrected' ? iso(visibleRow.updatedAt) : null,
        reasonCode: visibleRow.reasonCode, correctionNote: visibleRow.correctionReason,
        personalBest: ['official', 'corrected'].includes(stage) ? await personalBest(userId, ctx.event, category, visibleRow) : null,
      };
    }
    const dispute = plain(await db('EventResultDispute').where({ registrationId: reg.id }).orderBy('createdAt', 'desc').first());
    const win = windowOf(ctx.event, releases, reg.categoryId);
    const since = new Date(+stamp() - DAY);
    const todays = Number((await db('EventResultDispute').where({ raisedByUserId: userId }).where('createdAt', '>', since).count({ n: '*' }).first()).n);
    const canRaise = viewer === 'participant' && reg.participantUserId === userId && reg.status === 'confirmed' && Boolean(row) && !['none', 'rejected'].includes(stage) && !open.has(reg.id)
      && Boolean(win) && +stamp() <= +new Date(win.endsAt) && todays < 5;
    const vis = visibilityOf(reg, ctx.event, category, clauseVersions());
    return {
      ...base, stage, viewer, result,
      release: { stage: byCategory.get(reg.categoryId) ?? 'none', releasedAt: release?.releasedAt ?? null },
      dispute: dispute ? { id: dispute.id, status: dispute.status, createdAt: iso(dispute.createdAt), resolvedAt: iso(dispute.resolvedAt), resolutionNote: dispute.resolutionNote, canRaise, windowEndsAt: win?.endsAt ?? null } : { id: null, status: null, createdAt: null, resolvedAt: null, resolutionNote: null, canRaise, windowEndsAt: win?.endsAt ?? null },
      visibility: { current: vis.current, canChange: vis.canChange && reg.participantUserId === userId, allowed: vis.allowed, ...(vis.reason ? { reason: vis.reason } : {}) },
      runLinks: hooks.runLinksFor ? await hooks.runLinksFor(reg.id, userId) : [],
      medals: await medalsFor(reg.id),
      rewardsEarned: hooks.rewardsForRegistration ? await hooks.rewardsForRegistration(reg.id, userId) : [],
    };
  }

  async function myResults({ userId, query = {} }) {
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .join('Event as ev', 'ev.id', 'r.eventId').join('EventCategory as c', 'c.id', 'r.categoryId')
      .where('r.participantUserId', userId).where('r.status', 'confirmed').whereIn('e.verificationStatus', ['verified', 'corrected', 'disqualified'])
      .whereExists(function official() { this.select(db.raw('1')).from('EventResultRelease as x').whereRaw('x."eventId" = r."eventId"').where('x.stage', 'official').where('x.action', 'release').where(function scope() { this.whereRaw('x."categoryId" = r."categoryId"').orWhereNull('x.categoryId'); }); });
    if (cursor?.at) q.where(function k() { this.where('ev.startsAt', '<', new Date(cursor.at)).orWhere(function t() { this.where('ev.startsAt', new Date(cursor.at)).where('r.id', '<', cursor.id); }); });
    const rows = (await q.orderBy('ev.startsAt', 'desc').orderBy('r.id', 'desc').limit(limit + 1)
      .select('r.id as registrationId', 'r.bibNumber', 'ev.id as eventId', 'ev.title as eventTitle', 'ev.startsAt', 'c.name as categoryName', 'c.distanceMeters', 'e.finishStatus', 'e.verificationStatus', 'e.elapsedMs', 'e.overallRank', 'e.categoryRank')).map(plain);
    const page = rows.slice(0, limit);
    return {
      items: page.map(r => ({
        registrationId: r.registrationId, eventId: r.eventId, eventTitle: r.eventTitle, eventStartsAt: iso(r.startsAt), categoryName: r.categoryName, distanceMeters: num(r.distanceMeters), bibNumber: r.bibNumber,
        finishStatus: r.finishStatus, stage: r.verificationStatus === 'disqualified' ? 'disqualified' : r.verificationStatus === 'corrected' ? 'corrected' : 'official',
        elapsedMs: r.verificationStatus === 'disqualified' ? null : num(r.elapsedMs), overallRank: r.overallRank, categoryRank: r.categoryRank,
      })),
      nextCursor: rows.length > limit ? encodeCursor({ at: page[page.length - 1].startsAt, id: page[page.length - 1].registrationId }) : null,
    };
  }

  async function setVisibility({ userId, registrationId, body = {} }) {
    const found = await myRegistration(userId, registrationId);
    if (!found || found.viewer !== 'participant' || found.reg.participantUserId !== userId) return fail('registration_not_found', 404);
    const { reg } = found;
    if (!VISIBILITIES.includes(body.visibility)) return fail('validation_failed', 422, { fields: [{ path: 'visibility', code: 'invalid' }] });
    const ctx = await load({ eventId: reg.eventId });
    const category = ctx.categories.find(c => c.id === reg.categoryId);
    const vis = visibilityOf(reg, ctx.event, category, clauseVersions());
    if (!vis.allowed.includes(body.visibility) || (boardTreatedAsMinor(reg, ctx.event, category) && body.visibility === 'standard')) return fail('visibility_not_allowed', 422, { reason: vis.reason, allowed: vis.allowed });
    const same = reg.resultsVisibilitySetAt && reg.resultsVisibility === body.visibility;
    if (!same) {
      await db('EventRegistration').where({ id: reg.id }).update({ resultsVisibility: body.visibility, resultsVisibilitySetAt: stamp() });
      await audit(userId, 'events.result_visibility_changed', ctx.event.id, { visibility: vis.current }, { registrationId: reg.id, visibility: body.visibility });
    }
    return { visibility: body.visibility };
  }

  async function raiseDispute({ userId, registrationId, body = {} }) {
    const found = await myRegistration(userId, registrationId);
    if (!found || found.viewer !== 'participant' || found.reg.participantUserId !== userId) return fail('registration_not_found', 404);
    const { reg } = found;
    if (!DISPUTE_REASONS.includes(body.reasonCode)) return fail('validation_failed', 422, { fields: [{ path: 'reasonCode', code: 'invalid', allowed: DISPUTE_REASONS }] });
    const note = body.note === undefined || body.note === null || body.note === '' ? null : (typeof body.note === 'string' && body.note.trim().length <= 500 ? body.note.trim() : false);
    if (note === false) return fail('validation_failed', 422, { fields: [{ path: 'note', code: 'too_long' }] });
    const ctx = await load({ eventId: reg.eventId });
    let event = ctx.event;
    const out = await db.transaction(async (trx) => {
      await lockEvent(trx, event.id);
      const lockedReg = plain(await trx('EventRegistration').where({ id: reg.id }).forUpdate().first());
      if (lockedReg.status !== 'confirmed') return fail('registration_not_found', 404);
      const row = plain(await trx('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
      const { rows: releases, byCategory } = await stagesOf(trx, event, ctx.categories);
      const stage = row ? deriveStage({ row, release: byCategory.get(reg.categoryId) ?? 'none' }) : 'none';
      if (!row || ['none', 'rejected'].includes(stage)) return fail('no_result', 409);
      const win = windowOf(event, releases, reg.categoryId);
      if (!win || +stamp() > +new Date(win.endsAt)) return fail('dispute_window_closed', 409);
      const since = new Date(+stamp() - DAY);
      const todays = Number((await trx('EventResultDispute').where({ raisedByUserId: userId }).where('createdAt', '>', since).count({ n: '*' }).first()).n);
      if (todays >= 5) return fail('rate_limited', 429, { retryAfterSeconds: 3600 });
      const id = newId('edis');
      try {
        await trx('EventResultDispute').insert({ id, registrationId: reg.id, resultId: row.id, raisedByUserId: userId, reasonCode: body.reasonCode, note, status: 'open', createdAt: stamp(), updatedAt: stamp() });
      } catch (err) {
        if (err.code === UNIQUE) return fail('dispute_open', 409);
        throw err;
      }
      await outbox(trx, event, 'result.disputed', 'registration', reg.id, { registrationId: reg.id, resultId: row.id, disputeId: id, status: 'open' });
      await audit(userId, 'events.dispute_raised', event.id, null, { disputeId: id, registrationId: reg.id, reasonCode: body.reasonCode }, trx);
      return { dispute: { id, status: 'open', createdAt: stamp().toISOString() }, status: 201 };
    });
    if (!out.error) { await tellOrganizer(event, 'disputeOpened', { id: `evdis:${out.dispute.id}:open`, route: `/organizer/events?event=${event.id}&view=results&section=disputes` }); await analytics('events_dispute_raised', { eventId: event.id }); }
    return out;
  }

  async function withdrawDispute({ userId, registrationId, disputeId }) {
    const found = await myRegistration(userId, registrationId);
    if (!found || found.reg.participantUserId !== userId) return fail('registration_not_found', 404);
    const ctx = await load({ eventId: found.reg.eventId });
    return db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const d = plain(await trx('EventResultDispute').where({ id: String(disputeId), registrationId: found.reg.id }).forUpdate().first());
      if (!d) return fail('dispute_not_found', 404);
      if (d.status !== 'open') return fail('dispute_closed', 409, { status: d.status });
      await trx('EventResultDispute').where({ id: d.id }).update({ status: 'withdrawn', updatedAt: stamp() });
      await outbox(trx, ctx.event, 'result.disputed', 'registration', d.registrationId, { registrationId: d.registrationId, resultId: d.resultId, disputeId: d.id, status: 'withdrawn' });
      await audit(userId, 'events.dispute_withdrawn', ctx.event.id, { status: 'open' }, { disputeId: d.id }, trx);
      return { dispute: { id: d.id, status: 'withdrawn' }, status: 200 };
    });
  }

  // ── The board (signed-in members) ─────────────────────────────────────────

  async function board({ userId, eventId, query = {} }) {
    const ctx = await load({ eventId });
    if (!ctx || !LIVE_EVENT.includes(ctx.event.status)) return fail('event_not_found', 404);
    const { event, categories } = ctx;
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const { rows: releases, byCategory } = await stagesOf(db, event, categories);
    const released = categories.filter(c => (byCategory.get(c.id) ?? 'none') !== 'none');
    const chosen = query.categoryId ? released.filter(c => c.id === String(query.categoryId)) : released;
    if (query.categoryId && !chosen.length && categories.some(c => c.id === String(query.categoryId))) return { event: { title: event.title, eventType: event.eventType, timezone: event.timezone }, release: { stage: 'none', releasedAt: null }, categories: released.map(c => ({ id: c.id, name: c.name, distanceMeters: num(c.distanceMeters) })), items: [], mine: null, nextCursor: null };
    if (query.categoryId && !categories.some(c => c.id === String(query.categoryId))) return fail('category_not_found', 404);
    const policy = policyOf(event, disputeDefaultHours());
    const rows = chosen.length ? (await db('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', event.id).where('r.status', 'confirmed').whereIn('r.categoryId', chosen.map(c => c.id)).whereNot('e.verificationStatus', 'rejected')
      .select('r.id', 'r.firstName', 'r.lastName', 'r.bibNumber', 'r.categoryId', 'r.dateOfBirth', 'r.resultsVisibility', 'r.resultsVisibilitySetAt', 'r.consentTextVersion', 'r.consentBasis', 'r.participantUserId',
        'e.verificationStatus', 'e.finishStatus', 'e.elapsedMs', 'e.overallRank', 'e.categoryRank', 'e.sourceType')).map(plain) : [];
    const catBy = new Map(categories.map(c => [c.id, c]));
    const disputes = await openDisputes(db, rows.map(r => r.id));
    const shaped = [];
    let mine = null;
    for (const r of rows) {
      const category = catBy.get(r.categoryId);
      const stageNow = byCategory.get(r.categoryId);
      const stage = deriveStage({ row: r, release: stageNow, disputeOpen: disputes.has(r.id) });
      if (stage === 'none') continue;
      if (r.participantUserId === userId) mine = { rank: query.categoryId || chosen.length === 1 ? r.categoryRank : r.overallRank, bibNumber: r.bibNumber ?? null };
      // visibilityOf already makes a minor bib-only, and keeps a minor's own choice of 'hidden' (H1)
      const vis = visibilityOf(r, event, category, clauseVersions()).current;
      const name = boardName(r, vis, policy.publicNames);
      if (name === null) continue;
      const pendingNoTime = r.verificationStatus === 'pending_verification' && ['dnf', 'dns', 'dq'].includes(r.finishStatus);
      const noTime = pendingNoTime || ['dnf', 'dns', 'dq'].includes(r.finishStatus) || r.verificationStatus === 'disqualified';
      shaped.push({
        rank: noTime ? null : (query.categoryId ? r.categoryRank : r.overallRank), bibNumber: r.bibNumber ?? null,
        displayName: name === ANONYMOUS ? null : name, anonymous: name === ANONYMOUS, elapsedMs: noTime ? null : num(r.elapsedMs),
        // an unverified DNF / DNS / DQ (an API submission) is only 'pending' on a board until a human decides (L3)
        finishStatus: pendingNoTime ? 'pending' : r.verificationStatus === 'disqualified' ? 'dq' : r.finishStatus, stage, sourceType: r.sourceType,
        badges: [...(r.verificationStatus === 'corrected' ? ['corrected'] : []), ...(disputes.has(r.id) ? ['under_review'] : [])],
        _name: vis === 'standard' && name !== ANONYMOUS ? name.toLowerCase() : '', _g: noTime ? 1 : 0, _id: r.id,
      });
    }
    const term = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const filtered = term ? shaped.filter(i => (i.bibNumber && i.bibNumber.toLowerCase() === term) || (i._name && i._name.startsWith(term))) : shaped;
    filtered.sort((a, b) => a._g - b._g || (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity) || String(a.bibNumber ?? '').localeCompare(String(b.bibNumber ?? '')) || a._id.localeCompare(b._id));
    const offset = Number.isInteger(cursor?.o) && cursor.o >= 0 ? cursor.o : 0;
    const page = filtered.slice(offset, offset + limit).map(({ _name, _g, _id, ...rest }) => rest);
    const rel = chosen.length === 1 ? latestRelease(releases, chosen[0].id) : (chosen.every(c => byCategory.get(c.id) === 'official') ? latestRelease(releases, null) : null);
    return {
      event: { title: event.title, eventType: event.eventType, timezone: event.timezone }, anonymousLabel: { en: 'Runner', sw: 'Mkimbiaji' },
      release: { stage: chosen.length && chosen.every(c => byCategory.get(c.id) === 'official') ? 'official' : (chosen.length ? 'provisional' : 'none'), releasedAt: rel?.releasedAt ?? null },
      categories: released.map(c => ({ id: c.id, name: c.name, distanceMeters: num(c.distanceMeters), stage: byCategory.get(c.id) })),
      items: page, mine, nextCursor: offset + limit < filtered.length ? encodeCursor({ o: offset + limit }) : null,
    };
  }

  // ── /v1 reads ─────────────────────────────────────────────────────────────

  async function apiList({ organizerId, eventId, query = {} }) {
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const since = query.updatedSince ? new Date(String(query.updatedSince)) : null;
    if (since && Number.isNaN(+since)) return fail('invalid_request', 400, { field: 'updatedSince' });
    if (query.status && !['pending_verification', 'verified', 'rejected', 'corrected', 'disqualified', 'finished', 'dnf', 'dns', 'dq'].includes(String(query.status))) return fail('invalid_request', 400, { field: 'status' });
    const q = db('EventResult as e').join('EventRegistration as r', 'r.id', 'e.registrationId').where('r.eventId', ctx.event.id).where('e.isCurrent', true);
    if (query.categoryId) q.where('r.categoryId', String(query.categoryId));
    if (query.status) q.where(function s() { this.where('e.verificationStatus', String(query.status)).orWhere('e.finishStatus', String(query.status)); });
    if (since) q.where('e.updatedAt', '>=', since);
    if (cursor?.after) q.where('e.id', '>', String(cursor.after));
    const rows = (await q.orderBy('e.id').limit(limit + 1).select('e.*', 'r.categoryId', 'r.bibNumber')).map(plain);
    const page = rows.slice(0, limit);
    const { byCategory } = await stagesOf(db, ctx.event, ctx.categories);
    return {
      items: page.map(e => ({
        registrationId: e.registrationId, resultId: e.id, revision: e.revision, bibNumber: e.bibNumber ?? null, categoryId: e.categoryId, finishStatus: e.finishStatus, verificationStatus: e.verificationStatus,
        stage: deriveStage({ row: e, release: byCategory.get(e.categoryId) ?? 'none' }), sourceType: e.sourceType, netElapsedMs: num(e.netElapsedMs), gunElapsedMs: num(e.gunElapsedMs), elapsedMs: num(e.elapsedMs),
        overallRank: e.overallRank, categoryRank: e.categoryRank, updatedAt: iso(e.updatedAt),
      })),
      nextCursor: rows.length > limit ? encodeCursor({ after: page[page.length - 1].id }) : null,
    };
  }

  async function apiReleases({ organizerId, eventId }) {
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const rows = await releaseRowsOf(db, ctx.event.id);
    return { items: rows.map(r => ({ categoryId: r.categoryId, stage: r.stage, action: r.action, releasedAt: iso(r.releasedAt), resultCount: r.resultCount })) };
  }

  // ── Additive decorations of existing member / public responses ────────────

  /** `resultStage`, `resultsVisibility` and `medalsCount` for rows of GET /me/event-registrations[/:id]. */
  async function decorateRegistrations(items, userId = null) {
    const ids = items.map(i => i.id).filter(Boolean);
    if (!ids.length) return items;
    const regs = (await db('EventRegistration').whereIn('id', ids)  .select('id', 'eventId', 'categoryId', 'resultsVisibility', 'resultsVisibilitySetAt', 'dateOfBirth', 'consentTextVersion', 'consentBasis', 'participantUserId')).map(plain);
    const rows = (await db('EventResult').whereIn('registrationId', ids).where({ isCurrent: true })).map(plain);
    const rowBy = new Map(rows.map(r => [r.registrationId, r]));
    const eventIds = [...new Set(regs.map(r => r.eventId))];
    const releases = eventIds.length ? (await db('EventResultRelease').whereIn('eventId', eventIds).orderBy('seq')).map(plain) : [];
    const events = new Map((await db('Event').whereIn('id', eventIds)).map(e => [e.id, plain(e)]));
    const cats = new Map((await db('EventCategory').whereIn('eventId', eventIds)).map(c => [c.id, plain(c)]));
    const medals = new Map((await db('EventMedalAward').whereIn('registrationId', ids).where({ awardStatus: 'awarded' }).groupBy('registrationId').select('registrationId').count({ n: '*' })).map(m => [m.registrationId, Number(m.n)]));
    const open = await openDisputes(db, ids);
    const regBy = new Map(regs.map(r => [r.id, r]));
    return items.map((item) => {
      const reg = regBy.get(item.id);
      if (!reg) return item;
      const stage = categoryStage(releases.filter(r => r.eventId === reg.eventId), reg.categoryId);
      // A place the viewer bought but somebody else claimed: a status chip only (D57, M5): no visibility choice, no medal count.
      if (userId && reg.participantUserId && reg.participantUserId !== userId) return { ...item, resultStage: deriveStage({ row: rowBy.get(item.id) ?? null, release: stage, disputeOpen: open.has(item.id) }) };
      const vis = visibilityOf(reg, events.get(reg.eventId), cats.get(reg.categoryId), clauseVersions());
      return { ...item, resultStage: deriveStage({ row: rowBy.get(item.id) ?? null, release: stage, disputeOpen: open.has(item.id) }), resultsVisibility: vis.current, medalsCount: medals.get(item.id) ?? 0 };
    });
  }

  /** The public `results` block of GET /events/:id: stages only. */
  async function publicBlock(eventId) {
    const ctx = await load({ eventId });
    if (!ctx) return null;
    const { rows, byCategory } = await stagesOf(db, ctx.event, ctx.categories);
    const stages = [...byCategory.values()];
    const stage = stages.length && stages.every(s => s === 'official') ? 'official' : stages.some(s => s !== 'none') ? 'provisional' : 'none';
    const rel = rows.filter(r => r.action === 'release').sort((a, b) => Number(b.seq) - Number(a.seq))[0];
    return { stage, releasedAt: stage === 'none' ? null : iso(rel?.releasedAt), categories: ctx.categories.map(c => ({ id: c.id, stage: byCategory.get(c.id) })) };
  }

  return {
    summary, list, detail, importPreview, importApply, importsList, apiImport, enter, verify, reject, bulkPreview, bulkApply, correct, disqualify,
    releasePreview, release, withdraw, updateSettings, disputesList, disputeResolve, myResult, myResults, setVisibility, raiseDispute, withdrawDispute, board,
    apiList, apiReleases, decorateRegistrations, publicBlock,
    hooks, internals: { load, stagesOf, writeRevision, recomputeRanks, idempotent, audit, outbox, lockEvent, allowed, stamp, tellParticipant, tellOrganizer, inboxOnly, rowOf: currentOf, regOf, awardsOn, rewardsOn },
  };
}
