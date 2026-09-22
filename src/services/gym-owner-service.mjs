// FitFlex Af — Gym Owner B2B Service (clean architecture + DI)
//
// Capabilities:
//   - Direct member management (walk-in members paid cash/mobile money at gym)
//   - Smart CSV/XLS bulk importer (EN + SW header mapping)
//   - Staff management with granular RBAC (5 preset roles + custom permissions)
//   - Multi-branch support (one owner, multiple gym branches)
//   - Facility & amenities configuration (equipment, operating hours, photos)
//   - Custodial delivery station (receive marketplace packages, verify collection)
//   - Class scheduling & trainer assignment
//   - Renewal reminders for direct members

import { randomUUID } from 'node:crypto';
import {
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  ALL_PERMISSIONS,
  DIRECT_MEMBER_PASS_TYPES,
  CSV_HEADER_MAP,
  parseCsvImport,
  AMENITIES,
  EQUIPMENT_INVENTORY,
  DEFAULT_OPERATING_HOURS
} from '../shared/gym-owner-constants.mjs';

export function createGymOwnerService({ users, gyms, checkins, directMembers, gymStaff, gymClasses, marketplaceOrders, auditLog }) {

  // ─── Direct Member Management ────────────────────────────────────────────

  function addDirectMember({ gymId, name, phone, email, passType, amount, startDate, endDate, notes }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    if (!name) return { ok: false, error: 'name_required' };
    if (!passType || !Object.values(DIRECT_MEMBER_PASS_TYPES).includes(passType))
      return { ok: false, error: 'invalid_pass_type' };

    const member = {
      id: `dm_${randomUUID().slice(0, 8)}`,
      gymId,
      name: name.trim(),
      phone: phone || null,
      email: email || null,
      passType,
      amount: Number(amount) || 0,
      startDate: startDate || new Date().toISOString().split('T')[0],
      endDate: endDate || null,
      notes: notes || null,
      createdAt: new Date().toISOString()
    };

    directMembers.insert(member);
    return { ok: true, member };
  }

  function updateDirectMember(memberId, gymId, updates) {
    const member = directMembers.find(m => m.id === memberId && m.gymId === gymId);
    if (!member) return { ok: false, error: 'member_not_found' };

    const allowed = ['name', 'phone', 'email', 'passType', 'amount', 'startDate', 'endDate', 'notes'];
    const patch = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }

    const updated = directMembers.update(m => m.id === memberId, patch);
    return { ok: true, member: updated };
  }

  function deleteDirectMember(memberId, gymId) {
    const member = directMembers.find(m => m.id === memberId && m.gymId === gymId);
    if (!member) return { ok: false, error: 'member_not_found' };
    directMembers.remove(m => m.id === memberId);
    return { ok: true };
  }

  function listDirectMembers(gymId, { search, passType, expiringWithin, limit = 100 } = {}) {
    let list = directMembers.filter(m => m.gymId === gymId);

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        (m.name || '').toLowerCase().includes(q) ||
        (m.phone || '').includes(q) ||
        (m.email || '').toLowerCase().includes(q)
      );
    }
    if (passType) list = list.filter(m => m.passType === passType);

    if (expiringWithin) {
      const days = Number(expiringWithin);
      const cutoff = new Date(Date.now() + days * 86_400_000);
      list = list.filter(m => {
        if (!m.endDate) return false;
        return new Date(m.endDate) <= cutoff;
      });
    }

    return list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, limit);
  }

  // ─── CSV Bulk Import ──────────────────────────────────────────────────────

  function bulkImportDirectMembers({ gymId, rawText, defaultPassType, defaultAmount }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    const parseResult = parseCsvImport(rawText);
    if (!parseResult.ok) return parseResult;

    const imported = [];
    const importErrors = parseResult.errors;

    for (const record of parseResult.parsed) {
      const passType = record.passType || defaultPassType || DIRECT_MEMBER_PASS_TYPES.MONTHLY;
      if (!Object.values(DIRECT_MEMBER_PASS_TYPES).includes(passType)) {
        importErrors.push({ row: record.rowNumber, error: 'invalid_pass_type' });
        continue;
      }

      const member = {
        id: `dm_${randomUUID().slice(0, 8)}`,
        gymId,
        name: record.name || 'Unknown',
        phone: record.phone || null,
        email: record.email || null,
        passType,
        amount: record.amount || Number(defaultAmount) || 0,
        startDate: record.startDate || new Date().toISOString().split('T')[0],
        endDate: record.endDate || null,
        notes: `Imported via CSV — row ${record.rowNumber}`,
        createdAt: new Date().toISOString()
      };

      directMembers.insert(member);
      imported.push(member);
    }

    return {
      ok: true,
      imported: imported.length,
      errors: importErrors.length,
      errorDetails: importErrors,
      totalRows: parseResult.totalRows,
      members: imported
    };
  }

  // ─── Renewal Reminders ──────────────────────────────────────────────────────

  function getExpiringDirectMembers(gymId, { daysAhead = 7 } = {}) {
    const cutoff = new Date(Date.now() + daysAhead * 86_400_000);
    return directMembers.filter(m => {
      if (m.gymId !== gymId || !m.endDate) return false;
      const endDate = new Date(m.endDate);
      return endDate <= cutoff && endDate >= new Date();
    });
  }

  function sendRenewalReminder({ memberId, gymId }) {
    const member = directMembers.find(m => m.id === memberId && m.gymId === gymId);
    if (!member) return { ok: false, error: 'member_not_found' };
    if (!member.phone) return { ok: false, error: 'member_has_no_phone' };

    // In production, this would call the WhatsApp notification service
    // For now, just log and return success
    console.log(`[renewal] reminder sent to ${member.name} (${member.phone}) — pass expiring ${member.endDate}`);

    return {
      ok: true,
      memberId,
      memberName: member.name,
      phone: member.phone,
      passType: member.passType,
      endDate: member.endDate
    };
  }

  function bulkSendReminders(gymId, { daysAhead = 7 } = {}) {
    const expiring = getExpiringDirectMembers(gymId, { daysAhead });
    const results = [];
    for (const member of expiring) {
      if (member.phone) {
        const result = sendRenewalReminder({ memberId: member.id, gymId });
        results.push(result);
      }
    }
    return { ok: true, sent: results.length, results };
  }

  // ─── Staff Management & RBAC ────────────────────────────────────────────────

  function addStaff({ gymId, userId, name, role, permissions, specialties }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    // Resolve permissions from role if no explicit permissions given
    let resolvedPermissions = permissions;
    if (!resolvedPermissions && role && STAFF_ROLES[role]) {
      resolvedPermissions = STAFF_ROLES[role].permissions;
    }
    if (!resolvedPermissions) {
      resolvedPermissions = [STAFF_PERMISSIONS.MANAGE_CHECKIN]; // default minimal
    }

    // Validate permissions
    const invalid = resolvedPermissions.filter(p => !ALL_PERMISSIONS.includes(p));
    if (invalid.length) return { ok: false, error: `invalid_permissions: ${invalid.join(', ')}` };

    const staff = {
      id: `stf_${randomUUID().slice(0, 8)}`,
      gymId,
      userId: userId || null,
      name: name || 'Staff Member',
      role: role || 'receptionist',
      roleLabel: STAFF_ROLES[role]?.label || 'Custom',
      permissions: resolvedPermissions,
      specialties: specialties || [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    gymStaff.insert(staff);
    return { ok: true, staff };
  }

  function updateStaff(staffId, gymId, updates) {
    const staff = gymStaff.find(s => s.id === staffId && s.gymId === gymId);
    if (!staff) return { ok: false, error: 'staff_not_found' };

    const allowed = ['name', 'role', 'specialties', 'status'];
    const patch = {};

    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }

    // If role is being updated, update permissions too (unless explicit permissions given)
    if (updates.role && STAFF_ROLES[updates.role] && updates.permissions === undefined) {
      patch.permissions = STAFF_ROLES[updates.role].permissions;
      patch.roleLabel = STAFF_ROLES[updates.role].label;
    }

    // Explicit permission override
    if (updates.permissions !== undefined) {
      const invalid = updates.permissions.filter(p => !ALL_PERMISSIONS.includes(p));
      if (invalid.length) return { ok: false, error: `invalid_permissions: ${invalid.join(', ')}` };
      patch.permissions = updates.permissions;
    }

    patch.updatedAt = new Date().toISOString();

    const updated = gymStaff.update(s => s.id === staffId, patch);
    return { ok: true, staff: updated };
  }

  function removeStaff(staffId, gymId) {
    const staff = gymStaff.find(s => s.id === staffId && s.gymId === gymId);
    if (!staff) return { ok: false, error: 'staff_not_found' };
    gymStaff.remove(s => s.id === staffId);
    return { ok: true };
  }

  function listStaff(gymId) {
    return gymStaff
      .filter(s => s.gymId === gymId)
      .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  }

  function getStaffPermissions(staffId, gymId) {
    const staff = gymStaff.find(s => s.id === staffId && s.gymId === gymId);
    if (!staff) return null;
    return { staffId, permissions: staff.permissions, role: staff.role, roleLabel: staff.roleLabel };
  }

  function hasPermission(staffId, gymId, permission) {
    const staff = gymStaff.find(s => s.id === staffId && s.gymId === gymId);
    if (!staff) return false;
    if (staff.role === 'owner') return true; // owner has all permissions
    return staff.permissions.includes(permission);
  }

  // ─── Multi-Branch Support ──────────────────────────────────────────────────

  function addBranch({ ownerId, name, location, address, coordinates, phone, email }) {
    const branch = {
      id: `gym_${randomUUID().slice(0, 6)}`,
      ownerId,
      name,
      location,
      address: address || null,
      coordinates: coordinates || null,
      phone: phone || null,
      email: email || null,
      status: 'active',
      amenities: [],
      equipmentInventory: [],
      operatingHours: { ...DEFAULT_OPERATING_HOURS },
      passPricing: { daily: null, weekly: null, monthly: null },
      images: [],
      isBranch: true,
      createdAt: new Date().toISOString()
    };

    gyms.insert(branch);
    return { ok: true, branch };
  }

  function listBranches(ownerId) {
    return gyms.filter(g => g.ownerId === ownerId);
  }

  // ─── Facility Configuration ────────────────────────────────────────────────

  function updateFacilityConfig(gymId, { amenities, equipmentInventory, operatingHours, passPricing, images }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    const patch = {};
    if (amenities) {
      const valid = amenities.filter(a => AMENITIES.includes(a));
      patch.amenities = valid;
    }
    if (equipmentInventory) {
      const valid = equipmentInventory.filter(e => EQUIPMENT_INVENTORY.includes(e));
      patch.equipmentInventory = valid;
    }
    if (operatingHours) patch.operatingHours = operatingHours;
    if (passPricing) patch.passPricing = passPricing;
    if (images) patch.images = Array.isArray(images) ? images : [images];

    const updated = gyms.update(g => g.id === gymId, patch);
    return { ok: true, gym: updated };
  }

  // ─── Class Scheduling ──────────────────────────────────────────────────────

  function createClass({ gymId, name, trainer, dayOfWeek, startTime, endTime, capacity, description }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };
    if (!name) return { ok: false, error: 'class_name_required' };

    const gymClass = {
      id: `cls_${randomUUID().slice(0, 8)}`,
      gymId,
      name,
      trainer: trainer || null,
      dayOfWeek: dayOfWeek || null,  // Mon, Tue, Wed...
      startTime: startTime || null,
      endTime: endTime || null,
      capacity: Number(capacity) || 20,
      description: description || null,
      status: 'active',
      createdAt: new Date().toISOString()
    };

    gymClasses.insert(gymClass);
    return { ok: true, gymClass };
  }

  function listClasses(gymId) {
    return gymClasses.filter(c => c.gymId === gymId && c.status === 'active');
  }

  function updateClass(classId, gymId, updates) {
    const gymClass = gymClasses.find(c => c.id === classId && c.gymId === gymId);
    if (!gymClass) return { ok: false, error: 'class_not_found' };
    const allowed = ['name', 'trainer', 'dayOfWeek', 'startTime', 'endTime', 'capacity', 'description', 'status'];
    const patch = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }
    const updated = gymClasses.update(c => c.id === classId, patch);
    return { ok: true, gymClass: updated };
  }

  function deleteClass(classId, gymId) {
    const gymClass = gymClasses.find(c => c.id === classId && c.gymId === gymId);
    if (!gymClass) return { ok: false, error: 'class_not_found' };
    gymClasses.update(c => c.id === classId, { status: 'archived' });
    return { ok: true };
  }

  // ─── Custodial Delivery Station ──────────────────────────────────────────────
  // (Marketplace orders dispatched to this gym for member pickup)

  function getCustodyQueue(gymId) {
    if (!marketplaceOrders?.filter) return [];
    return marketplaceOrders
      .filter(o => o.pickupGymId === gymId &&
              ['dispatched', 'custody'].includes(o.status))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .map(o => ({
        orderId: o.id,
        collectionCode: o.collectionCode,
        status: o.status,
        memberName: null, // would look up from users
        items: (o.items || []).map(i => i.productName),
        createdAt: o.createdAt
      }));
  }

  function verifyCollectionCode(gymId, collectionCode) {
    if (!marketplaceOrders?.find) return { ok: false, error: 'order_not_found' };
    const order = marketplaceOrders.find(o =>
      o.collectionCode === collectionCode &&
      o.pickupGymId === gymId &&
      o.status === 'custody'
    );
    if (!order) return { ok: false, error: 'invalid_code_or_not_in_custody' };
    return { ok: true, orderId: order.id, collectionCode, memberName: null };
  }

  return {
    // Direct members
    addDirectMember, updateDirectMember, deleteDirectMember, listDirectMembers,
    // CSV import
    bulkImportDirectMembers,
    // Renewal reminders
    getExpiringDirectMembers, sendRenualReminder: sendRenewalReminder, bulkSendReminders,
    // Staff & RBAC
    addStaff, updateStaff, removeStaff, listStaff, getStaffPermissions, hasPermission,
    // Multi-branch
    addBranch, listBranches,
    // Facility config
    updateFacilityConfig,
    // Classes
    createClass, listClasses, updateClass, deleteClass,
    // Custodial delivery
    getCustodyQueue, verifyCollectionCode,
    // Constants
    _constants: {
      STAFF_PERMISSIONS, STAFF_ROLES, ALL_PERMISSIONS,
      DIRECT_MEMBER_PASS_TYPES, CSV_HEADER_MAP, parseCsvImport,
      AMENITIES, EQUIPMENT_INVENTORY, DEFAULT_OPERATING_HOURS
    }
  };
}
