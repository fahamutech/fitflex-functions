// Partner KYC documents: file checks, private storage and access.
// - File type comes from the bytes; photos lose their metadata; bad PDFs are refused.
// - Storage keys never appear in responses; files are read back only by their
//   partner or a reviewer, checked against their hash, and every view is audited.
// - The routes run against a local stand-in for Zebra, through the real client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import FormData from 'form-data';
import sharp from 'sharp';
import { db } from '../src/infra/knex-store.mjs';
import * as collections from '../src/bootstrap/collections.mjs';
import { createPartnerKycService } from '../src/services/partner-kyc-service.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { sniffDocumentType, pdfProblem, displayFileName, prepareDocumentFile, sha256 } from '../src/infra/document-file.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { myKycDocumentFile, myKycReadDocumentFile, adminKycReadDocumentFile } from '../functions/partner-kyc.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const users = [];
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

async function makeUser(userType) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `KYC docs ${userType}`, updatedAt: new Date() });
  users.push(id);
  return id;
}

/** An in-memory stand-in for Zebra: put/get by key. */
function memoryStore() {
  const files = new Map();
  let n = 0;
  return {
    files, provider: 'zebra',
    async put(buffer, name) { const key = `bafymem${++n}/${name}`; files.set(key, Buffer.from(buffer)); return { provider: 'zebra', key }; },
    async get(key) { if (!files.has(key)) throw new Error('missing'); return Buffer.from(files.get(key)); },
  };
}

function kycService(documentStore) {
  const c = collections;
  return createPartnerKycService({
    users: c.users, gyms: c.gyms, trainers: c.trainers, corporateAccounts: c.corporateAccounts,
    partnerKycCases: c.partnerKycCases, partnerPeople: c.partnerPeople, partnerDocuments: c.partnerDocuments,
    partnerChecks: c.partnerChecks, partnerSettlementAccounts: c.partnerSettlementAccounts,
    partnerAgreements: c.partnerAgreements, partnerKycEvents: c.partnerKycEvents, auditLog: c.auditLog,
    documentStore,
  });
}

async function trainer(svc) {
  const id = await makeUser('trainer');
  return { partner: await svc.partnerForUser(id), actor: { id, role: 'partner' }, id };
}

// ── A local Zebra for the route tests ────────────────────────────────────────

const zebraFiles = new Map();
let zebra;
before(async () => {
  zebra = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/storage') {
      const { files } = await parseMultipartRequest(req);
      const cid = `bafyzebra${zebraFiles.size + 1}`;
      zebraFiles.set(`${cid}/${files[0].filename}`, files[0].buffer);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ urls: [`/storage/${cid}/${files[0].filename}`] }));
    }
    const key = decodeURIComponent(req.url.replace(/^\/storage\//, ''));
    if (req.method === 'GET' && zebraFiles.has(key)) return res.end(zebraFiles.get(key));
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => zebra.listen(0, '127.0.0.1', resolve));
  process.env.ZEBRA_BASE_URL = `http://127.0.0.1:${zebra.address().port}`;
});

after(async () => {
  delete process.env.ZEBRA_BASE_URL;
  await new Promise(resolve => zebra.close(resolve));
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('User').whereIn('id', users).del();
  }
});

// ── File checks ─────────────────────────────────────────────────────────────

test('the file type comes from its bytes, not its name', async () => {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).png().toBuffer();
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).webp().toBuffer();
  assert.deepEqual(sniffDocumentType(PDF), { mimeType: 'application/pdf', ext: 'pdf' });
  assert.equal(sniffDocumentType(jpeg).mimeType, 'image/jpeg');
  assert.equal(sniffDocumentType(png).mimeType, 'image/png');
  assert.equal(sniffDocumentType(webp).mimeType, 'image/webp');
  assert.equal(sniffDocumentType(Buffer.from('MZ\x90\x00 this is an exe file')), null);
  assert.equal(sniffDocumentType(Buffer.from('<html><script>')), null);
});

