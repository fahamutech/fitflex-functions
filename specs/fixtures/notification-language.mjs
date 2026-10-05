// What a message handed to notify() turns into for a reader of a given
// language: runs it through a real notification service (in-memory stores,
// a recording push sender) and returns the inbox row and the push.
import { createNotificationService } from '../../src/services/notification-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
    async removeAsync(fn) { for (let i = rows.length - 1; i >= 0; i--) if (fn(rows[i])) rows.splice(i, 1); },
  };
}

/**
 * @param {object} message  what a service passed to notify()
 * @param {'en'|'sw'|null} locale  the reader's stored language; null = never chose one
 * @returns {Promise<{ title:string, body:string, push:{title:string, body:string}, lookups:number }>}
 */
export async function deliveredTo(message, locale = null) {
  const pushes = [];
  const preferences = memStore(locale ? [{ id: 'reader', locale }] : []);
  let lookups = 0;
  const svc = createNotificationService({
    users: memStore([{ id: 'reader' }]), deviceTokens: memStore([{ id: 'd1', userId: 'reader', token: 'tok' }]),
    notifications: memStore(),
    preferences: { findByIdAsync: async (id) => { lookups += 1; return preferences.findByIdAsync(id); } },
    getMessaging: () => ({ async sendEachForMulticast(m) { pushes.push(m); return { successCount: 1, failureCount: 0, responses: [{ success: true }] }; } }),
    logger: { warn: () => {} },
  });
  // The fixture's reader stands in for whoever the service addressed.
  const { id, whatsapp, userId, to, u, ...rest } = message;
  const out = await svc.notify('reader', rest);
  return { title: out.notification.title, body: out.notification.body, push: pushes[0].notification, lookups };
}

/** Words the glossary bans, and English month and weekday names, must not reach a Swahili reader. */
export const NOT_SWAHILI = /\b(jimu|kocha|mkufunzi|wakufunzi|changamoto|January|February|March|April|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;
