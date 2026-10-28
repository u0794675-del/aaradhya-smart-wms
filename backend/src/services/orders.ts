import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement, releaseReservation, reserveStock, reverseTransaction } from './inventory.ts';
import { completeTask, createTask } from './tasks.ts';

type Channel = 'MANUAL' | 'MARKETPLACE' | 'B2B';
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
type PoolCode = 'B2B' | 'SHARED';

const ORDER_STATUSES = [
  'DRAFT', 'CONFIRMED', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKED', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'ON_HOLD',
] as const;

export interface CreateOrderInput {
  channel: Channel;
  poolCode?: PoolCode;
  warehouseId?: string;
  customerName: string;
  customerRef?: string | null;
  externalOrderId?: string | null;
  priority?: Priority;
  slaDueAt?: string | null;
  notes?: string | null;
  lines: Array<{ productId: string; quantity: number; boxId?: string | null }>;
}

export interface PickLineInput {
  orderLineId: string;
  reservationId?: string | null;
  quantity: number;
  scannedBoxId?: string | null;
  scannedLocationId?: string | null;
  scannedBarcode?: string | null;
}

export interface PackLineInput {
  orderLineId: string;
  quantity: number;
  batchId?: string | null;
}

export interface PackInput {
  packages?: Array<{
    weightGrams?: number | null;
    dimensions?: string | null;
    lines: PackLineInput[];
  }>;
}

export interface DispatchInput {
  carrier?: string | null;
  trackingNo?: string | null;
  proof?: Record<string, unknown> | null;
}

interface OrderRow {
  id: string;
  order_no: string;
  channel: string;
  pool_code: string;
  customer_name: string;
  status: string;
  priority: string;
  warehouse_id?: string;
  [key: string]: any;
}

function loadOrder(db: DB, id: string): OrderRow {
  const row = db.prepare('SELECT * FROM orders WHERE id = ? OR order_no = ?').get(id, id.toUpperCase()) as
    | OrderRow
    | undefined;
  if (!row) throw notFound('Order not found');
  return row;
}

function resolvePool(db: DB, poolCode: string) {
  const pool = db.prepare('SELECT * FROM stock_pools WHERE code = ? AND is_active = 1').get(poolCode) as
    | { id: string; code: string; name: string }
    | undefined;
  if (!pool) throw notFound(`Stock pool ${poolCode} is not configured`);
  return pool;
}

function resolveWarehouse(db: DB, warehouseId?: string) {
  const warehouse = warehouseId
    ? (db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId) as
        | Record<string, any>
        | undefined)
    : (db.prepare('SELECT * FROM warehouses WHERE is_active = 1 ORDER BY code LIMIT 1').get() as
        | Record<string, any>
        | undefined);
  if (!warehouse) throw notFound('No active warehouse is configured');
  return warehouse;
}

function orderWarehouse(db: DB, order: OrderRow) {
  return resolveWarehouse(db, order.warehouse_id ?? undefined);
}

function locationOfType(db: DB, warehouseId: string, type: string) {
  const row = db
    .prepare(
      "SELECT * FROM locations WHERE warehouse_id = ? AND type = ? AND status = 'ACTIVE' ORDER BY code LIMIT 1",
    )
    .get(warehouseId, type) as Record<string, any> | undefined;
  if (!row) throw conflict('LOCATION_NOT_CONFIGURED', `No active ${type} location exists for this warehouse`);
  return row;
}

function orderPoolCode(order: OrderRow): PoolCode {
  return order.pool_code as PoolCode;
}

function orderLines(db: DB, orderId: string) {
  return db
    .prepare(
      `SELECT ol.*, p.sku, p.name AS product_name, p.base_uom, p.is_batch_tracked, p.is_expiry_tracked,
              pb.barcode,
              (SELECT COALESCE(SUM(r.remaining_quantity), 0) FROM reservations r
                WHERE r.order_line_id = ol.id AND r.status IN ('ACTIVE','PARTIALLY_CONSUMED')) AS reserved_remaining
         FROM order_lines ol
         JOIN products p ON p.id = ol.product_id
         LEFT JOIN product_barcodes pb ON pb.product_id = p.id AND pb.is_primary = 1
        WHERE ol.order_id = ?
        ORDER BY ol.line_no`,
    )
    .all(orderId) as Array<Record<string, any>>;
}

