import type { DB } from '../db/index.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, documentNo, nextBoxCode } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { isExpired, nowIso, todayIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

export const PHYSICAL_STATUSES = [
  'AVAILABLE', 'RESERVED', 'PICKED', 'IN_TRANSIT', 'QC_PENDING', 'QUARANTINED',
  'DAMAGED', 'REJECTED', 'EXPIRED', 'RETURN_PENDING', 'REWORK',
] as const;
export type InventoryStatus = (typeof PHYSICAL_STATUSES)[number];

export const MOVEMENT_TYPES = [
  'RECEIPT', 'QC_ACCEPT', 'QC_REJECT', 'QC_QUARANTINE', 'PUTAWAY', 'BOX_TRANSFER', 'PICK', 'PICK_REVERSAL',
  'PACK', 'DISPATCH', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE', 'TRANSFER_RETURN',
  'RESERVATION_RELEASE', 'RETURN_RECEIVE', 'RETURN_RESTOCK', 'RETURN_DISPOSE',
  'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'REWORK', 'QUARANTINE_RELEASE', 'MIGRATION',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const SUPPORTED_POOL_CODES = new Set(['B2B', 'SHARED']);

export function isSupportedPoolCode(code: string): boolean {
  return SUPPORTED_POOL_CODES.has(code);
}

export interface StockEndpoint {
  warehouseId: string;
  locationId?: string | null;
  poolId: string;
  status: InventoryStatus;
  boxId?: string | null;
  batchId?: string | null;
}

export interface MovementInput {
  movementType: MovementType;
  productId: string;
  quantity: number;
  from?: StockEndpoint | null;
  to?: StockEndpoint | null;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceNo?: string | null;
  reason?: string | null;
  user: AuthUser;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown> | null;
  consumeReservedQty?: number;
  allowExpired?: boolean;
  allowBoxRelocation?: boolean;
  reconcileBox?: boolean;
  reversalOf?: string | null;
  txnNo?: string;
}

export interface BalanceRow {
  id: string;
  warehouse_id: string;
  location_id: string;
  pool_id: string;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  status: InventoryStatus;
  quantity: number;
  reserved_quantity: number;
  updated_at: string;
}

function assertInteger(quantity: number, field: string): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest('INVALID_QUANTITY', `${field} must be a positive whole number in base units`);
  }
}

function getBalance(db: DB, endpoint: StockEndpoint, productId: string): BalanceRow | undefined {
  return db
    .prepare(
      `SELECT * FROM inventory_balances
        WHERE warehouse_id = ? AND location_id = ? AND pool_id = ? AND product_id = ? AND status = ?
          AND COALESCE(batch_id, '') = COALESCE(?, '')
          AND COALESCE(box_id, '') = COALESCE(?, '')`,
    )
    .get(
      endpoint.warehouseId,
      endpoint.locationId ?? '',
      endpoint.poolId,
      productId,
      endpoint.status,
      endpoint.batchId ?? null,
      endpoint.boxId ?? null,
    ) as BalanceRow | undefined;
}

function loadProduct(db: DB, productId: string) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
    | {
        id: string;
        sku: string;
        name: string;
        status: string;
        base_uom: string;
        is_batch_tracked: number;
        is_expiry_tracked: number;
      }
    | undefined;
  if (!product) throw notFound('Product not found');
  if (product.status !== 'ACTIVE') throw conflict('PRODUCT_INACTIVE', `Product ${product.sku} is inactive`);
  return product;
}

function loadLocation(db: DB, locationId: string) {
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as
    | { id: string; code: string; type: string; status: string; warehouse_id: string }
    | undefined;
  if (!location) throw notFound('Location not found');
  return location;
}

function loadPool(db: DB, poolId: string) {
  const pool = db.prepare('SELECT * FROM stock_pools WHERE id = ?').get(poolId) as
    | { id: string; code: string; is_active: number }
    | undefined;
  if (!pool) throw notFound('Stock pool not found');
  if (pool.is_active !== 1) throw conflict('POOL_INACTIVE', `Stock pool ${pool.code} is inactive`);
  if (!isSupportedPoolCode(pool.code)) {
    throw badRequest('POOL_NOT_SUPPORTED', `Stock pool ${pool.code} is no longer supported; this system is B2B only`);
  }
  return pool;
}

function loadBatch(db: DB, batchId: string, productId: string) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as
    | { id: string; product_id: string; batch_no: string; expiry_date: string | null }
    | undefined;
  if (!batch) throw notFound('Batch not found');
  if (batch.product_id !== productId) {
    throw conflict('BATCH_PRODUCT_MISMATCH', `Batch ${batch.batch_no} does not belong to this SKU`);
  }
  return batch;
}

function loadBox(db: DB, boxId: string) {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId) as
    | {
        id: string;
        box_code: string;
        box_type: 'SINGLE' | 'MIXED';
        status: string;
        warehouse_id: string;
        location_id: string | null;
        pool_id: string | null;
      }
    | undefined;
  if (!box) throw notFound('Box not found');
  return box;
}

