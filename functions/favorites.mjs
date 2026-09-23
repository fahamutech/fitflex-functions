// Saved gyms REST surface (US017).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { favoriteService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const myFavoriteGyms = {
  created, method: 'get', path: '/me/favorites/gyms',
  description: 'Member: saved gym ids, most recently saved first.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json({ favoriteGymIds: await favoriteService.list(req.user.sub) })
};

export const saveFavoriteGym = {
  created, method: 'put', path: '/me/favorites/gyms/:gymId',
  description: 'Member: save a gym.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await favoriteService.set({ memberId: req.user.sub, gymId: req.params.gymId, favorite: true });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const removeFavoriteGym = {
  created, method: 'delete', path: '/me/favorites/gyms/:gymId',
  description: 'Member: remove a saved gym.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await favoriteService.set({ memberId: req.user.sub, gymId: req.params.gymId, favorite: false });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
