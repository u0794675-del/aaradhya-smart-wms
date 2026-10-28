import type { DB } from '../db/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { addHours, nowIso, todayIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { createBatch, convertToBase, type Uom } from './products.ts';
import { postMovement } from './inventory.ts';
import { completeTask, createTask } from './tasks.ts';

interface VendorInput {
  name: string;
  vendorCode?: string;
  gstin?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  paymentTerms?: string | null;
  leadTimeDays?: number | null;
  minOrderQty?: number | null;
}

export function createVendor(db: DB, input: VendorInput, actor: AuthUser): string {
  const name = input.name.trim();
  if (!name) throw badRequest('VENDOR_NAME_REQUIRED', 'Vendor name is required');
  const code = (input.vendorCode?.trim().toUpperCase() || documentNo(db, 'VENDOR', 'VEN', 4));
  if (db.prepare('SELECT id FROM vendors WHERE vendor_code = ?').get(code)) {
    throw conflict('VENDOR_CODE_EXISTS', `Vendor code ${code} already exists`);
  }
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO vendors (id, vendor_code, name, gstin, contact_name, email, phone, address, payment_terms,
                          lead_time_days, min_order_qty, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
  ).run(
    id,
    code,
    name,
    input.gstin ?? null,
    input.contactName ?? null,
    input.email ?? null,
    input.phone ?? null,
    input.address ?? null,
    input.paymentTerms ?? null,
    input.leadTimeDays ?? null,
    input.minOrderQty ?? null,
    now,
    now,
  );
  recordAudit(db, {
    eventType: 'VENDOR_CREATED',
    entityType: 'VENDOR',
    entityId: id,
    after: { vendorCode: code, name },
    actor: { userId: actor.id, role: actor.role },
  });
  return id;
}

