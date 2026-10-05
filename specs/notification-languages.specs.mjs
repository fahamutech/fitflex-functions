// Server-built notifications follow the reader's language: Swahili for a
// reader who chose it, English for everyone else, and English exactly as it
// was before the texts moved to shared/notification-texts.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../src/services/notification-service.mjs';
import {
  NOTIFICATION_TEXTS, notificationText, renderNotificationText, notificationLocale, formatSlots,
} from '../src/shared/notification-texts.mjs';
import { deliveredTo, NOT_SWAHILI } from './fixtures/notification-language.mjs';

// Parameters that exercise every branch of every builder.
const SAMPLES = {
  trainer_booking_requested: [{ memberName: 'Neema', count: 2, slots: '2026-10-05 09:00, 2026-10-06 09:00' }, { memberName: null, count: 1, slots: '2026-10-05 09:00' }],
  trainer_booking_confirmed_trainer: [{ memberName: 'Neema', count: 2, slots: 'S' }, { memberName: null, count: 1, slots: 'S' }],
  trainer_booking_confirmed_member: [{ trainerName: 'Asha', count: 2, slots: 'S' }, { trainerName: null, count: 1, slots: 'S' }],
  trainer_booking_cancelled_by_member: [{ memberName: 'Neema', slots: 'S' }, { memberName: null, slots: 'S' }],
  trainer_booking_cancelled_by_trainer: [{ trainerName: 'Asha', slots: 'S' }, { trainerName: null, slots: 'S' }],
  subscription_renewal: [{ tier: 'pro', daysLeft: 3 }, { tier: 'basic', daysLeft: 1 }, { tier: null, daysLeft: 0 }],
  trainer_pass_activated: [{ plan: 'weekly' }, { plan: 'daily' }, { plan: 'monthly' }, { plan: null }],
  subscription_activated: [{ tier: 'premium' }, { tier: null }],
  kyc_submitted: [{}], kyc_approved: [{}], kyc_reinstated: [{}], kyc_reopened: [{}],
  kyc_info_requested: [{ note: null }, { note: 'Send a clearer photo.' }],
  kyc_rejected: [{ note: null }, { note: 'The ID has expired.' }],
  kyc_suspended: [{ note: null }, { note: 'Insurance lapsed.' }],
  kyc_document_expiring: [
    ...['owner_id', 'trainer_id', 'representative_id', 'business_registration', 'tin_certificate', 'business_licence', 'certification', 'liability_insurance', 'representative_authority', 'something_new']
      .map(requirementKey => ({ requirementKey, daysLeft: 25, expiresOn: '2026-10-30' })),
    { requirementKey: 'certification', daysLeft: 1, expiresOn: '2026-10-06' },
    { requirementKey: 'certification', daysLeft: 0, expiresOn: '2026-10-05' },
    { requirementKey: 'certification', daysLeft: -2, expiresOn: '2026-10-03' },
  ],
  social_friends: [{ name: 'Juma' }, { name: null }],
  social_follow: [{ name: 'Juma' }, { name: null }],
  social_kudos: [{ name: 'Juma' }, { name: null }],
  social_comment: [{ name: 'Juma', preview: 'Nice run!' }, { name: null, preview: 'Safi' }],
  org_invitation: [{ orgName: 'Iron Paradise', orgType: 'gym', role: 'staff' }, { orgName: null, orgType: 'gym', role: 'trainer' }, { orgName: null, orgType: 'vendor', role: 'staff' }, { orgName: 'G', orgType: 'gym', role: 'member' }],
  trainer_enquiry: [{ memberName: 'Neema', preview: 'Morning slots?' }, { memberName: null, preview: 'Hi' }],
  trainer_interest: [{ memberName: 'Neema' }, { memberName: null }],
  trainer_enquiry_reply: [{ trainerName: 'Asha', preview: 'Yes' }, { trainerName: null, preview: 'Yes' }],
  trainer_enquiry_member_reply: [{ memberName: 'Neema', preview: 'Ok' }, { memberName: null, preview: 'Ok' }],
  trainer_client_request: [{ memberName: 'Amina' }, { memberName: null }],
  trainer_connected: [{ trainerName: 'Asha' }, { trainerName: null }],
  trainer_declined: [{ trainerName: 'Asha' }, { trainerName: null }],
  trainer_goal_assigned: [{ trainerName: 'Asha', goalTitle: 'Stretch' }, { trainerName: null, goalTitle: null }],
  trainer_workout_assigned: [{ trainerName: 'Asha', workoutName: 'Leg day', days: 3 }, { trainerName: null, workoutName: 'Leg day', days: 1 }],
  challenge_reward_earned: [{ challengeName: 'Hatua 10,000', label: '7-day pass' }],
  challenge_reward_issued: [{ label: '7-day pass', challengeName: 'Hatua 10,000', reference: 'P-1' }, { label: 'T-shirt', challengeName: null, reference: null }],
  challenge_reward_rejected: [{ label: 'T-shirt', challengeName: 'Hatua 10,000', note: 'Duplicate' }, { label: 'T-shirt', challengeName: null, note: 'Duplicate' }],
  refund_on_its_way: [{ amount: 'TZS 20,000' }], refund_requested: [{ amount: 'TZS 20,000' }], refund_approved: [{ amount: 'TZS 20,000' }],
  refund_rejected: [{ note: 'Used on 2 Oct.' }], refund_withdrawn: [{ note: 'No longer owed' }],
  refund_paid: [{ amount: 'TZS 20,000', reference: 'MPESA-1' }],
  trainer_payout_paid: [{ amount: 'TZS 34,000', sessionCount: 2, from: '2026-09-21', to: '2026-09-27', reference: 'MPESA-TR1' }, { amount: 'TZS 1', sessionCount: 1, from: 'a', to: 'b', reference: 'R' }],
  b2b_sponsor_visibility: [{ name: 'Acme' }],
  b2b_payment_confirmed: [{ amount: 'TZS 5,000', reference: 'REF1', receiptNumber: 'RCT-1' }],
  b2b_payment_not_found: [{ amount: 'TZS 5,000', reference: 'REF1', reason: 'Not on our statement' }],
  b2b_invoice_reminder: [
    { soon: true, invoiceNumber: 'INV-1', amount: 'TZS 9,000', dueDate: '2026-10-08', daysLate: -3 },
    { soon: false, invoiceNumber: 'INV-1', amount: 'TZS 9,000', dueDate: '2026-10-05', daysLate: 0 },
    { soon: false, invoiceNumber: 'INV-1', amount: 'TZS 9,000', dueDate: '2026-10-04', daysLate: 1 },
    { soon: false, invoiceNumber: 'INV-1', amount: 'TZS 9,000', dueDate: '2026-09-01', daysLate: 34 },
  ],
};

