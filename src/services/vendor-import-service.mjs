// Vendor smart import V1 — upload a CSV, match its columns, check every row, apply in chunks, retry, discard, export errors.
// Design: docs/design/vendor-import-v1.md. Nothing here writes products, stock or the profile directly: rows go through the
// shop service (product create with internal options, stock `count` adjustments, saveVendorProfile with publish never set),
// so the service's own validation and approval rules stay in force. Every method takes the vendorId from the caller's
// token and never from the request; another vendor's batch is simply "not found".
import { createHash, randomUUID } from 'node:crypto';
import { parseCsv } from '../shared/csv-parse.mjs';
import { csvDocument } from '../shared/csv-export.mjs';
import {
  IMPORT_ENTITIES, IMPORT_LIMITS, TEMPLATE_VERSION, CRITICAL_FIELDS, fieldDef, fieldKeys, suggestMapping, needsConfirmation, missingRequired,
  autoReady, templateVersionOf, valuesOf, validateRow, templateCsv, lowerKey,
} from '../shared/vendor-import-rules.mjs';
import { issueView, rowErrorView } from '../shared/vendor-import-messages.mjs';
import { ClaimLostError, SlotError } from '../infra/vendor-import-store-pg.mjs';

const CHUNK = 50;
const PER_CALL = 200;
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ROW_STATUSES = ['valid', 'needs_review', 'invalid'];
const BATCH_STATUSES = ['mapping_required', 'ready', 'applying', 'applied', 'partial', 'discarded'];

/** The file name as stored: no path, no control characters, at most 120 characters. Never used to build a path or header. */
export function safeFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base) return 'import.csv';
  if (base.length <= 120) return base;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? '';
  return base.slice(0, 120 - ext.length) + ext;
}

/** Bytes → text, or the error the upload answers with. */
export function readCsvBytes(buffer) {
  if (!buffer || !buffer.length) return fail('empty_file', 400);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return fail('unsupported_file_type', 415, { hint: 'xlsx_not_supported_yet' });
  if (buffer.includes(0)) return fail('unsupported_file_type', 415, { hint: 'binary_or_utf16' });
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch {
    return fail('invalid_encoding', 400);
  }
}

