import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createHarness, type Harness } from './helpers.ts';
import { WORKBOOK_SHEETS, type ParsedSheet, type ParsedWorkbook, type WorkbookCell } from '../src/lib/workbook.ts';
import {
  analyzeWorkbook,
  importAnalyzedWorkbook,
  summarizeWorkbookPlan,
} from '../src/services/workbook-import.ts';
import { importIssuesCsv } from '../src/services/imports.ts';
import { createProduct } from '../src/services/products.ts';
import type { AuthUser } from '../src/services/auth.ts';
import { nextSku } from '../src/lib/ids.ts';

const MASTER_HEADERS = [
  'Master SKU', 'Brand', 'Product Name / Source SKU', 'Source Brand + Product Key', 'Category',
  'Stock Pool', 'Active?', 'Barcode Value', 'Created From', 'Verification Status', 'Notes',
];
const REGISTER_HEADERS = [
  'Box ID', 'Barcode Value', 'Stock Pool', 'Brand', 'Zone', 'Rack', 'Bin / Location', 'Box Type',
  'Box Qty (physical boxes)', 'Status', 'Current Location Key', 'Source Page',
  'Transcription Confidence', 'Verification Status', 'Notes',
];
const CONTENTS_HEADERS = [
  'Box ID', 'Master SKU', 'Brand', 'Product Name / Source SKU', 'Qty per Box (units)',
  'Quantity Unit', 'Box Type', 'Source Page', 'Transcription Confidence', 'Verification Notes',
];
const UNITS_HEADERS = [
  'Box ID', 'Master SKU', 'Brand', 'Product Name', 'Units per Box', 'Opening Units',
  'Picked Units', 'Current Units', 'Status', 'Last Transaction', 'Last Updated', 'Notes',
];
const STOCK_HEADERS = [
  'Box ID', 'Master SKU(s)', 'Brand', 'Product / Contents Summary', 'Stock Pool', 'Zone', 'Rack',
  'Bin / Location', 'Opening Box Qty', 'Picked Box Qty', 'Dispatched Box Qty', 'Current Box Qty',
  'Status', 'Last Verified', 'Notes',
];
const MAPPING_HEADERS = ['Original / Source Box ID', 'New Box ID', 'Rule / Note'];

function tab(name: string, headers: string[], rows: WorkbookCell[][]): ParsedSheet {
  return { name, rows: [[name], ['Synthetic fixture'], headers, ...rows] };
}

function master(sku: string, brand: string, name: string, pool = 'B2B'): WorkbookCell[] {
  return [sku, brand, name, `${brand} | ${name}`, 'Test', pool, 'Yes', sku, 'Fixture', 'Needs Verification', 'Verify'];
}

function register(
  boxId: string,
  brand: string,
  zone: string,
  type: string,
  pool = 'B2B',
  source: { barcode?: string | null; rack?: string | null; bin?: string | null } = {},
): WorkbookCell[] {
  const barcode = source.barcode === undefined ? boxId : source.barcode;
  return [
    boxId,
    barcode,
    pool,
    brand,
    zone,
    source.rack ?? 'R-01',
    source.bin ?? 'B-01',
    type,
    1,
    'In Stock',
    `${zone}--`,
    'Fixture',
    'Medium',
    'Needs Verification',
    'Verify box',
  ];
}

function contents(boxId: string, sku: string, brand: string, qty: number | null): WorkbookCell[] {
  return [boxId, sku, brand, `${brand} product`, qty, 'Units per box', 'Single SKU', 'Fixture', 'Medium', 'Verify quantity'];
}

function units(
  boxId: string,
  sku: string,
  brand: string,
  perBox: number,
  current: number,
  status = current > 0 ? 'In Stock' : 'Out of Stock',
): WorkbookCell[] {
  return [boxId, sku, brand, `${brand} product`, perBox, perBox, perBox - current, current, status, null, null, 'Verify'];
}

function stock(boxId: string, brand: string, zone: string, currentBoxQty: number): WorkbookCell[] {
  return [boxId, '', brand, '', 'B2B', zone, null, null, 1, 0, 0, currentBoxQty, 'In Stock', null, 'Verify'];
}

