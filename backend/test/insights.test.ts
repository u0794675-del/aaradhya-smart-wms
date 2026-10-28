import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, expectedStatus, idem, type Harness } from './helpers.ts';
import {
  confirmAndAllocate,
  createOrder,
  createProduct,
  createVendor,
  getMeta,
  loc,
  pool,
  receiveStock,
  type Meta,
} from './flows.ts';

let harness: Harness;
let meta: Meta;
let admin: Awaited<ReturnType<Harness['client']>>;
let manager: Awaited<ReturnType<Harness['client']>>;
let picker: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;
let productId: string;
let productSku: string;

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  manager = await harness.client('manager@aaradhya.local');
  picker = await harness.client('picker@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Insights Supplier');
  const product = await createProduct(admin, { name: 'Insights Stock Syrup' });
  productId = product.id;
  productSku = product.sku;
  await receiveStock(admin, {
    productId,
    quantity: 8,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 8 },
    putaway: { locationId: loc(meta, 'RACK-A02') },
  });
});

after(async () => {
  await harness.close();
});

test('control tower, search and genealogy expose real persisted data', async () => {
  const order = await createOrder(admin, { productId, quantity: 2 });
  await confirmAndAllocate(admin, order.id);

  const tower = await admin.get('/api/control-tower');
  expectedStatus(tower, 200, 'control tower');
  assert.ok(tower.body.data.orders.open >= 1);
  assert.ok(tower.body.data.queues.picks.some((row: any) => row.order_no === order.orderNo));
  assert.ok(tower.body.data.inventory.availableUnits >= 6);
  assert.ok(Array.isArray(tower.body.data.recentActivity));

  const search = await admin.get(`/api/search?q=${encodeURIComponent(productSku)}`);
  expectedStatus(search, 200, 'search');
  const products = search.body.data.groups.find((group: any) => group.type === 'PRODUCTS');
  assert.ok(products.items.some((item: any) => item.sku === productSku));

  const trace = await admin.get(`/api/genealogy?type=PRODUCT&id=${productId}`);
  expectedStatus(trace, 200, 'genealogy');
  assert.equal(trace.body.data.entity.sku, productSku);
  const movements = trace.body.data.transactions.map((row: any) => row.movement_type);
  assert.ok(movements.includes('RECEIPT'));
  assert.ok(movements.includes('PUTAWAY'));
  assert.ok(trace.body.data.related.balances.length >= 1);
  assert.ok(trace.body.data.auditEvents.length >= 1);

  const deniedTower = await picker.get('/api/control-tower');
  assert.equal(deniedTower.status, 403);
});

test('audit events can be filtered by entity and are restricted to audit readers', async () => {
  const response = await admin.get(`/api/audit?entityType=INVENTORY&entityId=${productId}&limit=50`);
  expectedStatus(response, 200, 'audit list');
  assert.ok(response.body.data.rows.length > 0);
  const row = response.body.data.rows[0];
  assert.equal(row.entity_type, 'INVENTORY');
  assert.ok(row.actor_user_id);
  assert.ok(row.event_type.startsWith('STOCK_') || row.event_type.startsWith('RESERVATION_'));

  const denied = await picker.get('/api/audit');
  assert.equal(denied.status, 403);
});

test('reports summarize stock and export the same data as CSV', async () => {
  const summary = await admin.get('/api/reports/stock-summary');
  expectedStatus(summary, 200, 'stock summary');
  const row = summary.body.data.rows.find((entry: any) => entry.sku === productSku);
  assert.ok(row);
  assert.equal(Number(row.on_hand), 8);
  assert.equal(Number(row.available), 6);
  assert.equal(Number(row.reserved), 2);
  assert.ok(summary.body.data.totals.on_hand >= 8);
  assert.ok(row.stock_value >= 0 || row.stock_value === undefined);

  const csv = await admin.get('/api/reports/stock-summary.csv');
  expectedStatus(csv, 200, 'stock csv');
  assert.match(String(csv.headers.get('content-type')), /text\/csv/);
  assert.match(String(csv.body), new RegExp(`^sku,name`, 'm'));
  assert.match(String(csv.body), new RegExp(productSku));

  const movements = await admin.get('/api/reports/movements');
  expectedStatus(movements, 200, 'movement report');
  assert.ok(Array.isArray(movements.body.data.days));

  const expiry = await admin.get('/api/reports/expiry');
  expectedStatus(expiry, 200, 'expiry report');
  assert.ok(Array.isArray(expiry.body.data.buckets));
});

