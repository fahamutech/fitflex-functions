// Identity V2 · I6 (slice A) — invitations for gym staff and trainers.
//
// An organisation never creates an account or sets credentials for someone.
// It looks a person up by an exact phone or email, and invites: a known
// Person directly, or the identifier itself, which the person claims once
// they have verified it. Accepting needs a signed-in session that owns the
// target — the invitation token only opens the invitation, it grants nothing.
//
// What acceptance does today (the legacy structures still decide authority
// until I5 is enforced, and OrgMembership follows them through the I4 sync):
//   gym staff    a gym_staff persona for that Person, scoped to the gym, with
//                the invitation's ACL
//   gym trainer  the gym is added to the Person's existing trainer profile
//   gym member   a direct plan at the gym for the Person's member persona.
//                A desk payment rides on the invitation; the plan is created
//                only on acceptance and starts on the payment date (O2). If a
//                paid invitation expires unaccepted it is held for the gym to
//                re-issue or refund — nothing is refunded automatically.
//   vendor staff (slice C) a vendor_staff persona for that Person at the
//                inviting vendor, with the invitation's role and permissions.
//                Only the vendor (owner) invites.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const OPEN = ['pending', 'claimed'];
const INVITABLE_ROLES = { gym: ['staff', 'trainer', 'member'], vendor: ['staff'] };
// The persona type that owns each kind of organisation.
const OWNER_TYPE = { gym: 'gym_operator', vendor: 'vendor' };
// Staff and trainers are the owner's to invite; staff with the members scope may invite members.
const OWNER_ONLY_ROLES = ['staff', 'trainer'];
const toDate = v => { const d = new Date(v); return Number.isNaN(+d) ? null : d; };
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Limits approved 1 Oct 2026; each can be overridden by env. */
export const invitationLimits = () => ({
  expiryDays: num('INVITE_EXPIRY_DAYS', 14),
  maxResends: num('INVITE_MAX_RESENDS', 3),
  resendIntervalHours: num('INVITE_RESEND_INTERVAL_HOURS', 24),
  lookupsPerActorPerHour: num('LOOKUP_PER_ACTOR_PER_HOUR', 30),
  lookupsPerOrgPerDay: num('LOOKUP_PER_ORG_PER_DAY', 200),
  missesBeforeCooldown: num('LOOKUP_MISSES_BEFORE_COOLDOWN', 10),
  cooldownMinutes: num('LOOKUP_COOLDOWN_MINUTES', 15),
});

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const id = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** { type, value } for exactly one phone or email, or null. */
function parseIdentifier({ email, phone } = {}) {
  if (email && phone) return null;
  if (email) {
    const value = normalizeEmail(email);
    return value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? { type: 'email', value } : null;
  }
  if (phone) {
    const value = normalizePhone(phone);
    return value ? { type: 'phone', value } : null;
  }
  return null;
}

/** "Neema Abdallah" → "N**** A*******": enough to confirm, not to identify. */
export function maskName(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean)
    .map(part => part[0].toUpperCase() + '*'.repeat(Math.max(part.length - 1, 1))).join(' ') || null;
}

