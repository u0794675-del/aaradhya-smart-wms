import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { boxContents, boxTimeline, createEmptyBox, moveBox, postMovement, retireBox, reuseBox, type BalanceRow } from './inventory.ts';

export function listBoxes(
  db: DB,
  filters: { search?: string; type?: string; status?: string; locationId?: string; poolId?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      `(b.box_code LIKE ? OR EXISTS (
         SELECT 1 FROM inventory_balances ib JOIN products p ON p.id = ib.product_id
          WHERE ib.box_id = b.id AND (p.sku LIKE ? OR p.name LIKE ?)))`,
    );
    params.push(term, term, term);
  }
  if (filters.type) {
    conditions.push('b.box_type = ?');
    params.push(filters.type);
  }
  if (filters.status) {
    conditions.push('b.status = ?');
    params.push(filters.status);
  }
  if (filters.locationId) {
    conditions.push('b.location_id = ?');
    params.push(filters.locationId);
  }
  if (filters.poolId) {
    conditions.push('b.pool_id = ?');
    params.push(filters.poolId);
  }
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT b.id, b.box_code, b.box_type, b.status, b.location_id, b.pool_id, b.created_at, b.notes,
              l.code AS location_code, sp.code AS pool_code,
              bs.verification_status, bs.source_barcode, bs.source_zone, bs.source_rack, bs.source_bin,
              bs.source_box_quantity, bs.source_verification, bs.source_sheet, bs.source_row_no,
              COALESCE(SUM(ib.quantity), 0) AS total_quantity,
              COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available_quantity,
              COUNT(DISTINCT ib.product_id) AS sku_count
         FROM boxes b
         LEFT JOIN locations l ON l.id = b.location_id
         LEFT JOIN stock_pools sp ON sp.id = b.pool_id
         LEFT JOIN box_sources bs ON bs.box_id = b.id
         LEFT JOIN inventory_balances ib ON ib.box_id = b.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY b.id, l.code, sp.code, bs.box_id
        ORDER BY b.box_code
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, any>>;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM boxes b WHERE ${conditions.join(' AND ')}`).get(...params) as unknown as {
    n: number;
  };
  return { rows, total: Number(total.n), limit, offset };
}

export function getBoxDetail(db: DB, idOrCode: string) {
  const box = db
    .prepare('SELECT * FROM boxes WHERE id = ? OR box_code = ?')
    .get(idOrCode, idOrCode.toUpperCase()) as Record<string, any> | undefined;
  if (!box) throw notFound('Box not found');
  const location = box.location_id
    ? db.prepare('SELECT id, code, type FROM locations WHERE id = ?').get(box.location_id)
    : null;
  const pool = box.pool_id ? db.prepare('SELECT id, code, name FROM stock_pools WHERE id = ?').get(box.pool_id) : null;
  const contents = boxContents(db, box.id);
  const totals = contents.reduce<{ total: number; reserved: number; available: number }>(
    (acc, row) => {
      acc.total += Number(row.quantity);
      acc.reserved += Number(row.reserved_quantity);
      acc.available += Number(row.quantity) - Number(row.reserved_quantity);
      return acc;
    },
    { total: 0, reserved: 0, available: 0 },
  );
  const skuCount = new Set(contents.map((c) => String(c.product_id))).size;
  const creator = db.prepare('SELECT name FROM users WHERE id = ?').get(box.created_by) as { name: string } | undefined;
  const source = db.prepare('SELECT * FROM box_sources WHERE box_id = ?').get(box.id) ?? null;
  const sourceJob = source
    ? db.prepare('SELECT id, file_name, created_at FROM import_jobs WHERE id = ?').get((source as any).import_job_id) ?? null
    : null;
  return { box, location, pool, contents, totals, skuCount, createdBy: creator?.name ?? null, source, sourceJob };
}

export function addBoxContents(
  db: DB,
  input: {
    boxId: string;
    productId: string;
    quantity: number;
    batchId?: string | null;
    fromLocationId: string;
    sourceBoxId?: string | null;
    reason?: string;
    user: AuthUser;
    correlationId?: string | null;
  },
): { txnId: string; txnNo: string } {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(input.boxId) as
    | { id: string; box_code: string; status: string; warehouse_id: string; location_id: string | null; pool_id: string | null }
    | undefined;
  if (!box) throw notFound('Box not found');
  if (['RETIRED', 'DAMAGED'].includes(box.status)) throw conflict('BOX_NOT_USABLE', `Box is ${box.status}`);
  if (!box.location_id || !box.pool_id) throw conflict('BOX_NOT_POSITIONED', 'Box must have a location and pool before receiving stock');
  if (input.sourceBoxId === box.id) throw badRequest('SAME_BOX', 'Source and destination box are the same');

  const result = postMovement(db, {
    movementType: 'BOX_TRANSFER',
    productId: input.productId,
    quantity: input.quantity,
    from: {
      warehouseId: box.warehouse_id,
      locationId: input.fromLocationId,
      poolId: box.pool_id,
      status: 'AVAILABLE',
      boxId: input.sourceBoxId ?? null,
      batchId: input.batchId ?? null,
    },
    to: {
      warehouseId: box.warehouse_id,
      locationId: box.location_id,
      poolId: box.pool_id,
      status: 'AVAILABLE',
      boxId: box.id,
      batchId: input.batchId ?? null,
    },
    referenceType: 'BOX',
    referenceId: box.id,
    referenceNo: box.box_code,
    reason: input.reason ?? 'Stock added to box',
    user: input.user,
    correlationId: input.correlationId,
  });
  return { txnId: result.txnId, txnNo: result.txnNo };
}

export function removeBoxContents(
  db: DB,
  input: {
    boxId: string;
    productId: string;
    quantity: number;
    batchId?: string | null;
    toLocationId: string;
    reason?: string;
    user: AuthUser;
    correlationId?: string | null;
  },
): { txnId: string; txnNo: string } {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(input.boxId) as
    | { id: string; box_code: string; status: string; warehouse_id: string; location_id: string | null; pool_id: string | null }
    | undefined;
  if (!box) throw notFound('Box not found');
  if (!box.location_id || !box.pool_id) throw conflict('BOX_NOT_POSITIONED', 'Box has no current location or pool');
  const result = postMovement(db, {
    movementType: 'BOX_TRANSFER',
    productId: input.productId,
    quantity: input.quantity,
    from: {
      warehouseId: box.warehouse_id,
      locationId: box.location_id,
      poolId: box.pool_id,
      status: 'AVAILABLE',
      boxId: box.id,
      batchId: input.batchId ?? null,
    },
    to: {
      warehouseId: box.warehouse_id,
      locationId: input.toLocationId,
      poolId: box.pool_id,
      status: 'AVAILABLE',
      boxId: null,
      batchId: input.batchId ?? null,
    },
    referenceType: 'BOX',
    referenceId: box.id,
    referenceNo: box.box_code,
    reason: input.reason ?? 'Stock removed from box',
    user: input.user,
    correlationId: input.correlationId,
  });
  return { txnId: result.txnId, txnNo: result.txnNo };
}

export function createBox(
  db: DB,
  input: { boxType: 'SINGLE' | 'MIXED'; locationId: string; poolId: string; user: AuthUser; notes?: string; correlationId?: string | null },
) {
  const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
  return createEmptyBox(db, {
    boxType: input.boxType,
    warehouseId: warehouse.id,
    locationId: input.locationId,
    poolId: input.poolId,
    user: input.user,
    notes: input.notes ?? null,
    correlationId: input.correlationId ?? null,
  });
}

export { moveBox, retireBox, reuseBox, boxContents, boxTimeline };