test('settings changes are audited and rejected when the value type is wrong', async () => {
  const current = await admin.get('/api/settings');
  expectedStatus(current, 200, 'settings list');
  const before = current.body.data.rows.find((row: any) => row.key === 'low_stock_default');
  assert.equal(before.value, 20);

  const updated = await admin.patch('/api/settings/low_stock_default', { value: 25 });
  expectedStatus(updated, 200, 'update setting');
  assert.equal(updated.body.data.value, 25);

  const audit = await admin.get('/api/audit?eventType=SETTING_UPDATED&entityId=low_stock_default');
  expectedStatus(audit, 200, 'setting audit');
  assert.equal(audit.body.data.rows.length, 1);
  assert.equal(audit.body.data.rows[0].before.value, 20);
  assert.equal(audit.body.data.rows[0].after.value, 25);

  const wrongType = await admin.patch('/api/settings/low_stock_default', { value: 'many' });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error.code, 'SETTING_TYPE_MISMATCH');
  const after = await admin.get('/api/settings');
  assert.equal(after.body.data.rows.find((row: any) => row.key === 'low_stock_default').value, 25);

  const denied = await picker.patch('/api/settings/low_stock_default', { value: 30 });
  assert.equal(denied.status, 403);
});

test('notifications derive from real low stock and can be acknowledged and resolved', async () => {
  const product = await createProduct(admin, { name: 'Low Stock Drops', lowStockThreshold: 5 });
  await receiveStock(admin, {
    productId: product.id,
    quantity: 2,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 2 },
    putaway: { locationId: loc(meta, 'RACK-A01') },
  });

  const list = await admin.get('/api/notifications?status=OPEN');
  expectedStatus(list, 200, 'notifications');
  const notification = list.body.data.rows.find(
    (row: any) => row.rule_code === 'LOW_STOCK' && row.entity_id === product.id,
  );
  assert.ok(notification);
  assert.equal(notification.status, 'OPEN');

  const ack = await admin.post(`/api/notifications/${notification.id}/acknowledge`, {}, idem());
  expectedStatus(ack, 200, 'acknowledge notification');
  assert.equal(ack.body.data.status, 'ACKNOWLEDGED');

  const afterAck = await admin.get('/api/notifications?status=OPEN');
  const reRaised = afterAck.body.data.rows.filter(
    (row: any) => row.rule_code === 'LOW_STOCK' && row.entity_id === product.id,
  );
  assert.equal(reRaised.length, 0, 'acknowledging an alert must not create a duplicate open notification');
  const acknowledged = await admin.get('/api/notifications?status=ACKNOWLEDGED');
  assert.equal(
    acknowledged.body.data.rows.filter((row: any) => row.id === notification.id).length,
    1,
    'the acknowledged notification must remain in the acknowledged view',
  );

  const resolved = await admin.post(
    `/api/notifications/${notification.id}/resolve`,
    { reason: 'Purchase order raised for replenishment' },
    idem(),
  );
  expectedStatus(resolved, 200, 'resolve notification');
  assert.equal(resolved.body.data.status, 'RESOLVED');

  const afterResolve = await admin.get('/api/notifications?status=OPEN');
  assert.equal(
    afterResolve.body.data.rows.filter(
      (row: any) => row.rule_code === 'LOW_STOCK' && row.entity_id === product.id,
    ).length,
    0,
    'a resolved alert must stay closed while the low-stock condition persists',
  );

  const again = await admin.post(
    `/api/notifications/${notification.id}/resolve`,
    { reason: 'Second attempt' },
    idem(),
  );
  assert.equal(again.status, 409);

  const audit = await admin.get(`/api/audit?eventType=NOTIFICATION_RESOLVED&entityId=${notification.id}`);
  assert.equal(audit.body.data.rows.length, 1);
});

