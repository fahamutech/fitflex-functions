// Identity V2 — a person who has no profile yet (agreed 3 Oct 2026).
//
// Two ways to get here:
//   - Invited, and new to FitFlex. They signed in with the start PIN from the
//     invitation message (which also proved the number or email is theirs).
//     `begin` takes their name and their own four-digit PIN, and only then
//     does anything exist for them: a Person, the verified identifier, the PIN.
//   - Declined every invitation and never chose a role. Signing in gives the
//     same onboarding step again.
//
// From there, with a short-lived onboarding token (never a session):
//   accept    the invitation → the invited role, and a session in it
//   decline   it → back to the choice
//   role      pick member, trainer, gym owner or vendor instead → a session
//
// The organisation never sees or sets the PIN, and accepting stays a separate,
// explicit step (O5).
import { randomUUID } from 'node:crypto';
import { isPin, INVITE_START, ONBOARDING } from './pin-auth-service.mjs';

const SELF_ROLES = { member: 'member', trainer: 'trainer', gym_owner: 'gym_operator', gym_operator: 'gym_operator', vendor: 'vendor' };
const cleanName = name => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);

export function createOnboardingService({
  db, users, pinAuth, invitations, identityLink, sessionForPerson, isRegistered, approvalStatusForRole,
  verifyPurpose, auditLog = null,
}) {
  /** The person as the invitation code sees a profile: enough to build one from. */
  async function asUser(personId) {
    const person = await db('Person').where({ id: personId }).first('id', 'status', 'displayName');
    if (!person || person.status !== 'active') return null;
    const identifiers = await db('LoginIdentifier').where({ personId, status: 'active' }).whereNotNull('verifiedAt')
      .whereIn('type', ['email', 'phone']).select('type', 'normalizedValue');
    return {
      id: null, personId, displayName: person.displayName ?? null, firebaseUid: null, photoUrl: null,
      email: identifiers.find(i => i.type === 'email')?.normalizedValue ?? null,
      phone: identifiers.find(i => i.type === 'phone')?.normalizedValue ?? null,
    };
  }
  const tokenPerson = async token => {
    const claims = verifyPurpose(token, ONBOARDING);
    return claims ? asUser(claims.pid) : null;
  };
  const INVALID = { error: 'onboarding_token_invalid', status: 401 };

  /** Name + their own PIN, after the start PIN. Now the person exists. */
  async function begin({ body = {} }) {
    if (!pinAuth.configured()) return { error: 'pin_not_configured', status: 503 };
    const claims = verifyPurpose(body.startToken, INVITE_START);
    if (!claims) return { error: 'start_token_invalid', status: 401 };
    const displayName = cleanName(body.displayName);
    if (displayName.length < 2) return { error: 'display_name_required', status: 400 };
    if (!isPin(body.pin)) return { error: 'pin_must_be_4_digits', status: 400 };
    const identifier = { type: claims.type, value: claims.value };

    const personId = `psn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const outcome = await db.transaction(async trx => {
      // The start PIN works once: whoever gets here first uses it up.
      const used = await trx('Invitation')
        .where({ id: claims.inv, status: 'pending' }).whereNull('startPinUsedAt').whereNotNull('startPinHash')
        .update({ startPinUsedAt: trx.fn.now(), startPinHash: null, updatedAt: trx.fn.now() });
      if (!used) return { error: 'start_token_invalid', status: 401 };
      if (await isRegistered(identifier)) return { error: 'already_registered', status: 409 };
      await trx('Person').insert({ id: personId, status: 'active', displayName });
      await trx('LoginIdentifier').insert({
        id: `lid_${randomUUID().replace(/-/g, '').slice(0, 12)}`, personId, type: identifier.type,
        value: identifier.value, normalizedValue: identifier.value, verifiedAt: trx.fn.now(),
        provider: 'fitflex_invitation', status: 'active',
      });
      return { ok: true };
    });
    if (outcome.error) return outcome;
    await pinAuth.setPin(personId, String(body.pin));
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(), actor: null, action: 'person_started_from_invitation',
        target: personId, before: null, after: { invitationId: claims.inv, identifierType: identifier.type },
      });
    }
    // Listing claims the invitation for them, now that the identifier is verified.
    return pinAuth.onboarding(personId);
  }

  /** Accept an invitation: the invited role is created and opened. */
  async function accept({ body = {} }) {
    const user = await tokenPerson(body.onboardingToken);
    if (!user) return INVALID;
    const result = await invitations.accept({ user, invitationId: body.invitationId });
    if (result.error) return result;
    if (result.personaId) await identityLink.rememberPersona(user.personId, result.personaId);
    return sessionForPerson(user.personId);
  }

  /** Decline: nothing is created; the person is back at the choice. */
  async function decline({ body = {} }) {
    const user = await tokenPerson(body.onboardingToken);
    if (!user) return INVALID;
    const result = await invitations.decline({ user, invitationId: body.invitationId });
    if (result.error) return result;
    return pinAuth.onboarding(user.personId);
  }

  /** No invitation taken: choose how to use FitFlex, as someone registering would. */
  async function chooseRole({ body = {} }) {
    const user = await tokenPerson(body.onboardingToken);
    if (!user) return INVALID;
    const userType = SELF_ROLES[String(body.role ?? '')];
    if (!userType) return { error: 'role_not_allowed', status: 400, allowed: ['member', 'trainer', 'gym_owner', 'vendor'] };
    const held = await db('User').where({ personId: user.personId, userType }).whereNot({ accountStatus: 'closed' }).first('id');
    let personaId = held?.id;
    if (!personaId) {
      const made = await identityLink.createPersona({
        person: { id: user.personId }, source: user, userType, approvalStatus: approvalStatusForRole(userType),
      });
      if (made.error) return { error: 'persona_identifier_in_use', status: 409 };
      // Through the collection, so the hooks that follow a profile run.
      await users.updateByIdAsync(made.row.id, { updatedAt: new Date().toISOString() });
      personaId = made.row.id;
    }
    await identityLink.rememberPersona(user.personId, personaId);
    return sessionForPerson(user.personId);
  }

  return { begin, accept, decline, chooseRole };
}