function mapping(source: string, target: string, note = 'Sequential BOX ID'): WorkbookCell[] {
  return [source, target, note];
}

function workbook(overrides: Partial<Record<string, WorkbookCell[][]>> = {}): ParsedWorkbook {
  const sheets: ParsedSheet[] = [
    tab(WORKBOOK_SHEETS.MASTER, MASTER_HEADERS, overrides.master ?? [
      master('AHP0001', 'Allen', 'Allen A58'),
      master('AHP0002', 'Allen', 'Allen A30'),
      master('AHP0003', 'Dabur', 'Dabur Cough Syrup'),
    ]),
    tab(WORKBOOK_SHEETS.REGISTER, REGISTER_HEADERS, overrides.register ?? [
      register('BOX-001', 'Allen', 'Zone B', 'Single SKU'),
      register('BOX-002', 'Allen', 'Zone B', 'Mixed SKU'),
      register('BOX-003', 'Allen', 'Zone B', 'Single SKU'),
    ]),
    tab(WORKBOOK_SHEETS.CONTENTS, CONTENTS_HEADERS, overrides.contents ?? [
      contents('BOX-001', 'AHP0001', 'Allen', 10),
      contents('BOX-002', 'AHP0002', 'Allen', 5),
      contents('BOX-002', 'AHP0003', 'Dabur', 3),
      contents('MIX-001', 'AHP0002', 'Allen', 4),
    ]),
    tab(WORKBOOK_SHEETS.UNITS, UNITS_HEADERS, overrides.units ?? [
      units('BOX-001', 'AHP0001', 'Allen', 10, 10),
      units('BOX-001', 'AHP0001', 'Allen', 12, 12),
      units('BOX-002', 'AHP0002', 'Allen', 5, 5),
      units('BOX-002', 'AHP0003', 'Dabur', 3, 3),
      units('MIX-001', 'AHP0002', 'Allen', 4, 0),
    ]),
    tab(WORKBOOK_SHEETS.STOCK, STOCK_HEADERS, overrides.stock ?? [
      stock('BOX-001', 'Allen', 'Zone B', 1),
      stock('BOX-002', 'Allen', 'Zone B', 1),
      stock('BOX-003', 'Allen', 'Zone B', 1),
      stock('MIX-001', 'Allen', 'Zone B', 1),
    ]),
    {
      name: WORKBOOK_SHEETS.MAPPING,
      rows: [MAPPING_HEADERS, ...(overrides.mapping ?? [
        mapping('BOX-002-01', 'BOX-001'),
        mapping('MIX-OLD', 'MIX-001', 'MIX ID preserved'),
        mapping('Important', 'Note row should not import', ''),
      ])],
    },
    tab(WORKBOOK_SHEETS.PICKING, [
      'Transaction ID', 'Date/Time', 'Employee ID', 'Employee Name', 'Task / Order ID', 'Box ID Scanned',
      'Master SKU (if partial)', 'Pick Type', 'Qty Picked (boxes)', 'Qty Picked (units)', 'From Zone',
      'From Rack', 'From Bin', 'To Staging Location', 'Confirmation', 'Exception / Notes',
    ], []),
    tab(WORKBOOK_SHEETS.PUTAWAY, [
      'Transaction ID', 'Date/Time', 'Employee ID', 'Employee Name', 'Inbound / Task ID', 'Box ID Scanned',
      'Master SKU(s)', 'Qty Putaway (boxes)', 'From Location', 'To Zone', 'To Rack', 'To Bin / Location',
      'Confirmation', 'Exception / Notes',
    ], []),
  ];
  return { sheets, sheetNames: sheets.map((sheet) => sheet.name) };
}

let harness: Harness;
let actor: AuthUser;
let committedJobId = '';

