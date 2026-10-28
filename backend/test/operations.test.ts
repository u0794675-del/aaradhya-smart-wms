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
import { isSupportedPoolCode } from '../src/services/inventory.ts';

let harness: Harness;
let meta: Meta;
let admin: Awaited<ReturnType<Harness['client']>>;
let manager: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  manager = await harness.client('manager@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Operations Supplier');
});

after(async () => {
  await harness.close();
});

async function stockInPool(productId: string, quantity: number, poolCode: 'B2B' | 'SHARED', locationCode = 'RACK-A01') {
  await receiveStock(admin, {
    productId,
    quantity,
    vendorId,
    poolId: pool(meta, poolCode),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: quantity },
    putaway: { locationId: loc(meta, locationCode) },
  });
}

async function balances(productId: string) {
  const response = await admin.get(`/api/inventory/balances?productId=${productId}`);
  expectedStatus(response, 200, 'balances');
  return response.body.data.rows as Array<Record<string, any>>;
}

function sum(rows: Array<Record<string, any>>, predicate: (row: Record<string, any>) => boolean) {
  return rows.filter(predicate).reduce((total, row) => total + Number(row.quantity), 0);
}

async function shippedOrder(productId: string, quantity: number) {
  await stockInPool(productId, quantity, 'B2B', 'RACK-A02');
  const order = await createOrder(admin, { productId, quantity });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const pick = await admin.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: detail.lines[0].id, quantity }] },
    idem(),
  );
  expectedStatus(pick, 200, 'pick for return');
  expectedStatus(await admin.post(`/api/orders/${order.id}/pack`, {}, idem()), 200, 'pack for return');
  expectedStatus(await admin.post(`/api/orders/${order.id}/dispatch`, {}, idem()), 200, 'dispatch for return');
  return { order, line: detail.lines[0] };
}

test('B2B stock can be transferred to a separate pool only after approval, dispatch and receipt (Acceptance E)', async () => {
  const product = await createProduct(admin, { name: 'Pool Transfer Tablets' });
  await stockInPool(product.id, 10, 'B2B');

  const created = await manager.post(
    '/api/transfers',
    {
      transferType: 'POOL_TO_POOL',
      fromLocationId: loc(meta, 'RACK-A01'),
      fromPoolId: pool(meta, 'B2B'),
      toPoolId: pool(meta, 'SHARED'),
      reason: 'Rebalance wholesale stock for retail demand',
      lines: [{ productId: product.id, quantity: 3 }],
    },
    idem(),
  );
  expectedStatus(created, 201, 'create transfer');
  const transferId = created.body.data.id as string;
  assert.equal(created.body.data.status, 'PENDING_APPROVAL');

  const earlyDispatch = await manager.post(`/api/transfers/${transferId}/dispatch`, {}, idem());
  assert.equal(earlyDispatch.status, 409);

  expectedStatus(await manager.post(`/api/transfers/${transferId}/approve`, {}, idem()), 200, 'approve transfer');
  const dispatched = await manager.post(`/api/transfers/${transferId}/dispatch`, {}, idem());
  expectedStatus(dispatched, 200, 'dispatch transfer');

  let rows = await balances(product.id);
  assert.equal(sum(rows, (r) => r.pool_id === pool(meta, 'B2B') && r.status === 'AVAILABLE'), 7);
  assert.equal(sum(rows, (r) => r.status === 'IN_TRANSIT'), 3);
  assert.equal(sum(rows, (r) => r.pool_id === pool(meta, 'SHARED') && r.status === 'AVAILABLE'), 0);

  const availableInShared = await admin.get(`/api/inventory/availability?productId=${product.id}&poolId=${pool(meta, 'SHARED')}`);
  assert.equal(availableInShared.body.data.available, 0);

  const received = await manager.post(`/api/transfers/${transferId}/receive`, {}, idem());
  expectedStatus(received, 200, 'receive transfer');
  rows = await balances(product.id);
  assert.equal(sum(rows, (r) => r.pool_id === pool(meta, 'B2B') && r.status === 'AVAILABLE'), 7);
  assert.equal(sum(rows, (r) => r.pool_id === pool(meta, 'SHARED') && r.status === 'AVAILABLE'), 3);
  assert.equal(sum(rows, (r) => r.status === 'IN_TRANSIT'), 0);

  const transfer = await admin.get(`/api/transfers/${transferId}`);
  assert.equal(transfer.body.data.status, 'COMPLETED');
  const ledger = await admin.get(`/api/inventory/ledger?productId=${product.id}&limit=100`);
  const transfers = ledger.body.data.rows.filter((r: any) => r.movement_type.startsWith('TRANSFER_'));
  assert.deepEqual(transfers.map((r: any) => r.movement_type).sort(), ['TRANSFER_DISPATCH', 'TRANSFER_RECEIVE']);
});

