import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit, requestContext } from '../auth-guards.ts';
import { expiryReport, movementReport, stockSummary } from '../../services/operations.ts';
import { addDays, todayIso } from '../../lib/time.ts';
import { AppError } from '../../lib/errors.ts';
import { recordAudit } from '../../services/audit.ts';
import type { EmailSender } from '../../services/email.ts';
import {
  getBranding,
  REPORT_TEMPLATES,
  reportOtpRequired,
  sendEmailOtp,
  verifyReportOtp,
} from '../../services/report-security.ts';
import {
  buildReportModel,
  renderReport,
  reportFileBaseName,
  reportFileExtension,
  type ReportFormat,
  type ReportType,
} from '../../services/report-render.ts';

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CONTENT_TYPES: Record<ReportFormat, string> = {
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  CSV: 'text/csv; charset=utf-8',
};

const exportSchema = z.object({
  reportType: z.enum(['STOCK_SUMMARY', 'MOVEMENTS', 'EXPIRY']),
  format: z.enum(['PDF', 'XLSX', 'CSV']),
  template: z.enum(REPORT_TEMPLATES).optional(),
  params: z
    .object({
      search: z.string().max(100).optional(),
      category: z.string().max(100).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .default({}),
  otp: z
    .object({
      channel: z.enum(['TOTP', 'EMAIL']),
      code: z.string().min(6).max(12),
    })
    .optional(),
});

function denyLegacyExport(db: DB, request: Parameters<typeof currentUser>[0], reason: string): never {
  const user = currentUser(request);
  recordAudit(db, {
    eventType: 'REPORT_EXPORT_DENIED',
    entityType: 'REPORT',
    entityId: 'STOCK_SUMMARY:CSV',
    outcome: 'FAILURE',
    reason,
    refs: { path: request.url.split('?')[0], format: 'CSV' },
    actor: {
      userId: user.id,
      role: user.role,
      ...requestContext(request),
    },
  });
  throw new AppError(403, 'OTP_REQUIRED', 'Report OTP is mandatory. Export from the Export dialog with a one-time code.');
}

export async function registerReportRoutes(
  app: FastifyInstance,
  db: DB,
  sender: EmailSender,
): Promise<void> {
  app.get('/api/reports/stock-summary', { preHandler: [authGuard(db), permit(db, 'report.read')] }, async (request, reply) => {
    const user = currentUser(request);
    const query = z
      .object({ search: z.string().max(100).optional(), category: z.string().max(100).optional() })
      .parse(request.query);
    const rows = stockSummary(db, query).map((row) => {
      if (!user.permissions.includes('product.cost.read')) {
        const { cost_price: _cost, stock_value: _value, ...rest } = row;
        return rest;
      }
      return row;
    });
    const totals = rows.reduce(
      (sum, row) => ({
        on_hand: sum.on_hand + Number(row.on_hand ?? 0),
        available: sum.available + Number(row.available ?? 0),
        non_sellable: sum.non_sellable + Number(row.non_sellable ?? 0),
        stock_value: sum.stock_value + Number(row.stock_value ?? 0),
      }),
      { on_hand: 0, available: 0, non_sellable: 0, stock_value: 0 },
    );
    return reply.send({ data: { rows, totals, asOf: new Date().toISOString() } });
  });

  app.get('/api/reports/stock-summary.csv', { preHandler: [authGuard(db), permit(db, 'report.export')] }, async (request, reply) => {
    if (reportOtpRequired(db)) denyLegacyExport(db, request, 'OTP_REQUIRED');
    const user = currentUser(request);
    const query = z
      .object({ search: z.string().max(100).optional(), category: z.string().max(100).optional() })
      .parse(request.query);
    const rows = stockSummary(db, query);
    const includeCost = user.permissions.includes('product.cost.read');
    const header = [
      'sku', 'name', 'category', 'base_uom', 'on_hand', 'reserved', 'available',
      'non_sellable', 'in_transit', 'return_pending', 'expired',
      ...(includeCost ? ['cost_price', 'stock_value'] : []),
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.sku, row.name, row.category, row.base_uom, row.on_hand, row.reserved, row.available,
          row.non_sellable, row.in_transit, row.return_pending, row.expired,
          ...(includeCost ? [row.cost_price, row.stock_value] : []),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="stock-summary-${todayIso()}.csv"`);
    return reply.send(`${lines.join('\n')}\n`);
  });

  app.get('/api/reports/movements', { preHandler: [authGuard(db), permit(db, 'report.read')] }, async (request, reply) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.query);
    const to = query.to ?? todayIso();
    const from = query.from ?? addDays(-13).slice(0, 10);
    return reply.send({ data: movementReport(db, from, to) });
  });

  app.get('/api/reports/expiry', { preHandler: [authGuard(db), permit(db, 'report.read')] }, async (_request, reply) => {
    return reply.send({ data: expiryReport(db) });
  });

  app.post('/api/reports/otp/email', { preHandler: [authGuard(db), permit(db, 'report.export')] }, async (request, reply) => {
    const user = currentUser(request);
    const data = await sendEmailOtp(db, user, sender, requestContext(request));
    return reply.send({ data });
  });

  app.post('/api/reports/export', { preHandler: [authGuard(db), permit(db, 'report.export')] }, async (request, reply) => {
    const body = exportSchema.parse(request.body);
    const user = currentUser(request);
    const context = requestContext(request);
    const required = reportOtpRequired(db);

    if (required && !body.otp) {
      recordAudit(db, {
        eventType: 'REPORT_EXPORT_DENIED',
        entityType: 'REPORT',
        entityId: `${body.reportType}:${body.format}`,
        outcome: 'FAILURE',
        reason: 'OTP_REQUIRED',
        refs: { reportType: body.reportType, format: body.format },
        actor: { userId: user.id, role: user.role, ...context },
      });
      throw new AppError(403, 'OTP_REQUIRED', 'Enter a one-time code to export this report.');
    }
    if (body.otp) {
      verifyReportOtp(db, user, body.otp, context);
    }

    const branding = getBranding(db);
    const effectiveBranding = body.template ? { ...branding, template: body.template } : branding;
    const model = buildReportModel(db, user, body.reportType as ReportType, body.params);
    const buffer = await renderReport(model, body.format, effectiveBranding);
    const extension = reportFileExtension(body.format);
    const baseName = reportFileBaseName(body.reportType as ReportType);
    const fileName = `${baseName}-${todayIso()}.${extension}`;

    recordAudit(db, {
      eventType: 'REPORT_GENERATED',
      entityType: 'REPORT',
      entityId: `${body.reportType}:${body.format}`,
      refs: {
        reportType: body.reportType,
        format: body.format,
        template: effectiveBranding.template,
        rows: model.tables.reduce((sum, table) => sum + table.rows.length, 0),
        params: body.params,
        otpChannel: body.otp?.channel ?? null,
        bytes: buffer.length,
      },
      actor: { userId: user.id, role: user.role, ...context },
    });

    reply
      .header('content-type', CONTENT_TYPES[body.format])
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .header('cache-control', 'no-store');
    return reply.send(buffer);
  });
}
