// Notifications REST surface — device registration for push and the in-app inbox.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { notificationService, deliveryService, communicationPreferenceService } from '../src/bootstrap/services.mjs';

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

export const clickNotification = {
  created, method: 'post', path: '/me/notifications/:id/click',
  description: 'Any signed-in user: they tapped the message\'s button (marks it read and clicked). POST { via: "inbox" | "push" }.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await notificationService.markClicked({ userId: req.user.sub, id: req.params.id, via: req.body?.via });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const pushMessageOpened = {
  created, method: 'post', path: '/me/communications/messages/:id/opened',
  description: 'Any signed-in user: they opened a campaign push that has no inbox copy (records the open).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await deliveryService.pushOpened({ userId: req.user.sub, messageId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const myCommunicationPreferences = {
  created, method: 'get', path: '/me/communication-preferences',
  description: 'Any signed-in user: which messages from gyms and FitFlex they get. Service messages in the app and by push are always on.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => res.json(await communicationPreferenceService.get(req.user.sub))
};

export const updateMyCommunicationPreferences = {
  created, method: 'put', path: '/me/communication-preferences',
  description: 'Any signed-in user: change message choices. PUT { inAppMarketing?, pushMarketing?, whatsappTransactional?, whatsappMarketing?, locale? } — turning WhatsApp offers on records consent.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await communicationPreferenceService.update(req.user.sub, req.body || {});
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
    res.json(result);
  }
};
