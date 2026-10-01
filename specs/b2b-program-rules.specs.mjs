// B2B Phase 2 pure rules: funding split, usage windows, validation and the
// eligibility gate a Phase 3 usage engine will call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateResponsibility, usageWindow, readFunding, readUsage, readEligibility, readBenefitEligibility,
  readProviderRules, evaluateEligibility, programEffectiveStatus, describeFunding,
} from '../src/shared/b2b-programs.mjs';

const split = (benefit, priceTzs) => {
  const r = calculateResponsibility({ benefit, priceTzs });
  assert.equal(r.sponsorTzs + r.beneficiaryTzs, priceTzs, 'shares add up to the price');
  assert.ok(r.sponsorTzs >= 0 && r.beneficiaryTzs >= 0, 'no negative share');
  return [r.sponsorTzs, r.beneficiaryTzs];
};

// ── Funding ──────────────────────────────────────────────────────────────────

test('full sponsorship: the sponsor pays everything', () => {
  assert.deepEqual(split({ fundingType: 'full' }, 5000), [5000, 0]);
});

test('fixed sponsor contribution: sponsor pays up to the amount, member the rest', () => {
  const b = { fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000 };
  assert.deepEqual(split(b, 5000), [3000, 2000]);
  assert.deepEqual(split(b, 2500), [2500, 0]);   // never more than the price
});

test('percentage subsidy, with and without a per-use cap', () => {
  assert.deepEqual(split({ fundingType: 'sponsor_percentage', sponsorShareBps: 6000 }, 5000), [3000, 2000]);
  assert.deepEqual(split({ fundingType: 'sponsor_percentage', sponsorShareBps: 5000, sponsorCapTzs: 10000 }, 40000), [10000, 30000]);
  assert.deepEqual(split({ fundingType: 'sponsor_percentage', sponsorShareBps: 3333 }, 1001), [334, 667]);   // rounds, still adds up
  assert.deepEqual(split({ fundingType: 'sponsor_percentage', sponsorShareBps: 0 }, 5000), [0, 5000]);
});

test('beneficiary copay: member pays the fixed amount, sponsor the rest', () => {
  const b = { fundingType: 'beneficiary_fixed', beneficiaryAmountTzs: 2000 };
  assert.deepEqual(split(b, 5000), [3000, 2000]);
  assert.deepEqual(split(b, 1500), [0, 1500]);
  assert.deepEqual(split({ fundingType: 'none' }, 0), [0, 0]);
  assert.throws(() => calculateResponsibility({ benefit: { fundingType: 'full' }, priceTzs: -1 }), /price/);
});

test('funding validation carries exactly the numbers each type needs', () => {
  assert.equal(readFunding({ fundingType: 'gift' }).error, 'invalid_funding_type');
  assert.equal(readFunding({ fundingType: 'sponsor_fixed' }).error, 'invalid_sponsor_amount');
  assert.equal(readFunding({ fundingType: 'sponsor_fixed', sponsorAmountTzs: 2500.5 }).error, 'invalid_sponsor_amount');
  assert.equal(readFunding({ fundingType: 'sponsor_percentage', sponsorShareBps: 10001 }).error, 'invalid_sponsor_share');
  assert.equal(readFunding({ fundingType: 'sponsor_percentage', sponsorShareBps: -1 }).error, 'invalid_sponsor_share');
  assert.equal(readFunding({ fundingType: 'beneficiary_fixed' }).error, 'invalid_beneficiary_amount');
  // Stray numbers from another type are dropped, not stored.
  assert.deepEqual(readFunding({ fundingType: 'full', sponsorAmountTzs: 999 }).patch,
    { fundingType: 'full', sponsorAmountTzs: null, sponsorShareBps: null, sponsorCapTzs: null, beneficiaryAmountTzs: null });
  assert.equal(describeFunding({ fundingType: 'sponsor_percentage', sponsorShareBps: 6000, sponsorCapTzs: 3000 }), 'Sponsor pays 60% (max TZS 3,000); beneficiary pays the rest');
});

// ── Usage limits ─────────────────────────────────────────────────────────────

const program = { startDate: '2027-01-10', endDate: '2027-12-20' };
const win = (usagePeriod, day, extra = {}) => usageWindow({ benefit: { usagePeriod, usageLimit: 8, ...extra }, program, day });

