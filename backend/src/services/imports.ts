import { createHash } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { cellText, parseWorkbook, rowHasData } from '../lib/workbook.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { createProduct } from './products.ts';
import { parseBase64File } from './workbook-import.ts';

const UOMS = new Set(['PIECE', 'STRIP', 'PACK', 'CARTON', 'BOX', 'CASE']);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field.replace(/\r$/, ''));
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
}

export interface ImportRow {
  sku?: string;
  name: string;
  brand?: string;
  category?: string;
  baseUom: string;
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
  qcRequired: boolean;
  costPrice?: number;
  lowStockThreshold?: number;
}

export function importProducts(db: DB, input: { fileName: string; csv: string }, actor: AuthUser) {
  if (!input.csv || input.csv.length > 4_000_000) {
    throw badRequest('IMPORT_FILE_INVALID', 'A CSV file up to 4 MB is required');
  }
  const parsed = parseCsv(input.csv.replace(/^\uFEFF/, ''));
  if (parsed.length < 2) throw badRequest('IMPORT_EMPTY', 'The CSV must contain a header row and at least one product');
  const header = parsed[0].map((cell) => cell.trim().toLowerCase());
  const required = ['name'];
  for (const field of required) {
    if (!header.includes(field)) throw badRequest('IMPORT_HEADER_INVALID', `CSV is missing required column '${field}'`);
  }
  const index = (name: string) => header.indexOf(name);
  const existingSkus = new Set(
    (db.prepare('SELECT sku FROM products').all() as Array<{ sku: string }>).map((row) => row.sku),
  );
  const seenSkus = new Set<string>();
  const errors: Array<{ row: number; message: string }> = [];
  const valid: ImportRow[] = [];

  for (let line = 1; line < parsed.length; line += 1) {
    const cells = parsed[line];
    const value = (column: string) => {
      const position = index(column);
      return position >= 0 ? (cells[position] ?? '').trim() : '';
    };
    const rowNo = line + 1;
    const name = value('name');
    if (!name) {
      errors.push({ row: rowNo, message: 'name is required' });
      continue;
    }
    const sku = value('sku').toUpperCase() || undefined;
    if (sku && !/^[A-Z0-9][A-Z0-9._-]{1,49}$/.test(sku)) {
      errors.push({ row: rowNo, message: `SKU '${sku}' must be 2-50 characters of letters, digits, dot, underscore or dash` });
      continue;
    }
    if (sku && (existingSkus.has(sku) || seenSkus.has(sku))) {
      errors.push({ row: rowNo, message: `SKU '${sku}' already exists; existing company SKUs are never replaced` });
      continue;
    }
    const baseUom = value('baseuom').toUpperCase() || 'PIECE';
    if (!UOMS.has(baseUom)) {
      errors.push({ row: rowNo, message: `baseUom '${baseUom}' is not supported` });
      continue;
    }
    const isBatchTracked = parseBoolean(value('isbatchtracked'));
    const isExpiryTracked = parseBoolean(value('isexpirytracked'));
    if (isExpiryTracked && !isBatchTracked) {
      errors.push({ row: rowNo, message: 'Expiry tracking requires batch tracking' });
      continue;
    }
    const costRaw = value('costprice');
    const costPrice = costRaw ? Number(costRaw) : undefined;
    if (costPrice !== undefined && (!Number.isFinite(costPrice) || costPrice < 0)) {
      errors.push({ row: rowNo, message: 'costPrice must be a non-negative number' });
      continue;
    }
    const lowRaw = value('lowstockthreshold');
    const lowStockThreshold = lowRaw ? Number(lowRaw) : undefined;
    if (
      lowStockThreshold !== undefined &&
      (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0)
    ) {
      errors.push({ row: rowNo, message: 'lowStockThreshold must be a non-negative whole number' });
      continue;
    }
    if (sku) seenSkus.add(sku);
    valid.push({
      sku,
      name,
      brand: value('brand') || undefined,
      category: value('category') || undefined,
      baseUom,
      isBatchTracked,
      isExpiryTracked,
      qcRequired: value('qcrequired') ? parseBoolean(value('qcrequired')) : true,
      costPrice,
      lowStockThreshold,
    });
  }

  const jobId = newId();
  const hash = createHash('sha256').update(input.csv).digest('hex');
  const now = nowIso();
  db.prepare(
    `INSERT INTO import_jobs
      (id, import_type, file_name, status, total_rows, valid_rows, invalid_rows, error_report_json, source_hash, created_by, created_at)
     VALUES (?, 'PRODUCTS', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    input.fileName.slice(0, 200),
    errors.length || !valid.length ? 'FAILED' : 'VALIDATED',
    parsed.length - 1,
    valid.length,
    errors.length,
    errors.length ? JSON.stringify(errors.slice(0, 500)) : null,
    hash,
    actor.id,
    now,
  );

  if (errors.length) {
    db.prepare('UPDATE import_jobs SET completed_at = ? WHERE id = ?').run(now, jobId);
    recordAudit(db, {
      eventType: 'IMPORT_VALIDATION_FAILED',
      entityType: 'IMPORT_JOB',
      entityId: jobId,
      outcome: 'FAILURE',
      after: { fileName: input.fileName, invalidRows: errors.length, validRows: valid.length },
      actor: { userId: actor.id, role: actor.role },
    });
    return { job: getImportJob(db, jobId), errors };
  }

  try {
    const created = withTransaction(db, () => {
      const skus: string[] = [];
      for (const row of valid) {
        skus.push(
          createProduct(
            db,
            {
              name: row.name,
              sku: row.sku,
              brand: row.brand,
              category: row.category,
              baseUom: row.baseUom as any,
              isBatchTracked: row.isBatchTracked,
              isExpiryTracked: row.isExpiryTracked,
              qcRequired: row.qcRequired,
              costPrice: row.costPrice,
              lowStockThreshold: row.lowStockThreshold,
            },
            actor,
          ),
        );
      }
      db.prepare("UPDATE import_jobs SET status = 'IMPORTED', completed_at = ? WHERE id = ?").run(nowIso(), jobId);
      recordAudit(db, {
        eventType: 'IMPORT_COMPLETED',
        entityType: 'IMPORT_JOB',
        entityId: jobId,
        after: { fileName: input.fileName, imported: skus.length },
        actor: { userId: actor.id, role: actor.role },
      });
      return skus;
    });
    return { job: getImportJob(db, jobId), createdProducts: created.length, errors: [] };
  } catch (error) {
    db.prepare("UPDATE import_jobs SET status = 'FAILED', completed_at = ?, error_report_json = ? WHERE id = ?").run(
      nowIso(),
      JSON.stringify([{ row: 0, message: (error as Error).message }]),
      jobId,
    );
    recordAudit(db, {
      eventType: 'IMPORT_FAILED',
      entityType: 'IMPORT_JOB',
      entityId: jobId,
      outcome: 'FAILURE',
      reason: (error as Error).message,
      actor: { userId: actor.id, role: actor.role },
    });
    return { job: getImportJob(db, jobId), errors: [{ row: 0, message: (error as Error).message }] };
  }
}

export async function importProductsWorkbook(
  db: DB,
  input: { fileName: string; contentBase64: string },
  actor: AuthUser,
) {
  const buffer = parseBase64File(input.contentBase64);
  const parsed = await parseWorkbook(buffer);
  const rowsOf = (sheetName: string) => parsed.sheets.find((sheet) => sheet.name.toLowerCase() === sheetName)?.rows;
  const headerContainsName = (rows: Array<Array<string | number | boolean | Date | null | undefined>>) =>
    rows.slice(0, 10).findIndex((row) => row.some((cell) => cellText(cell).toLowerCase() === 'name'));
  const sheet =
    rowsOf('products') ??
    parsed.sheets.find((entry) => headerContainsName(entry.rows) >= 0)?.rows;
  if (!sheet) throw badRequest('IMPORT_HEADER_INVALID', 'The workbook has no sheet with a "name" header column');
  const headerIndex = headerContainsName(sheet);
  if (headerIndex < 0) throw badRequest('IMPORT_HEADER_INVALID', 'The workbook has no sheet with a "name" header column');

  const lines: string[] = [];
  const dataRows = sheet.slice(headerIndex).filter((row) => rowHasData(row));
  if (dataRows.length < 2) throw badRequest('IMPORT_EMPTY', 'The sheet must contain a header row and at least one product');
  for (const row of dataRows) {
    const cells = row.map((cell) => (cell === null || cell === undefined ? '' : typeof cell === 'boolean' ? String(cell) : cellText(cell)));
    let last = cells.length - 1;
    while (last >= 0 && cells[last] === '') last -= 1;
    lines.push(cells.slice(0, last + 1).map(csvCell).join(','));
  }
  return importProducts(db, { fileName: input.fileName, csv: lines.join('\n') }, actor);
}

export interface ImportJob {
  id: string;
  import_type: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  error_report_json: string | null;
  summary_json: string | null;
  source_hash: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  products_since?: number;
  summary: unknown;
  errors: unknown;
  [key: string]: unknown;
}

export function getImportJob(db: DB, id: string): ImportJob {
  const row = db
    .prepare(
      `SELECT j.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM products p WHERE p.created_by = j.created_by AND p.created_at >= j.created_at) AS products_since
         FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by
        WHERE j.id = ?`,
    )
    .get<Record<string, unknown>>(id);
  if (!row) throw badRequest('IMPORT_JOB_NOT_FOUND', 'Import job not found');
  return {
    ...row,
    summary: row.summary_json ? JSON.parse(String(row.summary_json)) : null,
    errors: row.error_report_json ? JSON.parse(String(row.error_report_json)) : [],
  } as ImportJob;
}

export function listImportJobs(db: DB) {
  const rows = db
    .prepare(
      `SELECT j.*, u.name AS created_by_name FROM import_jobs j
         LEFT JOIN users u ON u.id = j.created_by
        ORDER BY j.created_at DESC LIMIT 100`,
    )
    .all() as Array<Record<string, any>>;
  return rows.map((row) => ({
    ...row,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
  }));
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function importIssuesCsv(db: DB, id: string): { fileName: string; csv: string } {
  const job = getImportJob(db, id);
  const issues = Array.isArray(job.errors) ? (job.errors as Array<Record<string, unknown>>) : [];
  const header = ['severity', 'code', 'sheet', 'row', 'box_id', 'sku', 'message'];
  const lines = [header.join(',')];
  for (const entry of issues) {
    lines.push(
      [
        entry.severity ?? 'ERROR',
        entry.code ?? 'ROW_ERROR',
        entry.sheet ?? '',
        entry.row ?? '',
        entry.boxId ?? '',
        entry.sku ?? '',
        entry.message ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const base = String(job.file_name ?? 'import')
    .replace(/\.(xlsx|csv)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 80);
  return { fileName: `${base || 'import'}-errors-${id.slice(0, 8)}.csv`, csv: `${lines.join('\n')}\n` };
}
