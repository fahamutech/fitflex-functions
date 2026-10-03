// Partner KYC service — captures what each partner type must provide (see
// shared/partner-kyc-requirements.mjs) and reports the checklist.
//
// Partners (gym owners, trainers, vendors) fill in their own case. Admins can
// fill any case on a partner's behalf, which is how corporate KYB is done:
// companies are onboarded by FitFlex, not self-registered. Data that already
// lives elsewhere is edited where it lives (gym profile and rates via the
// gym endpoints, trainer specialties via /trainer/me, vendor marketplace
// details via /vendor/profile, corporate commercial terms via
// /admin/corporate/:id) and is only read here.
//
// A partner submits once the checklist says they're ready. A FitFlex reviewer
// claims the case, reviews documents and payout accounts, and decides. The
// decision drives the approval flag the apps already read (User.approvalStatus,
// and TrainerProfile.approvalStatus for trainers).
//
// Document files live in private storage (Zebra). Their storage keys never
// leave this service: responses say only whether a document has its file,
// and the file itself is streamed by the API after its own access checks.
import { randomUUID } from 'node:crypto';
import {
  PARTNER_SUBJECT, partnerTypeForUserType, normalizeIdentifier,
  ENTITY_TYPES, ID_TYPES, RELATIONSHIPS, AUTHORITIES,
  SETTLEMENT_METHODS, MOBILE_MONEY_PROVIDERS, SETTLEMENT_COOLDOWN_HOURS,
  REVIEW_DECISIONS, REASON_CODES, reasonRequired, canTransitionCase, startsNewRound,
  approvalStatusForCase, canTransitionSettlement,
} from '../shared/partner-kyc.mjs';
import {
  evaluateKyc, KYC_TIERS, PERSON_REQUIREMENTS, BUSINESS_REQUIREMENTS,
  DOCUMENTS_FOR, DOCUMENT_REQUIREMENTS, SETTLEMENT_REQUIRED, currentDocument,
} from '../shared/partner-kyc-requirements.mjs';
import { GYM_TIERS } from '../shared/constants.mjs';
import { requiredAgreements, agreementText } from '../shared/partner-agreements.mjs';
import { prepareDocumentFile, displayFileName, sha256 } from '../infra/document-file.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 300;

// Partners may edit while drafting or answering a request for information;
// admins may also correct a case that is waiting for or in review.
const PARTNER_EDITABLE = new Set(['draft', 'info_requested']);
const ADMIN_EDITABLE = new Set(['draft', 'info_requested', 'submitted', 'in_review']);
// Once verified, a partner can still renew a document (a licence about to
// expire or already expired) without reopening the case; a reviewer then
// accepts or rejects the new document on its own (owner decision, 28 Sep).
const RENEWABLE = new Set(['approved', 'suspended']);

const REQUIREMENT_NAMES = {
  owner_id: 'ID', trainer_id: 'ID', representative_id: 'representative ID',
  business_registration: 'business registration certificate', tin_certificate: 'TIN certificate',
  business_licence: 'business licence', certification: 'certification', liability_insurance: 'liability cover',
  representative_authority: 'proof of authority',
};

// Expiry reminders go out this many days before a document expires, and on the day.
export const EXPIRY_REMINDER_DAYS = [30, 7, 0];

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'country', 'postalCode'];
const BUSINESS_FIELDS = ['legalName', 'tradingName', 'entityType', 'registrationNumber', 'registrationAuthority',
  'incorporatedOn', 'registeredAddress', 'businessActivity', 'tin'];
const PERSON_FIELDS = ['fullName', 'dateOfBirth', 'nationality', 'idType', 'idNumber', 'idExpiresOn',
  'phone', 'email', 'address', 'position', 'relationship', 'authority'];

const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const nowIso = () => new Date().toISOString();

/** Validate and clean a patch. Returns { patch } or { error }. null clears a field. */
function cleanFields(body, allowed, rules) {
  const patch = {};
  for (const key of allowed) {
    if (!(key in body)) continue;
    let value = body[key];
    if (value === null || value === '') { patch[key] = null; continue; }
    const rule = rules[key] || 'text';
    if (rule === 'text') {
      if (typeof value !== 'string' || value.trim().length > MAX_TEXT) return { error: `invalid_${key}` };
      value = value.trim();
    } else if (rule === 'identifier') {
      value = normalizeIdentifier(value);
      if (!value || value.length > 64) return { error: `invalid_${key}` };
    } else if (rule === 'day') {
      if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(value))) return { error: `invalid_${key}` };
    } else if (rule === 'email') {
      if (typeof value !== 'string' || !EMAIL.test(value.trim())) return { error: `invalid_${key}` };
      value = value.trim().toLowerCase();
    } else if (rule === 'country') {
      if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) return { error: `invalid_${key}` };
      value = value.trim().toUpperCase();
    } else if (rule === 'address') {
      if (typeof value !== 'object' || Array.isArray(value)) return { error: `invalid_${key}` };
      const address = {};
      for (const f of ADDRESS_FIELDS) {
        if (value[f] === undefined || value[f] === null || value[f] === '') continue;
        if (typeof value[f] !== 'string' || value[f].length > MAX_TEXT) return { error: `invalid_${key}` };
        address[f] = value[f].trim();
      }
      value = address;
    } else if (Array.isArray(rule)) {
      if (!rule.includes(value)) return { error: `invalid_${key}`, allowed: rule };
    }
    patch[key] = value;
  }
  return { patch };
}

const BUSINESS_RULES = {
  entityType: ENTITY_TYPES, registrationNumber: 'identifier', tin: 'identifier',
  incorporatedOn: 'day', registeredAddress: 'address',
};
const PERSON_RULES = {
  dateOfBirth: 'day', idExpiresOn: 'day', nationality: 'country', idType: ID_TYPES, idNumber: 'identifier',
  email: 'email', address: 'address', relationship: RELATIONSHIPS, authority: AUTHORITIES,
};
const DOCUMENT_RULES = { documentNumber: 'identifier', issuedOn: 'day', expiresOn: 'day' };

