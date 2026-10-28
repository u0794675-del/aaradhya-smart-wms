import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, TEST_PASSWORD, createHarness, expectedStatus, idem, type Harness } from './helpers.ts';
import {
  boxDetail,
  createMixedBox,
  createProduct,
  createVendor,
  getMeta,
  loc,
  receiveStock,
  type Meta,
} from './flows.ts';

let harness: Harness;
let meta: Meta;
let admin: Awaited<ReturnType<Harness['client']>>;
let staff1: Awaited<ReturnType<Harness['client']>>;
let staff2: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;
let fieldEmployees: Array<{ id: string; employee_code: string; name: string; role_code: string }> = [];
let staff1Id = '';
let staff2Id = '';

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Field Operations Supplier');
  for (const [code, email] of [
    ['EMP-0007', 'field.staff1@aaradhya.local'],
    ['EMP-0008', 'field.staff2@aaradhya.local'],
  ]) {
    const created = await admin.post('/api/employees', {
      employeeCode: code,
      name: `Field Staff ${code.slice(-1)}`,
      email,
      password: TEST_PASSWORD,
      role: 'FIELD_OPERATOR',
      permissions: ['picking.execute', 'putaway.execute'],
    });
    expectedStatus(created, 201, `create field staff ${code}`);
  }
  staff1 = await harness.client('field.staff1@aaradhya.local');
  staff2 = await harness.client('field.staff2@aaradhya.local');
  const employees = await admin.get('/api/fieldops/employees');
  expectedStatus(employees, 200, 'field employees');
  fieldEmployees = employees.body.data;
  staff1Id = fieldEmployees.find((employee) => employee.employee_code === 'EMP-0007')!.id;
  staff2Id = fieldEmployees.find((employee) => employee.employee_code === 'EMP-0008')!.id;
});

after(async () => {
  await harness.close();
});

async function stockBox(input: {
  productId: string;
  quantity: number;
  locationCode: string;
  boxType?: 'SINGLE' | 'MIXED';
}): Promise<{ id: string; boxCode: string }> {
  const box = await createMixedBox(admin, {
    locationId: loc(meta, input.locationCode),
    poolId: poolId('B2B'),
    boxType: input.boxType,
  });
  await addToBox(box.id, input.productId, input.quantity, input.locationCode);
  return box;
}