function orderReservations(db: DB, orderId: string) {
  return db
    .prepare(
      `SELECT r.*, l.code AS location_code, bx.box_code, b.batch_no, b.expiry_date, p.sku
         FROM reservations r
         JOIN locations l ON l.id = r.location_id
         LEFT JOIN boxes bx ON bx.id = r.box_id
         LEFT JOIN batches b ON b.id = r.batch_id
         JOIN products p ON p.id = r.product_id
        WHERE r.order_id = ?
        ORDER BY r.created_at, r.reservation_no`,
    )
    .all(orderId);
}

function orderPackages(db: DB, orderId: string) {
  const packages = db
    .prepare('SELECT * FROM packages WHERE order_id = ? ORDER BY created_at')
    .all(orderId) as Array<Record<string, any>>;
  return packages.map((pkg) => ({
    ...pkg,
    lines: db
      .prepare(
        `SELECT pl.*, p.sku, p.name AS product_name, b.batch_no
           FROM package_lines pl
           JOIN products p ON p.id = pl.product_id
           LEFT JOIN batches b ON b.id = pl.batch_id
          WHERE pl.package_id = ?
          ORDER BY pl.id`,
      )
      .all(pkg.id),
  }));
}

export function getOrder(db: DB, id: string) {
  const order = loadOrder(db, id);
  return {
    ...order,
    lines: orderLines(db, order.id),
    reservations: orderReservations(db, order.id),
    packages: orderPackages(db, order.id),
    shipments: db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY created_at').all(order.id),
    tasks: db
      .prepare(
        `SELECT id, task_no, task_type, status, priority, assigned_to, due_at
           FROM tasks WHERE entity_type = 'ORDER' AND entity_id = ? ORDER BY created_at`,
      )
      .all(order.id),
  };
}