test('every notification text has English and Swahili, both filled in for every case', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(NOTIFICATION_TEXTS).sort(), 'a sample for every text');
  for (const [key, cases] of Object.entries(SAMPLES)) {
    for (const params of cases) {
      const en = renderNotificationText(key, params, 'en');
      const sw = renderNotificationText(key, params, 'sw');
      for (const [lang, t] of [['en', en], ['sw', sw]]) {
        assert.ok(t.title && t.body, `${key} ${lang}`);
        assert.doesNotMatch(`${t.title} ${t.body}`, /undefined|null|NaN|\[object/, `${key} ${lang}: ${t.title} / ${t.body}`);
      }
      assert.notEqual(sw.title, en.title, `${key}: Swahili title differs`);
      assert.doesNotMatch(`${sw.title} ${sw.body}`, NOT_SWAHILI, `${key}: ${sw.title} / ${sw.body}`);
    }
  }
});

test('English is word for word what the services wrote before', () => {
  const en = (key, params) => { const t = renderNotificationText(key, params, 'en'); return [t.title, t.body]; };
  const S = '2026-10-05 09:00, 2026-10-06 09:00';
  assert.equal(formatSlots([{ date: '2026-10-05', slot: '09:00' }, { date: '2026-10-06', slot: '09:00' }]), S);
  assert.deepEqual(en('trainer_booking_requested', { memberName: 'Neema', count: 2, slots: S }), ['New booking request', `Neema booked 2 session(s): ${S}. Awaiting payment confirmation.`]);
  assert.deepEqual(en('trainer_booking_confirmed_trainer', { memberName: null, count: 1, slots: S }), ['Booking paid and confirmed', `A member's 1 session(s) are confirmed: ${S}.`]);
  assert.deepEqual(en('trainer_booking_confirmed_member', { trainerName: null, count: 2, slots: S }), ['Trainer session confirmed', `Your 2 session(s) with your trainer are confirmed: ${S}.`]);
  assert.deepEqual(en('trainer_booking_cancelled_by_member', { memberName: 'Neema', slots: S }), ['Session cancelled', `Neema cancelled: ${S}. The slot is free again.`]);
  assert.deepEqual(en('trainer_booking_cancelled_by_trainer', { trainerName: null, slots: S }), ['Trainer session cancelled', `Your trainer cancelled your session: ${S}. Anything you paid for it will be refunded.`]);
  assert.deepEqual(en('subscription_renewal', { tier: 'pro', daysLeft: 3 }), ['Your Pro pass ends in 3 days', 'To keep training, renew it from the Passes screen. You can also choose a different tier.']);
  assert.equal(en('subscription_renewal', { tier: null, daysLeft: 0 })[0], 'Your membership pass ends today');
  assert.equal(en('subscription_renewal', { tier: 'basic', daysLeft: 1 })[0], 'Your Basic pass ends tomorrow');
  assert.deepEqual(en('trainer_pass_activated', { plan: 'weekly' }), ['Trainer pass active', 'Your weekly trainer pass is active. Show your check-in QR at reception to train your clients.']);
  assert.equal(en('trainer_pass_activated', { plan: 'yearly' })[1], 'Your trainer pass is active. Show your check-in QR at reception to train your clients.');
  assert.deepEqual(en('subscription_activated', { tier: 'premium' }), ['Payment confirmed', 'Your Premium pass is active. Show your QR code at the gym to check in.']);
  assert.equal(en('subscription_activated', { tier: null })[1], 'Your gym membership is active. Show your QR code at the gym to check in.');
  assert.deepEqual(en('kyc_submitted', {}), ['Verification details received', 'Thank you. FitFlex will review your details and let you know the outcome.']);
  assert.deepEqual(en('kyc_info_requested', { note: null }), ['More information needed', 'FitFlex needs more information to finish verifying you. Open your verification to see what to update.']);
  assert.deepEqual(en('kyc_approved', {}), ['You are verified', 'Your FitFlex partner verification is approved.']);
  assert.deepEqual(en('kyc_rejected', { note: null }), ['Verification not approved', 'Your FitFlex partner verification was not approved.']);
  assert.deepEqual(en('kyc_suspended', { note: null }), ['Verification suspended', 'Your FitFlex partner verification has been suspended.']);
  assert.deepEqual(en('kyc_reinstated', {}), ['Verification restored', 'Your FitFlex partner verification is active again.']);
  assert.deepEqual(en('kyc_reopened', {}), ['Verification reopened', 'You can update your details and submit them again.']);
  assert.deepEqual(en('kyc_document_expiring', { requirementKey: 'liability_insurance', daysLeft: 25, expiresOn: '2026-10-30' }), ['Your liability cover expires in 25 days', 'Your liability cover expires on 2026-10-30. Upload the renewed one in Verification.']);
  assert.equal(en('kyc_document_expiring', { requirementKey: 'owner_id', daysLeft: 1, expiresOn: 'D' })[0], 'Your ID expires in 1 day');
  assert.deepEqual(en('kyc_document_expiring', { requirementKey: 'unknown', daysLeft: 0, expiresOn: '2026-10-05' }), ['Your document has expired', 'Your document expired on 2026-10-05. Upload the renewed one in Verification.']);
  assert.deepEqual(en('social_friends', { name: 'Juma' }), ['You\'re friends', 'Juma followed you back.']);
  assert.deepEqual(en('social_follow', { name: null }), ['New follower', 'Someone started following you.']);
  assert.deepEqual(en('social_kudos', { name: 'Juma' }), ['Kudos', 'Juma gave you kudos.']);
  assert.deepEqual(en('social_comment', { name: 'Juma', preview: 'Nice run!' }), ['New comment', 'Juma: Nice run!']);
  assert.deepEqual(en('org_invitation', { orgName: null, orgType: 'vendor', role: 'staff' }), ['You have an invitation', 'A shop invited you to join as staff.']);
  assert.equal(en('org_invitation', { orgName: null, orgType: 'gym', role: 'trainer' })[1], 'A gym invited you to join as trainer.');
  assert.deepEqual(en('trainer_enquiry', { memberName: 'Neema', preview: 'Morning slots?' }), ['New enquiry from Neema', 'Morning slots?']);
  assert.deepEqual(en('trainer_interest', { memberName: null }), ['A member is interested in training with you', 'Say hello and tell them how you work.']);
  assert.deepEqual(en('trainer_enquiry_reply', { trainerName: null, preview: 'Yes' }), ['Your trainer replied', 'Yes']);
  assert.deepEqual(en('trainer_enquiry_member_reply', { memberName: null, preview: 'Ok' }), ['A member replied', 'Ok']);
  assert.deepEqual(en('trainer_client_request', { memberName: null }), ['New client request', 'A member would like to train with you.']);
  assert.deepEqual(en('trainer_connected', { trainerName: null }), ['Trainer connected', 'Your trainer accepted your request.']);
  assert.deepEqual(en('trainer_declined', { trainerName: null }), ['Trainer request', 'The trainer isn\'t taking new clients right now.']);
  assert.deepEqual(en('trainer_goal_assigned', { trainerName: 'Asha', goalTitle: 'Stretch' }), ['New goal from your trainer', 'Asha set you a goal: Stretch.']);
  assert.equal(en('trainer_goal_assigned', { trainerName: null, goalTitle: null })[1], 'Your trainer set you a goal.');
  assert.deepEqual(en('trainer_workout_assigned', { trainerName: 'Asha', workoutName: 'Leg day', days: 3 }), ['New workout from your trainer', 'Asha planned "Leg day" for you on 3 days.']);
  assert.equal(en('trainer_workout_assigned', { trainerName: null, workoutName: 'Leg day', days: 1 })[1], 'Your trainer planned "Leg day" for you.');
  assert.deepEqual(en('challenge_reward_earned', { challengeName: 'October Steps', label: '7-day pass' }), ['Reward earned', 'October Steps: 7-day pass. Pending fulfilment.']);
  assert.deepEqual(en('challenge_reward_issued', { label: '7-day pass', challengeName: 'October Steps', reference: 'P-1' }), ['Reward on its way', '7-day pass from October Steps has been handed out. Reference: P-1']);
  assert.equal(en('challenge_reward_issued', { label: 'T-shirt', challengeName: null, reference: null })[1], 'T-shirt from your challenge has been handed out.');
  assert.deepEqual(en('challenge_reward_rejected', { label: 'T-shirt', challengeName: null, note: 'Duplicate' }), ['Reward not approved', 'T-shirt from your challenge: Duplicate']);
  assert.deepEqual(en('refund_on_its_way', { amount: 'TZS 20,000' }), ['Refund on its way', 'Your refund of TZS 20,000 is approved. FitFlex will send it to the account you paid from.']);
  assert.deepEqual(en('refund_requested', { amount: 'TZS 20,000' }), ['Refund request received', 'We have your request for TZS 20,000 and will reply soon.']);
  assert.deepEqual(en('refund_approved', { amount: 'TZS 20,000' }), ['Refund approved', 'Your refund of TZS 20,000 is approved. FitFlex will send it to the account you paid from.']);
  assert.deepEqual(en('refund_rejected', { note: 'Why' }), ['Refund not approved', 'Why']);
  assert.deepEqual(en('refund_withdrawn', { note: 'No longer owed' }), ['Refund withdrawn', 'No longer owed']);
  assert.deepEqual(en('refund_paid', { amount: 'TZS 20,000', reference: 'MPESA-1' }), ['Refund sent', 'We sent TZS 20,000 back to you. Reference: MPESA-1.']);
  assert.deepEqual(en('trainer_payout_paid', { amount: 'TZS 34,000', sessionCount: 2, from: '2026-09-21', to: '2026-09-27', reference: 'MPESA-TR1' }), ['Payout sent', 'FitFlex sent you TZS 34,000 for 2 session(s), 2026-09-21 to 2026-09-27. Reference: MPESA-TR1.']);
  assert.deepEqual(en('b2b_sponsor_visibility', { name: 'Acme' }), ['What Acme can see', 'Acme gives you benefits through FitFlex and can see your FitFlex activity: gym visits, workouts, steps and challenge progress. It cannot see your weight, height or anything from another sponsor. See Benefits for details.']);
  assert.deepEqual(en('b2b_payment_confirmed', { amount: 'TZS 5,000', reference: 'REF1', receiptNumber: 'RCT-1' }), ['Payment received', 'FitFlex has confirmed your payment of TZS 5,000 (REF1). Receipt RCT-1.']);
  assert.deepEqual(en('b2b_payment_not_found', { amount: 'TZS 5,000', reference: 'REF1', reason: 'Not on our statement' }), ['Payment not confirmed', 'FitFlex could not confirm your payment of TZS 5,000 (REF1): Not on our statement']);
  const inv = { invoiceNumber: 'INV-1', amount: 'TZS 9,000' };
  assert.deepEqual(en('b2b_invoice_reminder', { ...inv, soon: true, dueDate: '2026-10-08', daysLate: -3 }), ['Invoice due soon', 'Invoice INV-1 (TZS 9,000) is due on 2026-10-08.']);
  assert.deepEqual(en('b2b_invoice_reminder', { ...inv, soon: false, dueDate: '2026-10-05', daysLate: 0 }), ['Invoice due today', 'Invoice INV-1 (TZS 9,000) is due today.']);
  assert.deepEqual(en('b2b_invoice_reminder', { ...inv, soon: false, dueDate: '2026-10-04', daysLate: 1 }), ['Invoice overdue', 'Invoice INV-1 (TZS 9,000) was due on 2026-10-04 and is 1 day overdue.']);
  assert.equal(en('b2b_invoice_reminder', { ...inv, soon: false, dueDate: '2026-09-01', daysLate: 34 })[1], 'Invoice INV-1 (TZS 9,000) was due on 2026-09-01 and is 34 days overdue.');
});

