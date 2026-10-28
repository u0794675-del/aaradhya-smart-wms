import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { isExpired, nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement } from './inventory.ts';
import { completeTask, createTask } from './tasks.ts';

export interface ReturnLineInput {
  orderLineId?: string | null;
  productId: string;
  quantity: number;
  batchId?: string | null;
}

export interface InspectLineInput {
  returnLineId: string;
  restockQty?: number;
  damagedQty?: number;
  rejectedQty?: number;
  reworkQty?: number;
  disposedQty?: number;
}

function loadReturn(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM returns WHERE id = ? OR return_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!row) throw notFound('Return not found');
  return row;
}

function returnLines(db: DB, returnId: string): Array<Record<string, any>> {
  return db
    .prepare(
      `SELECT rl.*, p.sku, p.name AS product_name, p.is_expiry_tracked, b.batch_no, b.expiry_date
         FROM return_lines rl
         JOIN products p ON p.id = rl.product_id
         LEFT JOIN batches b ON b.id = rl.batch_id
        WHERE rl.return_id = ?
        ORDER BY rl.id`,
    )
    .all(returnId) as Array<Record<string, any>>;
}

function locationByType(db: DB, warehouseId: string, type: string) {
  const row = db
    .prepare("SELECT * FROM locations WHERE warehouse_id = ? AND type = ? AND status = 'ACTIVE' ORDER BY code LIMIT 1")
    .get(warehouseId, type) as Record<string, any> | undefined;
  if (!row) throw conflict('LOCATION_NOT_CONFIGURED', `No active ${type} location exists`);
  return row;
}

export function getReturn(db: DB, id: string) {
  const row = db
    .prepare(
      `SELECT r.*, o.order_no, o.customer_name
         FROM returns r JOIN orders o ON o.id = r.order_id
        WHERE r.id = ? OR r.return_no = ?`,
    )
    .get(id, id.toUpperCase()) as Record<string, any> | undefined;
  if (!row) throw notFound('Return not found');
  return { ...row, lines: returnLines(db, row.id) };
}

export function listReturns(db: DB, filters: { status?: string; orderId?: string; limit?: number; offset?: number }) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    conditions.push(`r.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.orderId) {
    conditions.push('r.order_id = ?');
    params.push(filters.orderId);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT r.*, o.order_no, o.customer_name,
              (SELECT COUNT(*) FROM return_lines rl WHERE rl.return_id = r.id) AS line_count
         FROM returns r JOIN orders o ON o.id = r.order_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.received_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM returns r WHERE ${conditions.join(' AND ')}`).get(...params) as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

