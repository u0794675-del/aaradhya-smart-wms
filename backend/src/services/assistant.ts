import type { DB } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { addDays, nowIso, todayIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { searchAll } from './operations.ts';

interface Citation {
  type: string;
  id: string;
  label: string;
}

interface AssistantResult {
  intent: string;
  answer: string;
  citations: Citation[];
  data: unknown;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'at', 'to', 'and', 'or', 'is', 'are', 'how', 'much', 'many',
  'what', 'where', 'which', 'show', 'me', 'please', 'stock', 'on', 'hand', 'available', 'availability',
  'quantity', 'balance', 'do', 'we', 'have', 'there', 'any', 'status', 'order', 'for', 'current', 'now',
]);

function productBalances(db: DB, productId: string) {
  return db
    .prepare(
      `SELECT ib.status, ib.quantity, ib.reserved_quantity, l.code AS location, sp.code AS pool,
              bx.box_code, b.batch_no, b.expiry_date
         FROM inventory_balances ib
         JOIN locations l ON l.id = ib.location_id
         JOIN stock_pools sp ON sp.id = ib.pool_id
         LEFT JOIN boxes bx ON bx.id = ib.box_id
         LEFT JOIN batches b ON b.id = ib.batch_id
        WHERE ib.product_id = ? AND ib.quantity > 0
        ORDER BY CASE ib.status WHEN 'AVAILABLE' THEN 0 ELSE 1 END, l.code`,
    )
    .all(productId) as Array<Record<string, any>>;
}

function stockAnswer(db: DB, product: Record<string, any>): AssistantResult {
  const balances = productBalances(db, String(product.id));
  const available = balances
    .filter((row) => row.status === 'AVAILABLE')
    .reduce((sum, row) => sum + Number(row.quantity) - Number(row.reserved_quantity), 0);
  const onHand = balances.reduce((sum, row) => sum + Number(row.quantity), 0);
  const locations = balances
    .filter((row) => row.status === 'AVAILABLE')
    .map((row) => `${row.location} (${row.pool}) × ${Number(row.quantity)}${row.box_code ? ` in ${row.box_code}` : ''}`)
    .slice(0, 5);
  const parts = [
    `${product.sku} — ${product.name}: ${onHand} on hand, ${available} sellable right now.`,
  ];
  if (locations.length) parts.push(`Sellable stock: ${locations.join('; ')}.`);
  const held = balances.filter((row) => row.status !== 'AVAILABLE');
  if (held.length) {
    parts.push(
      `Not sellable: ${held
        .map((row) => `${row.status} × ${Number(row.quantity)} at ${row.location}`)
        .join('; ')}.`,
    );
  }
  return {
    intent: 'STOCK_LOOKUP',
    answer: parts.join(' '),
    citations: [{ type: 'PRODUCT', id: String(product.id), label: `${product.sku} — ${product.name}` }],
    data: { product: { id: product.id, sku: product.sku, name: product.name }, balances, onHand, available },
  };
}

