import type { DB } from '../db/index.ts';
import { notFound } from './errors.ts';

export function warehouseById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  if (!row) throw notFound('Warehouse not found');
  return row;
}

export function locationById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!row) throw notFound('Location not found');
  return row;
}

export function locationByCode(db: DB, code: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM locations WHERE code = ?').get(code);
  if (!row) throw notFound(`Location ${code} not found`);
  return row;
}

export function poolById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM stock_pools WHERE id = ?').get(id);
  if (!row) throw notFound('Stock pool not found');
  return row;
}

export function poolByCode(db: DB, code: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM stock_pools WHERE code = ?').get(code);
  if (!row) throw notFound(`Stock pool ${code} not found`);
  return row;
}

export function productById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!row) throw notFound('Product not found');
  return row;
}

export function boxById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM boxes WHERE id = ?').get(id);
  if (!row) throw notFound('Box not found');
  return row;
}

export function batchById(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  if (!row) throw notFound('Batch not found');
  return row;
}

export function requireLocation(db: DB, id: string): Record<string, unknown> {
  return locationById(db, id);
}

export function systemLocation(db: DB, warehouseId: string, code: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM locations WHERE warehouse_id = ? AND code = ?').get(warehouseId, code);
  if (!row) throw notFound(`System location ${code} is not configured for this warehouse`);
  return row;
}
