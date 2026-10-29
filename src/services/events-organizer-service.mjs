// Marathon & running events · S2 — the organizer side (spec §2, §4–§7, §9, §14.3; decisions D3, D11, D12, D13).
//
//   createOrganizer     POST /me/organizer: persona (event_organizer, under the caller's Person) + EventOrganizer
//                       (draft) + owner staff row + PartnerKycCase(event_organizer) + OrgMembership(organizer)
//   me / summary        what the portal shell needs
//   events              list / create / get / patch (CAS + nested upsert + validation + material-change rule)
//   transition          submit | withdraw | cancel | complete | archive (S1 transitionEvent + side effects)
//   staff               list / invite (start-PIN invitation, org type organizer) / change role / remove
//   syncOrganizerStatus the KYC hook: EventOrganizer.status is derived from the case (spec §2)
//   runLifecycle        the eventLifecycle job: automatic transitions (§7.1)
// Business errors are returned as { error, status, ...extra } (D5), never thrown.
import { randomUUID } from 'node:crypto';
import { normalizePhone, normalizeEmail } from '../shared/identifiers.mjs';
import {
  INVITABLE_ORGANIZER_ROLES, EVENT_EDITOR_ROLES, organizerStatusOf, permissionsFor, canManageStaff, removalRefusal, roleChangeRefusal,
} from '../shared/events-organizer.mjs';
import {
  parseEventPatch, parseNote, validateEvent, changedPaths, isMaterialPath, diffOf, allowedActionsFor, organizerView, rowView, slugify, validTimezone,
  CANCEL_REASONS, DEFAULT_CLOSING_SOON_HOURS, NOTE_MAX,
} from '../shared/events-document.mjs';
import { paginate } from '../shared/pagination.mjs';
import { isSensitiveReason, partnerReasonCode } from '../shared/partner-kyc.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Personas that may ask for the organizer capability (spec §4.3; staff, HR, admin and portal users may not). */
const CAN_BECOME_ORGANIZER = new Set(['member', 'trainer', 'gym_operator', 'vendor']);
const EDITABLE_STATUSES = new Set(['draft', 'published', 'registration_closed']);
const TRANSITIONS = Object.freeze({ submit: 'submitted', withdraw: 'draft', cancel: 'cancelled', complete: 'completed', archive: 'archived' });

/** "+255712345678" → "+255 7•• ••• 678"; "asha@example.com" → "a•••@example.com". */
export function maskContact({ phone, email }) {
  if (phone) {
    const p = String(phone).replace(/\s+/g, '');
    return `${p.slice(0, 5)} ${'•'.repeat(Math.max(p.length - 8, 2))} ${p.slice(-3)}`;
  }
  if (email) {
    const [local, domain] = String(email).split('@');
    return domain ? `${local.slice(0, 1)}•••@${domain}` : null;
  }
  return null;
}

