// Postgres store for vendor smart import (VendorImportBatch, VendorImportRow). Dedicated store, not a knex
// collection: every query is parameterised and scoped by vendorId (another vendor's batch is simply not found),
// and nothing loads a whole table. Design: docs/design/vendor-import-v1.md.
import { randomUUID } from 'node:crypto';
import { eatDayStart } from '../shared/vendor-stock.mjs';

const UNIQUE_VIOLATION = '23505';
export const DAILY_BATCH_CAP = 20;
export const OPEN_BATCH_CAP = 3;
/** A batch stuck in `applying` longer than this was abandoned by a crashed request: the next apply may take it over. */
export const STALE_APPLY_MS = 2 * 60 * 1000;

const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const short = () => randomUUID().replaceAll('-', '').slice(0, 12);
const batchId = () => `vib_${short()}`;
const rowId = () => `vir_${short()}`;
const encode = value => Buffer.from(value, 'utf8').toString('base64url');
const decode = value => { try { return Buffer.from(String(value), 'base64url').toString('utf8'); } catch { return ''; } };
const RANK = `(CASE status WHEN 'invalid' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END)`;

const EMPTY_COUNTS = Object.freeze({ total: 0, valid: 0, needs_review: 0, invalid: 0, pending: 0, applied: 0, failed: 0, skipped: 0 });

export function createPgVendorImportStore({ db, now = () => new Date() }) {
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
  async function productExists(id, vendorId) {
    const row = await db('Product').where({ id }).first('id', 'vendorId', 'deletedAt');
    return Boolean(row) && row.vendorId === vendorId;
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
        const existing = await trx('VendorImportBatch').where({ vendorId, fileSha256 }).whereNot({ status: 'discarded' }).first();
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
        const existing = await db('VendorImportBatch').where({ vendorId, fileSha256 }).whereNot({ status: 'discarded' }).first();
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
      for (const r of results) {
        await trx('VendorImportRow').where({ id: r.id, batchId: id, vendorId }).update({
          normalized: JSON.stringify(r.normalized ?? {}), status: r.status, issues: JSON.stringify(r.issues ?? []), applyState: 'pending', lastError: null,
        });
      }
      const counts = await countsIn(trx, id, vendorId);
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId }).update({
        mapping: JSON.stringify(mapping), status, templateVersion, counts: JSON.stringify(counts), updatedAt: now(),
      }).returning('*');
      return batchOf(batch);
    });
  }

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
    const stale = new Date(+at - STALE_APPLY_MS);
    const rows = await db('VendorImportBatch').where({ id, vendorId }).where(function () {
      this.whereIn('status', from).orWhere(function () { this.where({ status: 'applying' }).where('applyStartedAt', '<', stale); });
    }).update({ status: 'applying', applyStartedAt: at, updatedAt: at, includeNeedsReview }).returning('*');
    return rows.length ? batchOf(rows[0]) : null;
  }
  const isStale = batch => batch?.status === 'applying' && batch.applyStartedAt != null && +now() - +new Date(batch.applyStartedAt) > STALE_APPLY_MS;
  /** Keep the claim alive between chunks so a long apply is never taken over. */
  const touch = (vendorId, id) => db('VendorImportBatch').where({ id, vendorId, status: 'applying' }).update({ applyStartedAt: now() });

  const eligible = (q, includeNeedsReview) => q.where({ applyState: 'pending' }).whereIn('status', includeNeedsReview ? ['valid', 'needs_review'] : ['valid']);
  async function nextEligible({ vendorId, id, limit, includeNeedsReview }) {
    return plain(await eligible(db('VendorImportRow').where({ batchId: id, vendorId }), includeNeedsReview).orderBy('rowNo').limit(limit));
  }
  async function countEligible({ vendorId, id, includeNeedsReview }) {
    return Number((await eligible(db('VendorImportRow').where({ batchId: id, vendorId }), includeNeedsReview).count('* as n').first()).n);
  }
  async function markRow({ vendorId, id, patch }) {
    await db('VendorImportRow').where({ id, vendorId }).update(patch);
  }
  async function bumpAttempt(vendorId, id) {
    await db('VendorImportRow').where({ id, vendorId }).increment('attempts', 1);
  }

  /** Back to `ready` (more rows to go) or to the end state; counts refreshed. Only from `applying`. */
  async function release({ vendorId, id, status, finished }) {
    return db.transaction(async (trx) => {
      const counts = await countsIn(trx, id, vendorId);
      const at = now();
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId, status: 'applying' }).update({
        status, counts: JSON.stringify(counts), updatedAt: at, ...(finished ? { finishedAt: at } : {}),
      }).returning('*');
      return batchOf(batch) || null;
    });
  }

  /** The batch ended: rows nobody applied are marked skipped, and raw cells of unmapped columns are dropped. */
  async function skipPending({ vendorId, id }) {
    await db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'pending' }).update({ applyState: 'skipped' });
  }
  /** Keep only the raw cells of the mapped columns (the rest were never imported and are not ours to keep). */
  async function dropUnmappedRaw({ vendorId, id, mappedSources }) {
    await db.raw(`UPDATE "VendorImportRow" SET raw = COALESCE((
        SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(raw) AS e(key, value)
        WHERE e.key IN (SELECT jsonb_array_elements_text(?::jsonb))
      ), '{}'::jsonb)
      WHERE "batchId" = ? AND "vendorId" = ?`, [JSON.stringify(mappedSources), id, vendorId]);
  }
  async function refreshCounts(vendorId, id) {
    const counts = await countsIn(db, id, vendorId);
    await db('VendorImportBatch').where({ id, vendorId }).update({ counts: JSON.stringify(counts) });
    return counts;
  }

  /** Failed rows → pending again (their attempts are kept). → how many. */
  async function requeueFailed({ vendorId, id }) {
    return db('VendorImportRow').where({ batchId: id, vendorId, applyState: 'failed' }).update({ applyState: 'pending' });
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
      if (await trx('VendorImportRow').where({ batchId: id, vendorId, applyState: 'applied' }).first('id')) return { error: 'not_discardable' };
      const at = now();
      const [batch] = await trx('VendorImportBatch').where({ id, vendorId }).update({ status: 'discarded', updatedAt: at, finishedAt: at }).returning('*');
      return { batch: batchOf(batch) };
    });
  }

  // The lock holds one pooled connection while the chunk's service calls use others, so at most APPLY_SLOTS chunks run
  // at once per server (pool max 10): the rest wait here instead of starving the pool.
  const APPLY_SLOTS = 3;
  let busy = 0;
  const waiting = [];
  const acquire = () => (busy < APPLY_SLOTS ? (busy += 1, Promise.resolve()) : new Promise(resolve => waiting.push(resolve)));
  const release_ = () => { const next = waiting.shift(); if (next) next(); else busy -= 1; };

  /** Serialises SKU checks and creates of one vendor across concurrent imports; `fn` runs while the lock is held. */
  async function withVendorLock(vendorId, fn) {
    await acquire();
    try {
      return await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`vimp-apply:${vendorId}`]);
        return fn(trx);
      });
    } finally {
      release_();
    }
  }

  return {
    vendorProducts, productRow, productExists, productsBySku: productsBySkuOf, createBatch, getBatch, listBatches, sampleRaw, rowsPage, rowsWithIssues, eachRow,
    saveMapping, claim, isStale, touch, nextEligible, countEligible, markRow, bumpAttempt, release, skipPending, dropUnmappedRaw, refreshCounts,
    requeueFailed, countFailed, anyApplied, discard, withVendorLock,
  };
}
