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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const OPEN = ['pending', 'claimed'];
const SLICE_A_ROLES = { gym: ['staff', 'trainer'] };
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

export function createInvitationService({ db, users, trainers, notify = null, auditLog = null, ownerStaffAclScopes = [] }) {
  const gymOf = gymId => (gymId ? db('Gym').where({ id: gymId }).first('id', 'name') : null);
  const audit = async (actor, action, target, after) => {
    if (!auditLog) return;
    await auditLog.insertAsync({ id: randomUUID(), at: new Date().toISOString(), actor, action, target, before: null, after });
  };
  const view = (inv, extra = {}) => ({
    id: inv.id, orgType: inv.orgType, orgId: inv.gymId ?? inv.vendorId, role: inv.role, status: inv.status,
    identifierType: inv.identifierType, aclPermissions: inv.aclPermissions || [], message: inv.message ?? null,
    expiresAt: inv.expiresAt, createdAt: inv.createdAt, respondedAt: inv.respondedAt ?? null, ...extra,
  });

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
    if (!SLICE_A_ROLES[orgType]?.includes(role)) {
      return { error: 'role_not_invitable', status: 400, allowed: SLICE_A_ROLES[orgType] || [] };
    }
    const identifier = parseIdentifier(body);
    if (!identifier) return { error: 'one_phone_or_email_required', status: 400 };
    const aclPermissions = role === 'staff' ? [...new Set(body.aclPermissions || [])] : [];
    const invalid = aclPermissions.filter(p => !ownerStaffAclScopes.includes(p));
    if (invalid.length) return { error: 'invalid_acl_scopes', status: 400, invalid };

    await expireDue();
    const targetPersonId = await verifiedPerson(identifier);
    if (targetPersonId) {
      const member = await db('OrgMembership')
        .where({ personId: targetPersonId, orgType, gymId: orgId, role }).whereIn('status', ['active', 'suspended']).first('id');
      if (member) return { error: 'already_a_member', status: 409 };
      if (role === 'staff') {
        const owner = await db('OrgMembership')
          .where({ personId: targetPersonId, orgType, gymId: orgId, role: 'owner', status: 'active' }).first('id');
        if (owner) return { error: 'already_owner', status: 409 };
      }
    }
    const open = await db('Invitation')
      .where({ orgType, gymId: orgId, role, identifierType: identifier.type, identifierValue: identifier.value })
      .whereIn('status', OPEN).first();
    if (open) return { created: false, invitation: view(open) };

    const token = newToken();
    const row = {
      id: id('inv'), orgType, gymId: orgId, vendorId: null, role, targetPersonId,
      identifierType: identifier.type, identifierValue: identifier.value, tokenHash: sha256(token),
      status: 'pending', requiresAcceptance: true, aclPermissions,
      message: body.message ? String(body.message).slice(0, 500) : null, invitedBy: actor.id,
      expiresAt: new Date(Date.now() + invitationLimits().expiryDays * 86400e3),
    };
    await db('Invitation').insert(row);
    await audit(actor.id, 'invitation_created', row.id, { orgType, orgId, role, identifierType: identifier.type, knownPerson: Boolean(targetPersonId) });
    await tellPerson(row);
    // The token is returned once so the organisation can share the link. It
    // only opens the invitation; accepting needs the invited person's own session.
    return { created: true, invitation: view(await db('Invitation').where({ id: row.id }).first()), token };
  }

  /** In-app notice to a known Person's personas (best effort). */
  async function tellPerson(inv) {
    if (!notify || !inv.targetPersonId) return;
    try {
      const gym = await gymOf(inv.gymId);
      const personas = await db('User').where({ personId: inv.targetPersonId }).select('id');
      for (const p of personas) {
        await notify(p.id, {
          id: `ntf_${inv.id}_${p.id}`.slice(0, 60), type: 'org_invitation',
          title: 'You have an invitation',
          body: `${gym?.name || 'A gym'} invited you to join as ${inv.role}.`,
          data: { invitationId: inv.id, orgType: inv.orgType, orgId: inv.gymId ?? inv.vendorId, role: inv.role },
        });
      }
    } catch (err) {
      console.warn('[invitation] notify skipped:', err?.message);
    }
  }

  async function listForOrg({ orgType, orgId }) {
    await expireDue();
    const rows = await db('Invitation').where({ orgType, gymId: orgId }).orderBy('createdAt', 'desc').limit(200);
    return { invitations: rows.map(r => view(r, { identifierValue: r.identifierValue })) };
  }

  async function ownInvitation({ orgType, orgId, invitationId }) {
    const inv = await db('Invitation').where({ id: invitationId, orgType, gymId: orgId }).first();
    return inv || null;
  }

  async function cancel({ actor, orgType, orgId, invitationId }) {
    const inv = await ownInvitation({ orgType, orgId, invitationId });
    if (!inv) return { error: 'invitation_not_found', status: 404 };
    if (!OPEN.includes(inv.status)) return { error: 'invitation_not_open', status: 409 };
    await db('Invitation').where({ id: inv.id }).update({ status: 'cancelled', respondedAt: db.fn.now(), updatedAt: db.fn.now() });
    await audit(actor.id, 'invitation_cancelled', inv.id, { orgType, orgId });
    return { invitation: view({ ...inv, status: 'cancelled' }) };
  }

  /** A resend replaces the token, so an older link stops working. */
  async function resend({ actor, orgType, orgId, invitationId }) {
    await expireDue();
    const inv = await ownInvitation({ orgType, orgId, invitationId });
    if (!inv) return { error: 'invitation_not_found', status: 404 };
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
    return { invitation: view(inv), token };
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
    const gym = await gymOf(inv.gymId);
    return view(inv, { orgName: gym?.name ?? null });
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
    await audit(user.id, 'invitation_declined', found.inv.id, { orgType: found.inv.orgType, orgId: found.inv.gymId });
    return { invitation: view({ ...found.inv, status: 'declined' }) };
  }

  async function accept({ user, invitationId }) {
    const found = await mine({ personId: user.personId, invitationId });
    if (found.error) return found;
    const { inv } = found;
    const person = await db('Person').where({ id: user.personId }).first('status');
    if (person?.status !== 'active') return { error: 'person_not_active', status: 403 };
    if (!(await gymOf(inv.gymId))) return { error: 'organisation_not_found', status: 409 };

    let personaId;
    if (inv.role === 'staff') {
      const result = await acceptStaff(user, inv);
      if (result.error) return result;
      personaId = result.personaId;
    } else if (inv.role === 'trainer') {
      const result = await acceptTrainer(user, inv);
      if (result.error) return result;
      personaId = result.personaId;
    } else {
      return { error: 'role_not_invitable', status: 400 };
    }

    const membership = await db('OrgMembership')
      .where({ personId: user.personId, orgType: inv.orgType, gymId: inv.gymId, role: inv.role })
      .whereIn('status', ['active', 'suspended']).first('id');
    await db('Invitation').where({ id: inv.id }).update({
      status: 'accepted', respondedAt: db.fn.now(), membershipId: membership?.id ?? null, updatedAt: db.fn.now(),
    });
    if (membership) await db('OrgMembership').where({ id: membership.id }).update({ source: 'invite', invitedBy: inv.invitedBy });
    await audit(user.id, 'invitation_accepted', inv.id, { orgType: inv.orgType, orgId: inv.gymId, role: inv.role, personaId });
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

  /** The gym joins the Person's existing trainer profile. */
  async function acceptTrainer(user, inv) {
    const persona = await db('User').where({ personId: user.personId, userType: 'trainer' }).first('id');
    const profile = persona ? trainers.find(t => t.userId === persona.id) : null;
    if (!profile) return { error: 'trainer_persona_required', status: 409 };
    const gymIds = [...new Set([...(profile.gymIds || []), inv.gymId])];
    const pendingGymIds = (profile.pendingGymIds || []).filter(g => g !== inv.gymId);
    await trainers.updateAsync(t => t.id === profile.id, { gymIds, pendingGymIds });
    return { personaId: persona.id };
  }

  return { lookup, create, listForOrg, cancel, resend, listMine, open, accept, decline, claimFor, expireDue };
}