test('encrypted PDFs and PDFs with scripts are refused', async () => {
  assert.equal(pdfProblem(PDF), null);
  assert.equal(pdfProblem(Buffer.from('%PDF-1.7 << /Encrypt 5 0 R >>')), 'encrypted_pdf');
  assert.equal(pdfProblem(Buffer.from('%PDF-1.7 << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>')), 'pdf_with_active_content');
  assert.deepEqual(await prepareDocumentFile(Buffer.from('%PDF-1.4 /Launch /F (cmd.exe)')), { error: 'pdf_with_active_content' });
});

test('photos are re-encoded without their location metadata', async () => {
  const withGps = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123' } })
    .jpeg().withExif({ IFD0: { Make: 'PhoneCo' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '6/1 48/1 0/1' } }).toBuffer();
  assert.ok((await sharp(withGps).metadata()).exif);
  const file = await prepareDocumentFile(withGps);
  assert.equal(file.mimeType, 'image/jpeg');
  assert.equal((await sharp(file.buffer).metadata()).exif, undefined);
  assert.equal(file.sha256, sha256(file.buffer));
});

test('size, emptiness and broken images are caught', async () => {
  assert.deepEqual(await prepareDocumentFile(PDF, { truncated: true }), { error: 'file_too_large' });
  assert.deepEqual(await prepareDocumentFile(Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])), { error: 'file_too_large' });
  assert.deepEqual(await prepareDocumentFile(Buffer.alloc(0)), { error: 'empty_file' });
  assert.deepEqual(await prepareDocumentFile(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), { error: 'unreadable_image' });
});

test('display names keep the original name, safely', () => {
  assert.equal(displayFileName('C:\\\\Users\\\\asha\\\\TIN cert (final).PDF', 'pdf'), 'TIN cert final.pdf');
  assert.equal(displayFileName('../../etc/passwd', 'pdf'), 'passwd.pdf');
  assert.equal(displayFileName('', 'jpg'), 'document.jpg');
});

// ── Service ─────────────────────────────────────────────────────────────────

test('an upload attaches the file privately and moves the checklist on', async () => {
  const store = memoryStore();
  const svc = kycService(store);
  const t = await trainer(svc);
  await svc.upsertDocumentDetails(t.partner, 'certification', { issuer: 'ACE', documentNumber: 'A1', issuedOn: '2024-01-01', expiresOn: '2027-01-01' }, t.actor);
  const view = await svc.attachDocumentFile(t.partner, 'certification', { buffer: PDF, filename: 'my cert.pdf' }, t.actor);
  const doc = view.documents.find(d => d.requirementKey === 'certification');
  assert.equal(view.documents.length, 1);
  assert.equal(doc.hasFile, true);
  assert.equal(doc.fileName, 'my cert.pdf');
  assert.deepEqual(['storageKey', 'storageProvider', 'sha256'].filter(k => k in doc), []);
  assert.equal(view.checklist.sections.flatMap(s => s.items).find(i => i.key === 'professional.certification').status, 'submitted');

  // Stored under a random name, not the partner's file name.
  const [storedKey] = [...store.files.keys()];
  assert.match(storedKey, /^bafymem1\/pdoc_[0-9a-f-]+\.pdf$/);
  const row = await db('PartnerDocument').where('id', doc.id).first();
  assert.equal(row.sha256, sha256(PDF));
  assert.equal(row.mimeType, 'application/pdf');
});

test('a file can come before its details, and replacing it keeps the same pending document', async () => {
  const svc = kycService(memoryStore());
  const t = await trainer(svc);
  let view = await svc.attachDocumentFile(t.partner, 'liability_insurance', { buffer: PDF, filename: 'policy.pdf' }, t.actor);
  const first = view.documents[0];
  assert.equal(view.checklist.sections.flatMap(s => s.items).find(i => i.key === 'professional.liability_cover').status, 'incomplete');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  view = await svc.attachDocumentFile(t.partner, 'liability_insurance', { buffer: png, filename: 'policy.png' }, t.actor);
  assert.equal(view.documents.length, 1);
  assert.equal(view.documents[0].id, first.id);
  assert.equal(view.documents[0].mimeType, 'image/png');
});