export function listOrders(
  db: DB,
  filters: { status?: string; channel?: string; search?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (!statuses.every((s) => (ORDER_STATUSES as readonly string[]).includes(s))) {
      throw badRequest('INVALID_STATUS_FILTER', 'Unknown order status in filter');
    }
    conditions.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.channel) {
    conditions.push('o.channel = ?');
    params.push(filters.channel);
  }
  if (filters.search) {
    conditions.push('(o.order_no LIKE ? OR o.customer_name LIKE ? OR o.external_order_id LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM order_lines ol WHERE ol.order_id = o.id) AS line_count,
              (SELECT COALESCE(SUM(ol.ordered_qty), 0) FROM order_lines ol WHERE ol.order_id = o.id) AS ordered_units,
              (SELECT COALESCE(SUM(ol.picked_qty), 0) FROM order_lines ol WHERE ol.order_id = o.id) AS picked_units
         FROM orders o
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE o.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                 o.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${conditions.join(' AND ')}`).get(...params) as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

export function createOrder(db: DB, input: CreateOrderInput, actor: AuthUser): { id: string; orderNo: string } {
  if (!input.lines.length) throw badRequest('ORDER_LINES_REQUIRED', 'An order needs at least one line');
  const channelPool: PoolCode | null = input.channel === 'B2B' ? 'B2B' : null;
  const poolCode = channelPool ?? input.poolCode;
  if (!poolCode) throw badRequest('POOL_REQUIRED', 'A stock pool is required for this channel');
  if (channelPool && input.poolCode && input.poolCode !== channelPool) {
    throw badRequest('POOL_CHANNEL_MISMATCH', `The ${input.channel} channel can only allocate from the ${channelPool} pool`);
  }
  resolvePool(db, poolCode);
  const warehouse = resolveWarehouse(db, input.warehouseId);
  if (input.externalOrderId) {
    const dup = db.prepare('SELECT id, order_no FROM orders WHERE external_order_id = ?').get(input.externalOrderId) as
      | { id: string; order_no: string }
      | undefined;
    if (dup) {
      throw conflict('DUPLICATE_EXTERNAL_ORDER', `External order ${input.externalOrderId} is already imported as ${dup.order_no}`, {
        orderId: dup.id,
        orderNo: dup.order_no,
      });
    }
  }

  const id = newId();
  const orderNo = documentNo(db, 'ORDER', 'ORD', 6);
  const now = nowIso();
  db.prepare(
    `INSERT INTO orders
      (id, order_no, channel, pool_code, warehouse_id, customer_name, customer_ref, external_order_id, status,
       priority, sla_due_at, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    orderNo,
    input.channel,
    poolCode,
    warehouse.id,
    input.customerName.trim(),
    input.customerRef ?? null,
    input.externalOrderId ?? null,
    input.priority ?? 'NORMAL',
    input.slaDueAt ?? null,
    input.notes ?? null,
    actor.id,
    now,
    now,
  );

  input.lines.forEach((line, index) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Order quantities must be positive whole numbers');
    }
    const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'ACTIVE'").get(line.productId) as
      | Record<string, any>
      | undefined;
    if (!product) throw notFound(`Product ${line.productId} not found or inactive`);
    if (line.boxId) {
      const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(line.boxId) as Record<string, any> | undefined;
      if (!box) throw notFound('Requested box not found');
      if (box.status !== 'ACTIVE') throw conflict('BOX_NOT_AVAILABLE', `Box ${box.box_code} is not active`);
      if (box.pool_id && box.pool_id !== resolvePool(db, poolCode).id) {
        throw conflict('BOX_POOL_MISMATCH', `Box ${box.box_code} is not in the ${poolCode} pool`);
      }
    }
    db.prepare(
      `INSERT INTO order_lines (id, order_id, line_no, product_id, box_id, ordered_qty, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run(newId(), id, index + 1, line.productId, line.boxId ?? null, line.quantity);
  });

  recordAudit(db, {
    eventType: 'ORDER_CREATED',
    entityType: 'ORDER',
    entityId: id,
    after: {
      orderNo,
      channel: input.channel,
      poolCode,
      warehouseId: warehouse.id,
      customerName: input.customerName,
      lines: input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    },
    refs: { externalOrderId: input.externalOrderId ?? null },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, orderNo };
}

function setOrderStatus(db: DB, order: OrderRow, status: string, actor: AuthUser, reason?: string | null): void {
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), order.id);
  recordAudit(db, {
    eventType: `ORDER_${status}`,
    entityType: 'ORDER',
    entityId: order.id,
    reason: reason ?? null,
    before: { status: order.status },
    after: { status, orderNo: order.order_no },
    actor: { userId: actor.id, role: actor.role },
  });
  order.status = status;
}

export function confirmOrder(db: DB, orderId: string, actor: AuthUser): { status: string } {
  const order = loadOrder(db, orderId);
  if (order.status !== 'DRAFT') throw conflict('INVALID_ORDER_TRANSITION', `Cannot confirm an order in status ${order.status}`);
  if (!orderLines(db, order.id).length) throw conflict('ORDER_HAS_NO_LINES', 'An empty order cannot be confirmed');
  setOrderStatus(db, order, 'CONFIRMED', actor);
  return { status: 'CONFIRMED' };
}

export function allocateOrder(db: DB, orderId: string, actor: AuthUser): { status: string; reservations: number } {
  const order = loadOrder(db, orderId);
  if (order.status !== 'CONFIRMED') {
    throw conflict('INVALID_ORDER_TRANSITION', `Allocation requires a CONFIRMED order; order is ${order.status}`);
  }
  const warehouse = orderWarehouse(db, order);
  const pool = resolvePool(db, orderPoolCode(order));
  const lines = orderLines(db, order.id);
  for (const line of lines) {
    if (line.status === 'CANCELLED') continue;
    reserveStock(db, {
      orderId: order.id,
      orderLineId: line.id,
      productId: line.product_id,
      warehouseId: warehouse.id,
      poolId: pool.id,
      quantity: Number(line.ordered_qty),
      boxId: line.box_id ?? null,
      user: actor,
    });
  }
  setOrderStatus(db, order, 'ALLOCATED', actor);
  const task = createTask(
    db,
    {
      taskType: 'PICKING',
      warehouseId: warehouse.id,
      entityType: 'ORDER',
      entityId: order.id,
      description: `Pick ${order.order_no} for ${order.customer_name}`,
      priority: order.priority as Priority,
      dueInHours: 8,
    },
    actor,
  );
  recordAudit(db, {
    eventType: 'ORDER_ALLOCATED',
    entityType: 'ORDER',
    entityId: order.id,
    after: { orderNo: order.order_no, taskNo: task.taskNo, lines: lines.length },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'ALLOCATED', reservations: orderReservations(db, order.id).length };
}

function activeReservationsForLine(db: DB, lineId: string) {
  return db
    .prepare(
      `SELECT * FROM reservations
        WHERE order_line_id = ? AND status IN ('ACTIVE','PARTIALLY_CONSUMED') AND remaining_quantity > 0
        ORDER BY created_at, reservation_no`,
    )
    .all(lineId) as Array<Record<string, any>>;
}

function resolveBoxBySelector(db: DB, selector: string): Record<string, any> {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ? OR box_code = ?').get(selector, selector.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!box) throw notFound(`No box matches scan '${selector}'`);
  return box;
}

function resolveLocationBySelector(db: DB, selector: string): Record<string, any> {
  const location = db.prepare('SELECT * FROM locations WHERE id = ? OR code = ?').get(selector, selector.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!location) throw notFound(`No location matches scan '${selector}'`);
  return location;
}

export function pickOrder(
  db: DB,
  orderId: string,
  input: { lines: PickLineInput[]; taskId?: string | null },
  actor: AuthUser,
): { status: string; pickedLines: number; transactions: string[] } {
  const order = loadOrder(db, orderId);
  if (!['ALLOCATED', 'PICKING'].includes(order.status)) {
    throw conflict('INVALID_ORDER_TRANSITION', `Picking requires an ALLOCATED order; order is ${order.status}`);
  }
  if (!input.lines.length) throw badRequest('PICK_LINES_REQUIRED', 'At least one pick line is required');
  const warehouse = orderWarehouse(db, order);
  const packing = locationOfType(db, warehouse.id, 'PACK');
  const requireScan = getSetting(db, 'picking_require_scan', true);
  const pool = resolvePool(db, orderPoolCode(order));
  const lines = orderLines(db, order.id);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const txnIds: string[] = [];
  let pickedLines = 0;

  for (const request of input.lines) {
    const line = byId.get(request.orderLineId);
    if (!line) throw notFound(`Order line ${request.orderLineId} does not belong to ${order.order_no}`);
    if (line.status === 'CANCELLED') throw conflict('LINE_CANCELLED', 'Cancelled order lines cannot be picked');
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Pick quantities must be positive whole numbers');
    }

    let need = request.quantity;
    const reservations = request.reservationId
      ? activeReservationsForLine(db, line.id).filter((r) => r.id === request.reservationId)
      : activeReservationsForLine(db, line.id);
    if (request.reservationId && !reservations.length) {
      throw conflict('RESERVATION_NOT_ACTIVE', 'The selected reservation is not active for this order line');
    }
    const totalReserved = reservations.reduce((sum, r) => sum + Number(r.remaining_quantity), 0);
    if (totalReserved < request.quantity) {
      throw conflict('INSUFFICIENT_RESERVED_STOCK', `Only ${totalReserved} units remain reserved for ${line.sku}`, {
        sku: line.sku,
        requested: request.quantity,
        reservedRemaining: totalReserved,
      });
    }

    if (request.scannedBarcode) {
      const resolved = db
        .prepare(
          `SELECT p.id, p.sku FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ?`,
        )
        .get(request.scannedBarcode.trim().toUpperCase()) as { id: string; sku: string } | undefined;
      if (!resolved || resolved.id !== line.product_id) {
        throw conflict('WRONG_SKU_SCANNED', `Scanned barcode ${request.scannedBarcode} is not ${line.sku}`, {
          expectedSku: line.sku,
          scanned: request.scannedBarcode,
        });
      }
    }

    for (const reservation of reservations) {
      if (need <= 0) break;
      if (request.scannedLocationId) {
        const scanned = resolveLocationBySelector(db, request.scannedLocationId);
        if (scanned.id !== reservation.location_id) {
          throw conflict('WRONG_LOCATION_SCANNED', `Stock for ${line.sku} is not at ${scanned.code}`, {
            expectedLocationId: reservation.location_id,
            scannedLocationId: scanned.id,
          });
        }
      }
      if (request.scannedBoxId) {
        const scanned = resolveBoxBySelector(db, request.scannedBoxId);
        if (scanned.id !== reservation.box_id) {
          throw conflict('WRONG_BOX_SCANNED', `Stock for ${line.sku} is not in box ${scanned.box_code}`, {
            expectedBoxId: reservation.box_id,
            scannedBoxId: scanned.id,
          });
        }
      } else if (requireScan && reservation.box_id) {
        throw conflict('BOX_SCAN_REQUIRED', `Box scan is required to pick ${line.sku} from its mixed-box location`);
      }

      const take = Math.min(Number(reservation.remaining_quantity), need);
      const movement = postMovement(db, {
        movementType: 'PICK',
        productId: line.product_id,
        quantity: take,
        from: {
          warehouseId: warehouse.id,
          locationId: reservation.location_id,
          poolId: pool.id,
          status: 'AVAILABLE',
          boxId: reservation.box_id,
          batchId: reservation.batch_id,
        },
        to: {
          warehouseId: warehouse.id,
          locationId: packing.id,
          poolId: pool.id,
          status: 'PICKED',
          boxId: null,
          batchId: reservation.batch_id,
        },
        consumeReservedQty: take,
        referenceType: 'ORDER',
        referenceId: order.id,
        referenceNo: order.order_no,
        reason: 'Order picking',
        user: actor,
        metadata: {
          orderLineId: line.id,
          reservationId: reservation.id,
          reservationNo: reservation.reservation_no,
          scannedBoxId: request.scannedBoxId ?? null,
        },
      });
      txnIds.push(movement.txnId);

      const updated = db
        .prepare(
          `UPDATE reservations
              SET remaining_quantity = remaining_quantity - ?,
                  status = CASE WHEN remaining_quantity - ? = 0 THEN 'CONSUMED' ELSE 'PARTIALLY_CONSUMED' END,
                  closed_at = CASE WHEN remaining_quantity - ? = 0 THEN ? ELSE closed_at END
            WHERE id = ? AND remaining_quantity >= ?`,
        )
        .run(take, take, take, nowIso(), reservation.id, take);
      if (Number(updated.changes) !== 1) {
        throw conflict('RESERVATION_MISMATCH', 'Reservation changed while picking; reload and retry');
      }
      const lineUpdate = db
        .prepare(
          `UPDATE order_lines
              SET picked_qty = picked_qty + ?,
                  allocated_qty = CASE WHEN allocated_qty > ? THEN allocated_qty - ? ELSE 0 END,
                  status = CASE WHEN picked_qty + ? >= ordered_qty THEN 'PICKED' ELSE 'PARTIALLY_PICKED' END
            WHERE id = ? AND picked_qty + ? <= ordered_qty`,
        )
        .run(take, take, take, take, line.id, take);
      if (Number(lineUpdate.changes) !== 1) {
        throw conflict('PICK_EXCEEDS_ORDER', 'Pick quantity exceeds the ordered quantity for this line');
      }
      need -= take;
    }
    if (need > 0) throw conflict('INSUFFICIENT_RESERVED_STOCK', `Unable to pick the full quantity for ${line.sku}`);
    pickedLines += 1;
  }

  const refreshed = orderLines(db, order.id);
  const allPicked = refreshed.every((l) => l.status === 'CANCELLED' || Number(l.picked_qty) >= Number(l.ordered_qty));
  setOrderStatus(db, order, allPicked ? 'PICKED' : 'PICKING', actor);
  if (allPicked) {
    const openTasks = db
      .prepare(
        `SELECT id FROM tasks WHERE entity_type = 'ORDER' AND entity_id = ? AND task_type = 'PICKING'
           AND status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .all(order.id) as Array<{ id: string }>;
    for (const task of openTasks) completeTask(db, task.id, actor);
    createTask(
      db,
      {
        taskType: 'PACKING',
        warehouseId: warehouse.id,
        entityType: 'ORDER',
        entityId: order.id,
        description: `Pack ${order.order_no} for ${order.customer_name}`,
        priority: order.priority as Priority,
        dueInHours: 4,
      },
      actor,
    );
  }
  if (input.taskId) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND entity_type = ?').get(input.taskId, 'ORDER') as
      | { id: string }
      | undefined;
    if (task) {
      const state = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
      if (!['COMPLETED', 'CANCELLED'].includes(state.status)) {
        db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?) WHERE id = ?").run(
          nowIso(),
          task.id,
        );
      }
    }
  }
  return { status: order.status, pickedLines, transactions: txnIds };
}

