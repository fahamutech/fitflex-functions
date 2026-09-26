// What makes a gym's public profile and rate card complete. Pure functions,
// shared by the gym service (the auto "verified" flag) and partner KYC (the
// gym owner's operational requirements) so both apply the same rule.

const present = v => v !== null && v !== undefined && v !== '';

/** Profile fields still missing: name, location, coordinates, photos, amenities, equipment. */
export function gymProfileGaps(gym = {}) {
  const gaps = [];
  if (!present(gym.name)) gaps.push('name');
  if (!present(gym.location)) gaps.push('location');
  if (!present(gym.coordinates?.lat) || !present(gym.coordinates?.lng)) gaps.push('coordinates');
  if (!(gym.images?.length > 0)) gaps.push('photos');
  if (!(gym.amenities?.length > 0)) gaps.push('amenities');
  if (!(gym.equipment?.length > 0)) gaps.push('equipment');
  return gaps;
}

export function isFreeOnlineGym(gym = {}) {
  return gym.venueType === 'online' || gym.accessMode === 'free_online';
}

/** Rate card fields still missing. Free online venues have no rates to set. */
export function gymRateCardGaps(gym = {}) {
  if (isFreeOnlineGym(gym)) return [];
  const rate = Number(gym.ratePerDay || 0) || Number(gym.perVisitRate || 0);
  return rate > 0 ? [] : ['day_rate'];
}
