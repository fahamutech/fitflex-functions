// Marathon & running events · S2 — FitFlex admin moderation (spec §8, §14.4; decisions D11, D13).
// Every action writes an AuditLog row with the status before and after (`events.*` actions, read back by
// the audit routes). Approval (→ published) needs an active organizer whose KYC case is approved
// (follow-ups.md S2). Rejection sends the event back to draft with { reason, note, at } on the event.
import { randomUUID } from 'node:crypto';
import { organizerView, rowView, allowedActionsFor, parseNote, CANCEL_REASONS, REJECT_REASONS, DEFAULT_CLOSING_SOON_HOURS, PAYOUT_SCHEDULES } from '../shared/events-document.mjs';
import { paginate } from '../shared/pagination.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

// S4: `getRefunds` is the events refund service (lazy; absent in unit contexts, where cancel is exactly the S2 one).
export function createEventsAdminService({
  db, catalogue, organizerService, now = () => new Date(), closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS, getRefunds = () => null,
  // S5: tell the organizer's owner and admins (bilingual in-app notice); absent in unit contexts.
  notifyTeam = null,
}) {
  const viewOpts = () => ({ now: now(), closingSoonHours: closingSoonHours() });
  const actionsFor = status => allowedActionsFor({ status, actor: 'admin' });

  async function permitOnFile(organizer) {
    if (!organizer?.kycCaseId) return false;
    const doc = await db('PartnerDocument').where({ caseId: organizer.kycCaseId, requirementKey: 'event_permit' }).whereNotIn('status', ['superseded', 'rejected', 'expired']).whereNotNull('storageKey').first('id');
    return Boolean(doc);
  }

  const organizerCard = (o, permit) => (o ? { id: o.id, name: o.name, status: o.status, kycCaseId: o.kycCaseId ?? null, permitOnFile: permit } : null);

  async function list({ query = {} }) {
    const status = query.status && query.status !== 'all' ? String(query.status) : null;
    const joined = await catalogue.listForAdmin({ status });
    const permits = new Map();
    const rows = [];
    for (const j of joined) {
      if (!permits.has(j.event.organizerId)) permits.set(j.event.organizerId, await permitOnFile(j.organizer));
      const permit = permits.get(j.event.organizerId);
      rows.push({ ...rowView(j, { ...viewOpts(), allowedActions: actionsFor(j.event.status) }), organizer: organizerCard(j.organizer, permit), permitOnFile: permit });
    }
    return paginate(rows, { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
  }

  async function summary() {
    return { submitted: await catalogue.countByStatus('submitted') };
  }

  async function detail({ eventId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    const permit = await permitOnFile(joined.organizer);
    return {
      ...organizerView(joined, { ...viewOpts(), allowedActions: actionsFor(joined.event.status), changeLogCount: await catalogue.countChangeLog(joined.event.id) }),
      organizer: organizerCard(joined.organizer, permit), permitOnFile: permit,
      // S7 (additive): the reward switch (H6) and the waitlist at a glance (counts only).
      rewardsEligible: joined.event.rewardsEligible === true,
      waitlist: await waitlistCounts(joined.event.id),
    };
  }

  /** Counts of waitlist entries by status for the admin event view; zeros while the table is empty. */
  async function waitlistCounts(eventId) {
    try {
      const rows = await db('EventWaitlistEntry').where({ eventId }).groupBy('status').select('status').count({ n: '*' });
      return { enabled: undefined, waiting: Number(rows.find(r => r.status === 'waiting')?.n ?? 0), offered: Number(rows.find(r => r.status === 'offered')?.n ?? 0) };
    } catch { return null; }
  }

  async function decision({ eventId, body = {}, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (body.decision === 'approve') {
      if (joined.event.status !== 'submitted') return fail('invalid_transition', 409, { from: joined.event.status, to: 'published', allowed: [] });
      // Only a verified organizer publishes (D11 + the S2 follow-up): active organizer, approved case.
      const kycCase = joined.organizer?.kycCaseId ? await db('PartnerKycCase').where({ id: joined.organizer.kycCaseId }).first('status') : null;
      if (joined.organizer?.status !== 'active' || kycCase?.status !== 'approved') return fail('organizer_not_active', 409, { organizerStatus: joined.organizer?.status ?? null });
      const moved = await organizerService.moveEvent(joined.event.id, 'published', { actor: { id: actorId, kind: 'admin', role: 'admin' }, note: note || null });
      if (moved.error) return moved;
      return { status: moved.status, publishedAt: new Date(moved.event.publishedAt).toISOString() };
    }
    if (body.decision === 'reject') {
      if (joined.event.status !== 'submitted') return fail('invalid_transition', 409, { from: joined.event.status, to: 'draft', allowed: [] });
      if (!REJECT_REASONS.includes(body.reason)) return fail('reason_code_required', 400, { allowed: [...REJECT_REASONS] });
      if (!note) return fail('note_required', 400);
      const moved = await organizerService.moveEvent(joined.event.id, 'draft', { actor: { id: actorId, kind: 'admin', role: 'admin' }, rejection: { reason: body.reason, note } });
      if (moved.error) return moved;
      return { status: moved.status };
    }
    return fail('invalid_decision', 400, { allowed: ['approve', 'reject'] });
  }

  async function cancel({ eventId, body = {}, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    if (!CANCEL_REASONS.includes(body.reason)) return fail('reason_code_required', 400, { allowed: [...CANCEL_REASONS] });
    const note = parseNote(body.note);
    if (note.error) return note;
    // S4: the money the dialog showed must still be the money (checked before the irreversible move).
    const refunds = getRefunds();
    const raise = refunds && body.refundPaidOrders !== false;
    if (raise) {
      const preview = await refunds.eventCancelPreview({ eventId });
      if (preview.error) return preview;
      // The money the dialog showed must be sent back whenever paid orders exist (ruling c).
      if (preview.paidOrders > 0 && body.expectedRefundableTzs == null) return fail('expected_refundable_required', 400, { refundableTzs: preview.refundableTzs });
      if (body.expectedRefundableTzs != null && Number(body.expectedRefundableTzs) !== preview.refundableTzs) return fail('refundable_changed', 409, { refundableTzs: preview.refundableTzs });
    }
    const moved = await organizerService.moveEvent(joined.event.id, 'cancelled', {
      actor: { id: actorId, kind: 'admin', role: 'admin' }, cancellation: { reason: body.reason, note: note.note ?? { en: null, sw: null } },
    });
    if (moved.error) return moved;
    // Awaiting orders are released, paid places cancelled with tickets revoked, one refund request per paid order (idempotent, resumable).
    if (raise) {
      let batch;
      try { batch = await refunds.runEventBatch({ eventId, actorId }); } catch (err) { batch = { error: 'batch_failed', message: String(err?.message ?? err).slice(0, 200) }; }
      // The event is cancelled either way; an error is shown to the admin, who resumes with POST …/refund-batch (the sweep also does).
      if (batch.error) return { status: moved.status, batch: { error: batch.error, status: batch.status ?? null, resumeWith: `/admin/events/${eventId}/refund-batch` } };
      if (batch.touched) return { status: moved.status, batch: { batchId: batch.batchId, created: batch.created, existing: batch.existing, remaining: batch.remaining, amountTzs: batch.amountTzs, released: batch.released, failed: batch.failed } };
    }
    return { status: moved.status };
  }

  /** GET /admin/events/:id/cancel-preview — what cancelling would do to money, before the dialog confirms. */
  async function cancelPreview({ eventId }) {
    const refunds = getRefunds();
    if (!refunds) return fail('feature_disabled', 404);
    return refunds.eventCancelPreview({ eventId });
  }

  /**
   * S5 (D33): the ONLY way the payout schedule changes once the organizer has submitted. A published (or later) event, a scope-`events`
   * admin, a reason of 10–300 characters. Writes AuditLog `events.payout_schedule_changed` { before, after, reason }, an EventChangeLog row
   * (field payoutSchedule, not material, actor role admin) and tells the organizer's owner and admins. Not a material change: participants never see it.
   */
  async function changePayoutSchedule({ eventId, body = {}, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    if (!PAYOUT_SCHEDULES.includes(body.payoutSchedule)) return fail('event_invalid', 422, { fields: [{ path: 'payoutSchedule', code: 'invalid' }] });
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 10 || reason.length > 300) return fail('reason_required', 422, { min: 10, max: 300 });
    if (!['published', 'registration_closed', 'in_progress', 'completed'].includes(joined.event.status)) return fail('invalid_transition', 409, { from: joined.event.status, to: 'payout_schedule', allowed: [] });
    const before = joined.event.payoutSchedule ?? null;
    if (before === body.payoutSchedule) return { payoutSchedule: before, changed: false };
    await catalogue.patchEventRaw(joined.event.id, { payoutSchedule: body.payoutSchedule });
    await db('AuditLog').insert({
      id: `aud_${randomUUID().slice(0, 12)}`, at: now(), actor: actorId, action: 'events.payout_schedule_changed', target: joined.event.id,
      before: JSON.stringify({ payoutSchedule: before }), after: JSON.stringify({ payoutSchedule: body.payoutSchedule, reason }),
    });
    await catalogue.appendChangeLog({ eventId: joined.event.id, actorUserId: actorId, actorRole: 'admin', fields: ['payoutSchedule'], before: { payoutSchedule: before }, after: { payoutSchedule: body.payoutSchedule }, note: null, material: false });
    if (notifyTeam) {
      const label = { biweekly: ['every two weeks', 'kila wiki mbili'], monthly: ['once a month', 'mara moja kwa mwezi'] }[body.payoutSchedule];
      try {
        await notifyTeam(joined.event.organizerId, {
          id: `ntf_evpay_${joined.event.id}_${Date.now()}`, type: 'organizer_payout_schedule_changed',
          en: { title: 'Payout schedule changed', body: `FitFlex changed the payout schedule for ${joined.event.title} to ${label[0]}.` },
          sw: { title: 'Ratiba ya malipo imebadilishwa', body: `FitFlex imebadilisha ratiba ya malipo ya ${joined.event.title} kuwa ${label[1]}.` },
        });
      } catch { /* the change stands; the notice is best effort */ }
    }
    return { payoutSchedule: body.payoutSchedule, changed: true };
  }

  async function archive({ eventId, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    const moved = await organizerService.moveEvent(joined.event.id, 'archived', { actor: { id: actorId, kind: 'admin', role: 'admin' } });
    if (moved.error) return moved;
    return { status: moved.status };
  }

  async function complete({ eventId, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    const moved = await organizerService.moveEvent(joined.event.id, 'completed', { actor: { id: actorId, kind: 'admin', role: 'admin' } });
    if (moved.error) return moved;
    return { status: moved.status };
  }

  // ── Audit (reads AuditLog rows whose action starts with events.) ────────

  const auditView = (row, names) => ({
    id: row.id, at: new Date(row.at).toISOString(), actor: { id: row.actor, name: names.get(row.actor) ?? null }, action: row.action, target: row.target,
    reason: row.after?.reason ?? null, note: row.after?.note ?? null, before: row.before ?? null, after: row.after ?? null,
  });

  async function auditRows({ target = null, action = null, limit = 500 }) {
    let q = db('AuditLog').whereILike('action', 'events.%');
    if (target) q = q.where({ target });
    if (action) q = q.where({ action: action.startsWith('events.') ? action : `events.${action}` });
    const rows = (await q.orderBy([{ column: 'at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit)).map(r => ({ ...r, before: typeof r.before === 'string' ? JSON.parse(r.before) : r.before, after: typeof r.after === 'string' ? JSON.parse(r.after) : r.after }));
    const actorIds = [...new Set(rows.map(r => r.actor).filter(a => a && a !== 'system'))];
    const names = new Map(actorIds.length ? (await db('User').whereIn('id', actorIds).select('id', 'displayName')).map(u => [u.id, u.displayName]) : []);
    return rows.map(r => auditView(r, names));
  }

  async function eventAudit({ eventId, query = {} }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    return paginate(await auditRows({ target: joined.event.id }), { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
  }

  async function audit({ query = {} }) {
    return paginate(await auditRows({ action: query.action ? String(query.action) : null }), { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
  }


  // ── S7: incident controls (H6, H16, H17; docs/design/events-s7-hardening-and-pilot.md §6.1, D80, D84, D85) ──────────────────

  const reasonOf = (body) => {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 10 || reason.length > 300) return fail('reason_required', 422, { min: 10, max: 300 });
    let reasonSw = null;
    if (body.reasonSw !== undefined && body.reasonSw !== null && body.reasonSw !== '') {
      reasonSw = String(body.reasonSw).trim();
      if (reasonSw.length < 10 || reasonSw.length > 300) return fail('reason_required', 422, { min: 10, max: 300, field: 'reasonSw' });
    }
    return { reason, reasonSw: reasonSw ?? `(kwa Kiingereza) ${reason}` , explicitSw: reasonSw !== null };
  };
  const auditRow = (actorId, action, target, before, after) => db('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: now(), actor: actorId, action, target, before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  /** H16 (D85): pause (published → registration_closed) or resume (→ published) one event's registrations. Reason required; the organizer is told. */
  async function setRegistrationState({ eventId, body = {}, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    if (!['closed', 'open'].includes(body.state)) return fail('validation_failed', 422, { fields: [{ path: 'state', code: 'invalid' }] });
    const why = reasonOf(body);
    if (why.error) return why;
    const to = body.state === 'closed' ? 'registration_closed' : 'published';
    const from = joined.event.status;
    if (from !== (to === 'published' ? 'registration_closed' : 'published')) return fail('invalid_transition', 409, { from, to });
    if (to === 'published' && joined.event.registrationClosesAt && +new Date(joined.event.registrationClosesAt) <= +now()) return fail('registration_window_over', 409);
    const moved = await organizerService.moveEvent(joined.event.id, to, { actor: { id: actorId, kind: 'admin', role: 'admin' }, note: why.reason });
    if (moved.error) return moved;
    await auditRow(actorId, 'events.admin_registration_state_changed', joined.event.id, { status: from }, { status: to, reason: why.reason });
    if (notifyTeam) {
      const paused = to === 'registration_closed';
      try {
        await notifyTeam(joined.event.organizerId, {
          id: `ntf_evrs_${joined.event.id}_${Date.now()}`, type: paused ? 'organizer_registration_paused' : 'organizer_registration_resumed',
          en: paused ? { title: 'Registrations paused', body: `FitFlex paused registrations for ${joined.event.title}. ${why.reason}` } : { title: 'Registrations resumed', body: `FitFlex resumed registrations for ${joined.event.title}. ${why.reason}` },
          sw: paused ? { title: 'Usajili umesitishwa', body: `FitFlex imesitisha usajili wa ${joined.event.title}. ${why.reasonSw}` } : { title: 'Usajili umeendelea', body: `FitFlex imeruhusu usajili wa ${joined.event.title} kuendelea. ${why.reasonSw}` },
        });
      } catch { /* the move stands; the notice is best effort */ }
    }
    return { eventStatus: to, from };
  }

  /** H6 (D80): the per-event reward switch. Medals are unaffected; rewards are earned only while this is true (default false). */
  async function setRewardsEligible({ eventId, body = {}, actorId }) {
    const joined = await catalogue.loadJoined(eventId);
    if (!joined) return fail('event_not_found', 404);
    if (typeof body.eligible !== 'boolean') return fail('validation_failed', 422, { fields: [{ path: 'eligible', code: 'boolean' }] });
    const why = reasonOf(body);
    if (why.error) return why;
    const before = joined.event.rewardsEligible === true;
    if (before === body.eligible) return { rewardsEligible: before, changed: false };
    await db('Event').where({ id: joined.event.id }).update({ rewardsEligible: body.eligible, updatedAt: now() });
    await auditRow(actorId, 'events.rewards_eligible_changed', joined.event.id, { rewardsEligible: before }, { rewardsEligible: body.eligible, reason: why.reason });
    if (notifyTeam) {
      try {
        await notifyTeam(joined.event.organizerId, {
          id: `ntf_evre_${joined.event.id}_${Date.now()}`, type: 'organizer_rewards_eligibility_changed',
          en: { title: 'Rewards setting changed', body: `Rewards for ${joined.event.title} are now ${body.eligible ? 'on' : 'off'}.` },
          sw: { title: 'Mpangilio wa zawadi umebadilika', body: `Zawadi za ${joined.event.title} sasa ${body.eligible ? 'zimewashwa' : 'zimezimwa'}.` },
        });
      } catch { /* best effort */ }
    }
    return { rewardsEligible: body.eligible, changed: true };
  }

  /** H17: find an organizer without a direct API call (the Operations tab). */
  async function listOrganizers({ query = {} }) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
    let q = db('EventOrganizer as o').orderBy([{ column: 'o.name' }, { column: 'o.id' }]);
    const term = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
    if (term) q = q.where(b => b.whereILike('o.name', `%${term.replace(/[%_]/g, m => `\\${m}`)}%`).orWhere('o.id', term));
    if (query.apiAccess === 'true' || query.apiAccess === 'false') q = query.apiAccess === 'true' ? q.whereNotNull('o.apiAccessEnabledAt') : q.whereNull('o.apiAccessEnabledAt');
    if (query.cursor) { const after = Buffer.from(String(query.cursor), 'base64url').toString('utf8'); const [name, id] = after.split('\u0000'); if (name === undefined || !id) return fail('invalid_cursor', 400); q = q.whereRaw('(o.name, o.id) > (?, ?)', [name, id]); }
    const rows = await q.limit(limit + 1).select('o.id', 'o.name', 'o.status', 'o.apiAccessEnabledAt');
    const page = rows.slice(0, limit);
    const ids = page.map(r => r.id);
    const clients = ids.length ? await db('ApiClient').where({ ownerType: 'organizer', status: 'active' }).whereIn('ownerId', ids).groupBy('ownerId').select('ownerId').count({ n: '*' }) : [];
    const hooks = ids.length ? await db('WebhookEndpoint').where({ status: 'active' }).whereIn('organizerId', ids).groupBy('organizerId').select('organizerId').count({ n: '*' }) : [];
    const last = page[page.length - 1];
    return {
      items: page.map(r => ({
        id: r.id, name: r.name, status: r.status, apiAccessEnabled: Boolean(r.apiAccessEnabledAt),
        activeClients: Number(clients.find(c => c.ownerId === r.id)?.n ?? 0), activeEndpoints: Number(hooks.find(c => c.organizerId === r.id)?.n ?? 0),
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.name}\u0000${last.id}`).toString('base64url') : null,
    };
  }

  return { list, summary, detail, decision, cancel, cancelPreview, archive, complete, eventAudit, audit, changePayoutSchedule, setRegistrationState, setRewardsEligible, listOrganizers };
}
