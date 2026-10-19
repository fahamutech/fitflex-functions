// WhatsApp through Meta's own Cloud API (decided 15 Oct 2026), behind the
// provider contract in provider.mjs. Chosen with WHATSAPP_PROVIDER=meta and
// these settings — never in code or the database:
//
//   WHATSAPP_META_ACCESS_TOKEN         a system-user token with the
//                                      whatsapp_business_messaging and
//                                      whatsapp_business_management permissions
//   WHATSAPP_META_PHONE_NUMBER_ID      the sending number's id (not the number)
//   WHATSAPP_META_BUSINESS_ACCOUNT_ID  the WhatsApp Business Account id, for
//                                      reading template approvals
//   WHATSAPP_META_API_VERSION          optional, default below
//
// Templates are created in Meta's WhatsApp Manager with NAMED variables —
// {{member_name}}, {{gym_name}} … exactly as the admin WhatsApp page lists
// them — in English (code "en") and Swahili ("sw"). Sends then name each
// value, so the order can't go wrong. A template made with numbered
// variables ({{1}}, {{2}}) still works: values go in the registry's order.
//
// The webhook (POST/GET /webhooks/whatsapp/status?token=<WHATSAPP_WEBHOOK_SECRET>)
// receives Meta's delivery receipts and replies; the same secret is the
// "verify token" Meta asks for when the callback URL is saved.
import { ERRORS, validateRecipient } from './provider.mjs';

export const META_DEFAULT_API_VERSION = 'v23.0';
const GRAPH = 'https://graph.facebook.com';
const TIMEOUT_MS = 15_000;

// Meta's error codes → the contract's errors. Anything not listed fails the
// message for good, except server-side (5xx) trouble, which is retried.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const RETRY = { retryable: true };
const FINAL = { retryable: false };
// Built on first use: provider.mjs imports this file, so ERRORS isn't ready
// while this module is first evaluated.
let metaErrors = null;
const META_ERRORS = () => metaErrors ??= new Map([
  [131026, { error: ERRORS.invalidRecipient, ...FINAL }],    // not a WhatsApp user / can't receive
  [131050, { error: ERRORS.optedOut, ...FINAL }],            // they stopped marketing messages from us
  [132000, { error: 'bad_parameters', ...FINAL }],           // wrong number of variables
  [132001, { error: ERRORS.templateNotApproved, ...FINAL }], // template doesn't exist in that language
  [132005, { error: 'bad_parameters', ...FINAL }],           // a value is too long
  [132007, { error: ERRORS.templateNotApproved, ...FINAL }], // template breaks a format policy
  [132012, { error: 'bad_parameters', ...FINAL }],           // a value has the wrong format
  [132015, { error: ERRORS.templateNotApproved, ...FINAL }], // template paused
  [132016, { error: ERRORS.templateNotApproved, ...FINAL }], // template disabled
  [131047, { error: 'outside_reply_window', ...FINAL }],     // free text more than 24h after they wrote
  [130429, { error: ERRORS.rateLimited, ...RETRY }],         // throughput limit
  [131048, { error: ERRORS.rateLimited, ...RETRY }],         // spam rate limit
  [131056, { error: ERRORS.rateLimited, ...RETRY }],         // too many to one person
  [80007, { error: ERRORS.rateLimited, ...RETRY }],
  [4, { error: ERRORS.rateLimited, ...RETRY }],
  [131000, { error: ERRORS.unavailable, ...RETRY }],         // something went wrong at Meta
  [131016, { error: ERRORS.unavailable, ...RETRY }],         // service unavailable
  [1, { error: ERRORS.unavailable, ...RETRY }],
  [2, { error: ERRORS.unavailable, ...RETRY }],
  [190, { error: 'auth_failed', ...FINAL }],                 // token expired or revoked
  [10, { error: 'auth_failed', ...FINAL }],                  // permission missing
  [200, { error: 'auth_failed', ...FINAL }],
]);

const VARIABLE_RE = /\{\{\s*([a-z_][a-z0-9_]*|\d+)\s*\}\}/g;
const STATUS_MAP = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'paused', LIMIT_EXCEEDED: 'paused' };
const DELIVERY = new Set(['sent', 'delivered', 'read', 'failed']);

/** Meta wants the number in international form without the "+". */
const metaNumber = (e164) => String(e164).replace(/^\+/, '');

function failure(res, body) {
  const err = body?.error || {};
  const known = META_ERRORS().get(Number(err.code));
  const detail = [err.code, err.error_subcode, err.error_data?.details || err.message].filter(Boolean).join(': ').slice(0, 200);
  if (known) return { ok: false, ...known, detail };
  return { ok: false, error: res.status >= 500 ? ERRORS.unavailable : 'provider_error', retryable: res.status >= 500, detail };
}

