// Postgres store for vendor smart import (VendorImportBatch, VendorImportRow). Dedicated store, not a knex
// collection: every query is parameterised and scoped by vendorId (another vendor's batch is simply not found),
// and nothing loads a whole table. Design: docs/design/vendor-import-v1.md.
import { randomUUID } from 'node:crypto';
import { eatDayStart } from '../shared/vendor-stock.mjs';
import { PROFILE_IMPORT_FIELDS } from '../shared/vendor-import-rules.mjs';

/** The claim on a batch moved to another request (taken over after a stall): stop writing. */
export class ClaimLostError extends Error { constructor() { super('claim_lost'); this.code = 'claim_lost'; } }
/** Waited too long for a place to run, or the request went away while waiting. */
export class SlotError extends Error { constructor(code) { super(code); this.code = code; } }

const UNIQUE_VIOLATION = '23505';
export const DAILY_BATCH_CAP = 20;
export const OPEN_BATCH_CAP = 3;
/** Batches nobody finished are discarded (and their cells dropped) after this many days. */
export const ABANDONED_AFTER_DAYS = 30;
/** How long a request may wait for one of the per-server apply places. */
export const SLOT_WAIT_MS = 15_000;
/** Ended batches keep their counts and codes but lose every typed cell after this many days. */
export const ENDED_CLEAR_AFTER_DAYS = 30;

/** Issue params that are ours (field names, limits, counts, category suggestions) — everything else may hold a cell. */
const SAFE_PARAMS = ['field', 'max', 'found', 'expected', 'suggestion', 'suggestionSw', 'suggestionKey'];
const SCRUB_ISSUES = `COALESCE((SELECT jsonb_agg(CASE WHEN (i->'params') IS NOT NULL THEN jsonb_set(i, '{params}', COALESCE((
    SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(i->'params') AS e WHERE e.key IN (${SAFE_PARAMS.map(k => `'${k}'`).join(', ')})), '{}'::jsonb)) ELSE i END)
    FROM jsonb_array_elements(issues) AS i), '[]'::jsonb)`;
/** A batch stuck in `applying` longer than this was abandoned by a crashed request: the next apply may take it over. */
export const STALE_APPLY_MS = 2 * 60 * 1000;

const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const short = () => randomUUID().replaceAll('-', '').slice(0, 12);
const batchId = () => `vib_${short()}`;
const rowId = () => `vir_${short()}`;
const encode = value => Buffer.from(value, 'utf8').toString('base64url');
const decode = value => { try { return Buffer.from(String(value), 'base64url').toString('utf8'); } catch { return ''; } };
const RANK = `(CASE status WHEN 'invalid' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END)`;

/** Statuses where a batch is still open: the same file may not be uploaded again until it ends (applied, partial or discarded). */
const IN_FLIGHT = ['mapping_required', 'ready', 'applying'];
const EMPTY_COUNTS = Object.freeze({ total: 0, valid: 0, needs_review: 0, invalid: 0, pending: 0, applied: 0, failed: 0, skipped: 0 });

