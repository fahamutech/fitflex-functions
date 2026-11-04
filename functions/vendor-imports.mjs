// Vendor Smart Import V1 — CSV import of products, stock counts and the business profile.
// Dormant: VENDOR_TOOLS + VENDOR_IMPORT (off → 404 feature_disabled). Permission `import` for vendor_staff.
// Design: docs/design/vendor-import-v1.md. Create-only; imported products land paused + pending (the vendor's own
// restore action publishes them); no new ledger; the file's bytes are never stored (sha256 only).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorImportService, users } from '../src/bootstrap/services.mjs';
import { vendorImportOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { IMPORT_LIMITS } from '../src/shared/vendor-import-rules.mjs';
import { errorMessage, reasonMessage } from '../src/shared/vendor-import-messages.mjs';

const created = new Date().toISOString();

/**
 * vendor_staff need `import`, read from their stored staff record (active, of the vendor in their token), and their
 * vendor account must not be suspended (fail closed → 403 vendor_suspended). The vendor account itself is already
 * refused while suspended (requireAuth → 403 account_suspended). FitFlex admins are not allowed in V1 (requireAuth).
 */
export async function requireImportPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  let ok;
  let vendor;
  try {
    ok = await shopService.authorizeStaff(req.user, 'import');
    vendor = ok ? await users.findByIdAsync(req.user.vendorId) : null;
  } catch (error) {
    console.error('[vendor-imports] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable', message: errorMessage('authorization_unavailable') });
  }
  if (!ok) return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'import', message: errorMessage('vendor_permission_forbidden') });
  if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended', message: errorMessage('vendor_suspended') });
  return next();
}

// Per vendor per minute, in memory per server (the pattern of vendor sales): with several servers the real allowance is
// servers × this; the database quota (20 batches a day, 3 open) is the real bound.
export const VENDOR_IMPORT_RATE = Object.freeze({ uploadsPerMinute: 10, appliesPerMinute: 30, readsPerMinute: 120 });
const uploadLimiter = createVendorLimiter({ perMinute: VENDOR_IMPORT_RATE.uploadsPerMinute });
const applyLimiter = createVendorLimiter({ perMinute: VENDOR_IMPORT_RATE.appliesPerMinute });
const readLimiter = createVendorLimiter({ perMinute: VENDOR_IMPORT_RATE.readsPerMinute });
export const resetVendorImportLimits = () => { uploadLimiter.reset(); applyLimiter.reset(); readLimiter.reset(); };

const guards = method => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireImportPermission]);
/** The business profile is written only by the account holder (PUT /vendor/profile refuses vendor_staff, even admins). */
const isOwner = user => user.userType === 'vendor';
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const disabled = res => res.status(404).json({ error: 'feature_disabled', message: errorMessage('feature_disabled') });
const setHeader = (res, key, value) => (typeof res.setHeader === 'function' ? res.setHeader(key, value) : res.set?.(key, value));

