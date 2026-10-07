// Adding many people to an organisation at once, including people who have
// not joined FitFlex yet (Phase 7, slice 2).
//
//   import     a list of people by email or mobile number. Someone who already
//              has a member account is enrolled straight away, through the
//              same service a single "add person" uses, so the same rules
//              apply. Someone who has not joined yet is kept as an invite.
//   invite     waits for the person. When a member account appears with that
//              email or number they are enrolled and the invite is closed.
//              Matching runs every few minutes, and at once when a member
//              opens their benefits.
//   email      the invitation, then a reminder after 3 days and another after
//              10, to people listed with an email address. Email only, by
//              decision (P7-03): a person listed by number alone is told by
//              their organisation.
//
// Uploading the same list twice adds nobody twice: a person already on the
// list, or already invited, is left as they are (their group and reference
// are brought up to date). Companies managed under Corporate keep their own
// staff list and are refused here, as single adds are.
import { randomUUID } from 'node:crypto';
import { BENEFICIARY_TYPES } from '../shared/b2b.mjs';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const INVITE = 'B2BBeneficiaryInvite';
const IMPORT = 'B2BBeneficiaryImport';
const MANAGE = 'beneficiaries.manage';
const READ = 'beneficiaries.read';
const SYSTEM = 'system:b2b-beneficiary-invites';
export const MAX_IMPORT_ROWS = 2000;
/** The invitation plus two reminders. */
export const MAX_SCHEDULED_EMAILS = 3;
/** Days after the invitation that each reminder goes. */
export const REMINDER_DAYS = Object.freeze([3, 10]);
/** However often someone presses "send again". */
export const MAX_EMAILS_PER_INVITE = 6;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COLUMNS = ['name', 'email', 'phone', 'group', 'reference', 'type'];
const HEADER_ALIASES = { name: 'name', 'full name': 'name', displayname: 'name', email: 'email', 'email address': 'email', phone: 'phone', mobile: 'phone', 'mobile number': 'phone', 'phone number': 'phone',
  group: 'group', department: 'group', groupname: 'group', reference: 'reference', ref: 'reference', 'staff number': 'reference', 'policy number': 'reference', externalreference: 'reference', type: 'type', beneficiarytype: 'type' };

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Split one CSV line, honouring double quotes. */
function splitCsv(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cell); cell = ''; } else cell += ch;
  }
  out.push(cell);
  return out.map(c => c.trim());
}

/**
 * Rows from pasted or uploaded text. With a header line its names decide the
 * columns (in any order); without one the order is name, email, phone,
 * group, reference, type.
 */
