import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement } from './inventory.ts';

type TransferType = 'POOL_TO_POOL' | 'LOCATION_TO_LOCATION';

export interface TransferLineInput {
  productId: string;
  quantity: number;
  batchId?: string | null;
  boxId?: string | null;
  destinationLocationId?: string | null;
}

export interface CreateTransferInput {
  transferType: TransferType;
  fromLocationId: string;
  toLocationId?: string | null;
  fromPoolId: string;
  toPoolId: string;
  transitLocationId?: string | null;
  reason?: string | null;
  lines: TransferLineInput[];
}

function loadTransfer(db: DB, id: string) {
  const transfer = db.prepare('SELECT * FROM transfers WHERE id = ? OR transfer_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!transfer) throw notFound('Transfer not found');
  return transfer;
}

function transferLines(db: DB, transferId: string): Array<Record<string, any>> {
  return db
    .prepare(
      `SELECT tl.*, p.sku, p.name AS product_name, p.is_batch_tracked, p.is_expiry_tracked,
              b.batch_no, b.expiry_date, bx.box_code, dl.code AS destination_location_code
         FROM transfer_lines tl
         JOIN products p ON p.id = tl.product_id
         LEFT JOIN batches b ON b.id = tl.batch_id
         LEFT JOIN boxes bx ON bx.id = tl.box_id
         LEFT JOIN locations dl ON dl.id = tl.destination_location_id
        WHERE tl.transfer_id = ?
        ORDER BY tl.line_no`,
    )
    .all(transferId) as Array<Record<string, any>>;
}

function loadLocation(db: DB, id: string) {
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!location) throw notFound('Location not found');
  return location;
}

function loadPool(db: DB, id: string) {
  const pool = db.prepare('SELECT * FROM stock_pools WHERE id = ? AND is_active = 1').get(id) as
    | Record<string, any>
    | undefined;
  if (!pool) throw notFound('Stock pool not found or inactive');
  return pool;
}

function defaultTransit(db: DB, warehouseId: string) {
  const location = db
    .prepare("SELECT * FROM locations WHERE warehouse_id = ? AND type = 'TRANSIT' AND status = 'ACTIVE' ORDER BY code LIMIT 1")
    .get(warehouseId) as Record<string, any> | undefined;
  if (!location) throw conflict('TRANSIT_LOCATION_MISSING', 'No active transit location is configured');
  return location;
}

export function getTransfer(db: DB, id: string) {
  const transfer = loadTransfer(db, id);
  return {
    ...transfer,
    fromLocation: db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(transfer.from_location_id),
    transitLocation: db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(transfer.transit_location_id),
    lines: transferLines(db, transfer.id),
  };
}