/** { error, status, ...extra } → the JSON error body, with English and Swahili text. duplicate_file answers the existing batch's status as `status`. */
function send(res, result) {
  const { error, status, batchStatus, ...extra } = result;
  const body = { error, ...extra, ...(error === 'duplicate_file' ? { status: batchStatus } : batchStatus ? { batchStatus } : {}) };
  const message = errorMessage(error, extra);
  if (message) body.message = message;
  const why = reasonMessage(extra.reason ?? extra.hint, extra);
  if (why) body.reasonMessage = why;
  if (['rate_limited', 'import_busy'].includes(error) && extra.retryAfterSeconds) setHeader(res, 'Retry-After', String(extra.retryAfterSeconds));
  return res.status(status).json(body);
}
/** 429 rate_limited with English and Swahili text. */
function limited(limiter, vendorId, res) {
  const allowed = limiter.allow(vendorId);
  if (allowed.ok) return false;
  send(res, { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds });
  return true;
}
/** Aborts when the client goes away before the answer is sent, so a queued apply leaves the queue. */
function abortOnClose(res) {
  const controller = new AbortController();
  res.on?.('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}
const sendFile = (res, body, type, fileName, extraHeaders = {}) => {
  setHeader(res, 'Content-Type', type);
  setHeader(res, 'Content-Disposition', `attachment; filename="${String(fileName).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  setHeader(res, 'Access-Control-Expose-Headers', ['Content-Disposition', ...Object.keys(extraHeaders)].join(', '));
  setHeader(res, 'Cache-Control', 'no-store, private');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(extraHeaders)) setHeader(res, key, value);
  res.status(200);
  const buffer = Buffer.from(body, 'utf8');
  setHeader(res, 'Content-Length', String(buffer.length));
  return typeof res.end === 'function' ? res.end(buffer) : res.send(buffer);
};

const BATCH = '{ id, entity: products|inventory|profile, status: mapping_required|ready|applying|applied|partial|discarded, filename, sizeBytes, templateVersion: "v1"|null, delimiter, counts { total, valid, needs_review, invalid, pending, applied, failed, skipped }, createdBy, needsConfirmation (a critical column is a synonym/fuzzy match, or any is fuzzy: confirm before rows are checked), missingRequired:[field], createdAt, updatedAt, applyStartedAt|null, finishedAt|null }';
const ISSUE = '{ code, field|null, severity: error|warning|info, params, message { en, sw } } (Swahili is a draft for native review)';
const COMMON = 'Vendor / staff with `import` (VENDOR_TOOLS + VENDOR_IMPORT; off → 404 feature_disabled; a FitFlex admin → 403). Another vendor\'s batch or an unknown id → 404 import_not_found. Staff of a suspended vendor → 403 vendor_suspended. The `profile` entity is for the account holder only (like PUT /vendor/profile): vendor_staff, even with `import`, get 403 profile_import_owner_only on upload, mapping, apply and retry of a profile import (the template still downloads). 429 rate_limited { retryAfterSeconds } (+ Retry-After). Errors: { error, message { en, sw }, ...extra }.';

export const vendorImportDownloadTemplate = {
  created, method: 'get', path: '/vendor/imports/template',
  description: `${COMMON} Query: entity (products|inventory|profile; else 400 invalid_entity), lang (en|sw, default en; else 400 invalid_lang), example (0|1, default 0: with 1 two example rows follow the header). → text/csv; charset=utf-8 attachment, UTF-8 with BOM, CRLF, header row in the chosen language, header X-Template-Version: v1. products: name, price_tzs, stock, category, description, brand, sku, discount_price_tzs, cost_tzs, reorder_level (Swahili: jina, bei_tzs, idadi, aina, maelezo, chapa, sku, bei_punguzo_tzs, gharama_tzs, kiwango_cha_kuagiza); inventory: sku, quantity, variant (sku, idadi, aina_ndogo); profile: businessName, description, businessCategory, contactNumber, email, address, businessHours (jina_la_biashara, maelezo, aina_ya_biashara, namba_ya_mawasiliano, barua_pepe, anwani, saa_za_kazi).`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    if (limited(readLimiter, vendorOf(req.user), res)) return undefined;
    const query = req.query || {};
    const out = vendorImportService.template({ entity: String(query.entity ?? ''), lang: String(query.lang ?? 'en'), example: query.example === '1' || query.example === 'true' });
    if (out.error) return send(res, out);
    return sendFile(res, out.csv, 'text/csv; charset=utf-8', `fitflex-import-${query.entity}-${query.lang || 'en'}.csv`, { 'X-Template-Version': out.version });
  },
};

export const vendorImportUpload = {
  created, method: 'post', path: '/vendor/imports',
  description: `${COMMON} Upload a CSV: multipart/form-data with fields entity (products|inventory|profile) and file (one file, .csv, UTF-8; max ${IMPORT_LIMITS.maxBytes} bytes and ${IMPORT_LIMITS.maxRows} data rows, ${IMPORT_LIMITS.maxColumns} columns, ${IMPORT_LIMITS.maxCellChars} characters a cell). The file is parsed, its columns matched to fields (exact, synonym in English or Swahili, fuzzy) and, when every critical column is an exact header match (products: name, price_tzs, stock; inventory: sku, quantity) and none is fuzzy, every row is checked at once → status ready; otherwise status mapping_required (rows are checked after PUT /vendor/imports/:id/mapping). Nothing is created yet. The file's bytes are not stored (only a sha256). → 201 { batch } ${BATCH}. Errors: 400 invalid_entity | no_file_provided | invalid_multipart | invalid_csv { reason } | empty_file | header_invalid { reason: empty_name|duplicate_name } | too_many_columns { maxColumns } | cell_too_long { maxCellChars } | invalid_encoding (not UTF-8) | profile_single_row (profile files have exactly one data row); 413 file_too_large { maxBytes } | too_many_rows { maxRows }; 415 unsupported_file_type { hint: xlsx_not_supported_yet|binary_or_utf16 }; 409 duplicate_file { batchId, createdAt, status } (the same bytes are in a batch that is still open: mapping_required, ready or applying; after it is applied, partial or discarded the file may be uploaded again); 429 import_quota { reason: daily|open, max } (20 batches per vendor per EAT day, 3 not finished). 429 rate_limited (10 uploads a minute). A file that cannot be read creates no batch.`,
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(uploadLimiter, vendorId, res)) return undefined;
    let parsed;
    try {
      parsed = await parseMultipartRequest(req, { fileSize: IMPORT_LIMITS.maxBytes, files: 1, fields: 4, parts: 6, fieldSize: 256 });
    } catch {
      return send(res, { error: 'invalid_multipart', status: 400 });
    }
    const entity = parsed.fields.find(f => f.name === 'entity')?.value;
    const file = parsed.files.find(f => f.fieldname === 'file') || parsed.files[0];
    const result = await vendorImportService.upload({ vendorId, actorId: req.user.sub, entity, file, costAllowed: await shopService.canSeeCost(req.user), owner: isOwner(req.user) });
    if (result.error) return send(res, result);
    return res.status(201).json({ batch: result.batch });
  },
};

export const vendorImportList = {
  created, method: 'get', path: '/vendor/imports',
  description: `${COMMON} My imports, newest first. Query: status (optional), limit (1–100, default 50), cursor (the previous nextCursor). → { batches: [${BATCH}], nextCursor|null }. 400 invalid_status | invalid_limit | invalid_cursor.`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(readLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.listBatches({ vendorId, query: req.query || {} });
    if (result.error) return send(res, result);
    return res.json(result);
  },
};

export const vendorImportGet = {
  created, method: 'get', path: '/vendor/imports/:id',
  description: `${COMMON} One import and how its columns were matched → { batch ${BATCH}, columns: [{ source (the file's header), field|null, match: exact|synonym|fuzzy|none, confirmed, sample: up to 3 values }] }.`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    // Route order is the module's export order: if this route is mounted first, the template path must still work.
    if (req.params.id === 'template') return vendorImportDownloadTemplate.onRequest(req, res);
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(readLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.getBatch({ vendorId, id: req.params.id });
    if (result.error) return send(res, result);
    return res.json(result);
  },
};

export const vendorImportMapping = {
  created, method: 'put', path: '/vendor/imports/:id/mapping',
  description: `${COMMON} Choose which file column feeds which field, then every row is checked again. Body { mapping: { "<source header>": "<field>"|null, … } (columns left out keep their match), confirm: true }. Only while status is mapping_required or ready AND no row was applied or failed yet (else 409 batch_not_editable). A critical column (products: name, price_tzs, stock; inventory: sku, quantity) that is not an exact header match, and any fuzzy match, needs confirm:true → else 409 mapping_confirmation_required { columns }. Required before rows can be checked: products name + price_tzs, inventory sku + quantity, profile at least one field → else 400 critical_field_unmapped { fields }. Never importable: payout account, logo, banner, commission, areas (profile). 400 invalid_mapping { source, reason: unknown_column|unknown_field } | duplicate_mapping { field }. → { batch ${BATCH} } with status ready.`,
  requestSample: { mapping: { Bidhaa: 'name', 'Bei ya kuuza': 'price_tzs', Idadi: 'stock', Notes: null }, confirm: true },
  onGuard: guards('put'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(applyLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.putMapping({ vendorId, actorId: req.user.sub, id: req.params.id, body: req.body || {}, costAllowed: await shopService.canSeeCost(req.user), owner: isOwner(req.user) });
    if (result.error) return send(res, result);
    return res.json({ batch: result.batch });
  },
};

export const vendorImportPreview = {
  created, method: 'get', path: '/vendor/imports/:id/preview',
  description: `${COMMON} Read-only preview of the checked rows, problem rows first (invalid, then needs_review, then valid; then row number). Query: status (valid|needs_review|invalid; optional), limit (1–200, default 50), cursor. → { batch ${BATCH}, counts, rows: [{ id, rowNo (2 = the first data row; the header is row 1), status: valid|needs_review|invalid, applyState: pending|applied|failed|skipped, issues: [${ISSUE}], values (the checked values), resultId|null, lastError|null, attempts }], nextCursor|null }. Issue codes — invalid: name_missing, name_too_long, price_invalid, price_not_whole_tzs, discount_not_below_price, stock_invalid, sku_exists, sku_duplicate_in_file, product_not_found, row_shape, sku_missing, sku_ambiguous, variant_required, variant_not_found, field_too_long, email_invalid; needs_review: price_unusually_high, stock_missing, category_unknown (params.suggestion), name_exists, formula_like_text, cost_not_allowed; info: image_not_supported, already_set. 400 invalid_status | invalid_limit | invalid_cursor.`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(readLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.preview({ vendorId, id: req.params.id, query: req.query || {} });
    if (result.error) return send(res, result);
    return res.json(result);
  },
};

export const vendorImportApply = {
  created, method: 'post', path: '/vendor/imports/:id/apply',
  description: `${COMMON} Create the products / apply the counts / fill the profile. Body { includeNeedsReview: false }; the FIRST apply decides it for the batch's whole life (later calls and retries use the stored batch.includeNeedsReview, whatever they send). Only status ready (else 409 not_ready { batchStatus }); one request at a time per batch (409 apply_in_progress, also when another import of the vendor holds the vendor lock; 503 import_busy { retryAfterSeconds } when no place frees up within 15 seconds; a request whose client went away leaves the queue). Each call works up to 200 rows (50 at a time, each through the normal service call) and answers { batch ${BATCH}, processed, remaining }; the client repeats the call while remaining > 0 until batch.status is applied or partial (partial = some rows failed or were not applied). Only valid rows are applied; with includeNeedsReview also needs_review rows (an unknown category is left empty); invalid rows never. products: created PAUSED with approvalStatus pending (FitFlex review rules stay in force; the vendor restores the product to publish it); stock becomes a \`count\` stock-history row noted import:<batchId> (when the stock ledger is on); cost price only for callers who may see cost; no variants, no images; an applied row is never created twice (a retry finds it). inventory: each row sets the stock of the product with that SKU as a \`count\` adjustment (expected stock = the stock when the file was checked; changed since → that row fails stock_changed and can be retried). profile: fills only empty fields; never publishes; never touches payout account, logo, banner, commission or areas.`,
  requestSample: { includeNeedsReview: false },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(applyLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.apply({ vendorId, actorId: req.user.sub, id: req.params.id, body: req.body || {}, costAllowed: await shopService.canSeeCost(req.user), signal: abortOnClose(res), owner: isOwner(req.user) });
    if (result.error) return send(res, result);
    return res.json({ batch: result.batch, processed: result.processed, remaining: result.remaining });
  },
};

export const vendorImportRetry = {
  created, method: 'post', path: '/vendor/imports/:id/retry',
  description: `${COMMON} Put the failed rows back in the queue and apply them (same answer as apply). Only status partial or ready with failed rows → else 409 not_ready | nothing_to_retry; 409 apply_in_progress; 409 batch_expired (the batch ended more than 30 days ago and its cells were cleared). A row whose imported product the vendor deleted fails product_deleted and the next retry creates it again. A stock_changed inventory row is counted again against the stock as it is now.`,
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(applyLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.retry({ vendorId, actorId: req.user.sub, id: req.params.id, costAllowed: await shopService.canSeeCost(req.user), signal: abortOnClose(res), owner: isOwner(req.user) });
    if (result.error) return send(res, result);
    return res.json({ batch: result.batch, processed: result.processed, remaining: result.remaining });
  },
};

export const vendorImportDiscard = {
  created, method: 'post', path: '/vendor/imports/:id/discard',
  description: `${COMMON} Throw the import away (the same file may be uploaded again). Only before any row was tried (no row applied, failed or attempted) and not while applying → else 409 not_discardable { batchStatus }. Discarding drops every typed cell. → { batch ${BATCH} } (status discarded).`,
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(applyLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.discard({ vendorId, actorId: req.user.sub, id: req.params.id });
    if (result.error) return send(res, result);
    return res.json({ batch: result.batch });
  },
};

export const vendorImportErrorsCsv = {
  created, method: 'get', path: '/vendor/imports/:id/errors.csv',
  description: `${COMMON} Every issue of the import as a CSV: text/csv; charset=utf-8 attachment, UTF-8 with BOM, CRLF, columns row, field, severity, code, message_en, message_sw, value; formula-injection safe. Cells are kept only for rows not applied, until the batch is discarded or 30 days after it ended; after that the rows still list their codes and messages but value is empty. Fetch it with the sign-in header and save the blob (a plain link carries no token).`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorImportOn()) return disabled(res);
    const vendorId = vendorOf(req.user);
    if (limited(readLimiter, vendorId, res)) return undefined;
    const result = await vendorImportService.errorsCsv({ vendorId, id: req.params.id });
    if (result.error) return send(res, result);
    return sendFile(res, result.csv, 'text/csv; charset=utf-8', result.fileName);
  },
};
