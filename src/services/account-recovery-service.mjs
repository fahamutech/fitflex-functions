// Identity V2 · account recovery for someone who has lost every verified
// number and email AND forgot the PIN. Design confirmed 5 Oct 2026
// (IDENTITY_V2_ACCOUNT_RECOVERY_DESIGN.md); this is the member path.
//
// The flow: ask (the new number or email is proved with a code) → announce
// (the old numbers and emails are told, with a link that cancels it) → prove
// (answers only the owner is likely to know) → wait (24 hours for a member)
// → a FitFlex admin decides → hand over (the new value becomes the sign-in,
// the old ones stop, the old PIN is removed, every session ends) and the
// person sets a PIN with Forgot PIN.
//
// Principles kept here:
//   - FitFlex decides, never an organisation
//   - the real owner can always stop it, and nothing is approved before the wait ends
//   - nobody at FitFlex sets a PIN or sees a code
//   - the same account, personas and history move; nothing is recreated
//   - not offered where the stakes or the proof differ: verified partners
//     (their path is not built; they go to FitFlex support), staff of an
//     organisation (the owner re-invites) and admins
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseIdentifier } from './identifier-service.mjs';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const PURPOSE = 'account_recovery';
const REQUEST_TOKEN = 'recovery_request';
const STAFF_TYPES = new Set(['gym_staff', 'vendor_staff', 'corporate_hr']);
const PARTNER_TYPES = ['trainer', 'gym_operator', 'vendor'];
/** What a member is asked: facts the owner is likely to know. */
export const EVIDENCE_KEYS = ['homeGym', 'plan', 'lastCheckin', 'paymentRef', 'other'];
export const REFUSAL_REASONS = ['evidence_insufficient', 'details_do_not_match', 'other'];

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Confirmed 5 Oct 2026 (wait: 24 hours for a member; block: 7 days); the address limit is the proposed default. */
export const recoveryLimits = () => ({
  waitHours: num('RECOVERY_WAIT_HOURS_MEMBER', 24),
  blockDays: num('RECOVERY_BLOCK_DAYS', 7),
  startsPerAddressPerDay: num('RECOVERY_STARTS_PER_ADDRESS_PER_DAY', 3),
});

const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tooMany = seconds => ({ error: 'too_many_attempts', status: 429, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });

