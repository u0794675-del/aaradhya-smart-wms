import type { DB } from '../db/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement } from './inventory.ts';

export interface AdjustmentInput {
  productId: string;
  locationId: string;
  poolId: string;
  batchId?: string | null;
  boxId?: string | null;
  direction: 'IN' | 'OUT';
  quantity: number;
  reason: string;
}

function loadAdjustment(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM adjustment_requests WHERE id = ? OR adjustment_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!row) throw notFound('Adjustment not found');
  return row;
}

export function getAdjustment(db: DB, id: string) {
  const row = loadAdjustment(db, id);
  const product = db.prepare('SELECT sku, name FROM products WHERE id = ?').get(row.product_id) as
    | { sku: string; name: string }
    | undefined;
  const location = db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(row.location_id) as
    | { id: string; code: string; type: string }
    | undefined;
  const pool = db.prepare('SELECT id, code FROM stock_pools WHERE id = ?').get(row.pool_id) as
    | { id: string; code: string }
    | undefined;
  const batch = row.batch_id
    ? (db.prepare('SELECT batch_no, expiry_date FROM batches WHERE id = ?').get(row.batch_id) as
        | { batch_no: string; expiry_date: string | null }
        | undefined)
    : undefined;
  const box = row.box_id
    ? (db.prepare('SELECT box_code FROM boxes WHERE id = ?').get(row.box_id) as { box_code: string } | undefined)
    : undefined;
  const requester = db.prepare('SELECT name FROM users WHERE id = ?').get(row.requested_by) as { name: string } | undefined;
  const decider = row.decided_by
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(row.decided_by) as { name: string } | undefined)
    : undefined;
  return {
    ...row,
    sku: product?.sku ?? null,
    product_name: product?.name ?? null,
    location_code: location?.code ?? null,
    pool_code: pool?.code ?? null,
    batch_no: batch?.batch_no ?? null,
    batch_expiry: batch?.expiry_date ?? null,
    box_code: box?.box_code ?? null,
    requested_by_name: requester?.name ?? null,
    decided_by_name: decider?.name ?? null,
    location: location ?? null,
    pool: pool ?? null,
    transaction: row.transaction_id
      ? db.prepare('SELECT id, txn_no, movement_type, quantity, created_at FROM inventory_transactions WHERE id = ?').get(row.transaction_id)
      : null,
  };
}