function lowStockAnswer(db: DB): AssistantResult {
  const threshold = getSetting(db, 'low_stock_default', 20);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT p.id, p.sku, p.name, COALESCE(p.low_stock_threshold, ?) AS threshold,
                COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available
           FROM products p LEFT JOIN inventory_balances ib ON ib.product_id = p.id
          WHERE p.status = 'ACTIVE'
          GROUP BY p.id
       ) s
        WHERE s.available < s.threshold
        ORDER BY s.available ASC LIMIT 20`,
    )
    .all(threshold) as Array<Record<string, any>>;
  if (!rows.length) {
    return { intent: 'LOW_STOCK', answer: 'No active SKU is below its low-stock threshold right now.', citations: [], data: [] };
  }
  return {
    intent: 'LOW_STOCK',
    answer: `${rows.length} SKU${rows.length === 1 ? '' : 's'} below threshold: ${rows
      .slice(0, 8)
      .map((row) => `${row.sku} (${Number(row.available)} available, threshold ${Number(row.threshold)})`)
      .join('; ')}.`,
    citations: rows.slice(0, 5).map((row) => ({ type: 'PRODUCT', id: String(row.id), label: `${row.sku}` })),
    data: rows,
  };
}

function expiryAnswer(db: DB): AssistantResult {
  const warning = getSetting(db, 'expiry_warning_days', 60);
  const rows = db
    .prepare(
      `SELECT b.id, b.batch_no, b.expiry_date, p.sku, p.name, SUM(ib.quantity) AS quantity
         FROM batches b JOIN products p ON p.id = b.product_id
         JOIN inventory_balances ib ON ib.batch_id = b.id
        WHERE ib.quantity > 0 AND ib.status = 'AVAILABLE' AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?
        GROUP BY b.id, p.id ORDER BY b.expiry_date LIMIT 20`,
    )
    .all(addDays(warning).slice(0, 10)) as Array<Record<string, any>>;
  if (!rows.length) {
    return {
      intent: 'EXPIRY',
      answer: `No sellable batch expires within ${warning} days.`,
      citations: [],
      data: [],
    };
  }
  const expired = rows.filter((row) => String(row.expiry_date) < todayIso());
  return {
    intent: 'EXPIRY',
    answer: `${rows.length} batch${rows.length === 1 ? '' : 'es'} expiring within ${warning} days (${expired.length} already expired): ${rows
      .slice(0, 8)
      .map((row) => `${row.sku} batch ${row.batch_no} × ${Number(row.quantity)} on ${row.expiry_date}`)
      .join('; ')}.`,
    citations: rows.slice(0, 5).map((row) => ({ type: 'BATCH', id: String(row.id), label: `${row.sku} ${row.batch_no}` })),
    data: rows,
  };
}

function exceptionAnswer(db: DB): AssistantResult {
  const rows = db
    .prepare(
      `SELECT id, exception_no, type, severity, description FROM exceptions
        WHERE status IN ('OPEN','INVESTIGATING')
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END
        LIMIT 10`,
    )
    .all() as Array<Record<string, any>>;
  if (!rows.length) return { intent: 'EXCEPTIONS', answer: 'There are no open exceptions.', citations: [], data: [] };
  return {
    intent: 'EXCEPTIONS',
    answer: `${rows.length} open exception${rows.length === 1 ? '' : 's'}: ${rows
      .map((row) => `${row.exception_no} (${row.severity}) ${row.description}`)
      .join('; ')}.`,
    citations: rows.slice(0, 5).map((row) => ({ type: 'EXCEPTION', id: String(row.id), label: String(row.exception_no) })),
    data: rows,
  };
}

function orderAnswer(db: DB, orderNo: string): AssistantResult | null {
  const order = db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count,
              (SELECT COALESCE(SUM(l.ordered_qty),0) FROM order_lines l WHERE l.order_id = o.id) AS ordered_units,
              (SELECT COALESCE(SUM(l.picked_qty),0) FROM order_lines l WHERE l.order_id = o.id) AS picked_units
         FROM orders o WHERE o.order_no = ? OR o.id = ?`,
    )
    .get(orderNo.toUpperCase(), orderNo) as Record<string, any> | undefined;
  if (!order) return null;
  const shipments = db.prepare('SELECT shipment_no, carrier, tracking_no FROM shipments WHERE order_id = ?').all(order.id);
  const shipmentText = shipments.length
    ? ` Shipped via ${shipments.map((row) => `${row.carrier ?? 'carrier'} ${row.tracking_no ?? ''}`.trim()).join(', ')}.`
    : '';
  return {
    intent: 'ORDER_LOOKUP',
    answer: `${order.order_no} for ${order.customer_name} is ${order.status}: ${Number(order.picked_units)} of ${Number(
      order.ordered_units,
    )} units picked across ${Number(order.line_count)} line(s), ${order.channel}.${shipmentText}`,
    citations: [{ type: 'ORDER', id: String(order.id), label: String(order.order_no) }],
    data: { order, shipments },
  };
}

