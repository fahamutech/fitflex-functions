// Admin gym-settlement REST surface: see what the settlement service
// calculated, run a month by hand (Phase 3), and move a statement through
// the workflow — submit, approve, hold, pay (Phase 4). Preparing, approving
// and paying are separate permission scopes (DR-09).
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { settlementService, settlementWorkflowService, settlementViewService, settlementClawbackService } from '../src/bootstrap/services.mjs';
import { periodForMonth } from '../src/services/settlement-service.mjs';

const created = new Date().toISOString();
const guard = [requireAuth('admin'), requireAcl('payments')];

export const adminSettlementRuns = {
  created, method: 'get', path: '/admin/settlements/runs',
  description: 'Admin: settlement runs, newest first. Optional ?mode=live|shadow.',
  onGuard: guard,
  onRequest: async (req, res) => res.json(await settlementService.listRuns({ mode: req.query?.mode, limit: req.query?.limit }))
};

export const adminSettlementRun = {
  created, method: 'get', path: '/admin/settlements/runs/:id',
  description: 'Admin: one settlement run with its gym statements, totals and skipped cycles.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const result = await settlementViewService.adminRun(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const adminRunSettlement = {
  created, method: 'post', path: '/admin/settlements/runs',
  description: 'Admin: calculate and store one EAT month. mode "shadow" (default) stores a run that can never be paid; "live" stores the real one (once per month, only after the month has ended). Nothing is approved or paid.',
  requestSample: { month: '2026-10', mode: 'shadow' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_prepare')],
  onRequest: async (req, res) => {
    const { month, mode = 'shadow' } = req.body || {};
    const period = periodForMonth(month);
    if (!period) return res.status(400).json({ error: 'invalid_month' });
    const result = await settlementService.run({ ...period, mode, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (result.skipped) return res.status(409).json({ error: 'settlement_run_in_progress' });
    // New draft statements can take clawbacks that were waiting for one.
    if (mode === 'live' && !result.alreadyRun) await settlementClawbackService.sweepQuietly({ actorId: req.user?.sub });
    res.status(result.alreadyRun ? 200 : 201).json(result);
  }
};

export const adminSettlementStatement = {
  created, method: 'get', path: '/admin/settlements/statements/:id',
  description: 'Admin: one gym statement with its lines (member cycle at the gym), the check-ins behind each line, and adjustments.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const result = await settlementViewService.adminStatement(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

// ── workflow (settlement Phase 4) ───────────────────────────────────────────

const respond = (res, result) => {
  if (result.error) {
    const { error, status, ...detail } = result;
    return res.status(status || 409).json({ error, ...detail });
  }
  res.json(result);
};

export const adminSettlementStatements = {
  created, method: 'get', path: '/admin/settlements/statements',
  description: 'Admin: gym statements, newest period first. Optional ?status=, ?gymId=, ?mode=live|shadow (default live).',
  onGuard: guard,
  onRequest: async (req, res) => res.json((await settlementWorkflowService.list({ status: req.query?.status, gymId: req.query?.gymId, mode: req.query?.mode || 'live', limit: req.query?.limit })).map(settlementViewService.withGym))
};

export const adminSubmitStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/submit',
  description: 'Admin: submit a draft statement for approval. Its amounts are frozen from here.',
  onGuard: [requireAuth('admin'), requireAcl('settlements_prepare')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.submit({ id: req.params.id, actorId: req.user?.sub }))
};

export const adminRejectStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/reject',
  description: 'Admin: send a submitted statement back to draft, with a reason.',
  requestSample: { reason: 'Visit count looks wrong for 12 Oct' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => {
    const result = await settlementWorkflowService.reject({ id: req.params.id, reason: req.body?.reason, actorId: req.user?.sub });
    // Back in draft, the statement can take a clawback that was waiting.
    if (!result.error) await settlementClawbackService.sweepQuietly({ actorId: req.user?.sub });
    respond(res, result);
  }
};

export const adminApproveStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/approve',
  description: 'Admin: approve a submitted statement. The approver must not be the person who submitted it.',
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.approve({ id: req.params.id, actorId: req.user?.sub }))
};

export const adminHoldStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/hold',
  description: 'Admin: put a statement on hold, with a reason. A payable statement goes back to approved.',
  requestSample: { reason: 'Gym disputes two visits' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_prepare')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.hold({ id: req.params.id, reason: req.body?.reason, actorId: req.user?.sub }))
};

export const adminReleaseStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/release',
  description: 'Admin: lift a hold. The statement keeps its status.',
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.release({ id: req.params.id, actorId: req.user?.sub }))
};

