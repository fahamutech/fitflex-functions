// Notifications for the people who run things on FitFlex — gym owners and
// their staff, and vendors — about what happens at their gym or shop.
//
// Each goes through the ordinary notification service (inbox + push), with
// the ids a phone needs to open the right screen: gymId, memberId, orderId…
// Nothing here may fail the thing it reports on, so every send is
// best-effort.

import { formatTsh } from '../shared/money-display.mjs';

const tzs = formatTsh;

// A membership activated this recently is a new one, not a renewal of an old one.
const NEW_MEMBERSHIP_MS = 10 * 60 * 1000;

export function createPartnerNotifier({
  usernames = null, users, gyms, trainers = null, subscriptions = null, paymentRequests = null,
  // Each person's own message choices (communication preferences): check-in alerts can be switched off.
  preferences = null,
  notify, logger = console, now = () => new Date(),
}) {
  async function send(userId, message) {
    if (!userId) return;
    try {
      await notify(userId, message);
    } catch (err) {
      logger.warn?.(`[partner-notify] ${message.type} to ${userId} failed: ${err?.message}`);
    }
  }

  const runsGym = (u, gymId) => (Array.isArray(u.gymIds) ? u.gymIds.includes(gymId) : u.gymId === gymId);

  /** The people of a gym: its owner(s), and its staff unless `ownersOnly`. */
  async function gymPeople(gymId, { ownersOnly = false } = {}) {
    const roles = ownersOnly ? ['gym_operator'] : ['gym_operator', 'gym_staff'];
    const rows = await users.filterAsync(u => roles.includes(u.userType) && u.accountStatus !== 'suspended' && runsGym(u, gymId));
    return rows.map(u => u.id);
  }

  async function toGym(gymId, message, opts) {
    if (!gymId) return;
    try {
      for (const userId of await gymPeople(gymId, opts)) {
        if (opts?.unless && await opts.unless(userId)) continue;
        // A fixed id makes a message once-only; each person still gets their own copy.
        const id = message.id ? `${message.id}_${String(userId).replace(/[^A-Za-z0-9]/g, '').slice(-10)}` : undefined;
        await send(userId, { ...message, ...(id ? { id } : {}) });
      }
    } catch (err) {
      logger.warn?.(`[partner-notify] ${message.type} for gym ${gymId} failed: ${err?.message}`);
    }
  }

  // A gym sees the member's name, with their username beside it when they have one.
  const nameOf = async (userId, fallback) => {
    const name = (await users.findByIdAsync(userId))?.displayName || fallback;
    const handle = await usernames?.handleOf(userId);
    return handle ? `${name} (@${handle})` : name;
  };
  const gymName = async gymId => (await gyms.findByIdAsync?.(gymId))?.name || 'your gym';

  /** Has this person switched check-in alerts off? On unless they said so. */
  async function checkinAlertsOff(userId) {
    if (!preferences) return false;
    try {
      return (await preferences.findByIdAsync(userId))?.gymCheckinAlerts === false;
    } catch {
      return false;
    }
  }

  // ── Gyms ──────────────────────────────────────────────────────────────────

  /** A member checked in. */
  async function gymCheckin(checkin) {
    if (!checkin?.gymId) return;
    await toGym(checkin.gymId, {
      // One per visit, however many times it is reported.
      id: `ntf_chk_${String(checkin.id).slice(0, 40)}`.replace(/[^A-Za-z0-9_]/g, ''),
      type: 'gym_checkin',
      title: 'Member checked in',
      body: `${await nameOf(checkin.memberId, 'A member')} checked in at ${await gymName(checkin.gymId)}.`,
      data: { gymId: checkin.gymId, memberId: checkin.memberId, checkinId: checkin.id },
    }, { unless: checkinAlertsOff });
  }

  /**
   * A gym membership was paid for and activated.
   *
   * - The member's first membership at the gym: "New member", to the owner
   *   and staff.
   * - Anything after that — a renewal, or a member coming back: "Membership
   *   renewed", a payment notice for the owner only, once per period.
   */
  async function gymMemberJoined(sub) {
    const gymId = sub?.homeGymId;
    if (!gymId || sub.type !== 'direct_sub') return;
    let first = false;
    try {
      const fresh = +now() - +new Date(sub.createdAt) <= NEW_MEMBERSHIP_MS;
      const earlier = subscriptions
        ? (await subscriptions.filterByColumnAsync('memberId', sub.memberId))
          .some(x => x.id !== sub.id && x.type === 'direct_sub' && x.homeGymId === gymId)
        : false;
      first = fresh && !earlier;
    } catch (err) {
      logger.warn?.(`[partner-notify] gym membership check failed: ${err?.message}`);
      return;
    }
    const safe = v => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    const who = await nameOf(sub.memberId, 'A member');
    if (first) {
      await toGym(gymId, {
        id: `ntf_join_${safe(sub.id)}`,
        type: 'gym_member_joined',
        title: 'New member',
        body: `${who} now has a membership at ${await gymName(gymId)}.`,
        data: { gymId, memberId: sub.memberId, subscriptionId: sub.id },
      });
      return;
    }
    // The period it now runs to names the renewal, so it is told once.
    const until = sub.renewsAt || sub.expiresAt ? new Date(sub.renewsAt || sub.expiresAt).toISOString().slice(0, 10) : '';
    const paid = await paidFor(sub);
    await toGym(gymId, {
      id: `ntf_rnw_${safe(sub.id)}_${safe(until)}`,
      type: 'gym_membership_renewed',
      title: 'Membership renewed',
      body: `${who} renewed at ${await gymName(gymId)}${paid ? ` and paid ${tzs(paid)}` : ''}${until ? `. It now runs to ${until}.` : '.'}`,
      data: { gymId, memberId: sub.memberId, subscriptionId: sub.id, ...(paid ? { amountTzs: paid } : {}) },
    }, { ownersOnly: true });
  }

  /** What was last paid for this membership, when a payment is on record. */
  async function paidFor(sub) {
    if (!paymentRequests) return null;
    try {
      const rows = (await paymentRequests.filterByColumnAsync('subscriptionId', sub.id))
        .filter(p => p.status === 'approved' && Number(p.amountTzs) > 0)
        .sort((x, y) => +new Date(y.decidedAt || y.requestedAt || 0) - +new Date(x.decidedAt || x.requestedAt || 0));
      // Only a payment made for this renewal, not one from a period long past.
      const latest = rows[0];
      return latest && +now() - +new Date(latest.decidedAt || latest.requestedAt || 0) <= 24 * 60 * 60 * 1000 ? Number(latest.amountTzs) : null;
    } catch {
      return null;
    }
  }

  /** A trainer asked to work at the gym. */
  async function gymTrainerRequest({ gymId, trainer }) {
    await toGym(gymId, {
      type: 'gym_trainer_request',
      title: 'A trainer wants to join',
      body: `${trainer?.displayName || 'A trainer'} asked to train at ${await gymName(gymId)}. Review the request under Trainers.`,
      data: { gymId, trainerId: trainer?.id ?? '' },
    }, { ownersOnly: true });
  }

  /** A member left a new review of the gym. */
  async function gymReview(review) {
    if (!review?.gymId) return;
    await toGym(review.gymId, {
      type: 'gym_review',
      title: `New ${review.rating}-star review`,
      body: `${await nameOf(review.memberId, 'A member')} reviewed ${await gymName(review.gymId)}.`,
      data: { gymId: review.gymId, reviewId: review.id, rating: review.rating },
    });
  }

  /** A settlement statement was approved, or paid. Money: owners only. */
  async function gymStatement(statement, action) {
    if (!statement?.gymId || !['approved', 'paid'].includes(action)) return;
    const period = `${statement.periodStartDate} – ${statement.periodEndDate}`;
    await toGym(statement.gymId, {
      id: `ntf_stl_${String(statement.id).slice(0, 36)}_${action}`.replace(/[^A-Za-z0-9_]/g, ''),
      type: action === 'paid' ? 'gym_payout_paid' : 'gym_statement_approved',
      title: action === 'paid' ? 'Payout sent' : 'Statement ready',
      body: action === 'paid'
        ? `${tzs(statement.finalNetTzs)} for ${period} has been paid to ${await gymName(statement.gymId)}.`
        : `Your statement for ${period} is approved: ${tzs(statement.finalNetTzs)} to be paid.`,
      data: { gymId: statement.gymId, statementId: statement.id },
    }, { ownersOnly: true });
  }

  // ── Vendors ───────────────────────────────────────────────────────────────

  // The shop's own event → what the vendor is told.
  const VENDOR_MESSAGES = {
    new_order: d => ({ type: 'vendor_new_order', title: 'New order', body: 'You have a new paid order to prepare.', data: { orderId: d.orderId ?? '' } }),
    order_cancelled: d => ({ type: 'vendor_order_cancelled', title: 'Order cancelled', body: 'An order was cancelled. There is nothing more to prepare for it.', data: { orderId: d.orderId ?? '' } }),
    new_customer_enquiry: d => ({ type: 'vendor_customer_enquiry', title: 'New customer question', body: 'A customer asked about one of your products.', data: { enquiryId: d.enquiryId ?? '' } }),
    product_approved: d => ({ type: 'vendor_product_approved', title: 'Product approved', body: 'Your product is now visible in the shop.', data: { productId: d.productId ?? '' } }),
    product_rejected: d => ({ type: 'vendor_product_rejected', title: 'Product not approved', body: 'A product was not approved. Open it to see why and change it.', data: { productId: d.productId ?? '' } }),
    vendor_approved: () => ({ type: 'vendor_shop_approved', title: 'Your shop is approved', body: 'You can now sell on FitFlex.', data: {} }),
    vendor_rejected: d => ({ type: 'vendor_shop_rejected', title: 'Your shop was not approved', body: d.approvalNote || 'Open your shop profile to see what is needed.', data: {} }),
    vendor_suspended: d => ({ type: 'vendor_shop_suspended', title: 'Your shop is suspended', body: d.approvalNote || 'Your products are hidden until this is resolved.', data: {} }),
    // Vendor tools · S1. Swahili is a DRAFT for native review (plan §4, design spec §8.5); the push shows
    // English, and `titleSw` / `bodySw` let the app show Swahili in its inbox.
    vendor_low_stock: (d) => {
      const label = d.variant ? `${d.productName || 'A product'} (${d.variant})` : d.productName || 'A product';
      return {
        type: 'vendor_low_stock',
        title: `Low stock: ${label}`,
        body: `Only ${d.stock} left. Time to restock.`,
        data: {
          productId: d.productId ?? '', variant: d.variant ?? '', stock: d.stock ?? '',
          titleSw: `Stock inakaribia kuisha: ${label}`, bodySw: `Zimebaki ${d.stock} tu. Ni wakati wa kuongeza Stock.`,
        },
      };
    },
  };

  /** Something happened in a vendor's shop. Events with no message here stay in the shop's own list only. */
  async function vendorEvent(vendorUserId, event, data = {}) {
    const make = VENDOR_MESSAGES[event];
    if (make) await send(vendorUserId, make(data));
  }

  return { gymCheckin, gymMemberJoined, gymTrainerRequest, gymReview, gymStatement, vendorEvent, gymPeople };
}
