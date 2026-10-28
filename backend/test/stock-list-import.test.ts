import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import ExcelJS from 'exceljs';
import { createHarness, type Harness } from './helpers.ts';
import type { ParsedWorkbook, WorkbookCell } from '../src/lib/workbook.ts';
import {
  analyzeStockList,
  importAnalyzedStockList,
  summarizeStockListPlan,
} from '../src/services/stock-list-import.ts';
import { bulkDelete } from '../src/services/bulk-delete.ts';
import { createProduct } from '../src/services/products.ts';
import { createEmptyBox } from '../src/services/inventory.ts';
import { newId } from '../src/lib/ids.ts';
import { nowIso } from '../src/lib/time.ts';
import type { AuthUser } from '../src/services/auth.ts';

const HEADERS = ['Photo/Page', 'Brand', 'Product Name / SKU', 'Box Quantity', 'Qty per Box', 'Transcription Confidence'];

function stockBook(rows: WorkbookCell[][], sheetName = 'Zone B Combined'): ParsedWorkbook {
  return {
    sheets: [{ name: sheetName, rows: [['Zone B stock list'], ['Transcribed from photographs'], HEADERS, ...rows] }],
    sheetNames: [sheetName],
  };
}

let harness: Harness;
let actor: AuthUser;

before(async () => {
  harness = await createHarness();
  const row = harness.db
    .prepare("SELECT id, employee_code, name, email, role_code FROM users WHERE email = 'admin@aaradhya.local'")
    .get() as any;
  actor = {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    role: row.role_code,
    permissions: ['*'],
  };
});

after(async () => {
  await harness.close();
});

test('analyzes a brand stock list, merges duplicate names and keeps every declared box', () => {
  const plan = analyzeStockList(
    stockBook([
      ['Photo 1 - Page 1', 'Allen', 'Allen A01', 2, 144, 'Medium'],
      ['Photo 1 - Page 2', 'Allen', 'Allen A01', 1, 108, 'Low'],
      ['Photo 1 - Page 2', 'Allen', 'Allen A02', 3, 24, 'High'],
    ]),
    { fileName: 'Allen_Zone_B.xlsx', sourceHash: 'hash-analyze' },
  );
  const summary = summarizeStockListPlan(plan);
  assert.equal(plan.zone, 'Zone B');
  assert.equal(plan.headerRow, 3);
  assert.equal(plan.rows.length, 3);
  assert.equal(summary.source.products, 2);
  assert.equal(summary.source.boxes, 6);
  assert.equal(summary.source.units, 2 * 144 + 108 + 3 * 24);
  assert.equal(summary.source.brand, 'Allen');
  assert.equal(summary.issues.errors, 0, JSON.stringify(plan.issues));
  assert.ok(plan.issues.some((entry) => entry.code === 'DUPLICATE_PRODUCT'));
  assert.ok(plan.issues.some((entry) => entry.code === 'QTY_PER_BOX_VARIES'));
  assert.equal(summary.duplicates.products, 1);
  assert.equal(summary.verification.needsVerification, 8);
});

test('rejects a stock list with invalid quantities or a missing brand without writing stock', () => {
  const plan = analyzeStockList(
    stockBook([
      ['Photo 1', '', 'No brand product', 1, 12, 'Low'],
      ['Photo 1', 'Broken Brand', 'Zero boxes', 0, 12, 'Low'],
      ['Photo 1', 'Broken Brand', 'Text quantity', 2, 'many', 'Low'],
    ]),
    { fileName: 'broken.xlsx', sourceHash: 'hash-broken' },
  );
  const result = importAnalyzedStockList(harness.db, plan, actor, false);
  assert.equal(result.committed, false);
  assert.equal(result.job.status, 'FAILED');
  assert.equal(result.summary.issues.errors, 3);
  const products = harness.db.prepare("SELECT COUNT(*) AS n FROM products WHERE brand LIKE 'Broken%' OR name = 'No brand product'").get() as {
    n: number;
  };
  assert.equal(products.n, 0);
});

