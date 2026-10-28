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
  orderDetail,
  pool,
  receiveStock,
  type Meta,
} from './flows.ts';

let harness: Harness;
let meta: Meta;
let admin: Awaited<ReturnType<Harness['client']>>;
let manager: Awaited<ReturnType<Harness['client']>>;
let picker: Awaited<ReturnType<Harness['client']>>;
let qc: Awaited<ReturnType<Harness['client']>>;
let viewer: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  manager = await harness.client('manager@aaradhya.local');
  picker = await harness.client('picker@aaradhya.local');
  qc = await harness.client('qc@aaradhya.local');
  viewer = await harness.client('viewer@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Acceptance Supplier');
});

after(async () => {
  await harness.close();
});

async function balances(productId: string) {
  const response = await admin.get(`/api/inventory/balances?productId=${productId}`);
  expectedStatus(response, 200, 'balances');
  return response.body.data.rows as Array<Record<string, any>>;
}

async function ledger(productId: string) {
  const response = await admin.get(`/api/inventory/ledger?productId=${productId}&limit=300`);
  expectedStatus(response, 200, 'ledger');
  return response.body.data.rows as Array<Record<string, any>>;
}

function total(rows: Array<Record<string, any>>) {
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

function deniedCount(email: string) {
  const row = harness.db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE event_type = 'PERMISSION_DENIED'
          AND actor_user_id = (SELECT id FROM users WHERE email = ?)`,
    )
    .get(email) as { n: number };
  return Number(row.n);
}

test('permission denials block real stock routes, are audited, and permitted roles still succeed (Acceptance K)', async () => {
  const product = await createProduct(admin, { name: 'Permission Matrix Syrup' });
  await receiveStock(admin, {
    productId: product.id,
    quantity: 10,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 10 },
    putaway: { locationId: loc(meta, 'RACK-A02') },
  });
  const pickerDenialsBefore = deniedCount('picker@aaradhya.local');
  const qcDenialsBefore = deniedCount('qc@aaradhya.local');
  const viewerDenialsBefore = deniedCount('viewer@aaradhya.local');

  const unauthorizedAdjustment = await picker.post(
    '/api/adjustments',
    {
      productId: product.id,
      locationId: loc(meta, 'RACK-A02'),
      poolId: pool(meta, 'B2B'),
      direction: 'OUT',
      quantity: 4,
      reason: 'Picker should never post adjustments',
    },
    idem(),
  );
  assert.equal(unauthorizedAdjustment.status, 403);
  assert.equal(unauthorizedAdjustment.body.error.code, 'FORBIDDEN');

  const unauthorizedTransfer = await picker.post(
    '/api/transfers',
    {
      transferType: 'POOL_TO_POOL',
      fromLocationId: loc(meta, 'RACK-A02'),
      fromPoolId: pool(meta, 'B2B'),
      toPoolId: pool(meta, 'B2B'),
      reason: 'Picker should never move pool stock between channels',
      lines: [{ productId: product.id, quantity: 2 }],
    },
    idem(),
  );
  assert.equal(unauthorizedTransfer.status, 403);

  const unauthorizedOrder = await viewer.post(
    '/api/orders',
    { channel: 'B2B', customerName: 'Denied Customer', lines: [{ productId: product.id, quantity: 1 }] },
    idem(),
  );
  assert.equal(unauthorizedOrder.status, 403);

  const rowsAfterDenials = await balances(product.id);
  assert.equal(total(rowsAfterDenials), 10);
  const adjustmentLedger = (await ledger(product.id)).filter((r) =>
    ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_DISPATCH'].includes(r.movement_type),
  );
  assert.equal(adjustmentLedger.length, 0);
  const adjustments = await admin.get('/api/adjustments');
  expectedStatus(adjustments, 200);
  assert.equal(adjustments.body.data.rows.length, 0);
  const transfers = await admin.get('/api/transfers');
  expectedStatus(transfers, 200);
  assert.equal(transfers.body.data.rows.length, 0);

  assert.equal(deniedCount('picker@aaradhya.local'), pickerDenialsBefore + 2);
  assert.equal(deniedCount('viewer@aaradhya.local'), viewerDenialsBefore + 1);
  const pickerAudit = harness.db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE event_type = 'PERMISSION_DENIED'
          AND actor_user_id = (SELECT id FROM users WHERE email = 'picker@aaradhya.local')
          AND ip IS NOT NULL`,
    )
    .get() as { n: number };
  assert.ok(Number(pickerAudit.n) >= 1, 'denials must record the acting user and request context');

  const viewerRead = await viewer.get(`/api/inventory/balances?productId=${product.id}`);
  expectedStatus(viewerRead, 200, 'viewer read access');

  const order = await createOrder(admin, { productId: product.id, quantity: 2 });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const pickBody = { lines: [{ orderLineId: detail.lines[0].id, quantity: 2 }] };

  const unauthorizedPick = await qc.post(`/api/orders/${order.id}/pick`, pickBody, idem());
  assert.equal(unauthorizedPick.status, 403);
  assert.equal(deniedCount('qc@aaradhya.local'), qcDenialsBefore + 1);
  assert.equal(total(await balances(product.id)), 10);
  assert.equal((await orderDetail(admin, order.id)).status, 'ALLOCATED');

  const pick = await picker.post(`/api/orders/${order.id}/pick`, pickBody, idem());
  expectedStatus(pick, 200, 'permitted picker picks');
  const packed = await picker.post(`/api/orders/${order.id}/pack`, {}, idem());
  expectedStatus(packed, 200, 'permitted picker packs');

  const unauthorizedDispatch = await picker.post(`/api/orders/${order.id}/dispatch`, {}, idem());
  assert.equal(unauthorizedDispatch.status, 403);
  assert.equal((await orderDetail(admin, order.id)).status, 'PACKED');
  assert.equal((await ledger(product.id)).filter((r) => r.movement_type === 'DISPATCH').length, 0);

  const dispatched = await admin.post(`/api/orders/${order.id}/dispatch`, {}, idem());
  expectedStatus(dispatched, 200, 'admin dispatches');
  assert.equal((await ledger(product.id)).filter((r) => r.movement_type === 'DISPATCH').length, 1);
  assert.equal(
    (await balances(product.id)).filter((r) => r.status === 'AVAILABLE').reduce((s, r) => s + Number(r.quantity), 0),
    8,
  );
});