function validateEndpoint(
  db: DB,
  endpoint: StockEndpoint | null | undefined,
  product: ReturnType<typeof loadProduct>,
  side: 'source' | 'destination',
  movement?: MovementInput,
) {
  if (!endpoint) return undefined;
  if (!endpoint.locationId) throw badRequest('LOCATION_REQUIRED', `A ${side} location is required`);
  const location = loadLocation(db, endpoint.locationId);
  if (location.warehouse_id !== endpoint.warehouseId) {
    throw conflict('LOCATION_WAREHOUSE_MISMATCH', 'Location does not belong to the declared warehouse');
  }
  if (location.status !== 'ACTIVE') {
    throw conflict('LOCATION_BLOCKED', `Location ${location.code} is ${location.status} and cannot be used`);
  }
  loadPool(db, endpoint.poolId);

  if (product.is_batch_tracked === 1 && !endpoint.batchId) {
    throw badRequest('BATCH_REQUIRED', `SKU ${product.sku} is batch tracked; a batch is required`);
  }
  if (product.is_batch_tracked === 0 && endpoint.batchId) {
    throw badRequest('BATCH_NOT_ALLOWED', `SKU ${product.sku} is not batch tracked`);
  }
  if (endpoint.batchId) loadBatch(db, endpoint.batchId, product.id);

  if (endpoint.boxId) {
    const box = loadBox(db, endpoint.boxId);
    if (box.warehouse_id !== endpoint.warehouseId) throw conflict('BOX_WAREHOUSE_MISMATCH', 'Box belongs to another warehouse');
    if (['DAMAGED', 'RETIRED'].includes(box.status)) {
      throw conflict('BOX_NOT_USABLE', `Box ${box.box_code} is ${box.status} and cannot hold or release stock`);
    }
    if (box.location_id && box.location_id !== endpoint.locationId) {
      const relocating =
        movement?.allowBoxRelocation === true &&
        [movement.from?.locationId, movement.to?.locationId].includes(box.location_id);
      if (!relocating) throw conflict('BOX_LOCATION_MISMATCH', `Box ${box.box_code} is physically at a different location`);
    }
    if (box.pool_id && box.pool_id !== endpoint.poolId) {
      throw conflict('BOX_POOL_MISMATCH', `Box ${box.box_code} belongs to a different stock pool`);
    }
    if (box.box_type === 'SINGLE') {
      const other = db
        .prepare(
          `SELECT DISTINCT product_id FROM inventory_balances WHERE box_id = ? AND product_id <> ? AND quantity > 0 LIMIT 1`,
        )
        .get(endpoint.boxId, product.id) as { product_id: string } | undefined;
      if (other) throw conflict('SINGLE_BOX_MIX_FORBIDDEN', `Box ${box.box_code} is a single-SKU box and cannot hold another product`);
    }
  }
  return location;
}

function checkExpiryPolicy(
  db: DB,
  input: MovementInput,
  product: ReturnType<typeof loadProduct>,
  from: StockEndpoint | undefined,
  batch: { batch_no: string; expiry_date: string | null } | undefined,
): void {
  if (!from || !batch || input.allowExpired) return;
  const fulfilmentMovements: MovementType[] = ['PICK', 'DISPATCH', 'TRANSFER_DISPATCH'];
  if (!fulfilmentMovements.includes(input.movementType)) return;
  const blockExpired = getSetting(db, 'block_expired_picks', true);
  if (!blockExpired) return;
  if (product.is_expiry_tracked === 1 && !batch.expiry_date) {
    throw conflict('MISSING_EXPIRY_DATE', `Batch ${batch.batch_no} has no expiry date; picking is blocked by policy`);
  }
  if (isExpired(batch.expiry_date)) {
    throw conflict('EXPIRED_STOCK_BLOCKED', `Batch ${batch.batch_no} expired on ${batch.expiry_date}; normal picking is blocked`, {
      batchNo: batch.batch_no,
      expiryDate: batch.expiry_date,
    });
  }
}

