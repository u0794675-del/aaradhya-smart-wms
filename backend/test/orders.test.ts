import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, expectedStatus, idem, type Harness } from './helpers.ts';
import {
  boxDetail,
  confirmAndAllocate,
  createMixedBox,
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
let picker: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  picker = await harness.client('picker@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Fulfilment Supplier');
});

after(async () => {
  await harness.close();
});

async function stock(
  productId: string,
  quantity: number,
  options: { boxId?: string; locationCode?: string; batchNo?: string; expiryDate?: string; poolCode?: 'B2B' | 'SHARED' } = {},
) {
  return receiveStock(admin, {
    productId,
    quantity,
    vendorId,
    poolId: pool(meta, options.poolCode ?? 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    batchNo: options.batchNo,
    expiryDate: options.expiryDate,
    qc: { accepted: quantity },
    putaway: {
      locationId: loc(meta, options.locationCode ?? 'RACK-A02'),
      boxId: options.boxId ?? null,
    },
  });
}

async function balances(productId: string) {
  const response = await admin.get(`/api/inventory/balances?productId=${productId}`);
  expectedStatus(response, 200, 'balances');
  return response.body.data.rows as Array<Record<string, any>>;
}

async function available(productId: string) {
  const response = await admin.get(`/api/inventory/availability?productId=${productId}`);
  expectedStatus(response, 200, 'availability');
  return Number(response.body.data.available);
}

async function ledger(productId: string) {
  const response = await admin.get(`/api/inventory/ledger?productId=${productId}&limit=300`);
  expectedStatus(response, 200, 'ledger');
  return response.body.data.rows as Array<Record<string, any>>;
}

test('mixed-box pick consumes only the scanned SKU and requires a correct scan (Acceptance A)', async () => {
  const productA = await createProduct(admin, { name: 'Mixed Box Tablets' });
  const productB = await createProduct(admin, { name: 'Mixed Box Drops' });
  const productC = await createProduct(admin, { name: 'Mixed Box Ointment' });
  const mixed = await createMixedBox(admin, { locationId: loc(meta, 'RACK-A01'), poolId: pool(meta, 'B2B') });
  const otherBox = await createMixedBox(admin, { locationId: loc(meta, 'RACK-A01'), poolId: pool(meta, 'B2B') });
  await stock(productA.id, 10, { boxId: mixed.id, locationCode: 'RACK-A01' });
  await stock(productB.id, 5, { boxId: mixed.id, locationCode: 'RACK-A01' });
  await stock(productC.id, 8, { boxId: mixed.id, locationCode: 'RACK-A01' });

  const order = await createOrder(admin, { productId: productA.id, quantity: 1, boxId: mixed.id });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const line = detail.lines[0];
  const reservation = detail.reservations.find((r: any) => r.status === 'ACTIVE');
  assert.ok(reservation);
  assert.equal(reservation.box_id, mixed.id);

  const unscanned = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: line.id, quantity: 1 }] },
    idem(),
  );
  assert.equal(unscanned.status, 409);
  assert.equal(unscanned.body.error.code, 'BOX_SCAN_REQUIRED');

  const wrongBox = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: line.id, quantity: 1, scannedBoxId: otherBox.id }] },
    idem(),
  );
  assert.equal(wrongBox.status, 409);
  assert.equal(wrongBox.body.error.code, 'WRONG_BOX_SCANNED');

  const pick = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: line.id, quantity: 1, scannedBoxId: mixed.boxCode }] },
    idem(),
  );
  expectedStatus(pick, 200, 'pick from mixed box');

  const box = await boxDetail(admin, mixed.id);
  const bySku = new Map(box.contents.map((c: any) => [c.sku, Number(c.quantity)]));
  assert.equal(bySku.get(productA.sku), 9);
  assert.equal(bySku.get(productB.sku), 5);
  assert.equal(bySku.get(productC.sku), 8);

  const moves = (await ledger(productA.id)).filter((r) => r.movement_type === 'PICK');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].quantity, 1);
  assert.equal(moves[0].reference_id, order.id);
  assert.equal(moves[0].from_box_id, mixed.id);
});