test('product CSV imports are validated, all-or-nothing and recorded as jobs', async () => {
  const existing = await admin.get(`/api/products?search=${productSku}`);
  const countBefore = Number(existing.body.data.total);

  const invalid = await admin.post(
    '/api/imports/products',
    {
      fileName: 'products-invalid.csv',
      csv: `sku,name,baseUom\r\n${productSku},Duplicate Product,PIECE\r\n`,
    },
    idem(),
  );
  expectedStatus(invalid, 201, 'invalid import');
  assert.equal(invalid.body.data.job.status, 'FAILED');
  assert.equal(invalid.body.data.errors.length, 1);
  const afterInvalid = await admin.get(`/api/products?search=${productSku}`);
  assert.equal(Number(afterInvalid.body.data.total), countBefore);

  const valid = await admin.post(
    '/api/imports/products',
    {
      fileName: 'products-valid.csv',
      csv: `sku,name,category,baseUom,isBatchTracked,isExpiryTracked,qcRequired,costPrice,lowStockThreshold
IMPT-001,Imported Tablets,Respiratory,STRIP,true,true,true,12.5,15
IMPT-002,Imported Drops,Wellness,PIECE,false,false,false,4,10
`,
    },
    idem(),
  );
  expectedStatus(valid, 201, 'valid import');
  assert.equal(valid.body.data.job.status, 'IMPORTED');
  assert.equal(valid.body.data.createdProducts, 2);

  const imported = await admin.get('/api/products?search=IMPT-');
  const skus = imported.body.data.rows.map((row: any) => row.sku);
  assert.ok(skus.includes('IMPT-001'));
  assert.ok(skus.includes('IMPT-002'));
  const batchProduct = imported.body.data.rows.find((row: any) => row.sku === 'IMPT-001');
  assert.equal(batchProduct.is_batch_tracked, 1);
  assert.equal(batchProduct.is_expiry_tracked, 1);

  const jobs = await admin.get('/api/imports');
  expectedStatus(jobs, 200, 'import jobs');
  assert.ok(jobs.body.data.rows.length >= 2);

  const denied = await picker.post(
    '/api/imports/products',
    { fileName: 'x.csv', csv: 'name\nForbidden Import' },
    idem(),
  );
  assert.equal(denied.status, 403);
});

test('the grounded assistant answers from the database and logs each query', async () => {
  const stock = await manager.post('/api/assistant', { question: `How much stock of ${productSku} do we have?` });
  expectedStatus(stock, 200, 'assistant stock');
  assert.equal(stock.body.data.intent, 'STOCK_LOOKUP');
  assert.match(stock.body.data.answer, new RegExp(productSku));
  assert.ok(stock.body.data.citations.some((citation: any) => citation.id === productId));

  const low = await manager.post('/api/assistant', { question: 'Which products are below their low stock threshold?' });
  expectedStatus(low, 200, 'assistant low stock');
  assert.equal(low.body.data.intent, 'LOW_STOCK');
  assert.ok(Array.isArray(low.body.data.data));

  const expiry = await manager.post('/api/assistant', { question: 'Show me expiring batches' });
  expectedStatus(expiry, 200, 'assistant expiry');
  assert.equal(expiry.body.data.intent, 'EXPIRY');

  const logs = harness.db.prepare("SELECT COUNT(*) AS n FROM ai_action_logs WHERE outcome = 'SUCCESS'").get() as {
    n: number;
  };
  assert.ok(Number(logs.n) >= 3);

  const denied = await picker.post('/api/assistant', { question: 'How much stock?' });
  assert.equal(denied.status, 403);
});

test('exceptions are raised, investigated and resolved with audit history', async () => {
  const created = await picker.post(
    '/api/exceptions',
    {
      type: 'DAMAGED_SHELF',
      severity: 'HIGH',
      entityType: 'LOCATION',
      entityId: loc(meta, 'RACK-A02'),
      description: 'Water damage found on rack A02 bottom shelf',
    },
    idem(),
  );
  expectedStatus(created, 201, 'create exception');
  const exceptionId = created.body.data.id as string;
  assert.equal(created.body.data.status, 'OPEN');

  const noResolution = await picker.patch(
    `/api/exceptions/${exceptionId}`,
    { status: 'RESOLVED' },
    idem(),
  );
  assert.equal(noResolution.status, 400);
  assert.equal(noResolution.body.error.code, 'RESOLUTION_REQUIRED');

  const investigating = await picker.patch(`/api/exceptions/${exceptionId}`, { status: 'INVESTIGATING' }, idem());
  expectedStatus(investigating, 200, 'investigate exception');

  const resolved = await manager.patch(
    `/api/exceptions/${exceptionId}`,
    { status: 'RESOLVED', resolution: 'Shelf replaced and stock re-inspected' },
    idem(),
  );
  expectedStatus(resolved, 200, 'resolve exception');
  assert.equal(resolved.body.data.status, 'RESOLVED');
  assert.ok(resolved.body.data.audit.length >= 3);

  const invalid = await manager.patch(`/api/exceptions/${exceptionId}`, { status: 'OPEN' }, idem());
  assert.equal(invalid.status, 409);

  const list = await admin.get('/api/exceptions?status=RESOLVED');
  expectedStatus(list, 200, 'exception list');
  assert.ok(list.body.data.rows.some((row: any) => row.id === exceptionId));

  const detail = await admin.get(`/api/exceptions/${exceptionId}`);
  expectedStatus(detail, 200, 'exception detail');
  assert.equal(detail.body.data.created_by_name, 'Warehouse Picker');
  assert.equal(detail.body.data.owner_name, 'Warehouse Picker');
});