export function adjustBoxAfterMovement(db: DB, boxId: string, user: AuthUser, correlationId?: string | null): void {
  const box = loadBox(db, boxId);
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS qty,
              COUNT(DISTINCT location_id) AS locations,
              COUNT(DISTINCT pool_id) AS pools,
              MIN(location_id) AS location_id,
              MIN(pool_id) AS pool_id
         FROM inventory_balances WHERE box_id = ?`,
    )
    .get(boxId) as { qty: number; locations: number; pools: number; location_id: string | null; pool_id: string | null };
  const qty = Number(totals.qty);
  if (qty > 0) {
    if (Number(totals.locations) > 1) {
      throw conflict('BOX_SPLIT_LOCATION', 'Box contents ended up in more than one location; split the box explicitly');
    }
    db.prepare("UPDATE boxes SET status = 'ACTIVE', location_id = ?, pool_id = ? WHERE id = ? AND status NOT IN ('RETIRED','DAMAGED')").run(
      totals.location_id,
      totals.pool_id,
      boxId,
    );
  } else if (box.status === 'ACTIVE') {
    db.prepare("UPDATE boxes SET status = 'EMPTY' WHERE id = ?").run(boxId);
    recordAudit(db, {
      eventType: 'BOX_EMPTIED',
      entityType: 'BOX',
      entityId: boxId,
      after: { boxCode: box.box_code, status: 'EMPTY' },
      actor: { userId: user.id, role: user.role, correlationId },
    });
  }
}

/**
 * Posts one validated physical movement and writes the immutable ledger entry.
 * Must be called inside a transaction. Returns the ledger row id.
 */
export function postMovement(db: DB, input: MovementInput): { txnId: string; txnNo: string; fromBalance?: BalanceRow; toBalance?: BalanceRow } {
  assertInteger(input.quantity, 'Quantity');
  const product = loadProduct(db, input.productId);
  if (!input.from && !input.to) throw badRequest('EMPTY_MOVEMENT', 'A movement needs a source or destination');

  const from = input.from ?? null;
  const to = input.to ?? null;
  if (from && to) {
    const same =
      from.locationId === to.locationId &&
      from.poolId === to.poolId &&
      from.status === to.status &&
      (from.boxId ?? null) === (to.boxId ?? null) &&
      (from.batchId ?? null) === (to.batchId ?? null);
    if (same) throw badRequest('NO_OP_MOVEMENT', 'Source and destination are identical');
  }

  validateEndpoint(db, from, product, 'source', input);
  validateEndpoint(db, to, product, 'destination', input);

  let batch: { batch_no: string; expiry_date: string | null } | undefined;
  if (from?.batchId) batch = loadBatch(db, from.batchId, input.productId);
  if (!batch && to?.batchId) batch = loadBatch(db, to.batchId, input.productId);
  checkExpiryPolicy(db, input, product, from ?? undefined, batch);

  let updatedFrom: BalanceRow | undefined;
  let updatedTo: BalanceRow | undefined;

  if (from) {
    const balance = getBalance(db, from, input.productId);
    if (!balance) {
      throw conflict('INSUFFICIENT_STOCK', `No stock is recorded for ${product.sku} in the selected source`, {
        sku: product.sku,
        onHand: 0,
        available: 0,
        requested: input.quantity,
      });
    }
    const consumeReserved = input.consumeReservedQty ?? 0;
    if (!Number.isInteger(consumeReserved) || consumeReserved < 0 || consumeReserved > input.quantity) {
      throw badRequest('INVALID_RESERVED_QUANTITY', 'Reserved quantity to consume is invalid');
    }
    if (consumeReserved > Number(balance.reserved_quantity)) {
      throw conflict('RESERVATION_MISMATCH', 'The balance does not hold enough reserved stock for this pick', {
        reserved: Number(balance.reserved_quantity),
        requested: consumeReserved,
      });
    }
    const available = Number(balance.quantity) - Number(balance.reserved_quantity) + consumeReserved;
    if (available < input.quantity) {
      throw conflict('INSUFFICIENT_STOCK', `Insufficient stock for ${product.sku}`, {
        sku: product.sku,
        requested: input.quantity,
        available,
        onHand: Number(balance.quantity),
        reserved: Number(balance.reserved_quantity),
      });
    }
    const result = db
      .prepare(
        `UPDATE inventory_balances
            SET quantity = quantity - ?, reserved_quantity = reserved_quantity - ?, updated_at = ?
          WHERE id = ? AND quantity >= ? AND reserved_quantity >= ?
            AND (quantity - reserved_quantity + ?) >= ?`,
      )
      .run(
        input.quantity,
        consumeReserved,
        nowIso(),
        balance.id,
        input.quantity,
        consumeReserved,
        consumeReserved,
        input.quantity,
      );
    if (Number(result.changes) !== 1) {
      throw conflict('CONCURRENT_STOCK_CHANGE', 'Stock changed while this movement was being processed; reload and retry');
    }
    updatedFrom = getBalance(db, from, input.productId);
    if (updatedFrom && Number(updatedFrom.quantity) === 0) {
      db.prepare('DELETE FROM inventory_balances WHERE id = ?').run(updatedFrom.id);
      updatedFrom = undefined;
    }
  }

  if (to) {
    const existing = getBalance(db, to, input.productId);
    if (existing) {
      db.prepare('UPDATE inventory_balances SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(
        input.quantity,
        nowIso(),
        existing.id,
      );
      updatedTo = getBalance(db, to, input.productId);
    } else {
      const id = newId();
      db.prepare(
        `INSERT INTO inventory_balances
          (id, warehouse_id, location_id, pool_id, product_id, batch_id, box_id, status, quantity, reserved_quantity, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        id,
        to.warehouseId,
        to.locationId ?? '',
        to.poolId,
        input.productId,
        to.batchId ?? null,
        to.boxId ?? null,
        to.status,
        input.quantity,
        nowIso(),
      );
      updatedTo = getBalance(db, to, input.productId);
    }
  }

  const txnId = newId();
  const txnNo = input.txnNo ?? documentNo(db, 'TXN', 'TXN', 8);
  db.prepare(
    `INSERT INTO inventory_transactions
      (id, txn_no, movement_type, product_id, quantity,
       from_warehouse_id, from_location_id, from_pool_id, from_status, from_box_id, from_batch_id,
       to_warehouse_id, to_location_id, to_pool_id, to_status, to_box_id, to_batch_id,
       reference_type, reference_id, reference_no, reason, user_id, role_code, correlation_id,
       idempotency_key, reversal_of, created_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    txnId,
    txnNo,
    input.movementType,
    input.productId,
    input.quantity,
    from?.warehouseId ?? null,
    from?.locationId ?? null,
    from?.poolId ?? null,
    from?.status ?? null,
    from?.boxId ?? null,
    from?.batchId ?? null,
    to?.warehouseId ?? null,
    to?.locationId ?? null,
    to?.poolId ?? null,
    to?.status ?? null,
    to?.boxId ?? null,
    to?.batchId ?? null,
    input.referenceType ?? null,
    input.referenceId ?? null,
    input.referenceNo ?? null,
    input.reason ?? null,
    input.user.id,
    input.user.role,
    input.correlationId ?? null,
    input.idempotencyKey ?? null,
    input.reversalOf ?? null,
    nowIso(),
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  if (input.reconcileBox !== false) {
    if (from?.boxId) adjustBoxAfterMovement(db, from.boxId, input.user, input.correlationId);
    if (to?.boxId && to.boxId !== from?.boxId) adjustBoxAfterMovement(db, to.boxId, input.user, input.correlationId);
  }

  recordAudit(db, {
    eventType: `STOCK_${input.movementType}`,
    entityType: 'INVENTORY',
    entityId: input.productId,
    transactionId: txnId,
    reason: input.reason ?? null,
    before:
      updatedFrom === undefined
        ? from
          ? { quantity: 0 }
          : undefined
        : {
            balanceId: updatedFrom.id,
            quantity: Number(updatedFrom.quantity),
            reserved: Number(updatedFrom.reserved_quantity),
            locationId: updatedFrom.location_id,
            boxId: updatedFrom.box_id,
          },
    after: {
      sku: product.sku,
      quantity: input.quantity,
      from: from ?? null,
      to: to ?? null,
      txnNo,
    },
    refs: {
      movementType: input.movementType,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      referenceNo: input.referenceNo ?? null,
      boxId: from?.boxId ?? to?.boxId ?? null,
      batchId: from?.batchId ?? to?.batchId ?? null,
    },
    actor: {
      userId: input.user.id,
      role: input.user.role,
      correlationId: input.correlationId ?? null,
    },
  });

  return { txnId, txnNo, fromBalance: updatedFrom, toBalance: updatedTo };
}

export function availableQuantity(
  db: DB,
  opts: { productId?: string; poolId?: string; warehouseId?: string; boxId?: string; locationId?: string; includeExpired?: boolean },
): number {
  const conditions: string[] = ["ib.status = 'AVAILABLE'"];
  const params: any[] = [];
  if (opts.productId) {
    conditions.push('ib.product_id = ?');
    params.push(opts.productId);
  }
  if (opts.poolId) {
    conditions.push('ib.pool_id = ?');
    params.push(opts.poolId);
  }
  if (opts.warehouseId) {
    conditions.push('ib.warehouse_id = ?');
    params.push(opts.warehouseId);
  }
  if (opts.boxId) {
    conditions.push('ib.box_id = ?');
    params.push(opts.boxId);
  }
  if (opts.locationId) {
    conditions.push('ib.location_id = ?');
    params.push(opts.locationId);
  }
  if (!opts.includeExpired && getSetting(db, 'block_expired_picks', true)) {
    conditions.push("(ib.batch_id IS NULL OR EXISTS (SELECT 1 FROM batches b WHERE b.id = ib.batch_id AND (b.expiry_date IS NULL OR b.expiry_date >= ?)))");
    params.push(todayIso());
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ib.quantity - ib.reserved_quantity), 0) AS available
         FROM inventory_balances ib WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as { available: number };
  return Number(row.available);
}

export interface ReservationInput {
  orderId: string;
  orderLineId: string;
  productId: string;
  warehouseId: string;
  poolId: string;
  quantity: number;
  boxId?: string | null;
  user: AuthUser;
  correlationId?: string | null;
}

export function reserveStock(db: DB, input: ReservationInput): Array<Record<string, unknown>> {
  assertInteger(input.quantity, 'Reservation quantity');
  const product = loadProduct(db, input.productId);
  const conditions = [
    'ib.product_id = ?',
    'ib.warehouse_id = ?',
    'ib.pool_id = ?',
    "ib.status = 'AVAILABLE'",
    'ib.quantity > ib.reserved_quantity',
  ];
  const params: any[] = [input.productId, input.warehouseId, input.poolId];
  if (input.boxId) {
    conditions.push('ib.box_id = ?');
    params.push(input.boxId);
  }
  const blockExpired = getSetting(db, 'block_expired_picks', true);
  if (blockExpired) {
    conditions.push(
      "(ib.batch_id IS NULL OR EXISTS (SELECT 1 FROM batches b WHERE b.id = ib.batch_id AND (b.expiry_date IS NULL OR b.expiry_date >= ?)))",
    );
    params.push(todayIso());
  }
  const candidates = db
    .prepare(
      `SELECT ib.*, bt.expiry_date, bt.batch_no, l.code AS location_code, bx.box_code
         FROM inventory_balances ib
         LEFT JOIN batches bt ON bt.id = ib.batch_id
         LEFT JOIN locations l ON l.id = ib.location_id
         LEFT JOIN boxes bx ON bx.id = ib.box_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE WHEN bt.expiry_date IS NULL THEN 1 ELSE 0 END, bt.expiry_date ASC, ib.updated_at ASC`,
    )
    .all(...params) as unknown as Array<BalanceRow & { expiry_date: string | null; batch_no: string | null; location_code: string; box_code: string | null }>;

  let remaining = input.quantity;
  let totalAvailable = 0;
  for (const candidate of candidates) {
    totalAvailable += Number(candidate.quantity) - Number(candidate.reserved_quantity);
  }
  if (totalAvailable < input.quantity) {
    if (input.boxId) {
      const box = loadBox(db, input.boxId);
      const boxBatch = input.boxId
        ? (db.prepare('SELECT DISTINCT batch_id FROM inventory_balances WHERE box_id = ? LIMIT 1').get(input.boxId) as
            | { batch_id: string | null }
            | undefined)
        : undefined;
      if (boxBatch?.batch_id) {
        const batch = db.prepare('SELECT expiry_date, batch_no FROM batches WHERE id = ?').get(boxBatch.batch_id) as
          | { expiry_date: string | null; batch_no: string }
          | undefined;
        if (batch && isExpired(batch.expiry_date)) {
          throw conflict('EXPIRED_STOCK_BLOCKED', `Box ${box.box_code} only holds expired stock (batch ${batch.batch_no})`, {
            boxCode: box.box_code,
            expiryDate: batch.expiry_date,
          });
        }
      }
    }
    throw conflict('INSUFFICIENT_STOCK', `Insufficient available stock for ${product.sku}`, {
      sku: product.sku,
      requested: input.quantity,
      available: totalAvailable,
    });
  }

  const created: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const available = Number(candidate.quantity) - Number(candidate.reserved_quantity);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    const result = db
      .prepare(
        `UPDATE inventory_balances
            SET reserved_quantity = reserved_quantity + ?, updated_at = ?
          WHERE id = ? AND (quantity - reserved_quantity) >= ?`,
      )
      .run(take, nowIso(), candidate.id, take);
    if (Number(result.changes) !== 1) {
      throw conflict('CONCURRENT_STOCK_CHANGE', 'Stock changed during reservation; reload and retry');
    }
    const id = newId();
    const reservationNo = documentNo(db, 'RES', 'RES', 6);
    db.prepare(
      `INSERT INTO reservations
        (id, reservation_no, order_id, order_line_id, product_id, warehouse_id, pool_id,
         location_id, box_id, batch_id, quantity, remaining_quantity, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).run(
      id,
      reservationNo,
      input.orderId,
      input.orderLineId,
      input.productId,
      input.warehouseId,
      input.poolId,
      candidate.location_id,
      candidate.box_id,
      candidate.batch_id,
      take,
      take,
      input.user.id,
      nowIso(),
    );
    recordAudit(db, {
      eventType: 'RESERVATION_CREATED',
      entityType: 'ORDER_LINE',
      entityId: input.orderLineId,
      after: {
        reservationNo,
        quantity: take,
        location: candidate.location_code,
        box: candidate.box_code,
        batch: candidate.batch_no,
        expiryDate: candidate.expiry_date,
      },
      refs: { orderId: input.orderId, reservationId: id, productId: input.productId },
      actor: { userId: input.user.id, role: input.user.role, correlationId: input.correlationId },
    });
    created.push({
      id,
      reservationNo,
      quantity: take,
      locationId: candidate.location_id,
      boxId: candidate.box_id,
      batchId: candidate.batch_id,
      expiryDate: candidate.expiry_date,
    });
    remaining -= take;
  }

  db.prepare('UPDATE order_lines SET allocated_qty = allocated_qty + ?, status = ? WHERE id = ?').run(
    input.quantity,
    'ALLOCATED',
    input.orderLineId,
  );
  return created;
}

