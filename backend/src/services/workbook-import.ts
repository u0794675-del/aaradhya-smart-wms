import { createHash } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { badRequest, conflict, isConstraintViolation } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { ParsedWorkbook, WorkbookCell } from '../lib/workbook.ts';
import {
  WORKBOOK_SHEETS,
  REQUIRED_WORKBOOK_SHEETS,
  cellText,
  parseWorkbook,
  rawRowJson,
  rowHasData,
} from '../lib/workbook.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';
import { postMovement } from './inventory.ts';

const SKU_PATTERN = /^AHP\d{4,6}$/;
const BOX_PATTERN = /^(?:BOX|MIX)-\d{3,4}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const HEADER_ROW = 2;
const MASTER_HEADERS = [
  'Master SKU',
  'Brand',
  'Product Name / Source SKU',
  'Source Brand + Product Key',
  'Category',
  'Stock Pool',
  'Active?',
  'Barcode Value',
  'Created From',
  'Verification Status',
  'Notes',
];
const REGISTER_HEADERS = [
  'Box ID',
  'Barcode Value',
  'Stock Pool',
  'Brand',
  'Zone',
  'Rack',
  'Bin / Location',
  'Box Type',
  'Box Qty (physical boxes)',
  'Status',
  'Current Location Key',
  'Source Page',
  'Transcription Confidence',
  'Verification Status',
  'Notes',
];
const CONTENTS_HEADERS = [
  'Box ID',
  'Master SKU',
  'Brand',
  'Product Name / Source SKU',
  'Qty per Box (units)',
  'Quantity Unit',
  'Box Type',
  'Source Page',
  'Transcription Confidence',
  'Verification Notes',
];
const UNITS_HEADERS = [
  'Box ID',
  'Master SKU',
  'Brand',
  'Product Name',
  'Units per Box',
  'Opening Units',
  'Picked Units',
  'Current Units',
  'Status',
  'Last Transaction',
  'Last Updated',
  'Notes',
];
const STOCK_HEADERS = [
  'Box ID',
  'Master SKU(s)',
  'Brand',
  'Product / Contents Summary',
  'Stock Pool',
  'Zone',
  'Rack',
  'Bin / Location',
  'Opening Box Qty',
  'Picked Box Qty',
  'Dispatched Box Qty',
  'Current Box Qty',
  'Status',
  'Last Verified',
  'Notes',
];
const MAPPING_HEADERS = ['Original / Source Box ID', 'New Box ID', 'Rule / Note'];
const PICKING_HEADERS = [
  'Transaction ID',
  'Date/Time',
  'Employee ID',
  'Employee Name',
  'Task / Order ID',
  'Box ID Scanned',
  'Master SKU (if partial)',
  'Pick Type',
  'Qty Picked (boxes)',
  'Qty Picked (units)',
  'From Zone',
  'From Rack',
  'From Bin',
  'To Staging Location',
  'Confirmation',
  'Exception / Notes',
];
const PUTAWAY_HEADERS = [
  'Transaction ID',
  'Date/Time',
  'Employee ID',
  'Employee Name',
  'Inbound / Task ID',
  'Box ID Scanned',
  'Master SKU(s)',
  'Qty Putaway (boxes)',
  'From Location',
  'To Zone',
  'To Rack',
  'To Bin / Location',
  'Confirmation',
  'Exception / Notes',
];

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface WorkbookIssue {
  severity: IssueSeverity;
  code: string;
  sheet: string;
  row: number | null;
  boxId?: string | null;
  sku?: string | null;
  message: string;
}

export interface WorkbookProductPlan {
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  pool: string;
  active: 'ACTIVE' | 'INACTIVE';
  activeSource: string;
  barcode: string | null;
  sourceProductKey: string | null;
  createdFrom: string | null;
  sourceVerification: string | null;
  notes: string | null;
  rowNo: number;
}

export interface WorkbookBoxPlan {
  boxId: string;
  boxType: 'SINGLE' | 'MIXED';
  brand: string | null;
  zone: string | null;
  rack: string | null;
  bin: string | null;
  barcode: string | null;
  pool: string;
  sourceBoxType: string | null;
  sourceStatus: string | null;
  sourceQuantity: number | null;
  sourceLocationKey: string | null;
  sourceReference: string | null;
  confidence: string | null;
  sourceVerification: string | null;
  notes: string | null;
  sourceSheet: string;
  rowNo: number | null;
  skus: string[];
  foundIn: string[];
}

export interface WorkbookDeclarationPlan {
  boxId: string;
  sku: string;
  quantity: number | null;
  unitLabel: string | null;
  sourceBoxType: string | null;
  sourcePage: string | null;
  confidence: string | null;
  notes: string | null;
  conflictFlag: boolean;
  conflictDetail: string | null;
  rowNo: number;
}

export interface WorkbookPostingPlan {
  boxId: string;
  sku: string;
  quantity: number;
  zone: string | null;
  sourceRow: number;
  sourceStatus: string | null;
  notes: string | null;
}

export interface WorkbookMappingPlan {
  sourceBoxId: string;
  boxCode: string;
  note: string | null;
  rowNo: number;
}

export interface WorkbookRawRow {
  sheet: string;
  rowNo: number;
  json: string;
}

export interface WorkbookSheetSummary {
  sheet: string;
  dataRows: number;
  blankRowsSkipped: number;
}

export interface WorkbookPlan {
  fileName: string;
  sourceHash: string;
  products: WorkbookProductPlan[];
  boxes: WorkbookBoxPlan[];
  declarations: WorkbookDeclarationPlan[];
  postings: WorkbookPostingPlan[];
  mappings: WorkbookMappingPlan[];
  rawRows: WorkbookRawRow[];
  sheets: WorkbookSheetSummary[];
  issues: WorkbookIssue[];
  nextMasterSku: string;
  skippedRows: number;
}

interface BoxAccumulator {
  boxId: string;
  brand: string | null;
  zone: string | null;
  rack: string | null;
  bin: string | null;
  barcode: string | null;
  pool: string | null;
  sourceBoxType: string | null;
  sourceStatus: string | null;
  sourceQuantity: number | null;
  sourceLocationKey: string | null;
  sourceReference: string | null;
  confidence: string | null;
  sourceVerification: string | null;
  notes: string | null;
  sourceSheet: string | null;
  rowNo: number | null;
  contentSkus: Set<string>;
  unitSkus: Set<string>;
  contentBrands: Set<string>;
  foundIn: Set<string>;
}

interface IntRead {
  value: number | null;
  raw: string;
  invalid: boolean;
}

function readInt(value: WorkbookCell): IntRead {
  const raw = cellText(value);
  if (!raw) return { value: null, raw, invalid: false };
  const normalized = raw.replace(/,/g, '');
  if (!/^-?\d+$/.test(normalized)) return { value: null, raw, invalid: true };
  return { value: Number(normalized), raw, invalid: false };
}

function isB2B(value: string): boolean {
  return value.trim().toUpperCase() === 'B2B';
}

function zoneLocationCode(zone: string | null): string {
  if (!zone) return 'UNASSIGNED-STAGING';
  return `${zone.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}-UNASSIGNED`;
}

function boxIdFrom(value: WorkbookCell): string {
  return cellText(value).toUpperCase();
}

function productIdNumber(sku: string): number {
  return Number(sku.slice(3));
}

export function nextMasterSkuAfter(skus: string[]): string {
  let max = 0;
  for (const sku of skus) {
    if (!SKU_PATTERN.test(sku)) continue;
    max = Math.max(max, productIdNumber(sku));
  }
  return `AHP${String(max + 1).padStart(4, '0')}`;
}

