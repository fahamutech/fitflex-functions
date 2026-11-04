// Vendor smart import V1 — the `import` staff permission: migration backfill (vendorRole admin only), reversibility,
// and STAFF_PERMISSIONS (AUTH-ADJACENT: new vendor admin staff and the permission list in GET /vendor/me carry it).
// Against the CI database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService } from '../src/bootstrap/services.mjs';
import { STAFF_PERMISSIONS } from '../src/services/shop-service.mjs';
import { vendorCreateStaff } from '../functions/shop.mjs';
import { sign } from '../src/auth/jwt.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270203090000-vendor-import.cjs');
await ensureInit();
const dbName = (await db.raw('select current_database() as n')).rows[0].n;
assert.match(dbName, /^fitflex_ci(_[A-Za-z0-9]+)*$/, `refusing to run against ${dbName}`);

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], persons: [] };
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Backfill ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
after(async () => {
  await db('Invitation').whereIn('vendorId', made.users).del();
  await db('OrgMembership').whereIn('vendorId', made.users).del();
  await db('Vendor').whereIn('id', made.users).del();
  await db('Person').whereIn('id', made.persons).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

test('STAFF_PERMISSIONS carries `import`; a new vendor admin gets every permission, other roles only what they are given', async () => {
  assert.equal(STAFF_PERMISSIONS.has('import'), true);
  assert.deepEqual([...STAFF_PERMISSIONS], ['products', 'orders', 'sales', 'customers', 'reports', 'payments', 'staff', 'import']);
  const v = await user('vendor');
  const mk = async (role, permissions) => {
    const out = await shopService.createVendorStaff({ vendorId: v, body: { name: 'S', email: `${uid('s')}@example.com`, phone: `07${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, password: 'Secret123!', role, permissions } });
    assert.equal(out.status, 201, JSON.stringify(out));
    made.users.push(out.staff.id);
    return out.staff;
  };
  const admin = await mk('admin');
  assert.deepEqual([...admin.vendorPermissions].sort(), ['customers', 'import', 'orders', 'payments', 'products', 'reports', 'sales', 'staff']);
  const inventory = await mk('inventory_manager', ['products', 'import', 'bogus']);
  assert.deepEqual([...inventory.vendorPermissions].sort(), ['import', 'products'], 'unknown permissions are dropped, `import` may be granted by an admin');
  const plain = await mk('inventory_manager', ['products']);
  assert.equal(plain.vendorPermissions.includes('import'), false);
  assert.equal(await shopService.authorizeStaff({ sub: inventory.id, userType: 'vendor_staff', vendorId: v }, 'import'), true);
  assert.equal(await shopService.authorizeStaff({ sub: plain.id, userType: 'vendor_staff', vendorId: v }, 'import'), false);
  const me = await shopService.vendorMe({ sub: inventory.id, userType: 'vendor_staff', vendorId: v });
  assert.deepEqual(me.permissions.sort(), ['import', 'products']);
  assert.ok((await shopService.vendorMe({ sub: v, userType: 'vendor' })).permissions.includes('import'), 'the vendor account has every permission');
  assert.equal(typeof vendorCreateStaff.onRequest, 'function');
  assert.ok(sign);
});

test('backfill: vendorRole admin staff, their membership and pending admin invitations get `import`; other roles do not; repeatable', async () => {
  const v = await user('vendor');
  const admin = await user('vendor_staff', { vendorId: v, vendorRole: 'admin', accountStatus: 'active', vendorPermissions: ['products', 'staff'] });
  const seller = await user('vendor_staff', { vendorId: v, vendorRole: 'sales', accountStatus: 'active', vendorPermissions: ['sales'] });
  const noPerms = await user('vendor_staff', { vendorId: v, vendorRole: 'admin', accountStatus: 'active' });
  await db('Vendor').insert({ id: v, name: 'Backfill Shop', status: 'active' }).onConflict('id').ignore();
  const person = uid('per');
  made.persons.push(person);
  await db('Person').insert({ id: person });
  await db('OrgMembership').insert({ id: uid('om'), personId: person, personaId: admin, orgType: 'vendor', vendorId: v, role: 'staff', status: 'active', aclPermissions: ['products'] });
  const inviteFor = role => ({
    id: uid('inv'), orgType: 'vendor', vendorId: v, role: 'staff', identifierType: 'email', identifierValue: `${uid('i')}@example.com`,
    tokenHash: randomUUID(), status: 'pending', aclPermissions: ['orders'], payload: JSON.stringify({ vendorRole: role }), invitedBy: v,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const adminInvite = inviteFor('admin');
  const salesInvite = inviteFor('sales');
  await db('Invitation').insert([adminInvite, salesInvite]);
  await migration.addImportPermission(db);
  const second = await migration.addImportPermission(db);
  assert.deepEqual(second, { users: 0, memberships: 0, invitations: 0 }, 'safe to repeat');
  const perms = async id => (await db('User').where({ id }).first()).vendorPermissions;
  assert.deepEqual(await perms(admin), ['products', 'staff', 'import']);
  assert.deepEqual(await perms(noPerms), ['import']);
  assert.deepEqual(await perms(seller), ['sales'], 'other roles are not given it');
  assert.deepEqual((await db('OrgMembership').where({ personaId: admin }).first()).aclPermissions, ['products', 'import']);
  assert.deepEqual((await db('Invitation').where({ id: adminInvite.id }).first()).aclPermissions, ['orders', 'import']);
  assert.deepEqual((await db('Invitation').where({ id: salesInvite.id }).first()).aclPermissions, ['orders']);
  // reversible: down removes the permission and the tables, up brings both back
  await migration.down(db);
  assert.deepEqual(await perms(admin), ['products', 'staff']);
  assert.deepEqual(await perms(noPerms), []);
  assert.deepEqual((await db('OrgMembership').where({ personaId: admin }).first()).aclPermissions, ['products']);
  assert.deepEqual((await db('Invitation').where({ id: adminInvite.id }).first()).aclPermissions, ['orders']);
  assert.equal(await db.schema.hasTable('VendorImportBatch'), false);
  assert.equal(await db.schema.hasTable('VendorImportRow'), false);
  await migration.up(db);
  assert.equal(await db.schema.hasTable('VendorImportBatch'), true);
  assert.equal(await db.schema.hasTable('VendorImportRow'), true);
  assert.deepEqual(await perms(admin), ['products', 'staff', 'import']);
});

test('tables: the file lock is unique per vendor while a batch is open; checks refuse bad statuses and long file names', async () => {
  const v = await user('vendor');
  const base = { vendorId: v, createdBy: v, entity: 'products', filename: 'a.csv', sizeBytes: 1, delimiter: ',' };
  const id = n => `vib_t${n}_${v.slice(-6)}`;
  await db('VendorImportBatch').insert({ ...base, id: id(1), fileSha256: 'same', status: 'ready' });
  await assert.rejects(db('VendorImportBatch').insert({ ...base, id: id(2), fileSha256: 'same', status: 'ready' }), /vendorimportbatch_vendor_sha_live/);
  // the file lock covers OPEN batches only: once a batch ends (discarded, applied, partial) the same file may come again
  for (const ended of ['discarded', 'applied', 'partial']) {
    await db('VendorImportBatch').where({ id: id(1) }).update({ status: ended });
    await db('VendorImportBatch').insert({ ...base, id: id(9), fileSha256: 'same', status: 'mapping_required' });
    await db('VendorImportBatch').where({ id: id(9) }).del();
  }
  await db('VendorImportBatch').where({ id: id(1) }).update({ status: 'discarded' });
  await db('VendorImportBatch').insert({ ...base, id: id(2), fileSha256: 'same', status: 'ready' });
  await assert.rejects(db('VendorImportBatch').where({ id: id(1) }).update({ status: 'applying' }), /vendorimportbatch_vendor_sha_live/, 'an ended batch cannot re-enter flight while the file is open elsewhere');
  await db('VendorImportBatch').insert({ ...base, id: id(3), vendorId: `${v}_other`, fileSha256: 'same', status: 'ready' });
  await assert.rejects(db('VendorImportBatch').insert({ ...base, id: id(4), fileSha256: 'x', status: 'bogus' }), /vendorimportbatch_status_check/);
  await assert.rejects(db('VendorImportBatch').insert({ ...base, id: id(5), fileSha256: 'y', status: 'ready', filename: 'x'.repeat(121) }), /vendorimportbatch_filename_length/);
  await assert.rejects(db('VendorImportBatch').insert({ ...base, id: id(6), fileSha256: 'z', status: 'ready', entity: 'orders' }), /vendorimportbatch_entity_check/);
  await db('VendorImportRow').insert({ id: `vir_t_${v.slice(-6)}`, batchId: id(2), vendorId: v, rowNo: 2, entity: 'products' });
  await assert.rejects(db('VendorImportRow').insert({ id: `vir_u_${v.slice(-6)}`, batchId: id(2), vendorId: v, rowNo: 2, entity: 'products' }), /VendorImportRow_batchId_rowNo_unique|duplicate key/);
  await assert.rejects(db('VendorImportRow').insert({ id: `vir_w_${v.slice(-6)}`, batchId: id(2), vendorId: v, rowNo: 3, entity: 'products', applyState: 'bogus' }), /vendorimportrow_apply_state_check/);
  await db('VendorImportBatch').whereIn('id', [id(1), id(2), id(3)]).del();
  assert.equal(await db('VendorImportRow').where({ batchId: id(2) }).first(), undefined, 'rows go with their batch');
});
