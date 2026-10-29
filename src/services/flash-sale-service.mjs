// Shop flash sales (Phase 2 · slice 4). Contract: docs/shop-flash-sales-api.md. Dormant behind
// SHOP_FLASH_SALES (the routes, the job and the pricing paths check the flag; this service does not).
// PRICING PATH (CONTRIBUTING rule 6): an approved sale changes what buyers pay inside its window.
//
// - Vendors (the vendor account, or vendor staff with `products`) propose sales on their own
//   products. FitFlex staff (scope `promotions`) create sales on any vendor's product, without the
//   vendor's consent (owner 2026-10-20).
// - Every sale is approved by someone with `promotions_approve` who neither created, edited nor sent
//   it (403 cannot_approve_own_submission), naming the revision reviewed (409 sale_changed).
// - Rules (flash-sale-rules.mjs): ≥ 5 % off the regular price, no maximum; below the current
//   effective price; 1 hour to 7 days; no priceTzs raise in the 14 days before the start; one
//   approved sale per product at a time (also a database constraint).
// - Every change of state runs alone under the product's lock (store.transaction) and adds an
//   AuditLog row (`flash_sale.<action>`). The vendor is told on approve, reject, expiry and when
//   FitFlex ends a sale (notifyVendor: inbox + push, English and Swahili).
// - "live" is never stored: an approved sale is live while now is inside [startsAt, endsAt).
// - The vendor bears the discount: nothing here touches commission, payouts or settlement.
import { randomUUID } from 'node:crypto';
import {
  SALE_EFFECTIVE_STATUSES, SALE_REJECT_CODES, REASON_MAX, SALE_RULES, DAY_MS,
  effectiveStatus, proposalExpiry, flashSaleConfigFromEnv, parseSaleInput, windowError, discountError,
  priceRaiseError, priceHistoryError, latestRaise, isRaise, eatDate, overlaps, maxSalePrice,
} from '../shared/flash-sale-rules.mjs';
import { standingPrice, validDiscount, discountPct } from '../shared/shop-pricing.mjs';
import { storeNameOf } from '../shared/vendor-name.mjs';
import { EXCLUSION_VIOLATION } from '../infra/flash-sale-store-pg.mjs';

