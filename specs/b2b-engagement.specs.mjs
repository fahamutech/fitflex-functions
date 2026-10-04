// Challenges, their rewards and groups for B2B organisations, and the fix
// for companies: belonging comes from the people list (an employee or
// beneficiary linked to their FitFlex account), not from a field on the
// member's account that nothing ever set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createChallengeService } from '../src/services/challenge-service.mjs';
import { createChallengeRewardService } from '../src/services/challenge-reward-service.mjs';
import { createSocialService } from '../src/services/social-service.mjs';
import { createActivityService } from '../src/services/activity-service.mjs';
import { createCompanyDirectory } from '../src/services/company-directory.mjs';
import { ROLE_PERMISSIONS } from '../src/shared/b2b.mjs';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { b2bService, corporateService, signJwt as sign } from '../src/bootstrap/services.mjs';
import * as routes from '../functions/challenges.mjs';
import * as rewardRoutes from '../functions/challenge-rewards.mjs';
import * as groupRoutes from '../functions/social.mjs';

await ensureInit();

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async filterByColumnInAsync(col, vs) { return rows.filter(r => vs.includes(r[col])).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
    async removeByIdAsync(id) { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

const NOW = new Date('2026-09-24T06:00:00.000Z');   // Thursday, 09:00 EAT
const now = () => NOW;
const at = d => `${d}T05:00:00.000Z`;
const ORG = { creatorType: 'organization', creatorId: 'org_jubilee', createdBy: 'hr_user' };
const OTHER_ORG = { creatorType: 'organization', creatorId: 'org_other', createdBy: 'x' };
const CORP = { creatorType: 'corporate', creatorId: 'corp_1', createdBy: 'hr_1' };
const base = { name: '50K Steps', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-30' };

/**
 * An insurer (a B2B organisation) with five policyholders in two groups, one
 * suspended; another organisation; a company whose employees are linked to
 * their accounts but whose accounts carry no `corporateId`.
 */
function setup() {
  const member = (id, extra = {}) => ({ id, userType: 'member', displayName: `${id.toUpperCase()} Person`, accountStatus: 'active', corporateId: null, ...extra });
  const s = {
    users: store([...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'q1', 'e1', 'e2', 'e3', 'stranger'].map(id => member(id)), member('hr_user', { userType: 'corporate_hr', corporateId: 'corp_1' })]),
    beneficiaries: store([
      { id: 'ben_p1', organizationId: 'org_jubilee', userId: 'p1', groupName: 'Gold', status: 'active' },
      { id: 'ben_p2', organizationId: 'org_jubilee', userId: 'p2', groupName: 'Gold', status: 'active' },
      { id: 'ben_p3', organizationId: 'org_jubilee', userId: 'p3', groupName: 'Gold', status: 'active' },
      { id: 'ben_p4', organizationId: 'org_jubilee', userId: 'p4', groupName: 'Silver', status: 'active' },
      { id: 'ben_p5', organizationId: 'org_jubilee', userId: 'p5', groupName: 'Gold', status: 'suspended' },
      { id: 'ben_p6', organizationId: 'org_jubilee', userId: 'p6', groupName: null, status: 'active' },
      { id: 'ben_q1', organizationId: 'org_other', userId: 'q1', groupName: 'Gold', status: 'active' },
    ]),
    corporateEmployees: store([
      { id: 'emp_e1', corporateId: 'corp_1', userId: 'e1', displayName: 'E1 Staff', department: 'Finance', status: 'active' },
      { id: 'emp_e2', corporateId: 'corp_1', userId: 'e2', displayName: 'E2 Staff', department: 'Finance', status: 'active' },
      { id: 'emp_e3', corporateId: 'corp_1', userId: null, displayName: 'Not linked', department: 'Finance', status: 'active' },
    ]),
    challenges: store(), participants: store(), teams: store(), awards: store(), auditLog: store(),
    subscriptions: store([]), trainers: store([]), gyms: store([]), relationships: store([]), gymMemberSharing: store([]), checkins: store([]),
    activities: store([
      { id: 'a1', userId: 'p1', type: 'walking', source: 'manual', startedAt: at('2026-09-21'), steps: 60000 },
      { id: 'a2', userId: 'p2', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 20000 },
      { id: 'a3', userId: 'p3', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 50000 },
      { id: 'a4', userId: 'p4', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 10000 },
    ]),
    follows: store(), blocks: store(), profiles: store(), groups: store(), groupMembers: store(), kudos: store(), comments: store(), reports: store(),
  };
  s.directory = createCompanyDirectory({ users: s.users, corporateEmployees: s.corporateEmployees, beneficiaries: s.beneficiaries });
  s.svc = createChallengeService({ ...s, rewardAwards: s.awards, gymMemberIds: async () => new Map(), now });
  s.rw = createChallengeRewardService({
    challenges: s.challenges, participants: s.participants, awards: s.awards, users: s.users, corporateEmployees: s.corporateEmployees,
    challengeService: s.svc, auditLog: s.auditLog, directory: s.directory, notify: async () => {}, now,
  });
  s.social = createSocialService({ ...s, notify: async () => {}, now });
  s.acts = createActivityService({ activities: s.activities, resolveShare: (m, raw) => s.social.resolveShare(m, raw), now });
  return s;
}
const visible = async (s, m) => (await s.svc.memberChallenges(m)).challenges.map(c => c.name);

// ── Who belongs ──────────────────────────────────────────────────────────────

test('directory: people and memberships come from the list, for a company and for an organisation', async () => {
  const s = setup();
  assert.deepEqual((await s.directory.peopleOf('organization', 'org_jubilee')).map(p => [p.id, p.department, p.displayName]),
    [['ben_p1', 'Gold', 'P1 Person'], ['ben_p2', 'Gold', 'P2 Person'], ['ben_p3', 'Gold', 'P3 Person'], ['ben_p4', 'Silver', 'P4 Person'], ['ben_p6', null, 'P6 Person']]);   // the suspended one doesn't count
  assert.deepEqual((await s.directory.peopleOf('corporate', 'corp_1')).map(p => p.id), ['emp_e1', 'emp_e2', 'emp_e3']);
  assert.deepEqual((await s.directory.membershipsOf('p1')).map(m => [m.type, m.id, m.person.id]), [['organization', 'org_jubilee', 'ben_p1']]);
  // A linked employee belongs although their account has no corporateId.
  assert.deepEqual((await s.directory.membershipsOf('e1')).map(m => [m.type, m.id, m.person.id]), [['corporate', 'corp_1', 'emp_e1']]);
  assert.deepEqual(await s.directory.membershipsOf('p5'), []);          // suspended
  assert.deepEqual(await s.directory.membershipsOf('stranger'), []);
  assert.deepEqual(await s.directory.membershipsOf('hr_user'), []);     // HR is not a colleague
  assert.deepEqual([...(await s.directory.colleaguesOf('p1'))].sort(), ['p2', 'p3', 'p4', 'p6']);
  assert.deepEqual([...(await s.directory.colleaguesOf('e1'))], ['e2']);
});

// ── Challenges ───────────────────────────────────────────────────────────────

test('an organisation\'s challenge is for its own active people; narrowed by group or by chosen people', async () => {
  const s = setup();
  const all = (await s.svc.create(ORG, { ...base, name: 'Everyone' })).challenge;
  assert.deepEqual([all.creatorType, all.creatorId, all.visibility, all.rewardFunding], ['organization', 'org_jubilee', 'audience', 'company']);
  await s.svc.create(ORG, { ...base, name: 'Gold only', eligibility: { kind: 'departments', departments: ['gold'] } });
  await s.svc.create(ORG, { ...base, name: 'Two people', eligibility: { kind: 'employees', employeeIds: ['ben_p4', 'ben_p6'] } });
  await s.svc.create(OTHER_ORG, { ...base, name: 'Other org' });

  assert.deepEqual(await visible(s, 'p1'), ['Everyone', 'Gold only']);
  assert.deepEqual(await visible(s, 'p4'), ['Everyone', 'Two people']);
  assert.deepEqual(await visible(s, 'p6'), ['Everyone', 'Two people']);
  assert.deepEqual(await visible(s, 'q1'), ['Other org']);
  assert.deepEqual(await visible(s, 'p5'), []);          // suspended
  assert.deepEqual(await visible(s, 'stranger'), []);
  assert.equal((await s.svc.join('stranger', all.id)).status, 404);
  assert.equal((await s.svc.join('p1', all.id)).participant?.status ?? 'joined', 'joined');
  // To a member it reads as "by your company", whichever kind of body runs it.
  assert.equal((await s.svc.memberChallenge('p1', all.id)).challenge.creator.type, 'corporate');

  // A group or a person the organisation doesn't have is refused.
  assert.equal((await s.svc.create(ORG, { ...base, eligibility: { kind: 'departments', departments: ['Platinum'] } })).error, 'invalid_eligibility');
  assert.equal((await s.svc.create(ORG, { ...base, eligibility: { kind: 'employees', employeeIds: ['ben_q1'] } })).error, 'invalid_eligibility');
  assert.equal((await s.svc.create(ORG, { ...base, eligibility: { kind: 'tiers', tiers: ['pro'] } })).error, 'invalid_eligibility');
  // Each organisation manages only its own.
  assert.deepEqual((await s.svc.creatorList(ORG)).challenges.map(c => c.name).sort(), ['Everyone', 'Gold only', 'Two people']);
  assert.equal((await s.svc.cancel(OTHER_ORG, all.id)).status, 404);
  assert.equal((await s.svc.creatorParticipants(OTHER_ORG, all.id)).status, 404);
});

test('an organisation sees totals only, by group, with small groups folded; group teams come from the list', async () => {
  const s = setup();
  const c = (await s.svc.create(ORG, { ...base, mode: 'department' })).challenge;
  for (const m of ['p1', 'p2', 'p3', 'p4']) await s.svc.join(m, c.id);
  const view = await s.svc.creatorParticipants(ORG, c.id);
  assert.deepEqual(view.summary, { eligible: 5, joined: 4, participationRate: 0.8, completed: 2, completionRate: 0.5, averageProgress: 0.65 });
  assert.deepEqual(view.byDepartment, [
    { department: 'Gold', other: false, eligible: 3, joined: 3, participationRate: 1, completed: 2, averageProgress: 0.8 },
    { department: null, other: true, eligible: 2, joined: 1, participationRate: 0.5 },   // Silver and ungrouped: too few to show
  ]);
  assert.equal(JSON.stringify(view).includes('P1 Person'), false);   // never who
  const lb = await s.svc.leaderboard(ORG, c.id);
  assert.deepEqual(lb.teams.map(t => [t.name, t.members]), [['Gold', 3]]);
  assert.equal(lb.hiddenTeams, 1);
});

test('the fix for companies: a linked employee sees and joins the company\'s challenge without a corporateId on their account', async () => {
  const s = setup();
  const c = (await s.svc.create(CORP, { ...base, name: 'Company only' })).challenge;
  assert.deepEqual(await visible(s, 'e1'), ['Company only']);
  assert.deepEqual(await visible(s, 'p1'), []);
  assert.ok(!(await s.svc.join('e1', c.id)).error);
  assert.equal((await s.svc.creatorParticipants(CORP, c.id)).summary.eligible, 3);
});

// ── Rewards ──────────────────────────────────────────────────────────────────

test('rewards an organisation funds go to its own queue, with names and groups and never activity', async () => {
  const s = setup();
  const own = (await s.svc.create(ORG, { ...base, name: 'Jubilee', rewardItems: [{ type: 'corporate_reward', label: 'Premium discount' }] })).challenge;
  const byFitflex = (await s.svc.create(ORG, { ...base, name: 'Jubilee x FitFlex', rewardFunding: 'fitflex', rewardItems: [{ type: 'gym_pass', label: '7-day pass' }] })).challenge;
  const other = (await s.svc.create(OTHER_ORG, { ...base, name: 'Other', rewardItems: [{ type: 'badge', label: 'Badge' }] })).challenge;
  for (const c of [own, byFitflex]) for (const m of ['p1', 'p2']) await s.svc.join(m, c.id);
  await s.svc.join('q1', other.id);
  await s.rw.settleDue();

  const mine = await s.rw.queue({ kind: 'organization', organizationId: 'org_jubilee' });
  assert.deepEqual(mine.rewards.map(r => [r.reward.label, r.member]), [['Premium discount', { id: 'p1', displayName: 'P1 Person', department: 'Gold' }]]);
  for (const k of ['progress', 'fraction', 'activities', 'steps']) assert.ok(!(k in mine.rewards[0]), `no ${k}`);
  assert.equal((await s.rw.queue({ kind: 'organization', organizationId: 'org_other' })).rewards.length, 0);   // q1 logged nothing
  // FitFlex hands out what FitFlex funds; the organisation's own are not FitFlex's to settle.
  assert.deepEqual((await s.rw.queue({ kind: 'admin' })).rewards.map(r => r.challenge.name), ['Jubilee x FitFlex']);

  const award = mine.rewards[0];
  assert.equal((await s.rw.setStatus({ kind: 'organization', organizationId: 'org_other' }, 'x', award.id, { status: 'approved' })).status, 404);
  assert.equal((await s.rw.setStatus({ kind: 'admin' }, 'admin', award.id, { status: 'approved' })).status, 404);
  assert.equal((await s.rw.setStatus({ kind: 'organization', organizationId: 'org_jubilee' }, 'hr_user', award.id, { status: 'approved' })).reward.status, 'approved');
});

// ── Groups and the company audience ──────────────────────────────────────────

test('an organisation\'s group is found and joined only by its own people', async () => {
  const s = setup();
  const owner = { ownerType: 'organization', ownerId: 'org_jubilee', createdBy: 'hr_user' };
  const { group } = await s.social.createGroup(owner, { name: 'Jubilee Runners', joinPolicy: 'open', discoverable: true });
  assert.deepEqual((await s.social.ownedGroups(owner)).groups.map(g => g.name), ['Jubilee Runners']);
  assert.deepEqual((await s.social.ownedGroups({ ownerType: 'organization', ownerId: 'org_other' })).groups, []);

  assert.deepEqual((await s.social.discoverGroups('p1')).groups.map(g => g.name), ['Jubilee Runners']);
  assert.deepEqual((await s.social.discoverGroups('q1')).groups, []);
  assert.deepEqual((await s.social.discoverGroups('stranger')).groups, []);
  assert.ok(!(await s.social.joinGroup('p1', { groupId: group.id })).error);
  // Not with the invite code either.
  assert.deepEqual(await s.social.joinGroup('q1', { inviteCode: group.inviteCode }).then(r => [r.error, r.status]), ['company_only', 403]);
  assert.equal((await s.social.joinGroup('p5', { inviteCode: group.inviteCode })).error, 'company_only');   // suspended
  // Another organisation can't manage it.
  assert.equal((await s.social.archiveGroup({ ownerType: 'organization', ownerId: 'org_other' }, group.id)).status, 404);
});

test('the company audience reaches colleagues of the same organisation or company, and nobody else', async () => {
  const s = setup();
  const log = async (who, shareWith) => (await s.acts.log(who, { type: 'running', startedAt: new Date(+NOW - 7200e3).toISOString(), distanceKm: 5, durationMinutes: 30, shareWith })).activity;
  const sees = async (viewer, a) => s.social.canView(viewer, await s.activities.findByIdAsync(a.id));

  assert.equal((await s.social.settings('p1')).hasCompany, true);
  assert.equal((await s.social.settings('stranger')).hasCompany, false);
  assert.equal((await s.acts.log('stranger', { type: 'running', startedAt: new Date(+NOW - 3600e3).toISOString(), distanceKm: 1, durationMinutes: 5, shareWith: { company: true } })).error, 'no_company');

  const a = await log('p1', { company: true });
  assert.equal(await sees('p2', a), true);
  assert.equal(await sees('p4', a), true);        // another group, same organisation
  assert.equal(await sees('q1', a), false);       // another organisation
  assert.equal(await sees('p5', a), false);       // suspended
  assert.equal(await sees('stranger', a), false);
  // A company's linked employees are colleagues too (their accounts carry no corporateId); HR never is.
  const b = await log('e1', { company: true });
  assert.equal(await sees('e2', b), true);
  assert.equal(await sees('p1', b), false);
  assert.equal(await sees('hr_user', b), false);
  assert.ok((await s.social.feed('p2')).items.some(i => i.activity.id === a.id));
  assert.deepEqual((await s.social.findPeople('p1', { q: 'P4' })).people.map(p => p.id), ['p4']);
});

// ── Who may run them ─────────────────────────────────────────────────────────

test('roles: owner, admin, manager and HR run challenges and groups; analysts look; finance and viewers do not', () => {
  const can = role => [ROLE_PERMISSIONS[role].includes('engagement.read'), ROLE_PERMISSIONS[role].includes('engagement.manage')];
  assert.deepEqual(Object.fromEntries(Object.keys(ROLE_PERMISSIONS).map(r => [r, can(r)])), {
    owner: [true, true], admin: [true, true], manager: [true, true], hr: [true, true],
    finance: [false, false], analyst: [true, false], viewer: [false, false],
  });
});

// ── Routes (against the CI database) ─────────────────────────────────────────


const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], corporates: [], challenges: [], groups: [] };
async function account(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Engage ${userType} ${id.slice(-4)}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { method: route.method.toUpperCase(), headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  await db('ChallengeParticipant').whereIn('challengeId', made.challenges).del();
  await db('Challenge').whereIn('id', made.challenges).del();
  await db('SocialGroupMember').whereIn('groupId', made.groups).del();
  await db('SocialGroup').whereIn('id', made.groups).del();
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  if (orgIds.length) await db('B2BOrganization').whereIn('id', orgIds).del();
  if (made.corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

test('routes: an organisation\'s HR user runs challenges and groups for it; other roles and other organisations are kept out', async () => {
  const admin = await account('admin');
  const mk = async () => {
    const { organization } = await b2bService.createOrganization({ body: { organizationType: 'insurer', legalName: `Engage insurer ${uid('o')}` }, actorId: admin });
    made.orgs.push(organization.id);
    await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: admin });
    return organization.id;
  };
  const orgA = await mk();
  const orgB = await mk();
  const accessA = await b2bService.resolveAccess({ organizationId: orgA, userId: admin, userType: 'admin' });
  const role = async (r) => {
    const sub = await account('member');
    await b2bService.addOrganizationUser({ access: accessA, body: { userId: sub, role: r }, actorId: admin });
    return { sub, userType: 'member' };
  };
  const hr = await role('hr');
  const analyst = await role('analyst');
  const finance = await role('finance');
  const member = await account('member');
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: accessA, body: { userId: member, status: 'active', groupName: 'Gold' }, actorId: admin });
  const P = { organizationId: orgA };
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const challenge = { name: 'Route steps', type: 'steps', target: 1000, startDate: today, endDate: today, eligibility: { kind: 'employees', employeeIds: [beneficiary.id] } };

  const created = await call(routes.organizationCreateChallenge, { claims: hr, params: P, body: challenge });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  made.challenges.push(created.body.challenge.id);
  assert.deepEqual([created.body.challenge.creatorType, created.body.challenge.creatorId], ['organization', orgA]);
  assert.deepEqual((await call(routes.organizationChallenges, { claims: hr, params: P })).body.challenges.map(c => c.name), ['Route steps']);
  // The member it is for sees it in the app; the organisation sees totals.
  const mine = await call(routes.myChallenges, { claims: { sub: member, userType: 'member' } });
  assert.ok(mine.body.challenges.some(c => c.id === created.body.challenge.id), JSON.stringify(mine.body));
  assert.equal((await call(routes.organizationChallengeParticipants, { claims: hr, params: { ...P, id: created.body.challenge.id } })).body.summary.eligible, 1);

  // An analyst may look, not change; finance and outsiders get nothing.
  assert.equal((await call(routes.organizationChallenges, { claims: analyst, params: P })).statusCode, 200);
  assert.deepEqual(await call(routes.organizationCreateChallenge, { claims: analyst, params: P, body: challenge }).then(r => [r.statusCode, r.body.error]), [403, 'forbidden']);
  assert.deepEqual(await call(routes.organizationChallenges, { claims: finance, params: P }).then(r => [r.statusCode, r.body.error]), [403, 'forbidden']);
  assert.equal((await call(routes.organizationChallenges, { claims: { sub: member, userType: 'member' }, params: P })).statusCode, 404);
  // Another organisation: not through its id, and not its challenge through one's own.
  assert.equal((await call(routes.organizationChallenges, { claims: hr, params: { organizationId: orgB } })).statusCode, 404);
  const accessB = await b2bService.resolveAccess({ organizationId: orgB, userId: admin, userType: 'admin' });
  const hrB = { sub: await account('member'), userType: 'member' };
  await b2bService.addOrganizationUser({ access: accessB, body: { userId: hrB.sub, role: 'hr' }, actorId: admin });
  assert.equal((await call(routes.organizationCancelChallenge, { claims: hrB, params: { organizationId: orgB, id: created.body.challenge.id } })).statusCode, 404);

  // Groups and rewards go through the same check.
  const group = await call(groupRoutes.organizationCreateGroup, { claims: hr, params: P, body: { name: 'Route group', joinPolicy: 'open', discoverable: true } });
  assert.equal(group.statusCode, 201, JSON.stringify(group.body));
  made.groups.push(group.body.group.id);
  assert.deepEqual((await call(groupRoutes.organizationGroups, { claims: hr, params: P })).body.groups.map(g => g.name), ['Route group']);
  assert.equal((await call(groupRoutes.organizationCreateGroup, { claims: analyst, params: P, body: { name: 'x', joinPolicy: 'open' } })).statusCode, 403);
  assert.equal((await call(rewardRoutes.organizationRewards, { claims: hr, params: P })).statusCode, 200);
  assert.equal((await call(rewardRoutes.organizationRewards, { claims: finance, params: P })).statusCode, 403);

  // A suspended organisation can be looked at, not changed.
  await b2bService.setOrganizationStatus({ organizationId: orgA, status: 'suspended', actorId: admin });
  assert.equal((await call(routes.organizationCreateChallenge, { claims: hr, params: P, body: challenge })).statusCode, 403);
});

test('routes: a company from Companies shares its challenges between its HR login and its organisation users', async () => {
  const admin = await account('admin');
  const { account: corp } = await corporateService.onboard({ body: { companyName: `Engage Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit: 5 }, actorId: admin });
  made.corporates.push(corp.id);
  await corporateService.setStatus({ corporateId: corp.id, status: 'active', actorId: admin });
  const orgId = (await b2bService.organizationForCorporate({ corporateId: corp.id })).organization.id;
  const hrLogin = { sub: await account('corporate_hr', { corporateId: corp.id }), userType: 'corporate_hr' };
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

  // The company's HR login, through the organisation routes: it is stored as the company's.
  const created = await call(routes.organizationCreateChallenge, { claims: hrLogin, params: { organizationId: orgId }, body: { name: 'Shared', type: 'steps', target: 1000, startDate: today, endDate: today } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  made.challenges.push(created.body.challenge.id);
  assert.deepEqual([created.body.challenge.creatorType, created.body.challenge.creatorId], ['corporate', corp.id]);
  // …so the older company routes show the same challenge.
  assert.deepEqual((await call(routes.corporateChallenges, { claims: hrLogin })).body.challenges.map(c => c.name), ['Shared']);
});