test('commits a zone stock list as one MIGRATION opening-stock posting per box', () => {
  const plan = analyzeStockList(
    stockBook([
      ['Photo 1', 'SynthBrand', 'Synth A01', 2, 144, 'Medium'],
      ['Photo 1', 'SynthBrand', 'Synth A02', 2, 6, 'High'],
      ['Photo 2', 'SynthBrand', 'Synth A02', 1, 6, 'Low'],
    ]),
    { fileName: 'Synth_Zone_C.xlsx', sourceHash: 'hash-commit', zone: 'Zone C' },
  );
  const result = importAnalyzedStockList(harness.db, plan, actor, false);
  assert.equal(result.committed, true);
  assert.equal(result.job.status, 'IMPORTED');
  assert.deepEqual(result.reconciliation, {
    postedUnits: 2 * 144 + 3 * 6,
    ledgerUnits: 2 * 144 + 3 * 6,
    balanceUnits: 2 * 144 + 3 * 6,
    ok: true,
  });

  const products = harness.db
    .prepare("SELECT COUNT(*) AS n FROM products WHERE brand = 'SynthBrand'")
    .get() as { n: number };
  assert.equal(products.n, 2);
  const boxes = harness.db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(b.status) AS status, MIN(l.code) AS location, MIN(p.code) AS pool
         FROM boxes b JOIN locations l ON l.id = b.location_id JOIN stock_pools p ON p.id = b.pool_id
        WHERE b.notes LIKE 'Stock list%'`,
    )
    .get() as { n: number; status: string; location: string; pool: string };
  assert.equal(boxes.n, 5);
  assert.equal(boxes.status, 'ACTIVE');
  assert.equal(boxes.location, 'ZONE-C-UNASSIGNED');
  assert.equal(boxes.pool, 'B2B');
  const provenance = harness.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM product_sources WHERE source_created_from = 'STOCK_LIST') AS product_sources,
              (SELECT COUNT(*) FROM box_sources WHERE import_job_id = ?) AS box_sources,
              (SELECT COUNT(*) FROM box_content_declarations WHERE import_job_id = ?) AS declarations,
              (SELECT COUNT(*) FROM workbook_source_rows WHERE import_job_id = ?) AS raw_rows`,
    )
    .get(result.job.id, result.job.id, result.job.id) as Record<string, number>;
  assert.equal(provenance.product_sources, 2);
  assert.equal(provenance.box_sources, 5);
  assert.equal(provenance.declarations, 5);
  assert.equal(provenance.raw_rows, 3);
  const movements = harness.db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(quantity) AS units, MIN(movement_type) AS type
         FROM inventory_transactions WHERE reference_type = 'STOCK_LIST_IMPORT' AND reference_id = ?`,
    )
    .get(result.job.id) as { n: number; units: number; type: string };
  assert.equal(movements.n, 5);
  assert.equal(movements.units, 2 * 144 + 3 * 6);
  assert.equal(movements.type, 'MIGRATION');
  const verification = harness.db
    .prepare("SELECT COUNT(*) AS n FROM box_sources WHERE verification_status <> 'NEEDS_VERIFICATION'")
    .get() as { n: number };
  assert.equal(verification.n, 0);

  assert.throws(
    () => importAnalyzedStockList(harness.db, plan, actor, false),
    (error: any) => error.code === 'DUPLICATE_IMPORT',
  );
});

test('bulk delete removes only records without stock, movements or provenance', () => {
  const emptyId = createProduct(harness.db, { name: 'Bulk delete probe', baseUom: 'PIECE' }, actor);
  const stocked = harness.db.prepare("SELECT id FROM products WHERE brand = 'SynthBrand' ORDER BY sku LIMIT 1").get() as { id: string };
  const products = bulkDelete(harness.db, 'products', [emptyId, stocked.id], actor);
  assert.deepEqual(products.deleted, [emptyId]);
  assert.equal(products.skipped.length, 1);
  assert.match(products.skipped[0].reason, /inventory_balances/);

  const warehouse = harness.db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
  const location = harness.db.prepare('SELECT id FROM locations ORDER BY code LIMIT 1').get() as { id: string };
  const pool = harness.db.prepare("SELECT id FROM stock_pools WHERE code = 'B2B'").get() as { id: string };
  const emptyBox = createEmptyBox(harness.db, {
    boxType: 'SINGLE',
    warehouseId: warehouse.id,
    locationId: location.id,
    poolId: pool.id,
    user: actor,
    notes: 'bulk delete probe',
  });
  const emptyBoxId = emptyBox.id;
  const stockedBox = harness.db.prepare('SELECT id FROM boxes WHERE notes LIKE \'Stock list%\' LIMIT 1').get() as { id: string };
  const boxes = bulkDelete(harness.db, 'boxes', [emptyBoxId, stockedBox.id], actor);
  assert.deepEqual(boxes.deleted, [emptyBoxId]);
  assert.equal(boxes.skipped.length, 1);
  assert.match(boxes.skipped[0].reason, /inventory_balances/);

  const importedJob = harness.db
    .prepare("SELECT id FROM import_jobs WHERE import_type = 'STOCK_LIST' AND status = 'IMPORTED' LIMIT 1")
    .get() as { id: string };
  const emptyJobId = newId();
  harness.db
    .prepare(
      `INSERT INTO import_jobs (id, import_type, file_name, status, total_rows, valid_rows, invalid_rows, created_by, created_at, completed_at)
       VALUES (?, 'PRODUCTS', 'empty-job.csv', 'FAILED', 0, 0, 0, ?, ?, ?)`,
    )
    .run(emptyJobId, actor.id, nowIso(), nowIso());
  const jobs = bulkDelete(harness.db, 'import_jobs', [emptyJobId, importedJob.id], actor);
  assert.deepEqual(jobs.deleted, [emptyJobId]);
  assert.equal(jobs.skipped.length, 1);
  assert.match(jobs.skipped[0].reason, /product_sources/);
  const audits = harness.db
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type IN ('PRODUCT_BULK_DELETED','BOX_BULK_DELETED','IMPORT_JOB_BULK_DELETED')")
    .get() as { n: number };
  assert.equal(audits.n, 3);
});

test('templates download as real xlsx workbooks and the product importer accepts xlsx', async () => {
  const client = await harness.client();
  const productTemplate = await client.binary('GET', '/api/imports/products/template.xlsx');
  assert.equal(productTemplate.status, 200);
  assert.match(String(productTemplate.headers.get('content-type')), /spreadsheetml/);
  assert.equal(productTemplate.body.subarray(0, 2).toString(), 'PK');
  const stockTemplate = await client.binary('GET', '/api/imports/stock-list/template.xlsx');
  assert.equal(stockTemplate.status, 200);
  assert.equal(stockTemplate.body.subarray(0, 2).toString(), 'PK');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['name', 'sku', 'brand', 'category', 'baseuom', 'isbatchtracked', 'isexpirytracked', 'qcrequired']);
  sheet.addRow(['Xlsx Probed Product', 'XLSX-PROBE-1', 'ProbeBrand', 'Test', 'PIECE', false, false, true]);
  const buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
  const response = await client.post('/api/imports/products', {
    fileName: 'products.xlsx',
    contentBase64: buffer.toString('base64'),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.createdProducts, 1);
  const created = harness.db.prepare("SELECT id FROM products WHERE sku = 'XLSX-PROBE-1'").get() as { id: string };
  assert.ok(created.id);
  const removed = await client.post('/api/products/bulk-delete', { ids: [created.id], reason: 'test cleanup' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.data.deleted, [created.id]);
});
