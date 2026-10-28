import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement } from './inventory.ts';

type CountType = 'AD_HOC' | 'SCHEDULED' | 'BLIND' | 'LOCATION' | 'SKU' | 'BOX' | 'BATCH' | 'FULL';

export interface CountLineInput {
  productId: string;
  locationId?: string | null;
  poolId?: string | null;
  batchId?: string | null;
  boxId?: string | null;
  countedQty?: number | null;
  reason?: string | null;
}

export interface CreateCountInput {
  countType: CountType;
  locationId?: string | null;
  boxId?: string | null;
  batchId?: string | null;
  productId?: string | null;
  notes?: string | null;
  lines?: CountLineInput[];
}

function loadCount(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM cycle_counts WHERE id = ? OR count_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!row) throw notFound('Cycle count not found');
  return row;
}

export function countLines(db: DB, countId: string) {
  return db
    .prepare(
      `SELECT cl.*, p.sku, p.name AS product_name, l.code AS location_code, sp.code AS pool_code,
              b.batch_no, bx.box_code, t.txn_no AS adjustment_txn_no
         FROM cycle_count_lines cl
         JOIN products p ON p.id = cl.product_id
         JOIN locations l ON l.id = cl.location_id
         LEFT JOIN stock_pools sp ON sp.id = cl.pool_id
         LEFT JOIN batches b ON b.id = cl.batch_id
         LEFT JOIN boxes bx ON bx.id = cl.box_id
         LEFT JOIN inventory_transactions t ON t.id = cl.adjustment_txn_id
        WHERE cl.count_id = ?
        ORDER BY p.sku, l.code`,
    )
    .all(countId);
}

export function getCount(db: DB, id: string) {
  const count = loadCount(db, id);
  return {
    ...count,
    location: count.location_id
      ? db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(count.location_id)
      : null,
    box: count.box_id ? db.prepare('SELECT id, box_code, status FROM boxes WHERE id = ?').get(count.box_id) : null,
    lines: countLines(db, count.id),
    exceptions: db
      .prepare("SELECT id, exception_no, type, severity, status, description FROM exceptions WHERE entity_type = 'CYCLE_COUNT' AND entity_id = ?")
      .all(count.id),
  };
}

export function listCounts(db: DB, filters: { status?: string; warehouseId?: string; limit?: number; offset?: number }) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    conditions.push(`c.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.warehouseId) {
    conditions.push('c.warehouse_id = ?');
    params.push(filters.warehouseId);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT c.*, l.code AS location_code, bx.box_code,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM cycle_count_lines cl WHERE cl.count_id = c.id) AS line_count,
              (SELECT COUNT(*) FROM cycle_count_lines cl WHERE cl.count_id = c.id AND cl.difference <> 0) AS difference_count
         FROM cycle_counts c
         LEFT JOIN locations l ON l.id = c.location_id
         LEFT JOIN boxes bx ON bx.id = c.box_id
         LEFT JOIN users u ON u.id = c.created_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cycle_counts c WHERE ${conditions.join(' AND ')}`).get(...params) as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

