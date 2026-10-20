// Vendor business tools · S5 — documents (share links, public page, PDF) and VAT
// (plan docs/plans/vendor-business-tools-plan.md S5; design spec docs/design/vendor-documents-s5.md).
//
// - VendorDocumentLink: a share link to one vendor document. Only the SHA-256 of the 128-bit token
//   is stored (tokenHash, unique); the token itself is returned once and never kept (O-5). No expiry;
//   revokedAt turns it off for good. docType receipt | invoice | payment_receipt | statement |
//   order_invoice | credit_note (credit_note reserved for S7). lang en|sw = the page's default
//   language. lastOpenedAt: when the public page or PDF was last opened (no IP, no count: Q-14).
//   snapshot: the frozen statement (docType statement only, Q-9) — a statement link never shows
//   debt that arose after it was shared.
// - VendorTaxProfile: the vendor's VAT registration (O-12). The vendor submits TIN + VRN + the VAT
//   certificate (KYC document, requirement key vat_certificate); a KYC reviewer verifies or rejects.
//   submitted* = waiting for review; verified* = what is in force on documents and VAT. While a
//   change is pending the verified values stay in force (§6.2). pricesIncludeVat is locked true in
//   v1 (Q-11, CHECK). VAT applies to a sale only while vatRegistered AND verifiedAt is set, and only
//   to sales made at or after verifiedAt.
// - TaxCode + TaxRate: TRA-style codes (A standard, B special, C zero-rated, D special relief,
//   E exempt) and their dated rates. PRICING-ADJACENT CONSTANTS (CLAUDE.md rule 6): seeded A 18%,
//   C 0%, E exempt; B and D not in use until Tanzanian counsel confirms them (Q-12). New rates are
//   proposed by one admin and approved by ANOTHER (maker ≠ checker, also a CHECK here). A rate is in
//   force from its effectiveFrom (EAT day) until the next approved rate of the code.
// - ProductPrivate.vatCode: the product's VAT code (null = A). Private (never on Product, never on
//   /shop/*) and never re-queues product approval.
// - VendorSale: invoiceSeq/invoiceNumber (INV-000001, continuous per vendor, shared with order
//   invoices; credit sales only, Q-7; existing credit sales backfilled in createdAt order),
//   vatIncludedTzs (Σ line VAT contained in VAT-inclusive prices) and sellerSnapshot (seller details
//   at issue, Q-8).
//   THE S3 CHECK ISSUE (spec §3): vendorsale_total_adds_up is totalTzs = subtotal − line discounts −
//   discount + vatTzs, i.e. vatTzs is VAT ADDED on top. Prices include VAT (Q-11), so the VAT is
//   inside the total: it goes in vatIncludedTzs and vatTzs stays 0 (new CHECK vendorsale_vat_added_zero).
//   The S3 CHECK is untouched and keeps holding; nothing is counted twice.
// - VendorSaleLine: vatCode/vatRatePct/vatTzs (S3 columns) now get values; CHECKs keep them sane:
//   0 ≤ vatTzs ≤ the line's net (lineTotalTzs − saleDiscountShareTzs).
// - VendorCustomerPayment.sellerSnapshot: seller details at issue of the PMT receipt.
// - VendorOrderInvoice: one invoice per vendor per paid marketplace order (Q-15): INV number from the
//   vendor's series, the vendor's own lines with their VAT snapshot (code, rate, VAT) at payment
//   time, and the seller snapshot. A side table on purpose: ShopOrder.items (prices, commission,
//   payout — read by settlement) is never rewritten (O-10).
//
// Down: drops what this adds. INV numbers already given out are lost (count printed first).