async function addToBox(boxId: string, productId: string, quantity: number, locationCode: string): Promise<void> {
  await receiveStock(admin, {
    productId,
    quantity,
    vendorId,
    poolId: poolId('B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: quantity },
    putaway: { locationId: loc(meta, locationCode), boxId },
  });
}

function poolId(code: 'B2B' | 'SHARED'): string {
  const entry = meta.pools.find((entry) => entry.code === code);
  if (!entry) throw new Error(`Pool ${code} missing`);
  return entry.id;
}

async function balances(productId: string) {
  const response = await admin.get(`/api/inventory/balances?productId=${productId}&limit=500`);
  expectedStatus(response, 200, 'balances');
  return response.body.data.rows as Array<Record<string, any>>;
}

async function quantityAt(productId: string, locationCode: string, status = 'AVAILABLE'): Promise<number> {
  const rows = await balances(productId);
  return rows
    .filter((row) => row.location_code === locationCode && row.status === status)
    .reduce((total, row) => total + Number(row.quantity), 0);
}

async function totalAtAllStatuses(productId: string): Promise<number> {
  const rows = await balances(productId);
  return rows.reduce((total, row) => total + Number(row.quantity), 0);
}

function assertError(response: { status: number; body: any }, status: number, code: string, context: string) {
  assert.equal(response.status, status, `${context}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.error?.code, code, context);
}

async function assignJob(input: Record<string, unknown>) {
  return admin.post('/api/fieldops/jobs', input);
}

test('field employees are created explicitly and backend permissions gate assignment and access', async () => {
  const fieldOperators = fieldEmployees.filter((employee) => employee.role_code === 'FIELD_OPERATOR');
  assert.equal(fieldOperators.length, 2, 'only the employees created for this suite are seeded');
  assert.deepEqual(
    fieldOperators.map((employee) => employee.employee_code).sort(),
    ['EMP-0007', 'EMP-0008'],
  );
  assert.equal(new Set(fieldEmployees.map((employee) => employee.id)).size, fieldEmployees.length, 'employee IDs are unique');

  const viewer = await harness.client('viewer@aaradhya.local');
  const product = await createProduct(admin, { name: 'Insertion Staff Check', brand: 'Aaradhya' });
  const box = await stockBox({ productId: product.id, quantity: 1, locationCode: 'RACK-A01' });

  const payload = {
    jobType: 'PUTAWAY',
    boxId: box.id,
    employeeId: staff1Id,
    destinationLocationId: loc(meta, 'RACK-A02'),
  };
  const byStaff = await staff1.post('/api/fieldops/jobs', payload);
  assertError(byStaff, 403, 'FORBIDDEN', 'field staff cannot assign jobs');
  const byViewer = await viewer.post('/api/fieldops/jobs', payload);
  assertError(byViewer, 403, 'FORBIDDEN', 'viewer cannot assign jobs');

  const assigned = await assignJob({
    jobType: 'PUTAWAY',
    boxId: box.id,
    employeeId: staff1Id,
    destinationLocationId: loc(meta, 'RACK-A02'),
  });
  expectedStatus(assigned, 201, 'manager/admin assignment');
  const jobId = assigned.body.data.id as string;

  const otherEmployee = await staff2.get(`/api/fieldops/jobs/${jobId}`);
  assertError(otherEmployee, 403, 'FORBIDDEN', 'employee cannot open another employee job');
  const ownJob = await staff1.get(`/api/fieldops/jobs/${jobId}`);
  expectedStatus(ownJob, 200, 'employee opens own job');
  const otherList = await staff2.get('/api/fieldops/jobs?jobType=PUTAWAY&limit=300');
  expectedStatus(otherList, 200, 'employee job list');
  assert.equal(otherList.body.data.rows.some((row: any) => row.id === jobId), false, 'job list is scoped to self');
  const ownList = await staff1.get('/api/fieldops/jobs?jobType=PUTAWAY&limit=300');
  assert.equal(ownList.body.data.rows.some((row: any) => row.id === jobId), true, 'employee sees own job');

  const employees = await staff1.get('/api/fieldops/employees');
  assertError(employees, 403, 'FORBIDDEN', 'field staff cannot list all employees');

  // Cancel leaves stock untouched so the box can be reused by later tests.
  const before = await quantityAt(product.id, 'RACK-A01');
  expectedStatus(await admin.post(`/api/fieldops/jobs/${jobId}/cancel`, { reason: 'Test cleanup' }), 200, 'cancel job');
  assert.equal(await quantityAt(product.id, 'RACK-A01'), before, 'cancelling a job never moves stock');
  const cancelledDetail = await staff1.get(`/api/fieldops/jobs/${jobId}`);
  assert.equal(cancelledDetail.body.data.job.status, 'CANCELLED');
  assert.equal(cancelledDetail.body.data.operation, null);
});

test('putaway requires the assigned box and destination scans, updates the box only after confirmation, and preserves total stock', async () => {
  const product = await createProduct(admin, { name: 'Putaway Scan Tablets', brand: 'Allen' });
  const box = await stockBox({ productId: product.id, quantity: 6, locationCode: 'RACK-A02' });
  const created = await assignJob({
    jobType: 'PUTAWAY',
    boxId: box.id,
    employeeId: staff1Id,
    destinationLocationId: loc(meta, 'RACK-B01'),
  });
  expectedStatus(created, 201, 'create putaway job');
  const job = created.body.data;

  // Creating and opening the job is scan-only: no stock or box movement.
  const opened = await staff1.get(`/api/fieldops/jobs/${job.id}`);
  expectedStatus(opened, 200, 'open putaway job');
  assert.equal((await boxDetail(admin, box.id)).box.location_id, loc(meta, 'RACK-A02'), 'box stays at source before confirm');
  assert.equal(await quantityAt(product.id, 'RACK-A02'), 6);

  const wrongBox = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-putaway`,
    { boxCode: 'BOX-DOES-NOT-EXIST', destinationCode: 'RACK-B01' },
    idem(),
  );
  assert.equal(wrongBox.status, 404, 'unknown box scan is rejected');

  const wrongDestination = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-putaway`,
    { boxCode: box.boxCode, destinationCode: 'RACK-A01' },
    idem(),
  );
  assertError(wrongDestination, 409, 'WRONG_LOCATION_SCANNED', 'wrong destination scan');
  assert.equal(await quantityAt(product.id, 'RACK-A02'), 6, 'rejected scan moves nothing');
  assert.equal((await boxDetail(admin, box.id)).box.location_id, loc(meta, 'RACK-A02'));

  const beforeTotal = await totalAtAllStatuses(product.id);
  const key = idem();
  const confirmed = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-putaway`,
    { boxCode: box.boxCode, destinationCode: 'RACK-B01' },
    key,
  );
  expectedStatus(confirmed, 200, 'confirm putaway');
  assert.equal(await quantityAt(product.id, 'RACK-A02'), 0);
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 6);
  assert.equal(await totalAtAllStatuses(product.id), beforeTotal, 'location transfer does not change total stock');
  const detail = await boxDetail(admin, box.id);
  assert.equal(detail.box.location_id, loc(meta, 'RACK-B01'), 'box location updates after confirmation');

  const operation = confirmed.body.data.operation;
  assert.equal(operation.employee_code, 'EMP-0007');
  assert.equal(operation.box_code, box.boxCode);
  assert.equal(operation.brand, 'Allen');
  assert.equal(operation.source_location_code, 'RACK-A02');
  assert.equal(operation.destination_location_code, 'RACK-B01');
  assert.equal(operation.quantity_before, 6);
  assert.equal(operation.quantity_moved, 6);
  assert.equal(operation.quantity_after, 0);
  assert.equal(operation.box_count_before, 1);
  assert.equal(operation.box_count_after, 0);
  assert.equal(operation.txn_count, 1);

  const replay = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-putaway`,
    { boxCode: box.boxCode, destinationCode: 'RACK-B01' },
    key,
  );
  expectedStatus(replay, 200, 'idempotent replay');
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 6, 'replay does not move stock twice');

  const reuse = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-putaway`,
    { boxCode: box.boxCode, destinationCode: 'RACK-B01' },
    idem(),
  );
  assertError(reuse, 409, 'JOB_ALREADY_COMPLETED', 'second confirmation with a new key');

  const history = await admin.get(`/api/fieldops/history?type=PUTAWAY&box=${box.boxCode}`);
  expectedStatus(history, 200, 'putaway history');
  assert.equal(history.body.data.rows.length, 1);
  assert.equal(history.body.data.rows[0].operation_no, operation.operation_no);
  assert.equal(history.body.data.summary.length, 1);
  assert.equal(history.body.data.summary[0].quantity_moved, 6);

  const ledger = await admin.get(`/api/inventory/ledger?productId=${product.id}&referenceId=${job.id}`);
  expectedStatus(ledger, 200, 'ledger');
  assert.equal(ledger.body.data.rows.length, 1, 'one immutable ledger row for the confirmed putaway');
});

