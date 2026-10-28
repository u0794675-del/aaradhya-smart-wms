import ExcelJS from 'exceljs';

const HEADER_FILL = 'FF0E6B57';
const HEADER_TEXT = 'FFFFFFFF';

function styleHeader(row: ExcelJS.Row): void {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFD8CF' } } };
  });
}

function noteLines(sheet: ExcelJS.Worksheet, lines: string[]): void {
  let rowIndex = 1;
  sheet.getColumn(1).width = 108;
  for (const line of lines) {
    const row = sheet.getRow(rowIndex);
    row.getCell(1).value = line;
    if (rowIndex === 1) row.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF0E6B57' } };
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    rowIndex += 1;
  }
}

function finish(workbook: ExcelJS.Workbook): Promise<Buffer> {
  workbook.created = new Date();
  workbook.modified = new Date();
  return workbook.xlsx.writeBuffer().then((buffer) => Buffer.from(buffer as ArrayBuffer));
}

export async function productTemplateXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products', { properties: { defaultRowHeight: 18 } });
  const columns = [
    { header: 'name', width: 34 },
    { header: 'sku', width: 14 },
    { header: 'brand', width: 18 },
    { header: 'category', width: 18 },
    { header: 'baseuom', width: 12 },
    { header: 'isbatchtracked', width: 16 },
    { header: 'isexpirytracked', width: 16 },
    { header: 'qcrequired', width: 13 },
    { header: 'costprice', width: 12 },
    { header: 'lowstockthreshold', width: 18 },
  ];
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.header, width: column.width }));
  styleHeader(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const example = workbook.addWorksheet('Example (do not import)');
  example.columns = columns.map((column) => ({ header: column.header, key: column.header, width: column.width }));
  styleHeader(example.getRow(1));
  example.addRow(['Arnica Montana 30C', 'AHP91001', 'Aaradhya', 'Homeopathy', 'PIECE', 'TRUE', 'TRUE', 'TRUE', 45, 20]);
  example.addRow(['Calendula Cream 25g', 'AHP91002', 'Aaradhya', 'Topical', 'PIECE', 'FALSE', 'FALSE', 'TRUE', 120, 10]);
  example.views = [{ state: 'frozen', ySplit: 1 }];

  const notes = workbook.addWorksheet('Instructions');
  noteLines(notes, [
    'Product master import — how to fill this template',
    '1. Enter one product per row on the "Products" sheet. Do not rename or reorder the header row.',
    '2. name (required): full product name. sku (optional): leave blank to let the system assign AHP#### automatically.',
    '3. baseuom: PIECE, STRIP, PACK, CARTON, BOX or CASE. Default is PIECE when left blank.',
    '4. isbatchtracked / isexpirytracked / qcrequired: TRUE or FALSE. Blank counts as FALSE for tracking and TRUE for QC.',
    '5. costprice / lowstockthreshold: numbers only; leave blank when unknown.',
    '6. Save the file as .xlsx and upload it on Administration → Controlled data imports.',
    '7. The import runs all-or-nothing: if any row is invalid, nothing is written and the errors are reported.',
    'The "Example (do not import)" sheet is reference only; it is never read by the import.',
  ]);

  return finish(workbook);
}

export async function stockListTemplateXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock List', { properties: { defaultRowHeight: 18 } });
  const columns = [
    { header: 'Photo/Page', width: 22 },
    { header: 'Brand', width: 18 },
    { header: 'Product Name / SKU', width: 38 },
    { header: 'Box Quantity', width: 14 },
    { header: 'Qty per Box', width: 13 },
    { header: 'Transcription Confidence', width: 24 },
  ];
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.header, width: column.width }));
  styleHeader(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const example = workbook.addWorksheet('Example (do not import)');
  example.columns = columns.map((column) => ({ header: column.header, key: column.header, width: column.width }));
  styleHeader(example.getRow(1));
  example.addRow(['Zone B / Photo 1 - Page 1', 'Sample Brand', 'Sample Product 100ml', 2, 144, 'Medium']);
  example.addRow(['Zone B / Photo 1 - Page 1', 'Sample Brand', 'Sample Cream 25g', 1, 24, 'High']);
  example.addRow(['Zone B / Photo 2 - Page 1', 'Sample Brand', 'Sample Syrup 200ml', 3, 12, 'Low']);
  example.views = [{ state: 'frozen', ySplit: 1 }];

  const notes = workbook.addWorksheet('Instructions');
  noteLines(notes, [
    'Brand stock list import — how to fill this template',
    '1. One row per photographed/transcribed source line on the "Stock List" sheet. The header row may sit on row 1 or below a title row.',
    '2. Brand (required): the brand for every product. If the whole file is one brand, you can also type the brand on the import screen and leave this blank.',
    '3. Product Name / SKU (required): product name as printed on the box. The same name is merged into one SKU across rows.',
    '4. Box Quantity (required): how many identical boxes this line represents. Each box is created as a separate box record.',
    '5. Qty per Box (required): units inside one box. Total stock = Box Quantity × Qty per Box. Each box keeps its own declared count.',
    '6. Transcription Confidence (optional): High / Medium / Low. Every imported product and box is marked Needs Verification regardless.',
    '7. Importing a stock list never replays picking or putaway. Stock is posted once as a MIGRATION opening-stock movement into the chosen zone location (B2B pool).',
    '8. Importing the same file twice is rejected. A different file is required for corrections or additional zones/brands.',
    'The "Example (do not import)" sheet is reference only; it is never read by the import.',
  ]);

  return finish(workbook);
}
