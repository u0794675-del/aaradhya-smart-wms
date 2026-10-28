import type { DB } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { getSetting } from '../lib/settings.ts';
import { addDays, nowIso, todayIso } from '../lib/time.ts';

function scalar(db: DB, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as any[])) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function rows<T = Record<string, any>>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as any[])) as T[];
}

function lowStockRows(db: DB, limit: number) {
  const threshold = getSetting(db, 'low_stock_default', 20);
  return rows(
    db,
    `SELECT * FROM (
       SELECT p.id, p.sku, p.name, p.low_stock_threshold,
              COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE'
                                THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available,
              COALESCE(p.low_stock_threshold, ?) AS threshold
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        WHERE p.status = 'ACTIVE'
        GROUP BY p.id
     ) s
      WHERE s.available < s.threshold
      ORDER BY s.available ASC, s.sku
      LIMIT ?`,
    threshold,
    limit,
  ).map((row) => ({ ...row, available: Number(row.available), threshold: Number(row.threshold) }));
}

function expiringRows(db: DB, limit: number) {
  const warningDays = getSetting(db, 'expiry_warning_days', 60);
  return rows(
    db,
    `SELECT b.id, b.batch_no, b.expiry_date, p.id AS product_id, p.sku, p.name,
            SUM(ib.quantity) AS quantity
       FROM batches b
       JOIN products p ON p.id = b.product_id
       JOIN inventory_balances ib ON ib.batch_id = b.id
      WHERE ib.quantity > 0 AND ib.status = 'AVAILABLE' AND b.expiry_date IS NOT NULL
        AND b.expiry_date <= ?
      GROUP BY b.id, p.id
      ORDER BY b.expiry_date ASC
      LIMIT ?`,
    addDays(warningDays).slice(0, 10),
    limit,
  ).map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

export function controlTower(db: DB) {
  const today = `${todayIso()}T00:00:00.000Z`;
  const statusRows = rows<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const orderStatus: Record<string, number> = {};
  for (const row of statusRows) orderStatus[row.status] = Number(row.n);
  const taskRows = rows<{ task_type: string; status: string; n: number }>(
    db,
    'SELECT task_type, status, COUNT(*) AS n FROM tasks GROUP BY task_type, status',
  );
  const tasksByType: Record<string, number> = {};
  for (const row of taskRows) {
    if (!['COMPLETED', 'CANCELLED'].includes(row.status)) {
      tasksByType[row.task_type] = (tasksByType[row.task_type] ?? 0) + Number(row.n);
    }
  }
  const warningDays = getSetting(db, 'expiry_warning_days', 60);

  return {
    generatedAt: nowIso(),
    orders: {
      byStatus: orderStatus,
      open: statusRows
        .filter((row) => !['DISPATCHED', 'COMPLETED', 'CANCELLED'].includes(row.status))
        .reduce((sum, row) => sum + Number(row.n), 0),
      dispatchQueue: scalar(db, "SELECT COUNT(*) AS n FROM orders WHERE status = 'PACKED'"),
      pickQueue: scalar(db, "SELECT COUNT(*) AS n FROM orders WHERE status IN ('ALLOCATED','PICKING')"),
      allocateQueue: scalar(db, "SELECT COUNT(*) AS n FROM orders WHERE status = 'CONFIRMED'"),
    },
    tasks: {
      open: scalar(db, "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED')"),
      overdue: scalar(
        db,
        "SELECT COUNT(*) AS n FROM tasks WHERE due_at < ? AND status NOT IN ('COMPLETED','CANCELLED')",
        nowIso(),
      ),
      byType: tasksByType,
    },
    inventory: {
      lowStock: lowStockRows(db, 500).length,
      expiring: expiringRows(db, 500).length,
      expired: scalar(
        db,
        `SELECT COUNT(*) AS n FROM batches b
          WHERE b.expiry_date IS NOT NULL AND b.expiry_date < ?
            AND EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.batch_id = b.id AND ib.quantity > 0)`,
        todayIso(),
      ),
      nonSellable: scalar(
        db,
        "SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_balances WHERE status IN ('QUARANTINED','REJECTED','DAMAGED','REWORK')",
      ),
      inTransit: scalar(db, "SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_balances WHERE status = 'IN_TRANSIT'"),
      availableUnits: scalar(
        db,
        "SELECT COALESCE(SUM(quantity - reserved_quantity),0) AS n FROM inventory_balances WHERE status = 'AVAILABLE'",
      ),
    },
    approvals: {
      transfers: scalar(db, "SELECT COUNT(*) AS n FROM transfers WHERE status = 'PENDING_APPROVAL'"),
      adjustments: scalar(db, "SELECT COUNT(*) AS n FROM adjustment_requests WHERE status = 'PENDING_APPROVAL'"),
      cycleCounts: scalar(db, "SELECT COUNT(*) AS n FROM cycle_counts WHERE status = 'PENDING_APPROVAL'"),
    },
    exceptions: {
      open: scalar(db, "SELECT COUNT(*) AS n FROM exceptions WHERE status IN ('OPEN','INVESTIGATING')"),
      critical: scalar(
        db,
        "SELECT COUNT(*) AS n FROM exceptions WHERE status IN ('OPEN','INVESTIGATING') AND severity = 'CRITICAL'",
      ),
    },
    today: {
      dispatchedOrders: scalar(db, 'SELECT COUNT(*) AS n FROM shipments WHERE created_at >= ?', today),
      movements: scalar(db, 'SELECT COUNT(*) AS n FROM inventory_transactions WHERE created_at >= ?', today),
    },
    lowStockItems: lowStockRows(db, 6),
    expiringBatches: expiringRows(db, 6),
    warningDays,
    openExceptions: rows(
      db,
      `SELECT id, exception_no, type, severity, status, description, created_at
         FROM exceptions WHERE status IN ('OPEN','INVESTIGATING')
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 6`,
    ),
    recentActivity: rows(
      db,
      `SELECT a.id, a.event_type, a.entity_type, a.entity_id, a.outcome, a.created_at, u.name AS actor_name
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC LIMIT 10`,
    ),
    queues: {
      allocations: rows(
        db,
        `SELECT o.id, o.order_no, o.channel, o.customer_name, o.priority, o.created_at
           FROM orders o WHERE o.status = 'CONFIRMED' ORDER BY o.created_at LIMIT 5`,
      ),
      picks: rows(
        db,
        `SELECT o.id, o.order_no, o.channel, o.customer_name, o.priority, o.created_at
           FROM orders o WHERE o.status IN ('ALLOCATED','PICKING') ORDER BY o.created_at LIMIT 5`,
      ),
      packing: rows(
        db,
        `SELECT o.id, o.order_no, o.channel, o.customer_name, o.priority, o.created_at
           FROM orders o WHERE o.status = 'PICKED' ORDER BY o.created_at LIMIT 5`,
      ),
      dispatch: rows(
        db,
        `SELECT o.id, o.order_no, o.channel, o.customer_name, o.priority, o.created_at
           FROM orders o WHERE o.status = 'PACKED' ORDER BY o.created_at LIMIT 5`,
      ),
    },
  };
}

export function searchAll(db: DB, rawQuery: string) {
  const query = rawQuery.trim();
  if (query.length < 2) return { query, groups: [] as Array<Record<string, unknown>> };
  const term = `%${query}%`;
  const groups: Array<Record<string, unknown>> = [];

  const products = rows(
    db,
    `SELECT p.id, p.sku, p.name, p.base_uom
       FROM products p
      WHERE p.sku LIKE ? OR p.name LIKE ?
         OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ?)
      ORDER BY p.sku LIMIT 5`,
    term,
    term,
    term,
  );
  if (products.length) groups.push({ type: 'PRODUCTS', items: products });

  const orders = rows(
    db,
    `SELECT id, order_no AS number, customer_name AS label, status
       FROM orders WHERE order_no LIKE ? OR customer_name LIKE ? OR external_order_id LIKE ?
      ORDER BY created_at DESC LIMIT 5`,
    term,
    term,
    term,
  );
  if (orders.length) groups.push({ type: 'ORDERS', items: orders });

  const boxes = rows(
    db,
    `SELECT id, box_code AS number, box_type AS label, status
       FROM boxes WHERE box_code LIKE ? ORDER BY box_code LIMIT 5`,
    term,
  );
  if (boxes.length) groups.push({ type: 'BOXES', items: boxes });

  const batches = rows(
    db,
    `SELECT b.id, b.batch_no AS number, p.sku || ' · ' || p.name AS label, b.expiry_date
       FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.batch_no LIKE ? ORDER BY b.batch_no LIMIT 5`,
    term,
  );
  if (batches.length) groups.push({ type: 'BATCHES', items: batches });

  const receipts = rows(
    db,
    `SELECT id, receipt_no AS number, status, received_at FROM receipts
      WHERE receipt_no LIKE ? ORDER BY created_at DESC LIMIT 5`,
    term,
  );
  if (receipts.length) groups.push({ type: 'RECEIPTS', items: receipts });

  const transfers = rows(
    db,
    `SELECT id, transfer_no AS number, transfer_type AS label, status FROM transfers
      WHERE transfer_no LIKE ? ORDER BY created_at DESC LIMIT 5`,
    term,
  );
  if (transfers.length) groups.push({ type: 'TRANSFERS', items: transfers });

  const returns = rows(
    db,
    `SELECT id, return_no AS number, reason AS label, status FROM returns
      WHERE return_no LIKE ? ORDER BY received_at DESC LIMIT 5`,
    term,
  );
  if (returns.length) groups.push({ type: 'RETURNS', items: returns });

  const tasks = rows(
    db,
    `SELECT id, task_no AS number, task_type AS label, status FROM tasks
      WHERE task_no LIKE ? ORDER BY created_at DESC LIMIT 5`,
    term,
  );
  if (tasks.length) groups.push({ type: 'TASKS', items: tasks });

  return { query, groups };
}

const GENEALOGY_ENTITIES: Record<string, { table: string; label: string }> = {
  PRODUCT: { table: 'products', label: 'sku' },
  BATCH: { table: 'batches', label: 'batch_no' },
  BOX: { table: 'boxes', label: 'box_code' },
  ORDER: { table: 'orders', label: 'order_no' },
  RECEIPT: { table: 'receipts', label: 'receipt_no' },
  TRANSFER: { table: 'transfers', label: 'transfer_no' },
  RETURN: { table: 'returns', label: 'return_no' },
  CYCLE_COUNT: { table: 'cycle_counts', label: 'count_no' },
  ADJUSTMENT: { table: 'adjustment_requests', label: 'adjustment_no' },
};

const TXN_VIEW = `SELECT t.*, u.name AS user_name,
       fl.code AS from_location_code, tl.code AS to_location_code,
       fp.code AS from_pool_code, tp.code AS to_pool_code,
       fb.box_code AS from_box_code, tb.box_code AS to_box_code,
       fba.batch_no AS from_batch_no, tba.batch_no AS to_batch_no
  FROM inventory_transactions t
  LEFT JOIN users u ON u.id = t.user_id
  LEFT JOIN locations fl ON fl.id = t.from_location_id
  LEFT JOIN locations tl ON tl.id = t.to_location_id
  LEFT JOIN stock_pools fp ON fp.id = t.from_pool_id
  LEFT JOIN stock_pools tp ON tp.id = t.to_pool_id
  LEFT JOIN boxes fb ON fb.id = t.from_box_id
  LEFT JOIN boxes tb ON tb.id = t.to_box_id
  LEFT JOIN batches fba ON fba.id = t.from_batch_id
  LEFT JOIN batches tba ON tba.id = t.to_batch_id`;

export function genealogy(db: DB, typeInput: string, idOrNumber: string) {
  const type = typeInput.trim().toUpperCase();
  const definition = GENEALOGY_ENTITIES[type];
  if (!definition) throw badRequest('UNKNOWN_GENEALOGY_TYPE', `Unsupported trace type '${typeInput}'`);
  const entity = db
    .prepare(`SELECT * FROM ${definition.table} WHERE id = ? OR ${definition.label} = ?`)
    .get(idOrNumber, idOrNumber.toUpperCase()) as Record<string, any> | undefined;
  if (!entity) throw notFound(`${type} record not found`);

  let transactions: Array<Record<string, any>> = [];
  if (type === 'PRODUCT') {
    transactions = rows(db, `${TXN_VIEW} WHERE t.product_id = ? ORDER BY t.created_at DESC LIMIT 200`, entity.id);
  } else if (type === 'BATCH') {
    transactions = rows(
      db,
      `${TXN_VIEW} WHERE t.from_batch_id = ? OR t.to_batch_id = ? ORDER BY t.created_at DESC LIMIT 200`,
      entity.id,
      entity.id,
    );
  } else if (type === 'BOX') {
    transactions = rows(
      db,
      `${TXN_VIEW} WHERE t.from_box_id = ? OR t.to_box_id = ? ORDER BY t.created_at DESC LIMIT 200`,
      entity.id,
      entity.id,
    );
  } else {
    transactions = rows(
      db,
      `${TXN_VIEW} WHERE t.reference_id = ? ORDER BY t.created_at DESC LIMIT 200`,
      entity.id,
    );
  }

  const auditEvents = rows(
    db,
    `SELECT a.id, a.event_type, a.entity_type, a.entity_id, a.actor_user_id, u.name AS actor_name,
            a.outcome, a.reason, a.created_at, a.transaction_id
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.entity_id = ? OR a.transaction_id IN (SELECT id FROM inventory_transactions WHERE reference_id = ?)
      ORDER BY a.created_at DESC LIMIT 200`,
    entity.id,
    entity.id,
  );

  let related: Record<string, unknown> = {};
  if (type === 'PRODUCT') {
    related = {
      balances: rows(
        db,
        `SELECT ib.*, l.code AS location_code, sp.code AS pool_code, bx.box_code, b.batch_no, b.expiry_date
           FROM inventory_balances ib
           JOIN locations l ON l.id = ib.location_id
           JOIN stock_pools sp ON sp.id = ib.pool_id
           LEFT JOIN boxes bx ON bx.id = ib.box_id
           LEFT JOIN batches b ON b.id = ib.batch_id
          WHERE ib.product_id = ? AND ib.quantity > 0
          ORDER BY l.code`,
        entity.id,
      ),
      batches: rows(db, 'SELECT * FROM batches WHERE product_id = ? ORDER BY expiry_date', entity.id),
    };
  } else if (type === 'BATCH') {
    related = {
      product: db.prepare('SELECT id, sku, name, base_uom FROM products WHERE id = ?').get(entity.product_id),
      balances: rows(
        db,
        `SELECT ib.*, l.code AS location_code, bx.box_code FROM inventory_balances ib
           JOIN locations l ON l.id = ib.location_id LEFT JOIN boxes bx ON bx.id = ib.box_id
          WHERE ib.batch_id = ? AND ib.quantity > 0`,
        entity.id,
      ),
    };
  } else if (type === 'BOX') {
    related = {
      contents: rows(
        db,
        `SELECT c.*, l.code AS location_code FROM box_contents c
           LEFT JOIN boxes b ON b.id = c.box_id LEFT JOIN locations l ON l.id = b.location_id
          WHERE c.box_id = ?`,
        entity.id,
      ),
    };
  } else if (type === 'ORDER') {
    related = {
      lines: rows(db, 'SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_no', entity.id),
      shipments: rows(db, 'SELECT * FROM shipments WHERE order_id = ?', entity.id),
    };
  } else if (type === 'RECEIPT') {
    related = { lines: rows(db, 'SELECT * FROM receipt_lines WHERE receipt_id = ?', entity.id) };
  } else if (type === 'TRANSFER') {
    related = { lines: rows(db, 'SELECT * FROM transfer_lines WHERE transfer_id = ? ORDER BY line_no', entity.id) };
  } else if (type === 'RETURN') {
    related = { lines: rows(db, 'SELECT * FROM return_lines WHERE return_id = ?', entity.id) };
  } else if (type === 'CYCLE_COUNT') {
    related = { lines: rows(db, 'SELECT * FROM cycle_count_lines WHERE count_id = ?', entity.id) };
  }

  return { type, entity, transactions, auditEvents, related };
}

export function stockSummary(db: DB, filters: { search?: string; category?: string }) {
  const conditions = ['1=1'];
  // The expiry placeholder sits in the SELECT list, so it precedes filter params.
  const params: any[] = [todayIso()];
  if (filters.search) {
    conditions.push('(p.sku LIKE ? OR p.name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }
  if (filters.category) {
    conditions.push('p.category = ?');
    params.push(filters.category);
  }
  return rows(
    db,
    `SELECT p.id, p.sku, p.name, p.category, p.base_uom, p.low_stock_threshold, p.cost_price,
            COALESCE(SUM(ib.quantity), 0) AS on_hand,
            COALESCE(SUM(ib.reserved_quantity), 0) AS reserved,
            COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available,
            COALESCE(SUM(CASE WHEN ib.status IN ('QUARANTINED','REJECTED','DAMAGED','REWORK') THEN ib.quantity ELSE 0 END), 0) AS non_sellable,
            COALESCE(SUM(CASE WHEN ib.status = 'IN_TRANSIT' THEN ib.quantity ELSE 0 END), 0) AS in_transit,
            COALESCE(SUM(CASE WHEN ib.status = 'RETURN_PENDING' THEN ib.quantity ELSE 0 END), 0) AS return_pending,
            COALESCE(SUM(CASE WHEN b.expiry_date IS NOT NULL AND b.expiry_date < ? THEN ib.quantity ELSE 0 END), 0) AS expired,
            COALESCE(SUM(ib.quantity * COALESCE(p.cost_price, 0)), 0) AS stock_value
       FROM products p
       LEFT JOIN inventory_balances ib ON ib.product_id = p.id
       LEFT JOIN batches b ON b.id = ib.batch_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY p.id
      ORDER BY on_hand DESC, p.sku`,
    ...params,
  ).map((row) => {
    const mapped: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      mapped[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return mapped;
  });
}

export function inventoryOverview(db: DB) {
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS total_units,
              COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN quantity - reserved_quantity ELSE 0 END), 0) AS available_units,
              COUNT(DISTINCT CASE WHEN quantity > 0 THEN product_id END) AS sku_count,
              COUNT(DISTINCT CASE WHEN quantity > 0 THEN box_id END) AS box_count,
              COUNT(DISTINCT CASE WHEN quantity > 0 THEN location_id END) AS location_count
         FROM inventory_balances`,
    )
    .get() as Record<string, number>;

  const threshold = getSetting(db, 'low_stock_default', 20);
  const warningDays = getSetting(db, 'expiry_warning_days', 60);
  const lowStock = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT p.id
           FROM products p
           LEFT JOIN inventory_balances ib ON ib.product_id = p.id
          WHERE p.status = 'ACTIVE'
          GROUP BY p.id
         HAVING COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0)
                < COALESCE(p.low_stock_threshold, ?)
       ) s`,
    )
    .get(threshold) as { n: number };
  const expiring = db
    .prepare(
      `SELECT COUNT(DISTINCT b.id) AS n
         FROM batches b
         JOIN inventory_balances ib ON ib.batch_id = b.id
        WHERE ib.quantity > 0 AND ib.status = 'AVAILABLE' AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?`,
    )
    .get(addDays(warningDays).slice(0, 10)) as { n: number };

  const locations = db
    .prepare(
      `SELECT l.id, l.code, l.type, l.zone, l.status,
              COUNT(DISTINCT ib.product_id) AS sku_count,
              COUNT(DISTINCT ib.box_id) AS box_count,
              COALESCE(SUM(ib.quantity), 0) AS quantity,
              COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available
         FROM locations l
         JOIN inventory_balances ib ON ib.location_id = l.id AND ib.quantity > 0
        GROUP BY l.id, l.code, l.type, l.zone, l.status
        ORDER BY l.code`,
    )
    .all() as Array<Record<string, any>>;

  return {
    generatedAt: nowIso(),
    totals: {
      totalUnits: Number(totals.total_units),
      availableUnits: Number(totals.available_units),
      skuCount: Number(totals.sku_count),
      boxCount: Number(totals.box_count),
      locationCount: Number(totals.location_count),
      lowStock: Number(lowStock.n),
      expiringSoon: Number(expiring.n),
    },
    locations: locations.map((row) => ({
      id: String(row.id),
      code: String(row.code),
      type: String(row.type),
      zone: row.zone == null ? null : String(row.zone),
      status: String(row.status),
      skuCount: Number(row.sku_count),
      boxCount: Number(row.box_count),
      quantity: Number(row.quantity),
      available: Number(row.available),
    })),
  };
}

export function movementReport(db: DB, fromDate: string, toDate: string) {
  const from = `${fromDate}T00:00:00.000Z`;
  const to = `${toDate}T23:59:59.999Z`;
  const rowsRaw = rows(
    db,
    `SELECT substr(created_at, 1, 10) AS day, movement_type, COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS quantity
       FROM inventory_transactions
      WHERE created_at BETWEEN ? AND ?
      GROUP BY day, movement_type
      ORDER BY day ASC`,
    from,
    to,
  );
  const byDay = new Map<string, { day: string; count: number; quantity: number; byType: Record<string, number> }>();
  for (const row of rowsRaw) {
    const day = String(row.day);
    const entry = byDay.get(day) ?? { day, count: 0, quantity: 0, byType: {} };
    entry.count += Number(row.count);
    entry.quantity += Number(row.quantity);
    entry.byType[String(row.movement_type)] = Number(row.quantity);
    byDay.set(day, entry);
  }
  return { from: fromDate, to: toDate, days: [...byDay.values()], rows: rowsRaw };
}

export function expiryReport(db: DB) {
  const batches = rows(
    db,
    `SELECT b.id, b.batch_no, b.expiry_date, p.id AS product_id, p.sku, p.name,
            SUM(ib.quantity) AS quantity
       FROM batches b
       JOIN products p ON p.id = b.product_id
       JOIN inventory_balances ib ON ib.batch_id = b.id
      WHERE ib.quantity > 0 AND ib.status = 'AVAILABLE'
      GROUP BY b.id, p.id
      ORDER BY b.expiry_date ASC`,
  );
  const today = todayIso();
  const buckets = [
    { key: 'EXPIRED', label: 'Expired', min: -Infinity, max: -1, quantity: 0, batches: 0 },
    { key: 'D0_30', label: '0-30 days', min: 0, max: 30, quantity: 0, batches: 0 },
    { key: 'D31_60', label: '31-60 days', min: 31, max: 60, quantity: 0, batches: 0 },
    { key: 'D61_90', label: '61-90 days', min: 61, max: 90, quantity: 0, batches: 0 },
    { key: 'D91_180', label: '91-180 days', min: 91, max: 180, quantity: 0, batches: 0 },
    { key: 'D180_PLUS', label: '180+ days', min: 181, max: Infinity, quantity: 0, batches: 0 },
  ];
  const enriched = batches.map((row) => {
    const quantity = Number(row.quantity);
    const expiry = row.expiry_date ? String(row.expiry_date) : null;
    let daysLeft: number | null = null;
    if (expiry) {
      daysLeft = Math.round((new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
    }
    const bucket = buckets.find((entry) => daysLeft !== null && daysLeft >= entry.min && daysLeft <= entry.max);
    if (bucket) {
      bucket.quantity += quantity;
      bucket.batches += 1;
    }
    return { ...row, quantity, daysLeft };
  });
  return { asOf: today, buckets, batches: enriched };
}