function recentOrders(db: DB): AssistantResult {
  const rows = db
    .prepare(
      `SELECT id, order_no, customer_name, status, channel, created_at FROM orders
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as Array<Record<string, any>>;
  return {
    intent: 'RECENT_ORDERS',
    answer: rows.length
      ? `Latest orders: ${rows.map((row) => `${row.order_no} ${row.status} (${row.customer_name})`).join('; ')}.`
      : 'No orders exist yet.',
    citations: rows.slice(0, 5).map((row) => ({ type: 'ORDER', id: String(row.id), label: String(row.order_no) })),
    data: rows,
  };
}

function recentMovements(db: DB): AssistantResult {
  const rows = db
    .prepare(
      `SELECT t.id, t.txn_no, t.movement_type, t.quantity, t.created_at, p.sku
         FROM inventory_transactions t JOIN products p ON p.id = t.product_id
        ORDER BY t.created_at DESC LIMIT 10`,
    )
    .all() as Array<Record<string, any>>;
  return {
    intent: 'RECENT_MOVEMENTS',
    answer: rows.length
      ? `Latest stock movements: ${rows.map((row) => `${row.movement_type} ${row.sku} × ${Number(row.quantity)}`).join('; ')}.`
      : 'No stock movements have been recorded yet.',
    citations: rows.slice(0, 5).map((row) => ({ type: 'PRODUCT', id: String(row.id), label: String(row.sku) })),
    data: rows,
  };
}

function findProducts(db: DB, question: string) {
  const sku = question.match(/\bAHP\d+\b/i);
  if (sku) {
    return db
      .prepare('SELECT id, sku, name FROM products WHERE sku = ?')
      .all(sku[0].toUpperCase()) as Array<Record<string, any>>;
  }
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    .slice(0, 4);
  if (!tokens.length) return [];
  const conditions = tokens.map(() => '(LOWER(p.sku) LIKE ? OR LOWER(p.name) LIKE ?)').join(' OR ');
  const params = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
  return db
    .prepare(`SELECT id, sku, name FROM products p WHERE ${conditions} ORDER BY p.sku LIMIT 5`)
    .all(...params) as Array<Record<string, any>>;
}

function answerQuestion(db: DB, question: string): AssistantResult {
  const lower = question.toLowerCase();
  const orderMatch = question.match(/\b(?:ORD-\d+)\b/i);
  if (orderMatch) {
    const order = orderAnswer(db, orderMatch[0]);
    if (order) return order;
  }
  if (/\bexception/.test(lower)) return exceptionAnswer(db);
  if (/\blow stock|reorder|below threshold|shortage\b/.test(lower)) return lowStockAnswer(db);
  if (/\bexpir/.test(lower)) return expiryAnswer(db);
  if (/\bmovement|activity|ledger|transactions?\b/.test(lower)) return recentMovements(db);
  if (/\border/.test(lower)) {
    if (/\blast|recent|latest|today|open|pending\b/.test(lower)) return recentOrders(db);
    const fallbackOrder = orderAnswer(db, question.trim());
    if (fallbackOrder) return fallbackOrder;
    return recentOrders(db);
  }
  if (/\bstock|available|on hand|balance|where|quantity|units\b/.test(lower)) {
    const products = findProducts(db, question);
    if (products.length === 1) return stockAnswer(db, products[0]);
    if (products.length > 1) {
      const summaries = products.map((product) => stockAnswer(db, product));
      return {
        intent: 'STOCK_LOOKUP',
        answer: `I found ${products.length} matching SKUs. ${summaries.map((entry) => entry.answer).join(' ')}`,
        citations: summaries.flatMap((entry) => entry.citations),
        data: summaries.map((entry) => entry.data),
      };
    }
    return {
      intent: 'STOCK_LOOKUP',
      answer: 'I could not match that product. Try an SKU such as AHP00001, a product name, or ask for low stock or expiring batches.',
      citations: [],
      data: null,
    };
  }
  const search = searchAll(db, question);
  const items: Array<Record<string, any>> = [];
  for (const group of search.groups) {
    for (const item of group.items as Array<Record<string, any>>) {
      items.push({ group: group.type, ...item });
    }
  }
  return {
    intent: 'SEARCH',
    answer: items.length
      ? `I found ${items.length} matching record${items.length === 1 ? '' : 's'} across ${search.groups.length} categories.`
      : 'I could not find a matching record. Try an order number, SKU, box code, batch number or ask about stock, expiring batches or low stock.',
    citations: items.slice(0, 5).map((item) => ({
      type: String(item.group).replace(/S$/, ''),
      id: String(item.id),
      label: String(item.number ?? item.label ?? item.sku ?? item.id),
    })),
    data: search,
  };
}

export function askAssistant(db: DB, question: string, actor: AuthUser): AssistantResult {
  if (!question.trim() || question.length > 1000) {
    throw badRequest('QUESTION_INVALID', 'Ask a question between 1 and 1000 characters');
  }
  const logId = newId();
  try {
    const result = answerQuestion(db, question.trim());
    db.prepare(
      `INSERT INTO ai_action_logs
        (id, user_id, question, intent, sql_or_filter, answer, result_count, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'SUCCESS', ?)`,
    ).run(
      logId,
      actor.id,
      question.trim(),
      result.intent,
      'read-only grounded query',
      result.answer.slice(0, 4000),
      Array.isArray(result.data) ? result.data.length : 1,
      nowIso(),
    );
    return result;
  } catch (error) {
    db.prepare(
      `INSERT INTO ai_action_logs
        (id, user_id, question, intent, sql_or_filter, answer, result_count, outcome, created_at)
       VALUES (?, ?, ?, 'ERROR', NULL, ?, 0, 'FAILURE', ?)`,
    ).run(logId, actor.id, question.trim().slice(0, 1000), (error as Error).message.slice(0, 1000), nowIso());
    throw error;
  }
}
