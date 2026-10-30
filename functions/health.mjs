// Static/public pages — health probe, privacy policy, account-deletion instructions, support.
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
    <p class="muted">Last updated: October 30, 2026</p>

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

    <h2>Employers, Insurers and Other Sponsors</h2>
    <p>An employer, insurer, club or other organisation (a "sponsor") may give you benefits through FitFlex. While you are on a sponsor's list, that sponsor can see your FitFlex activity: your name and status on its list, the benefits you hold and how much of them you have used, your gym check-ins and trainer sessions with the date and place, the workouts and activities you record (type, date, duration, distance, steps and active minutes), and your progress in challenges and groups the sponsor runs. A sponsor cannot see your weight, height, calories, notes, recorded routes, payment details, or any benefit, challenge or group that another sponsor gives you. FitFlex tells you in the app when a sponsor adds you, and the Benefits screen lists what your sponsor can see. If you do not want a sponsor to see this information, ask the sponsor to remove you from its list or write to privacy@fitflex.af; you will stop receiving that sponsor's benefits.</p>

    <h2>Payments</h2>
    <p>FitFlex may use third-party payment partners to process subscriptions, payouts, credits, refunds, and related financial transactions. Payment partners may collect and process payment details under their own terms and privacy notices. FitFlex stores transaction references, statuses, amounts, and related account records needed to operate the service.</p>

    <h2>Data Retention</h2>
    <p>We retain information for as long as needed to provide FitFlex services, comply with legal and accounting obligations, resolve disputes, prevent fraud, and maintain audit records. Retention periods may vary by data type and legal requirement.</p>

    <h2>Data Deletion</h2>
    <p>You can delete your account yourself in the app (Profile, then Delete account), or ask us on WhatsApp at <a href="https://wa.me/255786670499">+255 786 670 499</a>. Your personal data is then removed. Payment, invoice, subscription, check-in, booking and order records are kept in anonymised form, without your name or contact details, because the money and visit totals of gyms, trainers and vendors depend on them. We may need to retain limited other records when required for legal, accounting, fraud prevention, dispute resolution, or safety purposes. If deletion is not immediately possible, we will explain the reason and complete deletion or anonymization when retention is no longer required. The full details are on our <a href="/delete-account">account deletion page</a>.</p>

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
      <p class="muted">Ilisasishwa mwisho: Oktoba 30, 2026</p>
      <p>FitFlex hukusanya na kutumia taarifa zinazohitajika kutoa huduma za uanachama wa mazoezi, kuingia gym kwa QR, malipo, vipindi na ma-trainer, usaidizi kwa wateja, usalama, na uboreshaji wa huduma.</p>
      <p>Hatuiuzi taarifa binafsi. Tunaweza kushiriki taarifa zinazohitajika na gym, ma-trainer, watoa huduma za malipo, uthibitisho, hosting, usaidizi, au mamlaka pale inapohitajika kuendesha huduma, kulinda watumiaji, au kutimiza matakwa ya kisheria.</p>
      <p>Mwajiri, kampuni ya bima, klabu au taasisi nyingine ("mdhamini") inaweza kukupa benefits kupitia FitFlex. Ukiwa kwenye orodha ya mdhamini, mdhamini huyo anaweza kuona shughuli zako za FitFlex: jina na hali yako kwenye orodha yake, benefits ulizonazo na kiasi ulichotumia, kuingia kwako gym na vipindi vya ma-trainer pamoja na tarehe na mahali, mazoezi na shughuli unazorekodi, na maendeleo yako kwenye challenge na vikundi vya mdhamini. Mdhamini hawezi kuona uzito wako, urefu wako, kalori, maelezo, njia ulizorekodi, taarifa za malipo, wala benefits, challenge au kikundi cha mdhamini mwingine. Usipotaka mdhamini aone taarifa hizi, mwombe akuondoe kwenye orodha yake au tuandikie kupitia privacy@fitflex.af; utaacha kupata benefits za mdhamini huyo.</p>
      <!-- Swahili: needs native review. Legal text: draft pending Tanzanian counsel. -->
      <p>Unaweza kufuta akaunti yako mwenyewe ndani ya app (Wasifu, kisha Futa akaunti), au utuombe kupitia WhatsApp <a href="https://wa.me/255786670499">+255 786 670 499</a>. Taarifa zako binafsi huondolewa. Kumbukumbu za malipo, ankara, usajili, kuingia gym, booking na oda huhifadhiwa bila jina wala mawasiliano yako, kwa sababu jumla za fedha na ziara za gym, ma-trainer na wauzaji zinategemea kumbukumbu hizo. Baadhi ya kumbukumbu nyingine zinaweza kuhifadhiwa kwa muda unaohitajika kwa sheria, uhasibu, usalama, kuzuia udanganyifu, au kutatua migogoro. Maelezo kamili yapo kwenye <a href="/delete-account">ukurasa wa kufuta akaunti</a>. Kusahihisha taarifa zako, tuandikie kupitia WhatsApp hiyo hiyo.</p>
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
    <p class="muted">Last updated: October 30, 2026</p>
    <!-- Legal text: draft pending Tanzanian counsel. Swahili below: needs native review. -->

    <p>This page explains how to delete your FitFlex account, for members, trainers, gym owners and vendors, what is deleted, and what is kept in anonymised form.</p>

    <h2>Delete Your Account in the App</h2>
    <ol>
      <li>Open the FitFlex app and sign in.</li>
      <li>Go to <strong>Profile</strong> (vendors: the <strong>Business</strong> tab; partners waiting for approval: the waiting screen).</li>
      <li>Tap <strong>Delete account</strong>.</li>
      <li>Read what will happen, then type <strong>DELETE</strong> (or <strong>FUTA</strong> in Swahili) to confirm.</li>
    </ol>
    <p>Deletion happens straight away and cannot be undone. If you use one sign-in for more than one role, for example member and trainer, only the role you are in is deleted; the others keep working, and your shared sign-in stays until the last one is gone.</p>

    <h2>Without the App</h2>
    <p>Message us on WhatsApp at <a href="https://wa.me/255786670499"><strong>+255 786 670 499</strong></a> from the number on your account, or give us the number or email on your account, and say you want it deleted. We will confirm it is you first.</p>

    <h2>What Gets Deleted</h2>
    <ul>
      <li>Your profile: name, phone number, email address, photo, date of birth, gender, username and preferences.</li>
      <li>Your sign-in: login, PIN, verification codes and recovery requests.</li>
      <li>Push notification tokens on your devices, your notifications and the messages sent to you.</li>
      <li>Your activity: workouts, runs and recorded GPS routes, goals, training plans, and challenge entries.</li>
      <li>Your social data: friends, followers, invitations, groups, comments and likes.</li>
      <li>Your conversations with trainers and vendors.</li>
      <li>The words of your reviews. The star rating stays, with no name or photo, so that gym, trainer and product ratings stay correct.</li>
      <li>Trainer, gym owner and vendor profile details, photos and logos, where they apply. A vendor's products leave the shop.</li>
    </ul>

    <h2>What Is Kept, in Anonymised Form</h2>
    <p>These records stay, without your name, phone number, email, address, photo or notes:</p>
    <ul>
      <li>Payments, refunds and invoices.</li>
      <li>Memberships and passes.</li>
      <li>Gym check-ins.</li>
      <li>Trainer bookings and sessions.</li>
      <li>Shop orders.</li>
      <li>Event orders and registrations.</li>
    </ul>
    <p>We keep them because gyms, trainers and vendors are paid from them, and because accounting, tax and dispute rules need them. Removing them would change amounts already owed or paid. They show as "Deleted member" and can no longer be linked to you through your account.</p>

    <h2>What May Be Kept Unchanged</h2>
    <p>A tax invoice or similar document that has already been issued may have to stay as issued, with the details it was issued with, for as long as tax law requires. Identity and business documents that partners uploaded for verification are kept or deleted according to our legal obligations. We keep these only as long as the law requires, and do not use them for anything else.</p>

    <h2>When We Cannot Delete Straight Away</h2>
    <p>Some accounts need a handover first, and the app will tell you: a gym owner whose gym has check-ins, a trainer with bookings, and the owner of an event organizer. Contact us on <a href="https://wa.me/255786670499">WhatsApp</a> and we will help you transfer or close them.</p>

    <h2>Contact</h2>
    <p>For questions about account or data deletion, contact FitFlex on WhatsApp at <a href="https://wa.me/255786670499">+255 786 670 499</a>.</p>

    <section class="section-divider" lang="sw">
      <h1>Futa Akaunti Yako ya FitFlex</h1>
      <p class="muted">Ilisasishwa mwisho: Oktoba 30, 2026</p>
      <p>Ukurasa huu unaelezea jinsi ya kufuta akaunti yako ya FitFlex, kwa wanachama, ma-trainer, wamiliki wa gym na wauzaji, nini kinafutwa, na nini kinahifadhiwa bila kukutambulisha.</p>

      <h2>Futa Akaunti Yako Ndani ya App</h2>
      <ol>
        <li>Fungua app ya FitFlex na uingie.</li>
        <li>Nenda kwenye <strong>Wasifu</strong> (wauzaji: kichupo cha <strong>Biashara</strong>; washirika wanaosubiri kuidhinishwa: ukurasa wa kusubiri).</li>
        <li>Gusa <strong>Futa akaunti</strong>.</li>
        <li>Soma kitakachotokea, kisha andika <strong>FUTA</strong> (au <strong>DELETE</strong> kwa Kiingereza) kuthibitisha.</li>
      </ol>
      <p>Akaunti hufutwa papo hapo na haiwezi kurudishwa. Ukitumia njia moja ya kuingia kwa majukumu zaidi ya moja, kwa mfano mwanachama na trainer, jukumu ulilopo ndilo pekee linalofutwa; mengine yanaendelea kufanya kazi, na njia yako ya kuingia inabaki hadi jukumu la mwisho liondoke.</p>

      <h2>Bila Kutumia App</h2>
      <p>Tutumie ujumbe WhatsApp <a href="https://wa.me/255786670499"><strong>+255 786 670 499</strong></a> kutoka namba iliyo kwenye akaunti yako, au tupe namba au barua pepe iliyo kwenye akaunti yako, na useme unataka ifutwe. Tutathibitisha kwanza kuwa ni wewe.</p>

      <h2>Taarifa Zinazofutwa</h2>
      <ul>
        <li>Wasifu wako: jina, namba ya simu, barua pepe, picha, tarehe ya kuzaliwa, jinsia, jina la mtumiaji na mapendeleo.</li>
        <li>Njia yako ya kuingia: akaunti ya kuingia, PIN, misimbo ya uthibitisho na maombi ya kurejesha akaunti.</li>
        <li>Tokeni za arifa kwenye vifaa vyako, arifa zako na ujumbe uliotumiwa.</li>
        <li>Shughuli zako: mazoezi, mbio na njia za GPS ulizorekodi, malengo, mipango ya mazoezi na ushiriki kwenye challenge.</li>
        <li>Taarifa zako za kijamii: marafiki, wafuasi, mialiko, vikundi, maoni na kupenda.</li>
        <li>Mazungumzo yako na ma-trainer na wauzaji.</li>
        <li>Maneno ya maoni yako ya tathmini. Nyota zinabaki, bila jina wala picha, ili ukadiriaji wa gym, ma-trainer na bidhaa ubaki sahihi.</li>
        <li>Taarifa za wasifu wa trainer, mmiliki wa gym au muuzaji, picha na nembo, pale zinapohusika. Bidhaa za muuzaji zinaondolewa dukani.</li>
      </ul>

      <h2>Kinachohifadhiwa Bila Kukutambulisha</h2>
      <p>Kumbukumbu hizi zinabaki, bila jina, namba ya simu, barua pepe, anwani, picha wala maelezo yako:</p>
      <ul>
        <li>Malipo, marejesho ya fedha na ankara.</li>
        <li>Uanachama na pasi.</li>
        <li>Kuingia gym.</li>
        <li>Booking na vipindi vya ma-trainer.</li>
        <li>Oda za duka.</li>
        <li>Oda na usajili wa matukio.</li>
      </ul>
      <p>Tunazihifadhi kwa sababu gym, ma-trainer na wauzaji hulipwa kutokana nazo, na kwa sababu sheria za uhasibu, kodi na utatuzi wa migogoro zinazihitaji. Kuziondoa kungebadilisha kiasi kilichokwisha kudaiwa au kulipwa. Zinaonekana kama "Mwanachama aliyefutwa" na haziwezi tena kuunganishwa nawe kupitia akaunti yako.</p>

      <h2>Kinachoweza Kubaki Bila Kubadilishwa</h2>
      <p>Ankara ya kodi au hati kama hiyo iliyokwisha kutolewa inaweza kulazimika kubaki kama ilivyotolewa, na taarifa zake, kwa muda unaotakiwa na sheria ya kodi. Nyaraka za utambulisho na biashara ambazo washirika walipakia kwa uthibitisho zinahifadhiwa au kufutwa kulingana na wajibu wetu wa kisheria. Tunazihifadhi kwa muda unaotakiwa na sheria tu, na hatuzitumii kwa jambo jingine.</p>

      <h2>Pale Tusipoweza Kufuta Papo Hapo</h2>
      <p>Baadhi ya akaunti zinahitaji makabidhiano kwanza, na app itakuambia: mmiliki wa gym ambayo ina watu waliowahi kuingia, trainer mwenye booking, na mmiliki wa akaunti ya mwandaaji wa matukio. Wasiliana nasi kupitia <a href="https://wa.me/255786670499">WhatsApp</a> tukusaidie kuzihamisha au kuzifunga.</p>

      <h2>Mawasiliano</h2>
      <p>Kwa maswali kuhusu kufuta akaunti au taarifa, wasiliana na FitFlex kupitia WhatsApp <a href="https://wa.me/255786670499">+255 786 670 499</a>.</p>
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

