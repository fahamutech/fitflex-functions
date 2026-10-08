// SMS — everything FitFlex sends by text message, on top of the provider
// seam (src/integrations/sms/provider.mjs). Moved here from the Supabase
// edge functions (send-sms-hook, sms-dispatch, sms-promo), so all SMS code
// lives in this backend:
//
// - send: one text to one or many numbers, every attempt kept in SmsLog.
//   A `dedupeKey` makes a message go out once however often it is asked
//   for; one that failed is tried again (a few times) instead of being
//   lost.
// - the SMS channel of the communication module: the dispatcher hands it
//   queued SMS ledger rows (campaigns and automations). Right before
//   sending it checks again that SMS is on, the member still allows it and
//   has a usable number — otherwise the message is skipped, never failed.
// - reminders: a trainer session starting within three hours, and a pass
//   ending in three days.
// - the admin side: status, a test send and the log.
// - verification codes: sent by the identity code through its own sender;
//   wrapped here only so they appear (redacted) in the same log.
//
// Nothing here knows which provider is behind it.
import { randomUUID } from 'node:crypto';
import { channelAllowed } from '../shared/communications.mjs';
import { maskPhone } from '../shared/phone.mjs';
import { addDays, eatToday, slotStartMs } from '../shared/trainer-access.mjs';
import { ERRORS, validateRecipient } from '../integrations/sms/provider.mjs';
import { beemCredentialShape } from '../integrations/sms/beem.mjs';

/** Two SMS parts. Longer messages are cut, never split into a third. */
export const SMS_MAX_LENGTH = 306;
/** A reminder that failed is tried again by later runs, this many times in all. */
export const REMINDER_MAX_ATTEMPTS = 3;
export const BOOKING_REMINDER_HOURS = 3;
export const RENEWAL_REMINDER_DAYS = 3;
export const SMS_CATEGORIES = ['otp', 'reminder', 'campaign', 'test'];
export const SMS_STATUSES = ['queued', 'accepted', 'failed'];

const OPT_OUT = { en: ' Opt out: App > Settings.', sw: ' Kujiondoa: App > Settings.' };
const EAT = 'Africa/Dar_es_Salaam';
// When this server process started: settings are read then, so a change needs a restart after it.
const STARTED_AT = new Date().toISOString();
const id = (p) => `${p}_${randomUUID().slice(0, 12)}`;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const firstName = (name, fallback) => oneLine(name).split(' ')[0] || fallback;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: EAT });

/**
 * A campaign or automation message as an SMS: who it is from, the body on
 * one line, and for offers how to stop them — cut to two SMS parts.
 */
export function smsText({ body, gymName = null, category = 'transactional', locale = null }) {
  const text = oneLine(body);
  const from = gymName ? `FitFlex x ${oneLine(gymName)}: ` : /^fitflex\b/i.test(text) ? '' : 'FitFlex: ';
  const footer = category === 'marketing' ? OPT_OUT[locale] || OPT_OUT.en : '';
  const room = SMS_MAX_LENGTH - from.length - footer.length;
  const cut = text.length > room ? `${text.slice(0, Math.max(room - 1, 0)).trimEnd()}…` : text;
  return `${from}${cut}${footer}`;
}

// Reminders are written in Swahili unless the member chose English in the app.
const REMINDERS = {
  booking: {
    sw: ({ name, trainer, time, gym }) => `FitFlex: Habari ${name}, kipindi chako${trainer ? ` na ${trainer}` : ''} kinaanza saa ${time}${gym ? ` @ ${gym}` : ''}. Tukutane huko!`,
    en: ({ name, trainer, time, gym }) => `FitFlex: Hi ${name}, your session${trainer ? ` with ${trainer}` : ''} starts at ${time}${gym ? ` at ${gym}` : ''}. See you there!`,
  },
  // Passes are prepaid and never charged automatically (Member Terms 3.4).
  renewal: {
    sw: ({ name, date }) => `FitFlex: Habari ${name}, pass yako inaisha ${date}. Lipia tena kwenye app ya FitFlex ili uendelee na mazoezi.`,
    en: ({ name, date }) => `FitFlex: Hi ${name}, your pass ends on ${date}. Renew it in the FitFlex app to keep training.`,
  },
};

