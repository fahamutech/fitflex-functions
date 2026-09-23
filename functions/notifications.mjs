// Notifications REST surface — device registration for push and the in-app inbox.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { notificationService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const registerDeviceToken = {
  created, method: 'post', path: '/me/device-tokens',
  description: 'Any signed-in user: register an FCM token for push. POST { token, platform }.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await notificationService.registerDevice({ userId: req.user.sub, token: req.body?.token, platform: req.body?.platform });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const unregisterDeviceToken = {
  created, method: 'post', path: '/me/device-tokens/remove',
  description: 'Any signed-in user: stop push to a device (on sign-out). POST { token }.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await notificationService.unregisterDevice({ userId: req.user.sub, token: req.body?.token });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const myNotifications = {
  created, method: 'get', path: '/me/notifications',
  description: 'Any signed-in user: newest-first inbox plus unread count. ?limit=50',
  onGuard: requireAuth(),
  onRequest: async (req, res) => res.json(await notificationService.inbox({ userId: req.user.sub, limit: req.query?.limit }))
};

export const markNotificationRead = {
  created, method: 'post', path: '/me/notifications/:id/read',
  description: 'Any signed-in user: mark one notification read, or "all".',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await notificationService.markRead({ userId: req.user.sub, id: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
