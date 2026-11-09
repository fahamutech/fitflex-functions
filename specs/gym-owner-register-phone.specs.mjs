// Gym owner registration — the contact phone is unique per account type (runs against the CI database).
// A number already on another gym_operator account must answer 409 phone_in_use and save no gym.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gymOwnerRegister } from '../functions/owner-gyms.mjs';
import { gyms, users } from '../src/bootstrap/services.mjs';

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const local = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const gymBody = (name) => ({ name, location: 'Dar', tier: 'standard', ratePerDay: 15000, venueType: 'physical', status: 'active', accessMode: 'paid_visit' });

async function register(sub, body) {
  const out = res();
  await gymOwnerRegister.onRequest({ user: { sub, userType: 'gym_operator' }, body }, out);
  return out;
}

test('register with a phone already on another gym owner is a 409 and saves no gym', async () => {
  const phone = local();
  const first = uniq('own_a');
  const second = uniq('own_b');
  const ok = await register(first, { displayName: 'A', phone, gyms: [gymBody('A gym')] });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));

  const name = uniq('Clash gym');
  const clash = await register(second, { displayName: 'B', phone, gyms: [gymBody(name)] });
  assert.equal(clash.statusCode, 409, JSON.stringify(clash.body));
  assert.equal(clash.body.error, 'phone_in_use');
  assert.equal((await gyms.filterAsync(g => g.name === name)).length, 0);
});

test('same number in another format on the same account registers fine', async () => {
  const phone = local();
  const id = uniq('own_c');
  assert.equal((await register(id, { phone, gyms: [gymBody('C1')] })).statusCode, 200);
  const again = await register(id, { phone: `+255${phone.slice(1)}`, gyms: [gymBody('C2')] });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal((await users.findByIdAsync(id)).phone, phone);
});

test('unreadable phone is a 400', async () => {
  const out = await register(uniq('own_d'), { phone: 'abc', gyms: [gymBody('D')] });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.error, 'invalid_phone');
});