test('concurrent picks cannot deduct the same box stock twice (Acceptance B)', async () => {
  const product = await createProduct(admin, { name: 'Concurrent Pick Capsules' });
  const box = await createMixedBox(admin, { locationId: loc(meta, 'RACK-A01'), poolId: pool(meta, 'B2B') });
  await stock(product.id, 10, { boxId: box.id, locationCode: 'RACK-A01' });
  const order = await createOrder(admin, { productId: product.id, quantity: 10, boxId: box.id });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);

  const call = () =>
    picker.post(
      `/api/orders/${order.id}/pick`,
      {
        lines: [
          {
            orderLineId: detail.lines[0].id,
            quantity: 10,
            scannedBoxId: box.id,
          },
        ],
      },
      idem(),
    );
  const responses = await Promise.all([call(), call()]);
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const failed = responses.find((r) => r.status === 409);
  assert.ok(failed);

  const boxAfter = await boxDetail(admin, box.id);
  assert.equal(boxAfter.totals.total, 0);
  assert.equal(boxAfter.box.status, 'EMPTY');
  const picks = (await ledger(product.id)).filter((r) => r.movement_type === 'PICK');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].quantity, 10);
  assert.equal(await available(product.id), 0);
});

test('duplicate pick submission is idempotent and deducts stock exactly once (Acceptance C)', async () => {
  const product = await createProduct(admin, { name: 'Idempotent Pick Syrup' });
  const box = await createMixedBox(admin, { locationId: loc(meta, 'RACK-A01'), poolId: pool(meta, 'B2B') });
  await stock(product.id, 4, { boxId: box.id, locationCode: 'RACK-A01' });
  const order = await createOrder(admin, { productId: product.id, quantity: 2, boxId: box.id });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const payload = {
    lines: [{ orderLineId: detail.lines[0].id, quantity: 2, scannedBoxId: box.id }],
  };
  const key = idem();
  const first = await picker.post(`/api/orders/${order.id}/pick`, payload, key);
  expectedStatus(first, 200, 'first pick');
  const second = await picker.post(`/api/orders/${order.id}/pick`, payload, key);
  expectedStatus(second, 200, 'replayed pick');
  assert.equal(second.headers.get('idempotent-replayed'), 'true');

  const picks = (await ledger(product.id)).filter((r) => r.movement_type === 'PICK');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].quantity, 2);
  const boxAfter = await boxDetail(admin, box.id);
  assert.equal(boxAfter.totals.total, 2);
});

test('reservations prevent overselling and cancellation releases them (Acceptance G)', async () => {
  const product = await createProduct(admin, { name: 'Reserved Stock Drops' });
  await stock(product.id, 5);
  assert.equal(await available(product.id), 5);

  const first = await createOrder(admin, { productId: product.id, quantity: 5 });
  await confirmAndAllocate(admin, first.id);
  assert.equal(await available(product.id), 0);

  const second = await createOrder(admin, { productId: product.id, quantity: 1 });
  await admin.post(`/api/orders/${second.id}/confirm`, {}, idem());
  const oversold = await admin.post(`/api/orders/${second.id}/allocate`, {}, idem());
  assert.equal(oversold.status, 409);
  assert.equal(oversold.body.error.code, 'INSUFFICIENT_STOCK');

  const cancelled = await admin.post(`/api/orders/${first.id}/cancel`, { reason: 'Customer changed the order' }, idem());
  expectedStatus(cancelled, 200, 'cancel reservation');
  assert.equal(cancelled.body.data.releasedReservations, 5);
  assert.equal(await available(product.id), 5);

  const retry = await admin.post(`/api/orders/${second.id}/allocate`, {}, idem());
  expectedStatus(retry, 200, 'allocate after release');
  assert.equal(await available(product.id), 4);
});

test('cancelling a picked order reverses the pick and restores stock (Acceptance H)', async () => {
  const product = await createProduct(admin, { name: 'Cancelled Pick Ointment' });
  await stock(product.id, 3);
  const order = await createOrder(admin, { productId: product.id, quantity: 3 });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const pick = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: detail.lines[0].id, quantity: 3 }] },
    idem(),
  );
  expectedStatus(pick, 200, 'pick before cancel');
  assert.equal(await available(product.id), 0);
  const pickedRows = (await balances(product.id)).filter((r) => r.status === 'PICKED');
  assert.equal(pickedRows.reduce((s, r) => s + Number(r.quantity), 0), 3);

  const cancelled = await admin.post(
    `/api/orders/${order.id}/cancel`,
    { reason: 'Customer cancelled while packing' },
    idem(),
  );
  expectedStatus(cancelled, 200, 'cancel picked order');
  assert.equal(cancelled.body.data.reversedPicks, 1);

  assert.equal(await available(product.id), 3);
  const after = await balances(product.id);
  assert.equal(after.filter((r) => r.status === 'PICKED').reduce((s, r) => s + Number(r.quantity), 0), 0);

  const moves = await ledger(product.id);
  const original = moves.find((r) => r.movement_type === 'PICK');
  assert.ok(original);
  const reversal = moves.find((r) => r.movement_type === 'PICK_REVERSAL');
  assert.ok(reversal);
  assert.equal(reversal.reversal_of, original.id);
  assert.equal(reversal.quantity, 3);
});

