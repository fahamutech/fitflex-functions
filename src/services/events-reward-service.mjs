// Marathon & running events · S6 — rewards and the entitlement ledger (spec §7.4, §7.6, §8.2, §8.3; D44, D45, D53). RULE 6 AREA.
//
// - NO POINTS CURRENCY (D44): RewardLedgerEntry.points holds an entitlement UNIT count per RewardDefinition (+1 earn, -1 claim / expiry, a
//   reverse carries the negated points of the entry it undoes). The wallet shows rewards, never a total; units of different definitions
//   are never added, converted or spent against each other. RewardDefinition.points is ignored.
// - NO MONEY (D45): digital certificates and perks verified by FitFlex staff. valueTzs must be empty (422 value_not_allowed_yet) and
//   only FitFlex can issue (422 issuer_not_allowed). Nothing here moves a shilling; there is no cash-out.
// - The ledger is append-only (database trigger). A claim, an expiry and a reversal are NEW rows. Two parallel claims of one unit are
//   serialised by an advisory lock per (user, definition): exactly one wins.
// - Account deletion: the ON DELETE SET NULL foreign key anonymises the user's rows (the one allowed update); nothing is deleted.
import { randomUUID } from 'node:crypto';
import { codeFor, hashCode, normaliseCode } from '../shared/events-reward-code.mjs';
import { bilingual, sha256hex } from '../shared/events-results-rules.mjs';
import { encodeCursor, decodeCursor, parseLimit } from '../shared/events-ops-rules.mjs';
import { createIdempotency } from '../shared/organizer-idempotency.mjs';
import { createCounterWindow } from '../shared/events-rate-limits.mjs';
import { enqueueAwardTask } from '../shared/events-award-queue.mjs';
import { COPY } from '../shared/events-results-copy.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const DAY = 86_400_000;
const PERK_HOLD_DAYS = 14;
const TRIGGERS = ['event_finish', 'medal', 'achievement'];
const MODES = ['certificate', 'perk'];
const POLICIES = ['revoke_unredeemed', 'revoke_all'];
const maskName = name => { const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean); return parts.length ? `${parts[0]}${parts[1] ? ` ${parts[1][0]}.` : ''}` : null; };