export function createMetaWhatsAppProvider({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const token = env.WHATSAPP_META_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_META_PHONE_NUMBER_ID;
  const businessAccountId = env.WHATSAPP_META_BUSINESS_ACCOUNT_ID;
  const version = String(env.WHATSAPP_META_API_VERSION || META_DEFAULT_API_VERSION).trim();
  const verifyToken = env.WHATSAPP_WEBHOOK_SECRET || null;
  const base = `${GRAPH}/${version}`;

  async function call(method, url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { res, json };
    } catch (err) {
      // Network trouble or our timeout: worth another try later.
      return { res: null, json: null, error: { ok: false, error: ERRORS.unavailable, retryable: true, detail: String(err?.message || err).slice(0, 200) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(payload) {
    const { res, json, error } = await call('POST', `${base}/${phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload });
    if (error) return error;
    const id = json?.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, providerMessageId: id };
    return failure(res, json);
  }

  return {
    name: 'meta',
    configured: true,
    validateRecipient,

    /**
     * An approved template. `parameterNames` (the registry's variables, in
     * order) are sent as named values; without them the values are numbered.
     */
    async sendTemplate({ to, templateName, language, parameters = [], parameterNames = null, reference = null }) {
      const check = validateRecipient(to);
      if (!check.ok) return { ok: false, error: ERRORS.invalidRecipient, retryable: false };
      const named = Array.isArray(parameterNames) && parameterNames.length === parameters.length
        && parameterNames.every(n => /^[a-z_][a-z0-9_]*$/.test(String(n)));
      const values = parameters.map((text, i) => ({ type: 'text', text: String(text ?? ''), ...(named ? { parameter_name: parameterNames[i] } : {}) }));
      return send({
        to: metaNumber(check.to),
        type: 'template',
        ...(reference ? { biz_opaque_callback_data: String(reference).slice(0, 512) } : {}),
        template: { name: templateName, language: { code: language }, ...(values.length ? { components: [{ type: 'body', parameters: values }] } : {}) },
      });
    },

    /** Free text: only allowed in the 24 hours after the person wrote to us. */
    async sendMessage({ to, text, reference = null }) {
      const check = validateRecipient(to);
      if (!check.ok) return { ok: false, error: ERRORS.invalidRecipient, retryable: false };
      return send({
        to: metaNumber(check.to), type: 'text', text: { body: String(text).slice(0, 4096), preview_url: false },
        ...(reference ? { biz_opaque_callback_data: String(reference).slice(0, 512) } : {}),
      });
    },

    /** Meta has no status lookup; receipts arrive through the webhook. */
    async getDeliveryStatus() {
      return { error: 'not_supported' };
    },

    /**
     * Every template on the business account, with Meta's approval status.
     * Only English ("en") and Swahili ("sw") versions are FitFlex's; named
     * variables are read from the body so the registry knows their order.
     */
    async listTemplates() {
      const templates = [];
      let url = `${base}/${businessAccountId}/message_templates?fields=name,language,status,category,components&limit=100`;
      for (let page = 0; url && page < 20; page += 1) {
        const { res, json, error } = await call('GET', url);
        if (error) return { error: error.error };
        if (!res.ok) return { error: failure(res, json).error };
        for (const t of json?.data || []) {
          const body = (t.components || []).find(c => c.type === 'BODY')?.text || '';
          const vars = [...body.matchAll(VARIABLE_RE)].map(m => m[1]);
          const named = vars.length > 0 && vars.every(v => !/^\d+$/.test(v));
          templates.push({
            name: t.name, language: t.language,
            status: STATUS_MAP[String(t.status || '').toUpperCase()] || 'pending',
            category: String(t.category || '').toLowerCase(),
            ...(named ? { variables: [...new Set(vars)] } : {}),
          });
        }
        url = json?.paging?.next || null;
      }
      return { templates };
    },

    /**
     * Meta's webhook body → delivery receipts and inbound text. Button taps
     * count as text, so a "STOP" quick-reply button works like typing it.
     */
    parseWebhook({ body } = {}) {
      const statuses = [];
      const inbound = [];
      if (!body || typeof body !== 'object' || body.object !== 'whatsapp_business_account') return { statuses, inbound };
      for (const entry of Array.isArray(body.entry) ? body.entry : []) {
        for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
          const value = change?.value || {};
          if (phoneNumberId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId) continue;
          for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
            if (typeof s?.id !== 'string' || !DELIVERY.has(s.status)) continue;
            const err = Array.isArray(s.errors) && s.errors[0];
            statuses.push({
              providerMessageId: s.id, status: s.status, at: new Date(Number(s.timestamp) * 1000 || Date.now()),
              ...(err ? { error: [err.code, err.title || err.message].filter(Boolean).join(': ').slice(0, 200) } : {}),
            });
          }
          for (const m of Array.isArray(value.messages) ? value.messages : []) {
            const text = m?.type === 'text' ? m.text?.body
              : m?.type === 'button' ? m.button?.text
              : m?.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
              : null;
            if (typeof m?.from !== 'string' || typeof text !== 'string') continue;
            inbound.push({ from: `+${m.from.replace(/^\+/, '')}`, text: text.slice(0, 1000), providerMessageId: m.id || null, at: new Date(Number(m.timestamp) * 1000 || Date.now()) });
          }
        }
      }
      return { statuses, inbound };
    },

    /** Meta's GET check when the callback URL is saved: echo the challenge. */
    verifyWebhook(query = {}) {
      if (query['hub.mode'] !== 'subscribe' || !verifyToken || query['hub.verify_token'] !== verifyToken) return null;
      return query['hub.challenge'] ?? null;
    },

  };
}