test('Swahili follows the glossary; people\'s own words pass through untouched', () => {
  const sw = (key, params) => { const t = renderNotificationText(key, params, 'sw'); return [t.title, t.body]; };
  assert.deepEqual(sw('trainer_booking_requested', { memberName: null, count: 2, slots: '2026-10-05 09:00, 2026-10-06 09:00' }),
    ['Ombi jipya la kipindi', 'Mwanachama ameweka vipindi 2: 2026-10-05 09:00, 2026-10-06 09:00. Vinasubiri uthibitisho wa malipo.']);
  assert.equal(sw('trainer_booking_requested', { memberName: 'Neema', count: 1, slots: 'S' })[1], 'Neema ameweka kipindi 1: S. Kinasubiri uthibitisho wa malipo.');
  assert.deepEqual(sw('trainer_booking_cancelled_by_trainer', { trainerName: null, slots: 'S' }), ['Kipindi na trainer kimeghairiwa', 'Trainer wako ameghairi kipindi chako: S. Kiasi ulicholipa kitarejeshwa.']);
  assert.deepEqual(sw('subscription_renewal', { tier: 'pro', daysLeft: 3 }), ['Pasi yako ya Pro inaisha baada ya siku 3', 'Ili uendelee na mazoezi, lipia tena kwenye ukurasa wa Pasi. Unaweza pia kuchagua daraja lingine.']);
  assert.equal(sw('subscription_renewal', { tier: null, daysLeft: 1 })[0], 'Pasi yako inaisha kesho');
  assert.equal(sw('trainer_pass_activated', { plan: 'weekly' })[1], 'Pasi yako ya trainer ya wiki inatumika. Onyesha QR yako ya kuingia mapokezi ili uwafundishe wateja wako.');
  assert.equal(sw('subscription_activated', { tier: null })[1], 'Uanachama wako wa gym uko hai. Onyesha msimbo wako wa QR gym ili kuingia.');
  assert.deepEqual(sw('kyc_suspended', { note: null }), ['Uthibitisho umesimamishwa', 'Uthibitisho wako wa mshirika wa FitFlex umesimamishwa.']);
  assert.deepEqual(sw('kyc_rejected', { note: 'The ID has expired.' }), ['Uthibitisho haujaidhinishwa', 'The ID has expired.'], 'the reviewer\'s note is not translated');
  assert.deepEqual(sw('kyc_document_expiring', { requirementKey: 'business_licence', daysLeft: 7, expiresOn: '2026-10-12' }),
    ['Leseni ya biashara: muda wake unaisha baada ya siku 7', 'Muda wa leseni ya biashara unaisha tarehe 2026-10-12. Pakia hati mpya kwenye Uthibitisho.']);
  assert.deepEqual(sw('social_comment', { name: null, preview: 'Nice run!' }), ['Maoni mapya', 'Mtu: Nice run!']);
  assert.equal(sw('org_invitation', { orgName: null, orgType: 'gym', role: 'staff' })[1], 'Gym imekualika kujiunga kama mfanyakazi.');
  assert.equal(sw('org_invitation', { orgName: 'Iron Paradise', orgType: 'gym', role: 'trainer' })[1], 'Iron Paradise imekualika kujiunga kama trainer.');
  assert.deepEqual(sw('trainer_enquiry', { memberName: 'Neema', preview: 'Morning slots?' }), ['Ulizo jipya kutoka kwa Neema', 'Morning slots?']);
  assert.deepEqual(sw('challenge_reward_issued', { label: 'T-shirt', challengeName: null, reference: 'P-1' }), ['Zawadi yako inakuja', 'T-shirt kutoka challenge yako imetolewa. Kumbukumbu: P-1']);
  assert.deepEqual(sw('refund_paid', { amount: 'TZS 20,000', reference: 'MPESA-1' }), ['Marejesho yametumwa', 'Tumekurejeshea TZS 20,000. Kumbukumbu: MPESA-1.']);
  assert.equal(sw('trainer_payout_paid', { amount: 'TZS 34,000', sessionCount: 2, from: '2026-09-21', to: '2026-09-27', reference: 'R1' })[1], 'FitFlex imekutumia TZS 34,000 kwa vipindi 2, 2026-09-21 hadi 2026-09-27. Kumbukumbu: R1.');
});

