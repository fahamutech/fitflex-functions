// The name an owner sees for someone who checked in at their gym.
//
// A trainer is known by the name on their trainer profile (the nickname when
// they chose one, same as everywhere else they appear); anyone else by their
// own display name. Only a name is ever returned: a display name that is in
// fact an email address or a phone number is withheld, so a contact detail
// never leaks through a field that is meant to be a name. null = no usable
// name, and the caller keeps showing the public ID.
const PHONE_LIKE = /^[+\d][\d\s().-]{5,}$/;

export function visitorName({ user, trainer } = {}) {
  const raw = (user?.userType === 'trainer' && trainer?.displayName) || user?.displayName || null;
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.includes('@') || PHONE_LIKE.test(name)) return null;
  return name.slice(0, 80);
}