export const adminMarkStatementPayable = {
  created, method: 'post', path: '/admin/settlements/statements/:id/payable',
  description: 'Admin: clear an approved statement for payment. Refused while it is on hold, has nothing to pay, or the gym fails the payout check (KYC approved and a verified payout account past its cooling-off).',
  onGuard: [requireAuth('admin'), requireAcl('settlements_pay')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.markPayable({ id: req.params.id, actorId: req.user?.sub }))
};

export const adminPayStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/pay',
  description: 'Admin: record that a payable statement was paid. Needs a payment reference; the payout check runs again. A paid statement is final.',
  requestSample: { paymentReference: 'MPESA-QK7H2L9', receiptUrl: 'https://…/receipt.png' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_pay')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.pay({ id: req.params.id, paymentReference: req.body?.paymentReference, receiptUrl: req.body?.receiptUrl, actorId: req.user?.sub }))
};

export const adminVoidStatement = {
  created, method: 'post', path: '/admin/settlements/statements/:id/void',
  description: 'Admin: void a draft, submitted or approved statement, with a reason. It will never be paid and its visits are not settled again; its adjustments are cancelled, and a carried-forward shortfall or clawback among them is raised again on the gym\'s next statement. A payable statement must be put on hold first; a paid one is final. To pay later instead, use hold.',
  requestSample: { reason: 'Gym left the network; nothing is owed for October' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => {
    const result = await settlementWorkflowService.voidStatement({ id: req.params.id, reason: req.body?.reason, actorId: req.user?.sub });
    if (!result.error) await settlementClawbackService.sweepQuietly({ actorId: req.user?.sub });
    respond(res, result);
  }
};

// ── adjustments (DR-20) ─────────────────────────────────────────────────────

export const adminProposeAdjustment = {
  created, method: 'post', path: '/admin/settlements/statements/:id/adjustments',
  description: 'Admin: propose a signed adjustment on a draft statement (type correction, clawback or manual; a clawback is negative). It changes nothing until someone else applies it.',
  requestSample: { amountTzs: -3500, type: 'clawback', reason: 'Visit voided after last month was paid', sourceCheckinId: 'chk_123' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_prepare')],
  onRequest: async (req, res) => {
    const { amountTzs, type, reason, sourceCheckinId, sourceSettlementId } = req.body || {};
    const result = await settlementWorkflowService.proposeAdjustment({ statementId: req.params.id, amountTzs, type, reason, sourceCheckinId, sourceSettlementId, actorId: req.user?.sub });
    if (result.error) return respond(res, result);
    res.status(201).json(result);
  }
};

export const adminApplyAdjustment = {
  created, method: 'post', path: '/admin/settlements/adjustments/:id/apply',
  description: 'Admin: apply a proposed adjustment to its draft statement. The approver must not be the person who proposed it. The statement\'s net never goes below zero: a shortfall is carried forward.',
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.decideAdjustment({ id: req.params.id, decision: 'apply', actorId: req.user?.sub }))
};

export const adminRejectAdjustment = {
  created, method: 'post', path: '/admin/settlements/adjustments/:id/reject',
  description: 'Admin: reject a proposed adjustment, with a reason.',
  requestSample: { reason: 'Already corrected last month' },
  onGuard: [requireAuth('admin'), requireAcl('settlements_approve')],
  onRequest: async (req, res) => respond(res, await settlementWorkflowService.decideAdjustment({ id: req.params.id, decision: 'reject', reason: req.body?.reason, actorId: req.user?.sub }))
};

// ── clawbacks after a voided check-in (DR-20) ───────────────────────────────

const withGyms = (r) => ({ ...r, raised: (r.raised || []).map(settlementViewService.withGym), pending: (r.pending || []).map(settlementViewService.withGym) });

export const adminSettlementClawbacks = {
  created, method: 'get', path: '/admin/settlements/clawbacks',
  description: 'Admin: what a sweep would do now, without doing it. "pending" are differences from voided check-ins whose gym has no draft statement to take them yet; "raised" would be proposed on a draft; "skipped" are member cycles that need a person (a disputed visit, or amounts that can no longer be reproduced).',
  onGuard: guard,
  onRequest: async (req, res) => res.json(withGyms(await settlementClawbackService.sweep({ dryRun: true })))
};

export const adminSweepSettlementClawbacks = {
  created, method: 'post', path: '/admin/settlements/clawbacks/sweep',
  description: 'Admin: recalculate settled member cycles that have a check-in voided since, and propose each gym\'s difference on its draft statement. Runs by itself when a check-in is voided, after each live run, and when a statement is rejected or voided; safe to repeat.',
  onGuard: [requireAuth('admin'), requireAcl('settlements_prepare')],
  onRequest: async (req, res) => res.json(withGyms(await settlementClawbackService.sweep({ actorId: req.user?.sub })))
};