test('unknown locales are English; an unknown key has no text', () => {
  for (const l of [null, undefined, '', 'fr', 'SW', 42]) assert.equal(notificationLocale(l), 'en');
  assert.equal(notificationLocale('sw'), 'sw');
  assert.equal(renderNotificationText('social_follow', { name: 'Juma' }, 'fr').title, 'New follower');
  assert.equal(renderNotificationText('no_such_text', {}, 'sw'), null);
  assert.throws(() => notificationText('no_such_text'), /unknown notification text/);
  assert.deepEqual(notificationText('social_follow', { name: 'Juma' }), {
    text: { key: 'social_follow', params: { name: 'Juma' } }, title: 'New follower', body: 'Juma started following you.',
  });
});

test('notify: a Swahili reader gets Swahili in the inbox and the push; an unknown reader gets English', async () => {
  const message = { type: 'social_follow', data: { userId: 'u2' }, ...notificationText('social_follow', { name: 'Juma' }) };
  const sw = await deliveredTo(message, 'sw');
  assert.deepEqual([sw.title, sw.body], ['Mfuasi mpya', 'Juma ameanza kukufuata.']);
  assert.deepEqual(sw.push, { title: 'Mfuasi mpya', body: 'Juma ameanza kukufuata.' });
  assert.equal(sw.lookups, 1, 'one preference read per notification');
  for (const locale of [null, 'en', 'fr']) {
    const en = await deliveredTo(message, locale);
    assert.deepEqual([en.title, en.body, en.push.title, en.push.body], ['New follower', 'Juma started following you.', 'New follower', 'Juma started following you.'], String(locale));
  }
});

