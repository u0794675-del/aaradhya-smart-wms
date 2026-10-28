import { createHash } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { newId, nextBoxCode, nextSku } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import {
  cellText,
  parseWorkbook,
  rawRowJson,
  rowHasData,
  type ParsedWorkbook,
  type WorkbookCell,
} from '../lib/workbook.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { getImportJob } from './imports.ts';
import { postMovement } from './inventory.ts';
import { ensureZoneLocation, parseBase64File } from './workbook-import.ts';

export interface StockListIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  sheet: string;
  row: number | null;
  message: string;
}

export interface StockListRow {
  sheet: string;
  rowNo: number;
  position: string | null;
  brand: string;
  productName: string;
  boxQuantity: number;
  qtyPerBox: number;
  confidence: string | null;
}

export interface StockListProduct {
  key: string;
  name: string;
  brand: string;
  rows: StockListRow[];
  boxes: number;
  units: number;
}

export interface StockListPlan {
  fileName: string;
  sourceHash: string;
  sheet: string;
  headerRow: number;
  zone: string;
  defaultBrand: string | null;
  rows: StockListRow[];
  products: StockListProduct[];
  rawRows: Array<{ sheet: string; rowNo: number; json: string }>;
  issues: StockListIssue[];
  dataRows: number;
}

export interface StockListSummary {
  source: {
    fileName: string;
    sheet: string;
    headerRow: number;
    zone: string;
    brand: string;
    rows: number;
    products: number;
    boxes: number;
    units: number;
  };
  products: { created: number };
  boxes: { created: number };
  declarations: { rows: number };
  postings: { transactions: number; units: number; byZone: Array<{ zone: string; boxes: number; units: number }> };
  verification: { needsVerification: number };
  duplicates: { products: number; rows: number };
  totals: { created: number; updated: number; skipped: number; failed: number; warnings: number };
  issues: { errors: number; warnings: number; byCode: Array<{ code: string; severity: string; count: number }> };
  committedAt?: string;
  committedBy?: { id: string; name: string };
}

export interface StockListImportInput {
  fileName: string;
  contentBase64: string;
  brand?: string;
  zone?: string;
  sheetName?: string;
}

export interface StockListImportResult {
  committed: boolean;
  job: ReturnType<typeof getImportJob>;
  summary: StockListSummary;
  issues: StockListIssue[];
  reconciliation?: { postedUnits: number; ledgerUnits: number; balanceUnits: number; ok: boolean };
}

const MAX_PRODUCTS = 2000;
const MAX_BOXES = 20_000;
const MAX_UNITS = 10_000_000;
const MAX_HEADER_SCAN = 15;

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseCount(cell: WorkbookCell): number | null {
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell : null;
  const text = cellText(cell).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

interface ColumnMap {
  product: number;
  boxQuantity: number;
  qtyPerBox: number;
  brand: number | null;
  confidence: number | null;
  position: number | null;
}

function headerColumns(row: WorkbookCell[]): ColumnMap | null {
  const cells = row.map((cell) => compact(cellText(cell)));
  const find = (predicate: (value: string) => boolean) => {
    const index = cells.findIndex((value) => value !== '' && predicate(value));
    return index >= 0 ? index : -1;
  };
  const product = find(
    (value) =>
      value.includes('productname') ||
      value === 'product' ||
      value === 'sku' ||
      value === 'products' ||
      (value.includes('product') && value.includes('name')),
  );
  const boxQuantity = find(
    (value) =>
      value.includes('boxquantity') ||
      value === 'boxqty' ||
      value.includes('noofboxes') ||
      value.includes('boxcount') ||
      value === 'boxes',
  );
  const qtyPerBox = find(
    (value) =>
      value.includes('qtyperbox') ||
      value.includes('unitsperbox') ||
      value.includes('piecesperbox') ||
      value.includes('perbox'),
  );
  if (product < 0 || boxQuantity < 0 || qtyPerBox < 0) return null;
  const optional = (predicate: (value: string) => boolean) => {
    const index = find(predicate);
    return index >= 0 ? index : null;
  };
  return {
    product,
    boxQuantity,
    qtyPerBox,
    brand: optional((value) => value === 'brand' || value === 'brandname'),
    confidence: optional((value) => value.includes('confidence')),
    position: optional((value) => value.includes('photo') || value === 'page' || value.includes('photopage')),
  };
}

function locateHeader(rows: WorkbookCell[][]): { rowIndex: number; columns: ColumnMap } | null {
  const limit = Math.min(rows.length, MAX_HEADER_SCAN);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const columns = headerColumns(rows[rowIndex] ?? []);
    if (columns) return { rowIndex, columns };
  }
  return null;
}

