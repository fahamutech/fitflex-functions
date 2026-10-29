// Marathon & running events · S2 — FitFlex admin moderation (spec §8, §14.4; decisions D11, D13).
// Every action writes an AuditLog row with the status before and after (`events.*` actions, read back by
// the audit routes). Approval (→ published) needs an active organizer whose KYC case is approved
// (follow-ups.md S2). Rejection sends the event back to draft with { reason, note, at } on the event.
import { organizerView, rowView, allowedActionsFor, parseNote, CANCEL_REASONS, REJECT_REASONS, DEFAULT_CLOSING_SOON_HOURS } from '../shared/events-document.mjs';
import { paginate } from '../shared/pagination.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

// S4: `getRefunds` is the events refund service (lazy; absent in unit contexts, where cancel is exactly the S2 one).
export function createEventsAdminService({ db, catalogue, organizerService, now = () => new Date(), closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS, getRefunds = () => null }) {
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
    };
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

  return { list, summary, detail, decision, cancel, cancelPreview, archive, complete, eventAudit, audit };
}