function systemQuantity(
  db: DB,
  dims: { warehouseId: string; locationId: string; poolId: string; productId: string; batchId: string | null; boxId: string | null },
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_balances
        WHERE status = 'AVAILABLE' AND warehouse_id = ? AND location_id = ? AND pool_id = ? AND product_id = ?
          AND COALESCE(batch_id, '') = COALESCE(?, '') AND COALESCE(box_id, '') = COALESCE(?, '')`,
    )
    .get(dims.warehouseId, dims.locationId, dims.poolId, dims.productId, dims.batchId, dims.boxId) as { qty: number };
  return Number(row.qty);
}

export function createCount(db: DB, input: CreateCountInput, actor: AuthUser): { id: string; countNo: string } {
  let warehouseId: string;
  let locationId: string | null = input.locationId ?? null;
  let boxId: string | null = input.boxId ?? null;
  if (boxId) {
    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId) as Record<string, any> | undefined;
    if (!box) throw notFound('Count box not found');
    warehouseId = box.warehouse_id;
    if (locationId && locationId !== box.location_id) {
      throw badRequest('COUNT_SCOPE_MISMATCH', 'Box is not at the specified count location');
    }
    locationId = box.location_id;
    if (!locationId) throw conflict('BOX_NOT_POSITIONED', 'Box must be positioned before counting');
  } else if (locationId) {
    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as Record<string, any> | undefined;
    if (!location) throw notFound('Count location not found');
    warehouseId = location.warehouse_id;
  } else if (input.lines?.length) {
    const firstLocation = db.prepare('SELECT * FROM locations WHERE id = ?').get(input.lines[0].locationId ?? '') as
      | Record<string, any>
      | undefined;
    if (!firstLocation) throw badRequest('LOCATION_REQUIRED', 'Explicit count lines require a location');
    warehouseId = firstLocation.warehouse_id;
  } else {
    throw badRequest('COUNT_SCOPE_REQUIRED', 'A cycle count needs a location, a box or explicit lines');
  }

  const id = newId();
  const countNo = documentNo(db, 'CYCLE_COUNT', 'CC', 6);
  db.prepare(
    `INSERT INTO cycle_counts
      (id, count_no, warehouse_id, location_id, box_id, count_type, status, created_by, created_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
  ).run(id, countNo, warehouseId, locationId, boxId, input.countType, actor.id, nowIso(), input.notes ?? null);

  const explicit = input.lines;
  if (explicit?.length) {
    for (const line of explicit) {
      const lineLocationId = line.locationId ?? locationId;
      if (!lineLocationId) throw badRequest('LOCATION_REQUIRED', 'Explicit count lines require a location');
      const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(lineLocationId) as Record<string, any> | undefined;
      if (!location) throw notFound('Count line location not found');
      let poolId = line.poolId ?? null;
      if (!poolId) {
        const pools = db
          .prepare(
            `SELECT DISTINCT pool_id FROM inventory_balances
              WHERE product_id = ? AND location_id = ? AND COALESCE(batch_id, '') = COALESCE(?, '')
                AND COALESCE(box_id, '') = COALESCE(?, '') AND quantity > 0`,
          )
          .all(line.productId, lineLocationId, line.batchId ?? null, line.boxId ?? null) as Array<{ pool_id: string }>;
        if (pools.length !== 1) {
          throw badRequest('POOL_REQUIRED', 'Specify the stock pool when the count dimensions are ambiguous or empty');
        }
        poolId = pools[0].pool_id;
      }
      const systemQty = systemQuantity(db, {
        warehouseId: location.warehouse_id,
        locationId: lineLocationId,
        poolId,
        productId: line.productId,
        batchId: line.batchId ?? null,
        boxId: line.boxId ?? boxId,
      });
      const counted = line.countedQty ?? null;
      const difference = counted === null ? null : counted - systemQty;
      db.prepare(
        `INSERT INTO cycle_count_lines
          (id, count_id, product_id, batch_id, box_id, location_id, pool_id, system_qty, counted_qty, difference, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        id,
        line.productId,
        line.batchId ?? input.batchId ?? null,
        line.boxId ?? boxId,
        lineLocationId,
        poolId,
        systemQty,
        counted,
        difference,
        line.reason ?? null,
      );
    }
  } else {
    const conditions = ["ib.status = 'AVAILABLE'", 'ib.warehouse_id = ?', 'ib.location_id = ?'];
    const params: any[] = [warehouseId, locationId];
    if (boxId) {
      conditions.push('ib.box_id = ?');
      params.push(boxId);
    }
    if (input.batchId) {
      conditions.push('ib.batch_id = ?');
      params.push(input.batchId);
    }
    if (input.productId) {
      conditions.push('ib.product_id = ?');
      params.push(input.productId);
    }
    const rows = db
      .prepare(
        `SELECT ib.product_id, ib.batch_id, ib.box_id, ib.location_id, ib.pool_id, SUM(ib.quantity) AS qty
           FROM inventory_balances ib
          WHERE ${conditions.join(' AND ')}
          GROUP BY ib.product_id, ib.batch_id, ib.box_id, ib.location_id, ib.pool_id
          ORDER BY ib.product_id`,
      )
      .all(...params) as Array<Record<string, any>>;
    for (const row of rows) {
      db.prepare(
        `INSERT INTO cycle_count_lines
          (id, count_id, product_id, batch_id, box_id, location_id, pool_id, system_qty, counted_qty, difference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(newId(), id, row.product_id, row.batch_id, row.box_id, row.location_id, row.pool_id, Number(row.qty));
    }
  }

  if (!countLines(db, id).length) throw conflict('COUNT_HAS_NO_LINES', 'No stock lines were found for the selected count scope');
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_CREATED',
    entityType: 'CYCLE_COUNT',
    entityId: id,
    after: { countNo, countType: input.countType, warehouseId, locationId, boxId, lines: countLines(db, id).length },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, countNo };
}

export function recordCounts(
  db: DB,
  countId: string,
  input: { lines: Array<{ lineId: string; countedQty: number; reason?: string | null }> },
  actor: AuthUser,
): { status: string; lines: Array<Record<string, any>> } {
  const count = loadCount(db, countId);
  if (!['DRAFT', 'IN_PROGRESS'].includes(count.status)) {
    throw conflict('INVALID_COUNT_TRANSITION', `Count is ${count.status} and cannot accept counts`);
  }
  if (!input.lines.length) throw badRequest('COUNT_LINES_REQUIRED', 'At least one counted line is required');
  for (const line of input.lines) {
    if (!Number.isInteger(line.countedQty) || line.countedQty < 0) {
      throw badRequest('INVALID_QUANTITY', 'Counted quantities must be non-negative whole numbers');
    }
    const row = db.prepare('SELECT * FROM cycle_count_lines WHERE id = ? AND count_id = ?').get(line.lineId, count.id) as
      | Record<string, any>
      | undefined;
    if (!row) throw notFound(`Count line ${line.lineId} does not belong to this count`);
    db.prepare('UPDATE cycle_count_lines SET counted_qty = ?, difference = ? - system_qty, reason = COALESCE(?, reason) WHERE id = ?').run(
      line.countedQty,
      line.countedQty,
      line.reason ?? null,
      line.lineId,
    );
  }
  if (count.status === 'DRAFT') db.prepare("UPDATE cycle_counts SET status = 'IN_PROGRESS' WHERE id = ?").run(count.id);
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_RECORDED',
    entityType: 'CYCLE_COUNT',
    entityId: count.id,
    after: { countNo: count.count_no, lines: input.lines },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'IN_PROGRESS', lines: countLines(db, count.id) };
}

