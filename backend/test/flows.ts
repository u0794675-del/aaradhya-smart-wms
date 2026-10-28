import assert from 'node:assert/strict';
import type { ApiClient } from './helpers.ts';
import { expectedStatus, idem } from './helpers.ts';

export interface Meta {
  warehouse: { id: string; code: string; name: string };
  locations: Array<{ id: string; code: string; type: string; status: string }>;
  pools: Array<{ id: string; code: string; name: string }>;
}

export async function getMeta(client: ApiClient): Promise<Meta> {
  const response = await client.get('/api/meta');
  expectedStatus(response, 200, 'meta');
  return response.body.data;
}

export function loc(meta: Meta, code: string): string {
  const location = meta.locations.find((l) => l.code === code);
  if (!location) throw new Error(`Location ${code} missing from bootstrap`);
  return location.id;
}

export function pool(meta: Meta, code: string): string {
  const entry = meta.pools.find((p) => p.code === code);
  if (!entry) throw new Error(`Pool ${code} missing from bootstrap`);
  return entry.id;
}

export async function createProduct(
  client: ApiClient,
  input: Partial<Record<string, unknown>> & { name: string },
) {
  const response = await client.post('/api/products', {
    baseUom: 'PIECE',
    isBatchTracked: false,
    isExpiryTracked: false,
    qcRequired: true,
    ...input,
  });
  expectedStatus(response, 201, `create product ${input.name}`);
  return response.body.data.product as Record<string, any>;
}

export async function createVendor(client: ApiClient, name = 'Default Vendor'): Promise<string> {
  const response = await client.post('/api/vendors', { name, gstin: '27AAAAA0000A1Z5' });
  expectedStatus(response, 201, 'create vendor');
  return response.body.data.id as string;
}

export async function createPurchaseOrder(
  client: ApiClient,
  input: { vendorId: string; lines: Array<{ productId: string; orderedQty: number; unitCost?: number }> },
): Promise<{ id: string; poNo: string }> {
  const created = await client.post('/api/purchase-orders', input);
  expectedStatus(created, 201, 'create PO');
  const approved = await client.post(`/api/purchase-orders/${created.body.data.id}/approve`);
  expectedStatus(approved, 200, 'approve PO');
  return created.body.data;
}

export interface ReceiveOptions {
  productId: string;
  quantity: number;
  vendorId: string;
  poolId: string;
  stagingLocationId: string;
  batchNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  qc?: { accepted: number; rejected?: number; quarantined?: number; notes?: string };
  qcClient?: ApiClient;
  putawayClient?: ApiClient;
  putaway?: { locationId: string; boxId?: string | null; quantity?: number };
}

export async function receiveStock(client: ApiClient, options: ReceiveOptions) {
  const po = await createPurchaseOrder(client, {
    vendorId: options.vendorId,
    lines: [{ productId: options.productId, orderedQty: options.quantity }],
  });
  const response = await client.post(
    '/api/receipts',
    {
      poId: po.id,
      stagingLocationId: options.stagingLocationId,
      poolId: options.poolId,
      vendorInvoiceRef: `INV-${Date.now()}`,
      lines: [
        {
          productId: options.productId,
          quantity: options.quantity,
          ...(options.batchNo
            ? { batchNo: options.batchNo, mfgDate: options.mfgDate, expiryDate: options.expiryDate }
            : {}),
        },
      ],
    },
    idem(),
  );
  expectedStatus(response, 201, 'create receipt');
  const receiptId = response.body.data.id as string;
  let receipt = await client.get(`/api/receipts/${receiptId}`);
  expectedStatus(receipt, 200, 'get receipt');
  const line = receipt.body.data.lines[0];
  assert.ok(line, 'receipt should have a line');

  if (line.qc_status === 'PENDING') {
    const qc = options.qc ?? { accepted: options.quantity };
    const inspect = await (options.qcClient ?? client).post(
      `/api/receipts/${receiptId}/lines/${line.id}/inspect`,
      {
        acceptedQty: qc.accepted,
        rejectedQty: qc.rejected ?? 0,
        quarantinedQty: qc.quarantined ?? 0,
        notes: qc.notes ?? 'Acceptance test inspection',
      },
      idem(),
    );
    expectedStatus(inspect, 200, 'QC inspect');
  }

  let putawayResult: any = null;
  if (options.putaway) {
    const putawayResponse = await (options.putawayClient ?? client).post(
      '/api/putaway',
      {
        receiptId,
        productId: options.productId,
        batchId: line.batch_id,
        quantity: options.putaway.quantity ?? options.quantity,
        toLocationId: options.putaway.locationId,
        boxId: options.putaway.boxId ?? null,
      },
      idem(),
    );
    expectedStatus(putawayResponse, 200, 'putaway');
    putawayResult = putawayResponse.body.data;
  }

  receipt = await client.get(`/api/receipts/${receiptId}`);
  return {
    receiptId,
    receiptNo: response.body.data.receiptNo as string,
    line: receipt.body.data.lines[0],
    poId: po.id,
    poNo: po.poNo,
    putaway: putawayResult,
  };
}

export async function createMixedBox(
  client: ApiClient,
  input: { locationId: string; poolId: string; boxType?: 'SINGLE' | 'MIXED' },
): Promise<{ id: string; boxCode: string }> {
  const response = await client.post('/api/boxes', {
    boxType: input.boxType ?? 'MIXED',
    locationId: input.locationId,
    poolId: input.poolId,
  });
  expectedStatus(response, 201, 'create box');
  return response.body.data;
}

export async function boxDetail(client: ApiClient, boxId: string) {
  const response = await client.get(`/api/boxes/${boxId}`);
  expectedStatus(response, 200, 'box detail');
  return response.body.data;
}

export async function createOrder(
  client: ApiClient,
  input: {
    productId: string;
    quantity: number;
    poolCode?: 'B2B' | 'SHARED';
    channel?: 'MANUAL' | 'MARKETPLACE' | 'B2B';
    boxId?: string | null;
    customerName?: string;
  },
): Promise<{ id: string; orderNo: string }> {
  const response = await client.post(
    '/api/orders',
    {
      channel: input.channel ?? 'B2B',
      poolCode: input.poolCode,
      customerName: input.customerName ?? 'Acceptance Customer',
      lines: [{ productId: input.productId, quantity: input.quantity, boxId: input.boxId ?? null }],
    },
    idem(),
  );
  expectedStatus(response, 201, 'create order');
  return response.body.data;
}

export async function confirmAndAllocate(client: ApiClient, orderId: string) {
  const confirmed = await client.post(`/api/orders/${orderId}/confirm`, {}, idem());
  expectedStatus(confirmed, 200, 'confirm order');
  const allocated = await client.post(`/api/orders/${orderId}/allocate`, {}, idem());
  expectedStatus(allocated, 200, 'allocate order');
  return allocated.body.data;
}

export async function orderDetail(client: ApiClient, orderId: string) {
  const response = await client.get(`/api/orders/${orderId}`);
  expectedStatus(response, 200, 'order detail');
  return response.body.data;
}
