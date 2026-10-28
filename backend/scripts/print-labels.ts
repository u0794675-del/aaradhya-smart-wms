import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const { BinaryBitmap, Code128Reader, HybridBinarizer, RGBLuminanceSource } =
  require('@zxing/library') as typeof import('@zxing/library');

// Standard Code 128 symbol table (values 0-106; index 106 is the stop pattern).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

function code128Modules(text: string): boolean[] {
  const values: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`Code 128B cannot encode "${char}" in ${text}`);
    values.push(code - 32);
  }
  let checksum = START_B;
  values.forEach((value, index) => {
    checksum += value * (index + 1);
  });
  const symbols = [START_B, ...values, checksum % 103, STOP];

  const modules: boolean[] = [];
  for (const symbol of symbols) {
    const pattern = PATTERNS[symbol];
    if (!pattern) throw new Error(`Missing Code 128 pattern ${symbol}`);
    for (let i = 0; i < pattern.length; i += 1) {
      const width = Number(pattern[i]);
      for (let j = 0; j < width; j += 1) modules.push(i % 2 === 0);
    }
  }
  return modules;
}

function decodeCheck(text: string, modules: boolean[]): boolean {
  const scale = 2;
  const quiet = 10;
  const height = 48;
  const width = (modules.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(width * height);
  pixels.fill(255);
  modules.forEach((bar, index) => {
    if (!bar) return;
    const start = (index + quiet) * scale;
    for (let y = 0; y < height; y += 1) {
      for (let x = start; x < start + scale; x += 1) {
        pixels[y * width + x] = 0;
      }
    }
  });
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)));
  const result = new Code128Reader().decode(bitmap);
  return result.getText() === text;
}

type Label = { code: string; title: string; meta: string };

const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'wms.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const boxes = db
  .prepare("SELECT box_code, box_type FROM boxes WHERE retired_at IS NULL ORDER BY box_code")
  .all() as Array<{ box_code: string; box_type: string }>;
const locations = db
  .prepare('SELECT code, zone, type FROM locations ORDER BY code')
  .all() as Array<{ code: string; zone: string; type: string }>;
db.close();

if (boxes.length === 0) throw new Error('No active boxes found');

const codes = [...boxes.map((box) => box.box_code), ...locations.map((location) => location.code)];
for (const code of codes) {
  if (!decodeCheck(code, code128Modules(code))) {
    throw new Error(`Barcode self-check failed for ${code}`);
  }
}

const boxLabels: Label[] = boxes.map((box) => ({
  code: box.box_code,
  title: 'BOX LABEL',
  meta: `WH1 · ${box.box_type}`,
}));
const locationLabels: Label[] = locations.map((location) => ({
  code: location.code,
  title: 'LOCATION',
  meta: `${location.zone} · ${location.type}`,
}));

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const COLS = 3;
const ROWS = 8;
const CELL_W = PAGE_W / COLS;
const CELL_H = PAGE_H / ROWS;
const PAD = 9;
const PER_SHEET = COLS * ROWS;

const doc = new PDFDocument({
  size: 'A4',
  margin: 0,
  autoFirstPage: false,
  compress: false,
  info: {
    Title: 'Aaradhya WMS box and location labels',
    Author: 'Aaradhya Homeopathic Pvt. Ltd.',
    Subject: 'Scannable Code 128 labels for boxes and storage locations',
    Creator: 'Aaradhya Smart WMS',
    CreationDate: new Date(),
  },
});
const chunks: Buffer[] = [];
doc.on('data', (chunk: Buffer) => chunks.push(chunk));
const finished = new Promise<Buffer>((resolve, reject) => {
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

function drawLabel(slot: number, label: Label) {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  const x = col * CELL_W;
  const y = row * CELL_H;

  doc.save();
  doc.lineWidth(0.5).strokeColor('#CBD5D1').dash(2, { space: 2 });
  doc.rect(x, y, CELL_W, CELL_H).stroke();
  doc.undash();
  doc.restore();

  doc.fillColor('#46584F').font('Helvetica').fontSize(5.6);
  doc.text('AARADHYA WMS', x + PAD, y + PAD, { width: CELL_W - PAD * 2 });
  doc.text(label.title, x + PAD, y + PAD, { width: CELL_W - PAD * 2, align: 'right' });

  const modules = code128Modules(label.code);
  const quiet = 10;
  const maxWidth = CELL_W - PAD * 2;
  const moduleWidth = Math.min(maxWidth / (modules.length + quiet * 2), 1.1);
  const barWidth = modules.length * moduleWidth;
  const barX = x + (CELL_W - barWidth) / 2;
  const barY = y + PAD + 12;
  const barHeight = 42;
  doc.fillColor('#000000');
  modules.forEach((bar, index) => {
    if (!bar) return;
    doc.rect(barX + index * moduleWidth, barY, moduleWidth, barHeight).fill();
  });

  const textY = barY + barHeight + 6;
  doc.fillColor('#101815').font('Helvetica-Bold').fontSize(13);
  doc.text(label.code, x + PAD, textY, { width: CELL_W - PAD * 2, align: 'center' });
  doc.fillColor('#5B6B63').font('Helvetica').fontSize(6.4);
  doc.text(label.meta, x + PAD, textY + 16, { width: CELL_W - PAD * 2, align: 'center', lineBreak: false });
}

function renderSheet(labels: Label[], sheetIndex: number) {
  doc.addPage({ size: 'A4', margin: 0 });
  labels.forEach((label, slot) => drawLabel(slot, label));
  doc.fillColor('#94A3A0').font('Helvetica').fontSize(5.5);
  doc.text(
    `Aaradhya Smart WMS · ${sheetIndex}`,
    0,
    PAGE_H - 8,
    { width: PAGE_W, align: 'center' },
  );
}

const sheets: Label[][] = [];
for (let index = 0; index < boxLabels.length; index += PER_SHEET) {
  sheets.push(boxLabels.slice(index, index + PER_SHEET));
}
for (let index = 0; index < locationLabels.length; index += PER_SHEET) {
  sheets.push(locationLabels.slice(index, index + PER_SHEET));
}
sheets.forEach((labels, index) => renderSheet(labels, index + 1));

doc.end();
const pdf = await finished;

const dir = path.resolve(process.cwd(), 'data', 'exports');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const file = path.join(dir, `labels-${stamp}.pdf`);
fs.writeFileSync(file, pdf);

console.log(`Verified ${codes.length}/${codes.length} barcodes with the reference decoder`);
console.log(`Box labels: ${boxLabels.length}, location labels: ${locationLabels.length}, sheets: ${sheets.length}`);
console.log(`PDF: ${file}`);