function createDiscrepancyException(
  db: DB,
  count: Record<string, any>,
  line: Record<string, any>,
  actor: AuthUser,
): void {
  const discrepancy = Math.abs(Number(line.difference));
  const severity = discrepancy >= 100 ? 'CRITICAL' : discrepancy >= 20 ? 'HIGH' : discrepancy >= 5 ? 'MEDIUM' : 'LOW';
  const exceptionId = newId();
  const exceptionNo = documentNo(db, 'EXCEPTION', 'EXC', 6);
  db.prepare(
    `INSERT INTO exceptions
      (id, exception_no, type, severity, status, owner_user_id, entity_type, entity_id, description, created_by, created_at)
     VALUES (?, ?, 'CYCLE_COUNT_DISCREPANCY', ?, 'OPEN', ?, 'CYCLE_COUNT', ?, ?, ?, ?)`,
  ).run(
    exceptionId,
    exceptionNo,
    severity,
    actor.id,
    count.id,
    `${line.sku} counted ${line.counted_qty} against system ${line.system_qty} at ${line.location_code} (difference ${line.difference})`,
    actor.id,
    nowIso(),
  );
  db.prepare("UPDATE cycle_count_lines SET investigation_status = 'OPEN' WHERE id = ?").run(line.id);
  recordAudit(db, {
    eventType: 'EXCEPTION_RAISED',
    entityType: 'EXCEPTION',
    entityId: exceptionId,
    after: { exceptionNo, type: 'CYCLE_COUNT_DISCREPANCY', severity, countNo: count.count_no, lineId: line.id },
    actor: { userId: actor.id, role: actor.role },
  });
}

function postCount(db: DB, count: Record<string, any>, actor: AuthUser): string[] {
  const lines = countLines(db, count.id) as Array<Record<string, any>>;
  const uncounted = lines.filter((l) => l.counted_qty === null);
  if (uncounted.length) {
    throw conflict('COUNT_INCOMPLETE', 'Every line must be counted before posting', { uncounted: uncounted.length });
  }
  const txnIds: string[] = [];
  for (const line of lines) {
    const difference = Number(line.difference);
    if (difference === 0) {
      db.prepare("UPDATE cycle_count_lines SET investigation_status = 'NONE' WHERE id = ?").run(line.id);
      continue;
    }
    const direction = difference > 0 ? 'IN' : 'OUT';
    const quantity = Math.abs(difference);
    const movement = postMovement(db, {
      movementType: direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
      productId: line.product_id,
      quantity,
      from:
        direction === 'OUT'
          ? {
              warehouseId: count.warehouse_id,
              locationId: line.location_id,
              poolId: line.pool_id,
              status: 'AVAILABLE',
              boxId: line.box_id,
              batchId: line.batch_id,
            }
          : null,
      to:
        direction === 'IN'
          ? {
              warehouseId: count.warehouse_id,
              locationId: line.location_id,
              poolId: line.pool_id,
              status: 'AVAILABLE',
              boxId: line.box_id,
              batchId: line.batch_id,
            }
          : null,
      referenceType: 'CYCLE_COUNT',
      referenceId: count.id,
      referenceNo: count.count_no,
      reason: `Cycle count adjustment: counted ${line.counted_qty}, system ${line.system_qty}`,
      user: actor,
      metadata: { countLineId: line.id, difference, investigationStatus: 'OPEN' },
    });
    txnIds.push(movement.txnId);
    db.prepare('UPDATE cycle_count_lines SET adjustment_txn_id = ? WHERE id = ?').run(movement.txnId, line.id);
    createDiscrepancyException(db, count, line, actor);
  }
  db.prepare(
    `UPDATE cycle_counts SET status = 'POSTED', approved_by = ?, approved_at = ?, posted_at = ? WHERE id = ?`,
  ).run(actor.id, nowIso(), nowIso(), count.id);
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_POSTED',
    entityType: 'CYCLE_COUNT',
    entityId: count.id,
    after: { countNo: count.count_no, transactions: txnIds, lines: lines.length },
    actor: { userId: actor.id, role: actor.role },
  });
  return txnIds;
}

