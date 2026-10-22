// Marathon & running events · S2 — FitFlex admin moderation (spec §8, §14.4; decisions D11, D13).
// Every action writes an AuditLog row with the status before and after (`events.*` actions, read back by
// the audit routes). Approval (→ published) needs an active organizer whose KYC case is approved
// (follow-ups.md S2). Rejection sends the event back to draft with { reason, note, at } on the event.
import { organizerView, rowView, allowedActionsFor, CANCEL_REASONS, REJECT_REASONS, DEFAULT_CLOSING_SOON_HOURS } from '../shared/events-document.mjs';
import { paginate } from '../shared/pagination.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

export function createEventsAdminService({ db, catalogue, organizerService, now = () => new Date(), closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS }) {
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
    const moved = await organizerService.moveEvent(joined.event.id, 'cancelled', {
      actor: { id: actorId, kind: 'admin', role: 'admin' }, cancellation: { reason: body.reason, note: { en: body.note?.en ?? null, sw: body.note?.sw ?? null } },
    });
    if (moved.error) return moved;
    return { status: moved.status };
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

  return { list, summary, detail, decision, cancel, archive, complete, eventAudit, audit };
}
