// Unit tests for the gym owner B2B service (direct members, CSV import, staff RBAC, classes, custody).
// Run with: node --test specs/gym-owner.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymOwnerService } from '../src/services/gym-owner-service.mjs';
import {
  STAFF_PERMISSIONS, STAFF_ROLES, ALL_PERMISSIONS,
  DIRECT_MEMBER_PASS_TYPES, CSV_HEADER_MAP, parseCsvImport,
  AMENITIES, EQUIPMENT_INVENTORY
} from '../src/shared/gym-owner-constants.mjs';

function createStore() {
  const data = { users: [], gyms: [], checkins: [], direct_members: [], gym_staff: [], gym_classes: [], marketplace_orders: [], audit_log: [] };
  function collection(name) {
    return {
      _data: data[name], all: () => data[name], find: p => data[name].find(p),
      filter: p => data[name].filter(p), some: p => data[name].some(p),
      insert: r => { data[name].push(r); return r; },
      update: (p, patch) => { const i = data[name].findIndex(p); if (i >= 0) data[name][i] = { ...data[name][i], ...patch }; return data[name].find(p); },
      remove: p => { const i = data[name].findIndex(p); if (i >= 0) return data[name].splice(i, 1)[0]; return null; }
    };
  }
  return { data, collection };
}