export function createReturn(
  db: DB,
  input: { orderId: string; reason: string; notes?: string | null; lines: ReturnLineInput[] },
  actor: AuthUser,
): { id: string; returnNo: string } {
  if (!input.lines.length) throw badRequest('RETURN_LINES_REQUIRED', 'A return needs at least one line');
  if (!input.reason.trim()) throw badRequest('RETURN_REASON_REQUIRED', 'A return reason is required');
  const order = db.prepare('SELECT * FROM orders WHERE id = ? OR order_no = ?').get(input.orderId, input.orderId.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!order) throw notFound('Order not found');
  if (!['DISPATCHED', 'COMPLETED'].includes(order.status)) {
    throw conflict('ORDER_NOT_DISPATCHED', 'Only dispatched or completed orders can be returned');
  }
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE is_active = 1 ORDER BY code LIMIT 1').get() as
    | Record<string, any>
    | undefined;
  if (!warehouse) throw notFound('No active warehouse');
  const returnsLocation = locationByType(db, warehouse.id, 'RETURN');
  const pool = db.prepare('SELECT * FROM stock_pools WHERE code = ?').get(order.pool_code) as Record<string, any> | undefined;
  if (!pool) throw notFound('Order stock pool not found');

  const id = newId();
  const returnNo = documentNo(db, 'RETURN', 'RTN', 6);
  db.prepare(
    `INSERT INTO returns
      (id, return_no, order_id, reason, status, received_by, received_at, disposition, notes)
     VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, 'PENDING', ?)`,
  ).run(id, returnNo, order.id, input.reason.trim(), actor.id, nowIso(), input.notes ?? null);

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Returned quantities must be positive whole numbers');
    }
    let orderLine: Record<string, any> | undefined;
    if (line.orderLineId) {
      orderLine = db.prepare('SELECT * FROM order_lines WHERE id = ? AND order_id = ?').get(line.orderLineId, order.id) as
        | Record<string, any>
        | undefined;
      if (!orderLine) throw notFound(`Order line ${line.orderLineId} does not belong to ${order.order_no}`);
    } else {
      const matches = db
        .prepare('SELECT * FROM order_lines WHERE order_id = ? AND product_id = ?')
        .all(order.id, line.productId) as Array<Record<string, any>>;
      if (matches.length !== 1) {
        throw badRequest('ORDER_LINE_REQUIRED', 'Specify the order line when a product appears on multiple lines');
      }
      orderLine = matches[0];
    }
    if (orderLine.product_id !== line.productId) {
      throw badRequest('ORDER_LINE_PRODUCT_MISMATCH', 'Returned product does not match the order line');
    }
    const alreadyReturned = db
      .prepare(
        `SELECT COALESCE(SUM(rl.received_qty), 0) AS qty FROM return_lines rl
           JOIN returns r ON r.id = rl.return_id
          WHERE rl.order_line_id = ? AND r.status <> 'CANCELLED'`,
      )
      .get(orderLine.id) as { qty: number };
    const returnable = Number(orderLine.dispatched_qty) - Number(alreadyReturned.qty);
    if (line.quantity > returnable) {
      throw conflict('RETURN_EXCEEDS_DISPATCH', `Only ${returnable} dispatched units can still be returned for this line`, {
        orderLineId: orderLine.id,
        dispatched: Number(orderLine.dispatched_qty),
        alreadyReturned: Number(alreadyReturned.qty),
        requested: line.quantity,
        returnable,
      });
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId) as Record<string, any> | undefined;
    if (!product) throw notFound('Product not found');
    let batchId = line.batchId ?? null;
    if (product.is_batch_tracked === 1 && !batchId) {
      throw badRequest('BATCH_REQUIRED', `SKU ${product.sku} requires a batch for returns`);
    }
    if (batchId) {
      const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND product_id = ?').get(batchId, line.productId);
      if (!batch) throw badRequest('BATCH_PRODUCT_MISMATCH', 'Batch does not belong to the returned product');
    }

    db.prepare(
      `INSERT INTO return_lines
        (id, return_id, order_line_id, product_id, batch_id, box_id, expected_qty, received_qty)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(newId(), id, orderLine.id, line.productId, batchId, Number(orderLine.dispatched_qty), line.quantity);
    postMovement(db, {
      movementType: 'RETURN_RECEIVE',
      productId: line.productId,
      quantity: line.quantity,
      from: null,
      to: {
        warehouseId: warehouse.id,
        locationId: returnsLocation.id,
        poolId: pool.id,
        status: 'RETURN_PENDING',
        boxId: null,
        batchId,
      },
      referenceType: 'RETURN',
      referenceId: id,
      referenceNo: returnNo,
      reason: `Customer return: ${input.reason.trim()}`,
      user: actor,
      metadata: { orderNo: order.order_no, orderLineId: orderLine.id },
    });
  }

  createTask(
    db,
    {
      taskType: 'RETURN_INSPECTION',
      warehouseId: warehouse.id,
      entityType: 'RETURN',
      entityId: id,
      description: `Inspect return ${returnNo} for ${order.order_no}`,
      priority: 'NORMAL',
      dueInHours: 8,
    },
    actor,
  );
  recordAudit(db, {
    eventType: 'RETURN_RECEIVED',
    entityType: 'RETURN',
    entityId: id,
    after: { returnNo, orderNo: order.order_no, lines: input.lines, location: returnsLocation.code },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, returnNo };
}

export function inspectReturn(
  db: DB,
  id: string,
  input: { lines: InspectLineInput[]; restockLocationId?: string | null; notes?: string | null },
  actor: AuthUser,
): { status: string; disposition: string; transactions: string[] } {
  const returned = loadReturn(db, id);
  if (!['RECEIVED', 'INSPECTED'].includes(returned.status)) {
    throw conflict('INVALID_RETURN_TRANSITION', `Return is ${returned.status} and cannot be inspected`);
  }
  if (!input.lines.length) throw badRequest('INSPECTION_LINES_REQUIRED', 'At least one return line must be inspected');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(returned.order_id) as Record<string, any>;
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE is_active = 1 ORDER BY code LIMIT 1').get() as Record<string, any>;
  const returnsLocation = locationByType(db, warehouse.id, 'RETURN');
  const quarantine = locationByType(db, warehouse.id, 'QUARANTINE');
  const restockLocation = input.restockLocationId
    ? (db.prepare('SELECT * FROM locations WHERE id = ?').get(input.restockLocationId) as Record<string, any> | undefined)
    : locationByType(db, warehouse.id, 'RACK');
  if (!restockLocation) throw notFound('Restock location not found');
  if (restockLocation.type !== 'RACK' || restockLocation.status !== 'ACTIVE') {
    throw conflict('INVALID_RESTOCK_LOCATION', 'Restock destination must be an active RACK location');
  }
  const pool = db.prepare('SELECT * FROM stock_pools WHERE code = ?').get(order.pool_code) as Record<string, any>;
  const lines = returnLines(db, returned.id);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const txnIds: string[] = [];

  for (const request of input.lines) {
    const line = byId.get(request.returnLineId);
    if (!line) throw notFound(`Return line ${request.returnLineId} does not belong to this return`);
    const remaining = Number(line.received_qty) - Number(line.inspected_qty);
    if (remaining <= 0) throw conflict('RETURN_LINE_ALREADY_INSPECTED', `Return line ${line.sku} is already fully inspected`);
    const quantities = {
      restock: request.restockQty ?? 0,
      damaged: request.damagedQty ?? 0,
      rejected: request.rejectedQty ?? 0,
      rework: request.reworkQty ?? 0,
      disposed: request.disposedQty ?? 0,
    };
    for (const value of Object.values(quantities)) {
      if (!Number.isInteger(value) || value < 0) throw badRequest('INVALID_QUANTITY', 'Inspection quantities must be non-negative whole numbers');
    }
    const inspected = Object.values(quantities).reduce((sum, value) => sum + value, 0);
    if (inspected !== remaining) {
      throw conflict('INSPECTION_QUANTITY_MISMATCH', `Inspection must account for exactly ${remaining} units of ${line.sku}`, {
        sku: line.sku,
        remaining,
        entered: inspected,
      });
    }
    if (quantities.restock > 0 && line.is_expiry_tracked === 1 && isExpired(line.expiry_date)) {
      throw conflict('EXPIRED_RETURN_RESTOCK', `Batch ${line.batch_no} expired on ${line.expiry_date} and cannot be restocked`, {
        batchNo: line.batch_no,
        expiryDate: line.expiry_date,
      });
    }

    const from = {
      warehouseId: warehouse.id,
      locationId: returnsLocation.id,
      poolId: pool.id,
      status: 'RETURN_PENDING' as const,
      boxId: null,
      batchId: line.batch_id,
    };
    const move = (
      quantity: number,
      to: { locationId: string; status: 'AVAILABLE' | 'DAMAGED' | 'REJECTED' | 'REWORK' } | null,
      reason: string,
      movementType: 'RETURN_RESTOCK' | 'RETURN_DISPOSE',
    ) => {
      const result = postMovement(db, {
        movementType,
        productId: line.product_id,
        quantity,
        from,
        to: to
          ? {
              warehouseId: warehouse.id,
              locationId: to.locationId,
              poolId: pool.id,
              status: to.status,
              boxId: null,
              batchId: line.batch_id,
            }
          : null,
        referenceType: 'RETURN',
        referenceId: returned.id,
        referenceNo: returned.return_no,
        reason,
        user: actor,
        metadata: { returnLineId: line.id, disposition: to?.status ?? 'DISPOSED' },
      });
      txnIds.push(result.txnId);
    };
    if (quantities.restock > 0) {
      move(
        quantities.restock,
        { locationId: restockLocation.id, status: 'AVAILABLE' },
        'Returned stock restocked after inspection',
        'RETURN_RESTOCK',
      );
    }
    if (quantities.damaged > 0) move(quantities.damaged, { locationId: quarantine.id, status: 'DAMAGED' }, 'Returned stock damaged', 'RETURN_DISPOSE');
    if (quantities.rejected > 0) move(quantities.rejected, { locationId: quarantine.id, status: 'REJECTED' }, 'Returned stock rejected', 'RETURN_DISPOSE');
    if (quantities.rework > 0) move(quantities.rework, { locationId: quarantine.id, status: 'REWORK' }, 'Returned stock needs rework', 'RETURN_DISPOSE');
    if (quantities.disposed > 0) move(quantities.disposed, null, 'Returned stock disposed', 'RETURN_DISPOSE');

    db.prepare(
      `UPDATE return_lines
          SET inspected_qty = inspected_qty + ?, restock_qty = restock_qty + ?, damaged_qty = damaged_qty + ?,
              rejected_qty = rejected_qty + ?, rework_qty = rework_qty + ?, disposed_qty = disposed_qty + ?
        WHERE id = ?`,
    ).run(
      inspected,
      quantities.restock,
      quantities.damaged,
      quantities.rejected,
      quantities.rework,
      quantities.disposed,
      line.id,
    );
  }

  const refreshed = returnLines(db, returned.id);
  const complete = refreshed.every((l) => Number(l.inspected_qty) >= Number(l.received_qty));
  const totals = refreshed.reduce<{
    restock: number;
    damaged: number;
    rejected: number;
    rework: number;
    disposed: number;
  }>(
    (acc, l) => {
      acc.restock += Number(l.restock_qty);
      acc.damaged += Number(l.damaged_qty);
      acc.rejected += Number(l.rejected_qty);
      acc.rework += Number(l.rework_qty);
      acc.disposed += Number(l.disposed_qty);
      return acc;
    },
    { restock: 0, damaged: 0, rejected: 0, rework: 0, disposed: 0 },
  );
  const used = Object.values(totals).filter((value) => value > 0).length;
  const disposition =
    totals.restock > 0 && used === 1 ? 'RESTOCK' : totals.restock > 0 ? 'PARTIAL' : totals.damaged > 0 ? 'DAMAGE' : totals.rejected > 0 ? 'REJECT' : totals.rework > 0 ? 'REWORK' : 'DISPOSE';
  const status = complete ? 'COMPLETED' : 'INSPECTED';
  db.prepare(
    `UPDATE returns SET status = ?, disposition = ?, inspected_by = ?, inspected_at = ?,
            notes = COALESCE(?, notes) WHERE id = ?`,
  ).run(status, disposition, actor.id, nowIso(), input.notes ?? null, returned.id);
  if (complete) {
    const tasks = db
      .prepare(
        `SELECT id FROM tasks WHERE entity_type = 'RETURN' AND entity_id = ? AND task_type = 'RETURN_INSPECTION'
           AND status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .all(returned.id) as Array<{ id: string }>;
    for (const task of tasks) completeTask(db, task.id, actor);
  }
  recordAudit(db, {
    eventType: 'RETURN_INSPECTED',
    entityType: 'RETURN',
    entityId: returned.id,
    after: { returnNo: returned.return_no, status, disposition, totals, transactions: txnIds },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status, disposition, transactions: txnIds };
}