test('returned goods are inspected and split into restock and damage without becoming sellable early', async () => {
  const product = await createProduct(admin, { name: 'Return Inspection Drops' });
  const { order } = await shippedOrder(product.id, 2);

  const tooMany = await manager.post(
    '/api/returns',
    { orderId: order.id, reason: 'Customer reported damage', lines: [{ productId: product.id, quantity: 3 }] },
    idem(),
  );
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, 'RETURN_EXCEEDS_DISPATCH');

  const created = await manager.post(
    '/api/returns',
    { orderId: order.id, reason: 'Customer reported damage', lines: [{ productId: product.id, quantity: 2 }] },
    idem(),
  );
  expectedStatus(created, 201, 'create return');
  const returnId = created.body.data.id as string;

  let rows = await balances(product.id);
  assert.equal(sum(rows, (r) => r.status === 'RETURN_PENDING'), 2);
  assert.equal(sum(rows, (r) => r.status === 'AVAILABLE'), 0);

  const returnDetail = await admin.get(`/api/returns/${returnId}`);
  const returnLine = returnDetail.body.data.lines[0];

  const partial = await manager.post(
    `/api/returns/${returnId}/inspect`,
    { lines: [{ returnLineId: returnLine.id, restockQty: 1 }] },
    idem(),
  );
  assert.equal(partial.status, 409);
  assert.equal(partial.body.error.code, 'INSPECTION_QUANTITY_MISMATCH');

  const inspected = await manager.post(
    `/api/returns/${returnId}/inspect`,
    { lines: [{ returnLineId: returnLine.id, restockQty: 1, damagedQty: 1 }] },
    idem(),
  );
  expectedStatus(inspected, 200, 'inspect return');
  assert.equal(inspected.body.data.status, 'COMPLETED');
  assert.equal(inspected.body.data.disposition, 'PARTIAL');

  rows = await balances(product.id);
  assert.equal(sum(rows, (r) => r.status === 'RETURN_PENDING'), 0);
  assert.equal(sum(rows, (r) => r.status === 'AVAILABLE'), 1);
  assert.equal(sum(rows, (r) => r.status === 'DAMAGED'), 1);
  const availableResponse = await admin.get(`/api/inventory/availability?productId=${product.id}`);
  assert.equal(availableResponse.body.data.available, 1);
});

test('a cycle count posts only approved differences and reconciles the ledger (Acceptance L)', async () => {
  const productA = await createProduct(admin, { name: 'Count Shortage Capsules' });
  const productB = await createProduct(admin, { name: 'Count Surplus Ointment' });
  await stockInPool(productA.id, 10, 'B2B', 'RACK-A02');
  await stockInPool(productB.id, 5, 'B2B', 'RACK-A02');

  const created = await manager.post(
    '/api/cycle-counts',
    { countType: 'LOCATION', locationId: loc(meta, 'RACK-A02'), notes: 'Scheduled aisle count' },
    idem(),
  );
  expectedStatus(created, 201, 'create count');
  const countId = created.body.data.id as string;
  const count = await admin.get(`/api/cycle-counts/${countId}`);
  assert.equal(count.body.data.status, 'DRAFT');
  assert.equal(count.body.data.lines.length, 2);

  const lineA = count.body.data.lines.find((l: any) => l.product_id === productA.id);
  const lineB = count.body.data.lines.find((l: any) => l.product_id === productB.id);
  assert.ok(lineA && lineB);
  assert.equal(lineA.system_qty, 10);
  assert.equal(lineB.system_qty, 5);

  const recorded = await manager.post(
    `/api/cycle-counts/${countId}/count`,
    {
      lines: [
        { lineId: lineA.id, countedQty: 7, reason: 'Three strips missing from the shelf' },
        { lineId: lineB.id, countedQty: 7, reason: 'Two extra units found behind the rack' },
      ],
    },
    idem(),
  );
  expectedStatus(recorded, 200, 'record counts');

  const submitted = await manager.post(`/api/cycle-counts/${countId}/submit`, {}, idem());
  expectedStatus(submitted, 200, 'submit count');
  assert.equal(submitted.body.data.status, 'PENDING_APPROVAL');

  const beforeApproval = await balances(productA.id);
  assert.equal(sum(beforeApproval, () => true), 10);

  const approved = await admin.post(`/api/cycle-counts/${countId}/approve`, {}, idem());
  expectedStatus(approved, 200, 'approve count');
  assert.equal(approved.body.data.status, 'POSTED');

  const rowsA = await balances(productA.id);
  const rowsB = await balances(productB.id);
  assert.equal(sum(rowsA, () => true), 7);
  assert.equal(sum(rowsB, () => true), 7);

  const ledgerA = await admin.get(`/api/inventory/ledger?productId=${productA.id}&limit=100`);
  const out = ledgerA.body.data.rows.filter((r: any) => r.movement_type === 'ADJUSTMENT_OUT');
  assert.equal(out.length, 1);
  assert.equal(out[0].quantity, 3);
  assert.equal(out[0].reference_id, countId);
  const ledgerB = await admin.get(`/api/inventory/ledger?productId=${productB.id}&limit=100`);
  const incoming = ledgerB.body.data.rows.filter((r: any) => r.movement_type === 'ADJUSTMENT_IN');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].quantity, 2);

  const posted = await admin.get(`/api/cycle-counts/${countId}`);
  assert.equal(posted.body.data.status, 'POSTED');
  assert.equal(posted.body.data.exceptions.length, 2);
  for (const line of posted.body.data.lines) {
    assert.ok(line.adjustment_txn_id);
    assert.equal(line.investigation_status, 'OPEN');
  }

  const reconciliation = await admin.get('/api/inventory/reconciliation');
  expectedStatus(reconciliation, 200, 'reconciliation');
  assert.equal(reconciliation.body.data.ok, true, JSON.stringify(reconciliation.body.data.checks));
});

