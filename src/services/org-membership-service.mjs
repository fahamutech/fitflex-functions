// Identity V2 · I4 — organisation memberships, derived from today's sources.
//
// The relationships themselves still live where they always have:
//   gym owner   User(gym_operator).gymIds / gymId
//   gym staff   User(gym_staff).gymIds + aclPermissions
//   gym trainer TrainerProfileGym (joined) and TrainerProfile.pendingGymIds (applied)
//   gym member  the member's latest direct subscription at each gym
//   vendor      the vendor's User row (Vendor.id = that User.id); staff via User.vendorId
// This service works out what each persona should hold and makes OrgMembership
// match (insert, update, end — never delete). It is idempotent, so the same
// code is the backfill, the dual-write and the drift check (apply: false).
//
// Suspension is always the membership's: a gym pausing a member, or an owner
// suspending a staff account at their organisation, never suspends the Person.
//
// Corporate relationships are not copied here. membershipsOfPerson() reads
// them from the B2B tables so callers get one list.
import { randomUUID } from 'node:crypto';

const LIVE = ['requested', 'invited', 'active', 'suspended'];
const PAID_SUB_STATUSES = ['active', 'expired', 'suspended'];
const omId = () => `om_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const keyOf = m => `${m.orgType}:${m.gymId ?? m.vendorId}:${m.role}`;
const gymIdsOf = u => (Array.isArray(u.gymIds) && u.gymIds.length ? u.gymIds : (u.gymId ? [u.gymId] : []));
const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

export function createOrgMembershipService({ db }) {
  /** What `user` should hold right now, from the source-of-truth columns. */
  async function expectedFor(trx, user, gymIds) {
    const accountStatus = user.accountStatus === 'suspended' ? 'suspended' : 'active';
    const out = [];
    const gym = (gymId, role, status, extra = {}) => {
      if (gymIds.has(gymId)) out.push({ orgType: 'gym', gymId, vendorId: null, role, status, aclPermissions: [], ...extra });
    };

    if (user.userType === 'gym_operator') {
      for (const id of gymIdsOf(user)) gym(id, 'owner', accountStatus);
    } else if (user.userType === 'gym_staff') {
      for (const id of gymIdsOf(user)) gym(id, 'staff', accountStatus, { aclPermissions: user.aclPermissions || [] });
    } else if (user.userType === 'trainer') {
      const profile = await trx('TrainerProfile').where({ userId: user.id }).first('id', 'pendingGymIds');
      if (profile) {
        const joined = await trx('TrainerProfileGym').where({ trainerId: profile.id }).select('gymId');
        const joinedIds = new Set(joined.map(r => r.gymId));
        for (const id of joinedIds) gym(id, 'trainer', accountStatus);
        for (const id of profile.pendingGymIds || []) if (!joinedIds.has(id)) gym(id, 'trainer', 'requested');
      }
    } else if (user.userType === 'member') {
      // The latest paid direct subscription at each gym decides the membership.
      const subs = await trx('Subscription')
        .where({ memberId: user.id, type: 'direct_sub' }).whereNotNull('homeGymId')
        .whereIn('status', PAID_SUB_STATUSES).orderBy('startedAt', 'desc');
      const seen = new Set();
      for (const s of subs) {
        if (seen.has(s.homeGymId)) continue;
        seen.add(s.homeGymId);
        const expired = s.expiresAt && Date.now() > +new Date(s.expiresAt);
        const status = s.status === 'suspended' ? 'suspended' : (expired || s.status === 'expired') ? 'left' : 'active';
        gym(s.homeGymId, 'member', status, { startedAt: s.startedAt, endedAt: status === 'left' ? s.expiresAt : null });
      }
    } else if (user.userType === 'vendor') {
      out.push({ orgType: 'vendor', gymId: null, vendorId: user.id, role: 'owner', status: accountStatus, aclPermissions: [] });
    } else if (user.userType === 'vendor_staff' && user.vendorId) {
      out.push({
        orgType: 'vendor', gymId: null, vendorId: user.vendorId, role: 'staff', status: accountStatus,
        aclPermissions: user.vendorPermissions || [],
      });
    }
    return out;
  }

  /** The thin Vendor record for a vendor persona (id = that User.id). */
  async function ensureVendor(trx, vendorUser, apply) {
    const name = vendorUser.vendorProfile?.businessName || vendorUser.displayName || 'Vendor';
    const status = vendorUser.accountStatus === 'suspended' ? 'suspended' : 'active';
    const current = await trx('Vendor').where({ id: vendorUser.id }).first();
    if (current && current.name === name && current.status === status) return 0;
    if (apply) {
      if (current) await trx('Vendor').where({ id: vendorUser.id }).update({ name, status, updatedAt: trx.fn.now() });
      else await trx('Vendor').insert({ id: vendorUser.id, name, status });
    }
    return current ? 0 : 1;
  }

  async function reconcileUser(trx, user, gymIds, apply, report) {
    if (!user.personId) return;
    if (user.userType === 'vendor') report.vendors += await ensureVendor(trx, user, apply);
    let expected = await expectedFor(trx, user, gymIds);
    // Staff can only belong to a vendor that has its organisation record.
    if (user.userType === 'vendor_staff') {
      const vendor = user.vendorId ? await trx('Vendor').where({ id: user.vendorId }).first('id') : null;
      if (!vendor) expected = [];
    }

    const existing = await trx('OrgMembership').where({ personaId: user.id });
    const liveByKey = new Map(existing.filter(m => LIVE.includes(m.status)).map(m => [keyOf(m), m]));
    const anyByKey = new Set(existing.map(keyOf));

    for (const e of expected) {
      const k = keyOf(e);
      const current = liveByKey.get(k);
      liveByKey.delete(k);
      if (current) {
        const aclChanged = !sameSet(current.aclPermissions || [], e.aclPermissions);
        if (current.status === e.status && !aclChanged) continue;
        report.updated += 1;
        if (!apply) continue;
        const ended = !LIVE.includes(e.status);
        await trx('OrgMembership').where({ id: current.id }).update({
          status: e.status, aclPermissions: e.aclPermissions,
          ...(ended ? { endedAt: e.endedAt ?? trx.fn.now(), endReason: 'source_ended' } : { endedAt: null, endReason: null }),
          updatedAt: trx.fn.now(),
        });
        continue;
      }
      // An ended relationship is recorded once, as history.
      if (!LIVE.includes(e.status) && anyByKey.has(k)) continue;
      report.inserted += 1;
      if (!apply) continue;
      await trx('OrgMembership').insert({
        id: omId(), personId: user.personId, personaId: user.id,
        orgType: e.orgType, gymId: e.gymId, vendorId: e.vendorId, role: e.role, status: e.status,
        aclPermissions: e.aclPermissions, source: e.status === 'requested' ? 'application' : 'sync',
        startedAt: e.status === 'requested' ? null : (e.startedAt ?? trx.fn.now()),
        endedAt: LIVE.includes(e.status) ? null : (e.endedAt ?? trx.fn.now()),
        endReason: LIVE.includes(e.status) ? null : 'source_ended',
      });
    }

    // Live memberships the sources no longer support are ended, never deleted.
    for (const stale of liveByKey.values()) {
      report.ended += 1;
      if (!apply) continue;
      await trx('OrgMembership').where({ id: stale.id }).update({
        status: stale.role === 'member' ? 'left' : stale.status === 'requested' ? 'declined' : 'removed',
        endedAt: trx.fn.now(), endReason: 'source_removed', updatedAt: trx.fn.now(),
      });
    }
  }

  const emptyReport = apply => ({ mode: apply ? 'apply' : 'dry-run', users: 0, vendors: 0, inserted: 0, updated: 0, ended: 0 });
  const liveGymIds = async trx => new Set((await trx('Gym').select('id')).map(g => g.id));

  /** Reconcile one persona. Called after any write that can change its relationships. */
  async function syncUser(userId, { apply = true } = {}) {
    const report = emptyReport(apply);
    if (!userId) return report;
    await db.transaction(async trx => {
      const user = await trx('User').where({ id: userId }).first();
      if (!user) return;
      report.users = 1;
      await reconcileUser(trx, user, await liveGymIds(trx), apply, report);
    });
    return report;
  }

  /**
   * Reconcile everyone. With apply: false this is the drift check: a non-zero
   * inserted / updated / ended count means memberships and sources disagree.
   */
  async function syncAll({ apply = false } = {}) {
    const report = emptyReport(apply);
    await db.transaction(async trx => {
      const gymIds = await liveGymIds(trx);
      // Vendors first, so vendor staff find their organisation record.
      const users = await trx('User')
        .whereIn('userType', ['vendor', 'gym_operator', 'gym_staff', 'trainer', 'member', 'vendor_staff'])
        .orderByRaw(`CASE WHEN "userType" = 'vendor' THEN 0 ELSE 1 END`);
      for (const user of users) {
        report.users += 1;
        await reconcileUser(trx, user, gymIds, apply, report);
      }
      // A removed persona leaves its memberships behind without a persona.
      const orphaned = await trx('OrgMembership').whereNull('personaId').whereIn('status', LIVE).select('id');
      report.ended += orphaned.length;
      if (apply && orphaned.length) {
        await trx('OrgMembership').whereIn('id', orphaned.map(o => o.id))
          .update({ status: 'removed', endedAt: trx.fn.now(), endReason: 'persona_removed', updatedAt: trx.fn.now() });
      }
    });
    return report;
  }

  /** End the live memberships of personas that no longer exist. */
  async function endOrphaned() {
    await db('OrgMembership').whereNull('personaId').whereIn('status', LIVE)
      .update({ status: 'removed', endedAt: db.fn.now(), endReason: 'persona_removed', updatedAt: db.fn.now() });
  }

  /**
   * Every organisation relationship of a Person, in one shape: gym and vendor
   * memberships from OrgMembership, corporate ones read from the B2B tables.
   */
  async function membershipsOfPerson(personId, { includeEnded = false } = {}) {
    if (!personId) return [];
    const rows = await db('OrgMembership').where({ personId })
      .modify(q => { if (!includeEnded) q.whereIn('status', LIVE); })
      .orderBy('createdAt');
    const out = rows.map(m => ({
      id: m.id, orgType: m.orgType, orgId: m.gymId ?? m.vendorId, role: m.role, status: m.status,
      aclPermissions: m.aclPermissions || [], personaId: m.personaId, startedAt: m.startedAt, endedAt: m.endedAt,
    }));

    if (await db.schema.hasTable('B2BOrganizationUser')) {
      const personas = (await db('User').where({ personId }).select('id')).map(u => u.id);
      if (personas.length) {
        const admins = await db('B2BOrganizationUser').whereIn('userId', personas)
          .modify(q => { if (!includeEnded) q.whereNot({ status: 'removed' }); });
        for (const a of admins) {
          out.push({
            id: a.id, orgType: 'corporate', orgId: a.organizationId, role: a.role, status: a.status,
            aclPermissions: a.permissions || [], personaId: a.userId, startedAt: a.createdAt, endedAt: a.removedAt ?? null,
          });
        }
        const beneficiaries = await db('B2BBeneficiary').whereIn('userId', personas)
          .modify(q => { if (!includeEnded) q.whereNot({ status: 'inactive' }); });
        for (const b of beneficiaries) {
          out.push({
            id: b.id, orgType: 'corporate', orgId: b.organizationId, role: 'beneficiary', status: b.status,
            aclPermissions: [], personaId: b.userId, startedAt: b.enrolledAt ?? b.createdAt, endedAt: null,
          });
        }
      }
    }
    return out;
  }

  return { syncUser, syncAll, endOrphaned, membershipsOfPerson };
}