function headerMismatches(rows: WorkbookCell[][], headers: string[], sheet: string): WorkbookIssue[] {
  const issues: WorkbookIssue[] = [];
  const header = (rows[HEADER_ROW] ?? []).map((cell) => cellText(cell).toLowerCase());
  headers.forEach((expected, index) => {
    if (header[index] !== expected.toLowerCase()) {
      issues.push({
        severity: 'ERROR',
        code: 'HEADER_MISMATCH',
        sheet,
        row: HEADER_ROW + 1,
        message: `Column ${index + 1} should be "${expected}" but is "${header[index] ?? ''}"`,
      });
    }
  });
  return issues;
}

interface AnalysisState {
  issues: WorkbookIssue[];
  rawRows: WorkbookRawRow[];
  sheets: WorkbookSheetSummary[];
}

function readSheet(
  workbook: ParsedWorkbook,
  sheet: string,
  headerRow: number,
  state: AnalysisState,
): WorkbookCell[][] {
  const found = workbook.sheets.find((entry) => entry.name === sheet);
  if (!found) {
    state.sheets.push({ sheet, dataRows: 0, blankRowsSkipped: 0 });
    return [];
  }
  const rows = found.rows;
  const data: WorkbookCell[][] = [];
  let blank = 0;
  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (!rowHasData(row)) {
      blank += 1;
      continue;
    }
    data.push(row);
    state.rawRows.push({ sheet, rowNo: index + 1, json: rawRowJson(row) });
  }
  state.sheets.push({ sheet, dataRows: data.length, blankRowsSkipped: blank });
  return data;
}

function issue(
  state: AnalysisState,
  severity: IssueSeverity,
  code: string,
  sheet: string,
  row: number | null,
  message: string,
  extra: { boxId?: string | null; sku?: string | null } = {},
): void {
  state.issues.push({ severity, code, sheet, row, message, ...extra });
}

