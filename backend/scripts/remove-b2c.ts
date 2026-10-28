import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { openDatabase, withTransaction, type DB } from '../src/db/index.ts';
import { newId } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/time.ts';

type Row = Record<string, unknown>;

interface BalanceRow extends Row {
  id: string;
  warehouse_id: string;
  location_id: string | null;
  pool_id: string;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  status: string;
  quantity: number;
  reserved_quantity: number;
}

interface Endpoint {
  warehouse_id: string;
  location_id: string | null;
  pool_id: string;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  status: string;
}

function select(db: DB, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all<Row>(...params);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function endpointKey(endpoint: Endpoint): string {
  return JSON.stringify([
    endpoint.warehouse_id,
    endpoint.location_id,
    endpoint.pool_id,
    endpoint.product_id,
    endpoint.batch_id,
    endpoint.box_id,
    endpoint.status,
  ]);
}

function totalUnits(db: DB): number {
  const row = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_balances').get() as { total: number };
  return Number(row.total);
}

function findBalance(db: DB, endpoint: Endpoint): { id: string; quantity: number } | undefined {
  return db
    .prepare(
      `SELECT id, quantity FROM inventory_balances
       WHERE warehouse_id = ? AND location_id IS ? AND pool_id = ? AND product_id = ?
         AND batch_id IS ? AND box_id IS ? AND status = ?`,
    )
    .get<{ id: string; quantity: number }>(
      endpoint.warehouse_id,
      endpoint.location_id,
      endpoint.pool_id,
      endpoint.product_id,
      endpoint.batch_id,
      endpoint.box_id,
      endpoint.status,
    );
}

function applyDeltas(db: DB, deltas: Map<string, { endpoint: Endpoint; delta: number }>): Row[] {
  const restored: Row[] = [];
  for (const { endpoint, delta } of deltas.values()) {
    if (delta === 0) continue;
    const existing = findBalance(db, endpoint);
    if (!existing) {
      if (delta < 0) {
        throw new Error(`Cannot restore balance for ${endpoint.product_id}: row is missing but delta is ${delta}`);
      }
      const id = newId();
      db.prepare(
        `INSERT INTO inventory_balances
          (id, warehouse_id, location_id, pool_id, product_id, batch_id, box_id, status, quantity, reserved_quantity, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        id,
        endpoint.warehouse_id,
        endpoint.location_id,
        endpoint.pool_id,
        endpoint.product_id,
        endpoint.batch_id,
        endpoint.box_id,
        endpoint.status,
        delta,
        nowIso(),
      );
      restored.push({ ...endpoint, before: 0, after: delta });
      continue;
    }
    const next = Number(existing.quantity) + delta;
    if (next < 0) {
      throw new Error(`Cannot restore balance ${existing.id}: would become ${next}`);
    }
    if (next === 0) {
      db.prepare('DELETE FROM inventory_balances WHERE id = ?').run(existing.id);
    } else {
      db.prepare('UPDATE inventory_balances SET quantity = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), existing.id);
    }
    restored.push({ ...endpoint, before: Number(existing.quantity), after: next });
  }
  return restored;
}

function collectAuditEvents(db: DB, needles: string[]): Row[] {
  const events = select(db, 'SELECT * FROM audit_events ORDER BY created_at');
  return events.filter((event) => {
    const haystack = [event.entity_id, event.after_json, event.before_json, event.reason]
      .filter((value) => typeof value === 'string')
      .join('\n');
    return needles.some((needle) => needle && haystack.includes(needle));
  });
}

function scanB2C(db: DB): string[] {
  const tables = select(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const hits: string[] = [];
  for (const table of tables) {
    const name = String(table.name);
    const columns = select(db, `PRAGMA table_info("${name}")`);
    for (const column of columns) {
      const columnName = String(column.name);
      try {
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${columnName}" AS TEXT) LIKE ?`)
          .get<{ n: number }>('%B2C%');
        if (row && Number(row.n) > 0) hits.push(`${name}.${columnName}=${Number(row.n)}`);
      } catch {
        /* generated or virtual columns are not scannable */
      }
    }
  }
  return hits;
}