export function createEventsRewardService({ db, ticketRing = () => null, notice = async () => {}, now = () => new Date(), adminRate = { perMinute: 30 } }) {
  const stamp = () => new Date(now());
  const idempotent = createIdempotency({ db, now });
  const audit = (actor, action, target, before, after, q = db) => q('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: typeof actor === 'string' ? actor : (actor.userId ?? 'system'), action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });
  const lookups = new Map();
  const lookupFailures = createCounterWindow({ limit: 10, windowMs: 3_600_000 });

  // ── Definitions ───────────────────────────────────────────────────────────

  const defView = (d, { capUsed = null } = {}) => ({
    id: d.id, title: d.title, triggerType: d.triggerType, triggerEventId: d.triggerEventId, triggerRef: d.triggerRef, redeemMode: d.redeemMode, terms: d.terms,
    startsAt: iso(d.startsAt), endsAt: iso(d.endsAt), capTotal: d.capTotal, capPerUser: d.capPerUser ?? 1, eligibility: d.eligibility, expiryDays: d.expiryDays,
    reversalPolicy: d.reversalPolicy, perUserCooldownDays: d.perUserCooldownDays, fundingNote: d.fundingNote, valueTzs: null, issuerType: d.issuerType, status: d.status,
    ...(capUsed === null ? {} : { capUsed }),
  });

  async function validate(body, current = null) {
    const fields = []; const out = {};
    const bad = (path, code) => fields.push({ path, code });
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (b.valueTzs !== undefined && b.valueTzs !== null) return fail('value_not_allowed_yet', 422);
    if (b.issuerType !== undefined && b.issuerType !== 'fitflex') return fail('issuer_not_allowed', 422);
    const locked = Boolean(current?.locked);
    const text = (key, max) => { if (key in b || !current) { const v = bilingual(b[key], { max, requireEn: true, requireSw: true }); if (v.error) bad(key, v.error); else out[key] = v.value; } };
    text('title', 80); text('terms', 600);
    if ('fundingNote' in b || !current) { const v = typeof b.fundingNote === 'string' ? b.fundingNote.trim() : ''; if (!v || v.length > 200) bad('fundingNote', v ? 'too_long' : 'required'); else out.fundingNote = v; }
    const triggerTouched = ['triggerType', 'triggerEventId', 'triggerRef', 'redeemMode'].some(k => k in b);
    if (triggerTouched || !current) {
      if (locked && triggerTouched) return fail('definition_locked', 409);
      const triggerType = b.triggerType ?? current?.triggerType;
      if (!TRIGGERS.includes(triggerType)) bad('triggerType', 'invalid'); else out.triggerType = triggerType;
      const redeemMode = b.redeemMode ?? current?.redeemMode ?? 'certificate';
      if (!MODES.includes(redeemMode)) bad('redeemMode', 'invalid'); else { out.redeemMode = redeemMode; out.rewardType = redeemMode; }
      const ref = 'triggerRef' in b ? b.triggerRef : current?.triggerRef;
      const eventId = 'triggerEventId' in b ? b.triggerEventId : current?.triggerEventId;
      if (triggerType === 'medal') {
        if (typeof ref !== 'string' || !(await db('EventMedalTemplate').where({ id: ref }).first('id'))) bad('triggerRef', 'unknown_medal'); else out.triggerRef = ref;
        out.triggerEventId = null;
      } else if (triggerType === 'achievement') {
        if (typeof ref !== 'string' || !(await db('AchievementDefinition').where({ key: ref, status: 'active' }).first('id'))) bad('triggerRef', 'unknown_achievement'); else out.triggerRef = ref;
        out.triggerEventId = null;
      } else if (triggerType === 'event_finish') {
        out.triggerRef = null;
        if (eventId === undefined || eventId === null) out.triggerEventId = null;
        else if (typeof eventId !== 'string' || !(await db('Event').where({ id: eventId }).first('id'))) bad('triggerEventId', 'unknown_event'); else out.triggerEventId = eventId;
      }
    }
    const intField = (key, min, max, nullable = true) => {
      if (!(key in b)) return;
      if (b[key] === null && nullable) { out[key] = null; return; }
      if (!Number.isInteger(b[key]) || b[key] < min || b[key] > max) bad(key, 'out_of_range'); else out[key] = b[key];
    };
    intField('capTotal', 1, 10_000_000); intField('capPerUser', 1, 100, false); intField('expiryDays', 1, 3650); intField('perUserCooldownDays', 0, 3650);
    if (!current && !('capPerUser' in b)) out.capPerUser = 1;
    for (const k of ['startsAt', 'endsAt']) if (k in b) { if (b[k] === null) out[k] = null; else if (Number.isNaN(+new Date(b[k]))) bad(k, 'invalid'); else out[k] = new Date(b[k]); }
    const s = 'startsAt' in out ? out.startsAt : current?.startsAt; const e = 'endsAt' in out ? out.endsAt : current?.endsAt;
    if (s && e && +new Date(e) < +new Date(s)) bad('endsAt', 'before_start');
    if ('reversalPolicy' in b) { if (!POLICIES.includes(b.reversalPolicy)) bad('reversalPolicy', 'invalid'); else out.reversalPolicy = b.reversalPolicy; }
    if ('eligibility' in b) {
      const el = b.eligibility && typeof b.eligibility === 'object' && !Array.isArray(b.eligibility) ? b.eligibility : null;
      if (!el || Object.keys(el).some(k => k !== 'categoryIds') || ('categoryIds' in el && (!Array.isArray(el.categoryIds) || el.categoryIds.length > 50 || el.categoryIds.some(x => typeof x !== 'string')))) bad('eligibility', 'invalid');
      else out.eligibility = el;
    }
    if (!current && 'status' in b && !['draft', 'active'].includes(b.status)) bad('status', 'invalid');
    if (fields.length) return fail('validation_failed', 422, { fields });
    return { values: out };
  }

  const jsonCols = v => ({ ...v, ...(v.title ? { title: JSON.stringify(v.title) } : {}), ...(v.terms ? { terms: JSON.stringify(v.terms) } : {}), ...(v.eligibility ? { eligibility: JSON.stringify(v.eligibility) } : {}) });
  const hasLedger = async id => Boolean(await db('RewardLedgerEntry').where({ rewardDefinitionId: id }).first('id'));

  async function createDefinition({ actor, body = {} }) {
    const v = await validate(body);
    if (v.error) return v;
    const id = newId('rwd');
    const status = body.status === 'active' ? 'active' : 'draft';
    const [row] = await db('RewardDefinition').insert({ id, issuerType: 'fitflex', ...jsonCols(v.values), valueTzs: null, points: null, status, createdAt: stamp(), updatedAt: stamp() }).returning('*');
    await audit(actor, 'events.reward_definition_created', id, null, { triggerType: row.triggerType, redeemMode: row.redeemMode, status });
    if (status === 'active') await kick(row);
    return { definition: defView(plain(row)), status: 201 };
  }

  /** A newly active definition earns retroactively: queue the event it names (a medal's own event or the trigger event). */
  async function kick(def) {
    let eventId = def.triggerEventId;
    if (!eventId && def.triggerType === 'medal') eventId = (await db('EventMedalTemplate').where({ id: def.triggerRef }).first('eventId'))?.eventId ?? null;
    if (eventId) await enqueueAwardTask(db, { eventId, reason: 'definition_changed', at: stamp() });
  }

  async function updateDefinition({ actor, id, body = {} }) {
    const cur = plain(await db('RewardDefinition').where({ id: String(id) }).first());
    if (!cur) return fail('definition_not_found', 404);
    if (cur.status === 'ended') return fail('definition_ended', 409);
    const v = await validate(body, { ...cur, locked: await hasLedger(cur.id) });
    if (v.error) return v;
    if (!Object.keys(v.values).length) return fail('validation_failed', 422, { fields: [{ path: 'body', code: 'empty' }] });
    const [row] = await db('RewardDefinition').where({ id: cur.id }).update({ ...jsonCols(v.values), updatedAt: stamp() }).returning('*');
    await audit(actor, 'events.reward_definition_updated', cur.id, { status: cur.status }, { fields: Object.keys(v.values) });
    return { definition: defView(plain(row)) };
  }

  async function setStatus({ actor, id, to }) {
    const cur = plain(await db('RewardDefinition').where({ id: String(id) }).first());
    if (!cur) return fail('definition_not_found', 404);
    const allowed = { active: ['draft', 'paused'], paused: ['active'], ended: ['active', 'paused', 'draft'] }[to];
    if (!allowed.includes(cur.status)) return fail('invalid_transition', 409, { from: cur.status, to });
    const [row] = await db('RewardDefinition').where({ id: cur.id }).update({ status: to, updatedAt: stamp() }).returning('*');
    await audit(actor, `events.reward_definition_${to === 'active' ? 'updated' : to === 'paused' ? 'paused' : 'ended'}`, cur.id, { status: cur.status }, { status: to });
    if (to === 'active') await kick(plain(row));
    return { definition: defView(plain(row)) };
  }
  const activate = args => setStatus({ ...args, to: 'active' });
  const pause = args => setStatus({ ...args, to: 'paused' });
  const end = args => setStatus({ ...args, to: 'ended' });

  async function listDefinitions() {
    const rows = (await db('RewardDefinition').orderBy('createdAt', 'desc').limit(500)).map(plain);
    const used = new Map((await db('RewardLedgerEntry').where({ entryType: 'earn' }).whereNotExists(function none() { this.select(db.raw('1')).from('RewardLedgerEntry as r').whereRaw('r."reversesEntryId" = "RewardLedgerEntry".id'); })
      .groupBy('rewardDefinitionId').select('rewardDefinitionId').count({ n: '*' })).map(r => [r.rewardDefinitionId, Number(r.n)]));
    return { items: rows.map(d => defView(d, { capUsed: used.get(d.id) ?? 0 })) };
  }

  // ── Ledger primitives (called by the award engine inside its transaction) ──

  const balanceIn = async (q, userId, definitionId) => Number((await q('RewardLedgerEntry').where({ userId, rewardDefinitionId: definitionId }).sum({ n: 'points' }).first()).n ?? 0);

  /** Live earns of a definition (earn entries with no reverse), optionally of one user. */
  const liveEarns = (q, definitionId, userId = null) => q('RewardLedgerEntry as e').where('e.rewardDefinitionId', definitionId).where('e.entryType', 'earn')
    .modify((b) => { if (userId) b.where('e.userId', userId); })
    .whereNotExists(function reversed() { this.select(q.raw('1')).from('RewardLedgerEntry as r').whereRaw('r."reversesEntryId" = e.id'); });

  /**
   * Earn one unit if the definition allows it. → { entry } | { skipped: 'window' | 'cap_total' | 'cap_user' | 'cooldown' | 'category' | 'inactive' }.
   * Locks the definition row so parallel earns cannot pass capTotal together. The key makes a retry a no-op; after a reversal a re-earn
   * (the medal was reinstated) gets a fresh suffix.
   */
  async function earnIn(trx, { definitionId, userId, sourceType, sourceId, categoryId = null }) {
    const def = plain(await trx('RewardDefinition').where({ id: definitionId }).forUpdate().first());
    if (!def || def.status !== 'active') return { skipped: 'inactive' };
    const at = stamp();
    if ((def.startsAt && +new Date(def.startsAt) > +at) || (def.endsAt && +new Date(def.endsAt) < +at)) return { skipped: 'window' };
    const cats = def.eligibility?.categoryIds;
    if (Array.isArray(cats) && cats.length && !cats.includes(categoryId)) return { skipped: 'category' };
    const base = `earn:${def.id}:${userId}:${sourceType}:${sourceId}`;
    const same = (await trx('RewardLedgerEntry').where('idempotencyKey', 'like', `${base}%`).select('id', 'idempotencyKey')).map(plain);
    const open = same.filter(s => true);
    if (open.length) {
      const reversed = new Set((await trx('RewardLedgerEntry').whereIn('reversesEntryId', open.map(o => o.id)).select('reversesEntryId')).map(r => r.reversesEntryId));
      if (open.some(o => !reversed.has(o.id))) return { skipped: 'already' };
    }
    const perUser = Number((await liveEarns(trx, def.id, userId).count({ n: '*' }).first()).n);
    if (perUser >= (def.capPerUser ?? 1)) return { skipped: 'cap_user' };
    if (def.perUserCooldownDays) {
      const last = await trx('RewardLedgerEntry').where({ rewardDefinitionId: def.id, userId, entryType: 'earn' }).max({ at: 'occurredAt' }).first();
      if (last?.at && +at - +new Date(last.at) < def.perUserCooldownDays * DAY) return { skipped: 'cooldown' };
    }
    if (def.capTotal !== null && Number((await liveEarns(trx, def.id).count({ n: '*' }).first()).n) >= def.capTotal) return { skipped: 'cap_total' };
    const id = newId('rle');
    const [entry] = await trx('RewardLedgerEntry').insert({
      id, userId, rewardDefinitionId: def.id, entryType: 'earn', points: 1, valueTzs: null, sourceType, sourceId, idempotencyKey: open.length ? `${base}:r${open.length}` : base, occurredAt: at, createdAt: at,
    }).returning('*');
    await audit('system', 'events.reward_earned', def.id, null, { entryId: id, sourceType }, trx);
    return { entry: plain(entry), def };
  }

  /**
   * The source of an earn was removed: undo what is still undoable (spec §7.4). → [{ entryId, definition, reason }] reversed.
   * An unspent unit is reversed. A reserved perk is cancelled and its unit returned, then reversed. A unit already REDEEMED is kept under
   * revoke_unredeemed (the redemption is flagged needsReview and the audit says so) and reversed under revoke_all (flagged too, nothing clawed back).
   */
  async function reverseSourceIn(trx, { userId, sourceType, sourceId, reason }) {
    const earns = (await trx('RewardLedgerEntry as e').where({ 'e.userId': userId, 'e.sourceType': sourceType, 'e.sourceId': sourceId, 'e.entryType': 'earn' })
      .whereNotExists(function reversed() { this.select(trx.raw('1')).from('RewardLedgerEntry as r').whereRaw('r."reversesEntryId" = e.id'); })
      .whereNotExists(function expired() { this.select(trx.raw('1')).from('RewardLedgerEntry as x').whereRaw(`x."idempotencyKey" = 'expire:' || e.id`); }).select('e.*')).map(plain);
    const done = [];
    for (const e of earns) {
      const def = plain(await trx('RewardDefinition').where({ id: e.rewardDefinitionId }).first());
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rwd:${userId}:${def.id}`]);
      let balance = await balanceIn(trx, userId, def.id);
      const at = stamp();
      if (balance < 1) {
        const reserved = plain(await trx('RewardRedemption').where({ userId, rewardDefinitionId: def.id, status: 'reserved' }).orderBy('reservedAt', 'desc').forUpdate().first());
        if (reserved) { await cancelIn(trx, reserved, { reason: 'source_revoked' }); balance += 1; } else {
          const used = plain(await trx('RewardRedemption').where({ userId, rewardDefinitionId: def.id, status: 'redeemed' }).orderBy('redeemedAt', 'desc').forUpdate().first());
          if (used) await trx('RewardRedemption').where({ id: used.id }).update({ needsReview: true, updatedAt: at });
          await audit('system', 'events.reward_reversal_skipped', def.id, null, { entryId: e.id, policy: def.reversalPolicy, redeemed: Boolean(used) }, trx);
          if (def.reversalPolicy !== 'revoke_all') continue;
        }
      }
      const id = newId('rle');
      await trx('RewardLedgerEntry').insert({ id, userId, rewardDefinitionId: def.id, entryType: 'reverse', points: -1, sourceType: 'reversal', sourceId: e.id, reversesEntryId: e.id, idempotencyKey: `reverse:${e.id}`, occurredAt: at, createdAt: at }).onConflict('idempotencyKey').ignore();
      await audit('system', 'events.reward_reversed', def.id, null, { entryId: id, reverses: e.id, reason }, trx);
      done.push({ entryId: id, definition: def, reason });
    }
    return done;
  }

  /** Cancel a reserved redemption and give the unit back (a reverse of the redeem entry). */
  async function cancelIn(trx, redemption, { reason, status = 'cancelled', adminNote = null, by = null }) {
    const at = stamp();
    await trx('RewardRedemption').where({ id: redemption.id, status: 'reserved' }).update({ status, adminNote, updatedAt: at, ...(by ? { redeemedBy: null } : {}) });
    if (redemption.ledgerEntryId) {
      await trx('RewardLedgerEntry').insert({
        id: newId('rle'), userId: redemption.userId, rewardDefinitionId: redemption.rewardDefinitionId, entryType: 'reverse', points: 1, sourceType: 'redemption', sourceId: redemption.id,
        reversesEntryId: redemption.ledgerEntryId, idempotencyKey: `reverse:${redemption.ledgerEntryId}`, occurredAt: at, createdAt: at,
      }).onConflict('idempotencyKey').ignore();
    }
    await audit('system', 'events.reward_redemption_cancelled', redemption.id, { status: 'reserved' }, { status, reason }, trx);
  }

  // ── Member: wallet, ledger, claim ─────────────────────────────────────────

  const titleOf = d => d.title;

  async function wallet({ userId }) {
    const entries = (await db('RewardLedgerEntry').where({ userId }).orderBy('occurredAt')).map(plain);
    const defIds = [...new Set(entries.map(e => e.rewardDefinitionId).filter(Boolean))];
    const defs = new Map((defIds.length ? await db('RewardDefinition').whereIn('id', defIds) : []).map(d => [d.id, plain(d)]));
    const at = stamp();
    const available = []; const expired = [];
    for (const id of defIds) {
      const d = defs.get(id);
      const mine = entries.filter(e => e.rewardDefinitionId === id);
      const units = mine.reduce((n, e) => n + e.points, 0);
      const reversedIds = new Set(mine.filter(e => e.entryType === 'reverse').map(e => e.reversesEntryId));
      const expiredKeys = new Set(mine.filter(e => e.entryType === 'expire').map(e => e.idempotencyKey));
      const live = mine.filter(e => e.entryType === 'earn' && !reversedIds.has(e.id) && !expiredKeys.has(`expire:${e.id}`));
      for (const e of mine.filter(x => x.entryType === 'expire')) expired.push({ definitionId: id, title: titleOf(d), expiredAt: iso(e.occurredAt) });
      if (units < 1) continue;
      const unspent = live.slice(Math.max(0, live.length - units));
      const nextExpiry = d.expiryDays && unspent.length ? iso(+new Date(unspent[0].occurredAt) + d.expiryDays * DAY) : null;
      available.push({ definitionId: id, title: titleOf(d), terms: d.terms, units, nextExpiry, redeemMode: d.redeemMode, canClaim: d.status === 'active' });
    }
    const ring = ticketRing();
    const reds = (await db('RewardRedemption').where({ userId }).orderBy('reservedAt', 'desc').limit(100)).map(plain);
    const redemptions = reds.map(r => ({
      id: r.id, definitionId: r.rewardDefinitionId, title: defs.get(r.rewardDefinitionId)?.title ?? null, status: r.status, redeemMode: defs.get(r.rewardDefinitionId)?.redeemMode ?? null,
      code: r.status === 'reserved' ? codeFor(ring, r.id) : null, expiresAt: iso(r.expiresAt), redeemedAt: iso(r.redeemedAt),
    }));
    void at;
    return { available, redemptions, expired };
  }

  async function myLedger({ userId, query = {} }) {
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('RewardLedgerEntry').where({ userId });
    if (cursor?.at) q.where(function k() { this.where('occurredAt', '<', new Date(cursor.at)).orWhere(function t() { this.where('occurredAt', new Date(cursor.at)).where('id', '<', cursor.id); }); });
    const rows = (await q.orderBy('occurredAt', 'desc').orderBy('id', 'desc').limit(limit + 1)).map(plain);
    const page = rows.slice(0, limit);
    const defs = new Map((await db('RewardDefinition').whereIn('id', [...new Set(page.map(r => r.rewardDefinitionId).filter(Boolean))])).map(d => [d.id, d.title]));
    return {
      items: page.map(r => ({ id: r.id, entryType: r.entryType, rewardDefinitionId: r.rewardDefinitionId, titleOf: defs.get(r.rewardDefinitionId) ?? null, units: r.points, sourceType: r.sourceType, sourceLabelCode: r.sourceType, occurredAt: iso(r.occurredAt), reverses: r.reversesEntryId })),
      nextCursor: rows.length > limit ? encodeCursor({ at: page[page.length - 1].occurredAt, id: page[page.length - 1].id }) : null,
    };
  }

  const redemptionView = (r, ring) => ({ id: r.id, definitionId: r.rewardDefinitionId, status: r.status, code: r.status === 'reserved' ? codeFor(ring, r.id) : null, expiresAt: iso(r.expiresAt), redeemedAt: iso(r.redeemedAt) });

  async function claim({ userId, key, body = {} }) {
    if (typeof body.rewardDefinitionId !== 'string' || !body.rewardDefinitionId) return fail('validation_failed', 422, { fields: [{ path: 'rewardDefinitionId', code: 'required' }] });
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) return fail(key ? 'invalid_idempotency_key' : 'idempotency_key_required', 400);
    const idemKey = `${userId}:${key}`.slice(0, 140);
    const prior = plain(await db('RewardRedemption').where({ idempotencyKey: idemKey }).first());
    if (prior) return prior.rewardDefinitionId === body.rewardDefinitionId ? { redemption: redemptionView(prior, ticketRing()), status: 200, replayed: true } : fail('idempotency_key_reused', 409);
    const ring = ticketRing();
    return db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rwd:${userId}:${body.rewardDefinitionId}`]);
      const def = plain(await trx('RewardDefinition').where({ id: body.rewardDefinitionId }).first());
      if (!def || def.status !== 'active') return fail('reward_unavailable', 409);
      if (def.redeemMode === 'perk' && !ring) return fail('rewards_unavailable', 503);
      if (await balanceIn(trx, userId, def.id) < 1) return fail('not_enough_units', 409);
      const at = stamp(); const id = newId('rdm'); const entryId = newId('rle');
      const perk = def.redeemMode === 'perk';
      await trx('RewardLedgerEntry').insert({ id: entryId, userId, rewardDefinitionId: def.id, entryType: 'redeem', points: -1, sourceType: 'redemption', sourceId: id, idempotencyKey: `redeem:${id}`, occurredAt: at, createdAt: at });
      const code = perk ? codeFor(ring, id) : null;
      const [row] = await trx('RewardRedemption').insert({
        id, userId, rewardDefinitionId: def.id, ledgerEntryId: entryId, codeHash: hashCode(code ?? `cert:${id}`), status: perk ? 'reserved' : 'redeemed', reservedAt: at,
        redeemedAt: perk ? null : at, expiresAt: perk ? new Date(+at + PERK_HOLD_DAYS * DAY) : null, redeemedByRole: perk ? null : 'self', idempotencyKey: idemKey, createdAt: at, updatedAt: at,
      }).returning('*');
      await audit(userId, 'events.reward_claimed', def.id, null, { redemptionId: id, redeemMode: def.redeemMode }, trx);
      return { redemption: { ...redemptionView(plain(row), ring), ...(perk ? {} : { certificate: { title: def.title, terms: def.terms } }) }, status: 201 };
    });
  }

  async function getRedemption({ userId, id }) {
    const r = plain(await db('RewardRedemption').where({ id: String(id), userId }).first());
    return r ? { redemption: redemptionView(r, ticketRing()) } : fail('not_found', 404);
  }

  // ── Admin desk (scope events): lookup, mark used, cancel ──────────────────

  async function lookup({ admin, body = {} }) {
    const bucket = lookups.get(admin) ?? { start: +stamp(), n: 0 };
    if (+stamp() - bucket.start > 60_000) { bucket.start = +stamp(); bucket.n = 0; }
    bucket.n += 1; lookups.set(admin, bucket);
    if (bucket.n > adminRate.perMinute) return fail('rate_limited', 429, { retryAfterSeconds: 60 });
    const blocked = lookupFailures.blocked(admin);
    if (blocked) return fail('rate_limited', 429, { retryAfterSeconds: blocked.retryAfterSeconds });
    const code = normaliseCode(body.code);
    const row = code ? plain(await db('RewardRedemption').where({ codeHash: hashCode(code) }).first()) : null;
    if (!row) {
      lookupFailures.hit(admin);
      if (lookupFailures.blocked(admin)) await audit(admin, 'events.reward_lookup_blocked', admin, null, { failures: 10 });
      return fail('code_not_found', 404);
    }
    return { redemption: await adminView(row) };
  }

  async function adminView(r) {
    const def = plain(await db('RewardDefinition').where({ id: r.rewardDefinitionId }).first());
    const user = r.userId ? plain(await db('User').where({ id: r.userId }).first('displayName')) : null;
    return { id: r.id, definitionId: r.rewardDefinitionId, title: def?.title ?? null, member: maskName(user?.displayName), status: r.status, expiresAt: iso(r.expiresAt), redeemedAt: iso(r.redeemedAt), needsReview: r.needsReview };
  }

  async function adminRedeem({ admin, id, body = {} }) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null;
    return db.transaction(async (trx) => {
      const r = plain(await trx('RewardRedemption').where({ id: String(id) }).forUpdate().first());
      if (!r) return fail('not_found', 404);
      if (r.status !== 'reserved') return fail('invalid_transition', 409, { from: r.status, to: 'redeemed' });
      if (r.expiresAt && +new Date(r.expiresAt) < +stamp()) { await expireIn(trx, r); return fail('redemption_expired', 409); }
      const at = stamp();
      await trx('RewardRedemption').where({ id: r.id }).update({ status: 'redeemed', redeemedAt: at, redeemedBy: admin, redeemedByRole: 'admin', adminNote: note, updatedAt: at });
      await audit(admin, 'events.reward_redeemed', r.id, { status: 'reserved' }, { note: Boolean(note) }, trx);
      return { redemption: await adminView({ ...r, status: 'redeemed', redeemedAt: at }) };
    });
  }

  async function adminCancel({ admin, id, body = {} }) {
    return db.transaction(async (trx) => {
      const r = plain(await trx('RewardRedemption').where({ id: String(id) }).forUpdate().first());
      if (!r) return fail('not_found', 404);
      if (r.status !== 'reserved') return fail('invalid_transition', 409, { from: r.status, to: 'cancelled' });
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rwd:${r.userId}:${r.rewardDefinitionId}`]);
      await cancelIn(trx, r, { reason: 'admin', adminNote: typeof body.note === 'string' ? body.note.trim().slice(0, 200) || null : null });
      await audit(admin, 'events.reward_cancelled', r.id, { status: 'reserved' }, { status: 'cancelled' }, trx);
      return { redemption: await adminView({ ...r, status: 'cancelled' }) };
    });
  }

  async function expireIn(trx, r) {
    await cancelIn(trx, r, { reason: 'expired', status: 'expired' });
  }

  async function adminLedger({ query = {} }) {
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('RewardLedgerEntry as l').leftJoin('User as u', 'u.id', 'l.userId');
    if (query.userId) q.where('l.userId', String(query.userId));
    if (query.definitionId) q.where('l.rewardDefinitionId', String(query.definitionId));
    if (query.entryType) q.where('l.entryType', String(query.entryType));
    if (cursor?.at) q.where(function k() { this.where('l.occurredAt', '<', new Date(cursor.at)).orWhere(function t() { this.where('l.occurredAt', new Date(cursor.at)).where('l.id', '<', cursor.id); }); });
    const rows = (await q.orderBy('l.occurredAt', 'desc').orderBy('l.id', 'desc').limit(limit + 1).select('l.*', 'u.displayName')).map(plain);
    const page = rows.slice(0, limit);
    return {
      items: page.map(r => ({ id: r.id, userId: r.userId, member: maskName(r.displayName), anonymised: r.userId === null, entryType: r.entryType, definitionId: r.rewardDefinitionId, units: r.points, sourceType: r.sourceType, reverses: r.reversesEntryId, occurredAt: iso(r.occurredAt) })),
      nextCursor: rows.length > limit ? encodeCursor({ at: page[page.length - 1].occurredAt, id: page[page.length - 1].id }) : null,
    };
  }

  async function adminSummary() {
    const rows = (await db('RewardLedgerEntry').whereNotNull('rewardDefinitionId').groupBy('rewardDefinitionId')
      .select('rewardDefinitionId')
      .select(db.raw(`count(*) FILTER (WHERE "entryType" = 'earn') AS earned`))
      .select(db.raw(`count(*) FILTER (WHERE "entryType" = 'redeem') AS redeemed`))
      .select(db.raw(`count(*) FILTER (WHERE "entryType" = 'expire') AS expired`))
      .select(db.raw(`count(*) FILTER (WHERE "entryType" = 'reverse' AND points < 0) AS reversed`))).map(plain);
    const review = new Map((await db('RewardRedemption').where({ needsReview: true }).groupBy('rewardDefinitionId').select('rewardDefinitionId').count({ n: '*' })).map(r => [r.rewardDefinitionId, Number(r.n)]));
    const used = new Map((await listDefinitions()).items.map(d => [d.id, d.capUsed]));
    const week = (await db('RewardLedgerEntry').where({ entryType: 'earn' }).where('occurredAt', '>', new Date(+stamp() - 7 * DAY)).whereNotNull('userId').groupBy('userId').select('userId').count({ n: '*' }).orderBy('n', 'desc').limit(10)).map(plain);
    return {
      items: rows.map(r => ({ definitionId: r.rewardDefinitionId, earned: Number(r.earned), redeemed: Number(r.redeemed), expired: Number(r.expired), reversed: Number(r.reversed), capUsed: used.get(r.rewardDefinitionId) ?? 0, needsReview: review.get(r.rewardDefinitionId) ?? 0 })),
      mostEarnedThisWeek: week.map(w => ({ userId: w.userId, count: Number(w.n) })),
    };
  }

  async function listTasks({ query = {} }) {
    const state = query.state ? String(query.state) : 'failed';
    if (!['pending', 'running', 'done', 'failed'].includes(state)) return fail('invalid_request', 400, { field: 'state' });
    const rows = (await db('EventAwardTask').where({ state }).orderBy('createdAt', 'desc').limit(200)).map(plain);
    return { items: rows.map(t => ({ id: t.id, eventId: t.eventId, registrationId: t.registrationId, reason: t.reason, state: t.state, attempts: t.attempts, lastError: t.lastError, createdAt: iso(t.createdAt) })) };
  }
  async function retryTask({ admin, id }) {
    const [row] = await db('EventAwardTask').where({ id: String(id), state: 'failed' }).update({ state: 'pending', attempts: 0, lastError: null, runAfter: stamp(), finishedAt: null }).returning('id');
    if (!row) return fail('not_found', 404);
    await audit(admin, 'events.award_task_retried', row.id, null, null);
    return { task: { id: row.id, state: 'pending' } };
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  /** Daily: expire the unspent units older than expiryDays (the newest units are the unspent ones: spending is first in, first out). */
  async function expireUnits() {
    const defs = (await db('RewardDefinition').whereNotNull('expiryDays').whereIn('status', ['active', 'paused', 'ended'])).map(plain);
    let expired = 0;
    for (const d of defs) {
      const users = (await db('RewardLedgerEntry').where({ rewardDefinitionId: d.id, entryType: 'earn' }).whereNotNull('userId').distinct('userId')).map(r => r.userId);
      for (const userId of users) {
        await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rwd:${userId}:${d.id}`]);
          const balance = await balanceIn(trx, userId, d.id);
          if (balance < 1) return;
          const live = (await liveEarns(trx, d.id, userId).whereNotExists(function done() { this.select(trx.raw('1')).from('RewardLedgerEntry as x').whereRaw(`x."idempotencyKey" = 'expire:' || e.id`); }).orderBy('e.occurredAt').select('e.*')).map(plain);
          const unspent = live.slice(Math.max(0, live.length - balance));
          for (const e of unspent) {
            if (+new Date(e.occurredAt) + d.expiryDays * DAY > +stamp()) continue;
            const at = stamp();
            const r = await trx('RewardLedgerEntry').insert({ id: newId('rle'), userId, rewardDefinitionId: d.id, entryType: 'expire', points: -1, sourceType: 'expiry', sourceId: e.id, idempotencyKey: `expire:${e.id}`, occurredAt: at, createdAt: at }).onConflict('idempotencyKey').ignore().returning('id');
            if (r.length) { expired += 1; await audit('system', 'events.reward_expired', d.id, null, { earnEntryId: e.id }, trx); }
          }
        });
      }
    }
    return { expired };
  }

  /** Reserved perks past expiresAt lapse and the unit returns. */
  async function expireReservations() {
    const due = (await db('RewardRedemption').where({ status: 'reserved' }).where('expiresAt', '<', stamp()).limit(500)).map(plain);
    let n = 0;
    for (const r of due) {
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rwd:${r.userId}:${r.rewardDefinitionId}`]);
        const fresh = plain(await trx('RewardRedemption').where({ id: r.id }).forUpdate().first());
        if (fresh.status === 'reserved') { await expireIn(trx, fresh); n += 1; }
      });
    }
    return { expiredReservations: n };
  }

  void sha256hex; void COPY; void notice;
  return {
    createDefinition, updateDefinition, activate, pause, end, listDefinitions, earnIn, reverseSourceIn, cancelIn, balanceIn, wallet, myLedger, claim, getRedemption,
    lookup, adminRedeem, adminCancel, adminLedger, adminSummary, listTasks, retryTask, expireUnits, expireReservations,
  };
}
