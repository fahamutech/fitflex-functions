// Read-only audit log viewer (admin-portal audit S2): filters + keyset pagination over AuditLog.
import { redactAuditForDisplay, userAuditSnapshot } from '../shared/audit-redact.mjs';

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

const encodeCursor = (at, id) => Buffer.from(JSON.stringify([new Date(at).toISOString(), id])).toString('base64url');
function decodeCursor(raw) {
  try {
    const [at, id] = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof id !== 'string' || Number.isNaN(Date.parse(at))) return null;
    return { at: new Date(at), id };
  } catch { return null; }
}

/** Old rows may hold a whole User row; reduce those to the audit allow-list, strip credentials from the rest. */
function redactForViewer(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'userType' in value) return redactAuditForDisplay(userAuditSnapshot(value));
  return redactAuditForDisplay(value ?? null);
}

export function createAuditLogService({ db }) {
  /** → { items, nextCursor } or { error: 'invalid_filter', field, status: 400 } */
  async function list({ actor, action, target, from, to, limit, cursor } = {}) {
    const text = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    const date = (v, field) => {
      if (v === undefined || v === null || v === '') return { value: null };
      const d = new Date(String(v));
      return Number.isNaN(+d) ? { error: field } : { value: d };
    };
    const f = date(from, 'from'); if (f.error) return { error: 'invalid_filter', field: 'from', status: 400 };
    const t = date(to, 'to'); if (t.error) return { error: 'invalid_filter', field: 'to', status: 400 };
    let cur = null;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      cur = decodeCursor(cursor);
      if (!cur) return { error: 'invalid_filter', field: 'cursor', status: 400 };
    }
    const n = Math.floor(Number(limit));
    const pageSize = Number.isFinite(n) && n > 0 ? Math.min(n, AUDIT_PAGE_MAX) : AUDIT_PAGE_DEFAULT;

    const q = db('AuditLog').select('id', 'at', 'actor', 'action', 'target', 'before', 'after', 'reason');
    if (text(actor)) q.where('actor', text(actor));
    if (text(action)) q.where('action', text(action));
    if (text(target)) q.where('target', text(target));
    if (f.value) q.where('at', '>=', f.value);
    if (t.value) q.where('at', '<=', t.value);
    if (cur) q.whereRaw('(at, id) < (?, ?)', [cur.at, cur.id]);
    const rows = await q.orderBy([{ column: 'at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const items = page.map(r => ({
      id: r.id, at: new Date(r.at).toISOString(), actor: r.actor, action: r.action, target: r.target,
      before: redactForViewer(r.before), after: redactForViewer(r.after), reason: r.reason ?? null,
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > pageSize ? encodeCursor(last.at, last.id) : null };
  }
  return { list };
}