export function createSmsService({
  db,
  provider,
  auditLog = null,
  // Gyms whose own expiry reminders replace FitFlex's (automation service).
  gymsWithReminders = async () => new Set(),
  env = process.env,
  now = () => new Date(),
  logger = console,
}) {
  function audit(actor, action, target, after) {
    auditLog?.insertAsync?.({ id: randomUUID(), at: now().toISOString(), actor: actor || null, action, target, before: null, after })
      ?.catch?.(() => {});
  }

  const available = () => Boolean(provider.configured);

  // ── sending ────────────────────────────────────────────────────────────

  /**
   * Takes the log row for one message. With a `dedupeKey` already used, a
   * row that failed is taken again (up to `maxAttempts` tries in all);
   * anything else means the message was already sent or is being sent.
   */
  async function claim({ userId, phone, category, dedupeKey, message }, maxAttempts) {
    const at = now();
    const row = {
      id: id('sms'), userId: userId ?? null, phone, category, dedupeKey: dedupeKey ?? null, message,
      status: 'queued', provider: provider.name, attempts: 1, createdAt: at, updatedAt: at,
    };
    if (!dedupeKey) {
      await db('SmsLog').insert(row);
      return { logId: row.id };
    }
    const inserted = await db('SmsLog').insert(row).onConflict('dedupeKey').ignore().returning('id');
    if (inserted.length) return { logId: row.id };
    const retried = await db('SmsLog').where({ dedupeKey, status: 'failed' }).where('attempts', '<', maxAttempts)
      .update({ status: 'queued', attempts: db.raw('"attempts" + 1'), phone, message, provider: provider.name, updatedAt: at })
      .returning('id');
    if (retried.length) return { logId: retried[0].id };
    const existing = await db('SmsLog').where({ dedupeKey }).first('id', 'status', 'providerMessageId');
    return { duplicate: existing || { status: 'queued' } };
  }

  /**
   * Sends `text` to each recipient and records every attempt.
   * @param {{ category: string, text: string, logText?: string, maxAttempts?: number,
   *   recipients: { phone: string, userId?: string|null, dedupeKey?: string|null }[] }} message
   *   `logText` is what the log keeps instead of `text` (verification codes).
   * @returns {Promise<{ sent: number, failed: number, skipped: number, results: object[] }>}
   *   One result per recipient, in order: outcome 'sent' | 'failed' | 'skipped'.
   */
  async function send({ category, text, recipients, logText = text, maxAttempts = REMINDER_MAX_ATTEMPTS }) {
    const results = recipients.map(r => ({ userId: r.userId ?? null, outcome: 'skipped' }));
    if (!provider.configured) {
      for (const r of results) r.reason = ERRORS.notConfigured;
      return tally(results);
    }
    const claimed = [];
    for (const [i, r] of recipients.entries()) {
      const recipient = validateRecipient(r.phone);
      if (!recipient.ok) { results[i].reason = recipient.reason; continue; }
      const c = await claim({ userId: r.userId, phone: recipient.to, category, dedupeKey: r.dedupeKey, message: logText }, maxAttempts);
      if (c.duplicate) { Object.assign(results[i], { reason: 'duplicate', duplicate: c.duplicate }); continue; }
      claimed.push({ i, to: recipient.to, logId: c.logId });
    }
    for (let start = 0; start < claimed.length; start += provider.maxRecipients) {
      const batch = claimed.slice(start, start + provider.maxRecipients);
      let r;
      try {
        r = await provider.send({ to: batch.map(b => b.to), text });
      } catch (err) {
        r = { ok: false, error: ERRORS.unreachable, retryable: true, message: String(err?.message || err).slice(0, 200) };
      }
      await db('SmsLog').whereIn('id', batch.map(b => b.logId)).update({
        status: r.ok ? 'accepted' : 'failed',
        providerMessageId: r.ok ? r.providerMessageId ?? null : null,
        providerCode: r.ok ? null : r.code ?? null,
        error: r.ok ? null : oneLine(`${r.error}${r.message ? `: ${r.message}` : ''}`).slice(0, 300),
        retryable: !r.ok && Boolean(r.retryable),
        updatedAt: now(),
      });
      for (const b of batch) {
        Object.assign(results[b.i], r.ok
          ? { outcome: 'sent', providerMessageId: r.providerMessageId ?? null }
          : { outcome: 'failed', reason: r.error, retryable: Boolean(r.retryable), code: r.code ?? null, message: r.message ?? null });
      }
    }
    return tally(results);
  }

  function tally(results) {
    const count = (outcome) => results.filter(r => r.outcome === outcome).length;
    return { sent: count('sent'), failed: count('failed'), skipped: count('skipped'), results };
  }

  // ── the communication module's SMS channel ─────────────────────────────

  const gymNames = new Map();
  async function gymNameOf(gymId) {
    if (!gymId) return null;
    if (!gymNames.has(gymId)) gymNames.set(gymId, (await db('Gym').where({ id: gymId }).first('name'))?.name ?? null);
    return gymNames.get(gymId);
  }

  /** One queued ledger row (CommunicationMessage, channel 'sms') → the dispatcher's outcome. */
  async function deliver(msg) {
    if (!provider.configured) return { skipped: ERRORS.notConfigured };
    const [member, prefs] = await Promise.all([
      db('User').where({ id: msg.memberId }).first('id', 'phone'),
      db('CommunicationPreference').where({ id: msg.memberId }).first(),
    ]);
    const allowed = channelAllowed(prefs, 'sms', msg.category);
    if (!allowed.allowed) return { skipped: allowed.reason };
    const recipient = validateRecipient(member?.phone);
    if (!recipient.ok) return { skipped: recipient.reason };
    const text = smsText({
      body: msg.body, category: msg.category, locale: msg.locale,
      gymName: msg.senderType === 'gym' ? await gymNameOf(msg.gymId) : null,
    });
    // The ledger row's id is the key: a retry after a crash finds the
    // message already accepted instead of sending (and charging) it twice.
    // The dispatcher decides how often to retry, so no cap here.
    const { results: [r] } = await send({
      category: 'campaign', text, maxAttempts: 1000,
      recipients: [{ phone: recipient.to, userId: msg.memberId, dedupeKey: `cmm:${msg.id}` }],
    });
    if (r.outcome === 'sent') return { status: 'sent', providerMessageId: r.providerMessageId };
    if (r.duplicate) return { status: 'sent', providerMessageId: r.duplicate.providerMessageId ?? null };
    if (r.outcome === 'skipped') return { skipped: r.reason };
    return r.retryable ? { temporary: true, reason: r.reason } : { permanent: true, reason: r.reason };
  }

  // ── reminders ──────────────────────────────────────────────────────────

  async function preferencesOf(memberIds) {
    if (!memberIds.length) return new Map();
    const rows = await db('CommunicationPreference').whereIn('id', [...new Set(memberIds)]);
    return new Map(rows.map(p => [p.id, p]));
  }

  // A reminder to one member, in their language, unless they switched SMS off.
  async function remind(kind, row, prefs, values, dedupeKey) {
    if (row.accountStatus === 'suspended') return { sent: 0, failed: 0, skipped: 1 };
    if (!channelAllowed(prefs, 'sms', 'transactional').allowed) return { sent: 0, failed: 0, skipped: 1 };
    const write = REMINDERS[kind][prefs?.locale] || REMINDERS[kind].sw;
    return send({
      category: 'reminder', text: write({ name: firstName(row.memberName, 'Rafiki'), ...values }),
      recipients: [{ phone: row.phone, userId: row.memberId, dedupeKey }],
    });
  }

  /**
   * Sends the reminders that are due. Safe to run as often as you like:
   * each reminder is keyed, so it goes out once.
   * - confirmed trainer sessions starting within BOOKING_REMINDER_HOURS;
   * - active passes ending in RENEWAL_REMINDER_DAYS days (a gym membership
   *   whose gym sends its own expiry reminders is left to the gym).
   */
  async function sendDueReminders() {
    const summary = { bookings: { sent: 0, failed: 0, skipped: 0 }, renewals: { sent: 0, failed: 0, skipped: 0 } };
    if (!provider.configured) return { skipped: ERRORS.notConfigured, ...summary };
    const add = (into, r) => { into.sent += r.sent; into.failed += r.failed; into.skipped += r.skipped; };
    const at = now();

    const today = eatToday(at);
    const bookings = (await db('TrainerBooking as b')
      .join('User as m', 'm.id', 'b.memberId')
      .leftJoin('TrainerProfile as t', 't.id', 'b.trainerId')
      .leftJoin('Gym as g', 'g.id', 'b.gymId')
      .where('b.status', 'confirmed').whereIn('b.date', [today, addDays(today, 1)]).whereNotNull('m.phone')
      .select('b.id', 'b.memberId', 'b.date', 'b.slot', 'm.phone', 'm.accountStatus', 'm.displayName as memberName',
        't.displayName as trainerName', 'g.name as gymName'))
      .filter((b) => {
        const start = slotStartMs(b.date, b.slot);
        return start > +at && start <= +at + BOOKING_REMINDER_HOURS * 3_600_000;
      });
    const bookingPrefs = await preferencesOf(bookings.map(b => b.memberId));
    for (const b of bookings) {
      add(summary.bookings, await remind('booking', b, bookingPrefs.get(b.memberId), {
        trainer: firstName(b.trainerName, ''), time: b.slot, gym: oneLine(b.gymName),
      }, `booking_reminder:${b.id}`));
    }

    const day = 86_400_000;
    const [subs, ownReminders] = await Promise.all([
      db('Subscription as s').join('User as m', 'm.id', 's.memberId')
        .where('s.status', 'active').whereNotNull('m.phone')
        .where('s.renewsAt', '>=', new Date(+at + (RENEWAL_REMINDER_DAYS - 1) * day))
        .where('s.renewsAt', '<', new Date(+at + RENEWAL_REMINDER_DAYS * day))
        .select('s.id', 's.memberId', 's.type', 's.homeGymId', 's.renewsAt', 'm.phone', 'm.accountStatus', 'm.displayName as memberName'),
      gymsWithReminders(),
    ]);
    const due = subs.filter(s => !(s.type === 'direct_sub' && ownReminders.has(s.homeGymId)));
    const renewalPrefs = await preferencesOf(due.map(s => s.memberId));
    for (const s of due) {
      add(summary.renewals, await remind('renewal', s, renewalPrefs.get(s.memberId), { date: fmtDate(s.renewsAt) },
        `renewal_t${RENEWAL_REMINDER_DAYS}:${s.id}:${new Date(s.renewsAt).toISOString().slice(0, 10)}`));
    }
    return summary;
  }

  // ── admin ──────────────────────────────────────────────────────────────

  async function status() {
    const since = new Date(+now() - 86_400_000);
    const rows = await db('SmsLog').where('createdAt', '>=', since).groupBy('status').select('status').count({ n: '*' });
    return {
      provider: provider.name,
      configured: Boolean(provider.configured),
      sender: provider.sender ?? null,
      ...(provider.setup ? { setup: provider.setup } : {}),
      verificationProvider: String(env.VERIFICATION_SMS_PROVIDER || '').trim().toLowerCase() || null,
      serverStartedAt: STARTED_AT,
      // The shape of the stored Beem pair (lengths, stray spaces or quotes) — never the values.
      beemCredentials: beemCredentialShape(env),
      last24h: Object.fromEntries(SMS_STATUSES.map(s => [s, Number(rows.find(r => r.status === s)?.n || 0)])),
    };
  }

  /** One real SMS to a number an admin types in, to check the provider end to end. */
  async function testSend({ phone, actorId = null }) {
    if (!provider.configured) return { error: ERRORS.notConfigured, status: 503 };
    const recipient = validateRecipient(phone);
    if (!recipient.ok) return { error: recipient.reason, status: 400 };
    const { results: [r] } = await send({
      category: 'test', text: 'FitFlex: test SMS. Your SMS provider is connected.', recipients: [{ phone: recipient.to }],
    });
    audit(actorId, 'sms_test_send', maskPhone(recipient.to), { outcome: r.outcome, reason: r.reason ?? null });
    const base = { ok: r.outcome === 'sent', to: maskPhone(recipient.to), provider: provider.name, sender: provider.sender };
    return r.outcome === 'sent'
      ? { ...base, providerMessageId: r.providerMessageId }
      // What the provider said (e.g. Beem 120 "Invalid Authentication Parameters"), so a wrong key shows at once.
      : { ...base, reason: r.reason, providerCode: r.code ?? null, providerMessage: r.message ?? null };
  }

  /** The log, newest first. Numbers are masked. ?status&category&before (ISO time)&limit */
  async function logs({ status: wanted = null, category = null, before = null, limit = 50 } = {}) {
    if (wanted && !SMS_STATUSES.includes(wanted)) return { error: 'invalid_status', status: 400 };
    if (category && !SMS_CATEGORIES.includes(category)) return { error: 'invalid_category', status: 400 };
    const cut = before ? new Date(before) : null;
    if (cut && Number.isNaN(+cut)) return { error: 'invalid_before', status: 400 };
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const q = db('SmsLog').orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(max + 1);
    if (wanted) q.where({ status: wanted });
    if (category) q.where({ category });
    if (cut) q.where('createdAt', '<', cut);
    const rows = await q;
    const page = rows.slice(0, max);
    return {
      logs: page.map(r => ({
        id: r.id, userId: r.userId, phone: maskPhone(r.phone), category: r.category, message: r.message,
        status: r.status, provider: r.provider, providerMessageId: r.providerMessageId, providerCode: r.providerCode,
        error: r.error, attempts: r.attempts, createdAt: new Date(r.createdAt).toISOString(),
      })),
      nextBefore: rows.length > max ? new Date(page[page.length - 1].createdAt).toISOString() : null,
    };
  }

  // ── verification codes ─────────────────────────────────────────────────

  /**
   * The identity code's SMS sender, with each send written to the log. The
   * code itself is never stored. A log failure never fails the send.
   */
  function verificationSender(sender) {
    if (!sender?.configured) return sender;
    return {
      ...sender,
      send: async (to, message) => {
        const r = await sender.send(to, message);
        const at = now();
        await db('SmsLog').insert({
          id: id('sms'), phone: validateRecipient(to).to || String(to), category: 'otp', message: 'Verification code [redacted]',
          status: r?.ok ? 'accepted' : 'failed', provider: String(env.VERIFICATION_SMS_PROVIDER || '').trim().toLowerCase() || null,
          error: r?.ok ? null : r?.error ?? 'unknown', createdAt: at, updatedAt: at,
        }).catch(err => logger.warn?.(`[sms] verification log failed: ${err.message}`));
        return r;
      },
    };
  }

  return { available, send, deliver, sendDueReminders, status, testSend, logs, verificationSender };
}