export function createPartnerKycService({
  users, gyms, trainers, corporateAccounts,
  partnerKycCases, partnerPeople, partnerDocuments, partnerChecks,
  partnerSettlementAccounts, partnerAgreements, partnerKycEvents, auditLog,
  notify = async () => {},
  documentStore = null,     // { provider, put(buffer, name, mimeType) → { provider, key }, get(key) → Buffer }
}) {
  // ── Partners and cases ────────────────────────────────────────────────────

  /** The partner behind a signed-in user, or an error if they aren't one. */
  async function partnerForUser(userId) {
    const user = await users.findByIdAsync(userId);
    if (!user) return fail('user_not_found', 404);
    const partnerType = partnerTypeForUserType(user.userType);
    if (!partnerType) return fail('not_a_partner', 403);
    return { partnerType, subjectId: user.id, user };
  }

  /** Resolve a partner from an admin URL (/partners/:partnerType/:subjectId). */
  async function resolvePartner(partnerType, subjectId) {
    const subject = PARTNER_SUBJECT[partnerType];
    if (!subject) return fail('invalid_partner_type', 400);
    if (subject.table === 'CorporateAccount') {
      const corporate = await corporateAccounts.findByIdAsync(subjectId);
      return corporate ? { partnerType, subjectId, corporate } : fail('partner_not_found', 404);
    }
    const user = await users.findByIdAsync(subjectId);
    if (!user || user.userType !== subject.userType) return fail('partner_not_found', 404);
    return { partnerType, subjectId, user };
  }

  async function findCase({ partnerType, subjectId }) {
    const column = partnerType === 'corporate' ? 'corporateId' : 'userId';
    const rows = await partnerKycCases.filterByColumnAsync(column, subjectId);
    return rows.find(c => c.partnerType === partnerType) || null;
  }

  async function record(kycCase, event, actor) {
    await partnerKycEvents.insertAsync({
      id: `pevt_${randomUUID().slice(0, 12)}`, caseId: kycCase.id, round: kycCase.round || 1,
      actorId: actor.id || null, actorRole: actor.role, data: {}, at: nowIso(), ...event,
    });
    await auditLog.insertAsync({
      id: `aud_${randomUUID().slice(0, 8)}`, at: nowIso(), actor: actor.id || 'system',
      action: `kyc.${event.eventType}`, target: kycCase.id, before: null,
      after: { partnerType: kycCase.partnerType, targetType: event.targetType || null, targetId: event.targetId || null, ...(event.data || {}) },
    });
  }

  async function ensureCase(partner, actor) {
    const existing = await findCase(partner);
    if (existing) return existing;
    const row = {
      id: `kyc_${randomUUID().slice(0, 12)}`, partnerType: partner.partnerType,
      userId: partner.partnerType === 'corporate' ? null : partner.subjectId,
      corporateId: partner.partnerType === 'corporate' ? partner.subjectId : null,
      status: 'draft', tier: KYC_TIERS[partner.partnerType], round: 1, createdAt: nowIso(), updatedAt: nowIso(),
    };
    try {
      await partnerKycCases.insertAsync(row);
    } catch (err) {
      // Two first edits at once: the unique index keeps one case per partner.
      if (err.code === '23505') return findCase(partner);
      throw err;
    }
    const created = await partnerKycCases.findByIdAsync(row.id);
    await record(created, { eventType: 'status_changed', fromStatus: null, toStatus: 'draft' }, actor);
    return created;
  }

  function editable(kycCase, actor) {
    const allowed = actor.role === 'admin' ? ADMIN_EDITABLE : PARTNER_EDITABLE;
    return !kycCase || allowed.has(kycCase.status);
  }

  /** Documents can also be renewed on a verified case. */
  const documentEditable = (kycCase, actor) => editable(kycCase, actor) || RENEWABLE.has(kycCase?.status);

  async function caseRows(kycCase) {
    if (!kycCase) return { people: [], documents: [], checks: [], settlementAccounts: [], agreements: [] };
    const [people, documents, checks, settlementAccounts, agreements] = await Promise.all([
      partnerPeople.filterByColumnAsync('caseId', kycCase.id),
      partnerDocuments.filterByColumnAsync('caseId', kycCase.id),
      partnerChecks.filterByColumnAsync('caseId', kycCase.id),
      partnerSettlementAccounts.filterByColumnAsync('caseId', kycCase.id),
      partnerAgreements.filterByColumnAsync('caseId', kycCase.id),
    ]);
    return { people, documents, checks, settlementAccounts, agreements };
  }

  /** Existing records the requirements read: gyms, trainer profile, vendor profile, company. */
  async function partnerRecords(partner) {
    const { partnerType, user } = partner;
    if (partnerType === 'gym_owner') {
      const ids = user.gymIds?.length ? user.gymIds : (user.gymId ? [user.gymId] : []);
      const rows = await Promise.all(ids.map(id => gyms.findByIdAsync(id)));
      return { gyms: rows.filter(Boolean) };
    }
    if (partnerType === 'trainer') return { trainer: await trainers.findAsync(t => t.userId === user.id) };
    if (partnerType === 'vendor') return { vendorProfile: user.vendorProfile || {} };
    return { corporate: partner.corporate };
  }

  async function evaluate(partner, kycCase) {
    const [rows, records] = await Promise.all([caseRows(kycCase), partnerRecords(partner)]);
    return { rows, checklist: evaluateKyc(partner.partnerType, { case: kycCase, ...rows, ...records }) };
  }

  const settlementView = a => ({
    id: a.id, method: a.method, provider: a.provider, accountName: a.accountName, accountNumber: a.accountNumber,
    branch: a.branch, currency: a.currency, status: a.status, isPrimary: a.isPrimary, createdAt: a.createdAt,
  });

  // What callers see of a document: never where or how it is stored.
  const documentView = ({ storageProvider, storageKey, sha256: _hash, ...doc }) => ({ ...doc, hasFile: Boolean(storageKey) });

  /** A partner's (or an admin's view of a partner's) KYC: case, details and checklist. */
  async function overview(partner) {
    const kycCase = await findCase(partner);
    const { rows, checklist } = await evaluate(partner, kycCase);
    return {
      partnerType: partner.partnerType,
      case: kycCase,
      people: rows.people,
      documents: rows.documents.map(documentView),
      settlementAccounts: rows.settlementAccounts.map(settlementView),
      checklist,
    };
  }

  // ── Business profile ──────────────────────────────────────────────────────

  async function updateBusiness(partner, body = {}, actor) {
    if (!BUSINESS_REQUIREMENTS[partner.partnerType].length) return fail('not_applicable', 400);
    const { patch, error, allowed } = cleanFields(body, BUSINESS_FIELDS, BUSINESS_RULES);
    if (error) return fail(error, 400, allowed ? { allowed } : {});
    if (!Object.keys(patch).length) return fail('nothing_to_update');
    const existing = await findCase(partner);
    if (!editable(existing, actor)) return fail('case_locked', 409, { caseStatus: existing.status });
    const kycCase = await ensureCase(partner, actor);
    await partnerKycCases.updateByIdAsync(kycCase.id, { ...patch, updatedAt: nowIso() });
    await record(kycCase, { eventType: 'profile_updated', targetType: 'case', data: { fields: Object.keys(patch) } }, actor);
    return overview(partner);
  }

  // ── People ────────────────────────────────────────────────────────────────

  async function upsertPerson(partner, role, body = {}, actor) {
    const spec = PERSON_REQUIREMENTS[partner.partnerType];
    if (role !== spec.role) return fail('invalid_role', 400, { allowed: [spec.role] });
    const { patch, error, allowed } = cleanFields(body, PERSON_FIELDS, PERSON_RULES);
    if (error) return fail(error, 400, allowed ? { allowed } : {});
    const existingCase = await findCase(partner);
    if (!editable(existingCase, actor)) return fail('case_locked', 409, { caseStatus: existingCase.status });
    const kycCase = await ensureCase(partner, actor);
    const current = (await partnerPeople.filterByColumnAsync('caseId', kycCase.id)).find(p => p.role === role);
    if (!current && !patch.fullName) return fail('fullName_required');
    if (current && 'fullName' in patch && !patch.fullName) return fail('fullName_required');
    let personId;
    if (current) {
      personId = current.id;
      await partnerPeople.updateByIdAsync(current.id, { ...patch, status: 'pending', updatedAt: nowIso() });
    } else {
      personId = `ppl_${randomUUID().slice(0, 12)}`;
      await partnerPeople.insertAsync({
        id: personId, caseId: kycCase.id, role, ...patch, createdAt: nowIso(), updatedAt: nowIso(),
      });
    }
    await record(kycCase, { eventType: 'person_updated', targetType: 'person', targetId: personId, data: { role, fields: Object.keys(patch) } }, actor);
    return overview(partner);
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  /**
   * Write to the document standing for a requirement. While it is still
   * pending it is corrected in place; once reviewed or expired (or if there
   * is none) a new one starts, pointing back at the one it replaces.
   */
  async function writeDocument(kycCase, requirementKey, patch, actor, id = null) {
    const current = currentDocument(await partnerDocuments.filterByColumnAsync('caseId', kycCase.id), requirementKey);
    if (current && current.status === 'pending') {
      await partnerDocuments.updateByIdAsync(current.id, { ...patch, updatedAt: nowIso() });
      return current.id;
    }
    const docId = id || `pdoc_${randomUUID().slice(0, 12)}`;
    await partnerDocuments.insertAsync({
      id: docId, caseId: kycCase.id, round: kycCase.round || 1, requirementKey,
      docType: DOCUMENT_REQUIREMENTS[requirementKey].types[0], details: {},
      ...patch, status: 'pending', supersedesId: current?.id || null,
      uploadedBy: actor.id || null, createdAt: nowIso(), updatedAt: nowIso(),
    });
    return docId;
  }

  /**
   * Attach a document's file (PDF, JPEG, PNG or WebP, up to 10 MB). The type
   * is read from the file itself; photos are re-encoded without metadata.
   * Replaces the file of a document still waiting for review.
   */
  async function attachDocumentFile(partner, requirementKey, upload = {}, actor) {
    if (!DOCUMENTS_FOR[partner.partnerType].includes(requirementKey)) {
      return fail('invalid_requirement', 400, { allowed: DOCUMENTS_FOR[partner.partnerType] });
    }
    const spec = DOCUMENT_REQUIREMENTS[requirementKey];
    if (upload.docType !== undefined && !spec.types.includes(upload.docType)) return fail('invalid_docType', 400, { allowed: spec.types });
    if (!documentStore) return fail('storage_service_unavailable', 503);
    if (!Buffer.isBuffer(upload.buffer)) return fail('no_file_provided');
    const existingCase = await findCase(partner);
    if (!documentEditable(existingCase, actor)) return fail('case_locked', 409, { caseStatus: existingCase.status });

    const file = await prepareDocumentFile(upload.buffer, { truncated: upload.truncated });
    if (file.error) return fail(file.error, file.error === 'file_too_large' ? 413 : 400);

    const kycCase = await ensureCase(partner, actor);
    const newId = `pdoc_${randomUUID().slice(0, 12)}`;
    let stored;
    try {
      // Stored under a random name; the original name is kept only for display.
      stored = await documentStore.put(file.buffer, `${newId}.${file.ext}`, file.mimeType);
    } catch (err) {
      return fail(err.code === 'storage_service_unavailable' ? err.message : 'storage_upload_failed', 503);
    }
    const docId = await writeDocument(kycCase, requirementKey, {
      ...(upload.docType ? { docType: upload.docType } : {}),
      storageProvider: stored.provider, storageKey: stored.key, mimeType: file.mimeType,
      sizeBytes: file.sizeBytes, sha256: file.sha256, fileName: displayFileName(upload.filename, file.ext),
      uploadedBy: actor.id || null,
    }, actor, newId);

    // The same file on another partner's case is worth a reviewer's attention.
    const elsewhere = (await partnerDocuments.filterByColumnAsync('sha256', file.sha256)).some(d => d.caseId !== kycCase.id);
    await record(kycCase, {
      eventType: 'document_uploaded', targetType: 'document', targetId: docId,
      data: { requirementKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes, ...(elsewhere ? { sameFileOnAnotherCase: true } : {}) },
    }, actor);
    return overview(partner);
  }

  async function loadDocumentFile(kycCase, documentId, viewer) {
    const doc = await partnerDocuments.findByIdAsync(documentId);
    if (!doc || doc.caseId !== kycCase.id) return fail('document_not_found', 404);
    if (!doc.storageKey) return fail('document_has_no_file', 404);
    if (!documentStore || documentStore.provider !== doc.storageProvider) return fail('storage_service_unavailable', 503);
    let buffer;
    try {
      buffer = await documentStore.get(doc.storageKey);
    } catch {
      return fail('storage_download_failed', 502);
    }
    if (sha256(buffer) !== doc.sha256) return fail('file_integrity_failed', 502);
    await auditLog.insertAsync({
      id: `aud_${randomUUID().slice(0, 8)}`, at: nowIso(), actor: viewer.id || 'system', action: 'kyc.document_viewed',
      target: kycCase.id, before: null, after: { documentId: doc.id, requirementKey: doc.requirementKey, viewerRole: viewer.role },
    });
    return { file: { buffer, mimeType: doc.mimeType, fileName: doc.fileName || `${doc.requirementKey}` } };
  }

  /** Partner: one of my own documents' files. */
  async function readOwnDocumentFile(partner, documentId, viewer) {
    const kycCase = await findCase(partner);
    if (!kycCase) return fail('document_not_found', 404);
    return loadDocumentFile(kycCase, documentId, viewer);
  }

  /** Reviewer: a document's file. Every view is audited. */
  async function readDocumentFile(caseId, documentId, viewer) {
    const kycCase = await partnerKycCases.findByIdAsync(caseId);
    if (!kycCase) return fail('case_not_found', 404);
    return loadDocumentFile(kycCase, documentId, viewer);
  }

  // ── Document details ──────────────────────────────────────────────────────
  // The details (number, issuer, dates) are recorded now; the file is
  // attached once private document storage is in place.

  async function upsertDocumentDetails(partner, requirementKey, body = {}, actor) {
    if (!DOCUMENTS_FOR[partner.partnerType].includes(requirementKey)) {
      return fail('invalid_requirement', 400, { allowed: DOCUMENTS_FOR[partner.partnerType] });
    }
    const spec = DOCUMENT_REQUIREMENTS[requirementKey];
    const docType = body.docType ?? spec.types[0];
    if (!spec.types.includes(docType)) return fail('invalid_docType', 400, { allowed: spec.types });
    const { patch, error } = cleanFields(body, ['documentNumber', 'issuer', 'issuedOn', 'expiresOn'], DOCUMENT_RULES);
    if (error) return fail(error);
    if (patch.issuedOn && patch.expiresOn && patch.expiresOn <= patch.issuedOn) return fail('expiresOn_before_issuedOn');
    let details;
    if (body.details !== undefined) {
      if (!body.details || typeof body.details !== 'object' || Array.isArray(body.details) || JSON.stringify(body.details).length > 2000) {
        return fail('invalid_details');
      }
      details = body.details;
    }
    const existingCase = await findCase(partner);
    if (!documentEditable(existingCase, actor)) return fail('case_locked', 409, { caseStatus: existingCase.status });
    const kycCase = await ensureCase(partner, actor);
    const docId = await writeDocument(kycCase, requirementKey, { docType, ...patch, ...(details ? { details } : {}) }, actor);
    await record(kycCase, {
      eventType: 'document_updated', targetType: 'document', targetId: docId,
      data: { requirementKey, docType, fields: Object.keys(patch) },
    }, actor);
    return overview(partner);
  }

  // ── Settlement accounts ───────────────────────────────────────────────────
  // A new account always starts unverified. Verifying it (and making it the
  // payout account) is a FitFlex step in a later phase.

  async function addSettlementAccount(partner, body = {}, actor) {
    if (!SETTLEMENT_REQUIRED[partner.partnerType]) return fail('not_applicable', 400);
    const method = body.method;
    if (!SETTLEMENT_METHODS.includes(method)) return fail('invalid_method', 400, { allowed: SETTLEMENT_METHODS });
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    if (method === 'mobile_money' && !MOBILE_MONEY_PROVIDERS.includes(provider)) {
      return fail('invalid_provider', 400, { allowed: MOBILE_MONEY_PROVIDERS });
    }
    if (!provider || provider.length > 100) return fail('provider_required');
    const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : '';
    if (!accountName || accountName.length > MAX_TEXT) return fail('accountName_required');
    const accountNumber = normalizeIdentifier(body.accountNumber)?.replace(/^\+/, '') || null;
    if (!accountNumber || accountNumber.length > 34) return fail('accountNumber_required');
    if (method === 'mobile_money' && !/^(0|255)\d{9}$/.test(accountNumber)) return fail('invalid_mobile_number');

    const kycCase = await ensureCase(partner, actor);
    const accounts = await partnerSettlementAccounts.filterByColumnAsync('caseId', kycCase.id);
    const live = accounts.filter(a => a.status === 'pending_verification' || a.status === 'verified');
    if (live.some(a => a.accountNumber === accountNumber && a.provider === provider)) return fail('account_already_added', 409);
    if (live.length >= 3) return fail('too_many_accounts', 409);

    const id = `psa_${randomUUID().slice(0, 12)}`;
    await partnerSettlementAccounts.insertAsync({
      id, caseId: kycCase.id, method, provider, accountName, accountNumber,
      branch: typeof body.branch === 'string' ? body.branch.trim().slice(0, MAX_TEXT) : null,
      swiftCode: typeof body.swiftCode === 'string' ? body.swiftCode.trim().toUpperCase().slice(0, 11) : null,
      status: 'pending_verification', isPrimary: false, requestedBy: actor.id || null,
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    await record(kycCase, {
      eventType: 'settlement_account_changed', targetType: 'settlement_account', targetId: id,
      data: { change: 'added', method, provider },
    }, actor);
    return { account: settlementView(await partnerSettlementAccounts.findByIdAsync(id)) };
  }

  async function removeSettlementAccount(partner, accountId, actor) {
    const kycCase = await findCase(partner);
    const account = kycCase && await partnerSettlementAccounts.findByIdAsync(accountId);
    if (!account || account.caseId !== kycCase.id) return fail('account_not_found', 404);
    if (account.status !== 'pending_verification') return fail('account_not_removable', 409, { accountStatus: account.status });
    await partnerSettlementAccounts.removeByIdAsync(account.id);
    await record(kycCase, {
      eventType: 'settlement_account_changed', targetType: 'settlement_account', targetId: account.id,
      data: { change: 'removed', method: account.method, provider: account.provider },
    }, actor);
    return { ok: true };
  }

  // ── Reviewer steps ────────────────────────────────────────────────────────

  /** Record a FitFlex site visit to a gym: result, vetting score and the tier it merits. */
  async function recordSiteVisit({ gymId, body = {}, actor }) {
    const gym = await gyms.findByIdAsync(gymId);
    if (!gym) return fail('gym_not_found', 404);
    const owner = await users.findAsync(u => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId)));
    if (!owner) return fail('gym_has_no_owner', 409);
    if (!['passed', 'failed'].includes(body.result)) return fail('invalid_result', 400, { allowed: ['passed', 'failed'] });
    const score = Number(body.score);
    const maxScore = body.maxScore === undefined || body.maxScore === null ? null : Number(body.maxScore);
    if (!Number.isFinite(score) || score < 0) return fail('invalid_score');
    if (maxScore !== null && (!Number.isFinite(maxScore) || maxScore <= 0 || score > maxScore)) return fail('invalid_maxScore');
    if (!GYM_TIERS.includes(body.tier)) return fail('invalid_tier', 400, { allowed: GYM_TIERS });
    const visitedOn = body.visitedOn ?? nowIso().slice(0, 10);
    if (!DAY.test(visitedOn)) return fail('invalid_visitedOn');
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : null;
    const rubric = body.rubric && typeof body.rubric === 'object' && !Array.isArray(body.rubric) ? body.rubric : null;

    const partner = { partnerType: 'gym_owner', subjectId: owner.id, user: owner };
    const kycCase = await ensureCase(partner, actor);
    const id = `pchk_${randomUUID().slice(0, 12)}`;
    await partnerChecks.insertAsync({
      id, caseId: kycCase.id, round: kycCase.round || 1, checkType: 'site_visit', targetType: 'gym', targetId: gymId,
      method: 'site_visit', result: body.result, note: notes,
      evidence: { score, maxScore, tier: body.tier, visitedOn, ...(rubric ? { rubric } : {}) },
      performedBy: actor.id || null, performedAt: nowIso(), createdAt: nowIso(), updatedAt: nowIso(),
    });
    await record(kycCase, {
      eventType: 'check_recorded', targetType: 'gym', targetId: gymId,
      data: { checkType: 'site_visit', result: body.result, score, tier: body.tier },
    }, actor);
    return { check: await partnerChecks.findByIdAsync(id), gymTier: gym.tier, tierMatches: gym.tier === body.tier };
  }

  // ── In-app agreements ─────────────────────────────────────────────────────

  /** Partner: the agreements to accept, in their language, and whether each is accepted. */
  async function agreements(partner, lang) {
    const kycCase = await findCase(partner);
    const rows = kycCase ? await partnerAgreements.filterByColumnAsync('caseId', kycCase.id) : [];
    return {
      agreements: requiredAgreements(partner.partnerType).map(({ agreementType, text }) => {
        const accepted = rows.find(a => a.agreementType === agreementType && a.version === text.version && a.status === 'accepted');
        return { agreementType, ...agreementText(text, lang), acceptedAt: accepted?.acceptedAt || null };
      }),
    };
  }

  /**
   * Partner: accept the current version of an agreement. Accepting again is a
   * no-op; accepting a new version supersedes the earlier one.
   */
  async function acceptAgreement(partner, body = {}, actor, meta = {}) {
    const required = requiredAgreements(partner.partnerType).find(a => a.agreementType === body.agreementType);
    if (!required) return fail('invalid_agreement', 400, { allowed: requiredAgreements(partner.partnerType).map(a => a.agreementType) });
    const { version } = required.text;
    if (body.version !== version) return fail('agreement_version_outdated', 409, { version });
    const kycCase = await ensureCase(partner, actor);
    const rows = await partnerAgreements.filterByColumnAsync('caseId', kycCase.id);
    const same = rows.filter(a => a.agreementType === body.agreementType);
    if (same.some(a => a.version === version && a.status === 'accepted')) return overview(partner);
    const at = nowIso();
    const existing = same.find(a => a.version === version); // revoked earlier: accept it again
    const fields = {
      status: 'accepted', acceptedBy: actor.id || null, acceptedAt: at, revokedAt: null,
      acceptedIp: typeof meta.ip === 'string' ? meta.ip.slice(0, 64) : null,
      acceptedUserAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 300) : null,
      effectiveFrom: at, updatedAt: at,
    };
    if (existing) await partnerAgreements.updateByIdAsync(existing.id, fields);
    else {
      await partnerAgreements.insertAsync({
        id: `pagr_${randomUUID().slice(0, 12)}`, caseId: kycCase.id, agreementType: body.agreementType, version,
        ...fields, createdAt: at,
      });
    }
    for (const a of same.filter(r => r.version !== version && r.status === 'accepted')) {
      await partnerAgreements.updateByIdAsync(a.id, { status: 'superseded', updatedAt: at });
    }
    await record(kycCase, {
      eventType: 'agreement_accepted', targetType: 'case', data: { agreementType: body.agreementType, version },
    }, actor);
    return overview(partner);
  }

  /** Record a signed corporate contract (FitFlex keeps the signed copy). */
  async function recordCorporateContract({ corporateId, body = {}, actor }) {
    const partner = await resolvePartner('corporate', corporateId);
    if (partner.error) return partner;
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    if (!version || version.length > 64) return fail('version_required');
    const signedOn = body.signedOn ?? nowIso().slice(0, 10);
    if (!DAY.test(signedOn)) return fail('invalid_signedOn');
    const kycCase = await ensureCase(partner, actor);
    const id = `pagr_${randomUUID().slice(0, 12)}`;
    try {
      await partnerAgreements.insertAsync({
        id, caseId: kycCase.id, agreementType: 'corporate_contract', version, status: 'accepted',
        acceptedBy: actor.id || null, acceptedAt: new Date(`${signedOn}T00:00:00Z`).toISOString(),
        effectiveFrom: body.effectiveFrom && DAY.test(body.effectiveFrom) ? new Date(`${body.effectiveFrom}T00:00:00Z`).toISOString() : null,
        expiresAt: body.expiresOn && DAY.test(body.expiresOn) ? new Date(`${body.expiresOn}T00:00:00Z`).toISOString() : null,
        createdAt: nowIso(), updatedAt: nowIso(),
      });
    } catch (err) {
      if (err.code === '23505') return fail('contract_version_exists', 409);
      throw err;
    }
    // Earlier contract versions stop applying.
    const earlier = (await partnerAgreements.filterByColumnAsync('caseId', kycCase.id))
      .filter(a => a.agreementType === 'corporate_contract' && a.id !== id && a.status === 'accepted');
    for (const a of earlier) await partnerAgreements.updateByIdAsync(a.id, { status: 'superseded', updatedAt: nowIso() });
    await record(kycCase, {
      eventType: 'agreement_accepted', targetType: 'case', data: { agreementType: 'corporate_contract', version, signedOn },
    }, actor);
    return overview(partner);
  }

  // ── Status changes ────────────────────────────────────────────────────────

  // What the partner is told at each step.
  const MESSAGES = {
    submitted: () => ({ title: 'Verification details received', body: 'Thank you. FitFlex will review your details and let you know the outcome.' }),
    info_requested: note => ({ title: 'More information needed', body: note || 'FitFlex needs more information to finish verifying you. Open your verification to see what to update.' }),
    approved: () => ({ title: 'You are verified', body: 'Your FitFlex partner verification is approved.' }),
    rejected: note => ({ title: 'Verification not approved', body: note || 'Your FitFlex partner verification was not approved.' }),
    suspended: note => ({ title: 'Verification suspended', body: note || 'Your FitFlex partner verification has been suspended.' }),
    reinstated: () => ({ title: 'Verification restored', body: 'Your FitFlex partner verification is active again.' }),
    reopened: () => ({ title: 'Verification reopened', body: 'You can update your details and submit them again.' }),
  };

  async function tell(kycCase, key, note) {
    if (!kycCase.userId || !MESSAGES[key]) return;
    try {
      await notify(kycCase.userId, { type: `kyc_${key}`, data: { caseId: kycCase.id }, ...MESSAGES[key](note) });
    } catch { /* a failed notification never fails the decision */ }
  }

  /** A verified owner's gyms that were waiting for KYC open to members. */
  async function openWaitingGyms(userId) {
    const owner = userId && await users.findByIdAsync(userId);
    const ids = owner ? (owner.gymIds?.length ? owner.gymIds : (owner.gymId ? [owner.gymId] : [])) : [];
    for (const id of ids) {
      const gym = await gyms.findByIdAsync(id);
      if (gym?.status === 'pending_verification') await gyms.updateAsync(g => g.id === id, { status: 'active' });
    }
  }

  /** Keep the approval flags every app reads in step with the case. */
  async function syncApproval(kycCase, status, note) {
    if (!kycCase.userId) return;
    const approvalStatus = approvalStatusForCase(status, kycCase.partnerType);
    const user = await users.findByIdAsync(kycCase.userId);
    if (user && (user.approvalStatus !== approvalStatus || (note !== undefined && user.approvalNote !== note))) {
      await users.updateByIdAsync(user.id, { approvalStatus, ...(note !== undefined ? { approvalNote: note } : {}) });
    }
    if (kycCase.partnerType === 'trainer') {
      const profile = await trainers.findAsync(t => t.userId === kycCase.userId);
      if (profile && profile.approvalStatus !== approvalStatus) await trainers.updateAsync(t => t.id === profile.id, { approvalStatus });
    }
  }

  async function moveCase(kycCase, to, actor, { reasonCode = null, reasonNote = null, patch = {}, data = {} } = {}) {
    if (!canTransitionCase(kycCase.status, to)) return fail('invalid_transition', 409, { caseStatus: kycCase.status, to });
    const round = startsNewRound(kycCase.status, to) ? (kycCase.round || 1) + 1 : (kycCase.round || 1);
    const updated = await partnerKycCases.updateByIdAsync(kycCase.id, {
      status: to, round,
      reasonCode: reasonRequired(to) ? reasonCode : null,
      reasonNote: reasonRequired(to) ? reasonNote : null,
      updatedAt: nowIso(), ...patch,
    });
    await record(updated, {
      eventType: 'status_changed', fromStatus: kycCase.status, toStatus: to,
      reasonCode: reasonCode || null, note: reasonNote || null, data,
    }, actor);
    return { case: updated };
  }

  /** Partner: send the case for review. Everything the partner provides must be in. */
  async function submit(partner, actor) {
    const kycCase = await findCase(partner);
    if (!kycCase) return fail('kyc_incomplete', 409, { missing: (await evaluate(partner, null)).checklist.missing });
    if (!['draft', 'info_requested'].includes(kycCase.status)) return fail('invalid_transition', 409, { caseStatus: kycCase.status });
    const { checklist } = await evaluate(partner, kycCase);
    if (!checklist.readyToSubmit) return fail('kyc_incomplete', 409, { missing: checklist.missing });
    const moved = await moveCase(kycCase, 'submitted', actor, { patch: { submittedAt: nowIso() } });
    if (moved.error) return moved;
    await syncApproval(moved.case, 'submitted');
    await tell(moved.case, 'submitted');
    return overview(partner);
  }

  /** Partner: take a submitted case back before a reviewer picks it up. */
  async function withdraw(partner, actor) {
    const kycCase = await findCase(partner);
    if (!kycCase) return fail('case_not_found', 404);
    if (kycCase.status !== 'submitted') return fail('invalid_transition', 409, { caseStatus: kycCase.status });
    const moved = await moveCase(kycCase, 'draft', actor);
    if (moved.error) return moved;
    return overview(partner);
  }

  async function reviewable(caseId, actor) {
    const kycCase = await partnerKycCases.findByIdAsync(caseId);
    if (!kycCase) return fail('case_not_found', 404);
    // Nobody reviews their own case, including through another of their roles.
    if (actor.id && kycCase.userId === actor.id) return fail('cannot_review_own_case', 403);
    return { kycCase };
  }

  /** Reviewer: take a submitted case into review, or reassign one in review to themselves. */
  async function claim(caseId, actor) {
    const { kycCase, error, status } = await reviewable(caseId, actor);
    if (error) return fail(error, status);
    if (kycCase.status === 'in_review') {
      if (kycCase.reviewerId === actor.id) return caseDetail(caseId);
      await partnerKycCases.updateByIdAsync(caseId, { reviewerId: actor.id, updatedAt: nowIso() });
      await record(kycCase, { eventType: 'reviewer_assigned', targetType: 'case', data: { from: kycCase.reviewerId || null } }, actor);
      return caseDetail(caseId);
    }
    if (kycCase.status !== 'submitted') return fail('invalid_transition', 409, { caseStatus: kycCase.status });
    const moved = await moveCase(kycCase, 'in_review', actor, { patch: { reviewerId: actor.id } });
    if (moved.error) return moved;
    return caseDetail(caseId);
  }

  const soonestExpiry = (documents) => documents
    .filter(d => d.status === 'accepted' && d.expiresOn)
    .map(d => d.expiresOn).sort()[0] || null;

  /**
   * Reviewer: decide a case — approve, reject, request_info, suspend,
   * reinstate or reopen. Approval needs every checklist item complete;
   * a super-admin may override that with a written reason.
   */
  async function decide(caseId, body = {}, actor) {
    const decision = REVIEW_DECISIONS[body.decision];
    if (!decision) return fail('invalid_decision', 400, { allowed: Object.keys(REVIEW_DECISIONS) });
    const { kycCase, error, status } = await reviewable(caseId, actor);
    if (error) return fail(error, status);
    if (kycCase.status !== decision.from) return fail('invalid_transition', 409, { caseStatus: kycCase.status, decision: body.decision });

    const reasonNote = typeof body.reasonNote === 'string' ? body.reasonNote.trim().slice(0, 2000) || null : null;
    const reasonCode = body.reasonCode ?? null;
    if (reasonRequired(decision.to) && !REASON_CODES.includes(reasonCode)) {
      return fail('reason_code_required', 400, { allowed: REASON_CODES });
    }

    const patch = {};
    const data = { decision: body.decision };
    if (decision.to === 'approved') {
      const partner = await resolvePartner(kycCase.partnerType, kycCase.userId || kycCase.corporateId);
      if (partner.error) return partner;
      const { rows, checklist } = await evaluate(partner, kycCase);
      const outstanding = checklist.sections.flatMap(sec => sec.items)
        .filter(i => i.status !== 'complete' && !i.optional).map(i => (i.gymId ? `${i.key}@${i.gymId}` : i.key));
      // Approving and reinstating both need a complete checklist.
      if (outstanding.length) {
        if (body.override !== true) return fail('kyc_incomplete', 409, { outstanding });
        if (!actor.superAdmin) return fail('override_requires_super_admin', 403);
        if (!reasonNote) return fail('override_reason_required', 400);
        data.override = true;
        data.outstanding = outstanding;
      }
      const expiry = soonestExpiry(rows.documents);
      patch.decidedAt = nowIso();
      patch.decidedBy = actor.id || null;
      // Review again when the first document expires, or in a year.
      patch.reverifyAt = expiry
        ? new Date(`${expiry}T00:00:00Z`).toISOString()
        : new Date(Date.now() + 365 * 86_400_000).toISOString();
    } else if (decision.to === 'rejected' || decision.to === 'info_requested') {
      patch.decidedAt = nowIso();
      patch.decidedBy = actor.id || null;
    }

    const moved = await moveCase(kycCase, decision.to, actor, { reasonCode, reasonNote, patch, data });
    if (moved.error) return moved;
    if (decision.to === 'approved' && kycCase.partnerType === 'gym_owner') await openWaitingGyms(kycCase.userId);
    await syncApproval(moved.case, decision.to, decision.to === 'rejected' ? reasonNote : (decision.to === 'approved' ? null : undefined));
    const message = { approve: 'approved', reject: 'rejected', request_info: 'info_requested', suspend: 'suspended', reinstate: 'reinstated', reopen: 'reopened' }[body.decision];
    await tell(moved.case, message, reasonNote);
    return caseDetail(caseId);
  }

  /** Reviewer: accept or reject one document. Only a document with its file can be accepted. */
  async function reviewDocument(caseId, documentId, body = {}, actor) {
    const { kycCase, error, status } = await reviewable(caseId, actor);
    if (error) return fail(error, status);
    // In review, or a renewal on a verified case.
    if (kycCase.status !== 'in_review' && !RENEWABLE.has(kycCase.status)) {
      return fail('case_not_in_review', 409, { caseStatus: kycCase.status });
    }
    const doc = await partnerDocuments.findByIdAsync(documentId);
    if (!doc || doc.caseId !== caseId) return fail('document_not_found', 404);
    if (doc.status !== 'pending') return fail('document_already_reviewed', 409, { documentStatus: doc.status });
    if (!['accept', 'reject'].includes(body.decision)) return fail('invalid_decision', 400, { allowed: ['accept', 'reject'] });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;
    if (body.decision === 'accept' && !doc.storageKey) return fail('document_has_no_file', 409);
    if (body.decision === 'reject' && !note) return fail('note_required', 400);
    await partnerDocuments.updateByIdAsync(doc.id, {
      status: body.decision === 'accept' ? 'accepted' : 'rejected',
      reviewNote: note, reviewedBy: actor.id || null, reviewedAt: nowIso(), updatedAt: nowIso(),
    });
    if (body.decision === 'accept' && RENEWABLE.has(kycCase.status)) {
      // An accepted renewal replaces the document it renews and moves the
      // next review date.
      if (doc.supersedesId) {
        const old = await partnerDocuments.findByIdAsync(doc.supersedesId);
        if (old?.status === 'accepted') await partnerDocuments.updateByIdAsync(old.id, { status: 'superseded', updatedAt: nowIso() });
      }
      const standing = (await partnerDocuments.filterByColumnAsync('caseId', caseId)).filter(d => d.status === 'accepted');
      const expiry = soonestExpiry(standing);
      if (expiry) await partnerKycCases.updateByIdAsync(caseId, { reverifyAt: new Date(`${expiry}T00:00:00Z`).toISOString(), updatedAt: nowIso() });
    }
    await record(kycCase, {
      eventType: 'document_reviewed', targetType: 'document', targetId: doc.id, note,
      data: { requirementKey: doc.requirementKey, decision: body.decision, ...(RENEWABLE.has(kycCase.status) ? { renewal: true } : {}) },
    }, actor);
    return caseDetail(caseId);
  }

  /**
   * Reviewer: verify or reject a payout account. Whoever added the account
   * can't verify it. A verified account becomes the payout account if there
   * isn't one yet, and can receive payouts once its cooling-off period ends.
   */
  async function reviewSettlementAccount(caseId, accountId, body = {}, actor) {
    const { kycCase, error, status } = await reviewable(caseId, actor);
    if (error) return fail(error, status);
    const account = await partnerSettlementAccounts.findByIdAsync(accountId);
    if (!account || account.caseId !== caseId) return fail('account_not_found', 404);
    if (!['verify', 'reject'].includes(body.decision)) return fail('invalid_decision', 400, { allowed: ['verify', 'reject'] });
    const to = body.decision === 'verify' ? 'verified' : 'rejected';
    if (!canTransitionSettlement(account.status, to)) return fail('invalid_transition', 409, { accountStatus: account.status });
    if (actor.id && account.requestedBy === actor.id) return fail('cannot_verify_own_request', 403);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;
    if (to === 'rejected' && !note) return fail('note_required', 400);

    const patch = { status: to, updatedAt: nowIso() };
    if (to === 'verified') {
      const accounts = await partnerSettlementAccounts.filterByColumnAsync('caseId', caseId);
      patch.verifiedBy = actor.id || null;
      patch.verifiedAt = nowIso();
      patch.cooldownUntil = new Date(Date.now() + SETTLEMENT_COOLDOWN_HOURS * 3_600_000).toISOString();
      patch.isPrimary = !accounts.some(a => a.isPrimary);
    }
    await partnerSettlementAccounts.updateByIdAsync(account.id, patch);
    await record(kycCase, {
      eventType: 'settlement_account_changed', targetType: 'settlement_account', targetId: account.id, note,
      data: { change: to, method: account.method, provider: account.provider, ...(patch.isPrimary ? { primary: true } : {}) },
    }, actor);
    return caseDetail(caseId);
  }

  // ── Expiry reminders ──────────────────────────────────────────────────────

  /**
   * Remind verified partners about documents that expire soon: 30 and 7 days
   * before, and on the day (or when found already expired). Reminders only —
   * nothing is suspended (owner decision, 28 Sep). Each reminder is sent once
   * per document and window; a renewal already uploaded stops them.
   */
  async function sendExpiryReminders({ now = new Date() } = {}) {
    const today = new Date(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    const cases = [
      ...await partnerKycCases.filterByColumnAsync('status', 'approved'),
      ...await partnerKycCases.filterByColumnAsync('status', 'suspended'),
    ].filter(c => c.userId);
    let sent = 0;
    let already = 0;
    for (const kycCase of cases) {
      const documents = await partnerDocuments.filterByColumnAsync('caseId', kycCase.id);
      const events = await partnerKycEvents.filterByColumnAsync('caseId', kycCase.id);
      const reminded = new Set(events
        .filter(e => e.eventType === 'note' && e.data?.kind === 'expiry_reminder')
        .map(e => `${e.targetId}:${e.data.window}`));
      for (const requirementKey of new Set(documents.map(d => d.requirementKey))) {
        const doc = currentDocument(documents, requirementKey);
        if (!doc || doc.status !== 'accepted' || !doc.expiresOn) continue; // none, or a renewal is waiting
        const daysLeft = Math.round((+new Date(`${doc.expiresOn}T00:00:00Z`) - +today) / 86_400_000);
        if (daysLeft < -30) continue; // long expired: reminded already
        const window = EXPIRY_REMINDER_DAYS.filter(d => daysLeft <= d).pop();
        if (window === undefined) continue;
        if (reminded.has(`${doc.id}:${window}`)) { already += 1; continue; }
        const name = REQUIREMENT_NAMES[requirementKey] || 'document';
        const body = daysLeft > 0
          ? `Your ${name} expires on ${doc.expiresOn}. Upload the renewed one in Verification.`
          : `Your ${name} expired on ${doc.expiresOn}. Upload the renewed one in Verification.`;
        try {
          await notify(kycCase.userId, {
            type: 'kyc_document_expiring',
            title: daysLeft > 0 ? `Your ${name} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : `Your ${name} has expired`,
            body,
            data: { caseId: kycCase.id, requirementKey, expiresOn: doc.expiresOn },
          });
        } catch { /* a failed notification is retried on the next run */ continue; }
        await partnerKycEvents.insertAsync({
          id: `pevt_${randomUUID().slice(0, 12)}`, caseId: kycCase.id, round: kycCase.round || 1,
          eventType: 'note', targetType: 'document', targetId: doc.id, actorId: null, actorRole: 'system',
          note: body, data: { kind: 'expiry_reminder', window, requirementKey, expiresOn: doc.expiresOn }, at: nowIso(),
        });
        sent += 1;
      }
    }
    return { cases: cases.length, sent, already };
  }

  // ── Admin reads ───────────────────────────────────────────────────────────

  async function listCases({ status, partnerType } = {}) {
    let rows = status ? await partnerKycCases.filterByColumnAsync('status', status) : await partnerKycCases.allAsync();
    if (partnerType) rows = rows.filter(c => c.partnerType === partnerType);
    const userIds = rows.map(c => c.userId).filter(Boolean);
    const corporateIds = rows.map(c => c.corporateId).filter(Boolean);
    const [userRows, companyRows] = await Promise.all([
      userIds.length ? users.filterByColumnInAsync('id', userIds) : [],
      corporateIds.length ? corporateAccounts.filterByColumnInAsync('id', corporateIds) : [],
    ]);
    const names = new Map([
      ...userRows.map(u => [u.id, u.vendorProfile?.businessName || u.displayName || u.email || u.id]),
      ...companyRows.map(c => [c.id, c.companyName]),
    ]);
    // Documents with a file waiting for a reviewer — including renewals on
    // cases that are already approved.
    const toReview = new Map();
    for (const d of await partnerDocuments.filterByColumnAsync('status', 'pending')) {
      if (d.storageKey) toReview.set(d.caseId, (toReview.get(d.caseId) || 0) + 1);
    }
    return rows
      .map(c => ({
        id: c.id, partnerType: c.partnerType, subjectId: c.userId || c.corporateId,
        partnerName: names.get(c.userId || c.corporateId) || null, legalName: c.legalName,
        status: c.status, tier: c.tier, round: c.round, submittedAt: c.submittedAt, updatedAt: c.updatedAt, createdAt: c.createdAt,
        documentsToReview: toReview.get(c.id) || 0,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function caseDetail(caseId) {
    const kycCase = await partnerKycCases.findByIdAsync(caseId);
    if (!kycCase) return fail('case_not_found', 404);
    const partner = await resolvePartner(kycCase.partnerType, kycCase.userId || kycCase.corporateId);
    if (partner.error) return partner;
    const [view, rows, events] = await Promise.all([
      overview(partner),
      caseRows(kycCase),
      partnerKycEvents.filterByColumnAsync('caseId', caseId),
    ]);
    return {
      ...view,
      checks: rows.checks,
      agreements: rows.agreements,
      events: events.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    };
  }

  return {
    partnerForUser, resolvePartner, findCase, ensureCase, overview,
    updateBusiness, upsertPerson, upsertDocumentDetails,
    attachDocumentFile, readOwnDocumentFile, readDocumentFile,
    addSettlementAccount, removeSettlementAccount,
    recordSiteVisit, recordCorporateContract, agreements, acceptAgreement,
    submit, withdraw, claim, decide, reviewDocument, reviewSettlementAccount, sendExpiryReminders,
    listCases, caseDetail,
  };
}