test('usage windows: daily, weekly (Mon–Sun), monthly, quarterly, whole programme and unlimited', () => {
  assert.deepEqual([win('day', '2027-03-15').start, win('day', '2027-03-15').end], ['2027-03-15', '2027-03-15']);
  assert.deepEqual([win('week', '2027-03-17').start, win('week', '2027-03-17').end], ['2027-03-15', '2027-03-21']);
  assert.deepEqual([win('month', '2027-02-10').start, win('month', '2027-02-10').end], ['2027-02-01', '2027-02-28']);
  assert.deepEqual([win('quarter', '2027-05-02').start, win('quarter', '2027-05-02').end], ['2027-04-01', '2027-06-30']);
  assert.deepEqual([win('program', '2027-05-02').start, win('program', '2027-05-02').end], ['2027-01-10', '2027-12-20']);
  assert.equal(win('month', '2027-02-10').usageLimit, 8);
  assert.equal(usageWindow({ benefit: { usagePeriod: 'unlimited' }, program, day: '2027-05-02' }), null);
});

test('usage windows are clipped to the benefit / programme validity', () => {
  assert.deepEqual([win('month', '2027-01-15').start, win('month', '2027-12-25').end], ['2027-01-10', '2027-12-20']);
  const own = usageWindow({ benefit: { usagePeriod: 'program', startDate: '2027-06-01', endDate: '2027-06-30' }, program, day: '2027-06-10' });
  assert.deepEqual([own.start, own.end], ['2027-06-01', '2027-06-30']);
  const open = usageWindow({ benefit: { usagePeriod: 'program' }, program: { startDate: '2027-01-01', endDate: null }, day: '2027-06-10' });
  assert.deepEqual([open.start, open.end], ['2027-01-01', null]);
});

test('usage-limit validation', () => {
  assert.deepEqual(readUsage({ usagePeriod: 'month', usageLimit: 8 }, 'full').patch, { usagePeriod: 'month', usageLimit: 8, periodSponsorCapTzs: null });
  assert.deepEqual(readUsage({}, 'full').patch, { usagePeriod: 'unlimited', usageLimit: null, periodSponsorCapTzs: null });
  assert.equal(readUsage({ usagePeriod: 'fortnight' }, 'full').error, 'invalid_usage_period');
  assert.equal(readUsage({ usagePeriod: 'month', usageLimit: 0 }, 'full').error, 'invalid_usage_limit');
  assert.equal(readUsage({ usagePeriod: 'month', usageLimit: 1.5 }, 'full').error, 'invalid_usage_limit');
  assert.equal(readUsage({ usagePeriod: 'unlimited', usageLimit: 4 }, 'full').error, 'unlimited_has_no_limits');
  assert.equal(readUsage({ usagePeriod: 'month', periodSponsorCapTzs: 50000 }, 'none').error, 'no_sponsor_money_to_cap');
  // A monthly marketplace allowance: money cap without a count.
  assert.deepEqual(readUsage({ usagePeriod: 'month', periodSponsorCapTzs: 50000 }, 'full').patch, { usagePeriod: 'month', usageLimit: null, periodSponsorCapTzs: 50000 });
});

// ── Providers ────────────────────────────────────────────────────────────────

test('provider rules follow the benefit type', () => {
  assert.deepEqual(readProviderRules('gym_access', undefined).value, { scope: 'all' });
  assert.deepEqual(readProviderRules('gym_access', { scope: 'selected', gymIds: ['g1', 'g1', 'g2'], gymTiers: ['standard'] }).value,
    { scope: 'selected', gymIds: ['g1', 'g2'], gymTiers: ['standard'] });
  assert.equal(readProviderRules('gym_access', { scope: 'selected', trainerIds: ['t1'] }).error, 'invalid_provider_rules');
  assert.equal(readProviderRules('gym_access', { scope: 'selected' }).error, 'provider_rules_empty');
  assert.equal(readProviderRules('gym_access', { scope: 'selected', gymTiers: ['gold'] }).error, 'invalid_gym_tier');
  assert.deepEqual(readProviderRules('marketplace', { scope: 'selected', productCategories: ['supplements'] }).value, { scope: 'selected', productCategories: ['supplements'] });
  assert.equal(readProviderRules('custom', { scope: 'selected', gymIds: ['g1'] }).error, 'provider_rules_not_supported');
});

// ── Eligibility ──────────────────────────────────────────────────────────────

