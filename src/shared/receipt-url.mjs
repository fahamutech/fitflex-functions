// A payout receipt link, as an admin records it when a statement is paid. It is
// shown to the partner, so only a plain https:// address is kept: no other
// scheme (javascript:, data:, http:), no user:password@ part, at most 1000
// characters. Empty means none.

const MAX = 1000;

/** null for none, the trimmed URL when it is acceptable, or undefined when it is not. */
export function readReceiptUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > MAX) return undefined;
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined;
  return raw;
}