test('the full receipt-to-return workflow is traced, persisted and reconciles end to end', async () => {
  const product = await createProduct(admin, {
    name: 'Golden Path Drops',
    isBatchTracked: true,
    isExpiryTracked: true,
  });
  const received = await receiveStock(admin, {
    productId: product.id,
    quantity: 6,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    batchNo: 'GP-2601',
    mfgDate: '2026-01-01',
    expiryDate: '2028-12-31',
    qc: { accepted: 4, rejected: 2 },
    putaway: { locationId: loc(meta, 'RACK-A01'), quantity: 4 },
  });
  assert.ok(received.line.batch_id);
  assert.equal(total(await balances(product.id)), 6);

  const order = await createOrder(admin, { productId: product.id, quantity: 3 });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const orderLine = detail.lines[0];
  assert.equal(orderLine.allocated_qty, 3);

  const pick = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: orderLine.id, quantity: 3 }] },
    idem(),
  );
  expectedStatus(pick, 200, 'golden path pick');
  expectedStatus(await picker.post(`/api/orders/${order.id}/pack`, {}, idem()), 200, 'golden path pack');
  const dispatched = await admin.post(
    `/api/orders/${order.id}/dispatch`,
    { carrier: 'Aaradhya Express', trackingNo: 'AWB-GOLD-1' },
    idem(),
  );
  expectedStatus(dispatched, 200, 'golden path dispatch');

  const finalOrder = await orderDetail(admin, order.id);
  assert.equal(finalOrder.status, 'DISPATCHED');
  assert.equal(finalOrder.shipments.length, 1);
  const shipment = await admin.get(`/api/shipments/${dispatched.body.data.shipmentNo}`);
  expectedStatus(shipment, 200, 'shipment trace');
  assert.equal(shipment.body.data.order.id, order.id);

  const returned = await manager.post(
    '/api/returns',
    {
      orderId: order.id,
      reason: 'Customer returned an unopened pack',
      lines: [{ productId: product.id, quantity: 1, batchId: received.line.batch_id }],
    },
    idem(),
  );
  expectedStatus(returned, 201, 'golden path return');
  let rows = await balances(product.id);
  assert.equal(rows.filter((r) => r.status === 'RETURN_PENDING').reduce((s, r) => s + Number(r.quantity), 0), 1);

  const returnDetail = await manager.get(`/api/returns/${returned.body.data.id}`);
  expectedStatus(returnDetail, 200, 'return detail');
  const inspected = await manager.post(
    `/api/returns/${returned.body.data.id}/inspect`,
    { lines: [{ returnLineId: returnDetail.body.data.lines[0].id, restockQty: 1 }] },
    idem(),
  );
  expectedStatus(inspected, 200, 'golden path inspect');
  assert.equal(inspected.body.data.status, 'COMPLETED');

  rows = await balances(product.id);
  assert.equal(rows.filter((r) => r.status === 'AVAILABLE').reduce((s, r) => s + Number(r.quantity), 0), 2);
  assert.equal(rows.filter((r) => r.status === 'RETURN_PENDING').length, 0);
  assert.equal(total(rows), 4);

  const movements = (await ledger(product.id)).map((r) => r.movement_type);
  for (const expected of ['RECEIPT', 'QC_ACCEPT', 'QC_REJECT', 'PUTAWAY', 'PICK', 'DISPATCH', 'RETURN_RECEIVE', 'RETURN_RESTOCK']) {
    assert.ok(movements.includes(expected), `ledger must contain ${expected}`);
  }

  const dispatchTxn = harness.db
    .prepare(
      `SELECT * FROM inventory_transactions
        WHERE product_id = ? AND movement_type = 'DISPATCH' AND reference_id = ?`,
    )
    .get(product.id, order.id) as Record<string, any> | undefined;
  assert.ok(dispatchTxn);
  assert.ok(dispatchTxn.user_id);
  assert.equal(dispatchTxn.role_code, 'ADMIN');
  assert.equal(dispatchTxn.reference_type, 'ORDER');
  assert.equal(Number(dispatchTxn.quantity), 3);
  assert.equal(dispatchTxn.to_location_id, null);
  const dispatchAudit = harness.db
    .prepare("SELECT * FROM audit_events WHERE transaction_id = ? AND event_type = 'STOCK_DISPATCH'")
    .get(dispatchTxn.id) as Record<string, any> | undefined;
  assert.ok(dispatchAudit);
  assert.equal(dispatchAudit.actor_user_id, dispatchTxn.user_id);
  assert.equal(dispatchAudit.outcome, 'SUCCESS');

  const reconciliation = await admin.get('/api/inventory/reconciliation');
  expectedStatus(reconciliation, 200, 'reconciliation');
  assert.equal(reconciliation.body.data.ok, true, JSON.stringify(reconciliation.body.data.checks));
});