test('adjustment corrections are posted through reversal and high-value adjustments need a second approver (Acceptance J)', async () => {
  const product = await createProduct(admin, { name: 'Adjustment Audit Powder' });
  await stockInPool(product.id, 10, 'B2B', 'RACK-A02');

  const adjustment = await manager.post(
    '/api/adjustments',
    {
      productId: product.id,
      locationId: loc(meta, 'RACK-A02'),
      poolId: pool(meta, 'B2B'),
      direction: 'OUT',
      quantity: 2,
      reason: 'Two units damaged during shelf handling',
    },
    idem(),
  );
  expectedStatus(adjustment, 201, 'post low-value adjustment');
  assert.equal(adjustment.body.data.status, 'POSTED');
  const transactionId = adjustment.body.data.transactionId as string;

  let rows = await balances(product.id);
  assert.equal(sum(rows, () => true), 8);

  const reversed = await admin.post(
    `/api/inventory/transactions/${transactionId}/reverse`,
    { reason: 'Correction: damage was recorded against the wrong SKU' },
    idem(),
  );
  expectedStatus(reversed, 200, 'reverse adjustment');
  rows = await balances(product.id);
  assert.equal(sum(rows, () => true), 10);

  const again = await admin.post(
    `/api/inventory/transactions/${transactionId}/reverse`,
    { reason: 'Attempt to reverse the same transaction twice' },
    idem(),
  );
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_REVERSED');

  const ledger = await admin.get(`/api/inventory/ledger?productId=${product.id}&limit=100`);
  const all = ledger.body.data.rows;
  const original = all.find((r: any) => r.id === transactionId);
  assert.ok(original);
  assert.equal(original.movement_type, 'ADJUSTMENT_OUT');
  assert.equal(original.quantity, 2);
  const correction = all.find((r: any) => r.reversal_of === transactionId);
  assert.ok(correction);
  assert.equal(correction.movement_type, 'ADJUSTMENT_IN');
  assert.equal(correction.quantity, 2);

  const large = await manager.post(
    '/api/adjustments',
    {
      productId: product.id,
      locationId: loc(meta, 'RACK-A02'),
      poolId: pool(meta, 'B2B'),
      direction: 'IN',
      quantity: 60,
      reason: 'Bulk stock found in unlabelled packaging',
    },
    idem(),
  );
  expectedStatus(large, 201, 'request high-value adjustment');
  assert.equal(large.body.data.status, 'PENDING_APPROVAL');

  const selfApproval = await manager.post(`/api/adjustments/${large.body.data.id}/approve`, {}, idem());
  assert.equal(selfApproval.status, 403);

  const approved = await admin.post(`/api/adjustments/${large.body.data.id}/approve`, {}, idem());
  expectedStatus(approved, 200, 'second approver posts adjustment');
  assert.equal(approved.body.data.status, 'POSTED');
  rows = await balances(product.id);
  assert.equal(sum(rows, () => true), 70);
});


test('only B2B and SHARED pools are supported', async () => {
  assert.equal(isSupportedPoolCode('B2B'), true);
  assert.equal(isSupportedPoolCode('SHARED'), true);
  assert.equal(isSupportedPoolCode('B2C'), false);
  const refreshed = await getMeta(admin);
  assert.deepEqual(
    refreshed.pools.map((entry) => entry.code).filter((code) => !isSupportedPoolCode(code)),
    [],
  );
});