export function listTransfers(db: DB, filters: { status?: string; limit?: number; offset?: number }) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    conditions.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT t.*, fl.code AS from_location_code, tl.code AS transit_location_code,
              fp.code AS from_pool_code, tp.code AS to_pool_code,
              (SELECT COUNT(*) FROM transfer_lines l WHERE l.transfer_id = t.id) AS line_count
         FROM transfers t
         LEFT JOIN locations fl ON fl.id = t.from_location_id
         LEFT JOIN locations tl ON tl.id = t.transit_location_id
         JOIN stock_pools fp ON fp.id = t.from_pool_id
         JOIN stock_pools tp ON tp.id = t.to_pool_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transfers t WHERE ${conditions.join(' AND ')}`).get(...params) as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

export function createTransfer(db: DB, input: CreateTransferInput, actor: AuthUser): { id: string; transferNo: string; status: string } {
  if (!input.lines.length) throw badRequest('TRANSFER_LINES_REQUIRED', 'A transfer needs at least one line');
  const fromLocation = loadLocation(db, input.fromLocationId);
  if (fromLocation.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', 'Source location is not active');
  if (!['RACK', 'STAGING'].includes(fromLocation.type)) {
    throw conflict('INVALID_TRANSFER_SOURCE', 'Transfers can only start from storage or staging locations');
  }
  const fromPool = loadPool(db, input.fromPoolId);
  const toPool = loadPool(db, input.toPoolId);
  if (fromPool.id === toPool.id && input.transferType === 'POOL_TO_POOL') {
    throw badRequest('SAME_POOL_TRANSFER', 'A pool transfer requires two different pools');
  }
  if (input.transferType === 'LOCATION_TO_LOCATION' && !input.toLocationId) {
    throw badRequest('DESTINATION_REQUIRED', 'A location-to-location transfer requires a destination location');
  }
  const transit = input.transitLocationId ? loadLocation(db, input.transitLocationId) : defaultTransit(db, fromLocation.warehouse_id);
  if (transit.type !== 'TRANSIT') throw badRequest('INVALID_TRANSIT_LOCATION', 'Transit location must be of type TRANSIT');
  if (transit.warehouse_id !== fromLocation.warehouse_id) {
    throw badRequest('TRANSIT_WAREHOUSE_MISMATCH', 'Transit location belongs to another warehouse');
  }
  const defaultDestination = input.toLocationId ?? (input.transferType === 'POOL_TO_POOL' ? input.fromLocationId : null);
  if (defaultDestination) {
    const destination = loadLocation(db, defaultDestination);
    if (destination.warehouse_id !== fromLocation.warehouse_id) {
      throw badRequest('DESTINATION_WAREHOUSE_MISMATCH', 'Destination location belongs to another warehouse');
    }
    if (destination.type !== 'RACK') {
      throw conflict('INVALID_TRANSFER_DESTINATION', 'Transfer destination must be a RACK location');
    }
  }

  const id = newId();
  const transferNo = documentNo(db, 'TRANSFER', 'TRF', 6);
  const requiresApproval = getSetting(db, 'transfer_requires_approval', true);
  const status = requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED';
  db.prepare(
    `INSERT INTO transfers
      (id, transfer_no, transfer_type, from_warehouse_id, to_warehouse_id, from_location_id,
       from_pool_id, to_pool_id, transit_location_id, status, reason, requested_by, created_at, approved_by, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    transferNo,
    input.transferType,
    fromLocation.warehouse_id,
    fromLocation.warehouse_id,
    fromLocation.id,
    fromPool.id,
    toPool.id,
    transit.id,
    status,
    input.reason ?? null,
    actor.id,
    nowIso(),
    requiresApproval ? null : actor.id,
    requiresApproval ? null : nowIso(),
  );

  input.lines.forEach((line, index) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Transfer quantities must be positive whole numbers');
    }
    const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'ACTIVE'").get(line.productId) as
      | Record<string, any>
      | undefined;
    if (!product) throw notFound(`Product ${line.productId} not found or inactive`);
    if (product.is_batch_tracked === 1 && !line.batchId) {
      throw badRequest('BATCH_REQUIRED', `SKU ${product.sku} requires a batch for transfers`);
    }
    if (line.batchId) {
      const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND product_id = ?').get(line.batchId, line.productId);
      if (!batch) throw badRequest('BATCH_PRODUCT_MISMATCH', 'Batch does not belong to the transfer product');
    }
    const destinationId = line.destinationLocationId ?? defaultDestination;
    if (!destinationId) throw badRequest('DESTINATION_REQUIRED', 'Each transfer line needs a destination location');
    const destination = loadLocation(db, destinationId);
    if (destination.type !== 'RACK') throw conflict('INVALID_TRANSFER_DESTINATION', 'Transfer destination must be a RACK location');
    if (destination.warehouse_id !== fromLocation.warehouse_id) {
      throw badRequest('DESTINATION_WAREHOUSE_MISMATCH', 'Destination belongs to another warehouse');
    }
    if (line.boxId) {
      throw conflict(
        'BOX_TRANSFER_UNSUPPORTED',
        'Unpack box contents before transferring; container movement is handled through the box workflow',
      );
    }
    db.prepare(
      `INSERT INTO transfer_lines
        (id, transfer_id, line_no, product_id, batch_id, box_id, quantity, destination_location_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), id, index + 1, line.productId, line.batchId ?? null, line.boxId ?? null, line.quantity, destinationId);
  });

  recordAudit(db, {
    eventType: 'TRANSFER_CREATED',
    entityType: 'TRANSFER',
    entityId: id,
    after: {
      transferNo,
      type: input.transferType,
      fromPool: fromPool.code,
      toPool: toPool.code,
      fromLocation: fromLocation.code,
      status,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, transferNo, status };
}

export function approveTransfer(db: DB, id: string, actor: AuthUser): { status: string } {
  const transfer = loadTransfer(db, id);
  if (transfer.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_TRANSFER_TRANSITION', `Transfer is ${transfer.status}, not pending approval`);
  }
  db.prepare("UPDATE transfers SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(
    actor.id,
    nowIso(),
    transfer.id,
  );
  recordAudit(db, {
    eventType: 'TRANSFER_APPROVED',
    entityType: 'TRANSFER',
    entityId: transfer.id,
    before: { status: transfer.status },
    after: { status: 'APPROVED', transferNo: transfer.transfer_no },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'APPROVED' };
}

export function dispatchTransfer(db: DB, id: string, actor: AuthUser): { status: string; transactions: string[] } {
  const transfer = loadTransfer(db, id);
  if (transfer.status !== 'APPROVED') {
    throw conflict('INVALID_TRANSFER_TRANSITION', `Transfer must be APPROVED before dispatch; it is ${transfer.status}`);
  }
  const lines = transferLines(db, transfer.id);
  if (!lines.length) throw conflict('TRANSFER_HAS_NO_LINES', 'Cannot dispatch an empty transfer');
  const txnIds: string[] = [];
  for (const line of lines) {
    if (Number(line.dispatched_qty) >= Number(line.quantity)) continue;
    const quantity = Number(line.quantity) - Number(line.dispatched_qty);
    const movement = postMovement(db, {
      movementType: 'TRANSFER_DISPATCH',
      productId: line.product_id,
      quantity,
      from: {
        warehouseId: transfer.from_warehouse_id,
        locationId: transfer.from_location_id,
        poolId: transfer.from_pool_id,
        status: 'AVAILABLE',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      to: {
        warehouseId: transfer.to_warehouse_id,
        locationId: transfer.transit_location_id,
        poolId: transfer.from_pool_id,
        status: 'IN_TRANSIT',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      referenceType: 'TRANSFER',
      referenceId: transfer.id,
      referenceNo: transfer.transfer_no,
      reason: transfer.reason ?? 'Stock transfer dispatched',
      user: actor,
      metadata: { transferType: transfer.transfer_type, destinationLocationId: line.destination_location_id },
    });
    txnIds.push(movement.txnId);
    db.prepare('UPDATE transfer_lines SET dispatched_qty = dispatched_qty + ? WHERE id = ?').run(quantity, line.id);
  }
  db.prepare("UPDATE transfers SET status = 'IN_TRANSIT', dispatched_at = ? WHERE id = ?").run(nowIso(), transfer.id);
  recordAudit(db, {
    eventType: 'TRANSFER_DISPATCHED',
    entityType: 'TRANSFER',
    entityId: transfer.id,
    after: { transferNo: transfer.transfer_no, status: 'IN_TRANSIT', transactions: txnIds },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'IN_TRANSIT', transactions: txnIds };
}

export function receiveTransfer(
  db: DB,
  id: string,
  input: { lines?: Array<{ lineId: string; quantity: number }> } | null,
  actor: AuthUser,
): { status: string; transactions: string[] } {
  const transfer = loadTransfer(db, id);
  if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(transfer.status)) {
    throw conflict('INVALID_TRANSFER_TRANSITION', `Transfer is ${transfer.status} and cannot be received`);
  }
  const lines = transferLines(db, transfer.id);
  const requested = new Map<string, number>();
  if (input?.lines?.length) {
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw badRequest('INVALID_QUANTITY', 'Received quantities must be positive whole numbers');
      }
      requested.set(line.lineId, (requested.get(line.lineId) ?? 0) + line.quantity);
    }
    const known = new Set(lines.map((l) => l.id));
    for (const lineId of requested.keys()) {
      if (!known.has(lineId)) throw notFound(`Transfer line ${lineId} does not belong to this transfer`);
    }
  }
  const txnIds: string[] = [];
  for (const line of lines) {
    const outstanding = Number(line.dispatched_qty) - Number(line.received_qty);
    if (outstanding <= 0) continue;
    const quantity = requested.size ? (requested.get(line.id) ?? 0) : outstanding;
    if (quantity <= 0) continue;
    if (quantity > outstanding) {
      throw conflict('RECEIPT_EXCEEDS_DISPATCH', `Cannot receive ${quantity} units; only ${outstanding} remain in transit`, {
        lineId: line.id,
        sku: line.sku,
        outstanding,
      });
    }
    const movement = postMovement(db, {
      movementType: 'TRANSFER_RECEIVE',
      productId: line.product_id,
      quantity,
      from: {
        warehouseId: transfer.to_warehouse_id,
        locationId: transfer.transit_location_id,
        poolId: transfer.from_pool_id,
        status: 'IN_TRANSIT',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      to: {
        warehouseId: transfer.to_warehouse_id,
        locationId: line.destination_location_id,
        poolId: transfer.to_pool_id,
        status: 'AVAILABLE',
        boxId: line.box_id,
        batchId: line.batch_id,
      },
      referenceType: 'TRANSFER',
      referenceId: transfer.id,
      referenceNo: transfer.transfer_no,
      reason: 'Stock transfer received',
      user: actor,
      metadata: { destinationLocationId: line.destination_location_id },
    });
    txnIds.push(movement.txnId);
    db.prepare('UPDATE transfer_lines SET received_qty = received_qty + ? WHERE id = ?').run(quantity, line.id);
  }
  const refreshed = transferLines(db, transfer.id);
  const fullyReceived = refreshed.every((l) => Number(l.received_qty) >= Number(l.dispatched_qty));
  const anyReceived = refreshed.some((l) => Number(l.received_qty) > 0);
  const status = fullyReceived ? 'COMPLETED' : anyReceived ? 'PARTIALLY_RECEIVED' : transfer.status;
  db.prepare('UPDATE transfers SET status = ?, received_at = ? WHERE id = ?').run(
    status,
    fullyReceived ? nowIso() : transfer.received_at ?? null,
    transfer.id,
  );
  recordAudit(db, {
    eventType: fullyReceived ? 'TRANSFER_COMPLETED' : 'TRANSFER_RECEIVED',
    entityType: 'TRANSFER',
    entityId: transfer.id,
    after: { transferNo: transfer.transfer_no, status, transactions: txnIds },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status, transactions: txnIds };
}

export function cancelTransfer(db: DB, id: string, reason: string, actor: AuthUser): { status: string } {
  const transfer = loadTransfer(db, id);
  if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(transfer.status)) {
    throw conflict('INVALID_TRANSFER_TRANSITION', `Transfer is ${transfer.status} and cannot be cancelled`);
  }
  if (!reason.trim()) throw badRequest('CANCEL_REASON_REQUIRED', 'A cancellation reason is required');
  db.prepare("UPDATE transfers SET status = 'CANCELLED', reason = COALESCE(reason, ?) WHERE id = ?").run(reason.trim(), transfer.id);
  recordAudit(db, {
    eventType: 'TRANSFER_CANCELLED',
    entityType: 'TRANSFER',
    entityId: transfer.id,
    reason: reason.trim(),
    before: { status: transfer.status },
    after: { status: 'CANCELLED', transferNo: transfer.transfer_no },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'CANCELLED' };
}