test('a mixed-content box can be put away without splitting its contents across locations', async () => {
  const first = await createProduct(admin, { name: 'Mixed Box Drops', brand: 'Allen' });
  const second = await createProduct(admin, { name: 'Mixed Box Ointment', brand: 'Aaradhya' });
  const box = await stockBox({ productId: first.id, quantity: 2, locationCode: 'RACK-A01', boxType: 'MIXED' });
  await addToBox(box.id, second.id, 3, 'RACK-A01');

  const created = await assignJob({
    jobType: 'PUTAWAY',
    boxId: box.id,
    employeeId: staff1Id,
    destinationLocationId: loc(meta, 'RACK-A02'),
  });
  expectedStatus(created, 201, 'create mixed putaway job');
  const beforeFirst = await totalAtAllStatuses(first.id);
  const beforeSecond = await totalAtAllStatuses(second.id);

  const confirmed = await staff1.post(
    `/api/fieldops/jobs/${created.body.data.id}/confirm-putaway`,
    { boxCode: box.boxCode, destinationCode: 'RACK-A02' },
    idem(),
  );
  expectedStatus(confirmed, 200, 'confirm mixed putaway');
  const detail = await boxDetail(admin, box.id);
  assert.equal(detail.box.location_id, loc(meta, 'RACK-A02'));
  assert.equal(detail.contents.every((line: any) => line.location_code === 'RACK-A02'), true, 'all box lines moved together');
  assert.equal(await totalAtAllStatuses(first.id), beforeFirst);
  assert.equal(await totalAtAllStatuses(second.id), beforeSecond);
  assert.equal(confirmed.body.data.operation.quantity_moved, 5);
  assert.equal(confirmed.body.data.operation.brand, 'Mixed brands');
  assert.equal(confirmed.body.data.operation.sku, null);
});

