// FitFlex Af — Gym Owner B2B REST Endpoints
//
//   - Direct member management (CRUD + CSV import)
//   - Staff management with RBAC (add/update/remove/list, permission check)
//   - Multi-branch (add/list)
//   - Facility config (amenities, equipment, hours, pricing, images)
//   - Class scheduling (create/list/update/delete)
//   - Custodial delivery station (queue + verify collection code)
//   - Renewal reminders (single + bulk)
//
// To wire into index.mjs:
//   import { initGymOwnerEndpoints } from './gym-owner-endpoints.mjs';
//   initGymOwnerEndpoints({ collection, requireAuth, auditLog, users, gyms, checkins, marketplaceOrders });

import { randomUUID } from 'node:crypto';
import { createGymOwnerService } from '../src/services/gym-owner-service.mjs';
import { STAFF_PERMISSIONS, STAFF_ROLES, DIRECT_MEMBER_PASS_TYPES } from '../src/shared/gym-owner-constants.mjs';

let svc = null;
let requireAuth = null;
let auditLog = null;
let users = null;
let gyms = null;
let checkins = null;
let marketplaceOrders = null;

export function initGymOwnerEndpoints({ collection, requireAuth: ra, auditLog: al, users: u, gyms: g, checkins: c, marketplaceOrders: mo }) {
  svc = createGymOwnerService({
    users: u,
    gyms: g,
    checkins: c,
    directMembers: collection('direct_members'),
    gymStaff: collection('gym_staff'),
    gymClasses: collection('gym_classes'),
    marketplaceOrders: mo,
    auditLog: al
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
  gyms = g;
  checkins = c;
  marketplaceOrders = mo;
}

const created = new Date().toISOString();

function getOperatorGymId(req) {
  const operator = users?.find(u => u.id === req.user.sub);
  return operator?.gymId || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECT MEMBERS
// ═══════════════════════════════════════════════════════════════════════════
export const listDirectMembers = {
  created, method: 'get', path: '/operator/direct-members',
  description: 'Gym operator: list direct (walk-in) members. ?search=, ?passType=, ?expiringWithin=7',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const { search, passType, expiringWithin, limit } = req.query || {};
    const list = svc.listDirectMembers(gymId, {
      search, passType,
      expiringWithin: expiringWithin ? Number(expiringWithin) : undefined,
      limit: limit ? Number(limit) : 100
    });
    res.json(list);
  }
};

export const addDirectMember = {
  created, method: 'post', path: '/operator/direct-members',
  description: 'Gym operator: add a direct (walk-in) member.',
  requestSample: { name: 'Juma Hassan', phone: '+255712345678', passType: 'monthly', amount: 80000 },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.addDirectMember({ gymId, ...req.body || {} });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const updateDirectMember = {
  created, method: 'put', path: '/operator/direct-members/:id',
  description: 'Gym operator: update a direct member.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.updateDirectMember(req.params.id, gymId, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const deleteDirectMember = {
  created, method: 'delete', path: '/operator/direct-members/:id',
  description: 'Gym operator: remove a direct member.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.deleteDirectMember(req.params.id, gymId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CSV BULK IMPORT
// ═══════════════════════════════════════════════════════════════════════════
export const bulkImportDirectMembers = {
  created, method: 'post', path: '/operator/direct-members/bulk-import',
  description: 'Gym operator: bulk import direct members from CSV or Excel paste. Supports EN + SW headers.',
  requestSample: {
    rawText: 'name,phone,passType,amount,startDate\\nJuma Hassan,+255712345678,monthly,80000,2026-09-01\\nAsha Jina,+255712111222,weekly,25000,2026-09-10',
    defaultPassType: 'monthly',
    defaultAmount: 80000
  },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const { rawText, defaultPassType, defaultAmount } = req.body || {};
    if (!rawText) return res.status(400).json({ error: 'rawText_required' });
    const result = svc.bulkImportDirectMembers({ gymId, rawText, defaultPassType, defaultAmount });
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// RENEWAL REMINDERS
// ═══════════════════════════════════════════════════════════════════════════
export const sendRenewalReminder = {
  created, method: 'post', path: '/operator/direct-members/:id/renewal-reminder',
  description: 'Gym operator: send a renewal reminder SMS/WhatsApp to a direct member.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.sendRenualReminder({ memberId: req.params.id, gymId });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const bulkRenewalReminders = {
  created, method: 'post', path: '/operator/direct-members/bulk-reminders',
  description: 'Gym operator: send renewal reminders to all expiring members (default: within 7 days).',
  requestSample: { daysAhead: 7 },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const { daysAhead } = req.body || {};
    const result = svc.bulkSendReminders(gymId, { daysAhead: daysAhead || 7 });
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// STAFF MANAGEMENT & RBAC
// ═══════════════════════════════════════════════════════════════════════════
export const listStaff = {
  created, method: 'get', path: '/operator/staff',
  description: 'Gym operator: list all staff with roles and permissions.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    res.json(svc.listStaff(gymId));
  }
};

export const addStaff = {
  created, method: 'post', path: '/operator/staff',
  description: 'Gym operator: add a staff member with role and permissions.',
  requestSample: { name: 'Jane Receptionist', role: 'receptionist', specialties: ['Zumba'] },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.addStaff({ gymId, ...req.body || {} });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const updateStaff = {
  created, method: 'put', path: '/operator/staff/:id',
  description: 'Gym operator: update a staff member (role, permissions, specialties, status).',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.updateStaff(req.params.id, gymId, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const removeStaff = {
  created, method: 'delete', path: '/operator/staff/:id',
  description: 'Gym operator: remove a staff member.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.removeStaff(req.params.id, gymId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const staffRolesReference = {
  created, method: 'get', path: '/operator/staff/roles',
  description: 'Gym operator: list available staff roles and their default permissions.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (_, res) => {
    res.json(Object.entries(STAFF_ROLES).map(([id, cfg]) => ({ id, ...cfg })));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-BRANCH
// ═══════════════════════════════════════════════════════════════════════════
export const listBranches = {
  created, method: 'get', path: '/operator/branches',
  description: 'Gym operator: list all gym branches owned by this operator.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    res.json(svc.listBranches(req.user.sub));
  }
};

export const addBranch = {
  created, method: 'post', path: '/operator/branches',
  description: 'Gym operator: add a new gym branch.',
  requestSample: { name: 'Power Gym City Centre', location: 'Dar es Salaam CBD', address: 'Msimbazi St, DSM' },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const result = svc.addBranch({ ownerId: req.user.sub, ...req.body || {} });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// FACILITY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
export const updateFacilityConfig = {
  created, method: 'put', path: '/operator/facility',
  description: 'Gym operator: update facility config (amenities, equipment, hours, pass pricing, images).',
  requestSample: {
    amenities: ['showers', 'air_conditioning', 'free_wifi', 'lockers'],
    equipmentInventory: ['cardio_treadmills', 'squat_racks', 'free_weights_dumbbells'],
    operatingHours: { weekday: { open: '06:00', close: '22:00' }, weekend: { open: '07:00', close: '21:00' } },
    passPricing: { daily: 5000, weekly: 25000, monthly: 80000 }
  },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.updateFacilityConfig(gymId, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const facilityAmenitiesList = {
  created, method: 'get', path: '/operator/facility/amenities',
  description: 'Gym operator: list all toggleable amenities for facility config UI.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (_, res) => {
    res.json({ amenities: require('../src/shared/gym-owner-constants.mjs').AMENITIES });
  }
};

export const facilityEquipmentList = {
  created, method: 'get', path: '/operator/facility/equipment',
  description: 'Gym operator: list all equipment inventory keys for facility config UI.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (_, res) => {
    res.json({ equipment: require('../src/shared/gym-owner-constants.mjs').EQUIPMENT_INVENTORY });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CLASS SCHEDULING
// ═══════════════════════════════════════════════════════════════════════════
export const listClasses = {
  created, method: 'get', path: '/operator/classes',
  description: 'Gym operator: list all active group fitness classes.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    res.json(svc.listClasses(gymId));
  }
};

export const createClass = {
  created, method: 'post', path: '/operator/classes',
  description: 'Gym operator: create a group fitness class.',
  requestSample: { name: 'Zumba Fiesta', trainer: 'Jane Smith', dayOfWeek: 'Mon', startTime: '07:00', endTime: '08:30', capacity: 25 },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.createClass({ gymId, ...req.body || {} });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const updateClass = {
  created, method: 'put', path: '/operator/classes/:id',
  description: 'Gym operator: update a group fitness class.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.updateClass(req.params.id, gymId, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const deleteClass = {
  created, method: 'delete', path: '/operator/classes/:id',
  description: 'Gym operator: archive a group fitness class.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const result = svc.deleteClass(req.params.id, gymId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CUSTODIAL DELIVERY STATION
// ═══════════════════════════════════════════════════════════════════════════
export const custodyQueue = {
  created, method: 'get', path: '/operator/custody-queue',
  description: 'Gym operator: list marketplace packages dispatched to or held at this gym.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    res.json(svc.getCustodyQueue(gymId));
  }
};

export const custodyVerifyCode = {
  created, method: 'post', path: '/operator/custody-verify',
  description: 'Gym operator: verify a collection code and look up the order for handover.',
  requestSample: { collectionCode: 'FF-COL-7489' },
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const gymId = getOperatorGymId(req);
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const { collectionCode } = req.body || {};
    if (!collectionCode) return res.status(400).json({ error: 'collectionCode_required' });
    const result = svc.verifyCollectionCode(gymId, collectionCode);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};
