import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createHarness, expectedStatus } from './helpers.ts';
import { createProduct, createVendor, getMeta, loc, pool, receiveStock } from './flows.ts';

test('inventory overview reports every stocked location and reconciles with balances', async () => {
  const harness = await createHarness();
  try {
    const admin = await harness.client();
    const meta = await getMeta(admin);
    const product = await createProduct(admin, {
      name: 'Overview Syrup',
      sku: `OV-${randomUUID().slice(0, 8)}`,
    });
    const vendor = await createVendor(admin, 'Overview Vendor');
    await receiveStock(admin, {
      productId: product.id,
      quantity: 12,
      vendorId: vendor,
      poolId: pool(meta, 'SHARED'),
      stagingLocationId: loc(meta, 'STAGING-01'),
      putaway: { locationId: loc(meta, 'RACK-A01') },
    });

    const response = await admin.get('/api/inventory/overview');
    expectedStatus(response, 200, 'inventory overview');
    const overview = response.body.data;

    assert.equal(overview.totals.totalUnits, 12);
    assert.equal(overview.totals.availableUnits, 12);
    assert.equal(overview.totals.skuCount, 1);
    assert.equal(overview.totals.locationCount, 1);
    assert.equal(overview.totals.lowStock, 1);
    assert.equal(overview.totals.expiringSoon, 0);

    const rack = overview.locations.find((row: any) => row.code === 'RACK-A01');
    assert.ok(rack, 'RACK-A01 should appear in the location breakdown');
    assert.equal(rack.quantity, 12);
    assert.equal(rack.available, 12);
    assert.equal(rack.skuCount, 1);
    assert.equal(rack.type, 'RACK');

    const balances = await admin.get('/api/inventory/balances?limit=500');
    expectedStatus(balances, 200, 'balances');
    const balanceTotal = balances.body.data.rows.reduce(
      (sum: number, row: any) => sum + Number(row.quantity),
      0,
    );
    assert.equal(overview.totals.totalUnits, balanceTotal);
  } finally {
    await harness.close();
  }
});
