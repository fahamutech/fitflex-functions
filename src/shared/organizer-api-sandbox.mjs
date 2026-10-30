// Marathon & running events · S5 — the API SANDBOX (spec §5.5). A sandbox client sees ONE built-in event, `evt_sandbox`, with three
// categories, two collection points and 25 clearly fake registrations ("Test Runner 01" …: no phone, email or dates). Reads return
// this fixture. Writes are validated and answered as if applied (including 409 already_collected for a repeated registration) but
// persist NOTHING: there is no way to touch real data and nothing to clean up. The only memory is a short in-process map so a
// repeated handover in the same session is refused as it would be live; it never reaches a database.
import { normaliseBib, encodeCursor, decodeCursor, parseLimit, MANUAL_REASONS } from './events-ops-rules.mjs';

export const SANDBOX_EVENT_ID = 'evt_sandbox';
const TOTAL = 25;
const pad = n => String(n).padStart(2, '0');
const CATS = [{ id: 'ecat_sandbox_5k', name: '5K', distanceM: 5000 }, { id: 'ecat_sandbox_10k', name: '10K', distanceM: 10000 }, { id: 'ecat_sandbox_21k', name: 'Half marathon', distanceM: 21097 }];
const POINTS = [{ id: 'ecp_sandbox_a', name: 'Sandbox kit point A' }, { id: 'ecp_sandbox_b', name: 'Sandbox kit point B' }];
const BASE = Date.parse('2030-01-01T05:00:00.000Z') - 30 * 86_400_000;

export const sandboxEvent = () => ({
  id: SANDBOX_EVENT_ID, title: 'FitFlex sandbox run', slug: 'fitflex-sandbox-run', status: 'published', startsAt: '2030-01-01T05:00:00.000Z', endsAt: '2030-01-01T11:00:00.000Z', timezone: 'Africa/Dar_es_Salaam',
  categories: CATS.map(c => ({ ...c })), collectionPoints: POINTS.map(p => ({ ...p })),
});

/** The 25 registrations, deterministic. #25 is cancelled (a tombstone: no names). */
export function sandboxRegistrations({ demographics = false } = {}) {
  return Array.from({ length: TOTAL }, (_, i) => {
    const n = i + 1;
    const cat = CATS[i % 3];
    const cancelled = n === TOTAL;
    const collected = !cancelled && n <= 5;
    const createdAt = new Date(BASE + n * 3_600_000).toISOString();
    const out = {
      id: `ereg_sandbox_${pad(n)}`, eventId: SANDBOX_EVENT_ID, categoryId: cat.id, categoryName: cat.name, ticketTypeId: 'ett_sandbox', ticketTypeName: 'Sandbox ticket', orderId: `eor_sandbox_${pad(Math.ceil(n / 2))}`,
      status: cancelled ? 'cancelled' : 'confirmed', createdAt, updatedAt: createdAt,
      firstName: cancelled ? null : 'Test', lastName: cancelled ? null : `Runner ${pad(n)}`,
      bibNumber: !cancelled && n <= 15 ? `SB-${String(n).padStart(3, '0')}` : null,
      kit: { state: cancelled ? 'not_ready' : collected ? 'collected' : 'ready', ...(collected ? { collectedAt: new Date(BASE + n * 3_600_000 + 600_000).toISOString() } : {}) },
      kitSize: cancelled ? null : ['s', 'm', 'l'][i % 3], ticketCode: `SBX${pad(n)}-TEST`, teamId: null, teamName: null, groupLabel: null, claimed: n % 2 === 0,
    };
    if (demographics) { out.gender = cancelled ? null : (n % 2 ? 'female' : 'male'); out.ageOnEventDay = cancelled ? null : 20 + (n % 30); }
    return out;
  });
}

export function sandboxList({ query = {}, demographics = false }) {
  const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
  if (limit === null) return { error: 'invalid_limit', status: 400 };
  let rows = sandboxRegistrations({ demographics });
  if (query.status === 'confirmed' || query.status === 'cancelled') rows = rows.filter(r => r.status === query.status);
  if (query.categoryId) rows = rows.filter(r => r.categoryId === String(query.categoryId));
  if (query.bib === 'assigned') rows = rows.filter(r => r.bibNumber); if (query.bib === 'unassigned') rows = rows.filter(r => !r.bibNumber);
  if (query.kit === 'collected') rows = rows.filter(r => r.kit.state === 'collected'); if (query.kit === 'remaining') rows = rows.filter(r => r.status === 'confirmed' && r.kit.state !== 'collected');
  let from = 0;
  if (query.cursor) { const cur = decodeCursor(query.cursor); if (!Number.isInteger(cur?.o) || cur.o < 0) return { error: 'invalid_cursor', status: 400 }; from = cur.o; }
  const page = rows.slice(from, from + limit);
  return { items: page, nextCursor: from + limit < rows.length ? encodeCursor({ o: from + limit }) : null };
}