export const maskIdentifier = (type, value) => {
  const v = String(value || '');
  if (type === 'email') {
    const [local = '', domain = ''] = v.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return v.length > 6 ? `${v.slice(0, 4)}${'•'.repeat(v.length - 7)}${v.slice(-3)}` : '••••';
};

const NOTICE = {
  announce: {
    subject: 'Someone asked to recover your FitFlex account / Kuna aliyeomba kurejesha akaunti yako ya FitFlex',
    text: (masked, url) => `FitFlex: someone asked to recover your account and move it to ${masked}. If this was NOT you, cancel it now: ${url} . If it was you, nothing more to do.\n`
      + `FitFlex: kuna mtu ameomba kurejesha akaunti yako na kuihamishia ${masked}. Kama SI wewe, ighairi sasa: ${url} . Kama ni wewe, hakuna unachohitaji kufanya.`,
  },
  done: {
    subject: 'Your FitFlex account was recovered / Akaunti yako ya FitFlex imerejeshwa',
    text: masked => `FitFlex: your account was recovered and moved to ${masked}. This number or email no longer signs in. If this was not you, contact FitFlex support.\n`
      + `FitFlex: akaunti yako imerejeshwa na kuhamishiwa ${masked}. Namba au barua pepe hii haitumiki tena kuingia. Kama si wewe, wasiliana na huduma ya FitFlex.`,
  },
};

export function createAccountRecoveryService({
  db, users, codes, identityLink, pinAuth, senders = null, signPurpose, verifyPurpose,
  partnerGate = null, linkingEnabled = () => false, auditLog = null,
  publicUrl = () => process.env.PUBLIC_API_URL || 'https://fitflex-faas.bfast.smartstock.co.tz',
}) {
  const newId = () => `arc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const event = (recoveryId, kind, actor = null, detail = null) => db('AccountRecoveryEvent')
    .insert({ id: `are_${randomUUID().replace(/-/g, '').slice(0, 12)}`, recoveryId, kind, actor, detail });
  const audit = (action, actor, target, after = null) => auditLog?.insertAsync({
    id: randomUUID(), at: new Date().toISOString(), actor, action, target, before: null, after,
  });

  // ── Who it is for ──────────────────────────────────────────────────────────

  /** The person who signs in with this identifier (or, for an email, the one Firebase account that still does). */
  async function locate(identifier) {
    const verified = await db('LoginIdentifier')
      .join('Person', 'Person.id', 'LoginIdentifier.personId')
      .where({ 'LoginIdentifier.type': identifier.type, 'LoginIdentifier.normalizedValue': identifier.value, 'LoginIdentifier.status': 'active' })
      .whereNotNull('LoginIdentifier.verifiedAt').first('Person.id as id', 'Person.status as status');
    if (verified) return verified.status === 'active' ? { personId: verified.id } : null;
    if (identifier.type !== 'email') return null;
    const rows = (await db('User').whereRaw('lower(btrim(email)) = ?', [identifier.value]).whereNotNull('firebaseUid').whereNotNull('personId'))
      .filter(u => u.accountStatus !== 'closed');
    const ids = [...new Set(rows.map(u => u.personId))];
    if (ids.length !== 1) return null;
    const person = await db('Person').where({ id: ids[0] }).first('id', 'status');
    return person?.status === 'active' ? { personId: person.id } : null;
  }

  const personas = personId => db('User').where({ personId }).whereNot({ accountStatus: 'closed' });

  /** Whether this kind of account can use assisted recovery. */
  async function eligibility(personId) {
    const rows = await personas(personId);
    if (!rows.length) return { error: 'account_not_found', status: 404 };
    if (rows.some(r => r.userType === 'admin' || r.portalUser)) return { error: 'recovery_not_available', status: 409 };
    if (rows.every(r => STAFF_TYPES.has(r.userType))) return { error: 'staff_recovery_not_available', status: 409 };
    const partners = rows.filter(r => PARTNER_TYPES.includes(r.userType)).map(r => r.id);
    if (partners.length && partnerGate && (await partnerGate.verifiedUserIds(partners)).size) {
      return { error: 'partner_recovery_not_available', status: 409 };
    }
    return { ok: true };
  }

  /** Someone else signs in with this value (or, for an email, through Firebase). */
  async function takenByAnother(personId, identifier) {
    const owner = await db('LoginIdentifier')
      .where({ type: identifier.type, normalizedValue: identifier.value, status: 'active' })
      .whereNotNull('verifiedAt').whereNot({ personId }).first('id');
    if (owner) return true;
    if (identifier.type !== 'email') return false;
    const rows = await db('User').whereRaw('lower(btrim(email)) = ?', [identifier.value])
      .whereNotNull('firebaseUid').whereNot({ accountStatus: 'closed' }).select('personId');
    return rows.some(r => r.personId !== personId);
  }

  /** The checks both steps share, in order. Returns { personId } or an error. */
  function gate(body, { needsNew = true } = {}) {
    const old = parseIdentifier(body.old || {});
    const next = parseIdentifier(body.new || {});
    if (!old || (needsNew && !next)) return { error: 'old_and_new_identifier_required', status: 400 };
    if (next && old.type === next.type && old.value === next.value) return { error: 'identifier_unchanged', status: 400 };
    return { old, next };
  }
  async function eligibleRequest(old, next) {
    const target = await locate(old);
    if (!target) return { error: 'account_not_found', status: 404 };
    const ok = await eligibility(target.personId);
    if (ok.error) return ok;
    if (await db('AccountRecovery').where({ personId: target.personId, status: 'open' }).first('id')) {
      return { error: 'recovery_already_open', status: 409 };
    }
    // A cancelled or refused request blocks the next one for a while.
    const block = recoveryLimits().blockDays * 86400e3;
    const last = await db('AccountRecovery').where({ personId: target.personId }).whereIn('status', ['cancelled', 'refused'])
      .orderBy('updatedAt', 'desc').first('updatedAt');
    if (last && Date.now() - +new Date(last.updatedAt) < block) {
      return { error: 'recovery_blocked', status: 429, retryAfterSeconds: Math.ceil((block - (Date.now() - +new Date(last.updatedAt))) / 1000) };
    }
    if (await takenByAnother(target.personId, next)) return { error: 'identifier_in_use', status: 409 };
    return { personId: target.personId };
  }

  // ── Ask ────────────────────────────────────────────────────────────────────

  /** Step 1: the old number or email they signed in with, and a NEW one, which gets a code. */
  async function start({ body = {}, ip = null }) {
    const parsed = await gate(body);
    if (parsed.error) return parsed;
    const { old, next } = parsed;
    if (ip) {
      const recent = Number((await db('AuthAttempt').where({ kind: 'recovery_start', ip })
        .where('createdAt', '>', new Date(Date.now() - 86400e3)).count({ n: '*' }).first()).n);
      if (recent >= recoveryLimits().startsPerAddressPerDay) return tooMany(86400);
    }
    await db('AuthAttempt').insert({
      id: `aat_${randomUUID().replace(/-/g, '').slice(0, 12)}`, kind: 'recovery_start',
      identifierHash: sha256(`${old.type}:${old.value}`), ip: ip || null, outcome: 'ok',
    });
    const checked = await eligibleRequest(old, next);
    if (checked.error) return checked;
    return codes.sendCode({ purpose: PURPOSE, personId: checked.personId, identifier: next, locale: body.locale });
  }

  /** Step 2: the code proves the new value. The request is recorded and the owner is told. */
  async function confirm({ body = {}, ip = null }) {
    const parsed = await gate(body);
    if (parsed.error) return parsed;
    const { old, next } = parsed;
    const name = String(body.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return { error: 'name_required', status: 400 };
    const checked = await eligibleRequest(old, next);
    if (checked.error) return checked;
    const consumed = await codes.consumeCode({ purpose: PURPOSE, personId: checked.personId, identifier: next, code: body.code });
    if (consumed.error) return consumed;

    const limits = recoveryLimits();
    const id = newId();
    const cancelKey = randomBytes(9).toString('base64url');
    const waitUntil = new Date(Date.now() + limits.waitHours * 3600e3);
    try {
      await db('AccountRecovery').insert({
        id, personId: checked.personId, tier: 'member',
        oldIdentifierType: old.type, oldIdentifierValue: old.value,
        newIdentifierType: next.type, newIdentifierValue: next.value,
        claimedName: name, waitUntil, cancelKeyHash: sha256(cancelKey), requestIp: ip || null,
      });
    } catch (err) {
      if (err?.code === '23505') return { error: 'recovery_already_open', status: 409 };
      throw err;
    }
    await event(id, 'requested', null, { waitUntil, newIdentifierType: next.type });
    await audit('recovery_requested', null, checked.personId, { id });
    await announce(checked.personId, next, `${publicUrl()}/auth/recovery/cancel/${id}.${cancelKey}`);
    return {
      requested: true, status: 'open', waitUntil, waitHours: limits.waitHours,
      requestToken: signPurpose(REQUEST_TOKEN, { rid: id }, '30d'),
      questions: EVIDENCE_KEYS,
    };
  }

  /** Tell every number and email this account has that someone asked, and how to stop it. */
  async function announce(personId, next, cancelUrl) {
    if (!senders) return;
    const targets = new Map();
    const rows = await db('LoginIdentifier').where({ personId, status: 'active' }).whereIn('type', ['email', 'phone']).select('type', 'normalizedValue');
    for (const r of rows) targets.set(`${r.type}:${r.normalizedValue}`, { type: r.type, value: r.normalizedValue });
    for (const p of await personas(personId)) {
      for (const [type, value] of [['email', normalizeEmail(p.email)], ['phone', normalizePhone(p.phone)]]) {
        if (value) targets.set(`${type}:${value}`, { type, value });
      }
    }
    targets.delete(`${next.type}:${next.value}`);
    await tell([...targets.values()], NOTICE.announce.subject, NOTICE.announce.text(maskIdentifier(next.type, next.value), cancelUrl));
  }

  async function tell(targets, subject, text) {
    if (!senders) return;
    for (const target of targets) {
      const sender = target.type === 'phone' ? senders.sms() : senders.email();
      if (!sender.configured) continue;
      try {
        await sender.send(target.value, { text, subject });
      } catch (err) {
        console.warn('[recovery] notice skipped:', err?.message);
      }
    }
  }

  // ── Prove, and watch ───────────────────────────────────────────────────────

  async function byToken(token) {
    const claims = verifyPurpose(token, REQUEST_TOKEN);
    return claims ? db('AccountRecovery').where({ id: claims.rid }).first() : null;
  }

  /** What the requester sees: where it stands, never what staff noted. */
  const publicView = row => ({
    status: row.status,
    waitUntil: row.waitUntil,
    ready: row.status === 'open' && Date.now() >= +new Date(row.waitUntil),
    answered: EVIDENCE_KEYS.filter(k => row.evidence?.[k]),
    ...(row.status === 'refused' ? {
      reason: row.decisionReason,
      retryAfter: new Date(+new Date(row.decidedAt) + recoveryLimits().blockDays * 86400e3),
    } : {}),
    ...(row.status === 'completed' ? {
      next: 'forgot_pin',
      identifierType: row.newIdentifierType, identifierValue: row.newIdentifierValue,
    } : {}),
  });

  async function status({ body = {} }) {
    const row = await byToken(body.requestToken);
    return row ? publicView(row) : { error: 'request_token_invalid', status: 401 };
  }

  /** Answers to the proof questions. Added while the request is open; each is short text. */
  async function addEvidence({ body = {} }) {
    const row = await byToken(body.requestToken);
    if (!row) return { error: 'request_token_invalid', status: 401 };
    if (row.status !== 'open') return { error: 'recovery_not_open', status: 409 };
    const answers = {};
    for (const key of EVIDENCE_KEYS) {
      const value = String(body.answers?.[key] ?? '').trim().slice(0, 300);
      if (value) answers[key] = value;
    }
    if (!Object.keys(answers).length) return { error: 'evidence_required', status: 400 };
    const evidence = { ...(row.evidence || {}), ...answers };
    await db('AccountRecovery').where({ id: row.id }).update({ evidence: JSON.stringify(evidence), updatedAt: db.fn.now() });
    await event(row.id, 'evidence_added', null, { keys: Object.keys(answers) });
    return publicView({ ...row, evidence });
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  async function cancelRow(row, by) {
    if (row.status !== 'open') return { cancelled: false, status: row.status };
    const done = await db('AccountRecovery').where({ id: row.id, status: 'open' })
      .update({ status: 'cancelled', cancelledBy: by, updatedAt: db.fn.now() });
    if (!done) return { cancelled: false, status: 'closed' };
    await event(row.id, 'cancelled', null, { by });
    await audit('recovery_cancelled', null, row.personId, { id: row.id, by });
    return { cancelled: true, status: 'cancelled' };
  }

  /** The person who asked changes their mind. */
  async function cancelAsRequester({ body = {} }) {
    const row = await byToken(body.requestToken);
    return row ? cancelRow(row, 'requester') : { error: 'request_token_invalid', status: 401 };
  }

  /** The owner, from the link in the message they were sent. */
  async function cancelWithLink(link) {
    const [id, key] = String(link || '').split('.');
    const row = id && key ? await db('AccountRecovery').where({ id }).first() : null;
    if (!row || !row.cancelKeyHash || !same(sha256(key), row.cancelKeyHash)) return { error: 'cancel_link_invalid', status: 404 };
    return cancelRow(row, 'owner_link');
  }

  /** The owner, from a device that is still signed in. */
  async function mine({ user }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const row = await db('AccountRecovery').where({ personId: user.personId, status: 'open' }).first();
    if (!row) return { open: false };
    return {
      open: true, id: row.id, requestedAt: row.createdAt, waitUntil: row.waitUntil,
      newIdentifierType: row.newIdentifierType, newIdentifier: maskIdentifier(row.newIdentifierType, row.newIdentifierValue),
    };
  }
  async function cancelAsOwner({ user }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const row = await db('AccountRecovery').where({ personId: user.personId, status: 'open' }).first();
    return row ? cancelRow(row, 'owner_device') : { cancelled: false, status: 'none' };
  }

  // ── FitFlex admin ──────────────────────────────────────────────────────────

  async function list({ status: wanted = 'open' } = {}) {
    const q = db('AccountRecovery').orderBy('createdAt', 'desc').limit(200);
    if (wanted !== 'all') q.where({ status: wanted });
    const rows = await q;
    const names = new Map();
    for (const r of rows) {
      const first = await db('User').where({ personId: r.personId }).orderBy('createdAt').first('displayName');
      names.set(r.id, first?.displayName || null);
    }
    return {
      recoveries: rows.map(r => ({
        id: r.id, status: r.status, tier: r.tier, claimedName: r.claimedName, accountName: names.get(r.id),
        newIdentifierType: r.newIdentifierType, createdAt: r.createdAt, waitUntil: r.waitUntil,
        ready: r.status === 'open' && Date.now() >= +new Date(r.waitUntil),
        answered: EVIDENCE_KEYS.filter(k => r.evidence?.[k]).length,
      })),
    };
  }

  /** What an admin compares the answers against: facts about the account, nothing sensitive. */
  async function accountFacts(personId) {
    const rows = await personas(personId);
    const ids = rows.map(r => r.id);
    const gymName = async gymId => (gymId ? (await db('Gym').where({ id: gymId }).first('name'))?.name || gymId : null);
    const sub = await db('Subscription').whereIn('memberId', ids).orderBy('createdAt', 'desc').first();
    const checkins = await db('Checkin').whereIn('memberId', ids).orderBy('timestamp', 'desc').limit(5);
    const payments = await db('PaymentRequest').whereIn('memberId', ids).orderBy('requestedAt', 'desc').limit(5);
    const idents = await db('LoginIdentifier').where({ personId }).whereIn('type', ['email', 'phone']).orderBy('createdAt');
    return {
      registeredAt: rows.map(r => r.createdAt).filter(Boolean).sort()[0] || null,
      personas: rows.map(r => ({ id: r.id, userType: r.userType, displayName: r.displayName, approvalStatus: r.approvalStatus })),
      subscription: sub ? {
        type: sub.type, tier: sub.tier, status: sub.status, startedAt: sub.startedAt, expiresAt: sub.expiresAt,
        homeGym: await gymName(sub.homeGymId), paymentRef: sub.paymentRef,
      } : null,
      lastCheckins: await Promise.all(checkins.map(async c => ({ at: c.timestamp, gym: await gymName(c.gymId) }))),
      payments: payments.map(p => ({ reference: p.reference, amountTzs: p.amountTzs, status: p.status, at: p.requestedAt })),
      identifiers: idents.map(i => ({ type: i.type, masked: maskIdentifier(i.type, i.normalizedValue), status: i.status, verified: Boolean(i.verifiedAt) })),
    };
  }

  async function detail({ id, actorId }) {
    const row = await db('AccountRecovery').where({ id }).first();
    if (!row) return { error: 'not_found', status: 404 };
    await event(id, 'viewed', actorId);
    await audit('recovery_viewed', actorId, row.personId, { id });
    const events = await db('AccountRecoveryEvent').where({ recoveryId: id }).orderBy('createdAt').select('kind', 'actor', 'detail', 'createdAt');
    return {
      recovery: {
        id: row.id, status: row.status, tier: row.tier, claimedName: row.claimedName,
        oldIdentifier: { type: row.oldIdentifierType, masked: maskIdentifier(row.oldIdentifierType, row.oldIdentifierValue) },
        newIdentifier: { type: row.newIdentifierType, value: row.newIdentifierValue },
        evidence: row.evidence || {}, createdAt: row.createdAt, waitUntil: row.waitUntil,
        ready: row.status === 'open' && Date.now() >= +new Date(row.waitUntil),
        cancelledBy: row.cancelledBy, decisionReason: row.decisionReason, decisionNote: row.decisionNote,
        decidedBy: row.decidedBy, decidedAt: row.decidedAt, requestIp: row.requestIp,
      },
      account: await accountFacts(row.personId),
      events,
    };
  }

  async function addNote({ id, note, actorId }) {
    const text = String(note ?? '').trim().slice(0, 1000);
    if (!text) return { error: 'note_required', status: 400 };
    const row = await db('AccountRecovery').where({ id }).first('id');
    if (!row) return { error: 'not_found', status: 404 };
    await event(id, 'note', actorId, { note: text });
    return { added: true };
  }

  /** approve (once the wait is over) or refuse; staff never see or set a PIN. */
  async function decide({ id, decision, reason, note, actorId }) {
    const row = await db('AccountRecovery').where({ id }).first();
    if (!row) return { error: 'not_found', status: 404 };
    if (row.status !== 'open') return { error: 'recovery_not_open', status: 409 };
    const actor = await users.findByIdAsync(actorId);
    if (actor?.personId && actor.personId === row.personId) return { error: 'cannot_decide_own_recovery', status: 403 };
    const privateNote = String(note ?? '').trim().slice(0, 1000) || null;

    if (decision === 'refuse') {
      if (!REFUSAL_REASONS.includes(reason)) return { error: 'reason_required', status: 400, reasons: REFUSAL_REASONS };
      await db('AccountRecovery').where({ id, status: 'open' }).update({
        status: 'refused', decidedBy: actorId, decidedAt: db.fn.now(), decisionReason: reason, decisionNote: privateNote, updatedAt: db.fn.now(),
      });
      await event(id, 'refused', actorId, { reason });
      await audit('recovery_refused', actorId, row.personId, { id, reason });
      return { status: 'refused' };
    }
    if (decision !== 'approve') return { error: 'decision_invalid', status: 400 };

    // The wait is a safety margin: however good the evidence, not before it ends.
    if (Date.now() < +new Date(row.waitUntil)) return { error: 'waiting_period_not_over', status: 409, canDecideAt: row.waitUntil };
    if (!Object.keys(row.evidence || {}).length) return { error: 'evidence_missing', status: 409 };
    const ok = await eligibility(row.personId);
    if (ok.error) return ok;
    const next = { type: row.newIdentifierType, value: row.newIdentifierValue };
    if (await takenByAnother(row.personId, next)) return { error: 'identifier_in_use', status: 409 };

    const handed = await handOver(row, next, actorId);
    if (handed.error) return handed;
    await db('AccountRecovery').where({ id, status: 'open' }).update({
      status: 'completed', decidedBy: actorId, decidedAt: db.fn.now(), completedAt: db.fn.now(),
      decisionReason: 'approved', decisionNote: privateNote, updatedAt: db.fn.now(),
    });
    await event(id, 'completed', actorId);
    await audit('recovery_approved', actorId, row.personId, { id, identifierType: next.type });
    return { status: 'completed' };
  }

  /**
   * The new value becomes the sign-in; every other number and email stops; the
   * old PIN is removed so the person sets their own with Forgot PIN; every
   * session ends. The same personas and history stay.
   */
  async function handOver(row, next, actorId) {
    const personId = row.personId;
    const anchor = await db('User').where({ personId }).whereNot({ accountStatus: 'closed' }).orderBy('createdAt').first('id');
    if (!anchor) return { error: 'account_not_found', status: 404 };
    const oldTargets = [];
    const prior = await db('LoginIdentifier').where({ personId, status: 'active' }).whereIn('type', ['email', 'phone']).select('id', 'type', 'normalizedValue');
    for (const p of await personas(personId)) {
      for (const [type, value] of [['email', normalizeEmail(p.email)], ['phone', normalizePhone(p.phone)]]) {
        if (value && !(type === next.type && value === next.value)) oldTargets.push({ type, value });
      }
    }

    const linked = await identityLink.linkOnVerifiedSignIn({
      anchorUserId: anchor.id, uid: null,
      email: next.type === 'email' ? next.value : null, phone: next.type === 'phone' ? next.value : null,
      provider: 'fitflex_recovery', trigger: 'account_recovery', attachOnly: !linkingEnabled(),
    });
    if (linked.conflicts.some(c => c.kind === 'verified_identifier_collision' && c.identifierType === next.type)) {
      return { error: 'identifier_in_use', status: 409 };
    }

    const revoke = prior.filter(p => !(p.type === next.type && p.normalizedValue === next.value));
    for (const p of revoke) oldTargets.push({ type: p.type, value: p.normalizedValue });
    if (revoke.length) {
      await db('LoginIdentifier').whereIn('id', revoke.map(p => p.id)).update({ status: 'revoked', updatedAt: db.fn.now() });
    }
    // The copies shown on the profiles follow. A clash on another profile of the same role leaves that copy as it was.
    for (const persona of await personas(personId)) {
      try {
        await users.updateByIdAsync(persona.id, { [next.type]: next.value, updatedAt: new Date().toISOString() });
      } catch (err) {
        if (err?.code !== '23505') throw err;
      }
    }
    await db('Person').where({ id: personId }).update({
      pinHash: null, pinSetAt: null, pinFailedCount: 0, pinLockedUntil: null, updatedAt: db.fn.now(),
    });
    await pinAuth.endSessions(personId);

    const seen = new Set();
    const told = oldTargets.filter(t => !seen.has(`${t.type}:${t.value}`) && seen.add(`${t.type}:${t.value}`));
    await tell([...told, next], NOTICE.done.subject, NOTICE.done.text(maskIdentifier(next.type, next.value)));
    return { ok: true, actorId };
  }

  return {
    start, confirm, addEvidence, status, cancelAsRequester, cancelWithLink, mine, cancelAsOwner,
    list, detail, addNote, decide,
  };
}