test('after a rejection, a new upload starts a new document', async () => {
  const svc = kycService(memoryStore());
  const t = await trainer(svc);
  const first = (await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF, filename: 'id.pdf' }, t.actor)).documents[0];
  await db('PartnerDocument').where('id', first.id).update({ status: 'rejected', reviewNote: 'Blurred' });
  const view = await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF, filename: 'id-again.pdf' }, t.actor);
  const replacement = view.documents.find(d => d.id !== first.id);
  assert.equal(replacement.supersedesId, first.id);
  assert.equal(replacement.status, 'pending');
});

test('the same file on two partners\' cases is flagged for reviewers', async () => {
  const svc = kycService(memoryStore());
  const a = await trainer(svc);
  const b = await trainer(svc);
  const unique = Buffer.concat([PDF, Buffer.from(`% ${randomUUID()}\n`)]);
  await svc.attachDocumentFile(a.partner, 'certification', { buffer: unique, filename: 'c.pdf' }, a.actor);
  const view = await svc.attachDocumentFile(b.partner, 'certification', { buffer: unique, filename: 'c.pdf' }, b.actor);
  const upload = (await db('PartnerKycEvent').where({ caseId: view.case.id, eventType: 'document_uploaded' }))[0];
  assert.equal(upload.data.sameFileOnAnotherCase, true);
});

test('uploads are refused for the wrong requirement, a locked case, bad files, or no storage', async () => {
  const svc = kycService(memoryStore());
  const t = await trainer(svc);
  assert.equal((await svc.attachDocumentFile(t.partner, 'business_licence', { buffer: PDF }, t.actor)).error, 'invalid_requirement');
  assert.equal((await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF, docType: 'selfie' }, t.actor)).error, 'invalid_docType');
  assert.equal((await svc.attachDocumentFile(t.partner, 'trainer_id', {}, t.actor)).error, 'no_file_provided');
  const exe = await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: Buffer.from('MZ\x90\x00 an executable file') }, t.actor);
  assert.deepEqual([exe.error, exe.status], ['unsupported_file_type', 400]);
  const big = await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF, truncated: true }, t.actor);
  assert.deepEqual([big.error, big.status], ['file_too_large', 413]);
  const view = await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF }, t.actor);
  await db('PartnerKycCase').where('id', view.case.id).update({ status: 'submitted' });
  assert.equal((await svc.attachDocumentFile(t.partner, 'trainer_id', { buffer: PDF }, t.actor)).error, 'case_locked');

  const noStore = kycService(null);
  const u = await trainer(noStore);
  assert.deepEqual(await noStore.attachDocumentFile(u.partner, 'trainer_id', { buffer: PDF }, u.actor), { error: 'storage_service_unavailable', status: 503 });
  const failing = kycService({ provider: 'zebra', put: async () => { throw Object.assign(new Error('storage_upload_failed'), { code: 'storage_service_unavailable' }); } });
  const w = await trainer(failing);
  assert.equal((await failing.attachDocumentFile(w.partner, 'trainer_id', { buffer: PDF }, w.actor)).status, 503);
});