const SYSTEM_ACTOR = 'system';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const ms = v => new Date(v).getTime();
const newSaleId = () => `fls_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const withEditor = (s, actorId) => [...new Set([...(s?.editors || []), actorId].filter(Boolean))];
/** Two-person rule: anyone who created, edited or sent a sale may not approve or reject it. */
const isContributor = (s, actorId) => Boolean(actorId) && (actorId === s.createdBy || actorId === s.submittedBy || (s.editors || []).includes(actorId));
/** A product a buyer can find (the shop's listing rules; stock is not checked: out of stock is allowed). */
const productListed = p => Boolean(p) && !p.deletedAt && p.status === 'active' && !['pending', 'rejected'].includes(p.approvalStatus)
  && p.visibility !== 'hidden' && p.homepageVisible !== false;
const whyNotListed = (p) => {
  if (!p || p.deletedAt) return 'product_deleted';
  if (p.status !== 'active') return 'product_inactive';
  if (['pending', 'rejected'].includes(p.approvalStatus)) return 'product_not_approved';
  return 'product_hidden';
};

function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? offset + limit : null };
}

const ADMIN_TABS = Object.freeze({
  requests: ['pending_approval'],
  scheduled: ['approved'],
  live: ['live'],
  closed: ['ended', 'rejected', 'expired', 'withdrawn'],
  drafts: ['draft'],
});

export function createFlashSaleService({
  store,                  // createPgFlashSaleStore
  partnerGate = null,     // operationalUserIds(ids) → Set (KYC gate)
  moderationGate = null,  // blocked('vendor') → Set
  notifyVendor = async () => {},
  config = () => flashSaleConfigFromEnv(),
  now = () => new Date(),
  logger = console,
}) {
  const stamp = () => now().toISOString();
  let lastAuditMs = 0;
  const auditAt = () => {
    lastAuditMs = Math.max(now().getTime(), lastAuditMs + 1);
    return new Date(lastAuditMs).toISOString();
  };
  const audit = (q, action, actor, sale, before, after) => q.audit({
    id: randomUUID(), at: auditAt(), actor, action: `flash_sale.${action}`, target: sale.id, before, after,
  });
  const snapshot = s => (s ? {
    status: s.status, revision: s.revision, productId: s.productId, salePriceTzs: s.salePriceTzs, startsAt: s.startsAt, endsAt: s.endsAt,
    wasPriceTzs: s.wasPriceTzs, regularPriceTzsAtSubmit: s.regularPriceTzsAtSubmit, discountPriceTzsAtSubmit: s.discountPriceTzsAtSubmit,
    expiresAt: s.expiresAt, statusReason: s.statusReason, statusReasonNote: s.statusReasonNote,
  } : null);

  // ── Who may do what ─────────────────────────────────────────────────────────

  /** → Map(vendorId → { ok, reason: null | vendor_suspended | vendor_not_approved | vendor_not_found, row }). */
  async function vendorStates(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    if (!wanted.length) return out;
    const [rows, operational, blocked] = await Promise.all([
      q.vendors(wanted),
      partnerGate ? partnerGate.operationalUserIds(wanted) : new Set(wanted),
      moderationGate ? moderationGate.blocked('vendor') : new Set(),
    ]);
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const id of wanted) {
      const row = byId.get(id);
      let reason = null;
      if (!row) reason = 'vendor_not_found';
      else if (row.accountStatus === 'suspended' || blocked.has(id)) reason = 'vendor_suspended';
      // Fail closed: only an explicitly approved, operational vendor may run a sale.
      else if (row.approvalStatus !== 'approved' || !operational.has(id)) reason = 'vendor_not_approved';
      out.set(id, { ok: !reason, reason, row: row || null });
    }
    return out;
  }
  async function vendorBlocked(q, vendorId, status = 403) {
    const s = (await vendorStates(q, [vendorId])).get(vendorId);
    return s.ok ? null : fail(s.reason, s.reason === 'vendor_not_found' ? 404 : status);
  }

  /** The product as it is now, owned by the sale's vendor and on sale to buyers. */
  async function productFor(q, productId, vendorId) {
    const p = await q.product(productId);
    if (!p || p.deletedAt) return { error: fail('product_not_found', 404, { productId }) };
    if (vendorId && p.vendorId !== vendorId) return { error: fail('not_your_product', 403, { productId }) };
    if (!productListed(p)) return { error: fail('product_not_eligible', 422, { productId, reason: whyNotListed(p) }) };
    return { product: p };
  }

  /** Another approved (not ended) or pending (not expired) sale of the product whose window overlaps. */
  /** `withPending` false on approval: only other approved sales count (the database rule). */
  async function overlapError(q, sale, at = now(), { withPending = true } = {}) {
    const others = (await q.salesOfProduct(sale.productId)).filter(o => o.id !== sale.id);
    const blocking = withPending ? ['approved', 'live', 'pending_approval'] : ['approved', 'live'];
    const clash = others.find(o => blocking.includes(effectiveStatus(o, at)) && overlaps(o, sale));
    return clash ? fail('sale_overlap', 409, { saleId: clash.id, startsAt: clash.startsAt, endsAt: clash.endsAt, effectiveStatus: effectiveStatus(clash, at) }) : null;
  }

  /** Every rule that depends on the product and time. `checkLead`: start ≥ 1 h ahead (not on approve). */
  async function rulesError(q, sale, product, { checkLead = true, withPending = true } = {}) {
    const at = now();
    const shape = windowError(sale, { now: at, checkLead }) || discountError(sale.salePriceTzs, product);
    if (shape) return shape;
    // New or copied products (owner ruling (b)): 14 days of price history before any sale starts.
    const young = priceHistoryError(await q.firstPriceAt(sale.productId), sale.startsAt, at);
    if (young) return young;
    const since = new Date(ms(sale.startsAt) - SALE_RULES.priceRaiseLookbackDays * DAY_MS).toISOString();
    const raised = priceRaiseError(await q.priceChanges(sale.productId, since), sale.startsAt);
    if (raised) return raised;
    return overlapError(q, sale, at, { withPending });
  }

  async function openProposalsFull(q, vendorId) {
    const { maxOpenProposals: max } = config();
    const open = await q.openProposals(vendorId, stamp());
    return open >= max ? fail('too_many_open_proposals', 409, { max, open }) : null;
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  function actionsFor(s, { side, canManage = false, canApprove = false, actorId = null }) {
    const eff = effectiveStatus(s, now());
    const out = [];
    const owns = (side === 'vendor' && s.origin === 'vendor') || (side === 'admin' && s.origin === 'staff' && canManage);
    if (owns) {
      if (['draft', 'pending_approval', 'rejected', 'approved'].includes(eff)) out.push('edit');
      if (eff === 'draft') out.push('submit');
      if (['draft', 'pending_approval', 'approved'].includes(eff)) out.push('withdraw');
    }
    // Owner ruling (d): the vendor pays the discount, so it may end ANY scheduled or live sale on its
    // own products, FitFlex-made ones included.
    if (side === 'vendor' && ['approved', 'live'].includes(eff)) out.push('end');
    if (side === 'admin' && canApprove) {
      if (eff === 'pending_approval' && !isContributor(s, actorId)) out.push('approve', 'reject');
      if (['approved', 'live'].includes(eff)) out.push('end');
    }
    return [...new Set(out)];
  }

  function commonView(s, product) {
    const regular = s.status === 'approved' || s.wasPriceTzs != null ? (s.wasPriceTzs ?? product?.priceTzs ?? null) : (product?.priceTzs ?? null);
    return {
      id: s.id, origin: s.origin, vendorId: s.vendorId, productId: s.productId,
      productName: product?.name ?? null, productImage: product?.images?.[0] ?? null,
      salePriceTzs: s.salePriceTzs,
      regularPriceTzs: product?.priceTzs ?? null,
      discountPriceTzs: product ? validDiscount(product) : null,
      wasPriceTzs: s.wasPriceTzs ?? null,
      discountPct: regular ? discountPct(regular, s.salePriceTzs) : 0,
      savingTzs: regular ? Math.max(0, regular - s.salePriceTzs) : 0,
      startsAt: s.startsAt, endsAt: s.endsAt,
      status: s.status, effectiveStatus: effectiveStatus(s, now()),
      statusReason: s.statusReason ?? null, statusReasonNote: s.statusReasonNote ?? null,
      expiresAt: s.status === 'pending_approval' ? s.expiresAt : null,
      revision: s.revision,
      submittedAt: s.submittedAt ?? null, approvedAt: s.approvedAt ?? null, decidedAt: s.decidedAt ?? null, endedAt: s.endedAt ?? null,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    };
  }

  const priceMoved = (s, product) => s.status === 'pending_approval' && product
    && (Number(product.priceTzs) !== Number(s.regularPriceTzsAtSubmit) || Number(validDiscount(product) ?? 0) !== Number(s.discountPriceTzsAtSubmit ?? 0));

  async function decorate(q, rows, side, viewer = null) {
    const products = new Map((await q.products(rows.map(r => r.productId))).map(p => [p.id, p]));
    if (side === 'vendor') {
      return rows.map(s => ({
        ...commonView(s, products.get(s.productId)),
        endedByFitflex: s.status === 'ended' && ['ended_by_fitflex', 'vendor_suspended'].includes(s.statusReason),
        allowedActions: actionsFor(s, { side: 'vendor' }),
      }));
    }
    const vendors = new Map((await q.vendors(rows.map(r => r.vendorId))).map(v => [v.id, v]));
    const names = await q.displayNames(rows.flatMap(r => [r.createdBy, r.submittedBy, r.approvedBy, r.decidedBy, r.endedBy]));
    return rows.map((s) => {
      const vendor = vendors.get(s.vendorId);
      const product = products.get(s.productId);
      return {
        ...commonView(s, product),
        vendorName: vendor ? storeNameOf(vendor) : null,
        sellerSuspended: vendor ? vendor.accountStatus === 'suspended' : false,
        createdBy: s.createdBy, createdByName: names[s.createdBy] ?? null,
        submittedBy: s.submittedBy ?? null, submittedByName: names[s.submittedBy] ?? null,
        approvedBy: s.approvedBy ?? null, approvedByName: names[s.approvedBy] ?? null,
        decidedBy: s.decidedBy ?? null, decidedByName: names[s.decidedBy] ?? null,
        endedBy: s.endedBy ?? null, endedByName: names[s.endedBy] ?? null,
        editedBy: s.editors || [],
        ownItem: isContributor(s, viewer?.actorId),
        regularPriceTzsAtSubmit: s.regularPriceTzsAtSubmit ?? null,
        discountPriceTzsAtSubmit: s.discountPriceTzsAtSubmit ?? null,
        priceChangedSinceSubmit: Boolean(priceMoved(s, product)),
        allowedActions: actionsFor(s, { side: 'admin', ...(viewer || {}) }),
      };
    });
  }

  // ── Loading in scope ────────────────────────────────────────────────────────

  /**
   * scope = { origin: 'vendor', vendorId } (a vendor acting on its own proposals) |
   * { vendorRead: vendorId } (a vendor reading: its own, plus FitFlex-made sales on its products once sent) |
   * { origin: 'staff' } (FitFlex-made sales) | { any: true } (admin decisions; vendor drafts are private).
   */
  function inScope(s, scope) {
    if (!s) return false;
    if (scope.any) return !(s.origin === 'vendor' && s.status === 'draft');
    if (scope.vendorRead) return s.vendorId === scope.vendorRead && (s.origin === 'vendor' || s.status !== 'draft');
    if (scope.origin === 'vendor') return s.origin === 'vendor' && s.vendorId === scope.vendorId;
    return s.origin === 'staff';
  }
  async function load(q, id, scope) {
    const s = await q.getSale(id);
    return inScope(s, scope) ? s : null;
  }
  const notFound = () => fail('sale_not_found', 404);
  const viewSide = scope => (scope.origin === 'vendor' || scope.vendorRead ? 'vendor' : 'admin');

  /** Run fn(q, sale) under the sale's product lock; send the notice it returns (best effort). */
  async function act(id, scope, actorId, fn) {
    if (!actorId) return fail('actor_required', 403);
    const first = await load(store, id, scope);
    if (!first) return notFound();
    let result;
    try {
      result = await store.transaction(first.productId, async (q) => {
        const s = await load(q, id, scope);
        if (!s) return notFound();
        return fn(q, s);
      });
    } catch (err) {
      // The database's one-approved-sale-per-product rule: someone else's approval won the race.
      // Say which sale won (contract (3)), read after the rollback.
      if (err?.code === EXCLUSION_VIOLATION) {
        const fresh = await store.getSale(id);
        const winner = fresh ? (await store.approvedOverlapping(fresh.productId, fresh.startsAt, fresh.endsAt, fresh.id))[0] : null;
        return fail('sale_overlap', 409, winner ? { saleId: winner.id, startsAt: winner.startsAt, endsAt: winner.endsAt, effectiveStatus: effectiveStatus(winner, now()) } : {});
      }
      throw err;
    }
    if (result.error) return result;
    if (result.notice) await notice(result.saved, result.notice);
    return result;
  }

  const invalid = (s, to) => fail('invalid_transition', 409, { from: effectiveStatus(s, now()), to });

  // ── Create and edit ─────────────────────────────────────────────────────────

  async function create({ scope, actorId, body, viewer = null }) {
    if (!actorId) return fail('actor_required', 403);
    const parsed = parseSaleInput(body, { create: true });
    if (parsed.error) return parsed;
    const v = parsed.value;
    const saved = await store.transaction(v.productId, async (q) => {
      const found = await productFor(q, v.productId, scope.origin === 'vendor' ? scope.vendorId : null);
      if (found.error) return found.error;
      const product = found.product;
      const blocked = await vendorBlocked(q, product.vendorId);
      if (blocked) return blocked;
      if (scope.origin === 'vendor') {
        const full = await openProposalsFull(q, scope.vendorId);
        if (full) return full;
      }
      const at = stamp();
      const row = {
        id: newSaleId(), origin: scope.origin, vendorId: product.vendorId, productId: product.id,
        salePriceTzs: v.salePriceTzs, startsAt: v.startsAt, endsAt: v.endsAt,
        status: 'draft', statusChangedAt: at, revision: 1, editors: [actorId], createdBy: actorId, createdAt: at, updatedAt: at,
      };
      const err = await rulesError(q, row, product);
      if (err) return err;
      const out = await q.insertSale(row);
      await audit(q, 'created', actorId, out, null, snapshot(out));
      return out;
    });
    if (saved.error) return saved;
    return { sale: (await decorate(store, [saved], viewSide(scope), viewer || { actorId, canManage: true }))[0] };
  }

  /**
   * Edit under the lock, moving the state like banners do:
   *   draft → draft · pending_approval → pending_approval (sent time kept; prices re-snapshotted) ·
   *   rejected → draft · approved (scheduled) → pending_approval · live | ended | expired | withdrawn → 409 not_editable.
   */
  async function update({ scope, id, actorId, body, viewer = null }) {
    if (!actorId) return fail('actor_required', 403);
    const parsed = parseSaleInput(body, { create: false });
    if (parsed.error) return parsed;
    if (!Object.keys(parsed.value).length) return fail('nothing_to_change', 400);
    const result = await act(id, scope, actorId, async (q, s) => {
      const eff = effectiveStatus(s, now());
      if (!['draft', 'pending_approval', 'rejected', 'approved'].includes(eff)) return fail('not_editable', 409, { currentStatus: eff });
      const found = await productFor(q, s.productId, s.vendorId);
      if (found.error) return found.error;
      const blocked = await vendorBlocked(q, s.vendorId);
      if (blocked) return blocked;
      const merged = { ...s, ...parsed.value };
      // Contract (4): the 1-hour lead applies only when the start itself moves.
      const startMoved = 'startsAt' in parsed.value && parsed.value.startsAt !== s.startsAt;
      const err = await rulesError(q, merged, found.product, { checkLead: startMoved });
      if (err) return err;
      const at = stamp();
      const next = { ...parsed.value, revision: s.revision + 1, editors: withEditor(s, actorId), updatedAt: at };
      const prices = { regularPriceTzsAtSubmit: found.product.priceTzs, discountPriceTzsAtSubmit: validDiscount(found.product) };
      if (eff === 'rejected') {
        if (s.origin === 'vendor') {
          const full = await openProposalsFull(q, s.vendorId);
          if (full) return full;
        }
        Object.assign(next, { status: 'draft', statusChangedAt: at, submittedBy: null, submittedAt: null, expiresAt: null, decidedBy: null, decidedAt: null, statusReason: null, statusReasonNote: null });
      } else if (eff === 'pending_approval') {
        Object.assign(next, prices, { expiresAt: proposalExpiry(s.submittedAt, merged.startsAt, config().proposalExpiryDays).toISOString() });
      } else if (eff === 'approved') {
        Object.assign(next, prices, {
          status: 'pending_approval', statusChangedAt: at, statusReason: null, statusReasonNote: null,
          submittedBy: actorId, submittedAt: at, expiresAt: proposalExpiry(at, merged.startsAt, config().proposalExpiryDays).toISOString(),
          approvedBy: null, approvedAt: null, decidedBy: null, decidedAt: null, wasPriceTzs: null,
        });
      }
      const saved = await q.updateSale(s.id, next);
      await audit(q, 'updated', actorId, saved, snapshot(s), snapshot(saved));
      return { saved };
    });
    if (result.error) return result;
    return { sale: (await decorate(store, [result.saved], viewSide(scope), viewer || { actorId, canManage: true }))[0] };
  }

  async function move(q, s, to, actorId, action, extra = {}) {
    const at = stamp();
    const saved = await q.updateSale(s.id, { status: to, statusChangedAt: at, updatedAt: at, ...extra });
    await audit(q, action, actorId, saved, { status: s.status, effectiveStatus: effectiveStatus(s, now()) }, {
      status: to, ...(extra.statusReason ? { code: extra.statusReason } : {}), ...(extra.statusReasonNote ? { reason: extra.statusReasonNote } : {}),
      ...(extra.wasPriceTzs != null ? { wasPriceTzs: extra.wasPriceTzs } : {}),
    });
    return saved;
  }

  const submit = ({ scope, id, actorId }) => act(id, scope, actorId, async (q, s) => {
    if (s.status !== 'draft') return invalid(s, 'pending_approval');
    const found = await productFor(q, s.productId, s.vendorId);
    if (found.error) return found.error;
    const blocked = await vendorBlocked(q, s.vendorId);
    if (blocked) return blocked;
    const err = await rulesError(q, s, found.product);
    if (err) return err;
    const at = stamp();
    const saved = await move(q, s, 'pending_approval', actorId, 'submitted', {
      submittedBy: actorId, submittedAt: at, editors: withEditor(s, actorId), statusReason: null, statusReasonNote: null,
      regularPriceTzsAtSubmit: found.product.priceTzs, discountPriceTzsAtSubmit: validDiscount(found.product),
      expiresAt: proposalExpiry(at, s.startsAt, config().proposalExpiryDays).toISOString(),
    });
    return { saved };
  });

  /** Take it back before it goes live: draft, pending or scheduled → withdrawn. */
  const withdraw = ({ scope, id, actorId }) => act(id, scope, actorId, async (q, s) => {
    const eff = effectiveStatus(s, now());
    if (eff === 'live') return fail('invalid_transition', 409, { from: eff, to: 'withdrawn', hint: 'end' });
    if (!['draft', 'pending_approval', 'approved'].includes(eff)) return invalid(s, 'withdrawn');
    return { saved: await move(q, s, 'withdrawn', actorId, 'withdrawn', { expiresAt: null }) };
  });

  /**
   * The vendor stops a scheduled or live sale on its own products early ("End now") — its own
   * proposals and (owner ruling (d)) FitFlex-made ones. Audited as flash_sale.ended with
   * { byVendorOnStaffSale: true } for the latter; FitFlex sees it in the queue (ended_by_vendor).
   */
  const vendorEnd = ({ scope, id, actorId }) => act(id, { vendorRead: scope.vendorId }, actorId, async (q, s) => {
    if (!['approved', 'live'].includes(effectiveStatus(s, now()))) return invalid(s, 'ended');
    const saved = await move(q, s, 'ended', actorId, 'ended', { endedBy: actorId, endedAt: stamp(), statusReason: 'ended_by_vendor', statusReasonNote: null });
    if (s.origin === 'staff') await audit(q, 'ended_by_vendor_on_staff_sale', actorId, saved, { status: s.status, createdBy: s.createdBy }, { status: 'ended', byVendorOnStaffSale: true });
    return { saved };
  });

  /**
   * Security review L2: a suspended vendor's scheduled and live sales are ended (statusReason
   * vendor_suspended), audited (flash_sale.ended) and the vendor told (flash_sale_ended). Called when an admin suspends the vendor
   * and by the lifecycle job (which also catches moderation suspensions). → number ended.
   */
  async function endForSuspendedVendor(vendorId, actorId = SYSTEM_ACTOR) {
    const at = now();
    const open = (await store.listForVendor(vendorId)).filter(s => ['approved', 'live'].includes(effectiveStatus(s, at)));
    let n = 0;
    for (const s0 of open) {
      const r = await store.transaction(s0.productId, async (q) => {
        const s = await q.getSale(s0.id);
        if (!s || !['approved', 'live'].includes(effectiveStatus(s, now()))) return null;
        return move(q, s, 'ended', actorId, 'ended', { endedBy: actorId, endedAt: stamp(), statusReason: 'vendor_suspended', statusReasonNote: null });
      });
      if (r) { n += 1; await notice(r, 'ended'); }
    }
    return n;
  }

  function sameRevision(s, revision) {
    if (revision == null || revision === '') return fail('revision_required', 400, { fields: ['revision'] });
    if (Number(revision) !== s.revision) return fail('sale_changed', 409, { revision: s.revision, updatedAt: s.updatedAt });
    return null;
  }

  /**
   * Approve a pending sale (promotions_approve on the route): an approver with no hand in it, the
   * revision reviewed, a vendor still allowed to sell, the product still on sale and at the prices it
   * had when the sale was sent, and every rule passing now. wasPriceTzs = the product's priceTzs now.
   */
  const approve = ({ id, actorId, revision }) => act(id, { any: true }, actorId, async (q, s) => {
    const eff = effectiveStatus(s, now());
    if (eff === 'expired') return fail('proposal_expired', 409, { expiresAt: s.expiresAt });
    if (eff !== 'pending_approval') return invalid(s, 'approved');
    const changed = sameRevision(s, revision);
    if (changed) return changed;
    if (isContributor(s, actorId)) return fail('cannot_approve_own_submission', 403);
    const st = (await vendorStates(q, [s.vendorId])).get(s.vendorId);
    if (!st.ok) return fail(st.reason, 409);
    // A moved price is said first (a price edit also sends the product back to review). The row
    // stays locked until the approval commits, so no price edit can land in between (review L4).
    const now0 = await q.productForUpdate(s.productId);
    if (now0 && !now0.deletedAt && now0.vendorId === s.vendorId && priceMoved(s, now0)) {
      return fail('sale_changed', 409, { reason: 'product_price_changed', regularPriceTzs: now0.priceTzs, regularPriceTzsAtSubmit: s.regularPriceTzsAtSubmit, discountPriceTzs: validDiscount(now0), discountPriceTzsAtSubmit: s.discountPriceTzsAtSubmit });
    }
    const found = await productFor(q, s.productId, s.vendorId);
    if (found.error) return found.error;
    const product = found.product;
    const err = await rulesError(q, s, product, { checkLead: false, withPending: false });
    if (err) return err;
    const at = stamp();
    const saved = await move(q, s, 'approved', actorId, 'approved', {
      approvedBy: actorId, approvedAt: at, decidedBy: actorId, decidedAt: at, expiresAt: null,
      wasPriceTzs: product.priceTzs, statusReason: null, statusReasonNote: null,
    });
    return { saved, notice: 'approved' };
  });

  /** Reject a pending sale { revision, code (SALE_REJECT_CODES), note (required for other; ≤ 500) }. */
  const reject = ({ id, actorId, revision, code, note }) => act(id, { any: true }, actorId, async (q, s) => {
    const eff = effectiveStatus(s, now());
    if (eff === 'expired') return fail('proposal_expired', 409, { expiresAt: s.expiresAt });
    if (eff !== 'pending_approval') return invalid(s, 'rejected');
    const changed = sameRevision(s, revision);
    if (changed) return changed;
    if (isContributor(s, actorId)) return fail('cannot_approve_own_submission', 403);
    if (code == null || code === '') return fail('reason_code_required', 400, { field: 'code', allowed: SALE_REJECT_CODES });
    if (!SALE_REJECT_CODES.includes(code)) return fail('invalid_reason_code', 400, { field: 'code', allowed: SALE_REJECT_CODES });
    if (note != null && (typeof note !== 'string' || note.trim().length > REASON_MAX)) return fail('invalid_note', 400, { field: 'note', maxLength: REASON_MAX });
    const why = text(note, REASON_MAX);
    if (code === 'other' && !why) return fail('note_required', 400, { field: 'note', maxLength: REASON_MAX });
    const at = stamp();
    const saved = await move(q, s, 'rejected', actorId, 'rejected', { statusReason: code, statusReasonNote: why, decidedBy: actorId, decidedAt: at, expiresAt: null });
    return { saved, notice: 'rejected' };
  });

  /** FitFlex ends an approved sale (scheduled or live) with a reason the vendor sees. */
  const end = ({ id, actorId, reason }) => act(id, { any: true }, actorId, async (q, s) => {
    if (!['approved', 'live'].includes(effectiveStatus(s, now()))) return invalid(s, 'ended');
    const why = text(reason, REASON_MAX);
    if (!why) return fail('reason_required', 400, { field: 'note', maxLength: REASON_MAX });
    const saved = await move(q, s, 'ended', actorId, 'ended', { endedBy: actorId, endedAt: stamp(), statusReason: 'ended_by_fitflex', statusReasonNote: why });
    return { saved, notice: 'ended' };
  });

  /**
   * Write down what time has decided: pending past expiry → expired (a vendor's own proposal: the
   * vendor is told), approved past the end → ended. Reads never wait for this. Idempotent.
   */
  async function runLifecycle() {
    const at = now();
    const { expired, ended } = await store.lapsed(at.toISOString());
    const out = { expired: [], ended: [] };
    for (const s0 of [...expired, ...ended]) {
      const r = await store.transaction(s0.productId, async (q) => {
        const s = await q.getSale(s0.id);
        const eff = s ? effectiveStatus(s, at) : null;
        if (s?.status === 'pending_approval' && eff === 'expired') {
          const code = ms(s.startsAt) <= ms(s.expiresAt) ? 'start_passed' : 'not_reviewed_in_time';
          return { kind: 'expired', saved: await move(q, s, 'expired', SYSTEM_ACTOR, 'expired', { statusReason: code, statusReasonNote: null }) };
        }
        if (s?.status === 'approved' && eff === 'ended') {
          return { kind: 'ended', saved: await move(q, s, 'ended', SYSTEM_ACTOR, 'ended', { endedAt: s.endsAt, statusReason: 'window_passed', statusReasonNote: null }) };
        }
        return null;
      });
      if (r) out[r.kind].push(r.saved);
    }
    for (const s of out.expired) if (s.origin === 'vendor') await notice(s, 'expired');
    // L2 sweep: sales of vendors suspended any way (account or moderation) since the last run.
    const open = await store.approvedNotEnded(at.toISOString());
    const states = await vendorStates(store, open.map(s => s.vendorId));
    let suspended = 0;
    for (const vendorId of new Set(open.map(s => s.vendorId))) {
      if (states.get(vendorId)?.reason === 'vendor_suspended') suspended += await endForSuspendedVendor(vendorId);
    }
    return { expired: out.expired.length, ended: out.ended.length, suspended };
  }

  async function notice(s, kind) {
    if (!s || !kind) return;
    try {
      const product = await store.product(s.productId);
      await notifyVendor(s.vendorId, `flash_sale_${kind}`, {
        saleId: s.id, productId: s.productId, productName: product?.name || '', startsAt: s.startsAt, endsAt: s.endsAt,
        reason: kind === 'rejected' || kind === 'ended' ? (s.statusReasonNote || '') : '',
      });
    } catch (err) {
      logger.error?.(`[flash-sales] could not tell vendor ${s.vendorId} about ${s.id} (${kind}):`, err?.message);
    }
  }

  // ── Price check and lists ───────────────────────────────────────────────────

  /**
   * GET …/price-check: the 14-day rule and the price limits for a product and a start.
   * vendorId: the caller's vendor (null for admins). → { ok, … } or { error }.
   */
  async function priceCheck({ vendorId = null, productId, startsAt = null }) {
    if (typeof productId !== 'string' || !productId) return fail('invalid_field', 400, { field: 'productId' });
    let start = startsAt;
    if (start == null || start === '') start = new Date(now().getTime() + SALE_RULES.minLeadMs).toISOString();
    else if (!Number.isFinite(ms(start))) return fail('invalid_date', 400, { field: 'startsAt' });
    const p = await store.product(productId);
    if (!p || p.deletedAt) return fail('product_not_found', 404, { productId });
    if (vendorId && p.vendorId !== vendorId) return fail('not_your_product', 403, { productId });
    const changes = await store.priceChanges(productId, new Date(ms(start) - SALE_RULES.priceRaiseLookbackDays * DAY_MS).toISOString());
    const raise = priceRaiseError(changes, start);
    const at = now();
    const young = priceHistoryError(await store.firstPriceAt(productId), start, at);
    const lock = (await store.approvedNotEnded(at.toISOString(), [productId]))[0] || null;
    return {
      ok: !raise && !young && !lock,
      // Owner ruling (b): the product's first price row and the first start it allows.
      listedAt: young?.listedAt ?? (await store.firstPriceAt(productId)),
      historyEarliestStart: young?.earliestStart ?? null,
      productId,
      regularPriceTzs: p.priceTzs,
      discountPriceTzs: validDiscount(p),
      effectivePriceTzs: standingPrice(p),
      maxSalePriceTzs: Math.min(maxSalePrice(p.priceTzs), standingPrice(p) - 1),
      raisedAt: raise?.raisedAt ?? null,
      raisedOn: raise?.raisedOn ?? null,
      earliestStart: raise?.earliestStart ?? null,
      lockedBy: lock ? { saleId: lock.id, startsAt: lock.startsAt, endsAt: lock.endsAt, effectiveStatus: effectiveStatus(lock, at) } : null,
    };
  }

  async function vendorList({ vendorId, query = {} }) {
    let rows = (await store.listForVendor(vendorId)).filter(s => inScope(s, { vendorRead: vendorId }));
    if (query.status) {
      if (!SALE_EFFECTIVE_STATUSES.includes(query.status)) return fail('invalid_status', 400, { allowed: SALE_EFFECTIVE_STATUSES });
      rows = rows.filter(s => effectiveStatus(s, now()) === query.status);
    }
    if (query.productId) rows = rows.filter(s => s.productId === query.productId);
    const p = page(rows, query);
    const st = (await vendorStates(store, [vendorId])).get(vendorId);
    return {
      items: await decorate(store, p.items, 'vendor'), total: p.total, nextCursor: p.nextCursor,
      vendor: { canPropose: st.ok, reason: st.reason },
      proposalExpiryDays: config().proposalExpiryDays,
      openProposals: { open: await store.openProposals(vendorId, stamp()), max: config().maxOpenProposals },
      rules: { ...SALE_RULES },
    };
  }

  async function vendorGet({ vendorId, id }) {
    const s = await load(store, id, { vendorRead: vendorId });
    if (!s) return notFound();
    return { sale: (await decorate(store, [s], 'vendor'))[0] };
  }

  async function adminList({ query = {}, viewer }) {
    const all = (await store.listSales()).filter(s => inScope(s, { any: true }));
    const at = now();
    const eff = s => effectiveStatus(s, at);
    const counts = Object.fromEntries(Object.entries(ADMIN_TABS).map(([tab, states]) => [tab, all.filter(s => states.includes(eff(s))).length]));
    let rows = all;
    if (query.tab) {
      if (!ADMIN_TABS[query.tab]) return fail('invalid_tab', 400, { allowed: Object.keys(ADMIN_TABS) });
      rows = rows.filter(s => ADMIN_TABS[query.tab].includes(eff(s)));
    }
    if (query.status) {
      if (!SALE_EFFECTIVE_STATUSES.includes(query.status)) return fail('invalid_status', 400, { allowed: SALE_EFFECTIVE_STATUSES });
      rows = rows.filter(s => eff(s) === query.status);
    }
    if (query.origin) rows = rows.filter(s => s.origin === query.origin);
    if (query.vendorId) rows = rows.filter(s => s.vendorId === query.vendorId);
    if (query.productId) rows = rows.filter(s => s.productId === query.productId);
    let decorated = await decorate(store, rows, 'admin', viewer);
    const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : '';
    if (needle) decorated = decorated.filter(v => [v.vendorName, v.productName].some(x => String(x || '').toLowerCase().includes(needle)));
    if (query.tab === 'requests' || query.status === 'pending_approval') decorated.sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || a.id.localeCompare(b.id));
    const p = page(decorated, query);
    return { items: p.items, total: p.total, nextCursor: p.nextCursor, counts };
  }

  async function adminGet({ id, viewer }) {
    const s = await load(store, id, { any: true });
    if (!s) return notFound();
    const history = await store.history(id);
    const names = await store.displayNames(history.map(r => r.actor));
    const product = await store.product(s.productId);
    const since = new Date(now().getTime() - 30 * DAY_MS).toISOString();
    const recent = await store.priceChanges(s.productId, since);
    const forRule = await store.priceChanges(s.productId, new Date(ms(s.startsAt) - SALE_RULES.priceRaiseLookbackDays * DAY_MS).toISOString());
    const raise = priceRaiseError(forRule, s.startsAt);
    const listedAt = await store.firstPriceAt(s.productId);
    const young = priceHistoryError(listedAt, s.startsAt, now());
    const regular = s.wasPriceTzs ?? product?.priceTzs ?? 0;
    return {
      sale: (await decorate(store, [s], 'admin', viewer))[0],
      history: history.map(r => ({ ...r, actorName: r.actor === SYSTEM_ACTOR ? null : names[r.actor] ?? null })),
      priceCheck: {
        passes14DayRule: !raise,
        passesHistoryRule: !young, listedAt, historyEarliestStart: young?.earliestStart ?? null,
        raisedAt: raise?.raisedAt ?? null, raisedOn: raise?.raisedOn ?? null, earliestStart: raise?.earliestStart ?? null,
        priceHistory: recent.map(c => ({ ...c, raised: isRaise(c), on: eatDate(c.at) })),
        discountLine: { pct: discountPct(regular, s.salePriceTzs), savingTzs: Math.max(0, regular - s.salePriceTzs), sellerPays: true },
        priceChangedSinceSubmit: Boolean(priceMoved(s, product)),
        lastRaiseAt: latestRaise(forRule)?.at ?? null,
      },
    };
  }

  /**
   * Contract (5): the staff product picker for "Create sale" with `promotions` (read-only, minimal
   * fields): products a buyer can find, of vendors allowed to run a sale. ?q (name), ?vendorId, ?limit ≤ 50.
   */
  async function adminProducts({ query = {} }) {
    const needle = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
    const rows = await store.pickerProducts({ q: needle, vendorId: typeof query.vendorId === 'string' ? query.vendorId : null, limit: limit * 3 });
    const states = await vendorStates(store, rows.map(p => p.vendorId));
    const items = rows.filter(p => productListed(p) && states.get(p.vendorId)?.ok).slice(0, limit).map(p => ({
      id: p.id, name: p.name, vendorId: p.vendorId, vendorName: storeNameOf(states.get(p.vendorId).row),
      priceTzs: p.priceTzs, discountPriceTzs: validDiscount(p), effectivePriceTzs: standingPrice(p),
      maxSalePriceTzs: Math.min(maxSalePrice(p.priceTzs), standingPrice(p) - 1), stock: p.stock, image: p.images?.[0] ?? null,
    }));
    return { items };
  }

  // ── Pricing reads (shop-service, shop home, checkout). Nothing cached. ───────

  const pricing = {
    /** Map(productId → approved sale live at `at`); productIds null = all products. */
    async liveByProduct(productIds = null, at = now()) {
      const rows = await store.liveAt(new Date(at).toISOString(), productIds);
      const out = new Map();
      // The constraint allows one per product; if two ever read as live, the lower price wins (lowest-price rule).
      for (const s of rows) if (!out.has(s.productId) || s.salePriceTzs < out.get(s.productId).salePriceTzs) out.set(s.productId, s);
      return out;
    },
    /**
     * The approved sale that locks a product's prices at `at` (scheduled or live), else null. `q` =
     * the store bound to the caller's transaction (read after it locked the Product row).
     */
    async lockOf(productId, at = now(), q = store) {
      return (await q.approvedNotEnded(new Date(at).toISOString(), [productId]))
        .sort((a, b) => ms(a.startsAt) - ms(b.startsAt))[0] || null;
    },
    /** Map(productId → lock) for several products (vendor product list). */
    async locksOf(productIds, at = now()) {
      const out = new Map();
      for (const s of await store.approvedNotEnded(new Date(at).toISOString(), productIds)) {
        if (!out.has(s.productId) || ms(s.startsAt) < ms(out.get(s.productId).startsAt)) out.set(s.productId, s);
      }
      return out;
    },
    /** Did this product's price come from one of its flash sales that is no longer live? (409 reason) */
    async wasSalePrice(productId, priceTzs, at = now()) {
      const t = new Date(at).getTime();
      return (await store.salesOfProduct(productId)).some(s => s.salePriceTzs === Number(priceTzs) && s.approvedBy && (s.status !== 'approved' || ms(s.endsAt) <= t || ms(s.startsAt) > t));
    },
    /** The store on another transaction (the stock ledger's product-form transaction). */
    using: trx => store.using(trx),
    /** Save a product (no ledger) in one transaction under its row lock: decide(current, q) → { patch } | { error }. */
    updateProductLocked: (productId, decide) => store.updateProductLocked(productId, decide),
    effectiveStatus: s => effectiveStatus(s, now()),
  };

  return {
    create, update, submit, withdraw, vendorEnd, vendorList, vendorGet, priceCheck,
    approve, reject, end, adminList, adminGet,
    runLifecycle, endForSuspendedVendor, adminProducts,
    pricing,
  };
}
