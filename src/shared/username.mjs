// What a member may call themselves in public (feature flag MEMBER_USERNAMES).
//
// 3 to 20 characters from a-z, 0-9, "." and "_", compared case-insensitively
// (the handle keeps the case the member typed). No leading "@", no leading or
// trailing "." or "_", no ".." or "__" runs. Contact details are refused: an
// email or a phone number is never a username.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const CHANGE_COOLDOWN_DAYS = 30;
export const RELEASE_HOLD_DAYS = 90;

// Names that would pass themselves off as FitFlex, its staff or roles.
export const RESERVED = Object.freeze([
  'fitflex', 'fitflexafrica', 'admin', 'administrator', 'support', 'help', 'staff', 'team', 'official',
  'moderator', 'mod', 'system', 'root', 'trainer', 'gym', 'owner', 'vendor', 'member', 'partner',
  'billing', 'payments', 'security', 'null', 'undefined', 'anonymous', 'everyone',
]);

// Obvious abuse, matched anywhere in the handle. A starting list, to be
// reviewed by a native Swahili speaker; moderation reports cover the rest.
export const BLOCKED_SUBSTRINGS = Object.freeze([
  'fuck', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'rapist', 'nazi', 'hitler',
  'malaya', 'kuma', 'mkundu', 'kafir',
]);

const SHAPE = /^[a-z0-9]([a-z0-9._]*[a-z0-9])?$/;

/** Letters and numbers only, for comparing a handle with a name that has spaces. */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * { ok:true, handle, handleLower } or { ok:false, error } where error is
 * 'invalid_username' or 'username_reserved'.
 */
export function cleanUsername(value) {
  let v = String(value ?? '').trim();
  if (v.startsWith('@')) v = v.slice(1);
  if (v.length < USERNAME_MIN || v.length > USERNAME_MAX) return { ok: false, error: 'invalid_username' };
  const lower = v.toLowerCase();
  if (!SHAPE.test(lower) || /[._]{2}/.test(lower)) return { ok: false, error: 'invalid_username' };
  // An email or phone number in disguise (digits and separators only, or 8+ digits).
  if ((lower.match(/\d/g) ?? []).length >= 8) return { ok: false, error: 'invalid_username' };
  const flat = squash(lower);
  if (RESERVED.includes(flat) || BLOCKED_SUBSTRINGS.some((w) => flat.includes(w))) {
    return { ok: false, error: 'username_reserved' };
  }
  return { ok: true, handle: v, handleLower: lower };
}
