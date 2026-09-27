// Zebra storage client, shared by the public image uploads (functions/
// storage.mjs) and private partner KYC documents.
//
// Zebra serves any stored file to whoever knows its content ID. Public images
// hand that address out on purpose. KYC documents never do: their content ID
// stays in the database, and the API streams the file to signed-in callers
// who may see it (createZebraDocumentStore below).
import Busboy from '@fastify/busboy';
import FormData from 'form-data';
import axios from 'axios';

const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const stripTrailingSlash = value => `${value ?? ''}`.replace(/\/+$/g, '');
const zebraBaseUrl = () => process.env.ZEBRA_BASE_URL;
export const storageEndpoint = () => `${stripTrailingSlash(zebraBaseUrl())}/storage`;

export class StorageUnavailableError extends Error {
  constructor(message = 'storage_service_unavailable') {
    super(message);
    this.code = 'storage_service_unavailable';
  }
}

/**
 * Read a multipart request into memory. With limits.fileSize set, a file
 * larger than the limit comes back with truncated: true.
 */
export const parseMultipartRequest = (request, limits) => new Promise((resolve, reject) => {
  const busboy = new Busboy({ headers: request.headers, ...(limits ? { limits } : {}) });
  const fields = [];
  const files = [];
  busboy.on('field', (name, value) => fields.push({ name, value }));
  busboy.on('file', (fieldname, stream, filename, encoding, mimetype) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      files.push({ fieldname, filename: filename || 'file', encoding, mimetype, buffer: Buffer.concat(chunks), truncated: Boolean(stream.truncated) });
    });
  });
  busboy.on('error', reject);
  busboy.on('finish', () => resolve({ fields, files }));
  request.pipe(busboy);
});

export const uploadToZebra = async (buffer, filename, mimetype) => {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype });
  return axios.post(storageEndpoint(), form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: UPLOAD_TIMEOUT_MS,
    validateStatus: () => true,
  });
};

/**
 * Zebra responds with `{ urls: ["/storage/<cid>/<filename>"] }` — a
 * root-relative path. Normalize to `{ cid, filename, url }`.
 */
export const parseZebraResponse = data => {
  const relativeUrl = data?.urls?.[0];
  if (!relativeUrl) return null;
  const url = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  const [, cid, filename] = url.match(/^\/storage\/([^/]+)\/(.+)$/) || [];
  return { cid: cid || null, filename: filename || null, url };
};

/**
 * Private documents on Zebra. put() returns a storage key ("<cid>/<filename>")
 * that must never leave the server; get() fetches the bytes back for the API
 * to stream after its own access checks.
 */
export function createZebraDocumentStore() {
  return {
    provider: 'zebra',
    async put(buffer, filename, mimeType) {
      if (!zebraBaseUrl()) throw new StorageUnavailableError();
      const response = await uploadToZebra(buffer, filename, mimeType);
      if (response.status < 200 || response.status >= 300) throw new StorageUnavailableError('storage_upload_failed');
      const stored = parseZebraResponse(response.data);
      if (!stored?.cid || !stored.filename) throw new StorageUnavailableError('storage_upload_failed');
      return { provider: 'zebra', key: `${stored.cid}/${stored.filename}` };
    },
    async get(key) {
      if (!zebraBaseUrl()) throw new StorageUnavailableError();
      const [cid, ...rest] = String(key).split('/');
      const filename = rest.join('/');
      const response = await axios.get(`${storageEndpoint()}/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`, {
        responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS, maxContentLength: 20 * 1024 * 1024,
        maxRedirects: 3, validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) throw new StorageUnavailableError('storage_download_failed');
      return Buffer.from(response.data);
    },
  };
}
