import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { nowIso } from './time.ts';

export const newId = (): string => randomUUID();

export function nextSequence(db: DB, name: string): number {
  const row = db
    .prepare(
      `INSERT INTO sequences (name, value) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET value = sequences.value + 1
       RETURNING value`,
    )
    .get(name) as { value: number };
  return Number(row.value);
}

export function documentNo(db: DB, sequence: string, prefix: string, width = 5): string {
  const n = nextSequence(db, sequence);
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

export function nextSku(db: DB): string {
  const n = nextSequence(db, 'SKU');
  return `AHP${String(n).padStart(4, '0')}`;
}

export function nextBoxCode(db: DB, type: 'SINGLE' | 'MIXED'): string {
  const prefix = type === 'MIXED' ? 'MIX' : 'BOX';
  return documentNo(db, prefix, prefix, 3);
}

export function correlationId(): string {
  return randomUUID();
}

export function nowOr(createdAt?: string): string {
  return createdAt ?? nowIso();
}
