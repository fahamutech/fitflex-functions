// Adding many people to an organisation at once, including people who have
// not joined FitFlex yet (Phase 7, slice 2).
//
//   import     a list of people by email or mobile number. Everyone on it is
//              kept as an invite, members and people who have not joined
//              alike: nobody is enrolled by an import (consent slice (a),
//              owner decision 22 Oct 2026, re-confirmed 29 Oct), and the
//              reply does not say who already has an account.
//   invite     waits for the person. When a member has VERIFIED that email or
//              number (a LoginIdentifier with verifiedAt) they are ASKED in the
//              app (a B2BMemberRequest, source invite) and enrolled only if
//              they accept; the invite then closes as enrolled. Until then the
//              organisation sees the invite as invited. Matching runs every few
//              minutes, at once after an import, and when a member opens their
//              benefits. One request per invite: after a decline or expiry the
//              member is not asked again unless the organisation presses "send
//              again" (and the 30-day cooldown after a decline has passed).
//   matching   uses verified contacts only (src/shared/verified-contacts.mjs).
//              User.email / User.phone can be typed in by anyone, so a member
//              who holds the contact only there is treated as not joined yet:
//              they stay invited and are matched once they verify it (security
//              fix, 20 Oct 2026). Members with no verified record are never
//              matched (fail closed).
//   messages   by email: the invitation, then a reminder after 3 days and
//              another after 10. By SMS, to people listed with a mobile
//              number: the invitation and one reminder after 3 days (each SMS
//              is paid for). Someone listed with both gets both (product
//              owner, 8 Oct 2026). WhatsApp is not sent: there is no WhatsApp
//              Business account or approved template yet.
//
// Uploading the same list twice adds nobody twice: a person already on the
// list, or already invited, is left as they are (their group and reference
// are brought up to date). Companies managed under Corporate keep their own
// staff list and are refused here, as single adds are.
import { randomUUID } from 'node:crypto';
import { BENEFICIARY_TYPES } from '../shared/b2b.mjs';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';
import { createVerifiedContacts, whereLiveAccount } from '../shared/verified-contacts.mjs';