export function sandboxChanges({ query = {}, demographics = false }) {
  const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
  if (limit === null) return { error: 'invalid_limit', status: 400 };
  let after = 0;
  if (query.cursor) { const cur = decodeCursor(query.cursor); if (!Number.isInteger(cur?.s) || cur.s < 0) return { error: 'invalid_cursor', status: 400 }; after = cur.s; }
  const regs = sandboxRegistrations({ demographics });
  const all = regs.map((r, i) => (r.status === 'cancelled'
    ? { seq: i + 1, id: `obx_sandbox_${pad(i + 1)}`, eventType: 'registration.cancelled', registrationId: r.id, changedAt: r.createdAt, status: 'cancelled', cancelledAt: r.createdAt, reasonCode: 'cancelled' }
    : { seq: i + 1, id: `obx_sandbox_${pad(i + 1)}`, eventType: 'registration.created', registrationId: r.id, changedAt: r.createdAt, status: 'confirmed' }));
  const rows = all.filter(x => x.seq > after);
  const page = rows.slice(0, limit);
  const items = query.expand === 'registration' ? page.map(x => ({ ...x, registration: regs.find(r => r.id === x.registrationId) })) : page;
  return { items, nextCursor: encodeCursor({ s: page.length ? page[page.length - 1].seq : after, t: Date.now() }), hasMore: rows.length > limit };
}

// Short-lived in-process memory so a repeated handover is refused like the live API; bounded, never persisted.
const taken = new Map();
const remember = (key) => { if (taken.size > 2000) taken.clear(); taken.set(key, Date.now()); };
const live = (key) => { const t = taken.get(key); if (t && Date.now() - t < 600_000) return true; taken.delete(key); return false; };
export const resetSandbox = () => taken.clear();
const find = id => sandboxRegistrations().find(r => r.id === id) ?? null;

export function sandboxKit({ clientId, body = {} }) {
  if (!['scan', 'manual'].includes(body.method)) return { error: 'validation_failed', status: 422, fields: [{ path: 'method', code: 'invalid' }] };
  let reg;
  if (body.method === 'scan') {
    const m = /^(?:FFEV1:)?sandbox-(\d{2})$/.exec(String(body.payload ?? '').trim());
    reg = m ? find(`ereg_sandbox_${m[1]}`) : null;
    if (!reg) return { error: String(body.payload ?? '').startsWith('FFEV1:') || /^ev1\./.test(String(body.payload ?? '')) ? 'registration_not_found' : 'not_event_ticket', status: String(body.payload ?? '').startsWith('FFEV1:') ? 404 : 400 };
  } else {
    reg = typeof body.registrationId === 'string' ? find(body.registrationId) : null;
    if (!reg) return { error: 'registration_not_found', status: 404 };
    if (!MANUAL_REASONS.includes(body.manualReason)) return { error: 'manual_reason_required', status: 422, allowed: [...MANUAL_REASONS] };
  }
  if (body.collectionPointId && !POINTS.some(p => p.id === body.collectionPointId)) return { error: 'collection_point_invalid', status: 422 };
  if (!body.collectionPointId) return { error: 'collection_point_required', status: 422 };
  if (reg.status !== 'confirmed') return { error: 'ticket_revoked', status: 409, reason: 'cancelled' };
  const key = `${clientId}:${reg.id}`;
  if (reg.kit.state === 'collected' || live(key)) return { error: 'already_collected', status: 409, collectedAt: reg.kit.collectedAt ?? new Date().toISOString(), collectionPointName: POINTS[0].name, byFirstName: null, canOverride: false };
  remember(key);
  const at = new Date().toISOString();
  return { status: 201, collection: { id: `ekc_sandbox_${reg.id.slice(-2)}`, status: body.status === 'exception' ? 'exception' : 'collected', collectedAt: at, collectionPointId: body.collectionPointId }, card: { displayName: `Test R.`, ticketCode: reg.ticketCode, categoryName: reg.categoryName, bibNumber: reg.bibNumber, kitSize: reg.kitSize, kit: { state: 'collected', collectedAt: at }, payment: 'paid' }, warnings: [] };
}

export function sandboxBib({ clientId, body = {} }) {
  const bib = normaliseBib(body.bibNumber);
  if (!bib) return { error: 'bib_invalid', status: 422 };
  const reg = typeof body.registrationId === 'string' ? find(body.registrationId) : null;
  if (!reg) return { error: 'registration_not_found', status: 404 };
  if (reg.status !== 'confirmed') return { error: 'ticket_revoked', status: 409 };
  const holder = sandboxRegistrations().find(r => r.bibNumber === bib);
  if (holder && holder.id !== reg.id) return { error: 'bib_taken', status: 409 };
  if (reg.bibNumber && reg.bibNumber !== bib && body.replace !== true) return { error: 'bib_already_assigned', status: 409, current: reg.bibNumber };
  if (taken.has(`${clientId}:bib:${bib}`) && !holder) return { error: 'bib_taken', status: 409 };
  remember(`${clientId}:bib:${bib}`);
  return { status: 201, assignment: { id: `ebn_sandbox_${reg.id.slice(-2)}`, registrationId: reg.id, bibNumber: bib, assignedAt: new Date().toISOString() }, previousBibNumber: reg.bibNumber ?? null, warnings: [] };
}