export function createInvitationService({
  db, users, trainers, notify = null, auditLog = null, ownerStaffAclScopes = [],
  activateDirectMembership = null, createPersona = null,
  vendorStaffRoles = [], vendorStaffPermissions = [], ensureVendor = null,
  // Telling the invited person directly, and the start PIN for someone new
  // to FitFlex (agreed 3 Oct 2026). All optional: without them an invitation
  // behaves as before (the organisation shares the link).
  senders = null, startPin = null, isRegistered = null, appLink = () => null, newTrainerProfile = null,
}) {
  const gymOf = gymId => (gymId ? db('Gym').where({ id: gymId }).first('id', 'name') : null);
  // An invitation or membership points at its organisation through gymId or vendorId.
  const orgRef = (orgType, orgId) => ({ orgType, [orgType === 'vendor' ? 'vendorId' : 'gymId']: orgId });
  const orgIdOf = inv => inv.gymId ?? inv.vendorId;
  const orgOf = inv => (inv.orgType === 'vendor'
    ? db('Vendor').where({ id: inv.vendorId }).first('id', 'name')
    : gymOf(inv.gymId));
  const isOwner = (actor, orgType) => actor.userType === OWNER_TYPE[orgType];
  const audit = async (actor, action, target, after) => {
    if (!auditLog) return;
    await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor, action, target, before: null, after });
  };
  const view = (inv, extra = {}) => ({
    id: inv.id, orgType: inv.orgType, orgId: orgIdOf(inv), role: inv.role, status: inv.status,
    identifierType: inv.identifierType, aclPermissions: inv.aclPermissions || [], message: inv.message ?? null,
    expiresAt: inv.expiresAt, createdAt: inv.createdAt, respondedAt: inv.respondedAt ?? null,
    ...(inv.payload?.plan ? { plan: inv.payload.plan, paidAmountTzs: inv.payload.payment?.amountTzs ?? null } : {}),
    ...(inv.payload?.vendorRole ? { vendorRole: inv.payload.vendorRole } : {}),
    ...extra,
  });
  /** A paid invitation that lapsed unaccepted, not yet re-issued or refunded by the gym. */
  const needsResolution = inv => inv.status === 'expired' && Boolean(inv.payload?.payment) && !inv.payload?.resolution;
  const canManage = (actor, inv) => isOwner(actor, inv.orgType) || inv.role === 'member';

  /** Validated plan + desk payment for a member invitation, or { error }. */
  function memberPayload(body) {
    const { durationUnit, startDate, endDate, tier, paidAmount } = body || {};
    if (!['D', 'W', 'M'].includes(durationUnit)) return { error: 'durationUnit_must_be_D_W_or_M', status: 400 };
    const start = toDate(startDate);
    const end = toDate(endDate);
    if (!start || !end) return { error: 'startDate_and_endDate_required', status: 400 };
    if (+end <= +start) return { error: 'endDate_must_follow_startDate', status: 400 };
    const amount = Number(paidAmount) > 0 ? Number(paidAmount) : 0;
    return {
      payload: {
        plan: { tier: tier || 'basic', durationUnit, startDate: start.toISOString(), endDate: end.toISOString() },
        // The plan runs from the day it was paid for, whenever it is accepted.
        ...(amount ? { payment: { amountTzs: amount, paidAt: start.toISOString() } } : {}),
      },
    };
  }

  /** A vendor staff invitation carries the staff role and its permissions, as the legacy form did. */
  function vendorStaffAccess(body) {
    const vendorRole = String(body?.vendorRole || '');
    if (!vendorStaffRoles.includes(vendorRole)) return { error: 'invalid_staff_role', status: 400, allowed: vendorStaffRoles };
    const permissions = vendorRole === 'admin'
      ? [...vendorStaffPermissions]
      : [...new Set(Array.isArray(body.permissions) ? body.permissions : [])];
    const invalid = permissions.filter(p => !vendorStaffPermissions.includes(p));
    if (invalid.length) return { error: 'invalid_staff_permissions', status: 400, invalid };
    return { payload: { vendorRole }, aclPermissions: permissions };
  }

  /** Verified, live owner of an exact identifier, if any. */
  async function verifiedPerson(identifier) {
    const row = await db('LoginIdentifier')
      .join('Person', 'Person.id', 'LoginIdentifier.personId')
      .where({ 'LoginIdentifier.type': identifier.type, 'LoginIdentifier.normalizedValue': identifier.value, 'LoginIdentifier.status': 'active', 'Person.status': 'active' })
      .whereNotNull('LoginIdentifier.verifiedAt')
      .first('Person.id as personId');
    return row?.personId ?? null;
  }

  async function expireDue() {
    await db('Invitation').whereIn('status', OPEN).where('expiresAt', '<', db.fn.now())
      .update({ status: 'expired', updatedAt: db.fn.now() });
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  async function lookupBlocked(actorId, orgType, orgId) {
    const limits = invitationLimits();
    const hourAgo = new Date(Date.now() - 3600e3);
    const dayAgo = new Date(Date.now() - 86400e3);
    const perActor = Number((await db('OrgLookupLog').where({ actorUserId: actorId }).where('createdAt', '>', hourAgo).count({ n: '*' }).first()).n);
    if (perActor >= limits.lookupsPerActorPerHour) return 'lookup_rate_limited';
    const perOrg = Number((await db('OrgLookupLog').where({ orgType, orgId }).where('createdAt', '>', dayAgo).count({ n: '*' }).first()).n);
    if (perOrg >= limits.lookupsPerOrgPerDay) return 'lookup_rate_limited';
    const recent = await db('OrgLookupLog').where({ actorUserId: actorId })
      .orderBy('createdAt', 'desc').limit(limits.missesBeforeCooldown).select('found', 'createdAt');
    if (recent.length === limits.missesBeforeCooldown && recent.every(r => !r.found)
        && Date.now() - +new Date(recent[0].createdAt) < limits.cooldownMinutes * 60e3) {
      return 'lookup_cooldown';
    }
    return null;
  }

  /**
   * Does this exact phone or email belong to a FitFlex person? Answers only
   * { found, maskedName }, and only for a verified identifier: an unverified
   * match looks exactly like no match.
   */
  async function lookup({ actor, orgType, orgId, body }) {
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const blocked = await lookupBlocked(actor.id, orgType, orgId);
    if (blocked) return { error: blocked, status: 429 };
    const personId = await verifiedPerson(identifier);
    await db('OrgLookupLog').insert({
      id: id('olk'), actorUserId: actor.id, orgType, orgId,
      identifierType: identifier.type, identifierHash: sha256(identifier.value), found: Boolean(personId),
    });
    if (!personId) return { found: false, maskedName: null };
    const persona = await db('User').where({ personId }).whereNotNull('displayName').orderBy('createdAt').first('displayName');
    return { found: true, maskedName: maskName(persona?.displayName) };
  }

  // ── Organisation side ────────────────────────────────────────────────────

  async function create({ actor, orgType, orgId, body = {} }) {
    const role = String(body.role || '');
    if (!INVITABLE_ROLES[orgType]?.includes(role)) {
      return { error: 'role_not_invitable', status: 400, allowed: INVITABLE_ROLES[orgType] || [] };
    }
    if (OWNER_ONLY_ROLES.includes(role) && !isOwner(actor, orgType)) return { error: 'owner_only', status: 403 };
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const extra = orgType === 'vendor' ? vendorStaffAccess(body)
      : role === 'member' ? memberPayload(body) : { payload: null };
    if (extra.error) return extra;
    const aclPermissions = extra.aclPermissions ?? (role === 'staff' ? [...new Set(body.aclPermissions || [])] : []);
    if (orgType === 'gym') {
      const invalid = aclPermissions.filter(p => !ownerStaffAclScopes.includes(p));
      if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };
    } else {
      // The vendor's organisation record (I4) must exist before anything can point at it.
      if (ensureVendor) await ensureVendor(orgId);
      if (!(await db('Vendor').where({ id: orgId }).first('id'))) return { error: 'organisation_not_found', status: 409 };
    }

    await expireDue();
    const targetPersonId = await verifiedPerson(identifier);
    if (targetPersonId) {
      const member = await db('OrgMembership')
        .where({ personId: targetPersonId, ...orgRef(orgType, orgId), role }).whereIn('status', ['active', 'suspended']).first('id');
      if (member) return { error: 'already_a_member', status: 409 };
      if (role === 'staff') {
        const owner = await db('OrgMembership')
          .where({ personId: targetPersonId, ...orgRef(orgType, orgId), role: 'owner', status: 'active' }).first('id');
        if (owner) return { error: 'already_owner', status: 409 };
      }
    }
    const open = await db('Invitation')
      .where({ ...orgRef(orgType, orgId), role, identifierType: identifier.type, identifierValue: identifier.value })
      .whereIn('status', OPEN).first();
    if (open) return { created: false, invitation: view(open) };

    const token = newToken();
    const row = {
      id: id('inv'), gymId: null, vendorId: null, ...orgRef(orgType, orgId), role, targetPersonId,
      identifierType: identifier.type, identifierValue: identifier.value, tokenHash: sha256(token),
      status: 'pending', requiresAcceptance: true, aclPermissions,
      payload: extra.payload ? JSON.stringify(extra.payload) : null,
      message: body.message ? String(body.message).slice(0, 500) : null, invitedBy: actor.id,
      expiresAt: new Date(Date.now() + invitationLimits().expiryDays * 86400e3),
    };
    await db('Invitation').insert(row);
    await audit(actor.id, 'invitation_created', row.id, { orgType, orgId, role, identifierType: identifier.type, knownPerson: Boolean(targetPersonId) });
    await tellPerson(row);
    const delivery = await deliver(row, body.locale);
    // The token is returned once so the organisation can share the link. It
    // only opens the invitation; accepting needs the invited person's own session.
    return { created: true, invitation: view(await db('Invitation').where({ id: row.id }).first()), token, delivery };
  }

  const DELIVERED_ROLES = ['staff', 'trainer'];
  const ROLE_WORDS = {
    en: { staff: 'staff', trainer: 'a trainer' },
    sw: { staff: 'mfanyakazi', trainer: 'trainer' },
  };
  const INVITE_TEXT = {
    en: {
      subject: 'You are invited on FitFlex',
      fresh: (org, role, link, pin, how) => `FitFlex: ${org} invited you to join as ${role}. Get the app: ${link} Sign in with this ${how} and start PIN ${pin}. You will then choose your own PIN.`,
      known: (org, role, link) => `FitFlex: ${org} invited you to join as ${role}. Open the FitFlex app to accept: ${link}`,
      how: { phone: 'number', email: 'email' },
    },
    sw: {
      subject: 'Umealikwa kwenye FitFlex',
      fresh: (org, role, link, pin, how) => `FitFlex: ${org} imekualika kujiunga kama ${role}. Pata app: ${link} Ingia kwa ${how} hii na PIN ya kuanzia ${pin}. Kisha utachagua PIN yako mwenyewe.`,
      known: (org, role, link) => `FitFlex: ${org} imekualika kujiunga kama ${role}. Fungua app ya FitFlex ili ukubali: ${link}`,
      how: { phone: 'namba', email: 'barua pepe' },
    },
  };

  /**
   * Tell the invited staff member or trainer directly, by SMS or email.
   * Someone new to FitFlex also gets a four-digit start PIN to sign in with
   * once; someone who already has an account gets the notice only. The
   * organisation never sees the PIN. Best effort: with no provider configured
   * nothing is sent and the organisation shares the link as before.
   */
  async function deliver(inv, locale) {
    if (!senders || !DELIVERED_ROLES.includes(inv.role)) return { sent: false };
    const channel = inv.identifierType === 'phone' ? 'sms' : 'email';
    const sender = inv.identifierType === 'phone' ? senders.sms() : senders.email();
    if (!sender.configured) return { sent: false, reason: `${channel}_not_configured` };
    try {
      const identifier = { type: inv.identifierType, value: inv.identifierValue };
      const fresh = Boolean(startPin?.enabled()) && !inv.targetPersonId
        && !(isRegistered && await isRegistered(identifier));
      const lang = locale === 'sw' ? 'sw' : 'en';
      const text = INVITE_TEXT[lang];
      const org = (await orgOf(inv))?.name || 'FitFlex';
      const role = ROLE_WORDS[lang][inv.role];
      const link = appLink() || '';
      let body;
      if (fresh) {
        const pin = String(randomInt(0, 10000)).padStart(4, '0');
        await db('Invitation').where({ id: inv.id }).update({
          startPinHash: startPin.hash(inv.id, pin), startPinAttempts: 0, startPinUsedAt: null, updatedAt: db.fn.now(),
        });
        body = text.fresh(org, role, link, pin, text.how[inv.identifierType]);
      } else {
        body = text.known(org, role, link);
      }
      const sent = await sender.send(inv.identifierValue, { text: body, subject: text.subject });
      return sent.ok ? { sent: true, channel, startPin: fresh } : { sent: false, reason: 'not_sent' };
    } catch (err) {
      console.warn('[invitation] delivery skipped:', err?.message);
      return { sent: false, reason: 'not_sent' };
    }
  }

  /** In-app notice to a known Person's personas (best effort). */
  async function tellPerson(inv) {
    if (!notify || !inv.targetPersonId) return;
    try {
      const org = await orgOf(inv);
      const personas = await db('User').where({ personId: inv.targetPersonId }).select('id');
      for (const p of personas) {
        await notify(p.id, {
          id: `ntf_${inv.id}_${p.id}`.slice(0, 60), type: 'org_invitation',
          title: 'You have an invitation',
          body: `${org?.name || (inv.orgType === 'vendor' ? 'A shop' : 'A gym')} invited you to join as ${inv.role}.`,
          data: { invitationId: inv.id, orgType: inv.orgType, orgId: orgIdOf(inv), role: inv.role },
        });
      }
    } catch (err) {
      console.warn('[invitation] notify skipped:', err?.message);
    }
  }

  async function listForOrg({ actor, orgType, orgId, onlyNeedsResolution = false }) {
    await expireDue();
    const rows = (await db('Invitation').where(orgRef(orgType, orgId)).orderBy('createdAt', 'desc').limit(200))
      .filter(r => canManage(actor, r) && (!onlyNeedsResolution || needsResolution(r)));
    return { invitations: rows.map(r => view(r, { identifierValue: r.identifierValue, needsResolution: needsResolution(r) })) };
  }

  async function ownInvitation({ orgType, orgId, invitationId }) {
    const inv = await db('Invitation').where({ id: invitationId, ...orgRef(orgType, orgId) }).first();
    return inv || null;
  }

  async function cancel({ actor, orgType, orgId, invitationId }) {
    const inv = await ownInvitation({ orgType, orgId, invitationId });
    if (!inv || !canManage(actor, inv)) return { error: 'invitation_not_found', status: 404 };
    if (!OPEN.includes(inv.status)) return { error: 'invitation_not_open', status: 409 };
    await db('Invitation').where({ id: inv.id }).update({ status: 'cancelled', respondedAt: db.fn.now(), updatedAt: db.fn.now() });
    await audit(actor.id, 'invitation_cancelled', inv.id, { orgType, orgId });
    return { invitation: view({ ...inv, status: 'cancelled' }) };
  }

  /** A resend replaces the token, so an older link stops working. */
  async function resend({ actor, orgType, orgId, invitationId }) {
    await expireDue();
    const inv = await ownInvitation({ orgType, orgId, invitationId });
    if (!inv || !canManage(actor, inv)) return { error: 'invitation_not_found', status: 404 };
    if (!OPEN.includes(inv.status)) return { error: 'invitation_not_open', status: 409 };
    const limits = invitationLimits();
    if (inv.resendCount >= limits.maxResends) return { error: 'resend_limit_reached', status: 429 };
    if (Date.now() - +new Date(inv.lastSentAt) < limits.resendIntervalHours * 3600e3) {
      return { error: 'resend_too_soon', status: 429 };
    }
    const token = newToken();
    await db('Invitation').where({ id: inv.id }).update({
      tokenHash: sha256(token), resendCount: inv.resendCount + 1, lastSentAt: db.fn.now(), updatedAt: db.fn.now(),
    });
    await audit(actor.id, 'invitation_resent', inv.id, { orgType, orgId });
    await tellPerson(inv);
    const delivery = await deliver(inv, null);
    return { invitation: view(inv), token, delivery };
  }

  // ── A paid invitation that lapsed (decision 1 Oct: held for the gym) ──────

  async function lapsedPaid({ actor, orgType, orgId, invitationId }) {
    await expireDue();
    const inv = await ownInvitation({ orgType, orgId, invitationId });
    if (!inv || !canManage(actor, inv)) return { error: 'invitation_not_found', status: 404 };
    if (!needsResolution(inv)) return { error: 'nothing_to_resolve', status: 409 };
    return { inv };
  }
  const setResolution = (inv, resolution) => db('Invitation').where({ id: inv.id })
    .update({ payload: JSON.stringify({ ...inv.payload, resolution }), updatedAt: db.fn.now() });

  /** Send the same paid plan again; the payment and its original date carry over. */
  async function reissue({ actor, orgType, orgId, invitationId }) {
    const found = await lapsedPaid({ actor, orgType, orgId, invitationId });
    if (found.error) return found;
    const { inv } = found;
    const token = newToken();
    const row = {
      id: id('inv'), orgType, gymId: orgId, vendorId: null, role: inv.role, targetPersonId: inv.targetPersonId,
      identifierType: inv.identifierType, identifierValue: inv.identifierValue, tokenHash: sha256(token),
      status: 'pending', requiresAcceptance: true, aclPermissions: [],
      payload: JSON.stringify({ plan: inv.payload.plan, payment: inv.payload.payment, reissuedFrom: inv.id }),
      message: inv.message, invitedBy: actor.id,
      expiresAt: new Date(Date.now() + invitationLimits().expiryDays * 86400e3),
    };
    await db('Invitation').insert(row);
    await setResolution(inv, { type: 'reissued', invitationId: row.id, by: actor.id, at: new Date().toISOString() });
    await audit(actor.id, 'invitation_reissued', inv.id, { orgType, orgId, newInvitationId: row.id });
    await tellPerson(row);
    return { invitation: view(await db('Invitation').where({ id: row.id }).first()), token };
  }

  /** The gym records that it refunded the desk payment itself. No money moves here. */
  async function markRefunded({ actor, orgType, orgId, invitationId, note }) {
    const found = await lapsedPaid({ actor, orgType, orgId, invitationId });
    if (found.error) return found;
    const resolution = { type: 'refunded', by: actor.id, at: new Date().toISOString(), note: note ? String(note).slice(0, 500) : null };
    await setResolution(found.inv, resolution);
    await audit(actor.id, 'invitation_payment_refunded', found.inv.id, { orgType, orgId, amountTzs: found.inv.payload.payment.amountTzs });
    return { invitation: view({ ...found.inv, payload: { ...found.inv.payload, resolution } }, { needsResolution: false }) };
  }

  // ── Invited person's side ────────────────────────────────────────────────

  const verifiedIdentifiersOf = personId => db('LoginIdentifier')
    .where({ personId, status: 'active' }).whereNotNull('verifiedAt').whereIn('type', ['email', 'phone'])
    .select('type', 'normalizedValue');

  /** Bind open invitations addressed to identifiers this Person has verified. */
  async function claimFor(personId) {
    for (const ident of await verifiedIdentifiersOf(personId)) {
      await db('Invitation')
        .where({ identifierType: ident.type, identifierValue: ident.normalizedValue, status: 'pending' })
        .whereNull('targetPersonId')
        .update({ targetPersonId: personId, status: 'claimed', claimedAt: db.fn.now(), updatedAt: db.fn.now() });
    }
  }

  async function describe(inv) {
    const org = await orgOf(inv);
    return view(inv, { orgName: org?.name ?? null });
  }

  async function listMine({ personId }) {
    await expireDue();
    await claimFor(personId);
    const rows = await db('Invitation').where({ targetPersonId: personId }).whereIn('status', OPEN).orderBy('createdAt', 'desc');
    return { invitations: await Promise.all(rows.map(describe)) };
  }

  /** Open an invitation from its link. The Person must own the identifier it was sent to. */
  async function open({ personId, token }) {
    if (!token) return { error: 'token_required', status: 400 };
    await expireDue();
    await claimFor(personId);
    const inv = await db('Invitation').where({ tokenHash: sha256(token) }).first();
    // The same answer for a wrong token and for someone else's invitation.
    if (!inv || !OPEN.includes(inv.status)) return { error: 'invitation_not_found', status: 404 };
    if (inv.targetPersonId !== personId) return { error: 'identifier_not_verified', status: 403, identifierType: inv.identifierType };
    return { invitation: await describe(inv) };
  }

  async function mine({ personId, invitationId }) {
    await expireDue();
    await claimFor(personId);
    const inv = await db('Invitation').where({ id: invitationId, targetPersonId: personId }).first();
    if (!inv) return { error: 'invitation_not_found', status: 404 };
    if (!OPEN.includes(inv.status)) return { error: 'invitation_not_open', status: 409, invitationStatus: inv.status };
    return { inv };
  }

  async function decline({ user, invitationId }) {
    const found = await mine({ personId: user.personId, invitationId });
    if (found.error) return found;
    await db('Invitation').where({ id: found.inv.id }).update({ status: 'declined', respondedAt: db.fn.now(), updatedAt: db.fn.now() });
    await audit(user.id, 'invitation_declined', found.inv.id, { orgType: found.inv.orgType, orgId: orgIdOf(found.inv) });
    return { invitation: view({ ...found.inv, status: 'declined' }) };
  }

  async function accept({ user, invitationId }) {
    const found = await mine({ personId: user.personId, invitationId });
    if (found.error) return found;
    const { inv } = found;
    const person = await db('Person').where({ id: user.personId }).first('id', 'status');
    if (person?.status !== 'active') return { error: 'person_not_active', status: 403 };
    if (!(await orgOf(inv))) return { error: 'organisation_not_found', status: 409 };

    let personaId;
    if (inv.role === 'staff') {
      const result = inv.orgType === 'vendor' ? await acceptVendorStaff(user, inv) : await acceptStaff(user, inv);
      if (result.error) return result;
      personaId = result.personaId;
    } else if (inv.role === 'trainer') {
      const result = await acceptTrainer(user, inv);
      if (result.error) return result;
      personaId = result.personaId;
    } else if (inv.role === 'member') {
      const result = await acceptMember(user, inv, person);
      if (result.error) return result;
      personaId = result.personaId;
    } else {
      return { error: 'role_not_invitable', status: 400 };
    }

    const membership = await db('OrgMembership')
      .where({ personId: user.personId, ...orgRef(inv.orgType, orgIdOf(inv)), role: inv.role })
      .orderByRaw(`CASE WHEN status IN ('active', 'suspended') THEN 0 ELSE 1 END, "createdAt" DESC`).first('id');
    await db('Invitation').where({ id: inv.id }).update({
      status: 'accepted', respondedAt: db.fn.now(), membershipId: membership?.id ?? null, updatedAt: db.fn.now(),
    });
    if (membership) await db('OrgMembership').where({ id: membership.id }).update({ source: 'invite', invitedBy: inv.invitedBy });
    await audit(user.id, 'invitation_accepted', inv.id, { orgType: inv.orgType, orgId: orgIdOf(inv), role: inv.role, personaId });
    return { invitation: view({ ...inv, status: 'accepted' }), personaId, membershipId: membership?.id ?? null };
  }

  /** A gym_staff persona for this Person at the inviting gym. No credentials are set. */
  async function acceptStaff(user, inv) {
    const existing = await db('User').where({ personId: user.personId, userType: 'gym_staff' }).first();
    if (existing) {
      // One staff persona carries one ACL for all its gyms in the legacy model,
      // so a second organisation can't grant its own permissions safely yet.
      if (!(existing.gymIds || []).includes(inv.gymId)) return { error: 'already_staff_elsewhere', status: 409 };
      return { personaId: existing.id };
    }
    const staffId = `usr_${randomUUID().slice(0, 8)}`;
    try {
      await db('User').insert({
        id: staffId, personId: user.personId, userType: 'gym_staff',
        firebaseUid: user.firebaseUid ?? null, email: user.email ?? null,
        displayName: user.displayName ?? null, photoUrl: user.photoUrl ?? null,
        accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true, portalUser: false,
        aclPermissions: inv.aclPermissions || [], gymIds: [inv.gymId], gymId: inv.gymId,
        createdAt: new Date(), updatedAt: new Date(),
      });
    } catch (err) {
      if (err?.code === '23505') return { error: 'persona_identifier_in_use', status: 409 };
      throw err;
    }
    // Through the collection, so the I4 hook derives the staff membership.
    await users.updateByIdAsync(staffId, { updatedAt: new Date().toISOString() });
    return { personaId: staffId };
  }

  /** A vendor_staff persona for this Person at the inviting vendor. No password is set. */
  async function acceptVendorStaff(user, inv) {
    const existing = await db('User').where({ personId: user.personId, userType: 'vendor_staff' }).first();
    if (existing) {
      // One staff persona belongs to one vendor in the legacy model.
      if (existing.vendorId !== inv.vendorId) return { error: 'already_staff_elsewhere', status: 409 };
      return { personaId: existing.id };
    }
    const staffId = `usr_${randomUUID().slice(0, 8)}`;
    try {
      await db('User').insert({
        id: staffId, personId: user.personId, userType: 'vendor_staff',
        firebaseUid: user.firebaseUid ?? null, email: user.email ?? null,
        displayName: user.displayName ?? null, photoUrl: user.photoUrl ?? null,
        accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true,
        vendorId: inv.vendorId, vendorRole: inv.payload?.vendorRole ?? null, vendorPermissions: inv.aclPermissions || [],
        createdAt: new Date(), updatedAt: new Date(),
      });
    } catch (err) {
      if (err?.code === '23505') return { error: 'persona_identifier_in_use', status: 409 };
      throw err;
    }
    // Through the collection, so the I4 hook derives the staff membership.
    await users.updateByIdAsync(staffId, { updatedAt: new Date().toISOString() });
    return { personaId: staffId };
  }

  /**
   * A direct plan at the gym for the Person's member persona (created here if
   * they have none). It starts on the payment date carried by the invitation.
   */
  async function acceptMember(user, inv, person) {
    if (!activateDirectMembership) return { error: 'role_not_invitable', status: 400 };
    let member = await db('User').where({ personId: user.personId, userType: 'member' }).first();
    if (!member) {
      if (!createPersona) return { error: 'member_persona_required', status: 409 };
      const created = await createPersona({ person, source: user, userType: 'member', approvalStatus: 'approved' });
      if (created.error) return { error: 'persona_identifier_in_use', status: 409 };
      member = created.row;
    }
    const { plan, payment } = inv.payload || {};
    if (!plan) return { error: 'invitation_has_no_plan', status: 409 };
    await activateDirectMembership({
      memberId: member.id, gymId: inv.gymId, tier: plan.tier,
      startDate: plan.startDate, endDate: plan.endDate,
      paidAmount: payment?.amountTzs ?? 0, paidAt: payment?.paidAt ?? null,
    });
    return { personaId: member.id };
  }

  /**
   * The gym joins the Person's trainer profile. Someone with no trainer
   * profile yet gets one on acceptance, attached to this gym: active at once,
   * and not bookable until FitFlex verifies them (rule of 3 Oct 2026).
   */
  async function acceptTrainer(user, inv) {
    let persona = await db('User').where({ personId: user.personId, userType: 'trainer' }).first('id');
    let profile = persona ? trainers.find(t => t.userId === persona.id) : null;
    if (!profile && newTrainerProfile && createPersona) {
      if (!persona) {
        const made = await createPersona({ person: { id: user.personId }, source: user, userType: 'trainer', approvalStatus: 'approved' });
        if (made.error) return { error: 'persona_identifier_in_use', status: 409 };
        await db('User').where({ id: made.row.id }).update({ onboardingCompleted: true });
        await users.updateByIdAsync(made.row.id, { updatedAt: new Date().toISOString() });
        persona = { id: made.row.id };
      }
      profile = await newTrainerProfile({ userId: persona.id, displayName: user.displayName, email: user.email ?? null, phone: user.phone ?? null });
    }
    if (!profile) return { error: 'trainer_persona_required', status: 409 };
    const gymIds = [...new Set([...(profile.gymIds || []), inv.gymId])];
    const pendingGymIds = (profile.pendingGymIds || []).filter(g => g !== inv.gymId);
    await trainers.updateAsync(t => t.id === profile.id, { gymIds, pendingGymIds });
    return { personaId: persona.id };
  }

  return { lookup, create, listForOrg, cancel, resend, reissue, markRefunded, listMine, open, accept, decline, claimFor, expireDue };
}