export function analyzeWorkbook(parsed: ParsedWorkbook, fileName = '', sourceHash = ''): WorkbookPlan {
  const state: AnalysisState = { issues: [], rawRows: [], sheets: [] };

  for (const sheet of REQUIRED_WORKBOOK_SHEETS) {
    if (!parsed.sheetNames.includes(sheet)) {
      issue(state, 'ERROR', 'SHEET_MISSING', sheet, null, `Workbook is missing the required "${sheet}" sheet`);
    }
  }
  for (const [sheet, headers] of [
    [WORKBOOK_SHEETS.MASTER, MASTER_HEADERS],
    [WORKBOOK_SHEETS.REGISTER, REGISTER_HEADERS],
    [WORKBOOK_SHEETS.CONTENTS, CONTENTS_HEADERS],
    [WORKBOOK_SHEETS.UNITS, UNITS_HEADERS],
    [WORKBOOK_SHEETS.STOCK, STOCK_HEADERS],
  ] as Array<[string, string[]]>) {
    const rows = parsed.sheets.find((entry) => entry.name === sheet)?.rows;
    if (rows) state.issues.push(...headerMismatches(rows, headers, sheet));
  }
  const mappingSheet = parsed.sheets.find((entry) => entry.name === WORKBOOK_SHEETS.MAPPING);
  if (mappingSheet) {
    const header = (mappingSheet.rows[0] ?? []).map((cell) => cellText(cell).toLowerCase());
    MAPPING_HEADERS.forEach((expected, index) => {
      if (header[index] !== expected.toLowerCase()) {
        issue(
          state,
          'ERROR',
          'HEADER_MISMATCH',
          WORKBOOK_SHEETS.MAPPING,
          1,
          `Column ${index + 1} should be "${expected}" but is "${header[index] ?? ''}"`,
        );
      }
    });
  }

  const masterRows = readSheet(parsed, WORKBOOK_SHEETS.MASTER, HEADER_ROW, state);
  const registerRows = readSheet(parsed, WORKBOOK_SHEETS.REGISTER, HEADER_ROW, state);
  const contentRows = readSheet(parsed, WORKBOOK_SHEETS.CONTENTS, HEADER_ROW, state);
  const unitRows = readSheet(parsed, WORKBOOK_SHEETS.UNITS, HEADER_ROW, state);
  const stockRows = readSheet(parsed, WORKBOOK_SHEETS.STOCK, HEADER_ROW, state);
  const mappingRows = readSheet(parsed, WORKBOOK_SHEETS.MAPPING, 0, state);

  for (const sheet of [
    WORKBOOK_SHEETS.PICKING,
    WORKBOOK_SHEETS.PUTAWAY,
    WORKBOOK_SHEETS.LISTS,
    WORKBOOK_SHEETS.SOURCE_REVIEW,
  ]) {
    const rows = readSheet(parsed, sheet, HEADER_ROW, state);
    if ((sheet === WORKBOOK_SHEETS.PICKING || sheet === WORKBOOK_SHEETS.PUTAWAY) && rows.length > 0) {
      issue(
        state,
        'WARNING',
        'HISTORICAL_ROWS_PRESERVED',
        sheet,
        null,
        `${rows.length} historical row(s) were preserved as source records but were not replayed as stock movements`,
      );
    }
  }

  // ---- Master SKU -------------------------------------------------------
  const products: WorkbookProductPlan[] = [];
  const productBySku = new Map<string, WorkbookProductPlan>();
  const barcodeOwners = new Map<string, string>();
  let blankTemplateRows = 0;
  const templateRowNumbers = new Set<number>();

  for (let index = 0; index < masterRows.length; index += 1) {
    const row = masterRows[index];
    const rowNo = HEADER_ROW + 2 + index;
    const sku = cellText(row[0]).toUpperCase();
    const name = cellText(row[2]);
    if (!sku && !name) {
      blankTemplateRows += 1;
      templateRowNumbers.add(rowNo);
      continue;
    }
    if (!sku) {
      issue(state, 'ERROR', 'MASTER_SKU_MISSING', WORKBOOK_SHEETS.MASTER, rowNo, 'Product row has a name but no Master SKU');
      continue;
    }
    if (!SKU_PATTERN.test(sku)) {
      issue(state, 'ERROR', 'MASTER_SKU_INVALID', WORKBOOK_SHEETS.MASTER, rowNo, `Master SKU "${sku}" does not match AHP####`, {
        sku,
      });
      continue;
    }
    if (!name) {
      issue(state, 'ERROR', 'PRODUCT_NAME_MISSING', WORKBOOK_SHEETS.MASTER, rowNo, `SKU ${sku} has no product name`, { sku });
      continue;
    }
    const brand = cellText(row[1]) || null;
    const existing = productBySku.get(sku);
    if (existing) {
      if (existing.name === name && existing.brand === brand) {
        issue(state, 'WARNING', 'DUPLICATE_MASTER_ROW', WORKBOOK_SHEETS.MASTER, rowNo, `SKU ${sku} appears more than once with the same values`, { sku });
      } else {
        issue(state, 'ERROR', 'DUPLICATE_MASTER_ID', WORKBOOK_SHEETS.MASTER, rowNo, `SKU ${sku} is repeated with different product details`, { sku });
      }
      continue;
    }
    const pool = cellText(row[5]);
    if (!isB2B(pool)) {
      issue(state, 'ERROR', 'NON_B2B_POOL', WORKBOOK_SHEETS.MASTER, rowNo, `SKU ${sku} declares pool "${pool || '(blank)'}"; only B2B inventory is accepted`, { sku });
      continue;
    }
    const barcode = cellText(row[7]) || null;
    if (barcode) {
      const owner = barcodeOwners.get(barcode);
      if (owner && owner !== sku) {
        issue(state, 'ERROR', 'DUPLICATE_BARCODE', WORKBOOK_SHEETS.MASTER, rowNo, `Barcode ${barcode} is already assigned to ${owner}`, { sku });
        continue;
      }
      barcodeOwners.set(barcode, sku);
    }
    const activeSource = cellText(row[6]);
    const plan: WorkbookProductPlan = {
      sku,
      name,
      brand,
      category: cellText(row[4]) || null,
      pool: 'B2B',
      active: /^(yes|y|true|active)$/i.test(activeSource) ? 'ACTIVE' : 'INACTIVE',
      activeSource,
      barcode,
      sourceProductKey: cellText(row[3]) || null,
      createdFrom: cellText(row[8]) || null,
      sourceVerification: cellText(row[9]) || null,
      notes: cellText(row[10]) || null,
      rowNo,
    };
    products.push(plan);
    productBySku.set(sku, plan);
  }

  // ---- Boxes and declared contents -------------------------------------
  const boxes = new Map<string, BoxAccumulator>();
  const boxBarcodeOwners = new Map<string, string>();
  const unitFirst = new Map<string, { row: WorkbookCell[]; rowNo: number; values: number[] }>();
  const unitPerBox = new Map<string, number>();
  const declarationFirst = new Map<string, { row: WorkbookCell[]; rowNo: number; values: Array<number | null> }>();
  const stockFirst = new Map<string, { row: WorkbookCell[]; rowNo: number; values: number[] }>();

  const ensureBox = (boxId: string, source: string): BoxAccumulator | null => {
    if (!BOX_PATTERN.test(boxId)) {
      issue(state, 'ERROR', 'BOX_ID_INVALID', source, null, `Box ID "${boxId}" does not match BOX-### or MIX-###`, { boxId });
      return null;
    }
    let box = boxes.get(boxId);
    if (!box) {
      box = {
        boxId,
        brand: null,
        zone: null,
        rack: null,
        bin: null,
        barcode: null,
        pool: null,
        sourceBoxType: null,
        sourceStatus: null,
        sourceQuantity: null,
        sourceLocationKey: null,
        sourceReference: null,
        confidence: null,
        sourceVerification: null,
        notes: null,
        sourceSheet: null,
        rowNo: null,
        contentSkus: new Set(),
        unitSkus: new Set(),
        contentBrands: new Set(),
        foundIn: new Set(),
      };
      boxes.set(boxId, box);
    }
    box.foundIn.add(source);
    return box;
  };

  for (let index = 0; index < registerRows.length; index += 1) {
    const row = registerRows[index];
    const rowNo = HEADER_ROW + 2 + index;
    const boxId = boxIdFrom(row[0]);
    const box = ensureBox(boxId, 'register');
    if (!box) continue;
    if (box.sourceSheet === WORKBOOK_SHEETS.REGISTER) {
      issue(state, 'ERROR', 'DUPLICATE_BOX_ID', WORKBOOK_SHEETS.REGISTER, rowNo, `Box ${boxId} is registered more than once`, { boxId });
      continue;
    }
    const pool = cellText(row[2]);
    if (!isB2B(pool)) {
      issue(state, 'ERROR', 'NON_B2B_POOL', WORKBOOK_SHEETS.REGISTER, rowNo, `Box ${boxId} declares pool "${pool || '(blank)'}"; only B2B inventory is accepted`, { boxId });
      continue;
    }
    const quantity = readInt(row[8]);
    if (quantity.invalid || (quantity.value !== null && quantity.value < 0)) {
      issue(state, 'ERROR', 'INVALID_BOX_QUANTITY', WORKBOOK_SHEETS.REGISTER, rowNo, `Box ${boxId} has invalid physical box quantity "${quantity.raw}"`, { boxId });
    }
    box.sourceSheet = WORKBOOK_SHEETS.REGISTER;
    box.rowNo = rowNo;
    box.brand = cellText(row[3]) || null;
    box.zone = cellText(row[4]) || null;
    box.rack = cellText(row[5]) || null;
    box.bin = cellText(row[6]) || null;
    box.barcode = cellText(row[1]).toUpperCase() || null;
    box.pool = 'B2B';
    box.sourceBoxType = cellText(row[7]) || null;
    box.sourceQuantity = quantity.value;
    box.sourceStatus = cellText(row[9]) || null;
    box.sourceLocationKey = cellText(row[10]) || null;
    box.sourceReference = cellText(row[11]) || null;
    box.confidence = cellText(row[12]) || null;
    box.sourceVerification = cellText(row[13]) || null;
    box.notes = cellText(row[14]) || null;
    if (box.barcode) {
      const alreadyOn = boxBarcodeOwners.get(box.barcode);
      if (alreadyOn && alreadyOn !== boxId) {
        issue(state, 'ERROR', 'DUPLICATE_BOX_BARCODE', WORKBOOK_SHEETS.REGISTER, rowNo, `Barcode ${box.barcode} is already assigned to box ${alreadyOn}`, { boxId });
      } else {
        boxBarcodeOwners.set(box.barcode, boxId);
        const productOwner = barcodeOwners.get(box.barcode);
        if (box.barcode !== boxId && productOwner) {
          issue(state, 'ERROR', 'DUPLICATE_BARCODE', WORKBOOK_SHEETS.REGISTER, rowNo, `Box barcode ${box.barcode} collides with product ${productOwner}`, { boxId, sku: productOwner });
        }
      }
    }
    if (quantity.value === null) {
      issue(state, 'WARNING', 'BOX_QUANTITY_MISSING', WORKBOOK_SHEETS.REGISTER, rowNo, `Box ${boxId} has no physical box quantity`, { boxId });
    }
  }

  for (let index = 0; index < contentRows.length; index += 1) {
    const row = contentRows[index];
    const rowNo = HEADER_ROW + 2 + index;
    const boxId = boxIdFrom(row[0]);
    const sku = cellText(row[1]).toUpperCase();
    const box = ensureBox(boxId, 'contents');
    if (!box) continue;
    if (!productBySku.has(sku)) {
      issue(state, 'ERROR', 'CONTENT_SKU_UNKNOWN', WORKBOOK_SHEETS.CONTENTS, rowNo, `Box ${boxId} references unknown Master SKU "${sku}"`, { boxId, sku });
      continue;
    }
    const quantity = readInt(row[4]);
    if (quantity.invalid || (quantity.value !== null && quantity.value < 0)) {
      issue(state, 'ERROR', 'INVALID_DECLARED_QUANTITY', WORKBOOK_SHEETS.CONTENTS, rowNo, `Box ${boxId} / ${sku} has invalid declared quantity "${quantity.raw}"`, { boxId, sku });
      continue;
    }
    box.contentSkus.add(sku);
    if (cellText(row[2])) box.contentBrands.add(cellText(row[2]));
    if (!box.sourceBoxType) box.sourceBoxType = cellText(row[6]) || null;
    const key = `${boxId}|${sku}`;
    const existing = declarationFirst.get(key);
    if (existing) {
      existing.values.push(quantity.value);
    } else {
      declarationFirst.set(key, { row, rowNo, values: [quantity.value] });
    }
  }

  for (let index = 0; index < unitRows.length; index += 1) {
    const row = unitRows[index];
    const rowNo = HEADER_ROW + 2 + index;
    const boxId = boxIdFrom(row[0]);
    const sku = cellText(row[1]).toUpperCase();
    const box = ensureBox(boxId, 'units');
    if (!box) continue;
    if (!productBySku.has(sku)) {
      issue(state, 'ERROR', 'UNIT_SKU_UNKNOWN', WORKBOOK_SHEETS.UNITS, rowNo, `Unit ledger row references unknown Master SKU "${sku}"`, { boxId, sku });
      continue;
    }
    const perBox = readInt(row[4]);
    const opening = readInt(row[5]);
    const picked = readInt(row[6]);
    const current = readInt(row[7]);
    if (perBox.invalid || opening.invalid || picked.invalid || current.invalid) {
      issue(state, 'ERROR', 'INVALID_UNIT_QUANTITY', WORKBOOK_SHEETS.UNITS, rowNo, `Box ${boxId} / ${sku} has a non-numeric unit quantity`, { boxId, sku });
      continue;
    }
    if ((current.value ?? 0) < 0 || (opening.value ?? 0) < 0 || (picked.value ?? 0) < 0) {
      issue(state, 'ERROR', 'NEGATIVE_UNIT_QUANTITY', WORKBOOK_SHEETS.UNITS, rowNo, `Box ${boxId} / ${sku} has a negative unit quantity`, { boxId, sku });
      continue;
    }
    box.unitSkus.add(sku);
    if (!box.brand) box.brand = cellText(row[2]) || null;
    const key = `${boxId}|${sku}`;
    const existing = unitFirst.get(key);
    if (existing) {
      existing.values.push(current.value ?? 0);
    } else {
      unitFirst.set(key, { row, rowNo, values: [current.value ?? 0] });
      if (perBox.value !== null) unitPerBox.set(key, perBox.value);
    }
    if (opening.value !== null && picked.value !== null && current.value !== null && opening.value - picked.value !== current.value) {
      issue(state, 'WARNING', 'UNIT_BALANCE_MISMATCH', WORKBOOK_SHEETS.UNITS, rowNo, `Box ${boxId} / ${sku}: opening ${opening.value} - picked ${picked.value} does not equal current ${current.value}`, { boxId, sku });
    }
    if (current.value !== null && (current.value > 0) !== (cellText(row[8]) === 'In Stock')) {
      issue(state, 'WARNING', 'UNIT_STATUS_MISMATCH', WORKBOOK_SHEETS.UNITS, rowNo, `Box ${boxId} / ${sku} status "${cellText(row[8])}" disagrees with current units ${current.value}`, { boxId, sku });
    }
  }

  for (let index = 0; index < stockRows.length; index += 1) {
    const row = stockRows[index];
    const rowNo = HEADER_ROW + 2 + index;
    const boxId = boxIdFrom(row[0]);
    const box = ensureBox(boxId, 'stock');
    if (!box) continue;
    const pool = cellText(row[4]);
    if (pool && !isB2B(pool)) {
      issue(state, 'ERROR', 'NON_B2B_POOL', WORKBOOK_SHEETS.STOCK, rowNo, `Box ${boxId} declares pool "${pool}"; only B2B inventory is accepted`, { boxId });
      continue;
    }
    const current = readInt(row[11]);
    if (current.invalid || (current.value !== null && current.value < 0)) {
      issue(state, 'ERROR', 'INVALID_STOCK_LEDGER_QUANTITY', WORKBOOK_SHEETS.STOCK, rowNo, `Box ${boxId} has invalid current box quantity "${current.raw}"`, { boxId });
      continue;
    }
    const existing = stockFirst.get(boxId);
    if (existing) {
      existing.values.push(current.value ?? 0);
    } else {
      stockFirst.set(boxId, { row, rowNo, values: [current.value ?? 0] });
    }
    if (!box.zone) box.zone = cellText(row[5]) || null;
    if (!box.brand) box.brand = cellText(row[2]) || null;
    if (!box.pool) box.pool = 'B2B';
    if (!box.sourceStatus) box.sourceStatus = cellText(row[12]) || null;
    if (!box.notes) box.notes = cellText(row[14]) || null;
  }

  // ---- Resolve boxes ----------------------------------------------------
  const boxPlans: WorkbookBoxPlan[] = [];
  for (const box of boxes.values()) {
    const skus = new Set([...box.contentSkus, ...box.unitSkus]);
    const declaredMixed = /mixed/i.test(box.sourceBoxType ?? '');
    const boxType: 'SINGLE' | 'MIXED' = declaredMixed || skus.size > 1 ? 'MIXED' : 'SINGLE';
    if (declaredMixed && skus.size <= 1 && box.contentSkus.size > 0) {
      issue(state, 'WARNING', 'MIXED_BOX_SINGLE_SKU', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} is declared mixed but only one SKU is recorded`, { boxId: box.boxId });
    }
    if (!declaredMixed && skus.size > 1) {
      issue(state, 'WARNING', 'BOX_TYPE_CONFLICT', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} is declared ${box.sourceBoxType ?? 'unknown'} but contains ${skus.size} SKUs; it is imported as a mixed box`, { boxId: box.boxId });
    }
    if (!box.foundIn.has('register')) {
      issue(state, 'WARNING', 'BOX_MISSING_FROM_REGISTER', WORKBOOK_SHEETS.CONTENTS, box.rowNo, `Box ${box.boxId} is referenced by contents/ledger but has no Box Register row`, { boxId: box.boxId });
    }
    if (!box.contentSkus.size) {
      issue(state, 'WARNING', 'BOX_WITHOUT_CONTENTS', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} has no declared contents`, { boxId: box.boxId });
    }
    if (!box.zone) {
      issue(state, 'WARNING', 'BOX_ZONE_MISSING', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} has no zone; it will be placed in Unassigned staging`, { boxId: box.boxId });
    }
    if (!box.pool) {
      issue(state, 'WARNING', 'BOX_POOL_MISSING', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} has no pool; it is imported as B2B`, { boxId: box.boxId });
      box.pool = 'B2B';
    }
    if (box.brand && box.contentBrands.size) {
      for (const brand of box.contentBrands) {
        if (brand !== box.brand) {
          issue(state, 'WARNING', 'BRAND_CONFLICT', WORKBOOK_SHEETS.CONTENTS, box.rowNo, `Box ${box.boxId} register brand "${box.brand}" differs from contents brand "${brand}"`, { boxId: box.boxId });
        }
      }
    }
    if (box.barcode && boxes.has(box.barcode) && box.barcode !== box.boxId) {
      issue(state, 'ERROR', 'DUPLICATE_BOX_BARCODE', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box barcode ${box.barcode} matches the ID of another box`, { boxId: box.boxId });
    }
    boxPlans.push({      boxId: box.boxId,
      boxType,
      brand: box.brand,
      zone: box.zone,
      rack: box.rack,
      bin: box.bin,
      barcode: box.barcode,
      pool: box.pool ?? 'B2B',
      sourceBoxType: box.sourceBoxType,
      sourceStatus: box.sourceStatus,
      sourceQuantity: box.sourceQuantity,
      sourceLocationKey: box.sourceLocationKey,
      sourceReference: box.sourceReference,
      confidence: box.confidence,
      sourceVerification: box.sourceVerification,
      notes: box.notes,
      sourceSheet: box.sourceSheet ?? WORKBOOK_SHEETS.CONTENTS,
      rowNo: box.rowNo,
      skus: [...skus].sort(),
      foundIn: [...box.foundIn],
    });
  }
  boxPlans.sort((a, b) => a.boxId.localeCompare(b.boxId));

  // ---- Declarations -----------------------------------------------------
  const declarations: WorkbookDeclarationPlan[] = [];
  for (const [key, entry] of declarationFirst) {
    const [boxId, sku] = key.split('|');
    const row = entry.row;
    const values = entry.values;
    const unique = [...new Set(values.map((value) => (value === null ? 'null' : String(value))))];
    const conflicts: string[] = [];
    if (values.length > 1) {
      issue(state, 'WARNING', 'DUPLICATE_DECLARATION', WORKBOOK_SHEETS.CONTENTS, entry.rowNo, `Box ${boxId} / ${sku} appears ${values.length} times with quantities ${unique.join(', ')}; the first recorded value is used`, { boxId, sku });
      if (unique.length > 1) conflicts.push(`duplicate rows: ${unique.join(', ')}`);
    }
    const perBox = unitPerBox.get(key);
    const declared = values[0] ?? null;
    if (declared === null) {
      issue(state, 'WARNING', 'DECLARED_QUANTITY_MISSING', WORKBOOK_SHEETS.CONTENTS, entry.rowNo, `Box ${boxId} / ${sku} has no declared quantity`, { boxId, sku });
    }
    if (declared !== null && perBox !== undefined && declared !== perBox) {
      issue(state, 'WARNING', 'DECLARED_UNIT_CONFLICT', WORKBOOK_SHEETS.CONTENTS, entry.rowNo, `Box ${boxId} / ${sku}: contents declares ${declared} but the unit ledger says ${perBox} units per box`, { boxId, sku });
      conflicts.push(`contents ${declared} vs unit ledger ${perBox}`);
    }
    const unit = unitFirst.get(key);
    if (!unit) {
      issue(state, 'WARNING', 'DECLARATION_WITHOUT_LEDGER', WORKBOOK_SHEETS.CONTENTS, entry.rowNo, `Box ${boxId} / ${sku} has no unit stock ledger row`, { boxId, sku });
    } else if (unit.values.length > 1) {
      const unitValues = [...new Set(unit.values.map(String))];
      if (unitValues.length > 1) conflicts.push(`duplicate unit ledger rows: ${unitValues.join(', ')}`);
    }
    declarations.push({
      boxId,
      sku,
      quantity: declared,
      unitLabel: cellText(row[5]) || null,
      sourceBoxType: cellText(row[6]) || null,
      sourcePage: cellText(row[7]) || null,
      confidence: cellText(row[8]) || null,
      notes: cellText(row[9]) || null,
      conflictFlag: conflicts.length > 0,
      conflictDetail: conflicts.length ? conflicts.join('; ') : null,
      rowNo: entry.rowNo,
    });
  }
  declarations.sort((a, b) => a.boxId.localeCompare(b.boxId) || a.sku.localeCompare(b.sku));

  // ---- Opening stock postings ------------------------------------------
  const postings: WorkbookPostingPlan[] = [];
  const boxById = new Map(boxPlans.map((box) => [box.boxId, box]));
  const warnedBoxCounts = new Set<string>();
  for (const [key, entry] of unitFirst) {
    const [boxId, sku] = key.split('|');
    const values = entry.values;
    const unique = [...new Set(values.map(String))];
    if (values.length > 1) {
      issue(state, 'WARNING', 'DUPLICATE_UNIT_LEDGER_ROW', WORKBOOK_SHEETS.UNITS, entry.rowNo, `Unit ledger row for ${boxId} / ${sku} is duplicated with current units ${unique.join(', ')}; the first recorded value is used`, { boxId, sku });
    }
    const current = values[0];
    if (!Number.isInteger(current) || current < 0) {
      issue(state, 'ERROR', 'INVALID_CURRENT_UNITS', WORKBOOK_SHEETS.UNITS, entry.rowNo, `Box ${boxId} / ${sku} has invalid current units`, { boxId, sku });
      continue;
    }
    if (current === 0) {
      const stock = stockFirst.get(boxId);
      if (stock && stock.values[0] > 0 && !warnedBoxCounts.has(boxId)) {
        warnedBoxCounts.add(boxId);
        issue(state, 'WARNING', 'BOX_COUNT_WITHOUT_UNITS', WORKBOOK_SHEETS.STOCK, stock.rowNo, `Box ${boxId} is recorded as ${stock.values[0]} physical box in stock but the unit ledger holds 0 units; no stock was posted`, { boxId, sku });
      }
      continue;
    }
    const declared = declarationFirst.get(key)?.values[0] ?? null;
    if (declared !== null && current > declared) {
      issue(state, 'WARNING', 'CURRENT_EXCEEDS_DECLARED', WORKBOOK_SHEETS.UNITS, entry.rowNo, `Box ${boxId} / ${sku} has ${current} current units but only ${declared} declared per box`, { boxId, sku });
    }
    const box = boxById.get(boxId);
    postings.push({
      boxId,
      sku,
      quantity: current,
      zone: box?.zone ?? null,
      sourceRow: entry.rowNo,
      sourceStatus: cellText(entry.row[8]) || null,
      notes: cellText(entry.row[11]) || null,
    });
  }
  postings.sort((a, b) => a.boxId.localeCompare(b.boxId) || a.sku.localeCompare(b.sku));

  const postingBoxes = new Set(postings.map((posting) => posting.boxId));
  for (const box of boxPlans) {
    if (box.skus.length === 0 && box.sourceQuantity !== null && box.sourceQuantity > 0) {
      issue(state, 'WARNING', 'REGISTER_BOX_WITHOUT_STOCK', WORKBOOK_SHEETS.REGISTER, box.rowNo, `Box ${box.boxId} is registered as in stock but has no contents or unit balance`, { boxId: box.boxId });
    }
    if (box.skus.length > 0 && !postingBoxes.has(box.boxId)) {
      issue(state, 'WARNING', 'DECLARED_CONTENTS_NOT_POSTED', WORKBOOK_SHEETS.CONTENTS, box.rowNo, `Box ${box.boxId} has declared contents but no current units; no opening stock was posted`, { boxId: box.boxId });
    }
  }

  // ---- Box ID mapping ---------------------------------------------------
  const mappings: WorkbookMappingPlan[] = [];
  const mappingSeen = new Set<string>();
  let skippedMappingRows = 0;
  for (let index = 0; index < mappingRows.length; index += 1) {
    const row = mappingRows[index];
    const rowNo = 2 + index;
    const sourceBoxId = cellText(row[0]);
    const boxCode = boxIdFrom(row[1]);
    if (!sourceBoxId || !BOX_PATTERN.test(boxCode)) {
      skippedMappingRows += 1;
      continue;
    }
    if (mappingSeen.has(sourceBoxId)) {
      issue(state, 'WARNING', 'DUPLICATE_MAPPING_SOURCE', WORKBOOK_SHEETS.MAPPING, rowNo, `Mapping source ${sourceBoxId} appears more than once; the first mapping is used`, { boxId: boxCode });
      continue;
    }
    mappingSeen.add(sourceBoxId);
    if (!boxes.has(boxCode)) {
      issue(state, 'WARNING', 'MAPPING_TARGET_UNKNOWN', WORKBOOK_SHEETS.MAPPING, rowNo, `Mapping target ${boxCode} is not present in the box register`, { boxId: boxCode });
    }
    mappings.push({ sourceBoxId, boxCode, note: cellText(row[2]) || null, rowNo });
  }
  if (skippedMappingRows > 0) {
    issue(state, 'WARNING', 'MAPPING_NOTE_ROWS_SKIPPED', WORKBOOK_SHEETS.MAPPING, null, `${skippedMappingRows} non-box note row(s) were preserved but not imported as mappings`);
  }

  const nextMasterSku = nextMasterSkuAfter(products.map((product) => product.sku));
  if (blankTemplateRows > 0) {
    issue(state, 'WARNING', 'BLANK_TEMPLATE_ROWS', WORKBOOK_SHEETS.MASTER, null, `${blankTemplateRows} blank template row(s) were skipped`);
    const masterSheet = state.sheets.find((sheet) => sheet.sheet === WORKBOOK_SHEETS.MASTER);
    if (masterSheet) {
      masterSheet.dataRows = Math.max(0, masterSheet.dataRows - blankTemplateRows);
      masterSheet.blankRowsSkipped += blankTemplateRows;
    }
    state.rawRows = state.rawRows.filter(
      (row) => !(row.sheet === WORKBOOK_SHEETS.MASTER && templateRowNumbers.has(row.rowNo)),
    );
  }

  return {
    fileName,
    sourceHash,
    products,
    boxes: boxPlans,
    declarations,
    postings,
    mappings,
    rawRows: state.rawRows,
    sheets: state.sheets,
    issues: state.issues,
    nextMasterSku,
    skippedRows: blankTemplateRows + skippedMappingRows,
  };
}