// ── S6: results (spec §8.4). 25 fake runners with three statuses; reads come from here, writes are validated and persist nothing. ──

const RESULT_BASE = Date.parse('2030-01-01T05:30:00.000Z');
/** Results of the fake runners 1–24 (#25 is the cancelled place and has none): 1–15 verified, 16–20 pending_verification, 21–22 dnf, 23–24 dns. */
export function sandboxResults() {
  const regs = sandboxRegistrations();
  const rows = [];
  for (let n = 1; n <= 24; n += 1) {
    const reg = regs[n - 1];
    const finished = n <= 20;
    const elapsed = finished ? (1800 + n * 47) * 1000 : null;
    const verified = n <= 15;
    rows.push({
      registrationId: reg.id, resultId: `eres_sandbox_${pad(n)}`, revision: 1, bibNumber: reg.bibNumber, categoryId: reg.categoryId,
      finishStatus: finished ? 'finished' : n <= 22 ? 'dnf' : 'dns', verificationStatus: verified ? 'verified' : n <= 20 ? 'pending_verification' : 'verified',
      stage: verified ? 'official' : n <= 20 ? 'provisional' : 'official', sourceType: 'timing_provider',
      netElapsedMs: elapsed, gunElapsedMs: elapsed === null ? null : elapsed + 21_000, elapsedMs: elapsed,
      overallRank: verified ? n : null, categoryRank: verified ? Math.ceil(n / 3) : null, updatedAt: new Date(RESULT_BASE + n * 60_000).toISOString(),
    });
  }
  return rows;
}
export function sandboxResultList({ query = {} }) {
  let rows = sandboxResults();
  if (query.categoryId) rows = rows.filter(r => r.categoryId === String(query.categoryId));
  if (query.status) rows = rows.filter(r => r.verificationStatus === String(query.status) || r.finishStatus === String(query.status));
  if (query.updatedSince) { const t = Date.parse(String(query.updatedSince)); if (Number.isNaN(t)) return { error: 'invalid_request', status: 400, field: 'updatedSince' }; rows = rows.filter(r => Date.parse(r.updatedAt) >= t); }
  const limit = parseLimit(query.limit);
  if (limit === null) return { error: 'invalid_request', status: 400, field: 'limit' };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { error: 'invalid_cursor', status: 400 };
  const start = Number.isInteger(cursor?.o) ? cursor.o : 0;
  const page = rows.slice(start, start + limit);
  return { items: page, nextCursor: start + limit < rows.length ? encodeCursor({ o: start + limit }) : null };
}
export const sandboxReleases = () => ({ items: CATS.map(c => ({ categoryId: c.id, stage: 'provisional', action: 'release', releasedAt: new Date(RESULT_BASE).toISOString(), resultCount: 8 })) });

/** A results batch against the sandbox: every row is checked like the live route and answered, nothing is stored. */
export function sandboxResultsImport({ body = {} }) {
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length || rows.length > 500) return { error: 'validation_failed', status: 422, fields: [{ path: 'rows', code: rows && rows.length > 500 ? 'too_many' : 'required' }] };
  const regs = sandboxRegistrations();
  const existing = new Map(sandboxResults().map(r => [r.registrationId, r]));
  const results = rows.map((r, i) => {
    const clientRef = typeof r?.clientRef === 'string' ? r.clientRef.slice(0, 100) : `#${i + 1}`;
    const bib = normaliseBib(r?.bib ?? '');
    const reg = r?.registrationId ? regs.find(x => x.id === r.registrationId) : regs.find(x => x.bibNumber === bib);
    if (!reg || reg.status !== 'confirmed') return { clientRef, ok: false, resultId: null, action: null, error: 'bib_not_found' };
    const status = String(r?.status ?? (r?.netTime ? 'finished' : '')).toLowerCase();
    if (!['finished', 'dnf', 'dns', 'dq'].includes(status)) return { clientRef, ok: false, resultId: null, action: null, error: 'status_invalid' };
    if (status === 'finished' && !/^(\d{1,2}:)?\d{1,2}:\d{2}(\.\d{1,3})?$/.test(String(r?.netTime ?? r?.gunTime ?? ''))) return { clientRef, ok: false, resultId: null, action: null, error: r?.netTime || r?.gunTime ? 'time_invalid' : 'time_missing_for_finisher' };
    const cur = existing.get(reg.id);
    if (cur?.verificationStatus === 'verified' && cur.finishStatus === 'finished') return { clientRef, ok: false, resultId: cur.resultId, action: null, error: 'already_official' };
    return { clientRef, ok: true, resultId: cur?.resultId ?? `eres_sandbox_new_${pad(i + 1)}`, action: cur ? 'revised' : 'created', error: null };
  });
  return { results, status: 200 };
}