export function releaseReservation(
  db: DB,
  reservationId: string,
  user: AuthUser,
  reason: string,
  correlationId?: string | null,
): number {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as
    | {
        id: string;
        order_id: string;
        order_line_id: string;
        product_id: string;
        location_id: string;
        box_id: string | null;
        batch_id: string | null;
        pool_id: string;
        warehouse_id: string;
        remaining_quantity: number;
        status: string;
        reservation_no: string;
      }
    | undefined;
  if (!reservation) throw notFound('Reservation not found');
  if (!['ACTIVE', 'PARTIALLY_CONSUMED'].includes(reservation.status) || Number(reservation.remaining_quantity) <= 0) {
    return 0;
  }
  const qty = Number(reservation.remaining_quantity);
  const result = db
    .prepare(
      `UPDATE inventory_balances SET reserved_quantity = reserved_quantity - ?, updated_at = ?
        WHERE warehouse_id = ? AND location_id = ? AND pool_id = ? AND product_id = ? AND status = 'AVAILABLE'
          AND COALESCE(batch_id, '') = COALESCE(?, '') AND COALESCE(box_id, '') = COALESCE(?, '')
          AND reserved_quantity >= ?`,
    )
    .run(
      qty,
      nowIso(),
      reservation.warehouse_id,
      reservation.location_id,
      reservation.pool_id,
      reservation.product_id,
      reservation.batch_id,
      reservation.box_id,
      qty,
    );
  if (Number(result.changes) !== 1) {
    throw conflict('RESERVATION_MISMATCH', 'Reserved balance is inconsistent; reconciliation is required');
  }
  db.prepare(
    "UPDATE reservations SET remaining_quantity = 0, status = 'RELEASED', closed_at = ? WHERE id = ?",
  ).run(nowIso(), reservationId);
  db.prepare(
    'UPDATE order_lines SET allocated_qty = CASE WHEN allocated_qty > ? THEN allocated_qty - ? ELSE 0 END WHERE id = ?',
  ).run(qty, qty, reservation.order_line_id);
  recordAudit(db, {
    eventType: 'RESERVATION_RELEASED',
    entityType: 'ORDER_LINE',
    entityId: reservation.order_line_id,
    transactionId: null,
    reason,
    after: { reservationNo: reservation.reservation_no, releasedQuantity: qty },
    refs: { orderId: reservation.order_id, reservationId },
    actor: { userId: user.id, role: user.role, correlationId },
  });
  return qty;
}