export function submitCount(db: DB, countId: string, actor: AuthUser): { status: string; transactions?: string[] } {
  const count = loadCount(db, countId);
  if (!['DRAFT', 'IN_PROGRESS'].includes(count.status)) {
    throw conflict('INVALID_COUNT_TRANSITION', `Count is ${count.status} and cannot be submitted`);
  }
  const uncounted = db
    .prepare('SELECT COUNT(*) AS n FROM cycle_count_lines WHERE count_id = ? AND counted_qty IS NULL')
    .get(count.id) as { n: number };
  if (Number(uncounted.n) > 0) {
    throw conflict('COUNT_INCOMPLETE', 'Every line must be counted before submission', { uncounted: Number(uncounted.n) });
  }
  const approvalRequired = getSetting(db, 'cycle_count_approval_required', true);
  if (!approvalRequired) {
    const txnIds = postCount(db, count, actor);
    return { status: 'POSTED', transactions: txnIds };
  }
  db.prepare("UPDATE cycle_counts SET status = 'PENDING_APPROVAL', submitted_at = ? WHERE id = ?").run(nowIso(), count.id);
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_SUBMITTED',
    entityType: 'CYCLE_COUNT',
    entityId: count.id,
    after: { countNo: count.count_no, status: 'PENDING_APPROVAL' },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'PENDING_APPROVAL' };
}

export function approveCount(db: DB, countId: string, actor: AuthUser): { status: string; transactions: string[] } {
  const count = loadCount(db, countId);
  if (count.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_COUNT_TRANSITION', `Count is ${count.status}, not pending approval`);
  }
  const txnIds = postCount(db, count, actor);
  return { status: 'POSTED', transactions: txnIds };
}

export function rejectCount(db: DB, countId: string, reason: string, actor: AuthUser): { status: string } {
  const count = loadCount(db, countId);
  if (count.status !== 'PENDING_APPROVAL') {
    throw conflict('INVALID_COUNT_TRANSITION', `Count is ${count.status}, not pending approval`);
  }
  if (!reason.trim()) throw badRequest('REJECT_REASON_REQUIRED', 'A rejection reason is required');
  db.prepare("UPDATE cycle_counts SET status = 'REJECTED', notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?").run(
    `Rejected: ${reason.trim()}`,
    count.id,
  );
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_REJECTED',
    entityType: 'CYCLE_COUNT',
    entityId: count.id,
    reason: reason.trim(),
    after: { countNo: count.count_no, status: 'REJECTED' },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'REJECTED' };
}

export function cancelCount(db: DB, countId: string, reason: string, actor: AuthUser): { status: string } {
  const count = loadCount(db, countId);
  if (!['DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL'].includes(count.status)) {
    throw conflict('INVALID_COUNT_TRANSITION', `Count is ${count.status} and cannot be cancelled`);
  }
  if (!reason.trim()) throw badRequest('CANCEL_REASON_REQUIRED', 'A cancellation reason is required');
  db.prepare("UPDATE cycle_counts SET status = 'CANCELLED' WHERE id = ?").run(count.id);
  recordAudit(db, {
    eventType: 'CYCLE_COUNT_CANCELLED',
    entityType: 'CYCLE_COUNT',
    entityId: count.id,
    reason: reason.trim(),
    after: { countNo: count.count_no, status: 'CANCELLED' },
    actor: { userId: actor.id, role: actor.role },
  });
  return { status: 'CANCELLED' };
}