export function createEventsOrganizerService({
  db, eventStore, catalogue, users, identityLink = null, partnerKyc, invitations = null, orgMemberships = null, auditLog = null,
  notify = async () => {}, track = async () => {}, now = () => new Date(),
  closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS, autoCompleteGraceHours = () => 6,
  // S3: (organizerId) → { registrationsTotal, awaitingPaymentTotal, confirmedTotal } for the overview (null until wired).
  registrationTotals = null,
}) {
  const nowIso = () => now().toISOString();
  const audit = async (actor, action, target, before, after) => {
    if (!auditLog) return;
    await auditLog.insertAsync({ id: `aud_${randomUUID().slice(0, 8)}`, at: nowIso(), actor: actor || 'system', action, target, before: before ?? null, after: after ?? null });
  };
  /** Server-side analytics (spec §15): named, no personal data; an AuditLog row until a pipeline exists. */
  const analytics = async (name, payload) => {
    await audit('system', `analytics.${name}`, payload.eventId, null, payload);
    try { await track(name, payload); } catch { /* best effort */ }
  };
  const viewOpts = () => ({ now: now(), closingSoonHours: closingSoonHours() });

  // What the organizer owner / staff are told about why (owner rule 22 Oct 2026, as /me/kyc since #245): statusReason
  // is the reviewer's KYC note, so it is shown only under a known partner-safe reason code. A sensitive code
  // (suspected_fraud, duplicate_partner) becomes statusReasonCode 'under_review' with no note; a note with no
  // case code behind it is not shown either (fail closed). EventOrganizer.statusReason keeps the real note for admins.
  const organizerReason_ = (o, kycCase) => {
    const code = kycCase?.reasonCode ?? null;
    const note = o.statusReason ?? kycCase?.reasonNote ?? null;
    if (!code || isSensitiveReason(code)) return { statusReasonCode: partnerReasonCode(code), statusReason: null };
    return { statusReasonCode: code, statusReason: note };
  };

  const organizerView_ = (o, kycCase = null) => ({
    id: o.id, name: o.name, status: o.status, timezone: o.timezone, kycCaseId: o.kycCaseId ?? kycCase?.id ?? null,
    kycStatus: kycCase?.status ?? null, ...organizerReason_(o, kycCase),
    contactPhone: o.contactPhone ?? null, contactEmail: o.contactEmail ?? null,
  });

  // ── Organizer creation (POST /me/organizer) ─────────────────────────────

  async function createOrganizer({ claims, body = {} }) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 2 || name.length > 80) return fail('invalid_name', 400);
    const phone = normalizePhone(body.contactPhone);
    if (!phone) return fail('invalid_phone', 400);
    const email = body.contactEmail ? normalizeEmail(body.contactEmail) : null;
    if (body.contactEmail && (!email || !EMAIL.test(email))) return fail('invalid_email', 400);
    const timezone = typeof body.timezone === 'string' && body.timezone ? body.timezone : 'Africa/Dar_es_Salaam';
    if (!validTimezone(timezone)) return fail('invalid_timezone', 400);

    const caller = await users.findByIdAsync(claims.sub);
    if (!caller) return fail('user_not_found', 404);
    if (caller.userType === 'event_organizer' || caller.userType === 'organizer_staff') {
      return (await catalogue.organizerForUser(caller.id)) ? fail('organizer_exists', 409) : fail('persona_not_allowed', 403);
    }
    if (!CAN_BECOME_ORGANIZER.has(caller.userType) || caller.portalUser === true) return fail('persona_not_allowed', 403);
    // The persona lives under the caller's Person (Identity V2): without one there is nowhere to hang it.
    if (!caller.personId || !identityLink) return fail('persona_not_allowed', 403, { reason: 'no_person' });
    const person = await identityLink.personOf(caller.personId);
    if (person?.status !== 'active') return fail('persona_not_allowed', 403, { reason: 'person_not_active' });
    const personas = await identityLink.personasOf(caller.personId);
    const dangling = personas.find(p => p.userType === 'event_organizer');
    // A persona left behind by an interrupted earlier attempt (no organizer behind it) is reused, not refused (L5).
    if (dangling && ((await catalogue.organizerForUser(dangling.id)) || (await catalogue.organizerOfOwner(dangling.id)))) return fail('organizer_exists', 409);
    let persona = dangling ? await users.findByIdAsync(dangling.id) : null;
    if (!persona) {
      const made = await identityLink.createPersona({ person, source: caller, userType: 'event_organizer', approvalStatus: 'approved' });
      if (made.error) return fail('persona_identifier_in_use', 409);
      persona = made.row;
    }
    const organizer = await eventStore.createOrganizer({ ownerUserId: persona.id, name, contactPhone: phone, contactEmail: email, timezone });
    if (organizer.error) return organizer;
    const actor = { id: persona.id, role: 'partner' };
    const kycCase = await partnerKyc.ensureCase({ partnerType: 'event_organizer', subjectId: persona.id, user: persona }, actor);
    await catalogue.patchOrganizer(organizer.id, { kycCaseId: kycCase.id });
    await catalogue.addStaff({ organizerId: organizer.id, userId: persona.id, role: 'owner', addedBy: caller.id });
    // Through the collection so the I4 hook derives the OrgMembership(organizer, owner) row.
    await users.updateByIdAsync(persona.id, { organizerId: organizer.id, organizerRole: 'owner', displayName: persona.displayName || name, onboardingCompleted: true, updatedAt: nowIso() });
    if (orgMemberships) { try { await orgMemberships.syncUser(persona.id); } catch { /* the hook already ran */ } }
    await audit(caller.id, 'events.organizer_created', organizer.id, null, { personaId: persona.id, kycCaseId: kycCase.id, name });
    const saved = await catalogue.getOrganizer(organizer.id);
    return { created: true, status: 201, organizer: organizerView_(saved, kycCase), kycCaseId: kycCase.id, personaId: persona.id };
  }

  // ── /organizer/me and summary ───────────────────────────────────────────

  async function kycCaseOf(organizer) {
    if (!organizer.kycCaseId) return null;
    return (await db('PartnerKycCase').where({ id: organizer.kycCaseId }).first()) ?? null;
  }

  async function me({ ctx }) {
    const kycCase = await kycCaseOf(ctx.organizer);
    return { organizer: organizerView_(ctx.organizer, kycCase), role: ctx.role, permissions: permissionsFor(ctx.role, ctx.organizer.status) };
  }

  async function summary({ ctx }) {
    const all = await catalogue.listForOrganizer(ctx.organizer.id);
    const at = +now();
    const live = all.filter(j => j.event.status !== 'archived');
    const upcoming = live.filter(j => +new Date(j.event.startsAt) >= at).sort((a, b) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt));
    const past = live.filter(j => +new Date(j.event.startsAt) < at).sort((a, b) => +new Date(b.event.startsAt) - +new Date(a.event.startsAt));
    const next = [...upcoming, ...past].slice(0, 3);
    return {
      eventsTotal: all.length,
      publishedTotal: all.filter(j => ['published', 'registration_closed', 'in_progress'].includes(j.event.status)).length,
      // S3 (registration service) fills these; zeros until it is wired.
      ...(registrationTotals ? await registrationTotals(ctx.organizer.id) : { registrationsTotal: 0, awaitingPaymentTotal: 0, confirmedTotal: 0 }),
      nextEvents: next.map(j => rowView(j, { ...viewOpts(), allowedActions: actionsFor(ctx, j.event.status) })),
    };
  }

  const actionsFor = (ctx, status) => allowedActionsFor({ status, actor: 'organizer', role: ctx.role, organizerStatus: ctx.organizer.status });

  // ── Events ──────────────────────────────────────────────────────────────

  async function listEvents({ ctx, query = {} }) {
    const status = query.status && query.status !== 'all' ? String(query.status) : null;
    const type = query.type ? String(query.type) : null;
    const rows = (await catalogue.listForOrganizer(ctx.organizer.id, { status, type })).map(j => rowView(j, { ...viewOpts(), allowedActions: actionsFor(ctx, j.event.status) }));
    return paginate(rows, { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
  }

  async function uniqueSlug(title) {
    const base = slugify(title);
    for (let i = 0; i < 20; i += 1) {
      const candidate = i === 0 ? base : `${base}-${randomUUID().slice(0, 4)}`;
      if (!(await db('Event').where({ slug: candidate }).first('id'))) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  /** POST /organizer/events {title}: a draft with placeholder dates (the wizard fills them in). */
  async function createEvent({ ctx, body = {}, actorId }) {
    if (!EVENT_EDITOR_ROLES.includes(ctx.role)) return fail('forbidden_role', 403);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 3 || title.length > 80) return fail('event_invalid', 422, { fields: [{ path: 'title', code: title ? 'length' : 'required', min: 3, max: 80 }] });
    const startsAt = new Date(+now() + 30 * 86_400_000);
    const created = await eventStore.createEvent({
      organizerId: ctx.organizer.id, slug: await uniqueSlug(title), title, eventType: 'road', timezone: ctx.organizer.timezone || 'Africa/Dar_es_Salaam',
      startsAt, endsAt: new Date(+startsAt + 6 * 3_600_000), registrationClosesAt: new Date(+startsAt - 86_400_000),
    });
    if (created.error) return created;
    await audit(actorId, 'events.event_created', created.id, null, { organizerId: ctx.organizer.id, title });
    return { status: 201, id: created.id, version: created.version };
  }

  /** The caller's event, joined; 403 not_your_organizer for anyone else's (never 404 to a stranger). */
  async function own(ctx, eventId) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined || joined.event.organizerId !== ctx.organizer.id) return fail('not_your_organizer', 403);
    return { joined };
  }

  async function getEvent({ ctx, eventId }) {
    const found = await own(ctx, eventId);
    if (found.error) return found;
    const { joined } = found;
    return organizerView(joined, { ...viewOpts(), allowedActions: actionsFor(ctx, joined.event.status), changeLogCount: await catalogue.countChangeLog(joined.event.id) });
  }

  /**
   * PATCH /organizer/events/:id — compare-and-set on `version`, nested upsert, validation (422 event_invalid),
   * the material-change rule on published events (409 change_note_required) and one EventChangeLog row per
   * save of a published event (§7.4). Returns { version, updatedAt, material }.
   */
  async function patchEvent({ ctx, eventId, body = {}, actorId, actorKind = 'organizer' }) {
    if (actorKind === 'organizer') {
      if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
      if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
      if (!EVENT_EDITOR_ROLES.includes(ctx.role)) return fail('forbidden_role', 403);
    }
    const found = actorKind === 'organizer' ? await own(ctx, eventId) : await (async () => { const j = await catalogue.loadJoined(eventId); return j ? { joined: j } : fail('event_not_found', 404); })();
    if (found.error) return found;
    const { joined } = found;
    const current = joined.event;
    const expectedVersion = Number(body.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return fail('version_conflict', 409, { eventId, reason: 'version_required', version: current.version });
    if (expectedVersion !== current.version) return fail('version_conflict', 409, { eventId, version: current.version });
    if (!EDITABLE_STATUSES.has(current.status)) return fail('invalid_transition', 409, { from: current.status, to: 'edit', allowed: [] });

    const { patch, nested, changeNote: rawNote } = parseEventPatch(body);
    // S5 (D33): the payout schedule is free in a draft and locked from submission on; after publication only FitFlex changes it (admin route, with a reason).
    if (patch.payoutSchedule !== undefined && current.status !== 'draft') {
      if (patch.payoutSchedule === (current.payoutSchedule ?? null)) delete patch.payoutSchedule;
      else return fail('payout_schedule_locked', 409, { eventId, eventStatus: current.status });
    }
    const parsedNote = parseNote(rawNote);
    if (parsedNote.error) return fail('event_invalid', 422, { fields: parsedNote.fields.map(x => ({ ...x, path: `changeNote.${x.path.slice(5)}` })) });
    const changeNote = parsedNote.note;
    // Validate the document as it would be after the save (patch mode: only what is present).
    const draft = { ...current, ...patch };
    if (nested?.categories) draft.categories = nested.categories.map(c => ({ ...c, distanceMeters: c.distanceM, startTime: c.startsAt, ticketTypes: c.ticketTypes }));
    if (nested?.collectionPoints) draft.collectionPoints = nested.collectionPoints.map(p => ({ ...p, openingWindows: p.windows }));
    const fields = validateEvent(draft, { mode: 'patch', now: now() });
    if (fields.length) return fail('event_invalid', 422, { fields });

    const before = organizerView(joined, viewOpts());
    const after = organizerView({ ...joined, event: draft, categories: draft.categories ?? joined.categories, collectionPoints: draft.collectionPoints ?? joined.collectionPoints }, viewOpts());
    const paths = changedPaths(before, after);
    const material = paths.filter(isMaterialPath);
    const published = ['published', 'registration_closed'].includes(current.status);
    if (published && material.length && !changeNote) return fail('change_note_required', 409, { fields: material });

    if (nested) {
      const r = await catalogue.upsertNested(current.id, nested);
      if (r.error) return r;
    }
    // S5 (M4): `event.updated` commits WITH the event row. The paths (never values) are known here already.
    const saved = await eventStore.updateEvent(current.id, patch, {
      expectedVersion,
      inTransaction: published ? (trx, row) => eventStore.appendOutbox(trx, { type: 'event.updated', aggregateType: 'event', aggregateId: current.id, organizerId: current.organizerId, eventId: current.id, payload: { eventId: current.id, version: row.version, changedFields: paths, material: material.length > 0 } }) : null,
    });
    if (saved.error) {
      if (saved.error === 'event_frozen_field') return fail('event_invalid', 422, { fields: [{ path: saved.field, code: 'frozen' }] });
      return saved;
    }
    if (published && changeNote) await catalogue.patchEventRaw(current.id, { lastChangeNote: changeNote });
    if (published) {
      const diff = diffOf(before, after, paths);
      await catalogue.appendChangeLog({ eventId: current.id, actorUserId: actorId, actorRole: actorKind === 'admin' ? 'admin' : ctx.role, fields: paths, before: diff.before, after: diff.after, note: changeNote, material: material.length > 0 });
    }
    await audit(actorId, 'events.event_updated', current.id, { version: current.version }, { version: saved.event.version, fields: paths, material: material.length > 0 });
    // S5: `event.updated` for webhooks and the API (paths only, never values); the payout schedule is not part of what organizers' systems see.
    return { version: saved.event.version, updatedAt: new Date(saved.event.updatedAt).toISOString(), material: material.length > 0 };
  }

  /**
   * Move an event with its side effects. Used by the organizer routes and the admin service.
   * `actor` = { id, kind: 'organizer' | 'admin' | 'system', role }. Extra: cancellation, rejection.
   */
  async function moveEvent(eventId, to, { actor, cancellation = null, rejection = null, note = null } = {}) {
    const before = await eventStore.getEvent(eventId);
    if (!before) return fail('event_not_found', 404);
    const sideBefore = {};
    if (to === 'submitted') {
      // The texts participants will agree to are frozen now (S1 freezes the columns after submission).
      const r = await eventStore.updateEvent(eventId, { termsSnapshot: before.terms ?? null, refundPolicySnapshot: before.refundPolicy ?? null }, { expectedVersion: before.version });
      if (r.error) return r;
      sideBefore.version = r.event.version;
    }
    // S5 (M4): `event.cancelled` commits WITH the status move.
    const moved = await eventStore.transitionEvent(eventId, to, {
      inTransaction: to === 'cancelled' ? (trx, row) => eventStore.appendOutbox(trx, { type: 'event.cancelled', aggregateType: 'event', aggregateId: eventId, organizerId: before.organizerId, eventId, payload: { eventId, cancelledAt: row.cancelledAt, reasonCode: cancellation?.reason ?? 'admin' } }) : null,
    });
    if (moved.error) return moved;
    const raw = {};
    if (to === 'submitted') { raw.submittedAt = now(); raw.rejection = null; }
    if (to === 'draft' && rejection) raw.rejection = { ...rejection, at: nowIso() };
    if (to === 'cancelled') raw.cancellation = cancellation;
    if (Object.keys(raw).length) await catalogue.patchEventRaw(eventId, raw);
    const action = { submitted: 'events.submitted', draft: rejection ? 'events.rejected' : 'events.withdrawn', published: 'events.published', registration_closed: 'events.registration_closed', in_progress: 'events.started', completed: 'events.completed', cancelled: 'events.cancelled', archived: 'events.archived' }[to];
    await audit(actor.id, action, eventId, { status: moved.from }, { status: to, by: actor.kind, ...(rejection ? { reason: rejection.reason, note: rejection.note } : {}), ...(cancellation ? { reason: cancellation.reason, note: cancellation.note } : {}), ...(note ? { note } : {}) });
    if (actor.kind !== 'system' && ['published', 'registration_closed'].includes(moved.from)) {
      await catalogue.appendChangeLog({ eventId, actorUserId: actor.id, actorRole: actor.kind === 'admin' ? 'admin' : actor.role, fields: ['status'], before: { status: moved.from }, after: { status: to }, note: cancellation?.note ?? null, material: to === 'cancelled', reason: cancellation?.reason ?? null });
    }
    if (to === 'submitted') await analytics('organizer_event_submitted', { eventId });
    if (to === 'published') await analytics('event_published', { eventId });
    return { status: to, from: moved.from, event: await eventStore.getEvent(eventId) };
  }

  async function transition({ ctx, eventId, action, body = {}, actorId }) {
    const to = TRANSITIONS[action];
    if (!to) return fail('invalid_transition', 409, { to: action });
    if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
    if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
    if (!EVENT_EDITOR_ROLES.includes(ctx.role)) return fail('forbidden_role', 403);
    const found = await own(ctx, eventId);
    if (found.error) return found;
    const { joined } = found;
    const extra = {};
    if (action === 'submit' && joined.event.status === 'draft') {
      // The full checklist (§6.2 / §7); a non-draft falls through to the machine's invalid_transition.
      const fields = validateEvent({ ...joined.event, categories: joined.categories, collectionPoints: joined.collectionPoints }, { mode: 'submit', now: now() });
      if (fields.length) return fail('event_invalid', 422, { fields });
    }
    if (action === 'cancel') {
      if (!CANCEL_REASONS.includes(body.reason)) return fail('reason_code_required', 400, { allowed: [...CANCEL_REASONS] });
      const note = parseNote(body.note);
      if (note.error) return note;
      // D12: once anyone holds a confirmed place, only FitFlex cancels.
      if (await catalogue.hasConfirmedRegistrations(joined.event.id)) return fail('has_registrations', 409);
      extra.cancellation = { reason: body.reason, note: note.note ?? { en: null, sw: null } };
    }
    const moved = await moveEvent(joined.event.id, to, { actor: { id: actorId, kind: 'organizer', role: ctx.role }, ...extra });
    if (moved.error) return moved;
    return { status: moved.status };
  }

  async function deleteEvent({ ctx, eventId, actorId }) {
    if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
    if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
    if (!EVENT_EDITOR_ROLES.includes(ctx.role)) return fail('forbidden_role', 403);
    const found = await own(ctx, eventId);
    if (found.error) return found;
    const r = await catalogue.deleteDraft(found.joined.event.id);
    if (r.error) return r;
    await audit(actorId, 'events.deleted', eventId, { status: 'draft', title: found.joined.event.title }, null);
    return { deleted: true };
  }

  // An admin's name is never shown to the organizer (L3); the role still says who acted.
  const changeView = l => ({
    id: l.id, at: new Date(l.createdAt).toISOString(), actor: { name: l.actorRole === 'admin' ? null : l.actorName ?? null, role: l.actorRole ?? null },
    fields: Array.isArray(l.fields) ? l.fields : String(l.field || '').split(',').filter(Boolean), material: l.material === true,
    note: l.note ? { en: l.note.en ?? null, sw: l.note.sw ?? null } : null, before: l.before ?? null, after: l.after ?? null,
  });

  async function changes({ ctx, eventId, query = {} }) {
    const found = await own(ctx, eventId);
    if (found.error) return found;
    return paginate((await catalogue.listChangeLog(found.joined.event.id)).map(changeView), { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
  }

  // ── Staff (§9) ──────────────────────────────────────────────────────────

  const staffView = s => ({
    id: s.id, userId: s.userId, displayName: s.displayName ?? null, maskedContact: maskContact({ phone: s.phone, email: s.email }),
    role: s.role, status: 'active', addedAt: new Date(s.createdAt).toISOString(),
  });

  async function openInvitations(organizerId) {
    if (!invitations) return [];
    const rows = await db('Invitation').where({ orgType: 'organizer', organizerId, role: 'staff' }).whereIn('status', ['pending', 'claimed']).orderBy('createdAt');
    return rows.map(inv => ({
      id: inv.id, userId: null, displayName: null, maskedContact: maskContact(inv.identifierType === 'phone' ? { phone: inv.identifierValue } : { email: inv.identifierValue }),
      role: inv.payload?.organizerRole ?? (typeof inv.payload === 'string' ? JSON.parse(inv.payload)?.organizerRole : null) ?? null, status: 'invited', addedAt: new Date(inv.createdAt).toISOString(),
    }));
  }

  async function listStaff({ ctx }) {
    if (!canManageStaff(ctx.role)) return fail('forbidden_role', 403);
    const items = [...(await catalogue.staffOf(ctx.organizer.id)).map(staffView), ...(await openInvitations(ctx.organizer.id))];
    return { items };
  }

  async function inviteStaff({ ctx, body = {}, actorId }) {
    if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
    if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
    if (!canManageStaff(ctx.role)) return fail('forbidden_role', 403);
    const role = String(body.role || '');
    if (!INVITABLE_ORGANIZER_ROLES.includes(role)) return fail('invalid_role', 400, { allowed: [...INVITABLE_ORGANIZER_ROLES] });
    if (!invitations) return fail('invitations_unavailable', 503);
    // Phone or email only (security review #249): a userId would let an organizer probe accounts and
    // learn a stranger's contact; the mask below is of what the caller typed.
    let identifier = null;
    if (body.phone) {
      const phone = normalizePhone(body.phone);
      if (!phone) return fail('invalid_contact', 400);
      identifier = { phone };
    } else if (body.email) {
      const email = normalizeEmail(body.email);
      if (!email || !EMAIL.test(email)) return fail('invalid_contact', 400);
      identifier = { email };
    } else return fail('invalid_contact', 400);
    const me_ = await users.findByIdAsync(actorId);
    if (me_ && ((identifier.phone && normalizePhone(me_.phone) === identifier.phone) || (identifier.email && normalizeEmail(me_.email) === identifier.email))) return fail('cannot_invite_self', 422);
    // Already on this organizer's staff (any persona holding the identifier)?
    const holders = await db('User').where(b => { if (identifier.phone) b.orWhere({ phone: identifier.phone }); if (identifier.email) b.orWhereRaw('lower(email) = ?', [identifier.email]); }).select('id');
    if (holders.length) {
      const active = await db('EventOrganizerStaff').where({ organizerId: ctx.organizer.id, status: 'active' }).whereIn('userId', holders.map(h => h.id)).first('id');
      if (active) return fail('already_staff', 409);
    }
    const actor = { id: actorId, userType: ctx.role === 'owner' ? 'event_organizer' : 'organizer_staff', organizerRole: ctx.role };
    const r = await invitations.create({ actor, orgType: 'organizer', orgId: ctx.organizer.id, body: { ...identifier, role: 'staff', organizerRole: role, locale: body.locale } });
    if (r.error) {
      if (['already_a_member', 'already_owner'].includes(r.error)) return fail('already_staff', 409);
      if (r.error === 'one_phone_or_email_required') return fail('invalid_contact', 400);
      return r;
    }
    await audit(actorId, 'events.staff_invited', ctx.organizer.id, null, { invitationId: r.invitation.id, role, identifierType: r.invitation.identifierType });
    return { status: 201, invitation: { id: r.invitation.id, role, status: 'invited', maskedContact: maskContact(identifier), expiresAt: r.invitation.expiresAt, delivery: r.delivery ?? null, created: r.created } };
  }

  async function changeStaffRole({ ctx, staffId, body = {}, actorId }) {
    if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
    if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
    if (!canManageStaff(ctx.role)) return fail('forbidden_role', 403);
    const target = await catalogue.getStaff(ctx.organizer.id, staffId);
    if (!target) return fail('staff_not_found', 404);
    const refusal = roleChangeRefusal(ctx.role, target.role, String(body.role || ''));
    if (refusal === 'invalid_role') return fail('invalid_role', 400, { allowed: [...INVITABLE_ORGANIZER_ROLES] });
    if (refusal) return fail(refusal, refusal === 'cannot_remove_owner' ? 409 : 403);
    const saved = await catalogue.setStaffRole(ctx.organizer.id, staffId, body.role);
    await users.updateByIdAsync(target.userId, { organizerRole: body.role, updatedAt: nowIso() });
    await audit(actorId, 'events.staff_role_changed', staffId, { role: target.role }, { role: body.role });
    return { id: saved.id, role: saved.role };
  }

  async function removeStaff({ ctx, staffId, actorId }) {
    if (ctx.organizer.status === 'suspended') return fail('organizer_suspended', 403);
    if (ctx.organizer.status !== 'active') return fail('organizer_not_active', 403);
    if (!canManageStaff(ctx.role)) return fail('forbidden_role', 403);
    const target = await catalogue.getStaff(ctx.organizer.id, staffId);
    if (!target) {
      // An open invitation can be withdrawn through the same route.
      if (invitations && staffId.startsWith('inv_')) {
        const actor = { id: actorId, userType: ctx.role === 'owner' ? 'event_organizer' : 'organizer_staff', organizerRole: ctx.role };
        const r = await invitations.cancel({ actor, orgType: 'organizer', orgId: ctx.organizer.id, invitationId: staffId });
        return r.error ? fail('staff_not_found', 404) : { removed: true, invitation: true };
      }
      return fail('staff_not_found', 404);
    }
    if (target.userId === actorId) return fail('cannot_remove_self', 409);
    const refusal = removalRefusal(ctx.role, target.role);
    if (refusal) return fail(refusal, refusal === 'cannot_remove_owner' ? 409 : 403);
    await catalogue.removeStaff(ctx.organizer.id, staffId);
    // The persona stays (history), but it no longer opens the organizer; the I4 hook ends the membership.
    await users.updateByIdAsync(target.userId, { organizerId: null, organizerRole: null, updatedAt: nowIso() });
    await audit(actorId, 'events.staff_removed', staffId, { role: target.role, userId: target.userId }, null);
    return { removed: true };
  }

  // ── KYC hook: the derived organizer status (spec §2) ────────────────────

  async function syncOrganizerStatus(kycCase, { reasonNote = null } = {}) {
    if (kycCase?.partnerType !== 'event_organizer') return null;
    const organizer = (await catalogue.organizerByKycCase(kycCase.id)) || (await catalogue.organizerOfOwner(kycCase.userId));
    if (!organizer) return null;
    const status = organizerStatusOf(kycCase);
    if (organizer.status === status && (organizer.statusReason ?? null) === (['rejected', 'suspended'].includes(status) ? (reasonNote || kycCase.reasonNote || 'kyc') : null)) return organizer;
    const saved = await catalogue.setOrganizerStatus(organizer.id, status, reasonNote || kycCase.reasonNote || null);
    await audit('system', 'events.organizer_status', organizer.id, { status: organizer.status }, { status, kycCaseId: kycCase.id, kycStatus: kycCase.status });
    return saved;
  }

  // ── The eventLifecycle job (§7.1 automatic transitions) ─────────────────

  async function runLifecycle({ at = now() } = {}) {
    const due = await catalogue.dueTransitions({ at, graceMs: autoCompleteGraceHours() * 3_600_000 });
    const out = { due: due.length, moved: 0, skipped: 0, failed: 0 };
    for (const d of due) {
      try {
        const r = await moveEvent(d.id, d.to, { actor: { id: 'system', kind: 'system', role: null } });
        if (r.error) out.skipped += 1; else out.moved += 1;
      } catch (err) {
        out.failed += 1;
        console.warn('[events] lifecycle move failed', d.id, d.to, err?.message);
      }
    }
    return out;
  }

  return {
    createOrganizer, me, summary, listEvents, createEvent, getEvent, patchEvent, transition, deleteEvent, changes,
    listStaff, inviteStaff, changeStaffRole, removeStaff, syncOrganizerStatus, runLifecycle, moveEvent, actionsFor,
  };
}