export function createVendorImportService({ store, shop, auditLog, now = () => new Date() }) {
  const nowIso = () => now().toISOString();

  async function audit(actor, action, batch, extra = {}) {
    // Counts only: never rows, contacts, prices or the file name.
    await auditLog.insertAsync({
      id: randomUUID(), at: nowIso(), actor, action, target: batch.id,
      after: { vendorId: batch.vendorId, entity: batch.entity, ...extra },
    });
  }

  // ── views ──────────────────────────────────────────────────────────────────
  const columnsOf = batch => batch.mapping?.columns || [];
  function batchView(batch) {
    const columns = columnsOf(batch);
    return {
      id: batch.id, entity: batch.entity, status: batch.status, filename: batch.filename, sizeBytes: batch.sizeBytes,
      templateVersion: batch.templateVersion ?? null, delimiter: batch.delimiter, counts: batch.counts, createdBy: batch.createdBy,
      includeNeedsReview: batch.includeNeedsReview ?? null,
      needsConfirmation: ['mapping_required', 'ready'].includes(batch.status) && needsConfirmation(batch.entity, columns),
      missingRequired: missingRequired(batch.entity, columns),
      createdAt: batch.createdAt, updatedAt: batch.updatedAt, applyStartedAt: batch.applyStartedAt ?? null, finishedAt: batch.finishedAt ?? null,
    };
  }
  const rowView = row => ({
    id: row.id, rowNo: row.rowNo, status: row.status, applyState: row.applyState, issues: (row.issues || []).map(issueView),
    values: row.normalized || {}, resultId: row.resultId ?? null, lastError: rowErrorView(row.lastError), attempts: row.attempts,
  });
  const loadBatch = async (vendorId, id) => (typeof id === 'string' && id.length <= 40 ? store.getBatch(vendorId, id) : null);
  const notFound = () => fail('import_not_found', 404);

  // ── checking rows ──────────────────────────────────────────────────────────
  async function contextFor(entity, vendorId, costAllowed) {
    const ctx = { costAllowed: Boolean(costAllowed), seenSkus: new Set(), skus: new Map(), names: new Set(), profile: null };
    if (entity === 'products' || entity === 'inventory') {
      for (const product of await store.vendorProducts(vendorId)) {
        if (product.sku && String(product.sku).trim()) {
          const key = lowerKey(product.sku);
          ctx.skus.set(key, [...(ctx.skus.get(key) || []), product]);
        }
        if (product.name) ctx.names.add(lowerKey(product.name));
      }
    }
    if (entity === 'profile') ctx.profile = (await shop.getVendorProfile(vendorId)) || {};
    return ctx;
  }

  /** Check rows (in row order) through the mapping. A row whose shape was wrong at upload stays invalid. */
  function checkRows(entity, columns, rows, ctx) {
    return rows.map((row) => {
      const shape = (row.issues || []).find(i => i.code === 'row_shape');
      if (shape) return { id: row.id, rowNo: row.rowNo, raw: row.raw, normalized: {}, issues: [shape], status: 'invalid' };
      const { values, hasImage } = valuesOf(entity, columns, row.raw || {});
      const out = validateRow(entity, values, hasImage, ctx);
      return { id: row.id, rowNo: row.rowNo, raw: row.raw, ...out };
    });
  }

  // ── upload ─────────────────────────────────────────────────────────────────
  async function upload({ vendorId, actorId, entity, file, costAllowed = false }) {
    if (!IMPORT_ENTITIES.includes(entity)) return fail('invalid_entity', 400, { allowed: IMPORT_ENTITIES });
    if (!file?.buffer) return fail('no_file_provided', 400);
    if (file.truncated || file.buffer.length > IMPORT_LIMITS.maxBytes) return fail('file_too_large', 413, { maxBytes: IMPORT_LIMITS.maxBytes });
    const bytes = readCsvBytes(file.buffer);
    if (bytes.error) return bytes;
    const parsed = parseCsv(bytes.text, IMPORT_LIMITS);
    if (parsed.error) return parsed;
    const names = parsed.header.map(h => h.toLowerCase());
    const emptyAt = parsed.header.findIndex(h => !h);
    if (emptyAt >= 0) return fail('header_invalid', 400, { reason: 'empty_name', column: emptyAt + 1 });
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate !== undefined) return fail('header_invalid', 400, { reason: 'duplicate_name', name: duplicate.slice(0, 80) });
    if (entity === 'profile' && parsed.rows.length !== 1) return fail('profile_single_row', 400, { rows: parsed.rows.length });

    const expected = parsed.header.length;
    const rows = parsed.rows.map(({ rowNo, cells }) => {
      const raw = Object.fromEntries(parsed.header.map((h, i) => [h, cells[i] ?? '']));
      const shape = cells.length !== expected ? [{ code: 'row_shape', field: null, severity: 'error', params: { found: cells.length, expected } }] : [];
      return { rowNo, raw, issues: shape };
    });
    const columns = suggestMapping(entity, parsed.header);
    const ready = autoReady(entity, columns);
    let results;
    let counts = null;
    if (ready) {
      results = checkRows(entity, columns, rows, await contextFor(entity, vendorId, costAllowed));
    } else {
      // Not checked until the columns are matched: rows wait with their shape problems only.
      results = rows.map(r => ({ ...r, normalized: {}, status: r.issues.length ? 'invalid' : 'needs_review' }));
      counts = { total: rows.length, valid: 0, needs_review: rows.length, invalid: 0, pending: rows.length, applied: 0, failed: 0, skipped: 0 };
      counts.needs_review = results.filter(r => r.status === 'needs_review').length;
      counts.invalid = results.filter(r => r.status === 'invalid').length;
    }
    const created = await store.createBatch({
      vendorId, createdBy: actorId, entity, filename: safeFilename(file.filename), sizeBytes: file.buffer.length,
      fileSha256: createHash('sha256').update(file.buffer).digest('hex'), templateVersion: templateVersionOf(entity, parsed.header),
      delimiter: parsed.delimiter, status: ready ? 'ready' : 'mapping_required',
      mapping: { columns, confirmedBy: null, confirmedAt: null }, rows: results, counts,
    });
    if (created.error === 'duplicate_file') {
      const { existing } = created;
      // `batchStatus` is the existing batch's status; the route answers it as `status` in the body (409 is the HTTP status).
      return fail('duplicate_file', 409, { batchId: existing.id, createdAt: existing.createdAt, batchStatus: existing.status });
    }
    if (created.error) return created;
    await audit(actorId, 'vendor_import_uploaded', created.batch, { counts: created.batch.counts, status: created.batch.status });
    return { batch: batchView(created.batch), status: 201 };
  }

  // ── reading ────────────────────────────────────────────────────────────────
  async function listBatches({ vendorId, query = {} }) {
    const status = query.status == null || query.status === '' ? null : String(query.status);
    if (status && !BATCH_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: BATCH_STATUSES });
    const limit = query.limit == null || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('invalid_limit', 400, { max: 100 });
    const out = await store.listBatches({ vendorId, status, limit, cursor: query.cursor || null });
    if (out.error) return out;
    return { batches: out.batches.map(batchView), nextCursor: out.nextCursor };
  }

  async function getBatch({ vendorId, id }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    const samples = await store.sampleRaw(vendorId, id, 3);
    const columns = columnsOf(batch).map(c => ({
      source: c.source, field: c.field, match: c.match, confirmed: c.confirmed,
      sample: samples.map(raw => (raw && hasOwn(raw, c.source) ? raw[c.source] : null)).filter(v => v !== null && v !== '').slice(0, 3),
    }));
    return { batch: batchView(batch), columns };
  }

  async function preview({ vendorId, id, query = {} }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    const status = query.status == null || query.status === '' ? null : String(query.status);
    if (status && !ROW_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: ROW_STATUSES });
    const limit = query.limit == null || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail('invalid_limit', 400, { max: 200 });
    const page = await store.rowsPage({ vendorId, id, status, limit, cursor: query.cursor || null });
    if (page.error) return page;
    return { batch: batchView(batch), counts: batch.counts, rows: page.rows.map(rowView), nextCursor: page.nextCursor };
  }

  // ── mapping ────────────────────────────────────────────────────────────────
  async function putMapping({ vendorId, actorId, id, body, costAllowed = false }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    if (!['mapping_required', 'ready'].includes(batch.status)) return fail('batch_not_editable', 409, { batchStatus: batch.status });
    const input = body?.mapping;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_mapping', 400);
    const entity = batch.entity;
    const allowed = new Set(fieldKeys(entity));
    const before = columnsOf(batch);
    const sources = new Set(before.map(c => c.source));
    for (const [source, field] of Object.entries(input)) {
      if (!sources.has(source)) return fail('invalid_mapping', 400, { source: source.slice(0, 80), reason: 'unknown_column' });
      if (field !== null && (typeof field !== 'string' || !allowed.has(field))) return fail('invalid_mapping', 400, { source: source.slice(0, 80), reason: 'unknown_field' });
    }
    const columns = before.map((c) => {
      if (!hasOwn(input, c.source)) return { ...c };
      const field = input[c.source];
      return { source: c.source, field, match: field === c.field ? c.match : 'none', confirmed: false };
    });
    const used = new Set();
    for (const c of columns) {
      if (!c.field || fieldDef(entity, c.field).multiple) continue;
      if (used.has(c.field)) return fail('duplicate_mapping', 400, { field: c.field });
      used.add(c.field);
    }
    const mappedAny = columns.some(c => c.field && !fieldDef(entity, c.field).ignored);
    const missing = missingRequired(entity, columns);
    if (missing.length || !mappedAny) return fail('critical_field_unmapped', 400, { fields: missing });
    // A critical field that is not an exact header match, or any fuzzy match, needs a person to say yes.
    const pending = columns.filter(c => c.field && ((CRITICAL_FIELDS[entity].includes(c.field) && c.match !== 'exact') || c.match === 'fuzzy') && !c.confirmed);
    if (pending.length && body.confirm !== true) {
      return fail('mapping_confirmation_required', 409, { columns: pending.map(c => ({ source: c.source, field: c.field, match: c.match })) });
    }
    const confirmedAt = body.confirm === true ? nowIso() : null;
    const confirmed = columns.map(c => ({ ...c, confirmed: c.field ? (c.match === 'exact' || body.confirm === true) : false }));

    const ctx = await contextFor(entity, vendorId, costAllowed);
    const results = [];
    await store.eachRow(vendorId, id, async (rows) => { results.push(...checkRows(entity, confirmed, rows, ctx)); });
    const saved = await store.saveMapping({
      vendorId, id, status: 'ready', templateVersion: batch.templateVersion ?? null,
      mapping: { columns: confirmed, confirmedBy: confirmedAt ? actorId : null, confirmedAt }, results,
    });
    if (!saved) return fail('batch_not_editable', 409);
    await audit(actorId, 'vendor_import_mapping_confirmed', saved, { counts: saved.counts, confirmed: body.confirm === true });
    return { batch: batchView(saved) };
  }

  // ── applying ───────────────────────────────────────────────────────────────
  /** One row → { applied, resultId } | { error }. Never throws for a row's own problem. */
  async function applyRow({ batch, row, actorId, costAllowed }) {
    const n = row.normalized || {};
    if (batch.entity === 'products') {
      const presetId = `prd_imp_${row.id}`;
      // A retry after a crash finds the product the first try made.
      const made = await store.productState(presetId, batch.vendorId);
      if (made === 'live') return { resultId: presetId };
      if (made === 'deleted') return { error: 'product_deleted' }; // made by an earlier try, then removed: never reported as imported
      if (n.sku && (await store.productsBySku(batch.vendorId, n.sku)).length) return { error: 'sku_exists' };
      const body = {
        name: n.name, priceTzs: n.priceTzs, stock: n.stock ?? 0,
        ...(n.category ? { category: n.category } : {}),
        ...(n.description ? { description: n.description } : {}),
        ...(n.brand ? { brand: n.brand } : {}),
        ...(n.sku ? { sku: n.sku } : {}),
        ...(n.discountPriceTzs != null ? { discountPriceTzs: n.discountPriceTzs } : {}),
        ...(costAllowed && n.costTzs != null ? { costTzs: n.costTzs } : {}),
        ...(n.reorderLevel != null ? { reorderLevel: n.reorderLevel } : {}),
      };
      const out = await shop.upsertProduct({
        vendorId: batch.vendorId, actorId, body, costAllowed,
        initialStatus: 'paused', presetId, stockNote: `import:${batch.id}`,
      });
      if (out.error) return { error: out.error };
      return { resultId: out.product.id };
    }
    if (batch.entity === 'inventory') {
      let expectedStock = n.expectedStock;
      if (row.lastError === 'stock_changed') {
        // An explicit retry is the person saying "count it again": take the stock as it is now.
        const current = await store.productRow(batch.vendorId, n.productId);
        if (!current) return { error: 'product_not_found' };
        const variant = n.variant ? (Array.isArray(current.variants) ? current.variants : []).find(v => v?.name === n.variant) : null;
        expectedStock = n.variant ? variant?.stock : Number(current.stock || 0);
        if (!Number.isInteger(expectedStock)) return { error: 'variant_not_found' };
      }
      const out = await shop.adjustStock({
        vendorId: batch.vendorId, actorId, productId: n.productId,
        body: { reason: 'count', quantity: n.quantity, expectedStock, ...(n.variant ? { variant: n.variant } : {}), clientRef: `imp:${row.id}`, note: `import:${batch.id}` },
      });
      if (out.error) return { error: out.error };
      return { resultId: out.movement.id };
    }
    // profile: fills only what is still empty; publish is never sent.
    const prior = (await shop.getVendorProfile(batch.vendorId)) || {};
    const patch = {};
    for (const [key, value] of Object.entries(n)) {
      if (prior[key] != null && String(prior[key]).trim() !== '') continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length) {
      const out = await shop.saveVendorProfile({ vendorId: batch.vendorId, body: patch });
      if (out.error) return { error: out.error };
    }
    return { resultId: batch.vendorId };
  }

  const holder = ctx => ({ vendorId: ctx.batch.vendorId, batchId: ctx.batch.id, token: ctx.batch.claimToken });

  async function runRow(ctx, row) {
    const { batch } = ctx;
    // Throws ClaimLostError (before anything is created) when another request has taken the batch over.
    await store.bumpAttempt({ ...holder(ctx), id: row.id });
    let out;
    try {
      out = await applyRow({ batch, row, actorId: ctx.actorId, costAllowed: ctx.costAllowed });
    } catch (error) {
      if (error instanceof ClaimLostError) throw error;
      // A unique-id clash means the earlier try already made it; anything else is logged without row data.
      if (error?.code === '23505' && batch.entity === 'products' && await store.productState(`prd_imp_${row.id}`, batch.vendorId) === 'live') out = { resultId: `prd_imp_${row.id}` };
      else {
        console.error('[vendor-import] row failed', { batchId: batch.id, rowNo: row.rowNo, error: error?.code || error?.message });
        out = { error: 'internal_error' };
      }
    }
    if (out.error) {
      await store.markRow({ ...holder(ctx), id: row.id, patch: { applyState: 'failed', lastError: String(out.error).slice(0, 80) } });
      return false;
    }
    // Applied rows keep their checked values and issues; the cells the vendor typed are dropped.
    await store.markRow({ ...holder(ctx), id: row.id, patch: { applyState: 'applied', resultId: out.resultId, appliedAt: now(), lastError: null, raw: '{}' } });
    return true;
  }

  /** Shared by apply and retry: claim, work up to 200 rows, then release (more to do) or finish. */
  async function drive({ vendorId, actorId, id, from, includeNeedsReview, costAllowed, action, beforeRun, signal }) {
    const first = await loadBatch(vendorId, id);
    if (!first) return notFound();
    // A batch silent in `applying` for minutes was left by a crashed request: claim() takes it over.
    const takeover = store.isStale(first);
    if (!from.includes(first.status) && !takeover) {
      return first.status === 'applying' ? fail('apply_in_progress', 409) : fail('not_ready', 409, { batchStatus: first.status });
    }
    // The first apply decides includeNeedsReview for the batch's whole life; later calls and retries use the stored value.
    const claimed = await store.claim({ vendorId, id, from, includeNeedsReview: includeNeedsReview === true });
    if (!claimed) return fail('apply_in_progress', 409);
    if (claimed.duplicate) return fail('duplicate_file', 409, { batchId: claimed.duplicate.id, createdAt: claimed.duplicate.createdAt, batchStatus: claimed.duplicate.status });
    const batch = claimed;
    const token = batch.claimToken;
    const include = batch.includeNeedsReview === true;
    const give = status => store.release({ vendorId, id, token, status, finished: false }).catch(() => {});
    let processed = 0;
    let applied = 0;
    let failed = 0;
    try {
      if (beforeRun) await beforeRun(batch);
      while (processed < PER_CALL) {
        const rows = await store.nextEligible({ vendorId, id, limit: Math.min(CHUNK, PER_CALL - processed), includeNeedsReview: include });
        if (!rows.length) break;
        const ctx = { batch, actorId, costAllowed };
        // Keep the claim fresh before waiting for a place or the vendor's lock (either may take a while).
        await store.touch(vendorId, id, token);
        const locked = await store.withVendorLock(vendorId, async () => {
          for (const row of rows) { if (await runRow(ctx, row)) applied += 1; else failed += 1; }
        }, { signal });
        if (locked.busy) { await give('ready'); return fail('apply_in_progress', 409); }
        processed += rows.length;
        await store.touch(vendorId, id, token);
      }
      const remaining = await store.countEligible({ vendorId, id, includeNeedsReview: include });
      await store.touch(vendorId, id, token); // still ours? (throws when the claim moved on)
      let released;
      if (remaining > 0) {
        released = await store.release({ vendorId, id, token, status: 'ready', finished: false });
      } else {
        await store.skipPending({ vendorId, id, token });
        const counts = await store.refreshCounts(vendorId, id);
        const status = counts.applied === counts.total ? 'applied' : 'partial';
        const mapped = columnsOf(batch).filter(c => c.field && !fieldDef(batch.entity, c.field)?.ignored).map(c => c.source);
        await store.dropUnmappedRaw({ vendorId, id, mappedSources: mapped });
        released = await store.release({ vendorId, id, token, status, finished: true });
      }
      // No release means the claim moved on while we worked: someone else owns the batch now.
      if (!released) return fail('apply_in_progress', 409);
      await audit(actorId, action, released, { counts: released.counts, processed, applied, failed, remaining, status: released.status });
      return { batch: batchView(released), processed, remaining };
    } catch (error) {
      // Lost claim: another request owns the batch and we must not touch its state. Anything else: give the claim back so the
      // vendor can continue at once instead of waiting for the takeover window.
      if (error instanceof ClaimLostError) return fail('apply_in_progress', 409);
      await give('ready');
      if (error instanceof SlotError) {
        return error.code === 'slot_timeout' ? fail('import_busy', 503, { retryAfterSeconds: 5 }) : fail('request_aborted', 499);
      }
      throw error;
    }
  }

  const apply = ({ vendorId, actorId, id, body = {}, costAllowed = false, signal }) => drive({
    vendorId, actorId, id, from: ['ready'], includeNeedsReview: body?.includeNeedsReview === true, costAllowed, action: 'vendor_import_applied', signal,
  });

  async function retry({ vendorId, actorId, id, costAllowed = false, signal }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    if (!['partial', 'ready'].includes(batch.status) && !store.isStale(batch)) return batch.status === 'applying' ? fail('apply_in_progress', 409) : fail('not_ready', 409, { batchStatus: batch.status });
    if (!(await store.countFailed(vendorId, id))) return fail('nothing_to_retry', 409);
    return drive({
      // includeNeedsReview is not passed: a retry uses the value the first apply stored.
      vendorId, actorId, id, from: ['partial', 'ready'], includeNeedsReview: false, costAllowed, action: 'vendor_import_retried', signal,
      // Failed rows go back to pending only after this request owns the batch.
      beforeRun: claimed => store.requeueFailed({ vendorId, id, token: claimed.claimToken }),
    });
  }

  async function discard({ vendorId, actorId, id }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    const out = await store.discard({ vendorId, id });
    if (out.error) return fail('not_discardable', 409, { batchStatus: batch.status });
    const mapped = columnsOf(out.batch).filter(c => c.field && !fieldDef(out.batch.entity, c.field)?.ignored).map(c => c.source);
    await store.dropUnmappedRaw({ vendorId, id, mappedSources: mapped });
    await audit(actorId, 'vendor_import_discarded', out.batch, { counts: out.batch.counts });
    return { batch: batchView(out.batch) };
  }

  // ── errors file ────────────────────────────────────────────────────────────
  async function errorsCsv({ vendorId, id }) {
    const batch = await loadBatch(vendorId, id);
    if (!batch) return notFound();
    const sourceOf = new Map(columnsOf(batch).filter(c => c.field).map(c => [c.field, c.source]));
    const lines = [];
    for (const row of await store.rowsWithIssues(vendorId, id)) {
      for (const i of row.issues) {
        const view = issueView(i);
        const source = i.field ? sourceOf.get(i.field) : null;
        const value = source && row.raw && hasOwn(row.raw, source) ? row.raw[source] : (i.field && row.normalized?.[i.field] != null ? row.normalized[i.field] : '');
        lines.push([row.rowNo, i.field || '', i.severity, i.code, view.message?.en || '', view.message?.sw || '', String(value ?? '').slice(0, 200)]);
      }
    }
    const csv = csvDocument(['row', 'field', 'severity', 'code', 'message_en', 'message_sw', 'value'], lines);
    return { csv, rowCount: lines.length, fileName: `import-${batch.id}-errors.csv` };
  }

  // ── template ───────────────────────────────────────────────────────────────
  function template({ entity, lang, example }) {
    if (!IMPORT_ENTITIES.includes(entity)) return fail('invalid_entity', 400, { allowed: IMPORT_ENTITIES });
    if (!['en', 'sw'].includes(lang)) return fail('invalid_lang', 400, { allowed: ['en', 'sw'] });
    return { csv: templateCsv(entity, lang, example), version: TEMPLATE_VERSION };
  }

  /** Retention: discard batches nobody finished (open and untouched for 30 days) and drop their cells. → how many. */
  const purgeAbandoned = (opts) => store.purgeAbandoned(opts);

  return { purgeAbandoned, upload, listBatches, getBatch, preview, putMapping, apply, retry, discard, errorsCsv, template };
}