export function summarizeWorkbookPlan(plan: WorkbookPlan): Record<string, unknown> {
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  const warnings = plan.issues.filter((entry) => entry.severity === 'WARNING');
  const issueCounts = new Map<string, { severity: IssueSeverity; count: number }>();
  for (const entry of plan.issues) {
    const existing = issueCounts.get(entry.code);
    if (existing) existing.count += 1;
    else issueCounts.set(entry.code, { severity: entry.severity, count: 1 });
  }
  const byZone = new Map<string, { boxes: Set<string>; units: number }>();
  for (const posting of plan.postings) {
    const zone = posting.zone ?? 'Unassigned';
    const entry = byZone.get(zone) ?? { boxes: new Set<string>(), units: 0 };
    entry.boxes.add(posting.boxId);
    entry.units += posting.quantity;
    byZone.set(zone, entry);
  }
  const postingBoxes = new Set(plan.postings.map((posting) => posting.boxId));
  const units = plan.postings.reduce((total, posting) => total + posting.quantity, 0);
  const blankTemplate = plan.sheets
    .find((sheet) => sheet.sheet === WORKBOOK_SHEETS.MASTER)?.blankRowsSkipped ?? 0;
  return {
    fileName: plan.fileName,
    sourceHash: plan.sourceHash,
    sheets: plan.sheets,
    products: {
      created: plan.products.length,
      blankTemplateRowsSkipped: blankTemplate,
      nextMasterSku: plan.nextMasterSku,
    },
    boxes: {
      created: plan.boxes.length,
      singleSku: plan.boxes.filter((box) => box.boxType === 'SINGLE').length,
      mixedSku: plan.boxes.filter((box) => box.boxType === 'MIXED').length,
      active: plan.boxes.filter((box) => postingBoxes.has(box.boxId)).length,
      staging: plan.boxes.filter((box) => !postingBoxes.has(box.boxId)).length,
      withoutDeclaredContents: plan.boxes.filter((box) => box.skus.length === 0).length,
      missingFromRegister: plan.boxes.filter((box) => !box.foundIn.includes('register')).length,
    },
    declarations: {
      rows: plan.declarations.length,
      boxes: new Set(plan.declarations.map((entry) => entry.boxId)).size,
      conflicts: plan.declarations.filter((entry) => entry.conflictFlag).length,
      missingQuantity: plan.declarations.filter((entry) => entry.quantity === null).length,
    },
    postings: {
      transactions: plan.postings.length,
      boxes: postingBoxes.size,
      units,
      byZone: [...byZone.entries()]
        .map(([zone, entry]) => ({ zone, boxes: entry.boxes.size, units: entry.units }))
        .sort((a, b) => a.zone.localeCompare(b.zone)),
    },
    mappings: {
      imported: plan.mappings.length,
    },
    totals: {
      created:
        plan.products.length +
        plan.boxes.length +
        plan.declarations.length +
        plan.postings.length +
        plan.mappings.length,
      updated: 0,
      skipped: plan.skippedRows,
      failed: errors.length,
      warnings: warnings.length,
    },
    pool: {
      code: 'B2B',
      boxes: plan.boxes.length,
      boxesWithStock: postingBoxes.size,
      units,
    },
    verification: {
      needsVerification: plan.boxes.length,
      verified: 0,
      sourceMarkedVerified: plan.boxes.filter((box) => /verified/i.test(box.sourceVerification ?? '') && !/unverified|not verified|needs verification|pending/i.test(box.sourceVerification ?? '')).length,
    },
    issues: {
      errors: errors.length,
      warnings: warnings.length,
      byCode: [...issueCounts.entries()]
        .map(([code, entry]) => ({ code, severity: entry.severity, count: entry.count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    },
  };
}

export function parseBase64File(contentBase64: string): Buffer {
  if (!contentBase64 || contentBase64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8) {
    throw badRequest('IMPORT_FILE_INVALID', 'An .xlsx workbook up to 8 MB is required');
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(contentBase64)) {
    throw badRequest('IMPORT_FILE_INVALID', 'The uploaded workbook is not valid base64 data');
  }
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) throw badRequest('IMPORT_FILE_INVALID', 'The uploaded workbook is empty');
  if (buffer.length > MAX_FILE_BYTES) throw badRequest('IMPORT_FILE_INVALID', 'An .xlsx workbook up to 8 MB is required');
  return buffer;
}

function workbookHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface WorkbookImportInput {
  fileName: string;
  contentBase64: string;
}

export interface WorkbookImportResult {
  committed: boolean;
  job: ReturnType<typeof getWorkbookImportJob>;
  summary: Record<string, unknown>;
  issues: WorkbookIssue[];
  reconciliation?: { postedUnits: number; ledgerUnits: number; balanceUnits: number; ok: boolean };
}

export interface WorkbookImportJob {
  id: string;
  import_type: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  error_report_json: string | null;
  source_hash: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  summary: Record<string, unknown> | null;
  issues: WorkbookIssue[];
  [key: string]: unknown;
}

export function getWorkbookImportJob(db: DB, id: string): WorkbookImportJob {
  const row = db
    .prepare(
      `SELECT j.*, u.name AS created_by_name FROM import_jobs j
         LEFT JOIN users u ON u.id = j.created_by
        WHERE j.id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
  if (!row) throw badRequest('IMPORT_JOB_NOT_FOUND', 'Import job not found');
  return {
    ...(row as Record<string, unknown>),
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    issues: row.error_report_json ? JSON.parse(row.error_report_json) : [],
  } as WorkbookImportJob;
}

function countInvalidRows(issues: WorkbookIssue[]): number {
  const rows = new Set<string>();
  for (const entry of issues) {
    if (entry.severity !== 'ERROR' || entry.row === null) continue;
    rows.add(`${entry.sheet}|${entry.row}`);
  }
  return rows.size;
}

function createJob(
  db: DB,
  plan: WorkbookPlan,
  status: 'VALIDATED' | 'FAILED',
  actor: AuthUser,
): string {
  const jobId = newId();
  const summary = summarizeWorkbookPlan(plan);
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  const totalRows = plan.sheets.reduce((total, sheet) => total + sheet.dataRows, 0);
  const invalidRows = Math.max(countInvalidRows(plan.issues), errors.length > 0 ? 1 : 0);
  const validRows = Math.max(0, totalRows - invalidRows);
  const now = nowIso();
  db.prepare(
    `INSERT INTO import_jobs
      (id, import_type, file_name, status, total_rows, valid_rows, invalid_rows,
       error_report_json, source_hash, created_by, created_at, completed_at, summary_json)
     VALUES (?, 'WORKBOOK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    plan.fileName.slice(0, 200),
    status,
    totalRows,
    validRows,
    invalidRows,
    JSON.stringify(plan.issues.slice(0, 1000)),
    plan.sourceHash,
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
      products: plan.products.length,
      boxes: plan.boxes.length,
      postings: plan.postings.length,
      errors: errors.length,
      warnings: plan.issues.filter((entry) => entry.severity === 'WARNING').length,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return jobId;
}

function findExistingWorkbookImport(db: DB, hash: string): { id: string } | undefined {
  return db
    .prepare("SELECT id FROM import_jobs WHERE import_type = 'WORKBOOK' AND source_hash = ? AND status = 'IMPORTED'")
    .get(hash) as { id: string } | undefined;
}

interface CommitContext {
  db: DB;
  plan: WorkbookPlan;
  jobId: string;
  actor: AuthUser;
  warehouseId: string;
  poolId: string;
}

export function ensureZoneLocation(db: DB, warehouseId: string, zone: string | null): { id: string; code: string } {
  const code = zoneLocationCode(zone);
  const existing = db.prepare('SELECT id FROM locations WHERE code = ?').get(code) as { id: string } | undefined;
  if (existing) return { id: existing.id, code };
  const id = newId();
  db.prepare(
    `INSERT INTO locations (id, warehouse_id, code, zone, type, status, created_at)
     VALUES (?, ?, ?, ?, 'STAGING', 'ACTIVE', ?)`,
  ).run(id, warehouseId, code, zone, nowIso());
  return { id, code };
}

function commitPlan(context: CommitContext): { productIds: Map<string, string>; boxIds: Set<string> } {
  const { db, plan, jobId, actor, warehouseId, poolId } = context;
  const createdAt = nowIso();

  for (const product of plan.products) {
    const existing = db.prepare('SELECT id, name, brand FROM products WHERE sku = ?').get(product.sku) as
      | { id: string; name: string; brand: string | null }
      | undefined;
    if (existing) {
      throw conflict('IMPORT_PRODUCT_EXISTS', `SKU ${product.sku} already exists; the workbook cannot overwrite an existing product`, {
        sku: product.sku,
        existingName: existing.name,
        sourceName: product.name,
      });
    }
  }
  for (const box of plan.boxes) {
    const existing = db.prepare('SELECT id, status FROM boxes WHERE box_code = ?').get(box.boxId) as
      | { id: string; status: string }
      | undefined;
    if (existing) {
      throw conflict('IMPORT_BOX_EXISTS', `Box ${box.boxId} already exists; the workbook cannot overwrite an existing box`, {
        boxId: box.boxId,
      });
    }
  }

  const productIds = new Map<string, string>();
  const productInsert = db.prepare(
    `INSERT INTO products
      (id, sku, name, brand, category, base_uom, is_batch_tracked, is_expiry_tracked, qc_required,
       status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PIECE', 0, 0, 1, ?, ?, ?, ?)`,
  );
  const barcodeInsert = db.prepare(
    `INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
     VALUES (?, ?, ?, 'INTERNAL', 1, ?)`,
  );
  const sourceInsert = db.prepare(
    `INSERT INTO product_sources
      (product_id, source_sku, source_name, source_product_key, source_brand, source_category,
       source_pool, source_active, source_barcode, source_created_from, source_verification,
       source_notes, verification_status, source_file, source_sheet, source_row_no,
       import_job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEEDS_VERIFICATION', ?, ?, ?, ?, ?)`,
  );
  for (const product of plan.products) {
    const id = newId();
    productIds.set(product.sku, id);
    productInsert.run(
      id,
      product.sku,
      product.name,
      product.brand,
      product.category,
      product.active,
      actor.id,
      createdAt,
      createdAt,
    );
    if (product.barcode) barcodeInsert.run(newId(), id, product.barcode, createdAt);
    sourceInsert.run(
      id,
      product.sku,
      product.name,
      product.sourceProductKey,
      product.brand,
      product.category,
      product.pool,
      product.activeSource || null,
      product.barcode,
      product.createdFrom,
      product.sourceVerification,
      product.notes,
      plan.fileName.slice(0, 200),
      WORKBOOK_SHEETS.MASTER,
      product.rowNo,
      jobId,
      createdAt,
    );
  }

  const boxIds = new Set<string>();
  const boxInsert = db.prepare(
    `INSERT INTO boxes
      (id, box_code, box_type, status, warehouse_id, location_id, pool_id, created_by, created_at, notes)
     VALUES (?, ?, ?, 'STAGING', ?, ?, ?, ?, ?, ?)`,
  );
  const boxSourceInsert = db.prepare(
    `INSERT INTO box_sources
      (box_id, source_box_id, source_brand, source_zone, source_rack, source_bin, source_barcode,
       source_location_key, source_box_quantity, source_status, source_box_type, source_reference,
       transcription_confidence, source_verification, source_notes, verification_status,
       source_sheet, source_row_no, import_job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEEDS_VERIFICATION', ?, ?, ?, ?)`,
  );
  const boxEntityIds = new Map<string, string>();
  for (const box of plan.boxes) {
    const location = ensureZoneLocation(db, warehouseId, box.zone);
    const id = newId();
    boxEntityIds.set(box.boxId, id);
    boxIds.add(box.boxId);
    boxInsert.run(
      id,
      box.boxId,
      box.boxType,
      warehouseId,
      location.id,
      poolId,
      actor.id,
      createdAt,
      box.notes,
    );
    boxSourceInsert.run(
      id,
      box.boxId,
      box.brand,
      box.zone,
      box.rack,
      box.bin,
      box.barcode,
      box.sourceLocationKey,
      box.sourceQuantity,
      box.sourceStatus,
      box.sourceBoxType,
      box.sourceReference,
      box.confidence,
      box.sourceVerification,
      box.notes,
      box.sourceSheet,
      box.rowNo,
      jobId,
      createdAt,
    );
  }

  const declarationInsert = db.prepare(
    `INSERT INTO box_content_declarations
      (id, box_id, product_id, declared_quantity, unit_label, source_box_type, source_page,
       transcription_confidence, verification_notes, verification_status, conflict_flag,
       conflict_detail, source_row_no, import_job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEEDS_VERIFICATION', ?, ?, ?, ?, ?)`,
  );
  for (const declaration of plan.declarations) {
    declarationInsert.run(
      newId(),
      boxEntityIds.get(declaration.boxId),
      productIds.get(declaration.sku),
      declaration.quantity,
      declaration.unitLabel,
      declaration.sourceBoxType,
      declaration.sourcePage,
      declaration.confidence,
      declaration.notes,
      declaration.conflictFlag ? 1 : 0,
      declaration.conflictDetail,
      declaration.rowNo,
      jobId,
      createdAt,
    );
  }

  const mappingInsert = db.prepare(
    `INSERT INTO box_id_mappings (source_box_id, box_code, note, import_job_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const mapping of plan.mappings) {
    mappingInsert.run(mapping.sourceBoxId, mapping.boxCode, mapping.note, jobId, createdAt);
  }

  const rawInsert = db.prepare(
    `INSERT INTO workbook_source_rows (id, import_job_id, sheet_name, row_no, row_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const raw of plan.rawRows) {
    rawInsert.run(newId(), jobId, raw.sheet, raw.rowNo, raw.json, createdAt);
  }

  for (const posting of plan.postings) {
    const boxEntityId = boxEntityIds.get(posting.boxId);
    if (!boxEntityId) throw new Error(`Missing box entity for ${posting.boxId}`);
    const location = ensureZoneLocation(db, warehouseId, posting.zone);
    postMovement(db, {
      movementType: 'MIGRATION',
      productId: productIds.get(posting.sku)!,
      quantity: posting.quantity,
      to: {
        warehouseId,
        locationId: location.id,
        poolId,
        status: 'AVAILABLE',
        boxId: boxEntityId,
      },
      referenceType: 'WORKBOOK_IMPORT',
      referenceId: jobId,
      referenceNo: plan.fileName.slice(0, 200),
      reason: `Opening stock from ${WORKBOOK_SHEETS.UNITS} row ${posting.sourceRow}; source quantities require physical verification`,
      metadata: {
        sourceSheet: WORKBOOK_SHEETS.UNITS,
        sourceRow: posting.sourceRow,
        sourceStatus: posting.sourceStatus,
        notes: posting.notes,
        verification: 'NEEDS_VERIFICATION',
      },
      user: actor,
    });
  }

  return { productIds, boxIds };
}

function syncSkuSequence(db: DB, nextMasterSku: string): void {
  const workbookMax = Number(nextMasterSku.slice(3)) - 1;
  const row = db.prepare("SELECT value FROM sequences WHERE name = 'SKU'").get() as { value: number } | undefined;
  let existingMax = 0;
  for (const entry of db.prepare("SELECT sku FROM products WHERE sku LIKE 'AHP%'").all() as Array<{ sku: string }>) {
    if (SKU_PATTERN.test(entry.sku)) existingMax = Math.max(existingMax, productIdNumber(entry.sku));
  }
  const target = Math.max(workbookMax, existingMax, Number(row?.value ?? 0));
  if (!row) {
    db.prepare("INSERT INTO sequences (name, value) VALUES ('SKU', ?)").run(target);
  } else if (Number(row.value) < target) {
    db.prepare("UPDATE sequences SET value = ? WHERE name = 'SKU'").run(target);
  }
}

function reconcile(db: DB, plan: WorkbookPlan, jobId: string): WorkbookImportResult['reconciliation'] {
  const postedUnits = plan.postings.reduce((total, posting) => total + posting.quantity, 0);
  const ledger = db
    .prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_transactions WHERE reference_type = 'WORKBOOK_IMPORT' AND reference_id = ?")
    .get(jobId) as { n: number };
  const codes = plan.boxes.map((box) => box.boxId);
  let balanceUnits = 0;
  for (let offset = 0; offset < codes.length; offset += 400) {
    const chunk = codes.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(ib.quantity), 0) AS n
           FROM inventory_balances ib JOIN boxes b ON b.id = ib.box_id
          WHERE b.box_code IN (${placeholders})`,
      )
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

export function importAnalyzedWorkbook(
  db: DB,
  plan: WorkbookPlan,
  actor: AuthUser,
  dryRun: boolean,
): WorkbookImportResult {
  const errors = plan.issues.filter((entry) => entry.severity === 'ERROR');
  if (errors.length > 0) {
    const jobId = createJob(db, plan, 'FAILED', actor);
    return {
      committed: false,
      job: getWorkbookImportJob(db, jobId),
      summary: summarizeWorkbookPlan(plan),
      issues: plan.issues,
    };
  }
  const existing = findExistingWorkbookImport(db, plan.sourceHash);
  if (existing) {
    throw conflict('DUPLICATE_IMPORT', `This workbook was already imported as job ${existing.id}`, {
      jobId: existing.id,
    });
  }
  if (dryRun) {
    const jobId = createJob(db, plan, 'VALIDATED', actor);
    return {
      committed: false,
      job: getWorkbookImportJob(db, jobId),
      summary: summarizeWorkbookPlan(plan),
      issues: plan.issues,
    };
  }

  const jobId = createJob(db, plan, 'VALIDATED', actor);
  const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string } | undefined;
  if (!warehouse) throw badRequest('WAREHOUSE_NOT_CONFIGURED', 'The main warehouse WH1 is not configured');
  const pool = db.prepare("SELECT id FROM stock_pools WHERE code = 'B2B'").get() as { id: string } | undefined;
  if (!pool) throw badRequest('POOL_NOT_CONFIGURED', 'The B2B stock pool is not configured');

  try {
    const result = withTransaction(db, () => {
      const committed = commitPlan({
        db,
        plan,
        jobId,
        actor,
        warehouseId: warehouse.id,
        poolId: pool.id,
      });
      syncSkuSequence(db, plan.nextMasterSku);
      const summary = {
        ...summarizeWorkbookPlan(plan),
        committedAt: nowIso(),
        committedBy: { id: actor.id, name: actor.name },
      };
      const errorsNow = plan.issues.filter((entry) => entry.severity === 'ERROR').length;
      db.prepare("UPDATE import_jobs SET status = 'IMPORTED', completed_at = ?, summary_json = ?, invalid_rows = ? WHERE id = ?").run(
        nowIso(),
        JSON.stringify(summary),
        errorsNow,
        jobId,
      );
      recordAudit(db, {
        eventType: 'IMPORT_COMPLETED',
        entityType: 'IMPORT_JOB',
        entityId: jobId,
        after: {
          fileName: plan.fileName,
          sourceHash: plan.sourceHash,
          products: committed.productIds.size,
          boxes: committed.boxIds.size,
          postings: plan.postings.length,
          units: plan.postings.reduce((total, posting) => total + posting.quantity, 0),
        },
        actor: { userId: actor.id, role: actor.role },
      });
      return committed;
    });
    return {
      committed: true,
      job: getWorkbookImportJob(db, jobId),
      summary: summarizeWorkbookPlan(plan),
      issues: plan.issues,
      reconciliation: reconcile(db, plan, jobId),
    };
  } catch (error) {
    const message = (error as Error).message;
    db.prepare("UPDATE import_jobs SET status = 'FAILED', completed_at = ?, error_report_json = ? WHERE id = ?").run(
      nowIso(),
      JSON.stringify([...plan.issues.slice(0, 999), { severity: 'ERROR', code: 'IMPORT_FAILED', sheet: '', row: null, message }]),
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
    if (isConstraintViolation(error) && /source_hash|ux_import_jobs_workbook_hash/.test(message)) {
      throw conflict('DUPLICATE_IMPORT', 'Another import of this workbook completed first', { jobId });
    }
    throw error;
  }
}

export async function importWorkbook(
  db: DB,
  input: WorkbookImportInput,
  actor: AuthUser,
  options: { dryRun?: boolean; parsed?: ParsedWorkbook; hash?: string } = {},
): Promise<WorkbookImportResult> {
  const buffer = parseBase64File(input.contentBase64);
  const hash = options.hash ?? workbookHash(buffer);
  const parsed = options.parsed ?? (await parseWorkbook(buffer));
  const plan = analyzeWorkbook(parsed, input.fileName, hash);
  return importAnalyzedWorkbook(db, plan, actor, options.dryRun === true);
}
