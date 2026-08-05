// Shared helper: normalize a comma/newline-separated string or array into a
// clean array of trimmed, non-empty strings.
export function parseStringList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/\n|,/).map(v => v.trim()).filter(Boolean);
  return fallback;
}