const DOC_TYPES = ['receipt', 'invoice', 'payment_receipt', 'statement', 'order_invoice', 'credit_note'];
const CODES = ['A', 'B', 'C', 'D', 'E'];
const REJECT_REASONS = ['unreadable', 'number_mismatch', 'name_mismatch', 'not_vat_certificate', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');
const INVOICE_DOC_TYPE = 'invoice';
const invoiceNumber = seq => `INV-${String(seq).padStart(6, '0')}`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorDocumentLink', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('docType').notNullable();
    table.text('docId').notNullable();
    table.text('tokenHash').notNullable().unique();
    table.text('lang').notNullable().defaultTo('en');
    table.jsonb('snapshot');
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('lastOpenedAt', { precision: 3 });
    table.timestamp('revokedAt', { precision: 3 });
    table.text('revokedBy');
    table.index(['vendorId', 'docType', 'docId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "VendorDocumentLink"
    ADD CONSTRAINT vendordocumentlink_doc_type_check CHECK ("docType" IN (${list(DOC_TYPES)})),
    ADD CONSTRAINT vendordocumentlink_lang_check CHECK (lang IN ('en', 'sw')),
    ADD CONSTRAINT vendordocumentlink_token_hash_format CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT vendordocumentlink_snapshot_statement CHECK (("docType" = 'statement') = (snapshot IS NOT NULL)),
    ADD CONSTRAINT vendordocumentlink_revoked_complete CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL))`);

  await knex.schema.createTable('TaxCode', (table) => {
    table.text('code').primary();
    table.text('nameEn').notNullable();
    table.text('nameSw').notNullable();
    table.boolean('exempt').notNullable().defaultTo(false);
    table.boolean('inUse').notNullable().defaultTo(false);
    table.integer('sortOrder').notNullable().defaultTo(0);
  });
  await knex.raw(`ALTER TABLE "TaxCode" ADD CONSTRAINT taxcode_code_check CHECK (code IN (${list(CODES)}))`);
  // Q-12: A, C and E only until counsel confirms B and D. Names are drafts (Swahili for native review).
  await knex('TaxCode').insert([
    { code: 'A', nameEn: 'Standard', nameSw: 'Kiwango cha kawaida', exempt: false, inUse: true, sortOrder: 1 },
    { code: 'B', nameEn: 'Special rate', nameSw: 'Kiwango maalum', exempt: false, inUse: false, sortOrder: 2 },
    { code: 'C', nameEn: 'Zero-rated', nameSw: 'Kiwango sifuri', exempt: false, inUse: true, sortOrder: 3 },
    { code: 'D', nameEn: 'Special relief', nameSw: 'Nafuu maalum', exempt: false, inUse: false, sortOrder: 4 },
    { code: 'E', nameEn: 'Exempt', nameSw: 'Msamaha wa VAT', exempt: true, inUse: true, sortOrder: 5 },
  ]);

  await knex.schema.createTable('TaxRate', (table) => {
    table.text('id').primary();
    table.text('code').notNullable().references('code').inTable('TaxCode');
    table.decimal('ratePct', 5, 2); // null = exempt
    table.date('effectiveFrom').notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.text('reason').notNullable();
    table.text('proposedBy').notNullable();
    table.timestamp('proposedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.text('decidedBy');
    table.timestamp('decidedAt', { precision: 3 });
    table.text('decisionNote');
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.index(['code', 'status', 'effectiveFrom']);
  });
  await knex.raw(`ALTER TABLE "TaxRate"
    ADD CONSTRAINT taxrate_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    ADD CONSTRAINT taxrate_rate_range CHECK ("ratePct" IS NULL OR ("ratePct" >= 0 AND "ratePct" <= 100)),
    ADD CONSTRAINT taxrate_reason_length CHECK (char_length(reason) BETWEEN 3 AND 300),
    ADD CONSTRAINT taxrate_decided_complete CHECK ((status = 'pending') = ("decidedAt" IS NULL) AND ("decidedAt" IS NULL) = ("decidedBy" IS NULL)),
    ADD CONSTRAINT taxrate_maker_checker CHECK (status NOT IN ('approved', 'rejected') OR "decidedBy" <> "proposedBy")`);
  await knex.raw(`CREATE UNIQUE INDEX taxrate_approved_code_day_unique ON "TaxRate" (code, "effectiveFrom") WHERE status = 'approved'`);
  // Seed (PRICING CONSTANTS, call out in the PR): Tanzania mainland standard VAT 18%; zero-rated 0%; exempt.
  await knex('TaxRate').insert([
    { id: 'txr_seed_a', code: 'A', ratePct: 18, effectiveFrom: '2000-01-01', status: 'approved', reason: 'Initial standard rate (draft, counsel to confirm)' },
    { id: 'txr_seed_c', code: 'C', ratePct: 0, effectiveFrom: '2000-01-01', status: 'approved', reason: 'Initial zero rate (draft, counsel to confirm)' },
    { id: 'txr_seed_e', code: 'E', ratePct: null, effectiveFrom: '2000-01-01', status: 'approved', reason: 'Exempt supplies (draft, counsel to confirm)' },
  ].map(r => ({ ...r, proposedBy: 'system:seed', decidedBy: 'system:seed-approval', decidedAt: knex.fn.now() })));

  await knex.schema.createTable('VendorTaxProfile', (table) => {
    table.text('vendorId').primary();
    table.boolean('vatRegistered').notNullable().defaultTo(false);
    table.boolean('pricesIncludeVat').notNullable().defaultTo(true);
    table.text('status').notNullable().defaultTo('none');
    table.text('submittedTin');
    table.text('submittedVrn');
    table.text('submittedCertificateDocumentId');
    table.timestamp('submittedAt', { precision: 3 });
    table.text('submittedBy');
    table.text('verifiedTin');
    table.text('verifiedVrn');
    table.text('verifiedCertificateDocumentId');
    table.timestamp('verifiedAt', { precision: 3 });
    table.text('verifiedBy');
    table.text('rejectReason');
    table.text('rejectNote');
    table.timestamp('rejectedAt', { precision: 3 });
    table.text('rejectedBy');
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "VendorTaxProfile"
    ADD CONSTRAINT vendortaxprofile_prices_include_vat CHECK ("pricesIncludeVat" = true),
    ADD CONSTRAINT vendortaxprofile_status_check CHECK (status IN ('none', 'pending', 'verified', 'rejected')),
    ADD CONSTRAINT vendortaxprofile_pending_complete CHECK ((status = 'pending') = ("submittedAt" IS NOT NULL AND "rejectedAt" IS NULL)),
    ADD CONSTRAINT vendortaxprofile_submitted_complete CHECK ("submittedAt" IS NULL OR ("submittedVrn" IS NOT NULL AND "submittedTin" IS NOT NULL AND "submittedCertificateDocumentId" IS NOT NULL)),
    ADD CONSTRAINT vendortaxprofile_verified_complete CHECK ("verifiedAt" IS NULL OR ("verifiedVrn" IS NOT NULL AND "verifiedTin" IS NOT NULL AND "verifiedBy" IS NOT NULL)),
    ADD CONSTRAINT vendortaxprofile_verified_status CHECK (status <> 'verified' OR "verifiedAt" IS NOT NULL),
    ADD CONSTRAINT vendortaxprofile_reject_reason CHECK ("rejectReason" IS NULL OR "rejectReason" IN (${list(REJECT_REASONS)})),
    ADD CONSTRAINT vendortaxprofile_rejected_complete CHECK ((status = 'rejected') = ("rejectedAt" IS NOT NULL)),
    ADD CONSTRAINT vendortaxprofile_vrn_format CHECK (("submittedVrn" IS NULL OR "submittedVrn" ~ '^[A-Z0-9]{8,15}$') AND ("verifiedVrn" IS NULL OR "verifiedVrn" ~ '^[A-Z0-9]{8,15}$')),
    ADD CONSTRAINT vendortaxprofile_tin_format CHECK (("submittedTin" IS NULL OR "submittedTin" ~ '^[0-9]{9}$') AND ("verifiedTin" IS NULL OR "verifiedTin" ~ '^[0-9]{9}$'))`);

  await knex.schema.alterTable('ProductPrivate', (table) => { table.text('vatCode'); });
  await knex.raw(`ALTER TABLE "ProductPrivate" ADD CONSTRAINT productprivate_vat_code_check CHECK ("vatCode" IS NULL OR "vatCode" IN (${list(CODES)}))`);

  await knex.schema.alterTable('VendorSale', (table) => {
    table.integer('invoiceSeq');
    table.text('invoiceNumber');
    table.integer('vatIncludedTzs').notNullable().defaultTo(0);
    table.jsonb('sellerSnapshot');
  });
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD CONSTRAINT vendorsale_vat_included_range CHECK ("vatIncludedTzs" >= 0 AND "vatIncludedTzs" <= "totalTzs"),
    ADD CONSTRAINT vendorsale_vat_added_zero CHECK ("vatTzs" = 0) NOT VALID,
    ADD CONSTRAINT vendorsale_invoice_credit_only CHECK ("invoiceNumber" IS NULL OR kind = 'credit'),
    ADD CONSTRAINT vendorsale_invoice_complete CHECK (("invoiceNumber" IS NULL) = ("invoiceSeq" IS NULL))`);
  await knex.raw('ALTER TABLE "VendorSale" VALIDATE CONSTRAINT vendorsale_vat_added_zero');
  await knex.raw(`CREATE UNIQUE INDEX vendorsale_invoice_number_unique ON "VendorSale" ("vendorId", "invoiceNumber") WHERE "invoiceNumber" IS NOT NULL`);

  await knex.raw(`ALTER TABLE "VendorSaleLine"
    ADD CONSTRAINT vendorsaleline_vat_code_check CHECK ("vatCode" IS NULL OR "vatCode" IN (${list(CODES)})),
    ADD CONSTRAINT vendorsaleline_vat_rate_range CHECK ("vatRatePct" >= 0 AND "vatRatePct" <= 100),
    ADD CONSTRAINT vendorsaleline_vat_range CHECK ("vatTzs" >= 0 AND "vatTzs" <= "lineTotalTzs" - "saleDiscountShareTzs"),
    ADD CONSTRAINT vendorsaleline_vat_needs_code CHECK ("vatTzs" = 0 OR "vatCode" IS NOT NULL)`);

  await knex.schema.alterTable('VendorCustomerPayment', (table) => { table.jsonb('sellerSnapshot'); });

  await knex.schema.createTable('VendorOrderInvoice', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('orderId').notNullable();
    table.integer('seq').notNullable();
    table.text('number').notNullable();
    table.timestamp('issuedAt', { precision: 3 }).notNullable();
    table.boolean('vatApplied').notNullable().defaultTo(false);
    table.boolean('lateIssued').notNullable().defaultTo(false);
    table.integer('subtotalTzs').notNullable();
    table.integer('totalTzs').notNullable();
    table.integer('vatIncludedTzs').notNullable().defaultTo(0);
    table.jsonb('lines').notNullable();
    table.jsonb('sellerSnapshot').notNullable();
    table.text('paymentMethod');
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['orderId', 'vendorId']);
    table.unique(['vendorId', 'number']);
    table.unique(['vendorId', 'seq']);
  });
  await knex.raw(`ALTER TABLE "VendorOrderInvoice"
    ADD CONSTRAINT vendororderinvoice_money CHECK ("subtotalTzs" >= 0 AND "totalTzs" = "subtotalTzs" AND "vatIncludedTzs" >= 0 AND "vatIncludedTzs" <= "totalTzs"),
    ADD CONSTRAINT vendororderinvoice_vat_flag CHECK ("vatApplied" OR "vatIncludedTzs" = 0)`);

  await exports.backfillCreditInvoiceNumbers(knex);
};

/**
 * Q-7: every existing credit (pay-later) sale gets an INV number, per vendor in createdAt order, from
 * the vendor's `invoice` sequence (continuous with what comes after). Safe to repeat.
 * @param {import('knex').Knex} knex
 */
exports.backfillCreditInvoiceNumbers = async function backfillCreditInvoiceNumbers(knex) {
  const rows = await knex('VendorSale').where({ kind: 'credit' }).whereNull('invoiceNumber')
    .orderBy([{ column: 'vendorId' }, { column: 'createdAt' }, { column: 'id' }]).select('id', 'vendorId');
  const byVendor = new Map();
  for (const r of rows) byVendor.set(r.vendorId, [...(byVendor.get(r.vendorId) || []), r.id]);
  let numbered = 0;
  for (const [vendorId, ids] of byVendor) {
    await knex.transaction(async (trx) => {
      const { rows: issued } = await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt")
        VALUES (?, ?, ?, now())
        ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + ?, "updatedAt" = now()
        RETURNING "next" - ? AS first`, [vendorId, INVOICE_DOC_TYPE, ids.length + 1, ids.length, ids.length]);
      let seq = Number(issued[0].first);
      for (const id of ids) {
        await trx('VendorSale').where({ id, vendorId }).whereNull('invoiceNumber').update({ invoiceSeq: seq, invoiceNumber: invoiceNumber(seq) });
        seq += 1;
        numbered += 1;
      }
    });
  }
  console.log(`[migrate] vendor documents: ${numbered} pay-later sale(s) given an INV number across ${byVendor.size} vendor(s)`);
  return { numbered, vendors: byVendor.size };
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const numbered = (await knex.raw(`SELECT (SELECT count(*) FROM "VendorSale" WHERE "invoiceNumber" IS NOT NULL) + (SELECT count(*) FROM "VendorOrderInvoice") AS n`)).rows[0].n;
  if (Number(numbered)) console.warn(`[migrate] vendor documents down: ${numbered} INV number(s) will be dropped`);
  await knex.schema.dropTableIfExists('VendorOrderInvoice');
  await knex.schema.alterTable('VendorCustomerPayment', (table) => { table.dropColumn('sellerSnapshot'); });
  await knex.raw(`ALTER TABLE "VendorSaleLine"
    DROP CONSTRAINT IF EXISTS vendorsaleline_vat_needs_code,
    DROP CONSTRAINT IF EXISTS vendorsaleline_vat_range,
    DROP CONSTRAINT IF EXISTS vendorsaleline_vat_rate_range,
    DROP CONSTRAINT IF EXISTS vendorsaleline_vat_code_check`);
  // Lines keep their columns (S3); their VAT values are cleared with the profile that justified them.
  await knex('VendorSaleLine').update({ vatCode: null, vatRatePct: 0, vatTzs: 0 });
  await knex.raw('DROP INDEX IF EXISTS vendorsale_invoice_number_unique');
  await knex.raw(`ALTER TABLE "VendorSale"
    DROP CONSTRAINT IF EXISTS vendorsale_invoice_complete,
    DROP CONSTRAINT IF EXISTS vendorsale_invoice_credit_only,
    DROP CONSTRAINT IF EXISTS vendorsale_vat_added_zero,
    DROP CONSTRAINT IF EXISTS vendorsale_vat_included_range`);
  await knex.schema.alterTable('VendorSale', (table) => {
    table.dropColumn('sellerSnapshot');
    table.dropColumn('vatIncludedTzs');
    table.dropColumn('invoiceNumber');
    table.dropColumn('invoiceSeq');
  });
  await knex.raw('ALTER TABLE "ProductPrivate" DROP CONSTRAINT IF EXISTS productprivate_vat_code_check');
  await knex.schema.alterTable('ProductPrivate', (table) => { table.dropColumn('vatCode'); });
  await knex.schema.dropTableIfExists('VendorTaxProfile');
  await knex.schema.dropTableIfExists('TaxRate');
  await knex.schema.dropTableIfExists('TaxCode');
  await knex.schema.dropTableIfExists('VendorDocumentLink');
  await knex.raw(`DELETE FROM "VendorDocumentSequence" WHERE "docType" = ?`, [INVOICE_DOC_TYPE]);
};