before(async () => {
  harness = await createHarness();
  const row = harness.db
    .prepare("SELECT id, employee_code, name, email, role_code FROM users WHERE role_code = 'ADMIN' LIMIT 1")
    .get() as { id: string; employee_code: string; name: string; email: string; role_code: string };
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

test('analyzes the workbook without inventing stock or verification', () => {
  const plan = analyzeWorkbook(workbook(), 'synthetic.xlsx', 'hash-a');
  const summary = summarizeWorkbookPlan(plan) as any;
  assert.equal(summary.issues.errors, 0, JSON.stringify(plan.issues));
  assert.equal(summary.products.created, 3);
  assert.equal(summary.products.nextMasterSku, 'AHP0004');
  assert.equal(summary.boxes.created, 4);
  assert.equal(summary.boxes.mixedSku, 1);
  assert.equal(summary.declarations.rows, 4);
  assert.equal(summary.postings.transactions, 3);
  assert.equal(summary.postings.units, 18);
  assert.equal(summary.pool.code, 'B2B');
  assert.equal(summary.verification.needsVerification, 4);
  assert.equal(summary.verification.verified, 0);
  assert.equal(summary.totals.created, 16);
  assert.equal(summary.totals.skipped, 1);
  assert.equal(summary.totals.failed, 0);
  const box001 = plan.boxes.find((box) => box.boxId === 'BOX-001');
  assert.ok(box001);
  assert.equal(box001.barcode, 'BOX-001');
  assert.equal(box001.rack, 'R-01');
  assert.equal(box001.bin, 'B-01');
  const mix = plan.boxes.find((box) => box.boxId === 'MIX-001');
  assert.ok(mix);
  assert.equal(mix.foundIn.includes('register'), false);
  assert.equal(plan.postings.some((posting) => posting.boxId === 'MIX-001'), false);
  assert.ok(plan.issues.some((entry) => entry.code === 'DUPLICATE_UNIT_LEDGER_ROW' && entry.boxId === 'BOX-001'));
  assert.ok(plan.issues.some((entry) => entry.code === 'BOX_COUNT_WITHOUT_UNITS' && entry.boxId === 'MIX-001'));
});

test('commits the workbook once, preserves provenance and reconciles every unit', () => {
  const plan = analyzeWorkbook(workbook(), 'synthetic.xlsx', 'hash-commit');
  const result = importAnalyzedWorkbook(harness.db, plan, actor, false);
  assert.equal(result.committed, true);
  assert.equal(result.job.status, 'IMPORTED');
  committedJobId = result.job.id;
  assert.deepEqual(result.reconciliation, {
    postedUnits: 18,
    ledgerUnits: 18,
    balanceUnits: 18,
    ok: true,
  });

  const products = harness.db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
  const productSources = harness.db
    .prepare('SELECT COUNT(*) AS n, MIN(verification_status) AS status FROM product_sources')
    .get() as { n: number; status: string };
  const boxes = harness.db
    .prepare('SELECT status, COUNT(*) AS n FROM boxes GROUP BY status ORDER BY status')
    .all() as Array<{ status: string; n: number }>;
  const boxSources = harness.db
    .prepare('SELECT COUNT(*) AS n, MIN(verification_status) AS status FROM box_sources')
    .get() as { n: number; status: string };
  const declarations = harness.db
    .prepare('SELECT COUNT(*) AS n, SUM(conflict_flag) AS conflicts FROM box_content_declarations')
    .get() as { n: number; conflicts: number };
  const mappings = harness.db.prepare('SELECT COUNT(*) AS n FROM box_id_mappings').get() as { n: number };
  const rawRows = harness.db.prepare('SELECT COUNT(*) AS n FROM workbook_source_rows').get() as { n: number };
  const balances = harness.db
    .prepare('SELECT COUNT(*) AS n, SUM(quantity) AS units FROM inventory_balances')
    .get() as { n: number; units: number };
  const migration = harness.db
    .prepare("SELECT COUNT(*) AS n, SUM(quantity) AS units FROM inventory_transactions WHERE movement_type = 'MIGRATION'")
    .get() as { n: number; units: number };

  assert.equal(Number(products.n), 3);
  assert.deepEqual({ n: Number(productSources.n), status: productSources.status }, { n: 3, status: 'NEEDS_VERIFICATION' });
  assert.deepEqual(boxes.map((row) => ({ status: row.status, n: Number(row.n) })), [
    { status: 'ACTIVE', n: 2 },
    { status: 'STAGING', n: 2 },
  ]);
  assert.deepEqual({ n: Number(boxSources.n), status: boxSources.status }, { n: 4, status: 'NEEDS_VERIFICATION' });
  const box001Source = harness.db
    .prepare(
      `SELECT bs.source_barcode, bs.source_rack, bs.source_bin, bs.source_zone
         FROM box_sources bs JOIN boxes b ON b.id = bs.box_id
        WHERE b.box_code = 'BOX-001'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual({ ...box001Source }, {
    source_barcode: 'BOX-001',
    source_rack: 'R-01',
    source_bin: 'B-01',
    source_zone: 'Zone B',
  });
  assert.deepEqual({ n: Number(declarations.n), conflicts: Number(declarations.conflicts) }, { n: 4, conflicts: 1 });
  assert.equal(Number(mappings.n), 2);
  assert.equal(Number(rawRows.n), 3 + 3 + 4 + 5 + 4 + 3);
  assert.deepEqual({ n: Number(balances.n), units: Number(balances.units) }, { n: 3, units: 18 });
  assert.deepEqual({ n: Number(migration.n), units: Number(migration.units) }, { n: 3, units: 18 });

  const mixDeclaration = harness.db
    .prepare(
      `SELECT d.declared_quantity, d.verification_status
         FROM box_content_declarations d JOIN boxes b ON b.id = d.box_id
        WHERE b.box_code = 'MIX-001'`,
    )
    .get() as { declared_quantity: number; verification_status: string };
  assert.deepEqual({ ...mixDeclaration }, { declared_quantity: 4, verification_status: 'NEEDS_VERIFICATION' });
  const mixBalance = harness.db
    .prepare("SELECT COUNT(*) AS n FROM inventory_balances ib JOIN boxes b ON b.id = ib.box_id WHERE b.box_code = 'MIX-001'")
    .get() as { n: number };
  assert.equal(Number(mixBalance.n), 0);

  const originalRow = harness.db
    .prepare("SELECT row_json FROM workbook_source_rows WHERE sheet_name = 'B2B Box Contents' AND row_json LIKE '%MIX-001%'")
    .get() as { row_json: string } | undefined;
  assert.ok(originalRow);
  assert.ok(originalRow.row_json.includes('"MIX-001"'));

  assert.equal(nextSku(harness.db), 'AHP0004');
});

test('a second import of the same workbook is rejected without changing stock', () => {
  const plan = analyzeWorkbook(workbook(), 'synthetic.xlsx', 'hash-commit');
  assert.throws(
    () => importAnalyzedWorkbook(harness.db, plan, actor, false),
    (error: any) => error.code === 'DUPLICATE_IMPORT',
  );
  const balances = harness.db
    .prepare('SELECT COUNT(*) AS n, SUM(quantity) AS units FROM inventory_balances')
    .get() as { n: number; units: number };
  assert.deepEqual({ n: Number(balances.n), units: Number(balances.units) }, { n: 3, units: 18 });
});

test('non-B2B rows are rejected before any write', () => {
  const plan = analyzeWorkbook(
    workbook({
      master: [master('AHP0009', 'Allen', 'Allen A99', 'B2X')],
      register: [register('BOX-001', 'Allen', 'Zone B', 'Single SKU', 'B2X')],
      contents: [contents('BOX-001', 'AHP0009', 'Allen', 10)],
      units: [units('BOX-001', 'AHP0009', 'Allen', 10, 10)],
      stock: [stock('BOX-001', 'Allen', 'Zone B', 1)],
      mapping: [mapping('OLD-1', 'BOX-001')],
    }),
    'non-b2b.xlsx',
    'hash-non-b2b',
  );
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  assert.ok(errors.filter((entry) => entry.code === 'NON_B2B_POOL').length >= 2);
  const result = importAnalyzedWorkbook(harness.db, plan, actor, false);
  assert.equal(result.committed, false);
  assert.equal(result.job.status, 'FAILED');
  const products = harness.db.prepare("SELECT COUNT(*) AS n FROM products WHERE sku = 'AHP0009'").get() as { n: number };
  assert.equal(Number(products.n), 0);
});

test('import job row counts, totals and error CSV reflect the validated workbook', () => {
  const job = harness.db
    .prepare('SELECT total_rows, valid_rows, invalid_rows, summary_json FROM import_jobs WHERE id = ?')
    .get(committedJobId) as { total_rows: number; valid_rows: number; invalid_rows: number; summary_json: string };
  assert.deepEqual(
    { total: Number(job.total_rows), valid: Number(job.valid_rows), invalid: Number(job.invalid_rows) },
    { total: 22, valid: 22, invalid: 0 },
  );
  const summary = JSON.parse(job.summary_json) as any;
  assert.equal(summary.totals.created, 16);
  assert.equal(summary.totals.skipped, 1);
  assert.equal(summary.totals.failed, 0);

  const report = importIssuesCsv(harness.db, committedJobId);
  assert.ok(report.fileName.endsWith('.csv'));
  const lines = report.csv.trimEnd().split('\n');
  assert.equal(lines[0], 'severity,code,sheet,row,box_id,sku,message');
  assert.ok(lines.some((line) => line.includes('DUPLICATE_UNIT_LEDGER_ROW')));
  assert.ok(lines.some((line) => line.includes('MAPPING_NOTE_ROWS_SKIPPED')));
});

test('duplicate box barcodes are rejected before any write', () => {
  const plan = analyzeWorkbook(
    workbook({
      register: [
        register('BOX-010', 'Allen', 'Zone B', 'Single SKU', 'B2B', { barcode: 'SHARED-LABEL' }),
        register('BOX-011', 'Allen', 'Zone B', 'Single SKU', 'B2B', { barcode: 'SHARED-LABEL' }),
      ],
      contents: [
        contents('BOX-010', 'AHP0001', 'Allen', 1),
        contents('BOX-011', 'AHP0002', 'Allen', 1),
      ],
      units: [units('BOX-010', 'AHP0001', 'Allen', 1, 1), units('BOX-011', 'AHP0002', 'Allen', 1, 1)],
      stock: [stock('BOX-010', 'Allen', 'Zone B', 1), stock('BOX-011', 'Allen', 'Zone B', 1)],
      mapping: [],
    }),
    'duplicate-barcode.xlsx',
    'hash-duplicate-barcode',
  );
  assert.ok(
    plan.issues.some(
      (entry) => entry.severity === 'ERROR' && entry.code === 'DUPLICATE_BOX_BARCODE' && entry.boxId === 'BOX-011',
    ),
  );
  const result = importAnalyzedWorkbook(harness.db, plan, actor, false);
  assert.equal(result.committed, false);
  assert.equal(result.job.status, 'FAILED');
  const boxes = harness.db
    .prepare("SELECT COUNT(*) AS n FROM boxes WHERE box_code IN ('BOX-010', 'BOX-011')")
    .get() as { n: number };
  assert.equal(Number(boxes.n), 0);
});

test('opening stock import advances the SKU sequence past existing records', () => {
  createProduct(harness.db, { sku: 'AHP0050', name: 'Sequence anchor', baseUom: 'PIECE' }, actor);
  const plan = analyzeWorkbook(
    workbook({
      master: [master('AHP0008', 'Dabur', 'Dabur Chyawanprash')],
      register: [register('BOX-050', 'Dabur', 'Zone C', 'Single SKU')],
      contents: [contents('BOX-050', 'AHP0008', 'Dabur', 2)],
      units: [units('BOX-050', 'AHP0008', 'Dabur', 2, 2)],
      stock: [stock('BOX-050', 'Dabur', 'Zone C', 1)],
      mapping: [mapping('OLD-050', 'BOX-050')],
    }),
    'sequence.xlsx',
    'hash-sequence',
  );
  assert.equal(plan.issues.filter((entry) => entry.severity === 'ERROR').length, 0, JSON.stringify(plan.issues));
  const result = importAnalyzedWorkbook(harness.db, plan, actor, false);
  assert.equal(result.committed, true);
  assert.equal(nextSku(harness.db), 'AHP0051');
});
