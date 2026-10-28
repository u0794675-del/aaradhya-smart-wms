import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { getImportJob, importIssuesCsv, importProducts, importProductsWorkbook, listImportJobs } from '../../services/imports.ts';
import { bulkDelete } from '../../services/bulk-delete.ts';
import { importWorkbook } from '../../services/workbook-import.ts';
import { importStockList } from '../../services/stock-list-import.ts';
import { productTemplateXlsx, stockListTemplateXlsx } from '../../services/import-templates.ts';

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function registerImportRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.post('/api/imports/bulk-delete', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        reason: z.string().min(3).max(500).optional(),
      })
      .parse(request.body);
    const result = bulkDelete(db, 'import_jobs', body.ids, currentUser(request), body.reason);
    return reply.send({ data: result });
  });

  app.get('/api/imports/products/template.xlsx', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (_request, reply) => {
    const buffer = await productTemplateXlsx();
    return reply
      .header('content-type', XLSX_CONTENT_TYPE)
      .header('content-disposition', 'attachment; filename="product-import-template.xlsx"')
      .send(buffer);
  });

  app.get('/api/imports/stock-list/template.xlsx', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (_request, reply) => {
    const buffer = await stockListTemplateXlsx();
    return reply
      .header('content-type', XLSX_CONTENT_TYPE)
      .header('content-disposition', 'attachment; filename="stock-list-import-template.xlsx"')
      .send(buffer);
  });

  app.post('/api/imports/stock-list', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const body = z
      .object({
        fileName: z.string().min(1).max(200),
        contentBase64: z.string().min(1),
        brand: z.string().max(100).optional(),
        zone: z.string().max(50).optional(),
        sheetName: z.string().max(100).optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = await importStockList(db, body, user, { dryRun: body.dryRun === true });
    return reply.code(result.committed ? 201 : 200).send({ data: result });
  });

  app.get('/api/imports', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (_request, reply) => {
    return reply.send({ data: { rows: listImportJobs(db) } });
  });

  app.get('/api/imports/:id', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    return reply.send({ data: { job: getImportJob(db, id) } });
  });

  app.get('/api/imports/:id/errors.csv', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    const report = importIssuesCsv(db, id);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${report.fileName}"`);
    return reply.send(report.csv);
  });

  app.post('/api/imports/products', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const body = z
      .object({
        fileName: z.string().min(1).max(200),
        csv: z.string().min(1).max(4_000_000).optional(),
        contentBase64: z.string().min(1).optional(),
      })
      .refine((value) => Boolean(value.csv) !== Boolean(value.contentBase64), {
        message: 'Provide either csv text or a base64 .xlsx workbook',
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = body.contentBase64
      ? await importProductsWorkbook(db, { fileName: body.fileName, contentBase64: body.contentBase64 }, user)
      : importProducts(db, { fileName: body.fileName, csv: body.csv! }, user);
    return reply.code(201).send({ data: result });
  });

  app.post('/api/imports/workbook', { preHandler: [authGuard(db), permit(db, 'import.manage')] }, async (request, reply) => {
    const body = z
      .object({
        fileName: z.string().min(1).max(200),
        contentBase64: z.string().min(1),
        dryRun: z.boolean().optional(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = await importWorkbook(db, body, user, { dryRun: body.dryRun === true });
    return reply.code(result.committed ? 201 : 200).send({ data: result });
  });
}