export function updateVendor(db: DB, id: string, patch: Partial<VendorInput> & { status?: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' }, actor: AuthUser): void {
  const before = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!before) throw notFound('Vendor not found');
  const map: Array<[string, string]> = [
    ['name', 'name'], ['gstin', 'gstin'], ['contactName', 'contact_name'], ['email', 'email'], ['phone', 'phone'],
    ['address', 'address'], ['paymentTerms', 'payment_terms'], ['leadTimeDays', 'lead_time_days'],
    ['minOrderQty', 'min_order_qty'], ['status', 'status'],
  ];
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, column] of map) {
    if ((patch as any)[key] !== undefined) {
      fields.push(`${column} = ?`);
      values.push((patch as any)[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE vendors SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  recordAudit(db, {
    eventType: 'VENDOR_UPDATED',
    entityType: 'VENDOR',
    entityId: id,
    before,
    after: db.prepare('SELECT * FROM vendors WHERE id = ?').get(id),
    actor: { userId: actor.id, role: actor.role },
  });
}

export function listVendors(db: DB, filters: { search?: string; status?: string }) {
  const conditions = ['1=1'];
  const params: any[] = [];
  if (filters.search) {
    conditions.push('(name LIKE ? OR vendor_code LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  return db
    .prepare(
      `SELECT v.*,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id) AS purchase_order_count,
              (SELECT COUNT(*) FROM receipts r WHERE r.vendor_id = v.id) AS receipt_count
         FROM vendors v WHERE ${conditions.join(' AND ')} ORDER BY v.name LIMIT 200`,
    )
    .all(...params);
}

export function createPurchaseOrder(
  db: DB,
  input: {
    vendorId: string;
    expectedDate?: string | null;
    notes?: string | null;
    lines: Array<{ productId: string; orderedQty: number; unitCost?: number | null; uom?: Uom }>;
  },
  actor: AuthUser,
): { id: string; poNo: string } {
  const vendor = db.prepare('SELECT id, status FROM vendors WHERE id = ?').get(input.vendorId) as
    | { id: string; status: string }
    | undefined;
  if (!vendor) throw notFound('Vendor not found');
  if (vendor.status !== 'ACTIVE') throw conflict('VENDOR_INACTIVE', 'Purchase orders can only be raised on active vendors');
  if (!input.lines.length) throw badRequest('PO_LINES_REQUIRED', 'A purchase order needs at least one line');
  const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
  const id = newId();
  const poNo = documentNo(db, 'PO', 'PO', 6);
  const now = nowIso();
  db.prepare(
    `INSERT INTO purchase_orders (id, po_no, vendor_id, warehouse_id, status, expected_date, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?, ?)`,
  ).run(id, poNo, input.vendorId, warehouse.id, input.expectedDate ?? null, input.notes ?? null, actor.id, now);
  input.lines.forEach((line, index) => {
    const product = db.prepare('SELECT id, base_uom FROM products WHERE id = ? AND status = ?').get(line.productId, 'ACTIVE') as
      | { id: string; base_uom: Uom }
      | undefined;
    if (!product) throw notFound('Product not found or inactive');
    const qty = line.uom ? convertToBase(db, line.productId, line.orderedQty, line.uom) : line.orderedQty;
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('INVALID_QUANTITY', 'Ordered quantity must be a positive whole number');
    db.prepare(
      'INSERT INTO purchase_order_lines (id, po_id, line_no, product_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(newId(), id, index + 1, line.productId, qty, line.unitCost ?? null);
  });
  recordAudit(db, {
    eventType: 'PURCHASE_ORDER_CREATED',
    entityType: 'PURCHASE_ORDER',
    entityId: id,
    after: { poNo, vendorId: input.vendorId, lineCount: input.lines.length, status: 'PENDING_APPROVAL' },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, poNo };
}

export function approvePurchaseOrder(db: DB, id: string, actor: AuthUser): void {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!po) throw notFound('Purchase order not found');
  if (po.status !== 'PENDING_APPROVAL') throw conflict('INVALID_PO_STATE', `Purchase order is ${po.status}`);
  db.prepare("UPDATE purchase_orders SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(
    actor.id,
    nowIso(),
    id,
  );
  recordAudit(db, {
    eventType: 'PURCHASE_ORDER_APPROVED',
    entityType: 'PURCHASE_ORDER',
    entityId: id,
    before: { status: po.status },
    after: { status: 'APPROVED' },
    actor: { userId: actor.id, role: actor.role },
  });
}

export function listPurchaseOrders(db: DB, filters: { status?: string; vendorId?: string }) {
  const conditions = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    conditions.push('po.status = ?');
    params.push(filters.status);
  }
  if (filters.vendorId) {
    conditions.push('po.vendor_id = ?');
    params.push(filters.vendorId);
  }
  return db
    .prepare(
      `SELECT po.*, v.name AS vendor_name, u.name AS created_by_name,
              (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count,
              (SELECT COALESCE(SUM(l.ordered_qty - l.received_qty),0) FROM purchase_order_lines l WHERE l.po_id = po.id) AS open_qty
         FROM purchase_orders po
         JOIN vendors v ON v.id = po.vendor_id
         LEFT JOIN users u ON u.id = po.created_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY po.created_at DESC LIMIT 200`,
    )
    .all(...params);
}

export function getPurchaseOrder(db: DB, id: string) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? OR po_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!po) throw notFound('Purchase order not found');
  const lines = db
    .prepare(
      `SELECT l.*, p.sku, p.name AS product_name, p.base_uom
         FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
        WHERE l.po_id = ? ORDER BY l.line_no`,
    )
    .all(po.id);
  const receipts = db.prepare('SELECT id, receipt_no, status, received_at FROM receipts WHERE po_id = ? ORDER BY created_at').all(po.id);
  return { po, lines, receipts };
}

function resolveBatch(
  db: DB,
  input: { productId: string; batchId?: string | null; batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null },
  vendorId: string,
  actor: AuthUser,
): string | null {
  const product = db
    .prepare('SELECT id, sku, is_batch_tracked, is_expiry_tracked FROM products WHERE id = ?')
    .get(input.productId) as
    | { id: string; sku: string; is_batch_tracked: number; is_expiry_tracked: number }
    | undefined;
  if (!product) throw notFound('Product not found');
  if (product.is_batch_tracked === 0) {
    if (input.batchId || input.batchNo) throw badRequest('BATCH_NOT_ALLOWED', `SKU ${product.sku} is not batch tracked`);
    return null;
  }
  if (input.batchId) {
    const batch = db.prepare('SELECT id, product_id FROM batches WHERE id = ?').get(input.batchId) as
      | { id: string; product_id: string }
      | undefined;
    if (!batch) throw notFound('Batch not found');
    if (batch.product_id !== input.productId) throw conflict('BATCH_PRODUCT_MISMATCH', 'Batch belongs to another SKU');
    return batch.id;
  }
  if (!input.batchNo) throw badRequest('BATCH_REQUIRED', `SKU ${product.sku} requires a batch number`);
  const existing = db
    .prepare('SELECT id, expiry_date FROM batches WHERE product_id = ? AND batch_no = ?')
    .get(input.productId, input.batchNo.trim()) as { id: string; expiry_date: string | null } | undefined;
  if (existing) {
    if (input.expiryDate && existing.expiry_date !== input.expiryDate) {
      throw conflict('BATCH_EXPIRY_MISMATCH', 'Batch already exists with a different expiry date');
    }
    return existing.id;
  }
  return createBatch(
    db,
    {
      productId: input.productId,
      batchNo: input.batchNo,
      mfgDate: input.mfgDate ?? null,
      expiryDate: input.expiryDate ?? null,
      vendorId,
    },
    actor,
  );
}

export interface ReceiptLineInput {
  poLineId?: string;
  productId: string;
  quantity: number;
  uom?: Uom;
  batchId?: string | null;
  batchNo?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
}

export function createReceipt(
  db: DB,
  input: {
    poId: string;
    stagingLocationId: string;
    poolId: string;
    vendorInvoiceRef?: string | null;
    notes?: string | null;
    lines: ReceiptLineInput[];
    allowExcess?: boolean;
    excessReason?: string | null;
  },
  actor: AuthUser,
): { id: string; receiptNo: string; status: string } {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(input.poId) as Record<string, any> | undefined;
  if (!po) throw notFound('Purchase order not found');
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    throw conflict('PO_NOT_RECEIVABLE', `Purchase order is ${po.status}; it must be approved before receiving`);
  }
  const staging = db.prepare('SELECT * FROM locations WHERE id = ?').get(input.stagingLocationId) as Record<string, any> | undefined;
  if (!staging) throw notFound('Staging location not found');
  if (staging.type !== 'STAGING') throw badRequest('INVALID_STAGING_LOCATION', 'Goods must be received into a STAGING location');
  if (staging.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', 'Staging location is not active');
  const pool = db.prepare('SELECT * FROM stock_pools WHERE id = ?').get(input.poolId) as Record<string, any> | undefined;
  if (!pool) throw notFound('Stock pool not found');
  if (!input.lines.length) throw badRequest('RECEIPT_LINES_REQUIRED', 'A receipt needs at least one line');
  if (input.allowExcess && !actor.permissions.includes('inbound.approve')) {
    throw forbidden('Excess receipts require the inbound.approve permission');
  }
  if (input.allowExcess && !input.excessReason?.trim()) {
    throw badRequest('EXCESS_REASON_REQUIRED', 'An explanation is required for an excess receipt');
  }

  const id = newId();
  const receiptNo = documentNo(db, 'RECEIPT', 'RCV', 6);
  const now = nowIso();
  db.prepare(
    `INSERT INTO receipts (id, receipt_no, po_id, vendor_id, warehouse_id, pool_id, status, staging_location_id,
                           received_by, received_at, vendor_invoice_ref, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING_QC', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    receiptNo,
    po.id,
    po.vendor_id,
    po.warehouse_id,
    input.poolId,
    staging.id,
    actor.id,
    now,
    input.vendorInvoiceRef ?? null,
    input.notes ?? null,
    now,
  );

  let anyQcRequired = false;
  let acceptedImmediately = 0;
  for (const line of input.lines) {
    const poLine = line.poLineId
      ? (db.prepare('SELECT * FROM purchase_order_lines WHERE id = ? AND po_id = ?').get(line.poLineId, po.id) as Record<string, any> | undefined)
      : (db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ? AND product_id = ?').get(po.id, line.productId) as
          | Record<string, any>
          | undefined);
    if (!poLine) throw notFound('Purchase order line not found for received product');
    if (poLine.product_id !== line.productId) throw conflict('PO_LINE_PRODUCT_MISMATCH', 'Receipt line product does not match the PO line');
    const qty = line.uom ? convertToBase(db, line.productId, line.quantity, line.uom) : line.quantity;
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('INVALID_QUANTITY', 'Received quantity must be a positive whole number');
    const remaining = Number(poLine.ordered_qty) - Number(poLine.received_qty);
    if (qty > remaining && !input.allowExcess) {
      throw conflict('EXCESS_RECEIPT', `Received quantity ${qty} exceeds the open ordered quantity ${remaining}`, {
        productId: line.productId,
        orderedQty: Number(poLine.ordered_qty),
        alreadyReceived: Number(poLine.received_qty),
        receivedNow: qty,
        openQty: remaining,
      });
    }
    const product = db.prepare('SELECT sku, qc_required, is_batch_tracked FROM products WHERE id = ?').get(line.productId) as
      | { sku: string; qc_required: number; is_batch_tracked: number }
      | undefined;
    if (!product) throw notFound('Product not found');
    const batchId = resolveBatch(db, line, String(po.vendor_id), actor);
    if (db.prepare('SELECT id FROM receipt_lines WHERE receipt_id = ? AND product_id = ? AND COALESCE(batch_id,\'\') = COALESCE(?,\'\')').get(id, line.productId, batchId)) {
      throw conflict('DUPLICATE_RECEIPT_LINE', `SKU ${product.sku} appears more than once for the same batch in this receipt`);
    }
    const lineId = newId();
    const qcPending = product.qc_required === 1;
    if (qcPending) anyQcRequired = true;
    else acceptedImmediately += qty;
    db.prepare(
      `INSERT INTO receipt_lines
        (id, receipt_id, po_line_id, product_id, batch_id, expected_qty, received_qty, accepted_qty,
         rejected_qty, quarantined_qty, putaway_qty, qc_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    ).run(
      lineId,
      id,
      poLine.id,
      line.productId,
      batchId,
      Math.max(remaining, 0),
      qty,
      qcPending ? 0 : qty,
      qcPending ? 'PENDING' : 'ACCEPTED',
    );
    db.prepare('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?').run(qty, poLine.id);
    postMovement(db, {
      movementType: 'RECEIPT',
      productId: line.productId,
      quantity: qty,
      from: null,
      to: {
        warehouseId: po.warehouse_id,
        locationId: staging.id,
        poolId: input.poolId,
        status: qcPending ? 'QC_PENDING' : 'AVAILABLE',
        boxId: null,
        batchId,
      },
      referenceType: 'RECEIPT',
      referenceId: id,
      referenceNo: receiptNo,
      reason: input.allowExcess ? `Excess receipt approved: ${input.excessReason}` : 'Goods received',
      user: actor,
      metadata: { receiptLineId: lineId, poNo: po.po_no, vendorInvoiceRef: input.vendorInvoiceRef ?? null },
    });
  }

  const poLines = db.prepare('SELECT ordered_qty, received_qty FROM purchase_order_lines WHERE po_id = ?').all(po.id) as Array<{
    ordered_qty: number;
    received_qty: number;
  }>;
  const fullyReceived = poLines.every((l) => Number(l.received_qty) >= Number(l.ordered_qty));
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED', po.id);

  const warehouseId = String(po.warehouse_id);
  if (anyQcRequired) {
    createTask(
      db,
      {
        taskType: 'QC',
        warehouseId,
        entityType: 'RECEIPT',
        entityId: id,
        description: `QC inspection for receipt ${receiptNo}`,
        priority: 'HIGH',
        dueInHours: 4,
      },
      actor,
    );
  } else {
    db.prepare("UPDATE receipts SET status = 'COMPLETED' WHERE id = ?").run(id);
    if (acceptedImmediately > 0) {
      createTask(
        db,
        {
          taskType: 'PUTAWAY',
          warehouseId,
          entityType: 'RECEIPT',
          entityId: id,
          description: `Put away accepted goods for receipt ${receiptNo}`,
          priority: 'NORMAL',
          dueInHours: 8,
        },
        actor,
      );
    }
  }

  recordAudit(db, {
    eventType: 'RECEIPT_CREATED',
    entityType: 'RECEIPT',
    entityId: id,
    after: { receiptNo, poNo: po.po_no, lineCount: input.lines.length, qcRequired: anyQcRequired },
    refs: { poId: po.id, vendorId: po.vendor_id },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, receiptNo, status: anyQcRequired ? 'PENDING_QC' : 'COMPLETED' };
}

export function inspectReceiptLine(
  db: DB,
  input: {
    receiptId: string;
    lineId: string;
    acceptedQty: number;
    rejectedQty?: number;
    quarantinedQty?: number;
    notes?: string | null;
    template?: Record<string, unknown> | null;
  },
  actor: AuthUser,
): { inspectionId: string; lineStatus: string; acceptedQty: number; rejectedQty: number; quarantinedQty: number } {
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(input.receiptId) as Record<string, any> | undefined;
  if (!receipt) throw notFound('Receipt not found');
  if (receipt.status === 'CANCELLED') throw conflict('RECEIPT_CANCELLED', 'Receipt is cancelled');
  const line = db.prepare('SELECT * FROM receipt_lines WHERE id = ? AND receipt_id = ?').get(input.lineId, input.receiptId) as
    | Record<string, any>
    | undefined;
  if (!line) throw notFound('Receipt line not found');
  if (!line.batch_id && (db.prepare('SELECT is_batch_tracked FROM products WHERE id = ?').get(line.product_id) as { is_batch_tracked: number }).is_batch_tracked === 1) {
    throw conflict('BATCH_REQUIRED', 'Receipt line has no batch');
  }
  const accepted = input.acceptedQty ?? 0;
  const rejected = input.rejectedQty ?? 0;
  const quarantined = input.quarantinedQty ?? 0;
  for (const [name, value] of [
    ['acceptedQty', accepted],
    ['rejectedQty', rejected],
    ['quarantinedQty', quarantined],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw badRequest('INVALID_QUANTITY', `${name} must be a non-negative whole number`);
  }
  const inspected = accepted + rejected + quarantined;
  if (inspected <= 0) throw badRequest('INSPECTION_EMPTY', 'At least one unit must be inspected');
  const alreadyAccounted = Number(line.accepted_qty) + Number(line.rejected_qty) + Number(line.quarantined_qty);
  const remaining = Number(line.received_qty) - alreadyAccounted;
  if (inspected > remaining) {
    throw conflict('INSPECTION_EXCEEDS_RECEIVED', `Only ${remaining} units remain uninspected`, { remaining, inspected });
  }
  const receiptQty = Number(line.received_qty);
  const batchId = line.batch_id ?? null;
  const baseEndpoints = {
    warehouseId: String(receipt.warehouse_id),
    locationId: String(receipt.staging_location_id),
    poolId: String(receipt.pool_id),
    batchId,
    boxId: null,
  };
  if (accepted > 0) {
    postMovement(db, {
      movementType: 'QC_ACCEPT',
      productId: line.product_id,
      quantity: accepted,
      from: { ...baseEndpoints, status: 'QC_PENDING' },
      to: { ...baseEndpoints, status: 'AVAILABLE' },
      referenceType: 'RECEIPT',
      referenceId: receipt.id,
      referenceNo: receipt.receipt_no,
      reason: 'QC accepted',
      user: actor,
      metadata: { receiptLineId: line.id },
    });
  }
  if (rejected > 0) {
    postMovement(db, {
      movementType: 'QC_REJECT',
      productId: line.product_id,
      quantity: rejected,
      from: { ...baseEndpoints, status: 'QC_PENDING' },
      to: { ...baseEndpoints, status: 'REJECTED' },
      referenceType: 'RECEIPT',
      referenceId: receipt.id,
      referenceNo: receipt.receipt_no,
      reason: input.notes ?? 'QC rejected',
      user: actor,
      metadata: { receiptLineId: line.id },
    });
  }
  if (quarantined > 0) {
    postMovement(db, {
      movementType: 'QC_QUARANTINE',
      productId: line.product_id,
      quantity: quarantined,
      from: { ...baseEndpoints, status: 'QC_PENDING' },
      to: { ...baseEndpoints, status: 'QUARANTINED' },
      referenceType: 'RECEIPT',
      referenceId: receipt.id,
      referenceNo: receipt.receipt_no,
      reason: input.notes ?? 'QC quarantined',
      user: actor,
      metadata: { receiptLineId: line.id },
    });
  }

  const newAccepted = Number(line.accepted_qty) + accepted;
  const newRejected = Number(line.rejected_qty) + rejected;
  const newQuarantined = Number(line.quarantined_qty) + quarantined;
  let lineStatus: string;
  if (newAccepted + newRejected + newQuarantined < receiptQty) {
    lineStatus = 'PARTIALLY_ACCEPTED';
  } else if (newAccepted === receiptQty) {
    lineStatus = 'ACCEPTED';
  } else if (newRejected === receiptQty) {
    lineStatus = 'REJECTED';
  } else if (newQuarantined === receiptQty) {
    lineStatus = 'QUARANTINED';
  } else {
    lineStatus = 'PARTIALLY_ACCEPTED';
  }
  db.prepare(
    'UPDATE receipt_lines SET accepted_qty = ?, rejected_qty = ?, quarantined_qty = ?, qc_status = ? WHERE id = ?',
  ).run(newAccepted, newRejected, newQuarantined, lineStatus, line.id);

  const inspectionId = newId();
  const result =
    newAccepted === receiptQty ? 'ACCEPTED' : newRejected === receiptQty ? 'REJECTED' : newQuarantined === receiptQty ? 'QUARANTINED' : 'PARTIALLY_ACCEPTED';
  db.prepare(
    `INSERT INTO qc_inspections
      (id, inspection_no, receipt_id, receipt_line_id, product_id, inspected_qty, accepted_qty, rejected_qty,
       quarantined_qty, result, template_json, inspected_by, inspected_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    inspectionId,
    documentNo(db, 'QC', 'QC', 6),
    receipt.id,
    line.id,
    line.product_id,
    inspected,
    accepted,
    rejected,
    quarantined,
    result,
    input.template ? JSON.stringify(input.template) : null,
    actor.id,
    nowIso(),
    input.notes ?? null,
  );

  const allLines = db.prepare('SELECT * FROM receipt_lines WHERE receipt_id = ?').all(receipt.id) as Array<Record<string, any>>;
  const fullyInspected = allLines.every(
    (l) => Number(l.accepted_qty) + Number(l.rejected_qty) + Number(l.quarantined_qty) === Number(l.received_qty),
  );
  if (fullyInspected) {
    db.prepare("UPDATE receipts SET status = 'COMPLETED' WHERE id = ?").run(receipt.id);
    const qcTask = db
      .prepare("SELECT id FROM tasks WHERE entity_type = 'RECEIPT' AND entity_id = ? AND task_type = 'QC' AND status NOT IN ('COMPLETED','CANCELLED')")
      .get(receipt.id) as { id: string } | undefined;
    if (qcTask) completeTask(db, qcTask.id, actor);
    const acceptedTotal = allLines.reduce((sum, l) => sum + Number(l.accepted_qty), 0);
    if (acceptedTotal > 0) {
      const existingTask = db
        .prepare("SELECT id FROM tasks WHERE entity_type = 'RECEIPT' AND entity_id = ? AND task_type = 'PUTAWAY' AND status NOT IN ('COMPLETED','CANCELLED')")
        .get(receipt.id);
      if (!existingTask) {
        createTask(
          db,
          {
            taskType: 'PUTAWAY',
            warehouseId: String(receipt.warehouse_id),
            entityType: 'RECEIPT',
            entityId: receipt.id,
            description: `Put away accepted goods for receipt ${receipt.receipt_no}`,
            priority: 'NORMAL',
            dueInHours: 8,
          },
          actor,
        );
      }
    }
  } else {
    db.prepare("UPDATE receipts SET status = 'PARTIALLY_INSPECTED' WHERE id = ?").run(receipt.id);
  }

  recordAudit(db, {
    eventType: 'QC_INSPECTION_RECORDED',
    entityType: 'RECEIPT_LINE',
    entityId: line.id,
    after: { inspected, accepted, rejected, quarantined, result, lineStatus },
    refs: { receiptId: receipt.id, receiptNo: receipt.receipt_no, inspectionId },
    actor: { userId: actor.id, role: actor.role },
  });

  return { inspectionId, lineStatus, acceptedQty: newAccepted, rejectedQty: newRejected, quarantinedQty: newQuarantined };
}

export function getReceipt(db: DB, id: string) {
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? OR receipt_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!receipt) throw notFound('Receipt not found');
  const lines = db
    .prepare(
      `SELECT rl.*, p.sku, p.name AS product_name, p.base_uom, b.batch_no, b.expiry_date,
              (rl.accepted_qty - rl.putaway_qty) AS remaining_to_putaway
         FROM receipt_lines rl
         JOIN products p ON p.id = rl.product_id
         LEFT JOIN batches b ON b.id = rl.batch_id
        WHERE rl.receipt_id = ? ORDER BY p.sku`,
    )
    .all(receipt.id);
  const inspections = db
    .prepare(
      `SELECT q.*, u.name AS inspector_name FROM qc_inspections q
        LEFT JOIN users u ON u.id = q.inspected_by
        WHERE q.receipt_id = ? ORDER BY q.inspected_at`,
    )
    .all(receipt.id);
  const tasks = db.prepare("SELECT * FROM tasks WHERE entity_type = 'RECEIPT' AND entity_id = ? ORDER BY created_at").all(receipt.id);
  const vendor = db.prepare('SELECT id, vendor_code, name FROM vendors WHERE id = ?').get(receipt.vendor_id);
  const staging = db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(receipt.staging_location_id);
  return { receipt, lines, inspections, tasks, vendor, staging };
}

export function listReceipts(db: DB, filters: { status?: string; vendorId?: string; poId?: string }) {
  const conditions = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    conditions.push('r.status = ?');
    params.push(filters.status);
  }
  if (filters.vendorId) {
    conditions.push('r.vendor_id = ?');
    params.push(filters.vendorId);
  }
  if (filters.poId) {
    conditions.push('r.po_id = ?');
    params.push(filters.poId);
  }
  return db
    .prepare(
      `SELECT r.*, v.name AS vendor_name, po.po_no,
              (SELECT COALESCE(SUM(rl.received_qty),0) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS received_qty,
              (SELECT COALESCE(SUM(rl.accepted_qty),0) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS accepted_qty,
              (SELECT COALESCE(SUM(rl.rejected_qty),0) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS rejected_qty,
              (SELECT COALESCE(SUM(rl.putaway_qty),0) FROM receipt_lines rl WHERE rl.receipt_id = r.id) AS putaway_qty
         FROM receipts r
         JOIN vendors v ON v.id = r.vendor_id
         LEFT JOIN purchase_orders po ON po.id = r.po_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all(...params);
}

export function putaway(
  db: DB,
  input: {
    receiptId: string;
    productId: string;
    batchId?: string | null;
    quantity: number;
    toLocationId: string;
    boxId?: string | null;
    taskId?: string | null;
    reason?: string;
  },
  actor: AuthUser,
): { txnId: string; txnNo: string; remainingToPutaway: number } {
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(input.receiptId) as Record<string, any> | undefined;
  if (!receipt) throw notFound('Receipt not found');
  if (!['COMPLETED', 'PARTIALLY_INSPECTED'].includes(receipt.status)) {
    throw conflict('RECEIPT_NOT_READY', `Receipt is ${receipt.status}; accepted goods must be inspected before putaway`);
  }
  const line = db
    .prepare('SELECT * FROM receipt_lines WHERE receipt_id = ? AND product_id = ? AND COALESCE(batch_id,\'\') = COALESCE(?,\'\')')
    .get(receipt.id, input.productId, input.batchId ?? null) as Record<string, any> | undefined;
  if (!line) throw notFound('No accepted receipt line matches this SKU and batch');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw badRequest('INVALID_QUANTITY', 'Putaway quantity must be positive');
  const remaining = Number(line.accepted_qty) - Number(line.putaway_qty);
  if (input.quantity > remaining) {
    throw conflict('PUTAWAY_EXCEEDS_ACCEPTED', `Only ${remaining} accepted units remain to be put away`, { remaining });
  }
  const destination = db.prepare('SELECT * FROM locations WHERE id = ?').get(input.toLocationId) as Record<string, any> | undefined;
  if (!destination) throw notFound('Destination location not found');
  if (destination.type !== 'RACK') throw badRequest('INVALID_PUTAWAY_LOCATION', 'Putaway destinations must be RACK locations');
  if (destination.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', 'Destination location is not active');
  if (destination.warehouse_id !== receipt.warehouse_id) throw conflict('WAREHOUSE_MISMATCH', 'Destination is in another warehouse');
  if (destination.capacity_pieces) {
    const occupancy = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_balances WHERE location_id = ?')
      .get(destination.id) as { qty: number };
    if (Number(occupancy.qty) + input.quantity > Number(destination.capacity_pieces)) {
      throw conflict('LOCATION_CAPACITY_EXCEEDED', `Destination location capacity is ${destination.capacity_pieces} units`, {
        capacity: Number(destination.capacity_pieces),
        occupied: Number(occupancy.qty),
        requested: input.quantity,
      });
    }
  }
  if (input.boxId) {
    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(input.boxId) as Record<string, any> | undefined;
    if (!box) throw notFound('Box not found');
    if (box.location_id && box.location_id !== destination.id) {
      throw conflict('BOX_LOCATION_MISMATCH', `Box ${box.box_code} is not at the destination location`);
    }
  }
  const staging = receipt.staging_location_id as string;
  const result = postMovement(db, {
    movementType: 'PUTAWAY',
    productId: input.productId,
    quantity: input.quantity,
    from: {
      warehouseId: receipt.warehouse_id,
      locationId: staging,
      poolId: receipt.pool_id,
      status: 'AVAILABLE',
      boxId: null,
      batchId: input.batchId ?? null,
    },
    to: {
      warehouseId: receipt.warehouse_id,
      locationId: destination.id,
      poolId: receipt.pool_id,
      status: 'AVAILABLE',
      boxId: input.boxId ?? null,
      batchId: input.batchId ?? null,
    },
    referenceType: 'RECEIPT',
    referenceId: receipt.id,
    referenceNo: receipt.receipt_no,
    reason: input.reason ?? 'Putaway',
    user: actor,
    metadata: { receiptLineId: line.id, location: destination.code },
  });
  db.prepare('UPDATE receipt_lines SET putaway_qty = putaway_qty + ? WHERE id = ?').run(input.quantity, line.id);

  const updated = db.prepare('SELECT accepted_qty, putaway_qty FROM receipt_lines WHERE id = ?').get(line.id) as {
    accepted_qty: number;
    putaway_qty: number;
  };
  const totalRemainingRow = db
    .prepare('SELECT COALESCE(SUM(accepted_qty - putaway_qty),0) AS n FROM receipt_lines WHERE receipt_id = ?')
    .get(receipt.id) as { n: number };
  const remainingToPutaway = Number(totalRemainingRow.n);
  if (input.taskId) {
    if (remainingToPutaway === 0) completeTask(db, input.taskId, actor);
  }
  return { txnId: result.txnId, txnNo: result.txnNo, remainingToPutaway };
}

export function releaseQuarantine(
  db: DB,
  input: {
    productId: string;
    batchId?: string | null;
    quantity: number;
    fromLocationId: string;
    poolId: string;
    toStatus: 'AVAILABLE' | 'REJECTED';
    reason: string;
  },
  actor: AuthUser,
): { txnId: string } {
  if (!actor.permissions.includes('inventory.adjust.approve')) {
    throw forbidden('Quarantine release requires approval permission');
  }
  if (!input.reason.trim()) throw badRequest('REASON_REQUIRED', 'A quarantine release reason is required');
  const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
  const result = postMovement(db, {
    movementType: 'QUARANTINE_RELEASE',
    productId: input.productId,
    quantity: input.quantity,
    from: {
      warehouseId: warehouse.id,
      locationId: input.fromLocationId,
      poolId: input.poolId,
      status: 'QUARANTINED',
      batchId: input.batchId ?? null,
      boxId: null,
    },
    to: {
      warehouseId: warehouse.id,
      locationId: input.fromLocationId,
      poolId: input.poolId,
      status: input.toStatus,
      batchId: input.batchId ?? null,
      boxId: null,
    },
    referenceType: 'QUARANTINE_RELEASE',
    reason: input.reason,
    user: actor,
    metadata: { releasedBy: actor.id, releasedOn: todayIso() },
  });
  return { txnId: result.txnId };
}

export function vendorPerformance(db: DB, vendorId: string) {
  const vendor = db.prepare('SELECT id, vendor_code, name FROM vendors WHERE id = ?').get(vendorId) as
    | { id: string; vendor_code: string; name: string }
    | undefined;
  if (!vendor) throw notFound('Vendor not found');
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS purchase_orders,
              COALESCE(SUM(CASE WHEN po.status = 'RECEIVED' THEN 1 ELSE 0 END), 0) AS fully_received,
              COALESCE(SUM(CASE WHEN po.status IN ('APPROVED','PARTIALLY_RECEIVED') THEN 1 ELSE 0 END), 0) AS open_orders
         FROM purchase_orders po WHERE po.vendor_id = ?`,
    )
    .get(vendorId) as { purchase_orders: number; fully_received: number; open_orders: number };
  const receipts = db
    .prepare(
      `SELECT COUNT(*) AS receipt_count,
              COALESCE(SUM(rl.received_qty), 0) AS received_qty,
              COALESCE(SUM(rl.accepted_qty), 0) AS accepted_qty,
              COALESCE(SUM(rl.rejected_qty), 0) AS rejected_qty,
              COALESCE(SUM(rl.quarantined_qty), 0) AS quarantined_qty
         FROM receipts r JOIN receipt_lines rl ON rl.receipt_id = r.id WHERE r.vendor_id = ?`,
    )
    .get(vendorId) as Record<string, number>;
  const onTime = db
    .prepare(
      `SELECT COUNT(*) AS n FROM purchase_orders po
        WHERE po.vendor_id = ? AND po.status = 'RECEIVED' AND po.expected_date IS NOT NULL
          AND (SELECT MAX(r.received_at) FROM receipts r WHERE r.po_id = po.id) <= po.expected_date || 'T23:59:59.999Z'`,
    )
    .get(vendorId) as { n: number };
  const received = Number(receipts.received_qty ?? 0);
  return {
    vendor,
    summary: {
      purchaseOrders: Number(summary.purchase_orders),
      fullyReceived: Number(summary.fully_received),
      openOrders: Number(summary.open_orders),
      receiptCount: Number(receipts.receipt_count ?? 0),
      receivedQty: received,
      acceptedQty: Number(receipts.accepted_qty ?? 0),
      rejectedQty: Number(receipts.rejected_qty ?? 0),
      quarantinedQty: Number(receipts.quarantined_qty ?? 0),
      rejectionRate: received > 0 ? Number((Number(receipts.rejected_qty) / received).toFixed(4)) : null,
      onTimeReceipts: Number(onTime.n),
      onTimeRate:
        Number(summary.fully_received) > 0 ? Number((Number(onTime.n) / Number(summary.fully_received)).toFixed(4)) : null,
    },
    formulaNotes: {
      rejectionRate: 'rejected_qty / received_qty across all receipt lines',
      onTimeRate: 'fully received POs whose latest receipt date is on or before the expected date',
    },
  };
}