function main(): void {
  const apply = process.argv.includes('--apply');
  if (config.dbDriver !== 'sqlite') {
    throw new Error('This cleanup script currently supports SQLite databases only (DB_DRIVER=postgres is refused).');
  }
  const dbPath = path.resolve(config.dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const db = openDatabase(dbPath);

  try {
    const pools = select(db, "SELECT * FROM stock_pools WHERE code = 'B2C'");
    if (pools.length === 0) {
      console.log('No B2C pool exists in this database. Nothing to remove.');
      return;
    }
    const poolIds = pools.map((pool) => String(pool.id));
    const poolList = placeholders(poolIds.length);

    const balances = select(db, `SELECT * FROM inventory_balances WHERE pool_id IN (${poolList})`, poolIds) as BalanceRow[];
    const transfers = select(
      db,
      `SELECT * FROM transfers WHERE from_pool_id IN (${poolList}) OR to_pool_id IN (${poolList})`,
      [...poolIds, ...poolIds],
    );
    const transferIds = transfers.map((row) => String(row.id));
    const transferList = transferIds.length ? placeholders(transferIds.length) : null;
    const transactions = select(
      db,
      `SELECT * FROM inventory_transactions
        WHERE from_pool_id IN (${poolList}) OR to_pool_id IN (${poolList})
           ${transferList ? `OR (reference_type = 'TRANSFER' AND reference_id IN (${transferList}))` : ''}`,
      transferList
        ? [...poolIds, ...poolIds, ...transferIds]
        : [...poolIds, ...poolIds],
    );
    const transferLines = transferIds.length
      ? select(db, `SELECT * FROM transfer_lines WHERE transfer_id IN (${placeholders(transferIds.length)})`, transferIds)
      : [];
    const orders = select(db, `SELECT * FROM orders WHERE channel = 'B2C' OR pool_code = 'B2C'`);
    const orderIds = orders.map((row) => String(row.id));
    const orderLines = orderIds.length
      ? select(db, `SELECT * FROM order_lines WHERE order_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const reservations = orderIds.length
      ? select(db, `SELECT * FROM reservations WHERE order_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const packages = orderIds.length
      ? select(db, `SELECT * FROM packages WHERE order_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const shipments = orderIds.length
      ? select(db, `SELECT * FROM shipments WHERE order_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const returns = orderIds.length
      ? select(db, `SELECT * FROM returns WHERE order_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const notifications = orderIds.length
      ? select(db, `SELECT * FROM notifications WHERE entity_id IN (${placeholders(orderIds.length)})`, orderIds)
      : [];
    const aiLogs = select(db, "SELECT * FROM ai_action_logs WHERE question LIKE '%B2C%' OR answer LIKE '%B2C%'");

    const reservedInB2C = balances.filter((balance) => Number(balance.reserved_quantity) > 0);
    if (reservedInB2C.length > 0) {
      throw new Error('B2C balances still have reserved quantity; release or reallocate those reservations first.');
    }
    if (reservations.length > 0) {
      throw new Error('Reservations reference B2C orders; cancel or complete those orders first.');
    }
    if (packages.length > 0 || shipments.length > 0 || returns.length > 0) {
      throw new Error('Fulfilment records reference B2C orders; resolve them before removing B2C data.');
    }

    const transactionNos = transactions.map((row) => String(row.txn_no));
    const transactionIds = transactions.map((row) => String(row.id));
    const orderNos = orders.map((row) => String(row.order_no));
    const transferNos = transfers.map((row) => String(row.transfer_no));
    const needles = [
      ...poolIds,
      ...orderIds,
      ...orderNos,
      ...transferIds,
      ...transferNos,
      ...transactionIds,
      ...transactionNos,
      'B2C',
    ];
    const auditEvents = collectAuditEvents(db, needles);

    const idempotencyKeys = select(db, 'SELECT * FROM idempotency_keys').filter((row) => {
      const haystack = [row.path, row.response_json].filter((value) => typeof value === 'string').join('\n');
      return needles.some((needle) => needle && haystack.includes(needle));
    });

    const b2cPoolSet = new Set(poolIds);
    const deltas = new Map<string, { endpoint: Endpoint; delta: number }>();
    for (const txn of transactions) {
      const quantity = Number(txn.quantity);
      const endpoints: Array<{ endpoint: Endpoint; sign: number }> = [
        {
          sign: 1,
          endpoint: {
            warehouse_id: String(txn.from_warehouse_id),
            location_id: (txn.from_location_id as string | null) ?? null,
            pool_id: String(txn.from_pool_id),
            product_id: String(txn.product_id),
            batch_id: (txn.from_batch_id as string | null) ?? null,
            box_id: (txn.from_box_id as string | null) ?? null,
            status: String(txn.from_status),
          },
        },
        {
          sign: -1,
          endpoint: {
            warehouse_id: String(txn.to_warehouse_id),
            location_id: (txn.to_location_id as string | null) ?? null,
            pool_id: String(txn.to_pool_id),
            product_id: String(txn.product_id),
            batch_id: (txn.to_batch_id as string | null) ?? null,
            box_id: (txn.to_box_id as string | null) ?? null,
            status: String(txn.to_status),
          },
        },
      ];
      for (const entry of endpoints) {
        if (b2cPoolSet.has(entry.endpoint.pool_id)) continue;
        const key = endpointKey(entry.endpoint);
        const current = deltas.get(key) ?? { endpoint: entry.endpoint, delta: 0 };
        current.delta += quantity * entry.sign;
        deltas.set(key, current);
      }
    }

    const unitsBefore = totalUnits(db);
    const archive = {
      generatedAt: nowIso(),
      database: dbPath,
      mode: apply ? 'apply' : 'dry-run',
      removed: {
        stock_pools: pools,
        inventory_balances: balances,
        inventory_transactions: transactions,
        transfers,
        transfer_lines: transferLines,
        orders,
        order_lines: orderLines,
        packages,
        shipments,
        returns,
        notifications,
        ai_action_logs: aiLogs,
        idempotency_keys: idempotencyKeys,
        audit_events: auditEvents,
      },
      balanceDeltas: [...deltas.values()],
      counts: {
        stock_pools: pools.length,
        inventory_balances: balances.length,
        inventory_transactions: transactions.length,
        transfers: transfers.length,
        transfer_lines: transferLines.length,
        orders: orders.length,
        order_lines: orderLines.length,
        reservations: reservations.length,
        packages: packages.length,
        shipments: shipments.length,
        returns: returns.length,
        notifications: notifications.length,
        ai_action_logs: aiLogs.length,
        idempotency_keys: idempotencyKeys.length,
        audit_events: auditEvents.length,
      },
      unitsBefore,
    };

    const summary = {
      pool: pools.map((pool) => ({ id: pool.id, code: pool.code, name: pool.name })),
      balances: balances.length,
      balanceUnits: balances.reduce((total, row) => total + Number(row.quantity), 0),
      transactions: transactions.length,
      transfers: transfers.length,
      orders: orders.length,
      auditEvents: auditEvents.length,
      idempotencyKeys: idempotencyKeys.length,
      unitsBefore,
      restored: [...deltas.values()].filter((entry) => entry.delta !== 0),
    };

    if (!apply) {
      console.log(JSON.stringify({ dryRun: true, summary }, null, 2));
      return;
    }

    const backupPath = `${dbPath}.b2c-removal-${stamp}.bak`;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const archivePath = `${dbPath}.b2c-archive-${stamp}.json`;
    fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));

    const deleteTriggers = select(
      db,
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_txn_no_delete', 'trg_audit_no_delete')",
    ) as Array<{ name: string; sql: string }>;

    const result = withTransaction(db, () => {
      for (const trigger of deleteTriggers) db.exec(`DROP TRIGGER "${trigger.name}"`);

      for (const event of auditEvents) {
        db.prepare('DELETE FROM audit_events WHERE id = ?').run(String(event.id));
      }
      for (const key of idempotencyKeys) {
        db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?').run(String(key.user_id), String(key.idem_key));
      }
      for (const log of aiLogs) {
        db.prepare('DELETE FROM ai_action_logs WHERE id = ?').run(String(log.id));
      }
      for (const notification of notifications) {
        db.prepare('DELETE FROM notifications WHERE id = ?').run(String(notification.id));
      }
      for (const line of orderLines) {
        db.prepare('DELETE FROM order_lines WHERE id = ?').run(String(line.id));
      }
      for (const order of orders) {
        db.prepare('DELETE FROM orders WHERE id = ?').run(String(order.id));
      }
      for (const line of transferLines) {
        db.prepare('DELETE FROM transfer_lines WHERE id = ?').run(String(line.id));
      }
      for (const transfer of transfers) {
        db.prepare('DELETE FROM transfers WHERE id = ?').run(String(transfer.id));
      }
      for (const txn of transactions) {
        db.prepare('DELETE FROM inventory_transactions WHERE id = ?').run(String(txn.id));
      }
      const restored = applyDeltas(db, deltas);
      for (const balance of balances) {
        db.prepare('DELETE FROM inventory_balances WHERE id = ?').run(String(balance.id));
      }
      for (const pool of pools) {
        db.prepare('DELETE FROM stock_pools WHERE id = ?').run(String(pool.id));
      }

      for (const trigger of deleteTriggers) db.exec(trigger.sql);

      const unitsAfter = totalUnits(db);
      const fkIssues = select(db, 'PRAGMA foreign_key_check');
      const remaining = scanB2C(db);
      const remainingBalances = select(
        db,
        `SELECT COUNT(*) AS n FROM inventory_balances WHERE pool_id IN (${poolList})`,
        poolIds,
      )[0];

      if (unitsAfter !== unitsBefore) {
        throw new Error(`Unit total changed from ${unitsBefore} to ${unitsAfter}; cleanup rolled back.`);
      }
      if (remaining.length > 0) {
        throw new Error(`B2C references remain after cleanup: ${remaining.join(', ')}`);
      }
      if (fkIssues.length > 0) {
        throw new Error(`Foreign key violations after cleanup: ${JSON.stringify(fkIssues)}`);
      }
      if (Number(remainingBalances?.n ?? 0) !== 0) {
        throw new Error('B2C balances remain after cleanup');
      }

      return { restored, unitsAfter, remaining, fkIssues };
    });

    const { unitsAfter, remaining, fkIssues } = result;

    const reportPath = `${dbPath}.b2c-removal-${stamp}.report.json`;
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          completedAt: nowIso(),
          database: dbPath,
          backupPath,
          archivePath,
          summary,
          restoredBalances: result.restored,
          unitsBefore,
          unitsAfter,
          foreignKeyIssues: fkIssues.length,
          b2cReferencesRemaining: remaining,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          applied: true,
          backupPath,
          archivePath,
          reportPath,
          unitsBefore,
          unitsAfter,
          removed: summary,
          restoredBalances: result.restored,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

main();