const SUPPORT_WHATSAPP_URL = 'https://wa.me/255786670499';

const supportHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FitFlex Support</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; line-height: 1.6; color: #111827; background: #ffffff; }
    main { max-width: 880px; margin: 0 auto; padding: 40px 20px 64px; }
    h1, h2 { line-height: 1.25; color: #111827; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    h2 { font-size: 22px; margin: 32px 0 8px; }
    p, li { font-size: 16px; }
    .section-divider { margin-top: 48px; padding-top: 32px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <main>
    <h1>FitFlex Support</h1>
    <p>Need help with your pass, a payment, a gym check-in, a trainer booking, a shop order or your account? Message the FitFlex team and we will help you.</p>

    <h2>Contact us</h2>
    <p>WhatsApp: <a href="${SUPPORT_WHATSAPP_URL}">+255 786 670 499</a></p>
    <p>In the app, open the Profile tab and tap Help.</p>

    <h2>When you message us</h2>
    <ul>
      <li>Tell us the phone number or email on your FitFlex account.</li>
      <li>Say what happened, and for a payment include the date and amount.</li>
    </ul>

    <h2>More information</h2>
    <ul>
      <li><a href="/privacy-policy">Privacy Policy</a></li>
      <li><a href="/delete-account">Delete your account</a></li>
    </ul>

    <section class="section-divider" lang="sw">
      <h1>Msaada wa FitFlex</h1>
      <p>Unahitaji msaada kuhusu pasi yako, malipo, kuingia gym, kuweka miadi na trainer, oda ya duka au akaunti yako? Tuma ujumbe kwa timu ya FitFlex nasi tutakusaidia.</p>

      <h2>Wasiliana nasi</h2>
      <p>WhatsApp: <a href="${SUPPORT_WHATSAPP_URL}">+255 786 670 499</a></p>
      <p>Ndani ya app, fungua kichupo cha Wasifu kisha gusa Msaada.</p>

      <h2>Unapotutumia ujumbe</h2>
      <ul>
        <li>Tuambie namba ya simu au barua pepe iliyo kwenye akaunti yako ya FitFlex.</li>
        <li>Eleza kilichotokea, na kwa malipo weka tarehe na kiasi.</li>
      </ul>

      <h2>Maelezo zaidi</h2>
      <ul>
        <li><a href="/privacy-policy">Sera ya Faragha</a></li>
        <li><a href="/delete-account">Futa akaunti yako</a></li>
      </ul>
    </section>
  </main>
</body>
</html>`;

export const support = {
  created, method: 'get', path: '/support',
  description: 'Public: FitFlex support contact page for the App Store listing and app users.',
  responseSample: '<!doctype html><html lang="en">...</html>',
  onRequest: (_req, res) => res
    .status(200)
    .type('text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=3600')
    .send(supportHtml)
};