test('files are read back only by their partner or a reviewer, intact, and every view is audited', async () => {
  const store = memoryStore();
  const svc = kycService(store);
  const t = await trainer(svc);
  const view = await svc.attachDocumentFile(t.partner, 'certification', { buffer: PDF, filename: 'cert.pdf' }, t.actor);
  const docId = view.documents[0].id;

  const own = await svc.readOwnDocumentFile(t.partner, docId, t.actor);
  assert.deepEqual([own.file.mimeType, own.file.fileName, own.file.buffer.equals(PDF)], ['application/pdf', 'cert.pdf', true]);

  const stranger = await trainer(svc);
  assert.equal((await svc.readOwnDocumentFile(stranger.partner, docId, stranger.actor)).error, 'document_not_found');

  const reviewer = { id: await makeUser('admin'), role: 'admin' };
  const seen = await svc.readDocumentFile(view.case.id, docId, reviewer);
  assert.ok(seen.file.buffer.equals(PDF));
  const audits = await db('AuditLog').where({ target: view.case.id, action: 'kyc.document_viewed' });
  assert.deepEqual(audits.map(a => a.actor).sort(), [t.id, reviewer.id].sort());

  // A file changed in storage is refused rather than served.
  const [key] = [...store.files.keys()].filter(k => k.endsWith('.pdf')).slice(-1);
  store.files.set(key, Buffer.from('%PDF-1.7 tampered'));
  assert.deepEqual(await svc.readDocumentFile(view.case.id, docId, reviewer), { error: 'file_integrity_failed', status: 502 });
  assert.equal((await svc.readDocumentFile('kyc_nope', docId, reviewer)).error, 'case_not_found');
});

// ── Routes, through the real Zebra client ───────────────────────────────────

function multipart(fields, fileBuffer, filename) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (fileBuffer) form.append('file', fileBuffer, { filename, contentType: 'application/octet-stream' });
  const body = form.getBuffer();
  return Object.assign(Readable.from([body]), { headers: form.getHeaders() });
}

async function call(route, claims, { params = {}, req: base } = {}) {
  const req = base || Object.assign(Readable.from([]), { headers: {} });
  req.headers = { ...req.headers, authorization: `Bearer ${sign(claims)}` };
  Object.assign(req, { params, body: {}, query: {} });
  const out = {
    statusCode: 200, body: null, headers: {}, sent: null,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(buf) { this.sent = buf; },
  };
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

test('routes: a partner uploads through the API and views it back; a reviewer views it; Zebra addresses never leak', async () => {
  const id = await makeUser('trainer');
  const claims = { sub: id, userType: 'trainer' };
  const up = await call(myKycDocumentFile, claims, {
    params: { requirementKey: 'certification' }, req: multipart({ docType: 'certification' }, PDF, 'ACE certificate.pdf'),
  });
  assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  const doc = up.body.documents[0];
  assert.equal(doc.hasFile, true);
  assert.ok(!JSON.stringify(up.body).includes('bafyzebra'));
  assert.equal(zebraFiles.size, 1);

  const own = await call(myKycReadDocumentFile, claims, { params: { documentId: doc.id } });
  assert.equal(own.statusCode, 200);
  assert.ok(own.sent.equals(PDF));
  assert.equal(own.headers['content-type'], 'application/pdf');
  assert.equal(own.headers['cache-control'], 'no-store, private');
  assert.equal(own.headers['x-content-type-options'], 'nosniff');
  assert.match(own.headers['content-disposition'], /^inline; filename="ACE%20certificate\.pdf"/);

  const staff = { sub: await makeUser('admin'), userType: 'admin', portalUser: true, aclPermissions: ['kyc'] };
  const seen = await call(adminKycReadDocumentFile, staff, { params: { id: up.body.case.id, documentId: doc.id } });
  assert.ok(seen.sent.equals(PDF));
  const noScope = await call(adminKycReadDocumentFile, { ...staff, aclPermissions: ['gyms'] }, { params: { id: up.body.case.id, documentId: doc.id } });
  assert.equal(noScope.statusCode, 403);
});

test('routes: oversized uploads are stopped at the limit', async () => {
  const id = await makeUser('trainer');
  const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 10)]);
  const up = await call(myKycDocumentFile, { sub: id, userType: 'trainer' }, {
    params: { requirementKey: 'certification' }, req: multipart({}, big, 'huge.pdf'),
  });
  assert.deepEqual([up.statusCode, up.body.error], [413, 'file_too_large']);
});