const DAY = '2027-03-15';
const prog = (extra = {}) => ({ status: 'active', startDate: '2027-01-01', endDate: '2027-12-31', eligibility: { scope: 'all' }, ...extra });
const person = (extra = {}) => ({ id: 'b1', status: 'active', groupName: 'Finance', beneficiaryType: 'employee', enrolledAt: '2026-11-01T00:00:00.000Z', ...extra });
const benefit = (extra = {}) => ({ status: 'active', usagePeriod: 'month', ...extra });
const check = (extra = {}) => evaluateEligibility({ program: prog(), benefit: benefit(), beneficiary: person(), day: DAY, ...extra });

test('an active beneficiary of an active programme with an active benefit is eligible', () => {
  assert.deepEqual(check(), { eligible: true, reason: null });
});

test('each failed check is named', () => {
  assert.equal(check({ beneficiary: person({ status: 'suspended' }) }).reason, 'beneficiary_not_active');
  assert.equal(check({ beneficiary: person({ status: 'pending' }) }).reason, 'beneficiary_not_active');
  assert.equal(check({ program: prog({ status: 'paused' }) }).reason, 'program_not_active');
  assert.equal(check({ program: prog({ endDate: '2027-03-01' }) }).reason, 'program_expired');
  assert.equal(check({ program: prog({ status: 'expired' }) }).reason, 'program_expired');
  assert.equal(check({ program: prog({ startDate: '2027-04-01' }) }).reason, 'outside_program_dates');
  assert.equal(check({ benefit: benefit({ status: 'inactive' }) }).reason, 'benefit_not_active');
  assert.equal(check({ benefit: benefit({ startDate: '2027-06-01' }) }).reason, 'outside_benefit_dates');
});

test('population rules: groups, selected beneficiaries, types, enrolment date and benefit narrowing', () => {
  const groups = prog({ eligibility: { scope: 'groups', groups: ['Operations'] } });
  assert.equal(check({ program: groups }).reason, 'not_in_group');
  assert.equal(check({ program: groups, beneficiary: person({ groupName: 'Operations' }) }).eligible, true);
  const selected = prog({ eligibility: { scope: 'selected', beneficiaryIds: ['b2'] } });
  assert.equal(check({ program: selected }).reason, 'not_selected');
  assert.equal(check({ program: selected, beneficiary: person({ id: 'b2' }) }).eligible, true);
  assert.equal(check({ program: prog({ eligibility: { scope: 'all', beneficiaryTypes: ['policyholder'] } }) }).reason, 'beneficiary_type_not_eligible');
  assert.equal(check({ program: prog({ eligibility: { scope: 'all', enrolledOnOrBefore: '2026-10-01' } }) }).reason, 'enrolled_too_late');
  assert.equal(check({ benefit: benefit({ eligibility: { groups: ['Sales'], beneficiaryTypes: [] } }) }).reason, 'benefit_not_for_group');
  assert.equal(check({ benefit: benefit({ eligibility: { groups: [], beneficiaryTypes: ['dependant'] } }) }).reason, 'benefit_not_for_beneficiary_type');
  // Programme-level check (no benefit) ignores benefit rules.
  assert.equal(evaluateEligibility({ program: prog(), beneficiary: person(), day: DAY }).eligible, true);
});

test('eligibility validation', () => {
  assert.deepEqual(readEligibility(undefined).value, { scope: 'all', groups: [], beneficiaryIds: [], beneficiaryTypes: [], enrolledOnOrBefore: null });
  assert.equal(readEligibility({ scope: 'departments' }).error, 'invalid_eligibility_scope');
  assert.equal(readEligibility({ scope: 'groups' }).error, 'eligibility_groups_required');
  assert.equal(readEligibility({ scope: 'selected', beneficiaryIds: [] }).error, 'eligibility_beneficiaries_required');
  assert.equal(readEligibility({ scope: 'all', enrolledOnOrBefore: '2027-02-30' }).error, 'invalid_enrolled_on_or_before');
  // Lists that don't apply to the scope are dropped.
  assert.deepEqual(readEligibility({ scope: 'all', groups: ['x'], beneficiaryIds: ['y'] }).value.groups, []);
  assert.equal(readBenefitEligibility({ groups: [] }).value, null);
  assert.equal(programEffectiveStatus({ status: 'paused', endDate: '2027-01-01' }, DAY), 'expired');
  assert.equal(programEffectiveStatus({ status: 'draft', endDate: '2027-01-01' }, DAY), 'draft');
});
