// WhatsApp REST surface.
// - The provider's webhook (delivery receipts, STOP / START replies) for
//   the communication module's WhatsApp channel, behind a shared secret.
// - Legacy sends through the Africa's Talking service: the internal OTP
//   route and admins' re-engagement messages.
//
// The trainer, vendor and gym-operator "send a WhatsApp to any user id"
// routes and the open /test/whatsapp route were removed (audit S2/S3): they
// let any trainer, vendor or operator message any member, with no check that
// they had anything to do with them, and no app called them. Business
// messages to members go through the Communication Center instead.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { timingSafeEqual } from 'node:crypto';
import { whatsAppService, whatsappChannelService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// System-to-system routes must not be callable by the public: anyone could
// otherwise make FitFlex send an arbitrary "OTP" to any member's WhatsApp.
// Callers present FITFLEX_INTERNAL_TOKEN; with no token configured the route
// is closed.
function hasInternalToken(req) {
  const expected = process.env.FITFLEX_INTERNAL_TOKEN;
  const given = req.headers?.['x-fitflex-internal-token'];
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Public (system) ──
export const sendOtp = {
  created, method: 'post', path: '/whatsapp/send-otp',
  description: 'System: send OTP via WhatsApp to user. POST { userId, code }. Requires x-fitflex-internal-token.',
  onRequest: async (req, res) => {
    if (!hasInternalToken(req)) return res.status(403).json({ error: 'forbidden' });
    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: 'userId_code_required' });
    const result = await whatsAppService.sendOtp(userId, code);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Admin ──
export const adminSendReengagementVendor = {
  created, method: 'post', path: '/admin/send-reengagement/vendor/:vendorId',
  description: 'Admin: send re-engagement campaign to inactive vendor.',
  onGuard: [requireAuth('admin'), requireAcl('vendors')],
  onRequest: async (req, res) => {
    const result = await whatsAppService.sendVendorReengagement(req.params.vendorId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminSendReengagementMember = {
  created, method: 'post', path: '/admin/send-reengagement/member/:memberId',
  description: 'Admin: send re-engagement campaign to inactive member (highlight trainer availability).',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const result = await whatsAppService.sendMemberReengagement(req.params.memberId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Provider webhook ──
// The callback URL registered with the provider carries a shared secret:
// ?token=<WHATSAPP_WEBHOOK_SECRET> (or the x-whatsapp-webhook-token header).
// With no secret configured the webhook is closed. Real adapters can add
// their provider's signature check on top in parseWebhook.
function hasWebhookToken(req) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  const given = req.headers?.['x-whatsapp-webhook-token'] ?? req.query?.token;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleWebhook(req, res) {
  if (!hasWebhookToken(req)) return res.status(403).json({ error: 'forbidden' });
  const result = await whatsappChannelService.handleWebhook({ body: req.body, headers: req.headers, query: req.query });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}

export const whatsappStatusWebhook = {
  created, method: 'post', path: '/webhooks/whatsapp/status',
  description: 'WhatsApp provider webhook: delivery receipts update the message ledger; STOP/ACHA replies opt the member out of WhatsApp, START/ANZA back in. Requires WHATSAPP_WEBHOOK_SECRET as ?token=.',
  requestSample: { statuses: [{ id: 'wamid_x', status: 'delivered', timestamp: 1790000000 }], messages: [{ from: '+255712345678', text: 'STOP' }] },
  onRequest: handleWebhook,
};

// Some providers confirm a webhook URL with a GET before using it.
export const whatsappWebhookVerify = {
  created, method: 'get', path: '/webhooks/whatsapp/status',
  description: 'WhatsApp provider webhook URL check (for providers that verify with a GET). Requires the same secret.',
  onRequest: async (req, res) => {
    if (!hasWebhookToken(req)) return res.status(403).json({ error: 'forbidden' });
    const answer = whatsappChannelService.provider.verifyWebhook?.(req.query || {});
    if (answer == null) return res.json({ ok: true });
    res.type?.('text/plain');
    res.send(String(answer));
  },
};

// The old inbound URL, kept for anything already pointing at it — now with
// the same secret and handling.
export const whatsappWebhook = {
  created, method: 'post', path: '/whatsapp/webhook',
  description: 'Old address of the WhatsApp provider webhook; same as POST /webhooks/whatsapp/status. Requires WHATSAPP_WEBHOOK_SECRET as ?token=.',
  onRequest: handleWebhook,
};
