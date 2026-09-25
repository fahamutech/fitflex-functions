// Communications M1 — pure rules: purposes → categories, campaign status
// changes, sender invariants, member preferences, and the shared direct
// member status the Members list and audiences both use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PURPOSES, categoryForPurpose, canTransitionCampaign, validSender,
  DEFAULT_PREFERENCES, effectivePreferences, channelAllowed, CHANNELS,
} from '../src/shared/communications.mjs';
import { daysLeft, directMembershipStatus, EXPIRING_SOON_DAYS } from '../src/shared/member-status.mjs';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const inDays = (n) => new Date(+NOW + n * 86_400_000).toISOString();

// ── purposes and categories ────────────────────────────────────────────────

test('renewals, payments and announcements are transactional; promotions and engagement are marketing', () => {
  assert.equal(categoryForPurpose('renewal'), 'transactional');
  assert.equal(categoryForPurpose('payment'), 'transactional');
  assert.equal(categoryForPurpose('announcement'), 'transactional');
  assert.equal(categoryForPurpose('promotion'), 'marketing');
  assert.equal(categoryForPurpose('engagement'), 'marketing');
  // "General" can't claim transactional status to get past a marketing opt-out.
  assert.equal(categoryForPurpose('general'), 'marketing');
  assert.equal(categoryForPurpose('nonsense'), null);
  assert.deepEqual(PURPOSES.sort(), ['announcement', 'engagement', 'general', 'payment', 'promotion', 'renewal']);
});

// ── campaign status machine ────────────────────────────────────────────────

test('a draft can be scheduled, sent or cancelled; a sent campaign can never change again', () => {
  assert.ok(canTransitionCampaign('draft', 'scheduled'));
  assert.ok(canTransitionCampaign('draft', 'sending'));
  assert.ok(canTransitionCampaign('draft', 'cancelled'));
  assert.ok(canTransitionCampaign('scheduled', 'draft'));
  assert.ok(canTransitionCampaign('sending', 'partially_failed'));
  for (const done of ['sent', 'partially_failed', 'failed', 'cancelled']) {
    for (const to of ['draft', 'scheduled', 'sending', 'sent']) {
      assert.equal(canTransitionCampaign(done, to), false, `${done} → ${to}`);
    }
  }
  // Only the dispatcher moves a campaign out of "sending".
  assert.equal(canTransitionCampaign('sending', 'cancelled'), false);
  assert.equal(canTransitionCampaign('bogus', 'sent'), false);
});

test('a gym sender always names its gym; a FitFlex (platform) sender never does', () => {
  assert.ok(validSender('gym', 'gym_1'));
  assert.equal(validSender('gym', null), false);
  assert.ok(validSender('platform', null));
  assert.equal(validSender('platform', 'gym_1'), false);
  assert.equal(validSender('trainer', 'gym_1'), false);
});

// ── preferences ────────────────────────────────────────────────────────────

test('with no preference row: everything is on except WhatsApp marketing', () => {
  assert.deepEqual(effectivePreferences(null), { ...DEFAULT_PREFERENCES });
  assert.equal(DEFAULT_PREFERENCES.whatsappMarketing, false);
  assert.equal(channelAllowed(null, 'in_app', 'marketing').allowed, true);
  assert.equal(channelAllowed(null, 'push', 'marketing').allowed, true);
  assert.equal(channelAllowed(null, 'whatsapp', 'transactional').allowed, true);
  assert.deepEqual(channelAllowed(null, 'whatsapp', 'marketing'), { allowed: false, reason: 'whatsapp_marketing_not_opted_in' });
});

test('turning every marketing switch off never blocks a transactional message', () => {
  const allOff = { inAppMarketing: false, pushMarketing: false, whatsappMarketing: false };
  for (const channel of CHANNELS) {
    assert.equal(channelAllowed(allOff, channel, 'transactional').allowed, true, channel);
    assert.equal(channelAllowed(allOff, channel, 'marketing').allowed, false, channel);
  }
  assert.equal(channelAllowed(allOff, 'in_app', 'marketing').reason, 'in_app_marketing_off');
  assert.equal(channelAllowed(allOff, 'push', 'marketing').reason, 'push_marketing_off');
});

test('WhatsApp marketing goes out only after the member opts in', () => {
  assert.equal(channelAllowed({ whatsappMarketing: true }, 'whatsapp', 'marketing').allowed, true);
});

test('a WhatsApp opt-out (STOP) blocks every WhatsApp message but not in-app or push', () => {
  const stopped = { whatsappMarketing: true, whatsappTransactional: true, whatsappOptedOutAt: '2026-09-30T10:00:00.000Z' };
  assert.deepEqual(channelAllowed(stopped, 'whatsapp', 'transactional'), { allowed: false, reason: 'whatsapp_opted_out' });
  assert.deepEqual(channelAllowed(stopped, 'whatsapp', 'marketing'), { allowed: false, reason: 'whatsapp_opted_out' });
  assert.equal(channelAllowed(stopped, 'in_app', 'transactional').allowed, true);
  assert.equal(channelAllowed(stopped, 'push', 'marketing').allowed, true);
});

test('null columns fall back to defaults; unknown channels and categories are refused', () => {
  assert.equal(effectivePreferences({ inAppMarketing: null }).inAppMarketing, true);
  assert.equal(channelAllowed(null, 'sms', 'marketing').reason, 'unknown_channel');
  assert.equal(channelAllowed(null, 'in_app', 'urgent').reason, 'unknown_category');
});

// ── shared direct-member status ────────────────────────────────────────────

test('direct member status: expiring soon covers today through 7 days, then active', () => {
  assert.equal(EXPIRING_SOON_DAYS, 7);
  const st = (expiresAt) => directMembershipStatus({ accountStatus: 'active', sub: { status: 'active', expiresAt }, now: NOW });
  assert.equal(st(inDays(0.5)), 'expiring_soon');
  assert.equal(st(inDays(7)), 'expiring_soon');
  assert.equal(st(inDays(8)), 'active');
  assert.equal(st(inDays(-1)), 'expired');
});

test('direct member status: suspended wins; no subscription or no date is expired', () => {
  assert.equal(directMembershipStatus({ accountStatus: 'suspended', sub: { status: 'active', expiresAt: inDays(30) }, now: NOW }), 'suspended');
  assert.equal(directMembershipStatus({ accountStatus: 'active', sub: { status: 'suspended', expiresAt: inDays(30) }, now: NOW }), 'suspended');
  assert.equal(directMembershipStatus({ accountStatus: 'active', sub: null, now: NOW }), 'expired');
  assert.equal(directMembershipStatus({ accountStatus: 'active', sub: { status: 'active', expiresAt: null }, now: NOW }), 'expired');
});

test('daysLeft rounds partial days up and is negative once past', () => {
  assert.equal(daysLeft(inDays(2.1), NOW), 3);
  assert.equal(daysLeft(inDays(-2), NOW), -2);
  assert.equal(daysLeft(null, NOW), null);
});