test('notify: plain title and body still work, with no language lookup; type and data are untouched', async () => {
  const plain = await deliveredTo({ type: 't', title: 'Hi', body: 'There' }, 'sw');
  assert.deepEqual([plain.title, plain.body, plain.lookups], ['Hi', 'There', 0]);
  // An unknown key falls back to the title and body sent with it.
  const unknown = await deliveredTo({ type: 't', title: 'Hi', body: 'There', text: { key: 'no_such_text', params: {} } }, 'sw');
  assert.deepEqual([unknown.title, unknown.body], ['Hi', 'There']);
  // A caller that already knows the language skips the lookup.
  const known = await deliveredTo({ type: 'social_kudos', locale: 'sw', ...notificationText('social_kudos', { name: 'Juma' }) }, null);
  assert.deepEqual([known.title, known.body, known.lookups], ['Pongezi', 'Juma amekupongeza.', 0]);
});

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
    async removeAsync(fn) { for (let i = rows.length - 1; i >= 0; i--) if (fn(rows[i])) rows.splice(i, 1); },
  };
}

function service({ preferences, users = [] } = {}) {
  const notifications = memStore();
  const svc = createNotificationService({
    users: memStore(users), deviceTokens: memStore(), notifications, preferences, logger: { warn: () => {} },
  });
  return { svc, notifications };
}

