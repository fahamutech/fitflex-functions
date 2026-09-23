// Saved gyms (US017). Stored on the member's profile JSON as favoriteGymIds —
// a short list per member doesn't warrant its own table.
const MAX_FAVORITES = 100;

export function createFavoriteService({ users, gyms }) {
  async function list(memberId) {
    const user = await users.findByIdAsync(memberId);
    const ids = user?.memberProfile?.favoriteGymIds || [];
    // Drop gyms that were deleted or deactivated since they were saved.
    return ids.filter(id => gyms.find(g => g.id === id && g.status !== 'inactive'));
  }

  async function set({ memberId, gymId, favorite }) {
    const user = await users.findByIdAsync(memberId);
    if (!user) return { error: 'user_not_found', status: 404 };
    if (favorite && !gyms.find(g => g.id === gymId)) return { error: 'gym_not_found', status: 404 };
    const current = user.memberProfile?.favoriteGymIds || [];
    let next = current.filter(id => id !== gymId);
    if (favorite) {
      if (next.length >= MAX_FAVORITES) return { error: 'too_many_favorites', status: 400 };
      next = [gymId, ...next];
    }
    await users.updateByIdAsync(memberId, { memberProfile: { ...(user.memberProfile || {}), favoriteGymIds: next } });
    return { favoriteGymIds: next };
  }

  return { list, set };
}