export const REVERSAL_MAP: Partial<Record<MovementType, MovementType>> = {
  PICK: 'PICK_REVERSAL',
  DISPATCH: 'PICK_REVERSAL',
  TRANSFER_DISPATCH: 'TRANSFER_RETURN',
  ADJUSTMENT_IN: 'ADJUSTMENT_OUT',
  ADJUSTMENT_OUT: 'ADJUSTMENT_IN',
  RECEIPT: 'ADJUSTMENT_OUT',
  QC_ACCEPT: 'QC_QUARANTINE',
  PUTAWAY: 'PUTAWAY',
};

export function reverseTransaction(db: DB, txnId: string, user: AuthUser, reason: string, correlationId?: string | null): string {
  const original = db.prepare('SELECT * FROM inventory_transactions WHERE id = ?').get(txnId) as Record<string, any> | undefined;
  if (!original) throw notFound('Transaction not found');
  const already = db.prepare('SELECT id FROM inventory_transactions WHERE reversal_of = ?').get(txnId);
  if (already) throw conflict('ALREADY_REVERSED', 'This transaction has already been reversed');
  const reversalType = REVERSAL_MAP[original.movement_type as MovementType];
  if (!reversalType) throw conflict('NOT_REVERSIBLE', `Movement type ${original.movement_type} cannot be reversed automatically`);

  const from = original.to_location_id
    ? {
        warehouseId: original.to_warehouse_id,
        locationId: original.to_location_id,
        poolId: original.to_pool_id,
        status: original.to_status,
        boxId: original.to_box_id,
        batchId: original.to_batch_id,
      }
    : null;
  const to = original.from_location_id
    ? {
        warehouseId: original.from_warehouse_id,
        locationId: original.from_location_id,
        poolId: original.from_pool_id,
        status: original.from_status,
        boxId: original.from_box_id,
        batchId: original.from_batch_id,
      }
    : null;

  const result = postMovement(db, {
    movementType: reversalType,
    productId: original.product_id,
    quantity: Number(original.quantity),
    from,
    to,
    referenceType: 'REVERSAL',
    referenceId: txnId,
    referenceNo: original.txn_no,
    reason,
    user,
    correlationId,
    reversalOf: txnId,
    metadata: { originalTxnNo: original.txn_no },
  });
  return result.txnId;
}

export function boxContents(db: DB, boxId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM box_contents WHERE box_id = ? ORDER BY sku, batch_no').all(boxId);
}

