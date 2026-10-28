import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, expectedStatus, idem, type Harness } from './helpers.ts';
import { createProduct, createVendor, getMeta, loc, pool, receiveStock, type Meta } from './flows.ts';

let harness: Harness;
let meta: Meta;
let admin: Awaited<ReturnType<Harness['client']>>;
let qcUser: Awaited<ReturnType<Harness['client']>>;
let vendorId: string;

before(async () => {
  harness = await createHarness();
  admin = await harness.client('admin@aaradhya.local');
  qcUser = await harness.client('qc@aaradhya.local');
  meta = await getMeta(admin);
  vendorId = await createVendor(admin, 'Aaradhya Supplier');
});

after(async () => {
  await harness.close();
});

test('partial putaway moves exactly the accepted quantity and empties the source', async () => {
  const product = await createProduct(admin, { name: 'Putaway Test Tablets', qcRequired: true });
  const received = await receiveStock(admin, {
    productId: product.id,
    quantity: 50,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 50 },
  });
  const first = await admin.post(
    '/api/putaway',
    {
      receiptId: received.receiptId,
      productId: product.id,
      batchId: null,
      quantity: 30,
      toLocationId: loc(meta, 'RACK-A01'),
    },
    idem(),
  );
  expectedStatus(first, 200, 'putaway 30');
  const second = await admin.post(
    '/api/putaway',
    {
      receiptId: received.receiptId,
      productId: product.id,
      batchId: null,
      quantity: 20,
      toLocationId: loc(meta, 'RACK-A02'),
    },
    idem(),
  );
  expectedStatus(second, 200, 'putaway 20');
  assert.equal(second.body.data.remainingToPutaway, 0);

  const rackA01 = await admin.get(`/api/inventory/balances?locationId=${loc(meta, 'RACK-A01')}&productId=${product.id}`);
  expectedStatus(rackA01, 200);
  assert.equal(rackA01.body.data.rows.reduce((s: number, r: any) => s + r.quantity, 0), 30);

  const rackA02 = await admin.get(`/api/inventory/balances?locationId=${loc(meta, 'RACK-A02')}&productId=${product.id}`);
  assert.equal(rackA02.body.data.rows.reduce((s: number, r: any) => s + r.quantity, 0), 20);

  const staging = await admin.get(`/api/inventory/balances?locationId=${loc(meta, 'STAGING-01')}&productId=${product.id}`);
  assert.equal(staging.body.data.rows.reduce((s: number, r: any) => s + r.quantity, 0), 0);

  const ledger = await admin.get(`/api/inventory/ledger?productId=${product.id}`);
  const putaways = ledger.body.data.rows.filter((r: any) => r.movement_type === 'PUTAWAY');
  assert.equal(putaways.length, 2);
  assert.equal(putaways.reduce((s: number, r: any) => s + r.quantity, 0), 50);
});

test('QC rejection keeps rejected units non-sellable and reconciles quantities', async () => {
  const product = await createProduct(admin, { name: 'QC Rejection Capsules', qcRequired: true });
  const received = await receiveStock(admin, {
    productId: product.id,
    quantity: 100,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 95, rejected: 5, notes: 'Five units damaged in transit' },
    qcClient: qcUser,
  });

  const available = await admin.get(`/api/inventory/availability?productId=${product.id}`);
  expectedStatus(available, 200);
  assert.equal(available.body.data.available, 95);

  const balances = await admin.get(`/api/inventory/balances?productId=${product.id}`);
  const byStatus = new Map(balances.body.data.rows.map((r: any) => [r.status, r.quantity]));
  assert.equal(byStatus.get('AVAILABLE'), 95);
  assert.equal(byStatus.get('REJECTED'), 5);

  const receipt = await admin.get(`/api/receipts/${received.receiptId}`);
  assert.equal(receipt.body.data.lines[0].accepted_qty, 95);
  assert.equal(receipt.body.data.lines[0].rejected_qty, 5);
  assert.equal(receipt.body.data.inspections.length, 1);

  const rejectedSellable = await admin.get(`/api/inventory/availability?productId=${product.id}`);
  assert.ok(rejectedSellable.body.data.available < 100);
});

test('duplicate receipt submission is rejected by idempotency without double stock', async () => {
  const product = await createProduct(admin, { name: 'Idempotent Receipt Syrup' });
  const po = await admin.post('/api/purchase-orders', {
    vendorId,
    lines: [{ productId: product.id, orderedQty: 10 }],
  });
  expectedStatus(po, 201);
  await admin.post(`/api/purchase-orders/${po.body.data.id}/approve`);

  const payload = {
    poId: po.body.data.id,
    stagingLocationId: loc(meta, 'STAGING-01'),
    poolId: pool(meta, 'B2B'),
    lines: [{ productId: product.id, quantity: 10 }],
  };
  const key = idem();
  const first = await admin.post('/api/receipts', payload, key);
  expectedStatus(first, 201);
  const second = await admin.post('/api/receipts', payload, key);
  expectedStatus(second, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.equal(second.body.data.receiptNo, first.body.data.receiptNo);

  const balances = await admin.get(`/api/inventory/balances?productId=${product.id}`);
  const onHand = balances.body.data.rows.reduce((s: number, r: any) => s + r.quantity, 0);
  assert.equal(onHand, 10);
});

test('excess receipt requires the approval permission and a documented reason', async () => {
  const product = await createProduct(admin, { name: 'Excess Receipt Powder' });
  const po = await admin.post('/api/purchase-orders', {
    vendorId,
    lines: [{ productId: product.id, orderedQty: 5 }],
  });
  await admin.post(`/api/purchase-orders/${po.body.data.id}/approve`);
  const payload = {
    poId: po.body.data.id,
    stagingLocationId: loc(meta, 'STAGING-01'),
    poolId: pool(meta, 'B2B'),
    lines: [{ productId: product.id, quantity: 8 }],
  };

  const blocked = await admin.post('/api/receipts', payload, idem());
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'EXCESS_RECEIPT');

  const qcOnly = await qcUser.post(
    '/api/receipts',
    { ...payload, allowExcess: true, excessReason: 'Supplier shipped a larger lot' },
    idem(),
  );
  assert.equal(qcOnly.status, 403);

  const noReason = await admin.post(
    '/api/receipts',
    { ...payload, allowExcess: true },
    idem(),
  );
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'EXCESS_REASON_REQUIRED');

  const approved = await admin.post(
    '/api/receipts',
    { ...payload, allowExcess: true, excessReason: 'Supplier shipped a larger lot' },
    idem(),
  );
  expectedStatus(approved, 201, 'approved excess receipt');

  const balances = await admin.get(`/api/inventory/balances?productId=${product.id}`);
  const onHand = balances.body.data.rows.reduce((s: number, r: any) => s + r.quantity, 0);
  assert.equal(onHand, 8);
});