export function createPgVendorImportStore({ db, now = () => new Date(), applySlots = 3, slotWaitMs = SLOT_WAIT_MS, staleApplyMs = STALE_APPLY_MS }) {
  /** The batch as the service sees it (jsonb already parsed by pg). */
  const batchOf = row => (row ? plain(row) : null);

  // ── products the checks compare against ─────────────────────────────────────
  /** Every live product of the vendor (id, name, sku, stock, variants): small columns only. */
  async function vendorProducts(vendorId) {
    return plain(await db('Product').where({ vendorId }).whereNull('deletedAt').select('id', 'name', 'sku', 'stock', 'variants')) || [];
  }
  /** One live product of the vendor (stock and variants), or null. */
  async function productRow(vendorId, id) {
    return plain(await db('Product').where({ id, vendorId }).whereNull('deletedAt').first('id', 'name', 'sku', 'stock', 'variants')) || null;
  }
  /** 'live' | 'deleted' | 'none' for a product id of this vendor (another vendor's id counts as none). */
  async function productState(id, vendorId) {
    const row = await db('Product').where({ id }).first('id', 'vendorId', 'deletedAt');
    if (!row || row.vendorId !== vendorId) return 'none';
    return row.deletedAt ? 'deleted' : 'live';
  }
  /** Live products of the vendor whose SKU equals `sku` (case-insensitive, trimmed). */
  async function productsBySku(q, vendorId, sku) {
    return plain(await q('Product').where({ vendorId }).whereNull('deletedAt').whereRaw('lower(btrim(sku)) = ?', [String(sku).trim().toLowerCase()]).select('id', 'name', 'sku')) || [];
  }
  const productsBySkuOf = (vendorId, sku, q = db) => productsBySku(q, vendorId, sku);

  // ── creating a batch ────────────────────────────────────────────────────────
  /**
   * One transaction under the vendor's lock: quota (≤ 20 batches per EAT day, ≤ 3 not finished), then the batch
   * and its rows. → { batch } | { error: 'import_quota', reason } | { error: 'duplicate_file', existing }.
   */
  async function createBatch({ vendorId, createdBy, entity, filename, sizeBytes, fileSha256, templateVersion, delimiter, status, mapping, rows, counts: given = null }) {
    const at = now();
    const eatToday = eatDayStart(new Date(+at + 3 * 3600_000).toISOString().slice(0, 10));
    try {
      return await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`vimp-create:${vendorId}`]);
        const existing = await trx('VendorImportBatch').where({ vendorId, fileSha256 }).whereIn('status', IN_FLIGHT).first();
        if (existing) return { error: 'duplicate_file', status: 409, existing: batchOf(existing) };
        const today = Number((await trx('VendorImportBatch').where({ vendorId }).where('createdAt', '>=', eatToday).count('* as n').first()).n);
        if (today >= DAILY_BATCH_CAP) return { error: 'import_quota', status: 429, reason: 'daily', max: DAILY_BATCH_CAP };
        const open = Number((await trx('VendorImportBatch').where({ vendorId }).whereIn('status', ['mapping_required', 'ready', 'applying']).count('* as n').first()).n);
        if (open >= OPEN_BATCH_CAP) return { error: 'import_quota', status: 429, reason: 'open', max: OPEN_BATCH_CAP };
        const id = batchId();
        const counts = given || countsOfRows(rows);
        const [batch] = await trx('VendorImportBatch').insert({
          id, vendorId, createdBy, entity, source: 'csv', filename, sizeBytes, fileSha256, templateVersion, delimiter, status,
          counts: JSON.stringify(counts), mapping: JSON.stringify(mapping), createdAt: at, updatedAt: at,
        }).returning('*');
        for (let i = 0; i < rows.length; i += 250) {
          await trx('VendorImportRow').insert(rows.slice(i, i + 250).map(r => ({
            id: rowId(), batchId: id, vendorId, rowNo: r.rowNo, entity, raw: JSON.stringify(r.raw),
            normalized: JSON.stringify(r.normalized ?? {}), status: r.status, issues: JSON.stringify(r.issues ?? []),
          })));
        }
        return { batch: batchOf(batch) };
      });
    } catch (err) {
      // Two uploads of the same file at once: the unique index decides.
      if (err.code === UNIQUE_VIOLATION && /vendorimportbatch_vendor_sha_live/.test(err.constraint || err.message)) {
        const existing = await db('VendorImportBatch').where({ vendorId, fileSha256 }).whereIn('status', IN_FLIGHT).first();
        if (existing) return { error: 'duplicate_file', status: 409, existing: batchOf(existing) };
      }
      throw err;
    }
  }

  const countsOfRows = rows => ({
    ...EMPTY_COUNTS, total: rows.length,
    valid: rows.filter(r => r.status === 'valid').length,
    needs_review: rows.filter(r => r.status === 'needs_review').length,
    invalid: rows.filter(r => r.status === 'invalid').length,
    pending: rows.length,
  });

  // ── reading ─────────────────────────────────────────────────────────────────
  const getBatch = async (vendorId, id) => batchOf(await db('VendorImportBatch').where({ id, vendorId }).first());

  async function listBatches({ vendorId, status = null, limit, cursor = null }) {
    const q = db('VendorImportBatch').where({ vendorId });
    if (status) q.where({ status });
    if (cursor) {
      const [at, id] = decode(cursor).split('|');
      if (!at || !id || Number.isNaN(+new Date(at))) return { error: 'invalid_cursor', status: 400 };
      q.whereRaw('("createdAt", id) < (?, ?)', [new Date(at), id]);
    }
    const rows = await q.orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit + 1);
    const page = rows.slice(0, limit).map(batchOf);
    const last = page[page.length - 1];
    return { batches: page, nextCursor: rows.length > limit && last ? encode(`${new Date(last.createdAt).toISOString()}|${last.id}`) : null };
  }

  /** The first rows' raw cells, for the sample values beside each column. */
  async function sampleRaw(vendorId, id, n = 3) {
    return (await db('VendorImportRow').where({ batchId: id, vendorId }).orderBy('rowNo').limit(n).select('raw')).map(r => r.raw);
  }

  /** Keyset page of rows, problem rows first (invalid, needs_review, valid), then by row number. */
  async function rowsPage({ vendorId, id, status = null, limit, cursor = null }) {
    const q = db('VendorImportRow').where({ batchId: id, vendorId });
    if (status) q.where({ status });
    if (cursor) {
      const [rank, rowNo] = decode(cursor).split(':').map(Number);
      if (!Number.isInteger(rank) || !Number.isInteger(rowNo)) return { error: 'invalid_cursor', status: 400 };
      q.whereRaw(`(${RANK}, "rowNo") > (?, ?)`, [rank, rowNo]);
    }
    const rows = plain(await q.orderByRaw(`${RANK}, "rowNo"`).limit(limit + 1));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const rank = r => ({ invalid: 0, needs_review: 1, valid: 2 })[r.status];
    return { rows: page, nextCursor: rows.length > limit && last ? encode(`${rank(last)}:${last.rowNo}`) : null };
  }

  /** Rows that carry at least one issue, in row order (the errors file). */
  async function rowsWithIssues(vendorId, id) {
    return plain(await db('VendorImportRow').where({ batchId: id, vendorId }).whereRaw(`jsonb_array_length(issues) > 0`).orderBy('rowNo').select('rowNo', 'raw', 'normalized', 'issues'));
  }
  /** Every row's raw cells, in row order, 500 at a time through `each`. */
  async function eachRow(vendorId, id, each) {
    let after = 0;
    for (;;) {
      const rows = plain(await db('VendorImportRow').where({ batchId: id, vendorId }).where('rowNo', '>', after).orderBy('rowNo').limit(500));
      if (!rows.length) return;
      await each(rows);
      after = rows[rows.length - 1].rowNo;
    }
  }

  // ── mapping ─────────────────────────────────────────────────────────────────
  /** Store a (new) mapping and the re-checked rows in one transaction. `where` status guard: only editable batches. */
  async function saveMapping({ vendorId, id, mapping, status, templateVersion, results }) {
    return db.transaction(async (trx) => {
      const current = await trx('VendorImportBatch').where({ id, vendorId }).forUpdate().first();
      if (!current || !['mapping_required', 'ready'].includes(current.status)) return null;
      // Once any row was applied (or failed while applying) the mapping is fixed: re-checking would rewrite what was imported.
      if (await touchedRows(trx, id, vendorId)) return null;
      for (const r of results) {
        await trx('VendorImportRow').where({ id: r.id, batchId: id, vendorId, applyState: 'pending' }).update({
          normalized: JSON.stringify(r.normalized ?? {}), status: r.status, issues: JSON.stringify(r.issues ?? []), lastError: null,
        });
      }
      const counts = await countsIn(trx, id, vendorId);
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId }).update({
        mapping: JSON.stringify(mapping), status, templateVersion, counts: JSON.stringify(counts), updatedAt: now(),
      }).returning('*');
      return batchOf(batch);
    });
  }

  /** Has any row been tried (attempts > 0) or ended applied/failed? Then mapping and discard are refused. */
  const touchedRows = (q, id, vendorId) => q('VendorImportRow').where({ batchId: id, vendorId }).where(function () {
    this.where('attempts', '>', 0).orWhereIn('applyState', ['applied', 'failed']);
  }).first('id');

  async function countsIn(q, id, vendorId) {
    const rows = await q('VendorImportRow').where({ batchId: id, vendorId }).select('status', 'applyState').count('* as n').groupBy('status', 'applyState');
    const counts = { ...EMPTY_COUNTS };
    for (const r of rows) {
      const n = Number(r.n);
      counts.total += n;
      counts[r.status] += n;
      counts[r.applyState] += n;
    }
    return counts;
  }

  // ── applying ────────────────────────────────────────────────────────────────
  /**
   * Compare-and-set into `applying`: from `from` statuses, or from an `applying` that has been silent for STALE_APPLY_MS
   * (a crashed request). → the batch, or null when another request holds it / the status does not allow it.
   */
  async function claim({ vendorId, id, from, includeNeedsReview }) {
    const at = now();
    const stale = new Date(+at - staleApplyMs);
    const claimToken = randomUUID();
    try {
      const rows = await db('VendorImportBatch').where({ id, vendorId }).where(function () {
        this.whereIn('status', from).orWhere(function () { this.where({ status: 'applying' }).where('applyStartedAt', '<', stale); });
      }).update({
        status: 'applying', applyStartedAt: at, updatedAt: at, claimToken,
        preClaimStatus: db.raw(`CASE WHEN status = 'applying' THEN "preClaimStatus" ELSE status END`),
        // The first apply decides, for the batch's whole life: later calls and retries use what is stored.
        includeNeedsReview: db.raw('COALESCE("includeNeedsReview", ?)', [Boolean(includeNeedsReview)]),
      }).returning('*');
      return rows.length ? batchOf(rows[0]) : null;
    } catch (err) {
      // A retry would put this batch back in flight while the same file is open in another batch.
      if (err.code === UNIQUE_VIOLATION && /vendorimportbatch_vendor_sha_live/.test(err.constraint || err.message)) {
        const current = await db('VendorImportBatch').where({ id, vendorId }).first();
        const other = current && await db('VendorImportBatch').where({ vendorId, fileSha256: current.fileSha256 }).whereIn('status', IN_FLIGHT).whereNot({ id }).first();
        return other ? { duplicate: batchOf(other) } : null;
      }
      throw err;
    }
  }
  const isStale = batch => batch?.status === 'applying' && batch.applyStartedAt != null && +now() - +new Date(batch.applyStartedAt) > staleApplyMs;
  /** Keep the claim alive (before waiting for a place or the lock, and between chunks). Throws when the claim moved on. */
  async function touch(vendorId, id, token) {
    const n = await db('VendorImportBatch').where({ id, vendorId, status: 'applying', claimToken: token }).update({ applyStartedAt: now() });
    if (!n) throw new ClaimLostError();
  }
  /** Rows may be written only while this request still holds the claim. */
  const heldBy = (vendorId, id, token) => function () {
    this.select(1).from('VendorImportBatch').where({ id, vendorId, status: 'applying', claimToken: token });
  };

  const eligible = (q, includeNeedsReview) => q.where({ applyState: 'pending' }).whereIn('status', includeNeedsReview ? ['valid', 'needs_review'] : ['valid']);
  async function nextEligible({ vendorId, id, limit, includeNeedsReview }) {
    return plain(await eligible(db('VendorImportRow').where({ batchId: id, vendorId }), includeNeedsReview).orderBy('rowNo').limit(limit));
  }
  async function countEligible({ vendorId, id, includeNeedsReview }) {
    return Number((await eligible(db('VendorImportRow').where({ batchId: id, vendorId }), includeNeedsReview).count('* as n').first()).n);
  }
  async function markRow({ vendorId, batchId: bid, id, token, patch }) {
    const n = await db('VendorImportRow').where({ id, vendorId, batchId: bid }).whereExists(heldBy(vendorId, bid, token)).update(patch);
    if (!n) throw new ClaimLostError();
  }
  async function bumpAttempt({ vendorId, batchId: bid, id, token }) {
    const n = await db('VendorImportRow').where({ id, vendorId, batchId: bid }).whereExists(heldBy(vendorId, bid, token)).increment('attempts', 1);
    if (!n) throw new ClaimLostError();
  }

  /** Back to `ready` (more rows to go) or to the end state; counts refreshed. Only from `applying`. */
  async function release({ vendorId, id, token, status, finished }) {
    return db.transaction(async (trx) => {
      const counts = await countsIn(trx, id, vendorId);
      const at = now();
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId, status: 'applying', claimToken: token }).update({
        status, counts: JSON.stringify(counts), updatedAt: at, claimToken: null, ...(finished ? { finishedAt: at } : {}),
      }).returning('*');
      return batchOf(batch) || null;
    });
  }

  /** The batch ended: rows nobody applied are marked skipped, and raw cells of unmapped columns are dropped. */
  async function skipPending({ vendorId, id, token }) {
    await db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'pending' }).whereExists(heldBy(vendorId, id, token)).update({ applyState: 'skipped' });
  }
  /** Failed rows → pending again (their attempts are kept). → how many. */
  async function requeueFailed({ vendorId, id, token }) {
    const rows = await db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'failed' }).whereExists(heldBy(vendorId, id, token)).update({ applyState: 'pending' }).returning('id');
    return rows.map(r => r.id);
  }
  /** A retry that gave the batch back untouched: rows it had re-queued and nobody applied go back to failed. */
  async function unrequeue({ vendorId, id, token, rowIds }) {
    if (!rowIds?.length) return 0;
    return db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'pending' }).whereIn('id', rowIds).where('attempts', '>', 0).whereExists(heldBy(vendorId, id, token)).update({ applyState: 'failed' });
  }
  async function countFailed(vendorId, id) {
    return Number((await db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'failed' }).count('* as n').first()).n);
  }
  async function anyApplied(vendorId, id) {
    return Boolean(await db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'applied' }).first('id'));
  }

  /** Discard: only before any row was applied, and not while a request is applying. → the batch or null. */
  async function discard({ vendorId, id }) {
    return db.transaction(async (trx) => {
      const current = await trx('VendorImportBatch').where({ id, vendorId }).forUpdate().first();
      if (!current || !['mapping_required', 'ready'].includes(current.status)) return { error: 'not_discardable' };
      if (await touchedRows(trx, id, vendorId)) return { error: 'not_discardable' };
      const at = now();
      await clearCells(trx, { batchIds: [id], vendorId });
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId }).update({ status: 'discarded', updatedAt: at, finishedAt: at, cellsClearedAt: at, claimToken: null }).returning('*');
      return { batch: batchOf(batch) };
    });
  }

  // The lock holds one pooled connection while the chunk's service calls use others, so at most APPLY_SLOTS chunks run
  // at once per server (applySlots, default 3; pool max 10). A request waits for a place at most slotWaitMs (SLOT_WAIT_MS) and leaves the queue when its
  // client goes away, so one vendor cannot stall the others.
  let busy = 0;
  const waiting = [];
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(new SlotError('request_aborted'));
    if (busy < applySlots) { busy += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => { cleanup(); resolve(); }, reject };
      const leave = (code) => { const i = waiting.indexOf(waiter); if (i >= 0) waiting.splice(i, 1); cleanup(); reject(new SlotError(code)); };
      const timer = setTimeout(() => leave('slot_timeout'), slotWaitMs);
      const onAbort = () => leave('request_aborted');
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  }
  const releaseSlot = () => { const next = waiting.shift(); if (next) next.resolve(); else busy -= 1; };

  /**
   * Serialises SKU checks and creates of one vendor across concurrent imports. The vendor's lock is TRIED, never waited for:
   * → { busy: true } when another import of the vendor holds it; otherwise `fn(trx)` runs while it is held.
   * Throws SlotError (slot_timeout | request_aborted) when no place frees up in time.
   */
  async function withVendorLock(vendorId, fn, { signal } = {}) {
    await acquire(signal);
    try {
      return await db.transaction(async (trx) => {
        const got = (await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS ok', [`vimp-apply:${vendorId}`])).rows[0].ok;
        if (!got) return { busy: true };
        return { value: await fn(trx) };
      });
    } finally {
      releaseSlot();
    }
  }

  /** Every typed cell of these batches goes: raw, checked values, and issue params that could hold a cell (codes and field names stay). */
  async function clearCells(q, { batchIds, vendorId = null, where = '' }) {
    await q.raw(`UPDATE "VendorImportRow" SET raw = '{}'::jsonb, normalized = '{}'::jsonb, issues = ${SCRUB_ISSUES}
      WHERE "batchId" = ANY(?::text[]) ${vendorId ? 'AND "vendorId" = ?' : ''} ${where}`, vendorId ? [batchIds, vendorId] : [batchIds]);
  }

  /** Discard batches nobody finished (open and untouched for `days`): frees the file lock and drops every cell. → how many. */
  async function purgeAbandoned({ days = ABANDONED_AFTER_DAYS } = {}) {
    const cutoff = new Date(+now() - days * 86_400_000);
    return db.transaction(async (trx) => {
      const stale = await trx('VendorImportBatch').whereIn('status', ['mapping_required', 'ready']).where('updatedAt', '<', cutoff)
        .whereNotExists(function () {
          this.select(1).from('VendorImportRow').whereRaw('"VendorImportRow"."batchId" = "VendorImportBatch".id')
            .where(function () { this.where('attempts', '>', 0).orWhereIn('applyState', ['applied', 'failed']); });
        }).forUpdate().skipLocked().select('id');
      const ids = stale.map(r => r.id);
      if (!ids.length) return 0;
      const at = now();
      await clearCells(trx, { batchIds: ids });
      await trx('VendorImportBatch').whereIn('id', ids).update({ status: 'discarded', updatedAt: at, finishedAt: at, cellsClearedAt: at, claimToken: null });
      return ids.length;
    });
  }

  /**
   * Ended batches (applied, partial, discarded) older than `days` lose every typed cell; the batch row and its counts stay as history.
   * errors.csv of such a batch has the codes and messages but empty values. → how many batches.
   */
  async function clearEnded({ days = ENDED_CLEAR_AFTER_DAYS } = {}) {
    const cutoff = new Date(+now() - days * 86_400_000);
    return db.transaction(async (trx) => {
      const ended = await trx('VendorImportBatch').whereIn('status', ['applied', 'partial', 'discarded']).whereNull('cellsClearedAt')
        .whereRaw('COALESCE("finishedAt", "updatedAt") < ?', [cutoff]).forUpdate().skipLocked().limit(200).select('id');
      const ids = ended.map(r => r.id);
      if (!ids.length) return 0;
      await clearCells(trx, { batchIds: ids });
      await trx('VendorImportBatch').whereIn('id', ids).update({ cellsClearedAt: now() });
      return ids.length;
    });
  }

  /**
   * A batch silent in `applying` for more than `days` (its request died long ago) goes to a safe state through the same
   * claim-token guard as every write: `partial` when any row was tried, else `ready`. → how many.
   */
  async function resetStaleApplying({ days = ENDED_CLEAR_AFTER_DAYS } = {}) {
    const cutoff = new Date(+now() - days * 86_400_000);
    return db.transaction(async (trx) => {
      const stuck = await trx('VendorImportBatch').where({ status: 'applying' }).where('applyStartedAt', '<', cutoff).forUpdate().skipLocked().select('id', 'vendorId', 'claimToken');
      let n = 0;
      for (const b of stuck) {
        const tried = await touchedRows(trx, b.id, b.vendorId);
        const at = now();
        const q = trx('VendorImportBatch').where({ id: b.id, vendorId: b.vendorId, status: 'applying' });
        const guarded = b.claimToken == null ? q.whereNull('claimToken') : q.where({ claimToken: b.claimToken });
        n += await guarded.update({ status: tried ? 'partial' : 'ready', updatedAt: at, claimToken: null, ...(tried ? { finishedAt: at } : {}) });
      }
      return n;
    });
  }

  /** The finish of an apply, ALL in one transaction guarded by the claim token (a request that lost it writes nothing). */
  async function finish({ vendorId, id, token, mappedSources, entity }) {
    return db.transaction(async (trx) => {
      const held = await trx('VendorImportBatch').where({ id, vendorId, status: 'applying', claimToken: token }).forUpdate().first('id');
      if (!held) throw new ClaimLostError();
      await trx('VendorImportRow').where({ batchId: id, vendorId, applyState: 'pending' }).update({ applyState: 'skipped' });
      const counts = await countsIn(trx, id, vendorId);
      const status = counts.applied === counts.total ? 'applied' : 'partial';
      // rows not applied keep only their mapped cells (errors.csv needs them); applied rows keep nothing but counts and codes
      await trx.raw(`UPDATE "VendorImportRow" SET raw = COALESCE((
          SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(raw) AS e(key, value)
          WHERE e.key IN (SELECT jsonb_array_elements_text(?::jsonb))), '{}'::jsonb)
        WHERE "batchId" = ? AND "vendorId" = ?`, [JSON.stringify(mappedSources), id, vendorId]);
      await trx.raw(`UPDATE "VendorImportRow" SET raw = '{}'::jsonb, normalized = '{}'::jsonb, issues = ${SCRUB_ISSUES}
        WHERE "batchId" = ? AND "vendorId" = ? AND "applyState" = 'applied'`, [id, vendorId]);
      // the profile holds contact details: nothing of it stays once the row is no longer waiting for a retry
      if (entity === 'profile') {
        await trx.raw(`UPDATE "VendorImportRow" SET raw = '{}'::jsonb, normalized = '{}'::jsonb, issues = ${SCRUB_ISSUES}
          WHERE "batchId" = ? AND "vendorId" = ? AND "applyState" <> 'failed'`, [id, vendorId]);
      }
      const at = now();
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId }).update({
        status, counts: JSON.stringify(counts), updatedAt: at, finishedAt: at, claimToken: null,
      }).returning('*');
      return batchOf(batch);
    });
  }

  /**
   * Fill the empty profile fields of the account holder under a row lock on the User row (an owner save and an import
   * cannot interleave a read-modify-write). Only the allowlisted fields; publish, payout account, logo, banner,
   * commission and areas are never touched; status stays as it is. → { filled } | { error }.
   */
  async function fillProfile({ vendorId, patch }) {
    return db.transaction(async (trx) => {
      const row = await trx('User').where({ id: vendorId }).forUpdate().first('id', 'vendorProfile');
      if (!row) return { error: 'vendor_not_found' };
      const prior = row.vendorProfile || {};
      const filled = {};
      for (const key of PROFILE_IMPORT_FIELDS) {
        if (patch[key] != null && String(patch[key]).trim() !== '' && (prior[key] == null || String(prior[key]).trim() === '')) filled[key] = patch[key];
      }
      if (!Object.keys(filled).length) return { filled };
      const profile = { ...prior, ...filled, vendorId, status: prior.status || 'draft', updatedAt: now().toISOString() };
      await trx('User').where({ id: vendorId }).update({ vendorProfile: JSON.stringify(profile), updatedAt: now() });
      return { filled };
    });
  }

  return {
    vendorProducts, productRow, productState, productsBySku: productsBySkuOf, createBatch, getBatch, listBatches, sampleRaw, rowsPage, rowsWithIssues, eachRow,
    saveMapping, claim, isStale, touch, purgeAbandoned, clearEnded, resetStaleApplying, finish, fillProfile, staleApplyMs, nextEligible, countEligible, markRow, bumpAttempt, release, skipPending,
    requeueFailed, unrequeue, countFailed, anyApplied, discard, withVendorLock,
  };
}