function setup() {
  const { data, collection } = createStore();
  data.users = [{ id: 'usr_op', userType: 'gym_operator', gymId: 'gym_001', displayName: 'Operator' }];
  data.gyms = [{ id: 'gym_001', name: 'Power Gym', status: 'active', ownerId: 'usr_op' }];
  data.marketplace_orders = [{ id: 'ord_001', pickupGymId: 'gym_001', status: 'custody', collectionCode: 'FF-COL-7489', items: [{ productName: 'Whey Protein' }], createdAt: '2026-09-01T10:00:00.000Z' }];
  const svc = createGymOwnerService({
    users: collection('users'), gyms: collection('gyms'), checkins: collection('checkins'),
    directMembers: collection('direct_members'), gymStaff: collection('gym_staff'),
    gymClasses: collection('gym_classes'), marketplaceOrders: collection('marketplace_orders'),
    auditLog: collection('audit_log')
  });
  return { data, svc };
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECT MEMBERS
// ═══════════════════════════════════════════════════════════════════════════
test('Add direct member', () => {
  const { svc } = setup();
  const r = svc.addDirectMember({ gymId: 'gym_001', name: 'Juma', phone: '+255712345678', passType: 'monthly', amount: 80000 });
  assert.ok(r.ok);
  assert.equal(r.member.name, 'Juma');
  assert.equal(r.member.passType, 'monthly');
});

test('Cannot add direct member to non-existent gym', () => {
  const { svc } = setup();
  assert.ok(!svc.addDirectMember({ gymId: 'gym_x', name: 'Juma', passType: 'monthly' }).ok);
});

test('Cannot add direct member with invalid pass type', () => {
  const { svc } = setup();
  assert.ok(!svc.addDirectMember({ gymId: 'gym_001', name: 'Juma', passType: 'lifetime' }).ok);
});

test('List direct members with search', () => {
  const { svc } = setup();
  svc.addDirectMember({ gymId: 'gym_001', name: 'Juma Hassan', passType: 'monthly' });
  svc.addDirectMember({ gymId: 'gym_001', name: 'Asha Mwakyi', passType: 'weekly' });
  const results = svc.listDirectMembers('gym_001', { search: 'juma' });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Juma Hassan');
});

test('List direct members by pass type', () => {
  const { svc } = setup();
  svc.addDirectMember({ gymId: 'gym_001', name: 'J1', passType: 'monthly' });
  svc.addDirectMember({ gymId: 'gym_001', name: 'A1', passType: 'weekly' });
  const results = svc.listDirectMembers('gym_001', { passType: 'weekly' });
  assert.equal(results.length, 1);
});

test('Update and delete direct member', () => {
  const { svc } = setup();
  const { member } = svc.addDirectMember({ gymId: 'gym_001', name: 'Juma', passType: 'monthly' });
  const updated = svc.updateDirectMember(member.id, 'gym_001', { name: 'Juma H.' });
  assert.ok(updated.ok);
  assert.equal(updated.member.name, 'Juma H.');
  const deleted = svc.deleteDirectMember(member.id, 'gym_001');
  assert.ok(deleted.ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// CSV IMPORT
// ═══════════════════════════════════════════════════════════════════════════
test('CSV import: parses English headers', () => {
  const { svc } = setup();
  const csv = 'name,phone,passType,amount,startDate\nJuma Hassan,+255712345678,monthly,80000,2026-09-01\nAsha,+255712111222,weekly,25000,2026-09-10';
  const r = svc.bulkImportDirectMembers({ gymId: 'gym_001', rawText: csv });
  assert.ok(r.ok);
  assert.equal(r.imported, 2);
  assert.equal(r.errors, 0);
});

test('CSV import: parses Swahili headers', () => {
  const { svc } = setup();
  const csv = 'jina,simu,kifurushi,bei\nJuma,+255712345678,mwezi,80000';
  const r = svc.bulkImportDirectMembers({ gymId: 'gym_001', rawText: csv });
  assert.ok(r.ok);
  assert.equal(r.imported, 1);
  assert.equal(r.members[0].name, 'Juma');
  assert.equal(r.members[0].passType, 'monthly'); // mwezi → monthly
});

test('CSV import: handles tab-separated (Excel paste)', () => {
  const { svc } = setup();
  const tsv = 'name\tphone\tpassType\nJuma\t+255712345678\tmonthly';
  const r = svc.bulkImportDirectMembers({ gymId: 'gym_001', rawText: tsv });
  assert.ok(r.ok);
  assert.equal(r.imported, 1);
});

test('CSV import: skips rows without name or phone', () => {
  const { svc } = setup();
  const csv = 'name,phone\nJuma,+255712345678\n,';
  const r = svc.bulkImportDirectMembers({ gymId: 'gym_001', rawText: csv });
  assert.ok(r.ok);
  assert.equal(r.imported, 1);
  assert.equal(r.errors, 1); // second row skipped
});

// ═══════════════════════════════════════════════════════════════════════════
// STAFF & RBAC
// ═══════════════════════════════════════════════════════════════════════════
test('Add staff with role-based permissions', () => {
  const { svc } = setup();
  const r = svc.addStaff({ gymId: 'gym_001', name: 'Jane', role: 'receptionist' });
  assert.ok(r.ok);
  assert.equal(r.staff.role, 'receptionist');
  assert.ok(r.staff.permissions.includes(STAFF_PERMISSIONS.MANAGE_CHECKIN));
  assert.ok(r.staff.permissions.includes(STAFF_PERMISSIONS.MANAGE_GYM_SHOP));
  assert.ok(!r.staff.permissions.includes(STAFF_PERMISSIONS.ACCESS_FINANCIALS));
});

test('Owner role has all permissions', () => {
  const { svc } = setup();
  const r = svc.addStaff({ gymId: 'gym_001', name: 'Boss', role: 'owner' });
  assert.equal(r.staff.permissions.length, ALL_PERMISSIONS.length);
});

test('Custom permissions override role defaults', () => {
  const { svc } = setup();
  const r = svc.addStaff({
    gymId: 'gym_001', name: 'Custom',
    permissions: [STAFF_PERMISSIONS.MANAGE_CHECKIN, STAFF_PERMISSIONS.ACCESS_FINANCIALS]
  });
  assert.equal(r.staff.permissions.length, 2);
});

test('Invalid permissions rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.addStaff({ gymId: 'gym_001', name: 'X', permissions: ['invalid_perm'] }).ok);
});

test('hasPermission: owner has all, receptionist has limited', () => {
  const { svc } = setup();
  const owner = svc.addStaff({ gymId: 'gym_001', name: 'Owner', role: 'owner' });
  const recep = svc.addStaff({ gymId: 'gym_001', name: 'Recep', role: 'receptionist' });
  assert.ok(svc.hasPermission(owner.staff.id, 'gym_001', STAFF_PERMISSIONS.ACCESS_FINANCIALS));
  assert.ok(!svc.hasPermission(recep.staff.id, 'gym_001', STAFF_PERMISSIONS.ACCESS_FINANCIALS));
  assert.ok(svc.hasPermission(recep.staff.id, 'gym_001', STAFF_PERMISSIONS.MANAGE_CHECKIN));
});

test('Update staff role updates permissions', () => {
  const { svc } = setup();
  const { staff } = svc.addStaff({ gymId: 'gym_001', name: 'J1', role: 'receptionist' });
  const r = svc.updateStaff(staff.id, 'gym_001', { role: 'manager' });
  assert.ok(r.ok);
  assert.ok(r.staff.permissions.includes(STAFF_PERMISSIONS.ACCESS_FINANCIALS));
});

test('Remove staff', () => {
  const { svc } = setup();
  const { staff } = svc.addStaff({ gymId: 'gym_001', name: 'Temp', role: 'trainer' });
  assert.ok(svc.removeStaff(staff.id, 'gym_001').ok);
  assert.equal(svc.listStaff('gym_001').filter(s => s.id === staff.id).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CLASSES
// ═══════════════════════════════════════════════════════════════════════════
test('Create and list classes', () => {
  const { svc } = setup();
  svc.createClass({ gymId: 'gym_001', name: 'Zumba Fiesta', trainer: 'Jane', dayOfWeek: 'Mon', startTime: '07:00', capacity: 25 });
  svc.createClass({ gymId: 'gym_001', name: 'CrossFit', trainer: 'John', dayOfWeek: 'Wed', capacity: 15 });
  const list = svc.listClasses('gym_001');
  assert.equal(list.length, 2);
});

test('Delete class archives it', () => {
  const { svc } = setup();
  const { gymClass } = svc.createClass({ gymId: 'gym_001', name: 'Yoga' });
  svc.deleteClass(gymClass.id, 'gym_001');
  assert.equal(svc.listClasses('gym_001').length, 0); // archived = not in active list
});

// ═══════════════════════════════════════════════════════════════════════════
// CUSTODIAL DELIVERY
// ═══════════════════════════════════════════════════════════════════════════
test('Custody queue shows dispatched/custody orders for this gym', () => {
  const { svc } = setup();
  const queue = svc.getCustodyQueue('gym_001');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].collectionCode, 'FF-COL-7489');
});

test('Verify collection code for this gym', () => {
  const { svc } = setup();
  const r = svc.verifyCollectionCode('gym_001', 'FF-COL-7489');
  assert.ok(r.ok);
  assert.equal(r.orderId, 'ord_001');
});

test('Invalid collection code rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.verifyCollectionCode('gym_001', 'FF-COL-XXXX').ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// FACILITY CONFIG
// ═══════════════════════════════════════════════════════════════════════════
test('Update facility config — amenities and equipment', () => {
  const { svc } = setup();
  const r = svc.updateFacilityConfig('gym_001', {
    amenities: ['showers', 'air_conditioning', 'free_wifi'],
    equipmentInventory: ['cardio_treadmills', 'squat_racks'],
    passPricing: { daily: 5000, weekly: 25000, monthly: 80000 }
  });
  assert.ok(r.ok);
  assert.equal(r.gym.amenities.length, 3);
  assert.equal(r.gym.equipmentInventory.length, 2);
});

test('Invalid amenities are filtered out', () => {
  const { svc } = setup();
  const r = svc.updateFacilityConfig('gym_001', {
    amenities: ['showers', 'invalid_amenity', 'pool']
  });
  assert.ok(r.ok);
  assert.equal(r.gym.amenities.length, 2); // 'invalid_amenity' filtered
});

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-BRANCH
// ═══════════════════════════════════════════════════════════════════════════
test('Add and list branches', () => {
  const { svc } = setup();
  svc.addBranch({ ownerId: 'usr_op', name: 'Power Gym City Centre', location: 'DSM CBD' });
  const branches = svc.listBranches('usr_op');
  assert.ok(branches.length >= 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// RENEWAL REMINDERS
// ═══════════════════════════════════════════════════════════════════════════
test('Send renewal reminder to member with phone', () => {
  const { svc } = setup();
  const { member } = svc.addDirectMember({
    gymId: 'gym_001', name: 'Juma', phone: '+255712345678',
    passType: 'monthly', endDate: '2026-09-20'
  });
  const r = svc.sendRenualReminder({ memberId: member.id, gymId: 'gym_001' });
  assert.ok(r.ok);
  assert.equal(r.memberName, 'Juma');
});

test('Cannot send reminder to member without phone', () => {
  const { svc } = setup();
  const { member } = svc.addDirectMember({ gymId: 'gym_001', name: 'NoPhone', passType: 'monthly' });
  const r = svc.sendRenualReminder({ memberId: member.id, gymId: 'gym_001' });
  assert.ok(!r.ok);
  assert.equal(r.error, 'member_has_no_phone');
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
test('Staff roles have correct permission counts', () => {
  assert.equal(STAFF_ROLES.owner.permissions.length, ALL_PERMISSIONS.length);
  assert.ok(STAFF_ROLES.manager.permissions.length < ALL_PERMISSIONS.length);
  assert.ok(STAFF_ROLES.receptionist.permissions.length < STAFF_ROLES.manager.permissions.length);
  assert.equal(STAFF_ROLES.trainer.permissions.length, 1); // only MANAGE_CHECKIN
});

test('CSV header map supports both English and Swahili', () => {
  assert.equal(CSV_HEADER_MAP['jina'], 'name');
  assert.equal(CSV_HEADER_MAP['simu'], 'phone');
  assert.equal(CSV_HEADER_MAP['kifurushi'], 'passType');
  assert.equal(CSV_HEADER_MAP['name'], 'name');
  assert.equal(CSV_HEADER_MAP['phone'], 'phone');
});

test('parseCsvImport standalone function', () => {
  const r = parseCsvImport('name,phone\nJuma,+255712345678');
  assert.ok(r.ok);
  assert.equal(r.parsed.length, 1);
  assert.equal(r.parsed[0].name, 'Juma');
});