function pickedBatches(db: DB, orderId: string, orderLineId: string) {
  const rows = db
    .prepare(
      `SELECT t.to_batch_id AS batch_id, t.quantity, t.metadata_json
         FROM inventory_transactions t
        WHERE t.reference_type = 'ORDER' AND t.reference_id = ?
          AND t.movement_type = 'PICK'
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reversal_of = t.id)`,
    )
    .all(orderId) as Array<{ batch_id: string | null; quantity: number; metadata_json: string | null }>;

  const totals = new Map<string | null, number>();
  for (const row of rows) {
    let metadata: { orderLineId?: string } | null = null;
    try {
      metadata = row.metadata_json ? (JSON.parse(row.metadata_json) as { orderLineId?: string }) : null;
    } catch {
      metadata = null;
    }
    if (metadata?.orderLineId !== orderLineId) continue;
    totals.set(row.batch_id, (totals.get(row.batch_id) ?? 0) + Number(row.quantity));
  }

  return Array.from(totals, ([batch_id, quantity]) => ({ batch_id, quantity })).sort((a, b) => {
    if (a.batch_id === null && b.batch_id !== null) return -1;
    if (a.batch_id !== null && b.batch_id === null) return 1;
    return (a.batch_id ?? '').localeCompare(b.batch_id ?? '');
  });
}

