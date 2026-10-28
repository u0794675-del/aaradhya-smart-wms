import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nextSku } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

export const UOM_VALUES = ['PIECE', 'STRIP', 'PACK', 'CARTON', 'BOX', 'CASE'] as const;
export type Uom = (typeof UOM_VALUES)[number];

export interface ProductInput {
  sku?: string;
  name: string;
  parentSku?: string | null;
  brand?: string | null;
  category?: string | null;
  subcategory?: string | null;
  productType?: string | null;
  description?: string | null;
  baseUom: Uom;
  isBatchTracked?: boolean;
  isExpiryTracked?: boolean;
  qcRequired?: boolean;
  costPrice?: number | null;
  lowStockThreshold?: number | null;
  barcode?: string | null;
  uomConversions?: Array<{ fromUom: Uom; toUom: Uom; factor: number }>;
}

function validateUom(uom: string): Uom {
  if (!UOM_VALUES.includes(uom as Uom)) throw badRequest('INVALID_UOM', `Unsupported unit of measure: ${uom}`);
  return uom as Uom;
}

export function createProduct(db: DB, input: ProductInput, actor: AuthUser): string {
  const sku = (input.sku?.trim().toUpperCase() || nextSku(db));
  if (!/^[A-Z0-9][A-Z0-9._-]{1,49}$/.test(sku)) {
    throw badRequest('INVALID_SKU', 'SKU must be 2-50 characters of letters, digits, dot, underscore or dash');
  }
  const exists = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (exists) throw conflict('SKU_EXISTS', `SKU ${sku} already exists; existing company SKUs are never replaced`);
  const baseUom = validateUom(input.baseUom);
  const name = input.name.trim();
  if (!name) throw badRequest('NAME_REQUIRED', 'Product name is required');

  let parentId: string | null = null;
  if (input.parentSku) {
    const parent = db.prepare('SELECT id FROM products WHERE sku = ?').get(input.parentSku.trim().toUpperCase()) as
      | { id: string }
      | undefined;
    if (!parent) throw notFound(`Parent SKU ${input.parentSku} not found`);
    parentId = parent.id;
  }
  if (input.isExpiryTracked && !input.isBatchTracked) {
    throw badRequest('EXPIRY_REQUIRES_BATCH', 'Expiry tracking requires batch tracking');
  }
  const barcode = (input.barcode?.trim() || sku).toUpperCase();
  if (db.prepare('SELECT id FROM product_barcodes WHERE barcode = ?').get(barcode)) {
    throw conflict('BARCODE_EXISTS', `Barcode ${barcode} is already assigned to another record`);
  }

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO products
      (id, sku, parent_id, name, brand, category, subcategory, product_type, description, base_uom,
       is_batch_tracked, is_expiry_tracked, qc_required, cost_price, low_stock_threshold, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
  ).run(
    id,
    sku,
    parentId,
    name,
    input.brand ?? null,
    input.category ?? null,
    input.subcategory ?? null,
    input.productType ?? null,
    input.description ?? null,
    baseUom,
    input.isBatchTracked ? 1 : 0,
    input.isExpiryTracked ? 1 : 0,
    input.qcRequired === false ? 0 : 1,
    input.costPrice ?? null,
    input.lowStockThreshold ?? null,
    actor.id,
    now,
    now,
  );

  if (input.isExpiryTracked && !input.isBatchTracked) {
    throw badRequest('EXPIRY_REQUIRES_BATCH', 'Expiry tracking requires batch tracking');
  }

  db.prepare(
    'INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(newId(), id, barcode, 'INTERNAL', now);

  for (const conversion of input.uomConversions ?? []) {
    addUomConversion(db, id, conversion.fromUom, conversion.toUom, conversion.factor, actor, false);
  }

  recordAudit(db, {
    eventType: 'PRODUCT_CREATED',
    entityType: 'PRODUCT',
    entityId: id,
    after: {
      sku,
      name,
      baseUom,
      isBatchTracked: Boolean(input.isBatchTracked),
      isExpiryTracked: Boolean(input.isExpiryTracked),
      barcode,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return id;
}

export function updateProduct(db: DB, id: string, patch: Partial<ProductInput> & { status?: 'ACTIVE' | 'INACTIVE' }, actor: AuthUser): void {
  const before = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!before) throw notFound('Product not found');
  if (patch.sku && patch.sku.toUpperCase() !== before.sku) {
    throw conflict('SKU_IMMUTABLE', 'Company SKU changes require a controlled approval workflow; edit is blocked');
  }
  if (patch.isBatchTracked !== undefined || patch.isExpiryTracked !== undefined) {
    const stock = db.prepare('SELECT COUNT(*) AS n FROM inventory_balances WHERE product_id = ?').get(id) as { n: number };
    if (Number(stock.n) > 0) {
      throw conflict('TRACKING_CHANGE_BLOCKED', 'Batch/expiry tracking cannot be changed while stock exists');
    }
  }
  const fields: string[] = [];
  const values: any[] = [];
  const map: Array<[keyof typeof patch, string]> = [
    ['name', 'name'],
    ['brand', 'brand'],
    ['category', 'category'],
    ['subcategory', 'subcategory'],
    ['productType', 'product_type'],
    ['description', 'description'],
    ['qcRequired', 'qc_required'],
    ['costPrice', 'cost_price'],
    ['lowStockThreshold', 'low_stock_threshold'],
    ['status', 'status'],
    ['isBatchTracked', 'is_batch_tracked'],
    ['isExpiryTracked', 'is_expiry_tracked'],
  ];
  for (const [key, column] of map) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      const value = patch[key];
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const after = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  recordAudit(db, {
    eventType: 'PRODUCT_UPDATED',
    entityType: 'PRODUCT',
    entityId: id,
    before,
    after,
    actor: { userId: actor.id, role: actor.role },
  });
}

export function addBarcode(db: DB, productId: string, barcode: string, type: 'EAN' | 'CODE128' | 'QR' | 'INTERNAL', actor: AuthUser): string {
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw notFound('Product not found');
  const value = barcode.trim().toUpperCase();
  if (!value) throw badRequest('BARCODE_REQUIRED', 'Barcode is required');
  if (db.prepare('SELECT id FROM product_barcodes WHERE barcode = ?').get(value)) {
    throw conflict('BARCODE_EXISTS', `Barcode ${value} is already assigned`);
  }
  const id = newId();
  db.prepare(
    'INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(id, productId, value, type, nowIso());
  recordAudit(db, {
    eventType: 'BARCODE_ADDED',
    entityType: 'PRODUCT',
    entityId: productId,
    after: { barcode: value, type },
    actor: { userId: actor.id, role: actor.role },
  });
  return id;
}

export function addUomConversion(
  db: DB,
  productId: string,
  fromUom: Uom,
  toUom: Uom,
  factor: number,
  actor: AuthUser,
  audit = true,
): void {
  validateUom(fromUom);
  validateUom(toUom);
  if (fromUom === toUom) throw badRequest('INVALID_CONVERSION', 'Conversion units must differ');
  if (!Number.isInteger(factor) || factor <= 0) throw badRequest('INVALID_CONVERSION', 'Conversion factor must be a positive whole number');
  if (db.prepare('SELECT id FROM product_uom_conversions WHERE product_id = ? AND from_uom = ? AND to_uom = ?').get(productId, fromUom, toUom)) {
    throw conflict('CONVERSION_EXISTS', 'This unit conversion is already configured');
  }
  db.prepare(
    'INSERT INTO product_uom_conversions (id, product_id, from_uom, to_uom, factor) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), productId, fromUom, toUom, factor);
  if (audit) {
    recordAudit(db, {
      eventType: 'UOM_CONVERSION_ADDED',
      entityType: 'PRODUCT',
      entityId: productId,
      after: { fromUom, toUom, factor },
      actor: { userId: actor.id, role: actor.role },
    });
  }
}

export function convertToBase(db: DB, productId: string, quantity: number, uom: Uom): number {
  if (!Number.isInteger(quantity) || quantity <= 0) throw badRequest('INVALID_QUANTITY', 'Quantity must be a positive whole number');
  const product = db.prepare('SELECT base_uom FROM products WHERE id = ?').get(productId) as { base_uom: Uom } | undefined;
  if (!product) throw notFound('Product not found');
  if (uom === product.base_uom) return quantity;
  const conversions = db
    .prepare('SELECT from_uom, to_uom, factor FROM product_uom_conversions WHERE product_id = ?')
    .all(productId) as Array<{ from_uom: Uom; to_uom: Uom; factor: number }>;

  const queue: Array<{ uom: Uom; multiplier: number; depth: number }> = [{ uom, multiplier: 1, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > 3) break;
    if (current.uom === product.base_uom) {
      const converted = quantity * current.multiplier;
      if (!Number.isInteger(converted)) {
        throw badRequest('FRACTIONAL_QUANTITY', 'The configured conversion produces a fractional base quantity');
      }
      return converted;
    }
    for (const conversion of conversions) {
      if (conversion.from_uom === current.uom && !visited.has(conversion.to_uom)) {
        visited.add(conversion.to_uom);
        queue.push({ uom: conversion.to_uom, multiplier: current.multiplier * Number(conversion.factor), depth: current.depth + 1 });
      }
    }
  }
  throw conflict('UOM_CONVERSION_NOT_CONFIGURED', `No configured conversion from ${uom} to ${product.base_uom}`);
}

export function createBatch(
  db: DB,
  input: { productId: string; batchNo: string; mfgDate?: string | null; expiryDate?: string | null; vendorId?: string | null },
  actor: AuthUser,
): string {
  const product = db.prepare('SELECT sku, is_batch_tracked, is_expiry_tracked FROM products WHERE id = ?').get(input.productId) as
    | { sku: string; is_batch_tracked: number; is_expiry_tracked: number }
    | undefined;
  if (!product) throw notFound('Product not found');
  const batchNo = input.batchNo.trim();
  if (!batchNo) throw badRequest('BATCH_NO_REQUIRED', 'Batch number is required');
  if (product.is_batch_tracked === 0) throw badRequest('BATCH_NOT_ALLOWED', `SKU ${product.sku} is not batch tracked`);
  if (product.is_expiry_tracked === 1 && !input.expiryDate) {
    throw badRequest('EXPIRY_REQUIRED', `SKU ${product.sku} requires an expiry date for every batch`);
  }
  if (input.expiryDate && input.mfgDate && input.expiryDate <= input.mfgDate) {
    throw badRequest('INVALID_EXPIRY', 'Expiry date must be after the manufacturing date');
  }
  const existing = db
    .prepare('SELECT id FROM batches WHERE product_id = ? AND batch_no = ?')
    .get(input.productId, batchNo) as { id: string } | undefined;
  if (existing) throw conflict('BATCH_EXISTS', `Batch ${batchNo} already exists for this SKU`);
  const id = newId();
  db.prepare(
    'INSERT INTO batches (id, product_id, batch_no, mfg_date, expiry_date, vendor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.productId, batchNo, input.mfgDate ?? null, input.expiryDate ?? null, input.vendorId ?? null, nowIso());
  recordAudit(db, {
    eventType: 'BATCH_CREATED',
    entityType: 'BATCH',
    entityId: id,
    after: { sku: product.sku, batchNo, mfgDate: input.mfgDate ?? null, expiryDate: input.expiryDate ?? null },
    actor: { userId: actor.id, role: actor.role },
  });
  return id;
}

export function stockSummary(db: DB, productId: string) {
  const rows = db
    .prepare(
      `SELECT sp.code AS pool, ib.status,
              SUM(ib.quantity) AS quantity,
              SUM(ib.reserved_quantity) AS reserved,
              SUM(ib.quantity - ib.reserved_quantity) AS available
         FROM inventory_balances ib JOIN stock_pools sp ON sp.id = ib.pool_id
        WHERE ib.product_id = ? GROUP BY sp.code, ib.status ORDER BY sp.code, ib.status`,
    )
    .all(productId);
  const onHand = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const available = db
    .prepare(
      `SELECT COALESCE(SUM(quantity - reserved_quantity), 0) AS n FROM inventory_balances
        WHERE product_id = ? AND status = 'AVAILABLE'`,
    )
    .get(productId) as { n: number };
  return { rows, onHand, available: Number(available.n) };
}

export function getProduct(db: DB, idOrSku: string, includeCost = false) {
  const product = db
    .prepare('SELECT * FROM products WHERE id = ? OR sku = ?')
    .get(idOrSku, idOrSku.toUpperCase()) as Record<string, any> | undefined;
  if (!product) throw notFound('Product not found');
  if (!includeCost) delete product.cost_price;
  const barcodes = db.prepare('SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY created_at').all(product.id);
  const aliases = db.prepare('SELECT * FROM product_aliases WHERE product_id = ?').all(product.id);
  const conversions = db.prepare('SELECT * FROM product_uom_conversions WHERE product_id = ?').all(product.id);
  const batches = db
    .prepare('SELECT * FROM batches WHERE product_id = ? ORDER BY expiry_date IS NULL, expiry_date')
    .all(product.id);
  const children = db.prepare('SELECT id, sku, name FROM products WHERE parent_id = ? ORDER BY sku').all(product.id);
  const parent = product.parent_id
    ? db.prepare('SELECT id, sku, name FROM products WHERE id = ?').get(product.parent_id)
    : null;
  const summary = stockSummary(db, product.id);
  const source = db.prepare('SELECT * FROM product_sources WHERE product_id = ?').get(product.id) ?? null;
  return { product, barcodes, aliases, conversions, batches, children, parent, summary, source };
}

export function listProducts(
  db: DB,
  filters: { search?: string; category?: string; status?: string; limit?: number; offset?: number; includeCost?: boolean },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.search) {
    conditions.push('(p.sku LIKE ? OR p.name LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode LIKE ?))');
    const term = `%${filters.search.trim()}%`;
    params.push(term, term, term);
  }
  if (filters.category) {
    conditions.push('p.category = ?');
    params.push(filters.category);
  }
  if (filters.status) {
    conditions.push('p.status = ?');
    params.push(filters.status);
  }
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT p.*,
              COALESCE(SUM(ib.quantity), 0) AS on_hand,
              COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE' THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available,
              COUNT(DISTINCT ib.box_id) AS box_count,
              ps.verification_status, ps.source_verification, ps.source_row_no, ps.source_file
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.product_id = p.id
         LEFT JOIN product_sources ps ON ps.product_id = p.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY p.id, ps.product_id
        ORDER BY p.sku
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, any>>;
  if (!filters.includeCost) for (const row of rows) delete row.cost_price;
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}
