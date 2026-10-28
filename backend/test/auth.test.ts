import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, expectedStatus, TEST_PASSWORD, type Harness } from './helpers.ts';

let harness: Harness;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test('unauthenticated requests are rejected', async () => {
  const response = await fetch(`${harness.baseUrl}/api/auth/me`);
  assert.equal(response.status, 401);
});

test('login rejects a wrong password and writes an audit event', async () => {
  const response = await fetch(`${harness.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@aaradhya.local', password: 'wrong-password' }),
  });
  assert.equal(response.status, 401);
  const audit = harness.db
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'AUTH_LOGIN_FAILED'")
    .get() as { n: number };
  assert.ok(Number(audit.n) >= 1);
});

test('valid login returns a session and the current user', async () => {
  const client = await harness.client('picker@aaradhya.local');
  const me = await client.get('/api/auth/me');
  expectedStatus(me, 200);
  assert.equal(me.body.data.user.email, 'picker@aaradhya.local');
  assert.equal(me.body.data.user.role, 'PICKER');
  assert.ok(me.body.data.user.permissions.includes('picking.execute'));
  assert.ok(!me.body.data.user.permissions.includes('inventory.adjust'));
});

test('permission denial is enforced on the backend and audited', async () => {
  const viewer = await harness.client('viewer@aaradhya.local');
  const response = await viewer.post(
    '/api/products',
    { name: 'Forbidden Product', baseUom: 'PIECE' },
    'perm-test-key-0001',
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.equal(
    harness.db.prepare("SELECT COUNT(*) AS n FROM products WHERE name = 'Forbidden Product'").get()!.n,
    0,
  );
  const denied = harness.db
    .prepare(
      `SELECT * FROM audit_events
        WHERE event_type = 'PERMISSION_DENIED'
          AND actor_user_id = (SELECT id FROM users WHERE email = 'viewer@aaradhya.local')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as Record<string, any> | undefined;
  assert.ok(denied);
  assert.equal(denied.actor_role, 'VIEWER');
  assert.equal(denied.outcome, 'FAILURE');
  assert.match(String(denied.refs_json), /product\.manage/);
  expectedStatus(await viewer.get('/api/products'), 200, 'permitted read');
});

test('logout revokes the session', async () => {
  const client = await harness.client('picker@aaradhya.local');
  const logout = await client.post('/api/auth/logout');
  expectedStatus(logout, 200);
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('bootstrap is idempotent and does not overwrite passwords', async () => {
  const before = harness.db.prepare("SELECT password_hash FROM users WHERE email = 'admin@aaradhya.local'").get() as {
    password_hash: string;
  };
  const { bootstrapSystem } = await import('../src/db/bootstrap.ts');
  const result = bootstrapSystem(harness.db, { password: 'DifferentPass!123' });
  assert.equal(result.createdUsers.length, 0);
  const after = harness.db.prepare("SELECT password_hash FROM users WHERE email = 'admin@aaradhya.local'").get() as {
    password_hash: string;
  };
  assert.equal(after.password_hash, before.password_hash);
  const client = await harness.client('admin@aaradhya.local');
  const me = await client.get('/api/auth/me');
  expectedStatus(me, 200);
  assert.match(TEST_PASSWORD, /TestPass/);
});