const INVITE = 'B2BBeneficiaryInvite';
// Which member request answers an invite (or that the person was already on the
// list). Never on the invite row itself: what the organisation sees of an
// invite must not change when a member turns out to be behind it.
const MATCH = 'B2BBeneficiaryInviteMatch';
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
/** The SMS invitation and one reminder, after this many days. */
export const SMS_REMINDER_DAYS = Object.freeze([3]);
/** SMS is paid for per message: three per invite at most, "send again" included. */
export const MAX_SMS_PER_INVITE = 3;
/** One SMS segment, plain characters only. */
export const SMS_MAX_LENGTH = 160;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COLUMNS = ['name', 'email', 'phone', 'group', 'reference', 'type'];
const HEADER_ALIASES = { name: 'name', 'full name': 'name', displayname: 'name', email: 'email', 'email address': 'email', phone: 'phone', mobile: 'phone', 'mobile number': 'phone', 'phone number': 'phone',
  group: 'group', department: 'group', groupname: 'group', reference: 'reference', ref: 'reference', 'staff number': 'reference', 'policy number': 'reference', externalreference: 'reference', type: 'type', beneficiarytype: 'type' };

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Split one CSV line, honouring double quotes (also used by the events roster parser, S3). */
export function splitCsv(line) {
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
  // Member requests (b2b-member-request-service): an invite that matches a
  // member asks them. Without it nobody is matched (fail closed).
  memberRequests = null,
  // Who has verified an email / number (src/shared/verified-contacts.mjs).
  verifiedContacts = createVerifiedContacts(db),
  // Whether FitFlex can send email codes right now (GET /auth/options
  // emailCodes). When it can't, someone listed by email only cannot verify
  // that address in the app, so the portal asks for a mobile number too.
  emailCodes = () => false,
  // { configured, send(to, { subject, text }) }; read when needed so a later configuration is picked up.
  emailSender = () => ({ configured: false }),
  // Tell one person in the app: (userId, { id, type, title, body, data }). No
  // longer used here: a matched member is told by their member request.
  notify = async () => null,
  // { configured, send(to, { text }) }. Invitation SMS can be switched off with B2B_INVITE_SMS=off.
  smsSender = () => ({ configured: false }),
  smsEnabled = () => process.env.B2B_INVITE_SMS !== 'off',
  // A link to get the app, put in the messages when set. None is invented.
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
  const sms = () => (smsEnabled() ? smsSender() : { configured: false });
  const inviteView = ({ invitedBy, cancelledBy, ...i }) => ({ ...i, canResend: i.status === 'invited' && ((!!i.email && i.emailsSent < MAX_EMAILS_PER_INVITE) || (!!i.phone && i.smsSent < MAX_SMS_PER_INVITE)) });

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
    // A company's staff list is Corporate's. With ORG_ONLY_SPONSORS on it is
    // imported into from here too, through the company staff path (B5a).
    const companyStaff = Boolean(org.legacyCorporateId && b2bService.companyStaffWritable?.(access));
    if (org.legacyCorporateId && !companyStaff) return fail('managed_by_corporate', 409, { corporateId: org.legacyCorporateId, use: '/corporate/staff/bulk' });
    // Owner decision (finding 5): importing into a company's staff list is for org roles hr and admin only.
    if (companyStaff && !b2bService.companyStaffManage?.(access)) return fail('forbidden', 403, { requiredRoles: ['hr', 'admin'] });
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

    if (companyStaff) return importCompanyStaff({ access, given, people, problems, dryRun, actorId });

    // Nobody is looked up: who has an account is not the organisation's to learn
    // from an import. Everyone new is invited; a member behind an invited
    // contact is asked in the app (matching, below) and enrolled only if they accept.
    const live = await db(INVITE).where({ organizationId: org.id, status: 'invited' }).select('id', 'email', 'phone');
    const invitedEmail = new Map(live.filter(i => i.email).map(i => [i.email, i.id]));
    const invitedPhone = new Map(live.filter(i => i.phone).map(i => [i.phone, i.id]));

    // `enrolled` stays in the reply for compatibility and is always 0 here.
    const counts = { total: given.length, enrolled: 0, invited: 0, unchanged: 0, rejected: problems.length };
    const importId = newId('b2bim');
    const at = stamp();
    const created = [];
    for (const p of people) {
      const existing = (p.email && invitedEmail.get(p.email)) || (p.phone && invitedPhone.get(p.phone)) || null;
      if (existing) {
        counts.unchanged += 1;
        if (!dryRun) await db(INVITE).where({ id: existing }).update({ displayName: p.displayName, groupName: p.groupName, externalReference: p.externalReference, beneficiaryType: p.beneficiaryType, updatedAt: at });
        continue;
      }
      counts.invited += 1;
      if (dryRun) continue;
      try {
        const id = newId('b2bbi');
        await db(INVITE).insert({
          id, organizationId: org.id, email: p.email, phone: p.phone, displayName: p.displayName, externalReference: p.externalReference, groupName: p.groupName,
          beneficiaryType: p.beneficiaryType, status: 'invited', importId, invitedBy: actorId, invitedAt: at, nextEmailAt: p.email ? at : null, nextSmsAt: p.phone ? at : null, createdAt: at, updatedAt: at,
        });
        created.push(id);
        if (p.email) invitedEmail.set(p.email, true);
        if (p.phone) invitedPhone.set(p.phone, true);
      } catch (err) {
        if (err.code !== '23505') throw err;   // invited by someone else at the same moment
        counts.invited -= 1; counts.unchanged += 1;
      }
    }
    const summary = { ...counts, problems: problems.sort((a, b) => a.line - b.line), withoutEmail: people.filter(p => !p.email).length, withoutPhone: people.filter(p => !p.phone).length,
      emailConfigured: emailSender().configured === true, smsConfigured: sms().configured === true, emailCodesAvailable: emailCodes() === true };
    if (dryRun) return { dryRun: true, ...summary };
    await db(IMPORT).insert({ id: importId, organizationId: org.id, createdBy: actorId, total: counts.total, enrolled: counts.enrolled, invited: counts.invited, unchanged: counts.unchanged, rejected: counts.rejected,
      problems: JSON.stringify(summary.problems.slice(0, 500)), createdAt: at, updatedAt: at });
    await audit({ actor: actorId, action: 'b2b.beneficiaries.import', target: org.id, after: { importId, ...counts } });
    // Members behind these contacts are asked by the matching job (every 10 minutes), not here,
    // so the import's own timing does not depend on how many of them are members.
    return { importId, ...summary };
  }

  /**
   * B5a: import into a company's staff list from its organisation. Each new
   * person becomes a CorporateEmployee through b2bService.enrollBeneficiary
   * (corporate-service underneath: seat limit, billing and audit as in
   * /corporate/staff/bulk). Every row needs a name and is added pending and
   * unlinked; a member whose verified email or number it lists is ASKED to
   * accept the link (member request by contact, consent slice (a)) and is
   * linked only if they do; the reply is the same whether or not there is one.
   * Every row added gets its activation PIN once in `credentials` (never
   * stored with the import). Nobody is invited. Someone already on the staff
   * list by the same email or number is left alone, so the same list can be
   * uploaded again. Accounts are not looked up (the reply must not say who
   * has one). All-or-nothing on seats: a list
   * needing more seats than are free adds nobody.
   */
  async function importCompanyStaff({ access, given, people, problems, dryRun, actorId }) {
    const { org } = access;
    const corporateId = org.legacyCorporateId;
    const account = await db('CorporateAccount').where({ id: corporateId }).first();
    if (!account || account.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: org.status });
    const staff = await db('CorporateEmployee').where({ corporateId }).whereNot({ status: 'exited' }).select('email', 'phone');
    const onListEmail = new Set(staff.map(e => (e.email ? normalizeEmail(e.email) : null)).filter(Boolean));
    const onListPhone = new Set(staff.map(e => (e.phone ? normalizePhone(e.phone) : null)).filter(Boolean));

    const counts = { total: given.length, enrolled: 0, invited: 0, unchanged: 0, rejected: problems.length };
    const toAdd = [];
    for (const p of people) {
      if ((p.email && onListEmail.has(p.email)) || (p.phone && onListPhone.has(p.phone))) { counts.unchanged += 1; continue; }
      if (!p.displayName) { counts.rejected += 1; problems.push({ line: p.line, name: null, contact: p.email ?? p.phone, problem: 'name_required' }); continue; }
      toAdd.push(p);
    }
    const seatsAvailable = account.seatLimit > 0 ? Math.max(0, account.seatLimit - account.seatsUsed) : null;
    if (seatsAvailable !== null && toAdd.length > seatsAvailable) {
      return fail('seat_limit_reached', 409, { seatsAvailable, requested: toAdd.length, seatLimit: account.seatLimit });
    }
    const summaryOf = () => ({
      ...counts, problems: problems.sort((a, b) => a.line - b.line), withoutEmail: people.filter(p => !p.email).length, withoutPhone: people.filter(p => !p.phone).length,
      emailConfigured: emailSender().configured === true, smsConfigured: sms().configured === true, emailCodesAvailable: emailCodes() === true,
      companyStaff: true, seatsAvailable,
    });
    if (dryRun) {
      counts.enrolled = toAdd.length;
      return { dryRun: true, ...summaryOf() };
    }

    const credentials = [];
    for (const p of toAdd) {
      // By contact, never by the matched account id: the member behind a verified
      // contact is ASKED to accept the link (member-request consent), and the reply is the same either way.
      const out = await b2bService.enrollBeneficiary({
        access, actorId,
        body: { email: p.email, phone: p.phone, displayName: p.displayName, groupName: p.groupName, status: 'pending' },
      }, { fromImport: true });
      const where = { line: p.line, name: p.displayName, contact: p.email ?? p.phone };
      if (out.error === 'already_enrolled') { counts.unchanged += 1; continue; }
      if (out.error) { counts.rejected += 1; problems.push({ ...where, problem: out.error }); continue; }
      counts.enrolled += 1;
      // A PIN for every row added (linked or not), so the reply does not say who is a member.
      if (out.pin) credentials.push({ line: p.line, employeeId: out.beneficiary.id, displayName: out.beneficiary.displayName, pin: out.pin });
    }
    const importId = newId('b2bim');
    const at = stamp();
    const summary = summaryOf();
    await db(IMPORT).insert({ id: importId, organizationId: org.id, createdBy: actorId, total: counts.total, enrolled: counts.enrolled, invited: 0, unchanged: counts.unchanged, rejected: counts.rejected,
      problems: JSON.stringify(summary.problems.slice(0, 500)), createdAt: at, updatedAt: at });
    await audit({ actor: actorId, action: 'b2b.beneficiaries.import_company_staff', target: org.id, after: { importId, corporateId, ...counts } });
    return { importId, ...summary, credentials };
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
    return { items: rows.map(inviteView), invited: Number(c), emailConfigured: emailSender().configured === true, smsConfigured: sms().configured === true };
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
    const [row] = await db(INVITE).where({ id: invite.id, status: 'invited' }).update({ status: 'cancelled', cancelledAt: at, cancelledBy: actorId, nextEmailAt: null, nextSmsAt: null, updatedAt: at }).returning('*');
    // A member asked because of this invite is no longer asked.
    if (row && memberRequests) await memberRequests.cancelForInvite({ inviteId: invite.id, actorId });
    await audit({ actor: actorId, action: 'b2b.beneficiary_invite.cancel', target: invite.id, after: { organizationId: access.org.id } });
    return { invite: inviteView(row ?? await ownInvite(access, inviteId)) };
  }

  /**
   * Send the invitation again now, by every way the person can be reached:
   * email (six per invite at most) and SMS (three at most). Not within an
   * hour of the last message of that kind.
   */
  async function resendInvite({ access, inviteId, actorId }) {
    if (!can(access, MANAGE)) return refuse(MANAGE);
    const invite = await ownInvite(access, inviteId);
    if (!invite) return fail('invite_not_found', 404);
    if (invite.status !== 'invited') return fail('invite_already_used', 409, { inviteStatus: invite.status });
    const at = stamp();
    const recent = last => last && +at - +new Date(last) < 3_600_000;
    const byEmail = !!invite.email && invite.emailsSent < MAX_EMAILS_PER_INVITE && !recent(invite.lastEmailAt);
    const bySms = !!invite.phone && invite.smsSent < MAX_SMS_PER_INVITE && !recent(invite.lastSmsAt) && sms().configured === true;
    if (!byEmail && !bySms) {
      if (!invite.email && sms().configured !== true) return fail('sms_not_available', 409, { hint: 'This person was listed by mobile number only and FitFlex cannot send SMS at the moment. Tell them to join FitFlex with that number.' });
      if (recent(invite.lastEmailAt) || recent(invite.lastSmsAt)) return fail('sent_recently', 409, { lastEmailAt: invite.lastEmailAt, lastSmsAt: invite.lastSmsAt });
      return fail('message_limit_reached', 409, { maxEmails: MAX_EMAILS_PER_INVITE, maxSms: MAX_SMS_PER_INVITE });
    }
    await db(INVITE).where({ id: invite.id }).update({
      ...(byEmail ? { nextEmailAt: at, emailFailures: 0, lastEmailError: null } : {}), ...(bySms ? { nextSmsAt: at, smsFailures: 0, lastSmsError: null } : {}), updatedAt: at,
    });
    await audit({ actor: actorId, action: 'b2b.beneficiary_invite.resend', target: invite.id, after: { organizationId: access.org.id, email: byEmail, sms: bySms } });
    const out = await sendDue({ inviteIds: [invite.id] });
    return { invite: inviteView(await ownInvite(access, inviteId)), sent: { email: out.email.sent === 1, sms: out.sms.sent === 1 }, emailConfigured: !out.email.notConfigured, smsConfigured: sms().configured === true };
  }

  // ── Matching: the person has joined ───────────────────────────────────────

  /**
   * A member has verified an invited email or number: ask them (consent slice
   * (a)) rather than enrol them; one request per invite. Nothing is written to
   * the invite itself (security review of #283): the match is kept in
   * B2BBeneficiaryInviteMatch, so the organisation's invite list looks the
   * same whether or not a member is behind the contact. Someone already on the
   * list (they accepted before) is not asked and gets no more messages; their
   * invite stays as it is.
   */
  async function askFromInvite(invite, userId) {
    const org = await db('B2BOrganization').where({ id: invite.organizationId }).first('id', 'status', 'legacyCorporateId');
    if (!org || org.status !== 'active' || org.legacyCorporateId) return { skipped: 'organization_not_active' };
    const remember = fields => db(MATCH).insert({ inviteId: invite.id, organizationId: org.id, ...fields, createdAt: stamp() }).onConflict('inviteId').ignore();
    const already = await db('B2BBeneficiary').where({ organizationId: org.id, userId }).first('id');
    if (already) {
      await remember({ beneficiaryId: already.id });
      return { alreadyOnList: true };
    }
    const out = await memberRequests.createFromInvite({ invite, userId });
    if (out.skipped) {
      // Already asked by this organisation, or declined it lately: this invite counts as answered by that request.
      if (out.memberRequestId) await remember({ memberRequestId: out.memberRequestId });
      return out;
    }
    await remember({ memberRequestId: out.memberRequest.id });
    // Cancelled meanwhile: withdraw what was just asked.
    const still = await db(INVITE).where({ id: invite.id }).first('status');
    if (still?.status !== 'invited') {
      await memberRequests.cancelForInvite({ inviteId: invite.id, actorId: SYSTEM });
      return { skipped: 'invite_closed' };
    }
    return { asked: true };
  }

  /**
   * Ask everyone who has joined, and verified the invited email or number,
   * since they were invited (one request per invite; never again for the same
   * invite). With `userId`, only that person (used when a member opens their
   * benefits, so they do not wait for the next run); with `inviteIds`, only
   * those invites. Verified contacts only: User.email / User.phone match nothing.
   * Returns { matched, asked, alreadyOnList, failed, skipped }.
   */
  async function matchInvites({ userId = null, inviteIds = null, limit = 500 } = {}) {
    const stats = { matched: 0, asked: 0, alreadyOnList: 0, failed: 0, skipped: 0 };
    if (!memberRequests) return stats;
    const unmatched = col => function notMatched() { this.select(db.raw('1')).from(MATCH).whereRaw(`"${MATCH}"."inviteId" = ${col}`); };
    let pairs;
    if (userId) {
      const u = await whereLiveAccount(db('User').where({ id: userId, userType: 'member' })).first('id');
      if (!u) return stats;
      const proven = await verifiedContacts.contactsFor(u.id);
      const emails = proven.filter(c => c.type === 'email').map(c => c.value);
      const phones = proven.filter(c => c.type === 'phone').map(c => c.value);
      if (!emails.length && !phones.length) return stats;
      const rows = await db(INVITE).where({ status: 'invited' }).whereNotExists(unmatched(`"${INVITE}"."id"`))
        .where(b => { if (emails.length) b.orWhereIn('email', emails); if (phones.length) b.orWhereIn('phone', phones); });
      pairs = rows.map(invite => ({ invite, userId: u.id }));
    } else {
      // Invites joined to verified contacts of live members (never User.email / User.phone).
      let q = db(`${INVITE} as i`).join(verifiedContacts.verifiedMemberRows(), function on() {
        this.on(function email() { this.on('v.type', db.raw('?', ['email'])).andOn('v.normalizedValue', 'i.email'); })
          .orOn(function phone() { this.on('v.type', db.raw('?', ['phone'])).andOn('v.normalizedValue', 'i.phone'); });
      })
        .where({ 'i.status': 'invited' }).whereNotExists(unmatched('"i"."id"'));
      if (inviteIds) q = q.whereIn('i.id', inviteIds);
      const rows = await q.orderBy('i.invitedAt').orderBy('v.userCreatedAt').limit(limit).select('i.*', 'v.userId as matchedUserId');
      pairs = rows.map(({ matchedUserId, ...invite }) => ({ invite, userId: matchedUserId }));
    }
    const done = new Set();
    for (const { invite, userId: id } of pairs) {
      if (done.has(invite.id)) continue;
      done.add(invite.id);
      stats.matched += 1;
      try {
        const out = await askFromInvite(invite, id);
        if (out.asked) stats.asked += 1; else if (out.alreadyOnList) stats.alreadyOnList += 1; else stats.skipped += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-invites] could not ask about invite ${invite.id}: ${err.message}`);
      }
    }
    return stats;
  }

  /**
   * Invites whose messages are recorded as sent but not delivered: the member
   * behind them already said no (declined), or is already on the list. The
   * invite's counters and schedule move exactly as for anyone else, so the
   * organisation cannot tell (security review of #283); only nothing reaches
   * the person.
   */
  async function quietInvites(ids) {
    if (!ids.length) return new Set();
    const rows = await db(`${MATCH} as m`).leftJoin('B2BMemberRequest as r', 'r.id', 'm.memberRequestId')
      .whereIn('m.inviteId', ids)
      .where(b => b.whereNotNull('m.beneficiaryId').orWhere('r.status', 'declined').orWhere(c => c.where('r.status', 'cancelled').whereNot('r.reason', 'cancelled_by_organization')))
      .pluck('m.inviteId');
    return new Set(rows);
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  function emailFor(invite, org, count) {
    const name = orgName(org);
    const link = appLink();
    const hello = invite.displayName ? `Hello ${invite.displayName},` : 'Hello,';
    const lines = [
      hello, '',
      count === 0
        ? `${name} wants to add you to its wellness programme on FitFlex.`
        : `A reminder: ${name} wants to add you to its wellness programme on FitFlex.`,
      '',
      `To take part, get the FitFlex app and sign up as a member with this email address (${invite.email}). The app will then ask you whether you accept; nothing is shared with ${name} unless you do.`,
      confirmLine(invite),
      link ? `Get the app: ${link}` : null,
      '',
      `What ${name} can see: if you accept, ${name} can see your FitFlex activity, including activity from before you joined (gym visits, trainer sessions, the workouts and steps you record, and your progress in its challenges). It cannot see your weight, height, or anything another sponsor gives you.`,
      '',
      `If you do not want to take part, ignore this email, decline in the app, or ask ${name} to remove you from its list.`,
    ].filter(l => l !== null);
    return { subject: count === 0 ? `${name} invites you to FitFlex` : `Reminder: ${name} invites you to FitFlex`, text: lines.join('\n') };
  }

  /**
   * For people who already have an account: the invite matches only a
   * verified email or number. The in-app tile is "Mobile number and email".
   * An email can be confirmed in the app only while FitFlex email codes are
   * on, so with them off the email doesn't promise that.
   */
  function confirmLine(invite) {
    if (emailCodes() === true) return 'Already on FitFlex? Confirm this email address or your mobile number under Mobile number and email in the FitFlex app, and the app will ask you.';
    if (invite.phone) return 'Already on FitFlex? Confirm your mobile number under Mobile number and email in the FitFlex app, and the app will ask you.';
    return 'Already on FitFlex? The app asks you once this email address is confirmed on your FitFlex account.';
  }

  /** One SMS segment in plain characters: who added them, what to do, and the link when there is one. */
  function smsFor(invite, org, count) {
    const link = appLink();
    const name = orgName(org).replace(/[^\x20-\x7E]/g, '').trim().slice(0, 30) || 'Your organisation';
    const lead = count === 0 ? `${name} invites you to its wellness programme on FitFlex.` : `Reminder: ${name} invites you to FitFlex.`;
    // Existing users must confirm the number before the invite can match them.
    const plain = `${lead} Join as a member with this number, or confirm it under Mobile number and email.`;
    const withLink = link ? `${lead} Join with this number (or confirm it under Mobile number and email): ${link}` : null;
    // A link that does not fit is left out, never cut in half.
    const text = withLink && withLink.length <= SMS_MAX_LENGTH ? withLink : plain;
    return { text: text.slice(0, SMS_MAX_LENGTH) };
  }

  const CHANNELS = Object.freeze({
    email: { contact: 'email', sent: 'emailsSent', last: 'lastEmailAt', next: 'nextEmailAt', failures: 'emailFailures', error: 'lastEmailError', reminders: REMINDER_DAYS, sender: () => emailSender(), compose: emailFor },
    sms: { contact: 'phone', sent: 'smsSent', last: 'lastSmsAt', next: 'nextSmsAt', failures: 'smsFailures', error: 'lastSmsError', reminders: SMS_REMINDER_DAYS, sender: () => sms(), compose: smsFor },
  });

  async function sendChannel(channel, { limit, inviteIds }) {
    const c = CHANNELS[channel];
    const stats = { due: 0, sent: 0, failed: 0, notConfigured: false };
    const at = stamp();
    let q = db(INVITE).where({ status: 'invited' }).whereNotNull(c.contact).whereNotNull(c.next).where(c.next, '<=', at).orderBy(c.next).limit(limit);
    if (inviteIds) q = q.whereIn('id', inviteIds);
    const due = await q;
    stats.due = due.length;
    if (!due.length) return stats;
    const sender = c.sender();
    if (!sender.configured) { stats.notConfigured = true; return stats; }
    const orgs = new Map((await db('B2BOrganization').whereIn('id', [...new Set(due.map(i => i.organizationId))])).map(o => [o.id, o]));
    const quiet = await quietInvites(due.map(i => i.id));
    for (const invite of due) {
      const org = orgs.get(invite.organizationId);
      if (!org || org.status !== 'active') continue;
      // Claim it first, so two runs at once send one message.
      const claimed = await db(INVITE).where({ id: invite.id, status: 'invited', [c.sent]: invite[c.sent] }).whereNotNull(c.next).update({ [c.next]: null, updatedAt: at });
      if (!claimed) continue;
      let ok = false;
      let error = null;
      try {
        const out = quiet.has(invite.id) ? { ok: true } : await sender.send(invite[c.contact], c.compose(invite, org, invite[c.sent]));
        ok = out?.ok === true;
        error = ok ? null : out?.error ?? 'not_accepted';
      } catch (err) {
        error = String(err?.message ?? err).slice(0, 200);
      }
      if (ok) {
        const sentCount = invite[c.sent] + 1;
        const reminder = sentCount <= c.reminders.length ? new Date(+new Date(invite.invitedAt) + c.reminders[sentCount - 1] * 86_400_000) : null;
        await db(INVITE).where({ id: invite.id }).update({ [c.sent]: sentCount, [c.last]: at, [c.failures]: 0, [c.error]: null,
          [c.next]: reminder && reminder > at ? reminder : reminder ? new Date(+at + 86_400_000) : null, updatedAt: at });
        stats.sent += 1;
      } else {
        const failures = invite[c.failures] + 1;
        // Three failures in a row and it stops; "send again" starts it over.
        await db(INVITE).where({ id: invite.id }).update({ [c.failures]: failures, [c.error]: error, [c.next]: failures >= 3 ? null : new Date(+at + 3_600_000), updatedAt: at });
        stats.failed += 1;
      }
    }
    return stats;
  }

  /** Send the messages that are due, by email and by SMS: the invitation, then the reminders. Each is sent once. */
  async function sendDue({ limit = 200, inviteIds = null } = {}) {
    const email = await sendChannel('email', { limit, inviteIds });
    const text = await sendChannel('sms', { limit, inviteIds });
    return { email, sms: text, sent: email.sent + text.sent, failed: email.failed + text.failed };
  }

  /** For the operations page. */
  async function pending() {
    const [{ invited }] = await db(INVITE).where({ status: 'invited' }).count({ invited: '*' });
    const [{ stuck }] = await db(INVITE).where({ status: 'invited' }).where(b => b.where('emailFailures', '>=', 3).orWhere('smsFailures', '>=', 3)).count({ stuck: '*' });
    const [{ withProblems }] = await db(IMPORT).where('rejected', '>', 0).where('createdAt', '>', new Date(+stamp() - 7 * 86_400_000)).count({ withProblems: '*' });
    return { invitesWaiting: Number(invited), invitesNotDelivered: Number(stuck), importsWithRejectedRowsLast7Days: Number(withProblems) };
  }

  return { importPeople, listImports, listInvites, cancelInvite, resendInvite, matchInvites, sendDue, pending };
}
