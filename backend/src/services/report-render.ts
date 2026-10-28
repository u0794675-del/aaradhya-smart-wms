import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import type { DB } from '../db/index.ts';
import { addDays, nowIso, todayIso } from '../lib/time.ts';
import { badRequest } from '../lib/errors.ts';
import { expiryReport, movementReport, stockSummary } from './operations.ts';
import type { AuthUser } from './auth.ts';
import type { ReportBranding, ReportTemplate } from './report-security.ts';

export type ReportType = 'STOCK_SUMMARY' | 'MOVEMENTS' | 'EXPIRY';
export type ReportFormat = 'PDF' | 'XLSX' | 'CSV';

export interface ExportParams {
  search?: string;
  category?: string;
  from?: string;
  to?: string;
}

interface ReportColumn {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  format?: 'number' | 'money' | 'text';
}

interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
}

interface ReportStat {
  label: string;
  value: string;
}

export interface ReportModel {
  type: ReportType;
  title: string;
  subtitle: string;
  periodLabel: string | null;
  filters: string[];
  generatedAt: string;
  generatedBy: string;
  stats: ReportStat[];
  tables: ReportTable[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return value;
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

const istFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${istFormatter.format(date)} IST`;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberText(value: unknown): string {
  return number(value).toLocaleString('en-IN');
}

function moneyText(value: unknown): string {
  return `INR ${number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cellText(column: ReportColumn, value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (column.format === 'money') return moneyText(value);
  if (column.format === 'number' || typeof value === 'number') return numberText(value);
  return String(value);
}

export function buildReportModel(
  db: DB,
  user: AuthUser,
  type: ReportType,
  params: ExportParams,
): ReportModel {
  const generatedAt = nowIso();
  const base = {
    type,
    generatedAt,
    generatedBy: user.name,
  };

  if (type === 'STOCK_SUMMARY') {
    const rows = stockSummary(db, { search: params.search, category: params.category });
    const includeCost = user.permissions.includes('product.cost.read');
    const totals = rows.reduce(
      (sum, row) => ({
        onHand: sum.onHand + number(row.on_hand),
        available: sum.available + number(row.available),
        nonSellable: sum.nonSellable + number(row.non_sellable),
        stockValue: sum.stockValue + number(row.stock_value),
      }),
      { onHand: 0, available: 0, nonSellable: 0, stockValue: 0 },
    );
    const filters: string[] = [];
    if (params.search) filters.push(`Search: ${params.search}`);
    if (params.category) filters.push(`Category: ${params.category}`);
    const stats: ReportStat[] = [
      { label: 'Products', value: numberText(rows.length) },
      { label: 'On hand units', value: numberText(totals.onHand) },
      { label: 'Available units', value: numberText(totals.available) },
      { label: 'Non-sellable', value: numberText(totals.nonSellable) },
    ];
    if (includeCost) stats.push({ label: 'Stock value', value: moneyText(totals.stockValue) });

    const columns: ReportColumn[] = [
      { key: 'sku', header: 'SKU', width: 62 },
      { key: 'product', header: 'Product', width: 110 },
      { key: 'category', header: 'Category', width: 56 },
      { key: 'uom', header: 'UOM', width: 36 },
      { key: 'on_hand', header: 'On hand', width: 44, align: 'right', format: 'number' },
      { key: 'available', header: 'Available', width: 48, align: 'right', format: 'number' },
      { key: 'reserved', header: 'Reserved', width: 46, align: 'right', format: 'number' },
      { key: 'non_sellable', header: 'Non-sellable', width: 54, align: 'right', format: 'number' },
      { key: 'expired', header: 'Expired', width: 38, align: 'right', format: 'number' },
    ];
    if (includeCost) {
      columns.push({ key: 'stock_value', header: 'Stock value', width: 66, align: 'right', format: 'money' });
    }
    const tableRows = rows.map((row) => ({
      sku: row.sku,
      product: row.name,
      category: row.category ?? '-',
      uom: row.base_uom,
      on_hand: number(row.on_hand),
      available: number(row.available),
      reserved: number(row.reserved),
      non_sellable: number(row.non_sellable),
      expired: number(row.expired),
      stock_value: includeCost ? number(row.stock_value) : null,
    }));
    return {
      ...base,
      title: 'Stock summary',
      subtitle: 'Canonical product balances computed from the inventory ledger. Quantities are base units.',
      periodLabel: `As of ${formatDay(todayIso())}`,
      filters,
      stats,
      tables: [{ title: 'Balances by product', columns, rows: tableRows }],
    };
  }

  if (type === 'MOVEMENTS') {
    const to = params.to ?? todayIso();
    const from = params.from ?? addDays(-13).slice(0, 10);
    if (from > to) throw badRequest('REPORT_RANGE_INVALID', 'The start date must be on or before the end date');
    const report = movementReport(db, from, to);
    const rows = report.rows;
    const totals = rows.reduce(
      (sum, row) => ({ count: sum.count + number(row.count), quantity: sum.quantity + number(row.quantity) }),
      { count: 0, quantity: 0 },
    );
    const typeTotals = new Map<string, { count: number; quantity: number }>();
    for (const row of rows) {
      const key = String(row.movement_type);
      const entry = typeTotals.get(key) ?? { count: 0, quantity: 0 };
      entry.count += number(row.count);
      entry.quantity += number(row.quantity);
      typeTotals.set(key, entry);
    }
    const typeRows = [...typeTotals.entries()]
      .map(([movementType, value]) => ({
        movement_type: movementType.replace(/_/g, ' '),
        count: value.count,
        quantity: value.quantity,
        share: totals.quantity ? `${Math.round((value.quantity / totals.quantity) * 100)}%` : '0%',
      }))
      .sort((left, right) => right.quantity - left.quantity);
    const dayRows = report.days.map((day) => ({
      day: formatDay(day.day),
      transactions: day.count,
      quantity: day.quantity,
      mix: Object.entries(day.byType)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([movementType, quantity]) => `${movementType.replace(/_/g, ' ')} ${numberText(quantity)}`)
        .join(', '),
    }));
    return {
      ...base,
      title: 'Movement report',
      subtitle: 'Posted inventory transactions by day and movement type. Reversals appear as separate linked movements.',
      periodLabel: `${formatDay(from)} to ${formatDay(to)}`,
      filters: [],
      stats: [
        { label: 'Transactions', value: numberText(totals.count) },
        { label: 'Units moved', value: numberText(totals.quantity) },
        { label: 'Active days', value: numberText(report.days.length) },
        { label: 'Movement types', value: numberText(typeRows.length) },
      ],
      tables: [
        {
          title: 'Daily activity',
          columns: [
            { key: 'day', header: 'Day', width: 90 },
            { key: 'transactions', header: 'Transactions', width: 90, align: 'right', format: 'number' },
            { key: 'quantity', header: 'Units moved', width: 90, align: 'right', format: 'number' },
            { key: 'mix', header: 'Movement mix', width: 253 },
          ],
          rows: dayRows,
        },
        {
          title: 'By movement type',
          columns: [
            { key: 'movement_type', header: 'Movement type', width: 180 },
            { key: 'count', header: 'Transactions', width: 110, align: 'right', format: 'number' },
            { key: 'quantity', header: 'Units moved', width: 110, align: 'right', format: 'number' },
            { key: 'share', header: 'Share of units', width: 123, align: 'right' },
          ],
          rows: typeRows,
        },
      ],
    };
  }

  const report = expiryReport(db);
  const batches = report.batches as Array<Record<string, any> & { quantity: number; daysLeft: number | null }>;
  return {
    ...base,
    title: 'Expiry report',
    subtitle: 'Available batches grouped by remaining shelf life. Only batches with available stock are included.',
    periodLabel: `As of ${formatDay(report.asOf)}`,
    filters: [],
    stats: report.buckets.map((bucket) => ({
      label: bucket.label,
      value: numberText(bucket.quantity),
    })),
    tables: [
      {
        title: 'Batches by expiry',
        columns: [
          { key: 'batch_no', header: 'Batch', width: 86 },
          { key: 'sku', header: 'SKU', width: 70 },
          { key: 'product', header: 'Product', width: 165 },
          { key: 'expiry_date', header: 'Expiry', width: 70 },
          { key: 'days_left', header: 'Days left', width: 62, align: 'right' },
          { key: 'quantity', header: 'Available', width: 70, align: 'right', format: 'number' },
        ],
        rows: batches.map((batch) => ({
          batch_no: batch.batch_no,
          sku: batch.sku,
          product: batch.name,
          expiry_date: batch.expiry_date ?? '-',
          days_left:
            batch.daysLeft === null
              ? '-'
              : batch.daysLeft < 0
                ? `${Math.abs(batch.daysLeft)} overdue`
                : String(batch.daysLeft),
          quantity: number(batch.quantity),
        })),
      },
    ],
  };
}

export function renderCsv(model: ReportModel): Buffer {
  const table = model.tables[0];
  if (!table) return Buffer.from('\n');
  const lines = [table.columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';
const SOFT = '#F8FAFC';

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  return [
    Number.parseInt(cleaned.slice(0, 2), 16),
    Number.parseInt(cleaned.slice(2, 4), 16),
    Number.parseInt(cleaned.slice(4, 6), 16),
  ];
}

export function tint(hex: string, ratio: number): string {
  const [red, green, blue] = hexToRgb(hex);
  const mix = (value: number) => Math.round(value + (255 - value) * ratio);
  return `#${[mix(red), mix(green), mix(blue)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function logoBuffer(branding: ReportBranding): Buffer | null {
  if (!branding.logoDataUrl) return null;
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(branding.logoDataUrl);
  if (!match) return null;
  return Buffer.from(match[2], 'base64');
}

const PAGE_MARGIN = 36;
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2;
const FOOTER_SPACE = 24;

export const PDF_CONTENT_WIDTH = CONTENT_WIDTH;

export interface TableLayout {
  columns: ReportColumn[];
  padding: number;
  headerFontSize: number;
  bodyFontSize: number;
}

// Wide models (the stock summary has ten columns) describe more width than the
// A4 printable area. Scale every column to the page instead of letting the last
// column spill past the margin, and tighten type for dense tables.
export function layoutTable(columns: ReportColumn[], availableWidth = CONTENT_WIDTH): TableLayout {
  const dense = columns.length > 8;
  const padding = dense ? 4 : 5;
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  let fitted = columns;
  if (total > availableWidth + 0.01) {
    const scale = availableWidth / total;
    let used = 0;
    fitted = columns.map((column, index) => {
      const width =
        index === columns.length - 1
          ? Math.round((availableWidth - used) * 100) / 100
          : Math.round(column.width * scale * 100) / 100;
      used += width;
      return { ...column, width };
    });
  }
  return {
    columns: fitted,
    padding,
    headerFontSize: dense ? 7 : 7.5,
    bodyFontSize: dense ? 7.2 : 7.5,
  };
}

function drawWatermark(doc: PDFKit.PDFDocument, branding: ReportBranding): void {
  const text = branding.watermarkText?.trim();
  if (!text) return;
  const opacity = Math.min(0.5, Math.max(0.02, branding.watermarkOpacity));
  doc.save();
  doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.font('Helvetica-Bold').fillColor(branding.primaryColor).opacity(opacity);
  const label = text.toUpperCase();
  let size = 58;
  doc.fontSize(size);
  while (size > 18 && doc.widthOfString(label) > doc.page.width * 0.92) {
    size -= 2;
    doc.fontSize(size);
  }
  doc.text(label, 0, doc.page.height / 2 - size / 2, {
    width: doc.page.width,
    align: 'center',
    lineBreak: false,
  });
  doc.restore();
  doc.opacity(1).fillColor(INK);
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  model: ReportModel,
  branding: ReportBranding,
  compact: boolean,
): void {
  const template: ReportTemplate = branding.template;
  const logo = logoBuffer(branding);
  const left = PAGE_MARGIN;
  const width = CONTENT_WIDTH;
  const top = PAGE_MARGIN;

  if (template === 'EXECUTIVE') {
    const bandHeight = compact ? 38 : 68;
    doc.save();
    doc.rect(left, top, width, bandHeight).fill(branding.primaryColor);
    doc.restore();
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(compact ? 11 : 16);
    doc.text(branding.companyName, left + 14, top + (compact ? 13 : 14), {
      width: width - (logo ? 140 : 28),
      lineBreak: false,
      ellipsis: true,
    });
    if (!compact && branding.tagline) {
      doc.font('Helvetica').fontSize(8).fillColor(tint(branding.primaryColor, 0.72));
      doc.text(branding.tagline, left + 14, top + 38, { width: width - (logo ? 140 : 28), lineBreak: false });
    }
    if (logo) {
      try {
        doc.image(logo, left + width - 126, top + 8, { fit: [112, bandHeight - 16], align: 'right', valign: 'center' });
      } catch {
        // A corrupt logo must not prevent the report from being generated.
      }
    }
    doc.fillColor(INK);
    let y = top + bandHeight + 14;
    if (!compact) {
      doc.font('Helvetica-Bold').fontSize(19).fillColor(INK);
      doc.text(model.title, left, y, { width, lineBreak: false });
      y += 24;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
      doc.text(model.subtitle, left, y, { width, lineBreak: false, ellipsis: true });
      y += 16;
      const meta = [
        model.periodLabel,
        `Generated ${formatDateTime(model.generatedAt)}`,
        `By ${model.generatedBy}`,
        ...model.filters,
      ]
        .filter(Boolean)
        .join('   |   ');
      doc.fontSize(7.5).fillColor(MUTED).text(meta, left, y, { width, lineBreak: false, ellipsis: true });
      y += 12;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(branding.accentColor).stroke();
      y += 12;
    } else {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
      doc.text(model.title, left, y, { width: width - 120, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(model.periodLabel ?? '', left + width - 180, y + 1, { width: 180, align: 'right', lineBreak: false });
      y += 16;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.7).strokeColor(LINE).stroke();
      y += 8;
    }
    doc.y = y;
    return;
  }

  if (template === 'CLASSIC') {
    doc.fillColor(INK).font('Times-Bold').fontSize(compact ? 12 : 17);
    doc.text(branding.companyName, left, top, { width: width - (logo ? 110 : 0), align: compact ? 'left' : 'center' });
    if (!compact) {
      if (branding.tagline) {
        doc.font('Times-Roman').fontSize(8.5).fillColor(MUTED);
        doc.text(branding.tagline, left, doc.y + 2, { width: width - (logo ? 110 : 0), align: 'center' });
      }
      const details = [branding.addressLine, branding.contactLine].filter(Boolean).join('  |  ');
      if (details) {
        doc.font('Times-Roman').fontSize(7.5).fillColor(MUTED);
        doc.text(details, left, doc.y + 3, { width, align: 'center' });
      }
    }
    if (logo) {
      try {
        doc.image(logo, left + width - 96, top, { fit: [96, 44], align: 'right', valign: 'center' });
      } catch {
        // keep the text header if the image cannot be decoded
      }
    }
    let y = Math.max(doc.y + 8, top + 48);
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.4).strokeColor(branding.primaryColor).stroke();
    doc.moveTo(left, y + 3).lineTo(left + width, y + 3).lineWidth(0.5).strokeColor(branding.accentColor).stroke();
    y += 12;
    doc.fillColor(INK).font('Times-Bold').fontSize(compact ? 10 : 18);
    doc.text(model.title, left, y, { width, align: 'center', lineBreak: false });
    y += compact ? 16 : 24;
    if (!compact) {
      doc.font('Times-Roman').fontSize(8.5).fillColor(MUTED);
      doc.text(model.subtitle, left, y, { width, align: 'center', lineBreak: false, ellipsis: true });
      y += 15;
      const meta = [
        model.periodLabel,
        `Generated ${formatDateTime(model.generatedAt)}`,
        `By ${model.generatedBy}`,
        ...model.filters,
      ]
        .filter(Boolean)
        .join('   |   ');
      doc.fontSize(7.5).text(meta, left, y, { width, align: 'center', lineBreak: false, ellipsis: true });
      y += 14;
    }
    doc.y = y;
    return;
  }

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(compact ? 11 : 12);
  doc.text(branding.companyName, left, top, { width: width - (logo ? 110 : 0), lineBreak: false, ellipsis: true });
  if (logo) {
    try {
      doc.image(logo, left + width - 90, top - 2, { fit: [90, 34], align: 'right', valign: 'center' });
    } catch {
      // ignore unusable logo bytes
    }
  }
  let y = top + 20;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.8).strokeColor(branding.primaryColor).stroke();
  y += 12;
  doc.font('Helvetica-Bold').fontSize(compact ? 10 : 18).fillColor(INK);
  doc.text(model.title, left, y, { width, lineBreak: false });
  y += compact ? 15 : 24;
  if (!compact) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    doc.text(model.subtitle, left, y, { width, lineBreak: false, ellipsis: true });
    y += 15;
    const meta = [
      model.periodLabel,
      `Generated ${formatDateTime(model.generatedAt)}`,
      `By ${model.generatedBy}`,
      ...model.filters,
    ]
      .filter(Boolean)
      .join('   |   ');
    doc.fontSize(7.5).text(meta, left, y, { width, lineBreak: false, ellipsis: true });
    y += 12;
  }
  doc.y = y;
}

export async function renderPdf(model: ReportModel, branding: ReportBranding): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    bufferPages: true,
    compress: false,
    info: {
      Title: `${model.title} - ${branding.companyName}`,
      Author: branding.companyName,
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

  drawWatermark(doc, branding);
  drawHeader(doc, model, branding, false);

  const bottomLimit = () => doc.page.height - PAGE_MARGIN - FOOTER_SPACE;
  const newPage = () => {
    doc.addPage();
    drawWatermark(doc, branding);
    drawHeader(doc, model, branding, true);
  };
  const ensureSpace = (height: number) => {
    if (doc.y + height > bottomLimit()) newPage();
  };

  function drawStats(stats: ReportStat[]): void {
    if (!stats.length) return;
    const gap = 8;
    const columns = 4;
    const boxWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
    const boxHeight = 44;
    for (let index = 0; index < stats.length; index += columns) {
      ensureSpace(boxHeight + 12);
      const slice = stats.slice(index, index + columns);
      const top = doc.y;
      slice.forEach((stat, offset) => {
        const x = PAGE_MARGIN + offset * (boxWidth + gap);
        doc.save();
        doc.roundedRect(x, top, boxWidth, boxHeight, 4).fill(tint(branding.primaryColor, 0.9));
        doc.rect(x, top, 3, boxHeight).fill(branding.primaryColor);
        doc.restore();
        doc.fillColor(MUTED).font('Helvetica').fontSize(7);
        doc.text(stat.label.toUpperCase(), x + 10, top + 9, { width: boxWidth - 18, lineBreak: false, ellipsis: true });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(12);
        doc.text(stat.value, x + 10, top + 21, { width: boxWidth - 18, lineBreak: false, ellipsis: true });
      });
      doc.y = top + boxHeight + 12;
    }
  }

  function drawTableHeader(table: ReportTable, layout: TableLayout, showTitle: boolean): void {
    if (showTitle) {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
      doc.text(table.title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineBreak: false });
      doc.y += 18;
    }
    const headerHeight = 22;
    const top = doc.y;
    doc.save();
    doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, headerHeight).fill(branding.primaryColor);
    doc.restore();
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(layout.headerFontSize);
    let x = PAGE_MARGIN;
    for (const column of layout.columns) {
      doc.text(column.header, x + layout.padding, top + 7, {
        width: column.width - layout.padding * 2,
        align: column.align ?? 'left',
        lineBreak: false,
        ellipsis: true,
      });
      x += column.width;
    }
    doc.y = top + headerHeight;
  }

  function drawTable(table: ReportTable): void {
    const layout = layoutTable(table.columns);
    ensureSpace(60);
    drawTableHeader(table, layout, true);
    const rowHeight = 20;
    if (!table.rows.length) {
      ensureSpace(rowHeight + 8);
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8);
      doc.text('No rows for the selected filters.', PAGE_MARGIN + 5, doc.y + 8, { width: CONTENT_WIDTH - 10 });
      doc.y += rowHeight + 8;
      return;
    }
    table.rows.forEach((row, index) => {
      if (doc.y + rowHeight > bottomLimit()) {
        newPage();
        drawTableHeader(table, layout, true);
      }
      const top = doc.y;
      if (index % 2 === 0) {
        doc.save();
        doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, rowHeight).fill(SOFT);
        doc.restore();
      }
      doc.save();
      doc.moveTo(PAGE_MARGIN, top + rowHeight).lineTo(PAGE_MARGIN + CONTENT_WIDTH, top + rowHeight);
      doc.lineWidth(0.4).strokeColor(LINE).stroke();
      doc.restore();
      doc.fillColor(INK).font('Helvetica').fontSize(layout.bodyFontSize);
      let x = PAGE_MARGIN;
      for (const column of layout.columns) {
        doc.text(cellText(column, row[column.key]), x + layout.padding, top + 6, {
          width: column.width - layout.padding * 2,
          align: column.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
        x += column.width;
      }
      doc.y = top + rowHeight;
    });
    doc.y += 14;
  }

  drawStats(model.stats);
  for (const table of model.tables) drawTable(table);

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const page = doc.page;
    const previousBottom = page.margins.bottom;
    page.margins.bottom = 0;
    doc.moveTo(PAGE_MARGIN, page.height - 28).lineTo(page.width - PAGE_MARGIN, page.height - 28);
    doc.lineWidth(0.5).strokeColor(LINE).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.8);
    doc.text(branding.footerNote ?? branding.companyName, PAGE_MARGIN, page.height - 22, {
      width: CONTENT_WIDTH - 120,
      lineBreak: false,
      ellipsis: true,
    });
    doc.text(`Page ${index + 1} of ${range.count}`, page.width - PAGE_MARGIN - 100, page.height - 22, {
      width: 100,
      align: 'right',
      lineBreak: false,
    });
    page.margins.bottom = previousBottom;
  }

  doc.end();
  return finished;
}

function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

function excelColumnWidth(pdfWidth: number): number {
  return Math.max(9, Math.round(pdfWidth / 6.4));
}

export async function renderExcel(model: ReportModel, branding: ReportBranding): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = branding.companyName;
  workbook.company = branding.companyName;
  workbook.created = new Date(model.generatedAt);
  workbook.modified = new Date();
  const logo = logoBuffer(branding);

  const sheetName = (title: string) =>
    title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';

  model.tables.forEach((table, tableIndex) => {
    const sheet = workbook.addWorksheet(sheetName(table.title), {
      properties: { defaultRowHeight: 18 },
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.3, right: 0.3, top: 0.6, bottom: 0.5, header: 0.3, footer: 0.3 },
      },
      headerFooter: {
        oddHeader: branding.watermarkText
          ? `&C&KBFBFBF&"Arial,Italic"&16${branding.watermarkText.toUpperCase()}`
          : undefined,
        oddFooter: `&L${branding.footerNote ?? branding.companyName}&RPage &P of &N`,
      },
      views: [],
    });
    const columnCount = Math.max(8, table.columns.length);
    for (let index = 0; index < columnCount; index += 1) {
      sheet.getColumn(index + 1).width = excelColumnWidth(table.columns[index]?.width ?? 60);
    }

    const merge = (row: number, start: number, end: number) => {
      if (end > start) sheet.mergeCells(row, start, row, end);
      return sheet.getCell(row, start);
    };

    let rowIndex = 1;
    const company = merge(rowIndex, 1, columnCount - 2);
    company.value = branding.companyName;
    company.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    company.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    company.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(branding.primaryColor) } };
    sheet.getRow(rowIndex).height = 30;
    for (let col = 1; col <= columnCount; col += 1) {
      sheet.getCell(rowIndex, col).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: argb(branding.primaryColor) },
      };
    }
    if (logo && branding.logoMime) {
      try {
        const imageId = workbook.addImage({
          base64: branding.logoDataUrl!,
          extension: branding.logoMime === 'image/png' ? 'png' : 'jpeg',
        });
        sheet.addImage(imageId, {
          tl: { col: columnCount - 2, row: 0 },
          ext: { width: 100, height: 34 },
          editAs: 'oneCell',
        });
      } catch {
        // keep the text header when the logo cannot be embedded
      }
    }

    rowIndex += 1;
    if (branding.tagline || branding.addressLine || branding.contactLine) {
      const details = merge(rowIndex, 1, columnCount);
      details.value = [branding.tagline, branding.addressLine, branding.contactLine].filter(Boolean).join('  |  ');
      details.font = { name: 'Arial', size: 8, color: { argb: 'FF475569' } };
      details.alignment = { horizontal: 'left', indent: 1 };
      sheet.getRow(rowIndex).height = 18;
      rowIndex += 1;
    }

    if (branding.watermarkText) {
      const watermark = merge(rowIndex, 1, columnCount);
      watermark.value = branding.watermarkText.toUpperCase();
      watermark.font = { name: 'Arial', size: 22, italic: true, color: { argb: 'FFDCE5E3' } };
      watermark.alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getRow(rowIndex).height = 30;
      rowIndex += 1;
    }

    const title = merge(rowIndex, 1, columnCount);
    title.value = model.title;
    title.font = { name: 'Arial', size: 14, bold: true, color: { argb: argb(INK) } };
    title.alignment = { horizontal: 'left', indent: 1 };
    sheet.getRow(rowIndex).height = 24;
    rowIndex += 1;

    const meta = [
      model.periodLabel,
      model.subtitle,
      `Generated ${formatDateTime(model.generatedAt)} by ${model.generatedBy}`,
      ...model.filters,
    ]
      .filter(Boolean)
      .join('   |   ');
    const metaCell = merge(rowIndex, 1, columnCount);
    metaCell.value = meta;
    metaCell.font = { name: 'Arial', size: 8, color: { argb: 'FF64748B' } };
    metaCell.alignment = { horizontal: 'left', indent: 1, wrapText: false };
    sheet.getRow(rowIndex).height = 16;
    rowIndex += 2;

    if (tableIndex === 0 && model.stats.length) {
      const span = Math.max(1, Math.floor(columnCount / 4));
      for (let index = 0; index < model.stats.length; index += 4) {
        const slice = model.stats.slice(index, index + 4);
        const labelRow = rowIndex;
        const valueRow = rowIndex + 1;
        slice.forEach((stat, offset) => {
          const start = 1 + offset * span;
          const end = Math.min(columnCount, start + span - 1);
          const label = merge(labelRow, start, end);
          label.value = stat.label.toUpperCase();
          label.font = { name: 'Arial', size: 7, color: { argb: 'FF64748B' } };
          label.alignment = { horizontal: 'left', indent: 1 };
          label.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F4' } };
          const value = merge(valueRow, start, end);
          value.value = stat.value;
          value.font = { name: 'Arial', size: 12, bold: true, color: { argb: argb(INK) } };
          value.alignment = { horizontal: 'left', indent: 1 };
          value.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F4' } };
        });
        sheet.getRow(labelRow).height = 16;
        sheet.getRow(valueRow).height = 22;
        rowIndex += 2;
      }
      rowIndex += 1;
    }

    if (model.tables.length > 1) {
      const tableTitle = merge(rowIndex, 1, columnCount);
      tableTitle.value = table.title;
      tableTitle.font = { name: 'Arial', size: 11, bold: true, color: { argb: argb(INK) } };
      tableTitle.alignment = { horizontal: 'left', indent: 1 };
      sheet.getRow(rowIndex).height = 20;
      rowIndex += 1;
    }

    const headerRow = sheet.getRow(rowIndex);
    table.columns.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.header;
      cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(branding.primaryColor) } };
      cell.alignment = { horizontal: column.align === 'right' ? 'right' : 'left', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: argb(branding.primaryColor) } } };
    });
    headerRow.height = 22;
    const firstDataRow = rowIndex + 1;
    table.rows.forEach((dataRow, rowOffset) => {
      const current = sheet.getRow(firstDataRow + rowOffset);
      table.columns.forEach((column, columnIndex) => {
        const cell = current.getCell(columnIndex + 1);
        const value = dataRow[column.key];
        cell.value =
          column.format === 'number' || column.format === 'money'
            ? number(value)
            : value === null || value === undefined
              ? ''
              : String(value);
        if (column.format === 'number') cell.numFmt = '#,##0';
        if (column.format === 'money') cell.numFmt = '"INR" #,##0.00';
        cell.font = { name: 'Arial', size: 9, color: { argb: argb(INK) } };
        cell.alignment = { horizontal: column.align === 'right' ? 'right' : 'left', vertical: 'middle' };
        if (rowOffset % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
        cell.border = { bottom: { style: 'hair', color: { argb: argb(LINE) } } };
      });
      current.height = 18;
    });
    const lastDataRow = Math.max(firstDataRow, firstDataRow + table.rows.length - 1);
    if (table.rows.length) {
      sheet.autoFilter = { from: { row: rowIndex, column: 1 }, to: { row: lastDataRow, column: table.columns.length } };
    }
    sheet.views = [{ state: 'frozen', ySplit: rowIndex }];
    if (!table.rows.length) {
      const empty = merge(firstDataRow, 1, columnCount);
      empty.value = 'No rows for the selected filters.';
      empty.font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF94A3B8' } };
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

export function renderReport(
  model: ReportModel,
  format: ReportFormat,
  branding: ReportBranding,
): Promise<Buffer> | Buffer {
  if (format === 'CSV') return renderCsv(model);
  if (format === 'XLSX') return renderExcel(model, branding);
  return renderPdf(model, branding);
}

export function reportFileExtension(format: ReportFormat): string {
  return format === 'PDF' ? 'pdf' : format === 'XLSX' ? 'xlsx' : 'csv';
}

export function reportFileBaseName(type: ReportType): string {
  return type.toLowerCase().replace(/_/g, '-');
}
