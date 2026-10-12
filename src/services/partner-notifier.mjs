// Notifications for the people who run things on FitFlex — gym owners and
// their staff, and vendors — about what happens at their gym or shop.
//
// Each goes through the ordinary notification service (inbox + push), with
// the ids a phone needs to open the right screen: gymId, memberId, orderId…
// Nothing here may fail the thing it reports on, so every send is
// best-effort.

const tzs = n => `TZS ${Number(n || 0).toLocaleString('en-US')}`;

// A membership activated this recently is a new one, not a renewal of an old one.
const NEW_MEMBERSHIP_MS = 10 * 60 * 1000;

export function createPartnerNotifier({ users, gyms, trainers = null, subscriptions = null, notify, logger = console, now = () => new Date() }) {
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
        // A fixed id makes a message once-only; each person still gets their own copy.
        const id = message.id ? `${message.id}_${String(userId).replace(/[^A-Za-z0-9]/g, '').slice(-10)}` : undefined;
        await send(userId, { ...message, ...(id ? { id } : {}) });
      }
    } catch (err) {
      logger.warn?.(`[partner-notify] ${message.type} for gym ${gymId} failed: ${err?.message}`);
    }
  }

  const nameOf = async (userId, fallback) => (await users.findByIdAsync(userId))?.displayName || fallback;
  const gymName = async gymId => (await gyms.findByIdAsync?.(gymId))?.name || 'your gym';

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
    });
  }

  /**
   * A member joined the gym: their first membership there was activated.
   * A renewal, or a second membership after an earlier one, is not news.
   */
  async function gymMemberJoined(sub) {
    const gymId = sub?.homeGymId;
    if (!gymId || sub.type !== 'direct_sub') return;
    try {
      if (+now() - +new Date(sub.createdAt) > NEW_MEMBERSHIP_MS) return;
      const earlier = subscriptions
        ? (await subscriptions.filterByColumnAsync('memberId', sub.memberId))
          .some(x => x.id !== sub.id && x.type === 'direct_sub' && x.homeGymId === gymId)
        : false;
      if (earlier) return;
    } catch (err) {
      logger.warn?.(`[partner-notify] gym_member_joined check failed: ${err?.message}`);
      return;
    }
    await toGym(gymId, {
      id: `ntf_join_${String(sub.id).slice(0, 40)}`.replace(/[^A-Za-z0-9_]/g, ''),
      type: 'gym_member_joined',
      title: 'New member',
      body: `${await nameOf(sub.memberId, 'A member')} now has a membership at ${await gymName(gymId)}.`,
      data: { gymId, memberId: sub.memberId, subscriptionId: sub.id },
    });
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
  };

  /** Something happened in a vendor's shop. Events with no message here stay in the shop's own list only. */
  async function vendorEvent(vendorUserId, event, data = {}) {
    const make = VENDOR_MESSAGES[event];
    if (make) await send(vendorUserId, make(data));
  }

  return { gymCheckin, gymMemberJoined, gymTrainerRequest, gymReview, gymStatement, vendorEvent, gymPeople };
}