test('notify: without a preferences store, or when it cannot be read, the text is English and nothing fails', async () => {
  const message = { type: 'kyc_approved', ...notificationText('kyc_approved') };
  const none = service();
  assert.equal((await none.svc.notify('u1', message)).notification.title, 'You are verified');
  const broken = service({ preferences: { findByIdAsync: async () => { throw new Error('db down'); } } });
  const out = await broken.svc.notify('u1', message);
  assert.deepEqual([out.ok, out.notification.title], [true, 'You are verified']);
  assert.deepEqual(Object.keys(broken.notifications.rows[0]).sort(), ['body', 'campaignId', 'category', 'createdAt', 'data', 'gymId', 'id', 'readAt', 'title', 'type', 'userId'], 'the inbox row has the columns it always had');
  assert.deepEqual(broken.notifications.rows[0].data, { type: 'kyc_approved' });
});

test('booking, renewal and activation notices follow each reader\'s own language', async () => {
  const { svc, notifications } = service({
    preferences: memStore([{ id: 'usr_trn', locale: 'sw' }, { id: 'm_sw', locale: 'sw' }]),
    users: [{ id: 'm_en', displayName: 'Neema' }, { id: 'm_sw', displayName: 'Juma' }],
  });
  const trainer = { id: 'trn_1', userId: 'usr_trn', displayName: 'Coach Asha' };
  const bookings = [{ groupId: 'g1', date: '2026-10-05', slot: '09:00' }, { groupId: 'g1', date: '2026-10-06', slot: '09:00' }];
  const last = userId => notifications.rows.filter(n => n.userId === userId).at(-1);

  // The Swahili-reading trainer and the English-reading member hear of the same event, each in their language.
  await svc.notifyTrainerBooking('trainer_booking_confirmed', { trainer, memberId: 'm_en', bookings });
  assert.deepEqual([last('usr_trn').type, last('usr_trn').title, last('usr_trn').body],
    ['trainer_booking_confirmed', 'Kipindi kimelipiwa na kuthibitishwa', 'Vipindi 2 vya Neema vimethibitishwa: 2026-10-05 09:00, 2026-10-06 09:00.']);
  assert.deepEqual([last('m_en').title, last('m_en').body],
    ['Trainer session confirmed', 'Your 2 session(s) with Coach Asha are confirmed: 2026-10-05 09:00, 2026-10-06 09:00.']);
  assert.deepEqual(last('usr_trn').data, { bookingGroupId: 'g1', trainerId: 'trn_1', type: 'trainer_booking_confirmed' });

  await svc.notifyTrainerBooking('trainer_booking_requested', { trainer, memberId: 'm_en', bookings });
  assert.equal(last('usr_trn').title, 'Ombi jipya la kipindi');
  await svc.notifyTrainerBooking('trainer_booking_cancelled_by_member', { trainer, memberId: 'm_en', bookings: bookings.slice(0, 1) });
  assert.deepEqual([last('usr_trn').type, last('usr_trn').body], ['trainer_booking_cancelled', 'Neema ameghairi: 2026-10-05 09:00. Muda huo uko wazi tena.']);
  await svc.notifyTrainerBooking('trainer_booking_cancelled_by_trainer', { trainer, memberId: 'm_sw', bookings: bookings.slice(0, 1) });
  assert.deepEqual([last('m_sw').title, last('m_sw').body], ['Kipindi na trainer kimeghairiwa', 'Coach Asha ameghairi kipindi chako: 2026-10-05 09:00. Kiasi ulicholipa kitarejeshwa.']);

  const sub = { id: 's1', tier: 'pro', renewsAt: '2026-10-08T00:00:00.000Z' };
  await svc.notifyRenewal({ ...sub, memberId: 'm_sw' }, 3);
  assert.deepEqual([last('m_sw').id, last('m_sw').title], ['ntf_renew_s1_2026-10-08_3', 'Pasi yako ya Pro inaisha baada ya siku 3']);
  await svc.notifyRenewal({ ...sub, id: 's2', memberId: 'm_en' }, 3);
  assert.deepEqual([last('m_en').title, last('m_en').body], ['Your Pro pass ends in 3 days', 'To keep training, renew it from the Passes screen. You can also choose a different tier.']);

  await svc.notifySubscriptionActivated({ id: 's1', memberId: 'm_sw', tier: 'pro' });
  assert.deepEqual([last('m_sw').type, last('m_sw').title, last('m_sw').body], ['subscription_activated', 'Malipo yamethibitishwa', 'Pasi yako ya Pro inatumika. Onyesha msimbo wako wa QR gym ili kuingia.']);
  await svc.notifySubscriptionActivated({ id: 's3', memberId: 'm_en', tier: 'pro' });
  assert.equal(last('m_en').body, 'Your Pro pass is active. Show your QR code at the gym to check in.');
  await svc.notifySubscriptionActivated({ id: 's4', memberId: 'usr_trn', type: 'trainer_pass', plan: 'weekly', homeGymId: 'gym_1' });
  assert.deepEqual([last('usr_trn').type, last('usr_trn').title], ['trainer_pass_activated', 'Pasi ya trainer inatumika']);
  assert.deepEqual(last('usr_trn').data, { subscriptionId: 's4', gymId: 'gym_1', type: 'trainer_pass_activated' });
});