export function parseImportText(raw) {
  const lines = String(raw ?? '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = splitCsv(lines[0]).map(c => HEADER_ALIASES[c.toLowerCase()]);
  const hasHeader = first.filter(Boolean).length >= 2 || (first.length === 1 && first[0]);
  const order = hasHeader ? first : COLUMNS;
  return lines.slice(hasHeader ? 1 : 0).map((line, i) => {
    const cells = splitCsv(line);
    const row = { line: i + (hasHeader ? 2 : 1) };
    order.forEach((key, c) => { if (key && cells[c]) row[key] = cells[c]; });
    return row;
  });
}

/** One row checked and normalised, or the reason it cannot be used. */
export function readImportRow(raw = {}) {
  const email = raw.email ? normalizeEmail(raw.email) : null;
  const phone = raw.phone ? normalizePhone(raw.phone) : null;
  if (raw.email && (!email || !EMAIL_RE.test(email))) return { problem: 'invalid_email' };
  if (raw.phone && !phone) return { problem: 'invalid_phone' };
  if (!email && !phone) return { problem: 'email_or_phone_required' };
  const beneficiaryType = raw.type ? String(raw.type).trim().toLowerCase() : 'member';
  if (!BENEFICIARY_TYPES[beneficiaryType]) return { problem: 'invalid_type' };
  return { person: { email, phone, displayName: text(raw.name, 160), groupName: text(raw.group, 100), externalReference: text(raw.reference, 100), beneficiaryType } };
}

export function createB2BBeneficiaryImportService({
  db, b2bService,
  // { configured, send(to, { subject, text }) }; read when needed so a later configuration is picked up.
  emailSender = () => ({ configured: false }),
  // Tell one person in the app: (userId, { id, type, title, body, data })
  notify = async () => null,
  // A link to get the app, put in the email when set. None is invented.
  appLink = () => process.env.FITFLEX_APP_LINK || null,
  now = () => new Date(),
}) {
  const stamp = () => new Date(now());
  const can = (access, permission) => access.platformAdmin || access.permissions.includes(permission);
  const refuse = permission => fail('forbidden', 403, { requiredPermission: permission });
  const audit = ({ actor, action, target, after = null }) => db('AuditLog').insert({
    id: randomUUID(), at: stamp(), actor: actor ?? null, action, target, before: null, after: after == null ? null : JSON.stringify(after),
  });
  const orgName = org => org.tradingName || org.legalName;
  const inviteView = ({ invitedBy, cancelledBy, ...i }) => ({ ...i, canResend: i.status === 'invited' && !!i.email && i.emailsSent < MAX_EMAILS_PER_INVITE });

  /** Member accounts behind a set of emails and numbers: two queries, whatever the size of the list. */
  async function accountsFor(emails, phones) {
    const byEmail = new Map();
    const byPhone = new Map();
    const usable = q => q.where({ userType: 'member' }).where(b => b.whereNull('accountStatus').orWhereNot('accountStatus', 'deleted'));
    if (emails.length) for (const u of await usable(db('User').whereIn('email', emails)).select('id', 'email')) byEmail.set(normalizeEmail(u.email), u.id);
    if (phones.length) for (const u of await usable(db('User').whereIn('phone', phones)).select('id', 'phone')) byPhone.set(u.phone, u.id);
    return { byEmail, byPhone };
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Add a list of people. `rows` (objects) or `rawText` (CSV). `dryRun: true`
   * checks the list and says what would happen without changing anything.
   * Returns the count for each outcome and every row that was not simply
   * added, with the reason.
   */
  async function importPeople({ access, body = {}, actorId }) {
    if (!can(access, MANAGE)) return refuse(MANAGE);
    if (!actorId) return fail('actor_required', 403);
    const { org } = access;
    if (org.legacyCorporateId) return fail('managed_by_corporate', 409, { corporateId: org.legacyCorporateId, use: '/corporate/staff/bulk' });
    if (org.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: org.status });
    const given = Array.isArray(body.rows) ? body.rows.map((r, i) => ({ line: i + 1, ...r })) : parseImportText(body.rawText);
    if (!given.length) return fail('nothing_to_import', 400, { hint: 'One person per line: name, email, phone, group, reference, type.' });
    if (given.length > MAX_IMPORT_ROWS) return fail('too_many_rows', 400, { maxRows: MAX_IMPORT_ROWS, rows: given.length });
    const dryRun = body.dryRun === true;

    // Check every row, and catch the same person listed twice in the file.
    const problems = [];
    const people = [];
    const seen = new Set();
    for (const raw of given) {
      const read = readImportRow(raw);
      if (read.problem) { problems.push({ line: raw.line, name: text(raw.name, 160), contact: text(raw.email ?? raw.phone, 200), problem: read.problem }); continue; }
      const keys = [read.person.email && `e:${read.person.email}`, read.person.phone && `p:${read.person.phone}`].filter(Boolean);
      if (keys.some(k => seen.has(k))) { problems.push({ line: raw.line, name: read.person.displayName, contact: read.person.email ?? read.person.phone, problem: 'listed_twice' }); continue; }
      keys.forEach(k => seen.add(k));
      people.push({ line: raw.line, ...read.person });
    }

    const accounts = await accountsFor(people.map(p => p.email).filter(Boolean), people.map(p => p.phone).filter(Boolean));
    const live = await db(INVITE).where({ organizationId: org.id, status: 'invited' }).select('id', 'email', 'phone');
    const invitedEmail = new Map(live.filter(i => i.email).map(i => [i.email, i.id]));
    const invitedPhone = new Map(live.filter(i => i.phone).map(i => [i.phone, i.id]));
    const enrolledUsers = new Set((await b2bService.allBeneficiaries(org)).map(b => b.userId).filter(Boolean));

    const counts = { total: given.length, enrolled: 0, invited: 0, unchanged: 0, rejected: problems.length };
    const importId = newId('b2bim');
    const at = stamp();
    for (const p of people) {
      const userId = (p.email && accounts.byEmail.get(p.email)) || (p.phone && accounts.byPhone.get(p.phone)) || null;
      const where = { line: p.line, name: p.displayName, contact: p.email ?? p.phone };
      if (userId) {
        if (enrolledUsers.has(userId)) { counts.unchanged += 1; continue; }
        if (dryRun) { counts.enrolled += 1; continue; }
        const out = await b2bService.enrollBeneficiary({ access, actorId, body: { userId, status: 'active', groupName: p.groupName, externalReference: p.externalReference, beneficiaryType: p.beneficiaryType } });
        if (out.error === 'already_enrolled') counts.unchanged += 1;
        else if (out.error) { counts.rejected += 1; problems.push({ ...where, problem: out.error }); } else { counts.enrolled += 1; enrolledUsers.add(userId); }
        continue;
      }
      const existing = (p.email && invitedEmail.get(p.email)) || (p.phone && invitedPhone.get(p.phone)) || null;
      if (existing) {
        counts.unchanged += 1;
        if (!dryRun) await db(INVITE).where({ id: existing }).update({ displayName: p.displayName, groupName: p.groupName, externalReference: p.externalReference, beneficiaryType: p.beneficiaryType, updatedAt: at });
        continue;
      }
      counts.invited += 1;
      if (dryRun) continue;
      try {
        await db(INVITE).insert({
          id: newId('b2bbi'), organizationId: org.id, email: p.email, phone: p.phone, displayName: p.displayName, externalReference: p.externalReference, groupName: p.groupName,
          beneficiaryType: p.beneficiaryType, status: 'invited', importId, invitedBy: actorId, invitedAt: at, nextEmailAt: p.email ? at : null, createdAt: at, updatedAt: at,
        });
        if (p.email) invitedEmail.set(p.email, true);
        if (p.phone) invitedPhone.set(p.phone, true);
      } catch (err) {
        if (err.code !== '23505') throw err;   // invited by someone else at the same moment
        counts.invited -= 1; counts.unchanged += 1;
      }
    }
    const summary = { ...counts, problems: problems.sort((a, b) => a.line - b.line), withoutEmail: people.filter(p => !p.email).length };
    if (dryRun) return { dryRun: true, ...summary };
    await db(IMPORT).insert({ id: importId, organizationId: org.id, createdBy: actorId, total: counts.total, enrolled: counts.enrolled, invited: counts.invited, unchanged: counts.unchanged, rejected: counts.rejected,
      problems: JSON.stringify(summary.problems.slice(0, 500)), createdAt: at, updatedAt: at });
    await audit({ actor: actorId, action: 'b2b.beneficiaries.import', target: org.id, after: { importId, ...counts } });
    return { importId, ...summary };
  }

  async function listImports({ access }) {
    if (!can(access, READ)) return refuse(READ);
    const rows = await db(IMPORT).where({ organizationId: access.org.id }).orderBy('createdAt', 'desc').limit(20);
    return { items: rows.map(({ createdBy, ...r }) => r) };
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  async function listInvites({ access, query = {} }) {
    if (!can(access, READ)) return refuse(READ);
    const status = query.status ? String(query.status) : 'invited';
    let q = db(INVITE).where({ organizationId: access.org.id });
    if (status !== 'all') q = q.where({ status });
    const rows = await q.orderBy('invitedAt', 'desc').limit(Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000));
    const [{ c }] = await db(INVITE).where({ organizationId: access.org.id, status: 'invited' }).count({ c: '*' });
    return { items: rows.map(inviteView), invited: Number(c), emailConfigured: emailSender().configured === true };
  }

  async function ownInvite(access, inviteId, trx = db) {
    return trx(INVITE).where({ id: inviteId, organizationId: access.org.id }).first();
  }

  async function cancelInvite({ access, inviteId, actorId }) {
    if (!can(access, MANAGE)) return refuse(MANAGE);
    const invite = await ownInvite(access, inviteId);
    if (!invite) return fail('invite_not_found', 404);
    if (invite.status === 'cancelled') return { invite: inviteView(invite), unchanged: true };
    if (invite.status !== 'invited') return fail('invite_already_used', 409, { inviteStatus: invite.status });
    const at = stamp();
    const [row] = await db(INVITE).where({ id: invite.id, status: 'invited' }).update({ status: 'cancelled', cancelledAt: at, cancelledBy: actorId, nextEmailAt: null, updatedAt: at }).returning('*');
    await audit({ actor: actorId, action: 'b2b.beneficiary_invite.cancel', target: invite.id, after: { organizationId: access.org.id } });
    return { invite: inviteView(row ?? await ownInvite(access, inviteId)) };
  }

  /** Send the invitation email again now. At most six emails per invite, and not within an hour of the last. */
  async function resendInvite({ access, inviteId, actorId }) {
    if (!can(access, MANAGE)) return refuse(MANAGE);
    const invite = await ownInvite(access, inviteId);
    if (!invite) return fail('invite_not_found', 404);
    if (invite.status !== 'invited') return fail('invite_already_used', 409, { inviteStatus: invite.status });
    if (!invite.email) return fail('invite_has_no_email', 409, { hint: 'This person was listed by mobile number only. Tell them to join FitFlex with that number.' });
    if (invite.emailsSent >= MAX_EMAILS_PER_INVITE) return fail('email_limit_reached', 409, { maxEmails: MAX_EMAILS_PER_INVITE });
    if (invite.lastEmailAt && +stamp() - +new Date(invite.lastEmailAt) < 3_600_000) return fail('sent_recently', 409, { lastEmailAt: invite.lastEmailAt });
    await db(INVITE).where({ id: invite.id }).update({ nextEmailAt: stamp(), emailFailures: 0, lastEmailError: null, updatedAt: stamp() });
    await audit({ actor: actorId, action: 'b2b.beneficiary_invite.resend', target: invite.id, after: { organizationId: access.org.id } });
    const sent = await sendDue({ inviteIds: [invite.id] });
    return { invite: inviteView(await ownInvite(access, inviteId)), sent: sent.sent === 1, emailConfigured: !sent.notConfigured };
  }

  // ── Matching: the person has joined ───────────────────────────────────────

  async function enrolFromInvite(invite, userId) {
    const access = await b2bService.resolveAccess({ organizationId: invite.organizationId, userType: 'admin', userId: SYSTEM });
    if (access.error || access.org.status !== 'active') return { skipped: 'organization_not_active' };
    const out = await b2bService.enrollBeneficiary({ access, actorId: SYSTEM,
      body: { userId, status: 'active', groupName: invite.groupName, externalReference: invite.externalReference, beneficiaryType: invite.beneficiaryType } });
    let beneficiaryId = out.beneficiary?.id ?? null;
    if (out.error === 'already_enrolled') beneficiaryId = out.beneficiaryId ?? null;
    else if (out.error === 'external_reference_in_use') {
      // The reference went to someone else in the meantime: enrol without it rather than leave the person out.
      const again = await b2bService.enrollBeneficiary({ access, actorId: SYSTEM, body: { userId, status: 'active', groupName: invite.groupName, beneficiaryType: invite.beneficiaryType } });
      if (again.error && again.error !== 'already_enrolled') return { failed: again.error };
      beneficiaryId = again.beneficiary?.id ?? again.beneficiaryId ?? null;
    } else if (out.error) return { failed: out.error };
    const at = stamp();
    const closed = await db(INVITE).where({ id: invite.id, status: 'invited' }).update({ status: 'enrolled', enrolledAt: at, beneficiaryId, nextEmailAt: null, updatedAt: at });
    if (closed && out.beneficiary) {
      await notify(userId, {
        id: `b2b_enrolled_${invite.id}`.slice(0, 120), type: 'b2b_beneficiary_enrolled', title: `${orgName(access.org)} added you`,
        body: `${orgName(access.org)} has added you to its wellness programme on FitFlex. Open Benefits to see what you have.`, data: { organizationId: invite.organizationId },
      }).catch(() => null);
    }
    return { enrolled: !!closed };
  }

  /**
   * Enrol everyone who has joined since they were invited. With `userId`,
   * only that person (used when a member opens their benefits, so they do
   * not wait for the next run).
   */
  async function matchInvites({ userId = null, limit = 500 } = {}) {
    const stats = { matched: 0, enrolled: 0, failed: 0, skipped: 0 };
    let pairs;
    if (userId) {
      const u = await db('User').where({ id: userId, userType: 'member' }).first('id', 'email', 'phone', 'accountStatus');
      if (!u || u.accountStatus === 'deleted') return stats;
      const email = normalizeEmail(u.email);
      if (!email && !u.phone) return stats;
      const rows = await db(INVITE).where({ status: 'invited' }).where(b => { if (email) b.orWhere({ email }); if (u.phone) b.orWhere({ phone: u.phone }); });
      pairs = rows.map(invite => ({ invite, userId: u.id }));
    } else {
      const rows = await db(`${INVITE} as i`).join('User as u', function on() { this.on('u.email', 'i.email').orOn('u.phone', 'i.phone'); })
        .where({ 'i.status': 'invited', 'u.userType': 'member' }).where(b => b.whereNull('u.accountStatus').orWhereNot('u.accountStatus', 'deleted'))
        .orderBy('i.invitedAt').limit(limit).select('i.*', 'u.id as matchedUserId');
      pairs = rows.map(({ matchedUserId, ...invite }) => ({ invite, userId: matchedUserId }));
    }
    const done = new Set();
    for (const { invite, userId: id } of pairs) {
      if (done.has(invite.id)) continue;
      done.add(invite.id);
      stats.matched += 1;
      try {
        const out = await enrolFromInvite(invite, id);
        if (out.enrolled) stats.enrolled += 1; else if (out.failed) stats.failed += 1; else stats.skipped += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-invites] could not enrol invite ${invite.id}: ${err.message}`);
      }
    }
    return stats;
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  function emailFor(invite, org, count) {
    const name = orgName(org);
    const link = appLink();
    const hello = invite.displayName ? `Hello ${invite.displayName},` : 'Hello,';
    const lines = [
      hello, '',
      count === 0
        ? `${name} has added you to its wellness programme on FitFlex.`
        : `A reminder: ${name} has added you to its wellness programme on FitFlex, and your benefits are waiting.`,
      '',
      `To use it, get the FitFlex app and sign up as a member with this email address (${invite.email}). Your benefits appear under Benefits as soon as you have joined.`,
      link ? `Get the app: ${link}` : null,
      '',
      `What ${name} can see: once you join, ${name} can see your FitFlex activity (gym visits, trainer sessions, the workouts and steps you record, and your progress in its challenges). It cannot see your weight, height, or anything another sponsor gives you.`,
      '',
      `If you do not want to take part, ignore this email or ask ${name} to remove you from its list.`,
    ].filter(l => l !== null);
    return { subject: count === 0 ? `${name} has added you to FitFlex` : `Reminder: your FitFlex benefits from ${name}`, text: lines.join('\n') };
  }

  /** Send the emails that are due: the invitation, then the reminders. Each is sent once. */
  async function sendDue({ limit = 200, inviteIds = null } = {}) {
    const stats = { due: 0, sent: 0, failed: 0, notConfigured: false };
    const at = stamp();
    let q = db(INVITE).where({ status: 'invited' }).whereNotNull('email').whereNotNull('nextEmailAt').where('nextEmailAt', '<=', at).orderBy('nextEmailAt').limit(limit);
    if (inviteIds) q = q.whereIn('id', inviteIds);
    const due = await q;
    stats.due = due.length;
    if (!due.length) return stats;
    const sender = emailSender();
    if (!sender.configured) { stats.notConfigured = true; return stats; }
    const orgs = new Map((await db('B2BOrganization').whereIn('id', [...new Set(due.map(i => i.organizationId))])).map(o => [o.id, o]));
    for (const invite of due) {
      const org = orgs.get(invite.organizationId);
      if (!org || org.status !== 'active') continue;
      // Claim it first, so two runs at once send one email.
      const claimed = await db(INVITE).where({ id: invite.id, status: 'invited', emailsSent: invite.emailsSent }).whereNotNull('nextEmailAt').update({ nextEmailAt: null, updatedAt: at });
      if (!claimed) continue;
      let ok = false;
      let error = null;
      try {
        const out = await sender.send(invite.email, emailFor(invite, org, invite.emailsSent));
        ok = out?.ok === true;
        error = ok ? null : out?.error ?? 'not_accepted';
      } catch (err) {
        error = String(err?.message ?? err).slice(0, 200);
      }
      if (ok) {
        const sentCount = invite.emailsSent + 1;
        const reminder = sentCount <= REMINDER_DAYS.length && sentCount < MAX_SCHEDULED_EMAILS ? new Date(+new Date(invite.invitedAt) + REMINDER_DAYS[sentCount - 1] * 86_400_000) : null;
        await db(INVITE).where({ id: invite.id }).update({ emailsSent: sentCount, lastEmailAt: at, emailFailures: 0, lastEmailError: null,
          nextEmailAt: reminder && reminder > at ? reminder : reminder ? new Date(+at + 86_400_000) : null, updatedAt: at });
        stats.sent += 1;
      } else {
        const failures = invite.emailFailures + 1;
        // Three failures in a row and it stops; "send again" starts it over.
        await db(INVITE).where({ id: invite.id }).update({ emailFailures: failures, lastEmailError: error, nextEmailAt: failures >= 3 ? null : new Date(+at + 3_600_000), updatedAt: at });
        stats.failed += 1;
      }
    }
    return stats;
  }

  /** For the operations page. */
  async function pending() {
    const [{ invited }] = await db(INVITE).where({ status: 'invited' }).count({ invited: '*' });
    const [{ stuck }] = await db(INVITE).where({ status: 'invited' }).where('emailFailures', '>=', 3).count({ stuck: '*' });
    const [{ withProblems }] = await db(IMPORT).where('rejected', '>', 0).where('createdAt', '>', new Date(+stamp() - 7 * 86_400_000)).count({ withProblems: '*' });
    return { invitesWaiting: Number(invited), invitesEmailFailed: Number(stuck), importsWithRejectedRowsLast7Days: Number(withProblems) };
  }

  return { importPeople, listImports, listInvites, cancelInvite, resendInvite, matchInvites, sendDue, pending };
}
