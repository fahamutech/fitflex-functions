// Static/public pages — health probe, privacy policy, account-deletion instructions.
const created = new Date().toISOString();

export const health = {
  created, method: 'get', path: '/health',
  description: 'Liveness probe',
  responseSample: { status: 'ok' },
  onRequest: (_, res) => res.status(200).json({ status: 'ok', service: 'fitflex-functions', version: '1.0' }),
};

const privacyPolicyHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FitFlex Privacy Policy</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; line-height: 1.6; color: #111827; background: #ffffff; }
    main { max-width: 880px; margin: 0 auto; padding: 40px 20px 64px; }
    h1, h2 { line-height: 1.25; color: #111827; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    h2 { font-size: 22px; margin: 32px 0 8px; }
    p, li { font-size: 16px; }
    .muted { color: #4b5563; }
    .section-divider { margin-top: 48px; padding-top: 32px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <main>
    <h1>FitFlex Privacy Policy</h1>
    <p class="muted">Last updated: July 4, 2026</p>

    <p>FitFlex provides fitness membership, gym access, trainer booking, payment, and check-in services. This Privacy Policy explains how FitFlex collects, uses, shares, and protects information when you use the FitFlex mobile app, portals, websites, and related services.</p>

    <h2>Information We Collect</h2>
    <ul>
      <li>Account information, such as your name, phone number, email address, profile photo, role, and authentication identifiers.</li>
      <li>Membership and activity information, such as subscriptions, gym visits, QR check-ins, trainer bookings, credits, payment status, and support requests.</li>
      <li>Gym, operator, and trainer information, such as business profile details, location, services, availability, and approval or compliance information.</li>
      <li>Device and technical information, such as app version, device identifiers, IP address, logs, crash data, and security events.</li>
      <li>Location information when needed to show nearby gyms, verify gym access, or support location-based features, depending on your device permissions.</li>
    </ul>

    <h2>How We Use Information</h2>
    <ul>
      <li>To create and manage accounts, subscriptions, gym access, trainer bookings, check-ins, payments, and customer support.</li>
      <li>To verify identity, prevent fraud, enforce access rules, protect users and partner gyms, and maintain service security.</li>
      <li>To send service messages, receipts, account notices, renewal reminders, and important policy updates.</li>
      <li>To improve app performance, diagnose bugs, measure service usage, and develop better FitFlex features.</li>
      <li>To comply with legal, tax, accounting, safety, dispute resolution, and regulatory obligations.</li>
    </ul>

    <h2>Sharing Information</h2>
    <p>We do not sell personal information. We may share information with gyms, trainers, payment processors, authentication providers, hosting providers, analytics or crash reporting providers, support tools, professional advisers, regulators, or law enforcement when needed to operate FitFlex, process transactions, protect rights and safety, or comply with law. Gym operators receive only the information needed to provide access and manage memberships. QR scan flows are designed to use masked member identifiers where possible.</p>

    <h2>Payments</h2>
    <p>FitFlex may use third-party payment partners to process subscriptions, payouts, credits, refunds, and related financial transactions. Payment partners may collect and process payment details under their own terms and privacy notices. FitFlex stores transaction references, statuses, amounts, and related account records needed to operate the service.</p>

    <h2>Data Retention</h2>
    <p>We retain information for as long as needed to provide FitFlex services, comply with legal and accounting obligations, resolve disputes, prevent fraud, and maintain audit records. Retention periods may vary by data type and legal requirement.</p>

    <h2>Data Deletion</h2>
    <p>You may request account or personal data deletion by contacting us at privacy@fitflex.af. We may need to retain limited records when required for legal, accounting, fraud prevention, dispute resolution, or safety purposes. If deletion is not immediately possible, we will explain the reason and complete deletion or anonymization when retention is no longer required.</p>

    <h2>Security</h2>
    <p>We use administrative, technical, and organizational safeguards designed to protect personal information. No internet service is completely secure, so we cannot guarantee absolute security. You should keep your login credentials and devices secure.</p>

    <h2>Children</h2>
    <p>FitFlex is not intended for children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided personal information, contact us so we can take appropriate action.</p>

    <h2>Your Choices and Rights</h2>
    <p>You may update account details in the app where available, control device permissions through your device settings, opt out of non-essential communications where supported, and request access, correction, deletion, or other privacy rights by contacting us.</p>

    <h2>International Processing</h2>
    <p>FitFlex may process and store information in countries where we, our infrastructure providers, or service providers operate. We take steps designed to protect information consistent with this policy and applicable law.</p>

    <h2>Changes to This Policy</h2>
    <p>We may update this Privacy Policy from time to time. If changes are material, we will provide notice through the app, website, or other appropriate channels. The updated date above shows when the policy was last revised.</p>

    <h2>Contact</h2>
    <p>For privacy questions or requests, contact FitFlex at privacy@fitflex.af.</p>

    <section class="section-divider" lang="sw">
      <h1>Sera ya Faragha ya FitFlex</h1>
      <p class="muted">Ilisasishwa mwisho: Julai 4, 2026</p>
      <p>FitFlex hukusanya na kutumia taarifa zinazohitajika kutoa huduma za uanachama wa mazoezi, kuingia gym kwa QR, malipo, vipindi na ma-trainer, usaidizi kwa wateja, usalama, na uboreshaji wa huduma.</p>
      <p>Hatuiuzi taarifa binafsi. Tunaweza kushiriki taarifa zinazohitajika na gym, ma-trainer, watoa huduma za malipo, uthibitisho, hosting, usaidizi, au mamlaka pale inapohitajika kuendesha huduma, kulinda watumiaji, au kutimiza matakwa ya kisheria.</p>
      <p>Unaweza kuomba kusahihisha au kufuta taarifa zako kwa kutuandikia kupitia privacy@fitflex.af. Baadhi ya kumbukumbu zinaweza kuhifadhiwa kwa muda unaohitajika kwa sheria, uhasibu, usalama, kuzuia udanganyifu, au kutatua migogoro.</p>
    </section>
  </main>
</body>
</html>`;

export const privacyPolicy = {
  created, method: 'get', path: '/privacy-policy',
  description: 'Public: FitFlex privacy policy for Play Store listing and app users.',
  responseSample: '<!doctype html><html lang="en">...</html>',
  onRequest: (_req, res) => res
    .status(200)
    .type('text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=3600')
    .send(privacyPolicyHtml)
};

const deleteAccountHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delete Your FitFlex Account</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; line-height: 1.6; color: #111827; background: #ffffff; }
    main { max-width: 880px; margin: 0 auto; padding: 40px 20px 64px; }
    h1, h2 { line-height: 1.25; color: #111827; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    h2 { font-size: 22px; margin: 32px 0 8px; }
    p, li { font-size: 16px; }
    .muted { color: #4b5563; }
    .section-divider { margin-top: 48px; padding-top: 32px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <main>
    <h1>Delete Your FitFlex Account</h1>
    <p class="muted">Last updated: July 10, 2026</p>

    <p>This page explains how to request deletion of your FitFlex account and associated personal data, for members, gym owners, and trainers.</p>

    <h2>How to Request Deletion In the App</h2>
    <ol>
      <li>Open the FitFlex app and sign in.</li>
      <li>Go to the <strong>Profile</strong> tab.</li>
      <li>Under <strong>Account Settings</strong>, tap <strong>Help</strong> to contact FitFlex Support via WhatsApp.</li>
      <li>Send a message stating you want your FitFlex account deleted, including the phone number or email used on your account.</li>
      <li>Support will verify your identity and confirm once your account and data are deleted or scheduled for deletion.</li>
    </ol>

    <h2>Alternative: Request by Email</h2>
    <p>You can also request deletion without using the app by emailing <strong>privacy@fitflex.af</strong> from the address linked to your account, with the subject "Delete My Account".</p>

    <h2>What Gets Deleted</h2>
    <ul>
      <li>Your profile information, such as name, phone number, email address, and profile photo.</li>
      <li>Membership, subscription, and check-in history linked to your account.</li>
      <li>Trainer or gym operator profile details, where applicable.</li>
    </ul>

    <h2>What May Be Retained</h2>
    <p>We may retain limited records, such as payment/transaction history and support communications, where required for legal, accounting, fraud prevention, dispute resolution, or safety purposes. These records are retained only as long as necessary and are not used for any other purpose.</p>

    <h2>How Long It Takes</h2>
    <p>Account deletion requests are typically processed within 30 days. If deletion cannot happen immediately, we will explain why and complete deletion or anonymization once retention is no longer required.</p>

    <h2>Contact</h2>
    <p>For questions about account or data deletion, contact FitFlex at privacy@fitflex.af.</p>

    <section class="section-divider" lang="sw">
      <h1>Futa Akaunti Yako ya FitFlex</h1>
      <p class="muted">Ilisasishwa mwisho: Julai 10, 2026</p>
      <p>Ukurasa huu unaelezea jinsi ya kuomba kufutwa kwa akaunti yako ya FitFlex na taarifa zako binafsi, kwa wanachama, wamiliki wa gym, na ma-trainer.</p>

      <h2>Jinsi ya Kuomba Ndani ya App</h2>
      <ol>
        <li>Fungua app ya FitFlex na uingie.</li>
        <li>Fungua kichupo cha <strong>Wasifu</strong>.</li>
        <li>Chini ya <strong>Mipangilio ya akaunti</strong>, gusa <strong>Msaada</strong> kuwasiliana na Usaidizi wa FitFlex kupitia WhatsApp.</li>
        <li>Tuma ujumbe ukieleza unataka akaunti yako ya FitFlex ifutwe, ukijumuisha namba ya simu au barua pepe iliyotumika kwenye akaunti.</li>
        <li>Timu ya usaidizi itathibitisha utambulisho wako na kukujulisha baada ya akaunti na taarifa zako kufutwa.</li>
      </ol>

      <h2>Njia Nyingine: Ombi kwa Barua Pepe</h2>
      <p>Unaweza pia kuomba kufutwa bila kutumia app kwa kutuma barua pepe kwa <strong>privacy@fitflex.af</strong> kutoka anwani iliyounganishwa na akaunti yako, ukiandika "Delete My Account" kwenye kichwa cha ujumbe.</p>

      <h2>Taarifa Zinazofutwa</h2>
      <p>Taarifa za wasifu wako, historia ya uanachama na malipo, na taarifa za ma-trainer au wamiliki wa gym zinazohusiana na akaunti yako.</p>

      <h2>Taarifa Zinazoweza Kuhifadhiwa</h2>
      <p>Tunaweza kuhifadhi kumbukumbu chache, kama historia ya malipo na mawasiliano ya usaidizi, pale inapohitajika kisheria, kwa uhasibu, kuzuia udanganyifu, au kutatua migogoro, kwa muda unaohitajika tu.</p>

      <p>Ombi za kufuta akaunti kwa kawaida zinashughulikiwa ndani ya siku 30. Kwa maswali, wasiliana na FitFlex kupitia privacy@fitflex.af.</p>
    </section>
  </main>
</body>
</html>`;

export const deleteAccount = {
  created, method: 'get', path: '/delete-account',
  description: 'Public: FitFlex account deletion instructions for Play Store listing and app users.',
  responseSample: '<!doctype html><html lang="en">...</html>',
  onRequest: (_req, res) => res
    .status(200)
    .type('text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=3600')
    .send(deleteAccountHtml)
};
