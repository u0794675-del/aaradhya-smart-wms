import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DB, Statement } from './types.ts';

export type { DB, RunResult, Statement } from './types.ts';

export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return {
    dialect: 'sqlite',
    prepare: (sql: string) => db.prepare(sql) as unknown as Statement,
    exec: (sql: string) => {
      db.exec(sql);
    },
    close: () => db.close(),
  };
}

let txDepth = 0;

/**
 * Runs fn atomically. Nested calls use savepoints so composed services share
 * one database transaction. Stock movement validation assumes write serialisation
 * provided by BEGIN IMMEDIATE and conditional balance updates.
 */
export function withTransaction<T>(db: DB, fn: () => T): T {
  const depth = txDepth;
  const savepoint = `sp_${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (txDepth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    txDepth -= 1;
    if (txDepth === 0) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* transaction already rolled back */
      }
    } else {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  }
}

export function resetTransactionStateForTests(): void {
  txDepth = 0;
}