test('picking one whole box deducts exactly one box and records 10 → 1 → 9', async () => {
  const product = await createProduct(admin, { name: 'Ten Box Pick Tablets', brand: 'Allen' });
  const boxes: Array<{ id: string; boxCode: string }> = [];
  for (let index = 0; index < 10; index += 1) {
    boxes.push(await stockBox({ productId: product.id, quantity: 1, locationCode: 'RACK-B01' }));
  }
  const target = boxes[0]!;
  const created = await assignJob({
    jobType: 'PICK',
    boxId: target.id,
    employeeId: staff1Id,
    pickMode: 'BOX',
  });
  expectedStatus(created, 201, 'create box pick job');
  const job = created.body.data;

  assert.equal(await quantityAt(product.id, 'RACK-B01'), 10, 'ten units in ten boxes before the pick');
  const wrongLocation = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-pick`,
    { locationCode: 'RACK-A01', boxCode: target.boxCode },
    idem(),
  );
  assertError(wrongLocation, 409, 'WRONG_LOCATION_SCANNED', 'picking requires the assigned location barcode first');
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 10);

  const wrongBox = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-pick`,
    { locationCode: 'RACK-B01', boxCode: boxes[1]!.boxCode },
    idem(),
  );
  assertError(wrongBox, 409, 'WRONG_BOX_SCANNED', 'picking requires the assigned box');
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 10);

  const totalBefore = await totalAtAllStatuses(product.id);
  const confirmed = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-pick`,
    { locationCode: 'RACK-B01', boxCode: target.boxCode },
    idem(),
  );
  expectedStatus(confirmed, 200, 'confirm box pick');
  const operation = confirmed.body.data.operation;
  assert.equal(operation.quantity_before, 10);
  assert.equal(operation.quantity_moved, 1);
  assert.equal(operation.quantity_after, 9);
  assert.equal(operation.box_count_before, 10);
  assert.equal(operation.box_count_after, 9);
  assert.equal(operation.brand, 'Allen');
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 9, 'exactly one box left the location');
  assert.equal(await quantityAt(product.id, 'PACK-01', 'PICKED'), 1, 'the picked unit is in PICKED status at packing');
  assert.equal(await totalAtAllStatuses(product.id), totalBefore, 'picking moves stock; it does not destroy it');
  const picked = await boxDetail(admin, target.id);
  assert.equal(picked.contents.length, 0, 'picked box is empty');
  assert.equal(picked.box.location_id, loc(meta, 'PACK-01'), 'emptied box follows the stock to packing');

  const duplicate = await staff1.post(
    `/api/fieldops/jobs/${job.id}/confirm-pick`,
    { locationCode: 'RACK-B01', boxCode: target.boxCode },
    idem(),
  );
  assertError(duplicate, 409, 'JOB_ALREADY_COMPLETED', 'duplicate pick is blocked');
  assert.equal(await quantityAt(product.id, 'RACK-B01'), 9, 'duplicate confirmation does not deduct again');
});

test('partial-unit picking deducts only the confirmed SKU quantity and blocks over-picking', async () => {
  const product = await createProduct(admin, { name: 'Partial Pick Cream', brand: 'Aaradhya' });
  const box = await stockBox({ productId: product.id, quantity: 10, locationCode: 'RACK-A01' });

  const tooMany = await assignJob({
    jobType: 'PICK',
    boxId: box.id,
    employeeId: staff1Id,
    pickMode: 'UNITS',
    productId: product.id,
    pickQuantity: 11,
  });
  assertError(tooMany, 409, 'INSUFFICIENT_BOX_STOCK', 'cannot assign beyond box stock');

  const created = await assignJob({
    jobType: 'PICK',
    boxId: box.id,
    employeeId: staff1Id,
    pickMode: 'UNITS',
    productId: product.id,
    pickQuantity: 3,
  });
  expectedStatus(created, 201, 'create partial pick');

  const totalBefore = await totalAtAllStatuses(product.id);
  const confirmed = await staff1.post(
    `/api/fieldops/jobs/${created.body.data.id}/confirm-pick`,
    { locationCode: 'RACK-A01', boxCode: box.boxCode },
    idem(),
  );
  expectedStatus(confirmed, 200, 'confirm partial pick');
  const operation = confirmed.body.data.operation;
  assert.equal(operation.quantity_before, 10);
  assert.equal(operation.quantity_moved, 3);
  assert.equal(operation.quantity_after, 7);
  assert.equal(operation.box_count_before, 1);
  assert.equal(operation.box_count_after, 1);
  assert.equal(await quantityAt(product.id, 'RACK-A01'), 7, 'only confirmed units leave the box');
  assert.equal(await quantityAt(product.id, 'PACK-01', 'PICKED'), 3);
  assert.equal(await totalAtAllStatuses(product.id), totalBefore);

  const remaining = await boxDetail(admin, box.id);
  assert.equal(remaining.box.location_id, loc(meta, 'RACK-A01'), 'partially picked box stays at its location');
  assert.equal(remaining.contents.reduce((sum: number, line: any) => sum + Number(line.quantity), 0), 7);

  const negative = await assignJob({
    jobType: 'PICK',
    boxId: box.id,
    employeeId: staff1Id,
    pickMode: 'UNITS',
    productId: product.id,
    pickQuantity: 8,
  });
  assertError(negative, 409, 'INSUFFICIENT_BOX_STOCK', 'cannot assign more than remains');
});

test('history is employee-scoped, filterable, and shows employee-wise totals for administrators', async () => {
  // Two confirmed operations already exist from earlier tests for staff 1.
  const own = await staff1.get('/api/fieldops/history?type=PUTAWAY&limit=300');
  expectedStatus(own, 200, 'employee history');
  assert.ok(own.body.data.rows.length >= 1);
  assert.equal(own.body.data.rows.every((row: any) => row.employee_id === staff1Id), true, 'employee only sees own records');

  const scopeAttempt = await staff1.get(`/api/fieldops/history?employeeId=${staff2Id}&limit=300`);
  expectedStatus(scopeAttempt, 200, 'employee scoped filter');
  assert.equal(scopeAttempt.body.data.rows.every((row: any) => row.employee_id === staff1Id), true);

  const filtered = await admin.get(`/api/fieldops/history?type=PUTAWAY&employeeId=${staff1Id}&brand=Allen&limit=300`);
  expectedStatus(filtered, 200, 'filtered history');
  assert.ok(filtered.body.data.rows.length >= 1);
  assert.equal(filtered.body.data.rows.every((row: any) => row.employee_id === staff1Id && row.brand === 'Allen'), true);
  const summary = filtered.body.data.summary;
  assert.ok(summary.length >= 1);
  assert.equal(summary.every((row: any) => row.employee_id === staff1Id), true);
  const totalMoved = summary.reduce((sum: number, row: any) => sum + Number(row.quantity_moved), 0);
  assert.equal(totalMoved, filtered.body.data.rows.reduce((sum: number, row: any) => sum + Number(row.quantity_moved), 0));

  const noMatch = await admin.get('/api/fieldops/history?type=PICK&box=NO-SUCH-BOX');
  expectedStatus(noMatch, 200, 'empty filtered history');
  assert.equal(noMatch.body.data.rows.length, 0);
});

test('administrators can create, re-permission, reset and deactivate an employee; access is enforced by the backend', async () => {
  const created = await admin.post('/api/employees', {
    name: 'Test Field Employee',
    email: 'field.test@aaradhya.local',
    role: 'FIELD_OPERATOR',
    permissions: ['putaway.execute'],
  });
  expectedStatus(created, 201, 'create employee');
  assert.equal(created.body.data.employee.employee_code, 'EMP-0009');
  assert.deepEqual(created.body.data.employee.permissions, ['putaway.execute']);
  const password = created.body.data.temporaryPassword as string;
  assert.ok(password && password.length >= 8, 'temporary password is returned once');
  const employeeId = created.body.data.employee.id as string;

  const employeeClient = new ApiClient(harness.baseUrl);
  const login = await employeeClient.login('field.test@aaradhya.local', password);
  expectedStatus(login, 200, 'employee login with temporary password');
  assert.deepEqual(login.body.data.user.permissions, ['putaway.execute']);

  const pickerAccess = await employeeClient.get('/api/fieldops/jobs?jobType=PICK');
  assertError(pickerAccess, 403, 'FORBIDDEN', 'employee without picking permission cannot read picker jobs');
  const putawayAccess = await employeeClient.get('/api/fieldops/jobs?jobType=PUTAWAY');
  expectedStatus(putawayAccess, 200, 'permitted putaway access');

  const grant = await admin.patch(`/api/employees/${employeeId}`, { permissions: ['putaway.execute', 'picking.execute'] });
  expectedStatus(grant, 200, 'grant picking permission');
  assert.deepEqual(grant.body.data.permissions.sort(), ['picking.execute', 'putaway.execute']);
  expectedStatus(await employeeClient.get('/api/fieldops/jobs?jobType=PICK'), 200, 'override applies immediately');

  const reset = await admin.post(`/api/employees/${employeeId}/reset-password`);
  expectedStatus(reset, 200, 'reset password');
  const newPassword = reset.body.data.password as string;
  const staleSession = await employeeClient.get('/api/auth/me');
  assert.equal(staleSession.status, 401, 'password reset revokes open sessions');

  const oldLogin = new ApiClient(harness.baseUrl);
  assert.equal((await oldLogin.login('field.test@aaradhya.local', password)).status, 401, 'old password no longer works');
  const newLogin = new ApiClient(harness.baseUrl);
  expectedStatus(await newLogin.login('field.test@aaradhya.local', newPassword), 200, 'new password works');

  expectedStatus(await admin.patch(`/api/employees/${employeeId}`, { isActive: false }), 200, 'deactivate employee');
  assert.equal((await newLogin.get('/api/auth/me')).status, 401, 'deactivation revokes the session');
  const inactiveLogin = new ApiClient(harness.baseUrl);
  assert.equal((await inactiveLogin.login('field.test@aaradhya.local', newPassword)).status, 401, 'inactive employee cannot sign in');

  const duplicateCode = await admin.post('/api/employees', {
    employeeCode: 'EMP-0007',
    name: 'Duplicate Code',
    email: 'duplicate.code@aaradhya.local',
  });
  assertError(duplicateCode, 409, 'EMPLOYEE_CODE_EXISTS', 'employee IDs are unique');
});

test('employee register lists field staff only and bulk delete protects system accounts and staff with history', async () => {
  const list = await admin.get('/api/employees?limit=300');
  expectedStatus(list, 200, 'employee register');
  const rows = list.body.data.rows as Array<Record<string, any>>;
  assert.ok(Array.isArray(rows), 'employee list returns rows');
  assert.equal(
    rows.every((row) => row.role_code === 'FIELD_OPERATOR' || row.role_code === 'PICKER'),
    true,
    'only field roles appear in the employee register',
  );
  assert.equal(rows.some((row) => row.employee_code === 'EMP-0001'), false, 'admin account is not listed as field staff');

  const me = await admin.get('/api/auth/me');
  const adminId = me.body.data.user.id as string;
  const selfDelete = await admin.post('/api/employees/bulk-delete', { ids: [adminId], reason: 'guard check' });
  expectedStatus(selfDelete, 200, 'self delete');
  assert.equal(selfDelete.body.data.skipped[0].reason, 'You cannot delete your own account');

  const seeded = rows.find((row) => row.employee_code === 'EMP-0003');
  assert.ok(seeded, 'seeded picker login is part of the register');
  const protectedDelete = await admin.post('/api/employees/bulk-delete', { ids: [seeded.id], reason: 'guard check' });
  assert.equal(protectedDelete.body.data.deleted.length, 0);
  assert.equal(protectedDelete.body.data.skipped[0].reason, 'Seeded login account — deactivate it instead of deleting');

  const historyDelete = await admin.post('/api/employees/bulk-delete', { ids: [staff1Id], reason: 'guard check' });
  assert.equal(historyDelete.body.data.deleted.length, 0, 'employee with confirmed field history cannot be deleted');
  assert.match(String(historyDelete.body.data.skipped[0].reason), /deactivate the employee instead/);

  const disposable = await admin.post('/api/employees', {
    name: 'Disposable Staff',
    email: 'disposable.staff@aaradhya.local',
    role: 'FIELD_OPERATOR',
  });
  expectedStatus(disposable, 201, 'create disposable employee');
  const disposableId = disposable.body.data.employee.id as string;
  const deleted = await admin.post('/api/employees/bulk-delete', {
    ids: [disposableId],
    reason: 'test cleanup',
  });
  expectedStatus(deleted, 200, 'bulk delete employee');
  assert.deepEqual(deleted.body.data.deleted, [disposableId]);
  const after = await admin.get('/api/employees?limit=300');
  assert.equal(after.body.data.rows.some((row: any) => row.id === disposableId), false, 'deleted employee is gone');

  // Deleting another employee must never revoke the signed-in administrator.
  const actorSession = await admin.get('/api/auth/me');
  expectedStatus(actorSession, 200, 'actor session survives employee deletion');
  assert.equal(actorSession.body.data.user.id, adminId, 'actor stays signed in after bulk delete');
});