export function boxTimeline(db: DB, boxId: string, limit = 200): Array<Record<string, unknown>> {
  const ledger = db
    .prepare(
      `SELECT 'TXN' AS kind, t.id AS id, t.created_at AS at, t.movement_type AS type,
              t.txn_no AS reference, t.quantity AS quantity, p.sku AS sku,
              u.name AS actor, t.reason AS reason,
              t.from_location_id AS from_location_id, t.to_location_id AS to_location_id
         FROM inventory_transactions t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.from_box_id = ? OR t.to_box_id = ?`,
    )
    .all(boxId, boxId);
  const audits = db
    .prepare(
      `SELECT 'AUDIT' AS kind, e.id AS id, e.created_at AS at, e.event_type AS type,
              e.event_type AS reference, NULL AS quantity, NULL AS sku,
              u.name AS actor, e.reason AS reason,
              NULL AS from_location_id, NULL AS to_location_id
         FROM audit_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.entity_type = 'BOX' AND e.entity_id = ?`,
    )
    .all(boxId);
  return [...ledger, ...audits]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export interface ReconciliationCheck {
  name: string;
  ok: boolean;
  details: unknown;
}

export function reconcileInventory(db: DB): { ok: boolean; checks: ReconciliationCheck[] } {
  const checks: ReconciliationCheck[] = [];

  const balanceTotals = db
    .prepare(
      `SELECT product_id, SUM(quantity) AS qty, SUM(reserved_quantity) AS reserved
         FROM inventory_balances GROUP BY product_id`,
    )
    .all() as Array<{ product_id: string; qty: number; reserved: number }>;

  const ledgerNet = db
    .prepare(
      `SELECT product_id,
              SUM(CASE WHEN to_location_id IS NOT NULL THEN quantity ELSE 0 END) -
              SUM(CASE WHEN from_location_id IS NOT NULL THEN quantity ELSE 0 END) AS net
         FROM inventory_transactions GROUP BY product_id`,
    )
    .all() as Array<{ product_id: string; net: number }>;
  const ledgerMap = new Map(ledgerNet.map((r) => [r.product_id, Number(r.net)]));
  const balanceMismatches = balanceTotals
    .filter((row) => Number(row.qty) !== (ledgerMap.get(row.product_id) ?? 0))
    .map((row) => ({
      productId: row.product_id,
      balanceQuantity: Number(row.qty),
      ledgerNet: ledgerMap.get(row.product_id) ?? 0,
    }));
  checks.push({
    name: 'ledger_vs_balances',
    ok: balanceMismatches.length === 0,
    details: balanceMismatches,
  });

  const reservationMismatch = db
    .prepare(
      `SELECT * FROM (
         SELECT r.product_id, r.location_id, r.box_id, r.batch_id, r.pool_id, r.warehouse_id,
                SUM(r.remaining_quantity) AS reserved_remaining,
                COALESCE((
                  SELECT SUM(ib.reserved_quantity) FROM inventory_balances ib
                   WHERE ib.product_id = r.product_id AND ib.location_id = r.location_id
                     AND ib.pool_id = r.pool_id AND ib.warehouse_id = r.warehouse_id
                     AND COALESCE(ib.box_id, '') = COALESCE(r.box_id, '')
                     AND COALESCE(ib.batch_id, '') = COALESCE(r.batch_id, '')
                     AND ib.status = 'AVAILABLE'
                ), 0) AS balance_reserved
           FROM reservations r
          WHERE r.status IN ('ACTIVE','PARTIALLY_CONSUMED')
          GROUP BY r.product_id, r.location_id, r.box_id, r.batch_id, r.pool_id, r.warehouse_id
       ) s
        WHERE s.balance_reserved <> s.reserved_remaining`,
    )
    .all();
  checks.push({ name: 'reservations_vs_balances', ok: reservationMismatch.length === 0, details: reservationMismatch });

  const lineMismatch = db
    .prepare(
      `SELECT * FROM (
         SELECT ol.id, ol.allocated_qty,
                COALESCE(SUM(CASE WHEN r.status IN ('ACTIVE','PARTIALLY_CONSUMED') THEN r.remaining_quantity ELSE 0 END), 0) AS reserved
           FROM order_lines ol
           LEFT JOIN reservations r ON r.order_line_id = ol.id
          GROUP BY ol.id
       ) s
        WHERE s.reserved <> s.allocated_qty`,
    )
    .all();
  checks.push({ name: 'reservations_vs_order_lines', ok: lineMismatch.length === 0, details: lineMismatch });

  const boxMismatch = db
    .prepare(
      `SELECT * FROM (
         SELECT b.id, b.box_code,
                COALESCE(SUM(ib.quantity), 0) AS contents,
                CASE WHEN b.status IN ('EMPTY') AND COALESCE(SUM(ib.quantity), 0) > 0 THEN 1 ELSE 0 END AS inconsistent
           FROM boxes b LEFT JOIN inventory_balances ib ON ib.box_id = b.id
          GROUP BY b.id
       ) s
        WHERE s.inconsistent = 1`,
    )
    .all();
  checks.push({ name: 'box_status_vs_contents', ok: boxMismatch.length === 0, details: boxMismatch });

  const negative = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inventory_balances
        WHERE quantity < 0 OR reserved_quantity < 0 OR reserved_quantity > quantity`,
    )
    .get() as { n: number };
  checks.push({ name: 'non_negative_balances', ok: Number(negative.n) === 0, details: { violations: Number(negative.n) } });

  const receiptMismatch = db
    .prepare(
      `SELECT rl.id, rl.received_qty, rl.accepted_qty, rl.rejected_qty, rl.quarantined_qty,
              (rl.accepted_qty + rl.rejected_qty + rl.quarantined_qty) AS disposed
         FROM receipt_lines rl
        WHERE rl.qc_status <> 'PENDING'
          AND (rl.accepted_qty + rl.rejected_qty + rl.quarantined_qty) <> rl.received_qty`,
    )
    .all();
  checks.push({ name: 'qc_quantity_reconciliation', ok: receiptMismatch.length === 0, details: receiptMismatch });

  return { ok: checks.every((check) => check.ok), checks };
}

export function createEmptyBox(
  db: DB,
  input: {
    boxType: 'SINGLE' | 'MIXED';
    warehouseId: string;
    locationId: string;
    poolId: string;
    user: AuthUser;
    correlationId?: string | null;
    notes?: string | null;
  },
): { id: string; boxCode: string } {
  const location = loadLocation(db, input.locationId);
  if (location.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', `Location ${location.code} is not active`);
  if (location.warehouse_id !== input.warehouseId) throw conflict('LOCATION_WAREHOUSE_MISMATCH', 'Location belongs to another warehouse');
  loadPool(db, input.poolId);
  const boxCode = nextBoxCode(db, input.boxType);
  const id = newId();
  db.prepare(
    `INSERT INTO boxes (id, box_code, box_type, status, warehouse_id, location_id, pool_id, created_by, created_at, notes)
     VALUES (?, ?, ?, 'EMPTY', ?, ?, ?, ?, ?, ?)`,
  ).run(id, boxCode, input.boxType, input.warehouseId, input.locationId, input.poolId, input.user.id, nowIso(), input.notes ?? null);
  recordAudit(db, {
    eventType: 'BOX_CREATED',
    entityType: 'BOX',
    entityId: id,
    after: { boxCode, boxType: input.boxType, location: location.code, poolId: input.poolId },
    actor: { userId: input.user.id, role: input.user.role, correlationId: input.correlationId },
  });
  return { id, boxCode };
}

export function moveBox(
  db: DB,
  input: {
    boxId: string;
    toLocationId: string;
    user: AuthUser;
    correlationId?: string | null;
    reason?: string;
    referenceType?: string;
    referenceId?: string;
    referenceNo?: string;
    metadata?: Record<string, unknown> | null;
  },
): { movedLines: number; quantity: number; transactions: string[] } {
  const box = loadBox(db, input.boxId);
  if (box.status === 'RETIRED') throw conflict('BOX_RETIRED', 'Retired boxes cannot be moved');
  const destination = loadLocation(db, input.toLocationId);
  if (destination.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', `Destination ${destination.code} is not active`);
  if (destination.warehouse_id !== box.warehouse_id) throw conflict('WAREHOUSE_MISMATCH', 'Destination is in another warehouse');
  if (box.location_id === destination.id) throw badRequest('NO_OP_MOVEMENT', 'Box is already at this location');

  const contents = db
    .prepare("SELECT * FROM inventory_balances WHERE box_id = ? AND status = 'AVAILABLE'")
    .all(input.boxId) as unknown as BalanceRow[];
  let quantity = 0;
  const transactions: string[] = [];
  if (contents.length === 0) {
    db.prepare('UPDATE boxes SET location_id = ? WHERE id = ?').run(destination.id, input.boxId);
    recordAudit(db, {
      eventType: 'BOX_MOVED_EMPTY',
      entityType: 'BOX',
      entityId: input.boxId,
      before: { locationId: box.location_id },
      after: { locationId: destination.id, boxCode: box.box_code },
      actor: { userId: input.user.id, role: input.user.role, correlationId: input.correlationId },
    });
    return { movedLines: 0, quantity: 0, transactions };
  }
  if (!box.location_id) throw conflict('BOX_LOCATION_MISSING', 'Box has contents but no recorded location');
  for (const line of contents) {
    const movement = postMovement(db, {
      movementType: 'PUTAWAY',
      productId: line.product_id,
      quantity: Number(line.quantity),
      from: {
        warehouseId: line.warehouse_id,
        locationId: line.location_id,
        poolId: line.pool_id,
        status: 'AVAILABLE',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      to: {
        warehouseId: box.warehouse_id,
        locationId: destination.id,
        poolId: line.pool_id,
        status: 'AVAILABLE',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      referenceType: input.referenceType ?? 'BOX',
      referenceId: input.referenceId ?? box.id,
      referenceNo: input.referenceNo ?? box.box_code,
      reason: input.reason ?? 'Box move',
      user: input.user,
      correlationId: input.correlationId,
      metadata: input.metadata ?? null,
      allowBoxRelocation: true,
      reconcileBox: false,
    });
    transactions.push(movement.txnId);
    quantity += Number(line.quantity);
  }
  db.prepare('UPDATE boxes SET location_id = ? WHERE id = ?').run(destination.id, input.boxId);
  adjustBoxAfterMovement(db, input.boxId, input.user, input.correlationId);
  return { movedLines: contents.length, quantity, transactions };
}

export function retireBox(db: DB, boxId: string, user: AuthUser, reason: string, correlationId?: string | null): void {
  const box = loadBox(db, boxId);
  const contents = db.prepare('SELECT COALESCE(SUM(quantity),0) AS qty FROM inventory_balances WHERE box_id = ?').get(boxId) as {
    qty: number;
  };
  if (Number(contents.qty) > 0) throw conflict('BOX_NOT_EMPTY', 'Empty the box through authorized stock movements before retiring it');
  db.prepare("UPDATE boxes SET status = 'RETIRED', retired_at = ? WHERE id = ?").run(nowIso(), boxId);
  recordAudit(db, {
    eventType: 'BOX_RETIRED',
    entityType: 'BOX',
    entityId: boxId,
    reason,
    after: { boxCode: box.box_code, status: 'RETIRED' },
    actor: { userId: user.id, role: user.role, correlationId: correlationId ?? null },
  });
}

export function reuseBox(
  db: DB,
  input: { boxId: string; locationId: string; poolId: string; user: AuthUser; correlationId?: string | null },
): void {
  const box = loadBox(db, input.boxId);
  if (box.status !== 'EMPTY' && box.status !== 'RETIRED') {
    throw conflict('BOX_NOT_REUSABLE', 'Only empty or retired boxes can be explicitly reused');
  }
  const location = loadLocation(db, input.locationId);
  loadPool(db, input.poolId);
  if (location.warehouse_id !== box.warehouse_id) throw conflict('WAREHOUSE_MISMATCH', 'Location is in another warehouse');
  db.prepare(
    "UPDATE boxes SET status = 'EMPTY', location_id = ?, pool_id = ?, retired_at = NULL, reuse_count = reuse_count + 1 WHERE id = ?",
  ).run(input.locationId, input.poolId, input.boxId);
  recordAudit(db, {
    eventType: 'BOX_REUSED',
    entityType: 'BOX',
    entityId: box.id,
    before: { status: box.status, locationId: box.location_id },
    after: { status: 'EMPTY', locationId: location.id, poolId: input.poolId },
    reason: 'Explicit box reuse',
    actor: { userId: input.user.id, role: input.user.role, correlationId: input.correlationId ?? null },
  });
}

export function resolveBarcode(db: DB, barcode: string): Record<string, unknown> {
  const value = barcode.trim();
  if (!value) throw badRequest('BARCODE_REQUIRED', 'Barcode is required');

  const box = db.prepare('SELECT * FROM boxes WHERE box_code = ?').get(value) as Record<string, any> | undefined;
  if (box) {
    const contents = boxContents(db, box.id);
    return {
      type: 'BOX',
      box: {
        id: box.id,
        code: box.box_code,
        boxType: box.box_type,
        status: box.status,
        locationId: box.location_id,
        poolId: box.pool_id,
      },
      contents,
      totalQuantity: contents.reduce((sum, c) => sum + Number(c.quantity), 0),
    };
  }
  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(value) as Record<string, any> | undefined;
  if (batch) {
    return {
      type: 'BATCH',
      batch: { id: batch.id, batchNo: batch.batch_no, expiryDate: batch.expiry_date, productId: batch.product_id },
    };
  }
  const product = db
    .prepare(
      `SELECT p.*, pb.barcode FROM products p JOIN product_barcodes pb ON pb.product_id = p.id WHERE pb.barcode = ?`,
    )
    .get(value) as Record<string, any> | undefined;
  if (product) {
    const balances = db
      .prepare(
        `SELECT ib.quantity, ib.reserved_quantity, ib.status, l.code AS location, bx.box_code, p2.sku
           FROM inventory_balances ib
           JOIN locations l ON l.id = ib.location_id
           LEFT JOIN boxes bx ON bx.id = ib.box_id
           JOIN products p2 ON p2.id = ib.product_id
          WHERE ib.product_id = ? AND ib.quantity > 0
          ORDER BY ib.updated_at DESC`,
      )
      .all(product.id);
    return {
      type: 'PRODUCT',
      product: { id: product.id, sku: product.sku, name: product.name, barcode: product.barcode, baseUom: product.base_uom },
      balances,
    };
  }
  const location = db.prepare('SELECT * FROM locations WHERE code = ?').get(value) as Record<string, any> | undefined;
  if (location) {
    return { type: 'LOCATION', location: { id: location.id, code: location.code, type: location.type, status: location.status } };
  }
  const task = db.prepare('SELECT * FROM tasks WHERE task_no = ?').get(value) as Record<string, any> | undefined;
  if (task) return { type: 'TASK', task: { id: task.id, taskNo: task.task_no, type: task.task_type, status: task.status } };

  throw notFound(`No record matches barcode '${value}'`);
}

export function listBalances(
  db: DB,
  filters: { productId?: string; sku?: string; poolId?: string; boxId?: string; locationId?: string; batchId?: string; status?: string; warehouseId?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['ib.quantity > 0'];
  const params: any[] = [];
  if (filters.productId) {
    conditions.push('ib.product_id = ?');
    params.push(filters.productId);
  }
  if (filters.sku) {
    conditions.push('p.sku = ?');
    params.push(filters.sku);
  }
  if (filters.poolId) {
    conditions.push('ib.pool_id = ?');
    params.push(filters.poolId);
  }
  if (filters.boxId) {
    conditions.push('ib.box_id = ?');
    params.push(filters.boxId);
  }
  if (filters.locationId) {
    conditions.push('ib.location_id = ?');
    params.push(filters.locationId);
  }
  if (filters.batchId) {
    conditions.push('ib.batch_id = ?');
    params.push(filters.batchId);
  }
  if (filters.status) {
    conditions.push('ib.status = ?');
    params.push(filters.status);
  }
  if (filters.warehouseId) {
    conditions.push('ib.warehouse_id = ?');
    params.push(filters.warehouseId);
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT ib.*, p.sku, p.name AS product_name, p.base_uom, l.code AS location_code, l.type AS location_type,
              sp.code AS pool_code, bx.box_code, bt.batch_no, bt.expiry_date
         FROM inventory_balances ib
         JOIN products p ON p.id = ib.product_id
         JOIN locations l ON l.id = ib.location_id
         JOIN stock_pools sp ON sp.id = ib.pool_id
         LEFT JOIN boxes bx ON bx.id = ib.box_id
         LEFT JOIN batches bt ON bt.id = ib.batch_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.sku, l.code
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inventory_balances ib JOIN products p ON p.id = ib.product_id WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}

export function listTransactions(
  db: DB,
  filters: { productId?: string; movementType?: string; referenceId?: string; boxId?: string; userId?: string; from?: string; to?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.productId) {
    conditions.push('t.product_id = ?');
    params.push(filters.productId);
  }
  if (filters.movementType) {
    conditions.push('t.movement_type = ?');
    params.push(filters.movementType);
  }
  if (filters.referenceId) {
    conditions.push(
      '(t.reference_id = ? OR t.reversal_of IN (SELECT r.id FROM inventory_transactions r WHERE r.reference_id = ?))',
    );
    params.push(filters.referenceId, filters.referenceId);
  }
  if (filters.boxId) {
    conditions.push('(t.from_box_id = ? OR t.to_box_id = ?)');
    params.push(filters.boxId, filters.boxId);
  }
  if (filters.userId) {
    conditions.push('t.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.from) {
    conditions.push('t.created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('t.created_at <= ?');
    params.push(filters.to);
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT t.*, p.sku, p.name AS product_name, u.name AS user_name,
              fl.code AS from_location, tl.code AS to_location,
              fb.box_code AS from_box, tb.box_code AS to_box, bt.batch_no
         FROM inventory_transactions t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN locations fl ON fl.id = t.from_location_id
         LEFT JOIN locations tl ON tl.id = t.to_location_id
         LEFT JOIN boxes fb ON fb.id = t.from_box_id
         LEFT JOIN boxes tb ON tb.id = t.to_box_id
         LEFT JOIN batches bt ON bt.id = COALESCE(t.from_batch_id, t.to_batch_id)
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM inventory_transactions t WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}

export { AppError };
