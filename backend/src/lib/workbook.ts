import readXlsxFile from 'read-excel-file/node';

export type WorkbookCell = string | number | boolean | Date | null | undefined;

export interface ParsedSheet {
  name: string;
  rows: WorkbookCell[][];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  sheetNames: string[];
}

export const WORKBOOK_SHEETS = {
  MASTER: 'Master SKU',
  REGISTER: 'B2B Box Register',
  CONTENTS: 'B2B Box Contents',
  UNITS: 'B2B Unit Stock Ledger',
  STOCK: 'B2B Stock Ledger',
  PICKING: 'Picking Log',
  PUTAWAY: 'Putaway Log',
  MAPPING: 'Box ID Mapping',
  LISTS: 'Lists',
  SOURCE_REVIEW: 'Source Review',
} as const;

export const REQUIRED_WORKBOOK_SHEETS = [
  WORKBOOK_SHEETS.MASTER,
  WORKBOOK_SHEETS.REGISTER,
  WORKBOOK_SHEETS.CONTENTS,
  WORKBOOK_SHEETS.UNITS,
  WORKBOOK_SHEETS.STOCK,
  WORKBOOK_SHEETS.MAPPING,
] as const;

export async function parseWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const sheets = await readXlsxFile(buffer, { trim: true });
  return {
    sheets: sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data as WorkbookCell[][] })),
    sheetNames: sheets.map((sheet) => sheet.sheet),
  };
}

export function cellText(value: WorkbookCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

export function rowHasData(row: WorkbookCell[] | undefined): boolean {
  return Array.isArray(row) && row.some((cell) => cellText(cell) !== '');
}

export function rawRowJson(row: WorkbookCell[]): string {
  return JSON.stringify(
    row.map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (cell instanceof Date) return cell.toISOString();
      return cell;
    }),
  );
}