export function packOrder(
  db: DB,
  orderId: string,
  input: PackInput,
  actor: AuthUser,
): { status: string; packages: Array<Record<string, any>> } {
  const order = loadOrder(db, orderId);
  if (order.status !== 'PICKED') {
    throw conflict('INVALID_ORDER_TRANSITION', `Packing requires a fully picked order; order is ${order.status}`);
  }
  const lines = orderLines(db, order.id);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const definition = input.packages?.length
    ? input.packages
    : [
        {
          weightGrams: null,
          dimensions: null,
          lines: lines
            .filter((l) => Number(l.picked_qty) - Number(l.packed_qty) > 0)
            .map((l) => ({
              orderLineId: l.id,
              quantity: Number(l.picked_qty) - Number(l.packed_qty),
              batchId: null,
            })),
        },
      ];
  if (!definition.length || !definition.some((p) => p.lines.length)) {
    throw conflict('NOTHING_TO_PACK', 'No picked quantities remain to be packed');
  }

  const requestedByLine = new Map<string, number>();
  for (const definitionPackage of definition) {
    for (const line of definitionPackage.lines) {
      requestedByLine.set(line.orderLineId, (requestedByLine.get(line.orderLineId) ?? 0) + line.quantity);
    }
  }
  const uncovered = lines
    .filter((l) => l.status !== 'CANCELLED')
    .map((l) => ({
      orderLineId: l.id,
      sku: l.sku,
      pickedToPack: Number(l.picked_qty) - Number(l.packed_qty),
      requested: requestedByLine.get(l.id) ?? 0,
    }))
    .filter((l) => l.pickedToPack !== l.requested);
  if (uncovered.length) {
    throw conflict(
      'PACK_INCOMPLETE',
      'A packing submission must pack every picked unit; split it into multiple packages within one submission',
      { lines: uncovered },
    );
  }

  const created: Array<Record<string, any>> = [];
  for (const definitionPackage of definition) {
    if (!definitionPackage.lines.length) throw badRequest('EMPTY_PACKAGE', 'A package must contain at least one line');
    const packageId = newId();
    const packageNo = documentNo(db, 'PACKAGE', 'PKG', 6);
    const now = nowIso();
    db.prepare(
      `INSERT INTO packages
        (id, package_no, order_id, status, packed_by, packed_at, weight_grams, dimensions, created_at)
       VALUES (?, ?, ?, 'PACKED', ?, ?, ?, ?, ?)`,
    ).run(
      packageId,
      packageNo,
      order.id,
      actor.id,
      now,
      definitionPackage.weightGrams ?? null,
      definitionPackage.dimensions ?? null,
      now,
    );

    for (const request of definitionPackage.lines) {
      const line = lineById.get(request.orderLineId);
      if (!line) throw notFound(`Order line ${request.orderLineId} does not belong to ${order.order_no}`);
      const remaining = Number(line.picked_qty) - Number(line.packed_qty);
      if (request.quantity <= 0 || request.quantity > remaining) {
        throw conflict('PACK_QUANTITY_EXCEEDS_PICK', `Only ${remaining} picked units of ${line.sku} are available to pack`, {
          sku: line.sku,
          availableToPack: remaining,
          requested: request.quantity,
        });
      }
      let batchId = request.batchId ?? null;
      if (!batchId && line.is_batch_tracked === 1) {
        const batches = pickedBatches(db, order.id, line.id);
        if (batches.length > 1) {
          throw badRequest('BATCH_REQUIRED', `Choose a batch when packing ${line.sku}; more than one batch was picked`);
        }
        batchId = batches[0]?.batch_id ?? null;
      }
      if (line.is_batch_tracked === 1 && !batchId) {
        throw badRequest('BATCH_REQUIRED', `Batch details are required to pack ${line.sku}`);
      }
      db.prepare(
        `INSERT INTO package_lines (id, package_id, order_line_id, product_id, quantity, batch_id, box_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(newId(), packageId, line.id, line.product_id, request.quantity, batchId);
      db.prepare('UPDATE order_lines SET packed_qty = packed_qty + ? WHERE id = ?').run(request.quantity, line.id);
      line.packed_qty = Number(line.packed_qty) + request.quantity;
    }

    recordAudit(db, {
      eventType: 'PACKAGE_CREATED',
      entityType: 'PACKAGE',
      entityId: packageId,
      after: { packageNo, orderNo: order.order_no, lines: definitionPackage.lines },
      refs: { orderId: order.id },
      actor: { userId: actor.id, role: actor.role },
    });
    created.push({ id: packageId, packageNo });
  }

  const refreshed = orderLines(db, order.id);
  const allPacked = refreshed.every((l) => l.status === 'CANCELLED' || Number(l.packed_qty) >= Number(l.ordered_qty));
  if (!allPacked) {
    throw conflict('PACK_INCOMPLETE', 'Picked units remain unpacked; include every line in the packing submission');
  }
  setOrderStatus(db, order, 'PACKED', actor);
  const openTasks = db
    .prepare(
      `SELECT id FROM tasks WHERE entity_type = 'ORDER' AND entity_id = ? AND task_type = 'PACKING'
         AND status NOT IN ('COMPLETED','CANCELLED')`,
    )
    .all(order.id) as Array<{ id: string }>;
  for (const task of openTasks) completeTask(db, task.id, actor);
  return { status: order.status, packages: orderPackages(db, order.id) };
}

export function dispatchOrder(
  db: DB,
  orderId: string,
  input: DispatchInput,
  actor: AuthUser,
): { shipmentNo: string; status: string; transactions: string[] } {
  const order = loadOrder(db, orderId);
  if (order.status !== 'PACKED') {
    throw conflict('INVALID_ORDER_TRANSITION', `Dispatch requires a PACKED order; order is ${order.status}`);
  }
  const warehouse = orderWarehouse(db, order);
  const packing = locationOfType(db, warehouse.id, 'PACK');
  const pool = resolvePool(db, orderPoolCode(order));
  const packages = db
    .prepare("SELECT * FROM packages WHERE order_id = ? AND status IN ('PACKED','VERIFIED') ORDER BY created_at")
    .all(order.id) as Array<Record<string, any>>;
  if (!packages.length) throw conflict('NO_PACKAGES', 'No packed packages are ready for dispatch');

  const shipmentId = newId();
  const shipmentNo = documentNo(db, 'SHIPMENT', 'SHP', 6);
  const now = nowIso();
  db.prepare(
    `INSERT INTO shipments
      (id, shipment_no, order_id, carrier, tracking_no, status, package_count, dispatched_by, dispatched_at, proof_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'DISPATCHED', ?, ?, ?, ?, ?)`,
  ).run(
    shipmentId,
    shipmentNo,
    order.id,
    input.carrier ?? null,
    input.trackingNo ?? null,
    packages.length,
    actor.id,
    now,
    input.proof ? JSON.stringify(input.proof) : null,
    now,
  );

  const txnIds: string[] = [];
  for (const pkg of packages) {
    const packageLines = db.prepare('SELECT * FROM package_lines WHERE package_id = ?').all(pkg.id) as Array<
      Record<string, any>
    >;
    for (const line of packageLines) {
      const movement = postMovement(db, {
        movementType: 'DISPATCH',
        productId: line.product_id,
        quantity: Number(line.quantity),
        from: {
          warehouseId: warehouse.id,
          locationId: packing.id,
          poolId: pool.id,
          status: 'PICKED',
          boxId: null,
          batchId: line.batch_id ?? null,
        },
        to: null,
        referenceType: 'ORDER',
        referenceId: order.id,
        referenceNo: order.order_no,
        reason: `Dispatched in ${pkg.package_no} via shipment ${shipmentNo}`,
        user: actor,
        metadata: {
          shipmentNo,
          packageNo: pkg.package_no,
          carrier: input.carrier ?? null,
          trackingNo: input.trackingNo ?? null,
        },
      });
      txnIds.push(movement.txnId);
      db.prepare(
        `UPDATE order_lines SET dispatched_qty = dispatched_qty + ?,
                status = CASE WHEN dispatched_qty + ? >= picked_qty THEN 'DISPATCHED' ELSE status END
          WHERE id = ?`,
      ).run(Number(line.quantity), Number(line.quantity), line.order_line_id);
    }
    db.prepare("UPDATE packages SET shipment_id = ?, status = 'DISPATCHED' WHERE id = ?").run(shipmentId, pkg.id);
  }

  setOrderStatus(db, order, 'DISPATCHED', actor);
  const refreshed = orderLines(db, order.id);
  const fullyDispatched = refreshed.every(
    (l) => l.status === 'CANCELLED' || Number(l.dispatched_qty) >= Number(l.picked_qty),
  );
  if (fullyDispatched) {
    const openTasks = db
      .prepare(
        `SELECT id FROM tasks WHERE entity_type = 'ORDER' AND entity_id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .all(order.id) as Array<{ id: string }>;
    for (const task of openTasks) completeTask(db, task.id, actor);
  }
  recordAudit(db, {
    eventType: 'ORDER_DISPATCHED',
    entityType: 'ORDER',
    entityId: order.id,
    after: {
      orderNo: order.order_no,
      shipmentNo,
      packageCount: packages.length,
      carrier: input.carrier ?? null,
      trackingNo: input.trackingNo ?? null,
      transactions: txnIds,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return { shipmentNo, status: 'DISPATCHED', transactions: txnIds };
}

export function cancelOrder(
  db: DB,
  orderId: string,
  reason: string,
  actor: AuthUser,
): { status: string; releasedReservations: number; reversedPicks: number } {
  const order = loadOrder(db, orderId);
  if (['DISPATCHED', 'COMPLETED'].includes(order.status)) {
    throw conflict('ORDER_ALREADY_FULFILLED', 'Dispatched orders must be handled through returns, not cancellation');
  }
  if (order.status === 'CANCELLED') return { status: 'CANCELLED', releasedReservations: 0, reversedPicks: 0 };
  if (order.status === 'PACKED') {
    throw conflict('ORDER_ALREADY_PACKED', 'Packed orders cannot be cancelled; unpack or process a return instead');
  }
  if (!reason.trim()) throw badRequest('CANCEL_REASON_REQUIRED', 'A cancellation reason is required');

  const active = db
    .prepare(
      `SELECT id FROM reservations WHERE order_id = ? AND status IN ('ACTIVE','PARTIALLY_CONSUMED')`,
    )
    .all(order.id) as Array<{ id: string }>;
  let released = 0;
  for (const reservation of active) {
    released += releaseReservation(db, reservation.id, actor, `Order cancelled: ${reason.trim()}`);
  }

  const picks = db
    .prepare(
      `SELECT t.id FROM inventory_transactions t
        WHERE t.reference_type = 'ORDER' AND t.reference_id = ? AND t.movement_type = 'PICK'
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reversal_of = t.id)`,
    )
    .all(order.id) as Array<{ id: string }>;
  for (const pick of picks) {
    reverseTransaction(db, pick.id, actor, `Order cancelled: ${reason.trim()}`);
  }

  db.prepare(
    `UPDATE order_lines SET picked_qty = 0,
            status = CASE WHEN status = 'CANCELLED' THEN status ELSE 'CANCELLED' END
      WHERE order_id = ?`,
  ).run(order.id);
  db.prepare('UPDATE orders SET cancelled_at = ?, cancel_reason = ? WHERE id = ?').run(nowIso(), reason.trim(), order.id);
  setOrderStatus(db, order, 'CANCELLED', actor, reason.trim());
  const openTasks = db
    .prepare(
      `SELECT id FROM tasks WHERE entity_type = 'ORDER' AND entity_id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
    )
    .all(order.id) as Array<{ id: string }>;
  for (const task of openTasks) {
    db.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE id = ?").run(task.id);
  }
  recordAudit(db, {
    eventType: 'ORDER_CANCELLED',
    entityType: 'ORDER',
    entityId: order.id,
    reason: reason.trim(),
    after: { orderNo: order.order_no, releasedReservations: released, reversedPicks: picks.length },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'CANCELLED', releasedReservations: released, reversedPicks: picks.length };
}

export function getShipment(db: DB, id: string) {
  const shipment = db.prepare('SELECT * FROM shipments WHERE id = ? OR shipment_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!shipment) throw notFound('Shipment not found');
  return {
    ...shipment,
    order: db.prepare('SELECT id, order_no, customer_name, status FROM orders WHERE id = ?').get(shipment.order_id),
    packages: db.prepare('SELECT * FROM packages WHERE shipment_id = ? ORDER BY package_no').all(shipment.id),
  };
}