function zoneFromText(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /zone\s*[-_]?\s*([a-z0-9]+)/i.exec(value);
  if (!match) return null;
  return `Zone ${match[1].toUpperCase()}`;
}

export function analyzeStockList(
  parsed: ParsedWorkbook,
  input: { fileName?: string; sourceHash?: string; brand?: string; zone?: string; sheetName?: string } = {},
): StockListPlan {
  const fileName = (input.fileName ?? '').slice(0, 200);
  const defaultBrand = input.brand?.trim() ? input.brand.trim().slice(0, 100) : null;
  const issues: StockListIssue[] = [];
  const rawRows: Array<{ sheet: string; rowNo: number; json: string }> = [];
  const rows: StockListRow[] = [];
  const issue = (severity: StockListIssue['severity'], code: string, sheet: string, row: number | null, message: string) =>
    issues.push({ severity, code, sheet, row, message });

  const candidates = parsed.sheets
    .map((sheet) => {
      const header = locateHeader(sheet.rows);
      if (!header) return null;
      const preferred = input.sheetName ? sheet.name === input.sheetName : /combined|stock\s*list|inventory/i.test(sheet.name);
      return { sheet, header, preferred };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const chosen =
    (input.sheetName ? candidates.find((entry) => entry.sheet.name === input.sheetName) : undefined) ??
    candidates.find((entry) => entry.preferred) ??
    candidates[0] ??
    null;

  if (!chosen) {
    issue(
      'ERROR',
      'STOCK_LIST_SHEET_MISSING',
      input.sheetName ?? '',
      null,
      'No sheet has the stock list header row. Expected columns: Brand, Product Name / SKU, Box Quantity, Qty per Box.',
    );
    return {
      fileName,
      sourceHash: input.sourceHash ?? '',
      sheet: input.sheetName ?? '',
      headerRow: 0,
      zone: input.zone?.trim() || 'Zone B',
      defaultBrand,
      rows,
      products: [],
      rawRows,
      issues,
      dataRows: 0,
    };
  }

  const { sheet, header } = chosen;
  const { columns, rowIndex } = header;
  const zone =
    input.zone?.trim().slice(0, 50) ||
    zoneFromText(fileName) ||
    zoneFromText(sheet.name) ||
    'Zone B';

  for (let index = rowIndex + 1; index < sheet.rows.length; index += 1) {
    const row = sheet.rows[index] ?? [];
    if (!rowHasData(row)) continue;
    const rowNo = index + 1;
    const rawPosition = columns.position === null ? '' : cellText(row[columns.position]);
    const brand = (columns.brand === null ? '' : cellText(row[columns.brand])) || defaultBrand || '';
    const name = cellText(row[columns.product]);
    const boxCell = row[columns.boxQuantity];
    const perBoxCell = row[columns.qtyPerBox];
    const confidence = columns.confidence === null ? null : cellText(row[columns.confidence]) || null;

    rawRows.push({ sheet: sheet.name, rowNo, json: rawRowJson(row) });

    if (!name) continue;
    if (compact(name) === compact(cellText(sheet.rows[rowIndex][columns.product]))) continue;
    if (/^(grand\s*)?total|subtotal$/i.test(name)) {
      issue('WARNING', 'TOTAL_ROW_IGNORED', sheet.name, rowNo, `Row "${name}" looks like a total row and was not treated as stock.`);
      continue;
    }
    if (!brand) {
      issue('ERROR', 'MISSING_BRAND', sheet.name, rowNo, `"${name}" has no brand. Add a Brand value or choose a default brand before importing.`);
      continue;
    }
    const boxQuantity = parseCount(boxCell);
    if (boxQuantity === null || boxQuantity < 1 || boxQuantity > 5000) {
      issue('ERROR', 'INVALID_BOX_QUANTITY', sheet.name, rowNo, `"${name}" has Box Quantity "${cellText(boxCell)}"; expected a whole number from 1 to 5000.`);
      continue;
    }
    const qtyPerBox = parseCount(perBoxCell);
    if (qtyPerBox === null || qtyPerBox < 1 || qtyPerBox > 1_000_000) {
      issue('ERROR', 'INVALID_QTY_PER_BOX', sheet.name, rowNo, `"${name}" has Qty per Box "${cellText(perBoxCell)}"; expected a positive whole number.`);
      continue;
    }
    rows.push({
      sheet: sheet.name,
      rowNo,
      position: rawPosition || null,
      brand: brand.slice(0, 100),
      productName: name.slice(0, 200),
      boxQuantity,
      qtyPerBox,
      confidence: confidence?.slice(0, 50) ?? null,
    });
  }

  const byKey = new Map<string, StockListProduct>();
  for (const row of rows) {
    const key = `${row.brand.toLowerCase()}|${row.productName.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.boxes += row.boxQuantity;
      existing.units += row.boxQuantity * row.qtyPerBox;
    } else {
      byKey.set(key, {
        key,
        name: row.productName,
        brand: row.brand,
        rows: [row],
        boxes: row.boxQuantity,
        units: row.boxQuantity * row.qtyPerBox,
      });
    }
  }
  const products = [...byKey.values()];
  const duplicateProducts = products.filter((product) => product.rows.length > 1);
  for (const product of duplicateProducts) {
    const quantities = [...new Set(product.rows.map((row) => row.qtyPerBox))].sort((a, b) => a - b);
    issue(
      'WARNING',
      'DUPLICATE_PRODUCT',
      sheet.name,
      product.rows[0].rowNo,
      `"${product.name}" appears on ${product.rows.length} rows; all boxes are kept for one SKU.`,
    );
    if (quantities.length > 1) {
      issue(
        'WARNING',
        'QTY_PER_BOX_VARIES',
        sheet.name,
        product.rows[0].rowNo,
        `"${product.name}" declares different units per box (${quantities.join(', ')}); each source row keeps its own declared quantity and needs physical verification.`,
      );
    }
  }

  const totalBoxes = products.reduce((sum, product) => sum + product.boxes, 0);
  const totalUnits = products.reduce((sum, product) => sum + product.units, 0);
  if (products.length > MAX_PRODUCTS) {
    issue('ERROR', 'TOO_MANY_PRODUCTS', sheet.name, null, `The stock list has ${products.length} products; the limit is ${MAX_PRODUCTS} per import.`);
  }
  if (totalBoxes > MAX_BOXES) {
    issue('ERROR', 'TOO_MANY_BOXES', sheet.name, null, `The stock list creates ${totalBoxes} boxes; the limit is ${MAX_BOXES} per import.`);
  }
  if (totalUnits > MAX_UNITS) {
    issue('ERROR', 'TOO_MANY_UNITS', sheet.name, null, `The stock list declares ${totalUnits} units; the limit is ${MAX_UNITS} per import.`);
  }

  return {
    fileName,
    sourceHash: input.sourceHash ?? '',
    sheet: sheet.name,
    headerRow: rowIndex + 1,
    zone,
    defaultBrand,
    rows,
    products,
    rawRows,
    issues,
    dataRows: rows.length,
  };
}

function planBrand(plan: StockListPlan): string {
  const brands = [...new Set(plan.products.map((product) => product.brand))];
  if (brands.length === 1) return brands[0];
  if (brands.length === 0) return plan.defaultBrand ?? '';
  return 'MIXED';
}

export function summarizeStockListPlan(plan: StockListPlan): StockListSummary {
  const boxes = plan.products.reduce((sum, product) => sum + product.boxes, 0);
  const units = plan.products.reduce((sum, product) => sum + product.units, 0);
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  const warnings = plan.issues.filter((entry) => entry.severity === 'WARNING');
  const byCode = new Map<string, { code: string; severity: string; count: number }>();
  for (const entry of plan.issues) {
    const existing = byCode.get(entry.code);
    if (existing) existing.count += 1;
    else byCode.set(entry.code, { code: entry.code, severity: entry.severity, count: 1 });
  }
  const byZone = new Map<string, { zone: string; boxes: number; units: number }>();
  const zone = byZone.get(plan.zone) ?? { zone: plan.zone, boxes: 0, units: 0 };
  zone.boxes += boxes;
  zone.units += units;
  byZone.set(plan.zone, zone);
  return {
    source: {
      fileName: plan.fileName,
      sheet: plan.sheet,
      headerRow: plan.headerRow,
      zone: plan.zone,
      brand: planBrand(plan),
      rows: plan.dataRows,
      products: plan.products.length,
      boxes,
      units,
    },
    products: { created: plan.products.length },
    boxes: { created: boxes },
    declarations: { rows: boxes },
    postings: { transactions: boxes, units, byZone: [...byZone.values()] },
    verification: { needsVerification: plan.products.length + boxes },
    duplicates: {
      products: plan.products.filter((product) => product.rows.length > 1).length,
      rows: plan.products.reduce((sum, product) => sum + Math.max(0, product.rows.length - 1), 0),
    },
    totals: {
      created: plan.products.length + boxes,
      updated: 0,
      skipped: 0,
      failed: errors.length,
      warnings: warnings.length,
    },
    issues: {
      errors: errors.length,
      warnings: warnings.length,
      byCode: [...byCode.values()],
    },
  };
}

function createJob(db: DB, plan: StockListPlan, status: 'VALIDATED' | 'FAILED', actor: AuthUser): string {
  const jobId = newId();
  const summary = summarizeStockListPlan(plan);
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  const invalidRows = new Set(errors.map((entry) => `${entry.sheet}|${entry.row ?? ''}`)).size;
  const now = nowIso();
  db.prepare(
    `INSERT INTO import_jobs
      (id, import_type, file_name, status, total_rows, valid_rows, invalid_rows,
       error_report_json, source_hash, created_by, created_at, completed_at, summary_json)
     VALUES (?, 'STOCK_LIST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    plan.fileName || 'stock-list.xlsx',
    status,
    plan.dataRows + invalidRows,
    plan.dataRows,
    invalidRows,
    JSON.stringify(plan.issues.slice(0, 1000)),
    plan.sourceHash || null,
    actor.id,
    now,
    status === 'FAILED' ? now : null,
    JSON.stringify(summary),
  );
  recordAudit(db, {
    eventType: status === 'FAILED' ? 'IMPORT_VALIDATION_FAILED' : 'IMPORT_VALIDATED',
    entityType: 'IMPORT_JOB',
    entityId: jobId,
    outcome: status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
    after: {
      fileName: plan.fileName,
      sourceHash: plan.sourceHash,
      importType: 'STOCK_LIST',
      products: plan.products.length,
      boxes: summary.source.boxes,
      units: summary.source.units,
      brand: summary.source.brand,
      zone: plan.zone,
      errors: summary.issues.errors,
      warnings: summary.issues.warnings,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return jobId;
}

function findExistingStockListImport(db: DB, hash: string): { id: string } | undefined {
  if (!hash) return undefined;
  return db
    .prepare("SELECT id FROM import_jobs WHERE import_type = 'STOCK_LIST' AND source_hash = ? AND status = 'IMPORTED'")
    .get(hash) as { id: string } | undefined;
}

function commitPlan(
  db: DB,
  plan: StockListPlan,
  jobId: string,
  actor: AuthUser,
  warehouseId: string,
  poolId: string,
): { boxEntityIds: string[]; units: number } {
  const createdAt = nowIso();
  const location = ensureZoneLocation(db, warehouseId, plan.zone);

  const productInsert = db.prepare(
    `INSERT INTO products
      (id, sku, name, brand, base_uom, is_batch_tracked, is_expiry_tracked, qc_required,
       status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PIECE', 0, 0, 1, 'ACTIVE', ?, ?, ?)`,
  );
  const barcodeInsert = db.prepare(
    `INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
     VALUES (?, ?, ?, 'INTERNAL', 1, ?)`,
  );
  const sourceInsert = db.prepare(
    `INSERT INTO product_sources
      (product_id, source_sku, source_name, source_product_key, source_brand, source_pool,
       source_created_from, source_verification, source_notes, verification_status,
       source_file, source_sheet, source_row_no, import_job_id, created_at)
     VALUES (?, NULL, ?, ?, ?, 'B2B', 'STOCK_LIST', ?, ?, 'NEEDS_VERIFICATION', ?, ?, ?, ?, ?)`,
  );
  const boxInsert = db.prepare(
    `INSERT INTO boxes
      (id, box_code, box_type, status, warehouse_id, location_id, pool_id, created_by, created_at, notes)
     VALUES (?, ?, 'SINGLE', 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
  );
  const boxSourceInsert = db.prepare(
    `INSERT INTO box_sources
      (box_id, source_box_id, source_brand, source_zone, source_box_quantity, source_status,
       source_box_type, source_reference, transcription_confidence, source_notes,
       verification_status, source_sheet, source_row_no, import_job_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 'SINGLE', ?, ?, ?, 'NEEDS_VERIFICATION', ?, ?, ?, ?)`,
  );
  const declarationInsert = db.prepare(
    `INSERT INTO box_content_declarations
      (id, box_id, product_id, declared_quantity, unit_label, source_box_type, source_page,
       transcription_confidence, verification_notes, verification_status, conflict_flag,
       source_row_no, import_job_id, created_at)
     VALUES (?, ?, ?, ?, 'PIECE', 'SINGLE', ?, ?, ?, 'NEEDS_VERIFICATION', 0, ?, ?, ?)`,
  );
  const rawInsert = db.prepare(
    `INSERT INTO workbook_source_rows (id, import_job_id, sheet_name, row_no, row_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const productIds = new Map<string, string>();
  const rowProduct = new Map<StockListRow, string>();
  for (const product of plan.products) {
    const sku = nextSku(db);
    const id = newId();
    productIds.set(product.key, id);
    productInsert.run(id, sku, product.name, product.brand, actor.id, createdAt, createdAt);
    barcodeInsert.run(newId(), id, sku, createdAt);
    const first = product.rows[0];
    sourceInsert.run(
      id,
      product.name,
      product.key,
      product.brand,
      first.confidence,
      'Stock list transcription; physical verification required before sellable use',
      plan.fileName || 'stock-list.xlsx',
      first.sheet,
      first.rowNo,
      jobId,
      createdAt,
    );
    for (const row of product.rows) rowProduct.set(row, id);
  }

  const shortJob = jobId.slice(0, 8);
  const boxEntityIds: string[] = [];
  let units = 0;
  for (const row of plan.rows) {
    const productId = rowProduct.get(row)!;
    for (let copy = 1; copy <= row.boxQuantity; copy += 1) {
      const boxCode = nextBoxCode(db, 'SINGLE');
      const boxId = newId();
      boxEntityIds.push(boxId);
      units += row.qtyPerBox;
      boxInsert.run(
        boxId,
        boxCode,
        warehouseId,
        location.id,
        poolId,
        actor.id,
        createdAt,
        `Stock list ${plan.sheet} row ${row.rowNo}`,
      );
      boxSourceInsert.run(
        boxId,
        `SL-${shortJob}-${row.rowNo}-${copy}`,
        row.brand,
        plan.zone,
        row.boxQuantity,
        row.position,
        row.confidence,
        `Transcribed from ${row.sheet} row ${row.rowNo}; verify boxes and counts physically`,
        row.sheet,
        row.rowNo,
        jobId,
        createdAt,
      );
      declarationInsert.run(
        newId(),
        boxId,
        productId,
        row.qtyPerBox,
        row.position,
        row.confidence,
        `Declared ${row.qtyPerBox} units per box from ${row.sheet} row ${row.rowNo}`,
        row.rowNo,
        jobId,
        createdAt,
      );
      postMovement(db, {
        movementType: 'MIGRATION',
        productId,
        quantity: row.qtyPerBox,
        to: {
          warehouseId,
          locationId: location.id,
          poolId,
          status: 'AVAILABLE',
          boxId,
        },
        referenceType: 'STOCK_LIST_IMPORT',
        referenceId: jobId,
        referenceNo: (plan.fileName || 'stock-list.xlsx').slice(0, 200),
        reason: `Opening stock from stock list ${row.sheet} row ${row.rowNo}; quantity requires physical verification`,
        metadata: {
          sourceSheet: row.sheet,
          sourceRow: row.rowNo,
          sourcePosition: row.position,
          sourceBoxQuantity: row.boxQuantity,
          sourceQtyPerBox: row.qtyPerBox,
          confidence: row.confidence,
          zone: plan.zone,
          verification: 'NEEDS_VERIFICATION',
        },
        user: actor,
      });
    }
  }

  for (const raw of plan.rawRows) {
    rawInsert.run(newId(), jobId, raw.sheet, raw.rowNo, raw.json, createdAt);
  }

  return { boxEntityIds, units };
}

function reconcile(db: DB, jobId: string, boxEntityIds: string[], postedUnits: number): StockListImportResult['reconciliation'] {
  const ledger = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_transactions WHERE reference_type = 'STOCK_LIST_IMPORT' AND reference_id = ?")
    .get(jobId) as { n: number };
  let balanceUnits = 0;
  for (let offset = 0; offset < boxEntityIds.length; offset += 400) {
    const chunk = boxEntityIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const row = db
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_balances WHERE box_id IN (${placeholders})`)
      .get(...chunk) as { n: number };
    balanceUnits += Number(row.n);
  }
  return {
    postedUnits,
    ledgerUnits: Number(ledger.n),
    balanceUnits,
    ok: postedUnits === Number(ledger.n) && postedUnits === balanceUnits,
  };
}

export function importAnalyzedStockList(
  db: DB,
  plan: StockListPlan,
  actor: AuthUser,
  dryRun: boolean,
): StockListImportResult {
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  if (errors.length > 0) {
    const jobId = createJob(db, plan, 'FAILED', actor);
    return {
      committed: false,
      job: getImportJob(db, jobId),
      summary: summarizeStockListPlan(plan),
      issues: plan.issues,
    };
  }
  if (plan.rows.length === 0) {
    throw badRequest('STOCK_LIST_EMPTY', 'The stock list has no data rows with a product name, box quantity and units per box');
  }
  const existing = findExistingStockListImport(db, plan.sourceHash);
  if (existing) {
    throw conflict('DUPLICATE_IMPORT', `This stock list was already imported as job ${existing.id}`, { jobId: existing.id });
  }
  if (dryRun) {
    const jobId = createJob(db, plan, 'VALIDATED', actor);
    return {
      committed: false,
      job: getImportJob(db, jobId),
      summary: summarizeStockListPlan(plan),
      issues: plan.issues,
    };
  }

  const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string } | undefined;
  if (!warehouse) throw badRequest('WAREHOUSE_NOT_CONFIGURED', 'The main warehouse WH1 is not configured');
  const pool = db.prepare("SELECT id FROM stock_pools WHERE code = 'B2B'").get() as { id: string } | undefined;
  if (!pool) throw badRequest('POOL_NOT_CONFIGURED', 'The B2B stock pool is not configured');

  const jobId = createJob(db, plan, 'VALIDATED', actor);
  try {
    const committed = withTransaction(db, () => {
      const result = commitPlan(db, plan, jobId, actor, warehouse.id, pool.id);
      const summary: StockListSummary = {
        ...summarizeStockListPlan(plan),
        committedAt: nowIso(),
        committedBy: { id: actor.id, name: actor.name },
      };
      db.prepare(
        "UPDATE import_jobs SET status = 'IMPORTED', completed_at = ?, summary_json = ?, invalid_rows = 0 WHERE id = ?",
      ).run(nowIso(), JSON.stringify(summary), jobId);
      recordAudit(db, {
        eventType: 'IMPORT_COMPLETED',
        entityType: 'IMPORT_JOB',
        entityId: jobId,
        after: {
          fileName: plan.fileName,
          sourceHash: plan.sourceHash,
          importType: 'STOCK_LIST',
          brand: summary.source.brand,
          zone: plan.zone,
          products: plan.products.length,
          boxes: result.boxEntityIds.length,
          units: result.units,
        },
        actor: { userId: actor.id, role: actor.role },
      });
      return result;
    });
    return {
      committed: true,
      job: getImportJob(db, jobId),
      summary: summarizeStockListPlan(plan),
      issues: plan.issues,
      reconciliation: reconcile(db, jobId, committed.boxEntityIds, committed.units),
    };
  } catch (error) {
    const message = (error as Error).message;
    db.prepare("UPDATE import_jobs SET status = 'FAILED', completed_at = ?, error_report_json = ? WHERE id = ?").run(
      nowIso(),
      JSON.stringify([
        ...plan.issues.slice(0, 999),
        { severity: 'ERROR', code: 'IMPORT_FAILED', sheet: plan.sheet, row: null, message },
      ]),
      jobId,
    );
    recordAudit(db, {
      eventType: 'IMPORT_FAILED',
      entityType: 'IMPORT_JOB',
      entityId: jobId,
      outcome: 'FAILURE',
      reason: message,
      actor: { userId: actor.id, role: actor.role },
    });
    throw error;
  }
}

export async function importStockList(
  db: DB,
  input: StockListImportInput,
  actor: AuthUser,
  options: { dryRun?: boolean; parsed?: ParsedWorkbook; hash?: string } = {},
): Promise<StockListImportResult> {
  const buffer = parseBase64File(input.contentBase64);
  const hash = options.hash ?? createHash('sha256').update(buffer).digest('hex');
  const parsed = options.parsed ?? (await parseWorkbook(buffer));
  const plan = analyzeStockList(parsed, {
    fileName: input.fileName,
    sourceHash: hash,
    brand: input.brand,
    zone: input.zone,
    sheetName: input.sheetName,
  });
  return importAnalyzedStockList(db, plan, actor, options.dryRun === true);
}