test('expired batch stock cannot be allocated from a box (Acceptance I)', async () => {
  const product = await createProduct(admin, {
    name: 'Expired Batch Tablets',
    isBatchTracked: true,
    isExpiryTracked: true,
  });
  const box = await createMixedBox(admin, { locationId: loc(meta, 'RACK-A01'), poolId: pool(meta, 'B2B') });
  await stock(product.id, 10, {
    boxId: box.id,
    locationCode: 'RACK-A01',
    batchNo: 'EXP-LOT-1',
    expiryDate: '2020-01-31',
  });

  const onHand = (await balances(product.id)).reduce((s, r) => s + Number(r.quantity), 0);
  assert.equal(onHand, 10);
  assert.equal(await available(product.id), 0);

  const order = await createOrder(admin, { productId: product.id, quantity: 1, boxId: box.id });
  await admin.post(`/api/orders/${order.id}/confirm`, {}, idem());
  const blocked = await admin.post(`/api/orders/${order.id}/allocate`, {}, idem());
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'EXPIRED_STOCK_BLOCKED');

  const detail = await orderDetail(admin, order.id);
  assert.equal(detail.reservations.length, 0);
  assert.equal(detail.status, 'CONFIRMED');
});

test('a complete order can be packed and dispatched with an auditable shipment', async () => {
  const product = await createProduct(admin, { name: 'Dispatch Lifecycle Capsules' });
  await stock(product.id, 4);
  const order = await createOrder(admin, { productId: product.id, quantity: 4 });
  await confirmAndAllocate(admin, order.id);
  const detail = await orderDetail(admin, order.id);
  const pick = await picker.post(
    `/api/orders/${order.id}/pick`,
    { lines: [{ orderLineId: detail.lines[0].id, quantity: 4 }] },
    idem(),
  );
  expectedStatus(pick, 200, 'pick');
  assert.equal(pick.body.data.status, 'PICKED');

  const partial = await picker.post(
    `/api/orders/${order.id}/pack`,
    { packages: [{ lines: [{ orderLineId: detail.lines[0].id, quantity: 2 }] }] },
    idem(),
  );
  assert.equal(partial.status, 409);
  assert.equal(partial.body.error.code, 'PACK_INCOMPLETE');
  const afterPartial = await orderDetail(admin, order.id);
  assert.equal(afterPartial.status, 'PICKED');
  assert.equal(afterPartial.packages.length, 0);

  const packed = await picker.post(`/api/orders/${order.id}/pack`, {}, idem());
  expectedStatus(packed, 200, 'pack');
  assert.equal(packed.body.data.status, 'PACKED');
  assert.equal(packed.body.data.packages.length, 1);

  const dispatched = await admin.post(
    `/api/orders/${order.id}/dispatch`,
    { carrier: 'Aaradhya Express', trackingNo: 'AWB-10001' },
    idem(),
  );
  expectedStatus(dispatched, 200, 'dispatch');
  assert.match(dispatched.body.data.shipmentNo, /^SHP-/);

  const finalOrder = await orderDetail(admin, order.id);
  assert.equal(finalOrder.status, 'DISPATCHED');
  assert.equal(finalOrder.packages[0].status, 'DISPATCHED');
  assert.equal(finalOrder.shipments.length, 1);
  assert.equal(finalOrder.shipments[0].tracking_no, 'AWB-10001');

  const shipment = await admin.get(`/api/shipments/${dispatched.body.data.shipmentNo}`);
  expectedStatus(shipment, 200, 'shipment detail');
  assert.equal(shipment.body.data.order.id, order.id);

  assert.equal(await available(product.id), 0);
  const remaining = (await balances(product.id)).reduce((s, r) => s + Number(r.quantity), 0);
  assert.equal(remaining, 0);
  const moves = (await ledger(product.id)).filter((r) => r.movement_type === 'DISPATCH');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].quantity, 4);
  assert.equal(moves[0].reference_id, order.id);
});