export function listAdjustments(
  db: DB,
  filters: { status?: string; productId?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    conditions.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.productId) {
    conditions.push('a.product_id = ?');
    params.push(filters.productId);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT a.*, p.sku, l.code AS location_code, sp.code AS pool_code,
              ru.name AS requested_by_name, du.name AS decided_by_name
         FROM adjustment_requests a
         JOIN products p ON p.id = a.product_id
         JOIN locations l ON l.id = a.location_id
         JOIN stock_pools sp ON sp.id = a.pool_id
         LEFT JOIN users ru ON ru.id = a.requested_by
         LEFT JOIN users du ON du.id = a.decided_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.requested_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM adjustment_requests a WHERE ${conditions.join(' AND ')}`).get(...params) as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

function validateDimensions(db: DB, input: AdjustmentInput) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw badRequest('INVALID_QUANTITY', 'Adjustment quantity must be a positive whole number');
  }
  if (!input.reason.trim()) throw badRequest('ADJUSTMENT_REASON_REQUIRED', 'An adjustment reason is required');
  const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'ACTIVE'").get(input.productId) as
    | Record<string, any>
    | undefined;
  if (!product) throw notFound('Product not found or inactive');
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(input.locationId) as Record<string, any> | undefined;
  if (!location) throw notFound('Location not found');
  if (location.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', 'Adjustment location is not active');
  const pool = db.prepare('SELECT * FROM stock_pools WHERE id = ? AND is_active = 1').get(input.poolId) as
    | Record<string, any>
    | undefined;
  if (!pool) throw notFound('Stock pool not found or inactive');
  if (product.is_batch_tracked === 1 && !input.batchId) {
    throw badRequest('BATCH_REQUIRED', `SKU ${product.sku} requires a batch`);
  }
  if (product.is_batch_tracked === 0 && input.batchId) {
    throw badRequest('BATCH_NOT_ALLOWED', `SKU ${product.sku} is not batch tracked`);
  }
  if (input.batchId) {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND product_id = ?').get(input.batchId, input.productId);
    if (!batch) throw badRequest('BATCH_PRODUCT_MISMATCH', 'Batch does not belong to the product');
  }
  if (input.boxId) {
    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(input.boxId) as Record<string, any> | undefined;
    if (!box) throw notFound('Box not found');
    if (['DAMAGED', 'RETIRED'].includes(box.status)) throw conflict('BOX_NOT_USABLE', `Box is ${box.status}`);
    if (box.location_id && box.location_id !== location.id) {
      throw conflict('BOX_LOCATION_MISMATCH', 'Box is physically at another location');
    }
    if (box.pool_id && box.pool_id !== pool.id) throw conflict('BOX_POOL_MISMATCH', 'Box belongs to another pool');
    if (product.is_batch_tracked === 1) {
      const boxBatches = db
        .prepare('SELECT DISTINCT batch_id FROM inventory_balances WHERE box_id = ? AND quantity > 0')
        .all(input.boxId) as Array<{ batch_id: string | null }>;
      if (boxBatches.some((b) => b.batch_id && b.batch_id !== input.batchId)) {
        throw conflict('BOX_BATCH_MISMATCH', 'Box already holds a different batch');
      }
    }
  }
  return { product, location, pool };
}

export function createAdjustment(
  db: DB,
  input: AdjustmentInput,
  actor: AuthUser,
): { id: string; adjustmentNo: string; status: string; transactionId?: string } {
  const { location } = validateDimensions(db, input);
  const threshold = getSetting(db, 'adjustment_approval_threshold', 50);
  const canApprove = actor.permissions.includes('inventory.adjust.approve');
  const autoPost = canApprove && input.quantity <= threshold;

  const id = newId();
  const adjustmentNo = documentNo(db, 'ADJUSTMENT', 'ADJ', 6);
  db.prepare(
    `INSERT INTO adjustment_requests
      (id, adjustment_no, product_id, warehouse_id, location_id, pool_id, batch_id, box_id,
       direction, quantity, reason, status, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?)`,
  ).run(
    id,
    adjustmentNo,
    input.productId,
    location.warehouse_id,
    input.locationId,
    input.poolId,
    input.batchId ?? null,
    input.boxId ?? null,
    input.direction,
    input.quantity,
    input.reason.trim(),
    actor.id,
    nowIso(),
  );
  recordAudit(db, {
    eventType: 'ADJUSTMENT_REQUESTED',
    entityType: 'ADJUSTMENT',
    entityId: id,
    after: {
      adjustmentNo,
      direction: input.direction,
      quantity: input.quantity,
      productId: input.productId,
      locationId: input.locationId,
      poolId: input.poolId,
      autoPost,
      threshold,
    },
    reason: input.reason.trim(),
    actor: { userId: actor.id, role: actor.role },
  });

  if (!autoPost) {
    return { id, adjustmentNo, status: 'PENDING_APPROVAL' };
  }
  const transactionId = postAdjustment(db, id, actor);
  return { id, adjustmentNo, status: 'POSTED', transactionId };
}

function postAdjustment(db: DB, adjustmentId: string, actor: AuthUser): string {
  const adjustment = loadAdjustment(db, adjustmentId);
  if (adjustment.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_ADJUSTMENT_TRANSITION', `Adjustment is ${adjustment.status}`);
  }
  const from =
    adjustment.direction === 'OUT'
      ? {
          warehouseId: adjustment.warehouse_id,
          locationId: adjustment.location_id,
          poolId: adjustment.pool_id,
          status: 'AVAILABLE' as const,
          boxId: adjustment.box_id,
          batchId: adjustment.batch_id,
        }
      : null;
  const to =
    adjustment.direction === 'IN'
      ? {
          warehouseId: adjustment.warehouse_id,
          locationId: adjustment.location_id,
          poolId: adjustment.pool_id,
          status: 'AVAILABLE' as const,
          boxId: adjustment.box_id,
          batchId: adjustment.batch_id,
        }
      : null;
  const movement = postMovement(db, {
    movementType: adjustment.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
    productId: adjustment.product_id,
    quantity: Number(adjustment.quantity),
    from,
    to,
    referenceType: 'ADJUSTMENT',
    referenceId: adjustment.id,
    referenceNo: adjustment.adjustment_no,
    reason: adjustment.reason,
    user: actor,
    metadata: { direction: adjustment.direction, requestedBy: adjustment.requested_by },
  });
  db.prepare(
    `UPDATE adjustment_requests SET status = 'POSTED', decided_by = ?, decided_at = ?, transaction_id = ? WHERE id = ?`,
  ).run(actor.id, nowIso(), movement.txnId, adjustment.id);
  recordAudit(db, {
    eventType: 'ADJUSTMENT_POSTED',
    entityType: 'ADJUSTMENT',
    entityId: adjustment.id,
    transactionId: movement.txnId,
    after: {
      adjustmentNo: adjustment.adjustment_no,
      direction: adjustment.direction,
      quantity: Number(adjustment.quantity),
      txnNo: movement.txnNo,
      decidedBy: actor.id,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return movement.txnId;
}

export function approveAdjustment(db: DB, id: string, actor: AuthUser, note?: string | null): { status: string; transactionId: string } {
  const adjustment = loadAdjustment(db, id);
  if (adjustment.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_ADJUSTMENT_TRANSITION', `Adjustment is ${adjustment.status}, not pending approval`);
  }
  if (adjustment.requested_by === actor.id) {
    throw forbidden('An adjustment must be approved by a different user than the requester');
  }
  const transactionId = postAdjustment(db, adjustment.id, actor);
  if (note?.trim()) {
    db.prepare('UPDATE adjustment_requests SET decision_reason = ? WHERE id = ?').run(note.trim(), adjustment.id);
  }
  return { status: 'POSTED', transactionId };
}

export function rejectAdjustment(db: DB, id: string, reason: string, actor: AuthUser): { status: string } {
  const adjustment = loadAdjustment(db, id);
  if (adjustment.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_ADJUSTMENT_TRANSITION', `Adjustment is ${adjustment.status}, not pending approval`);
  }
  if (!reason.trim()) throw badRequest('REJECT_REASON_REQUIRED', 'A rejection reason is required');
  db.prepare(
    "UPDATE adjustment_requests SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?",
  ).run(actor.id, nowIso(), reason.trim(), adjustment.id);
  recordAudit(db, {
    eventType: 'ADJUSTMENT_REJECTED',
    entityType: 'ADJUSTMENT',
    entityId: adjustment.id,
    reason: reason.trim(),
    after: { adjustmentNo: adjustment.adjustment_no, status: 'REJECTED' },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'REJECTED' };
}
