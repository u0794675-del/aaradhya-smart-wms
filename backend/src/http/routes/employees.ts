import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import {
  EMPLOYEE_PERMISSION_CODES,
  bulkDeleteEmployees,
  createEmployee,
  listEmployees,
  resetEmployeePassword,
  updateEmployee,
} from '../../services/employees.ts';

export async function registerEmployeeRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get(
    '/api/employees/permissions',
    { preHandler: [authGuard(db), permit(db, 'user.manage')] },
    async (_request, reply) => {
      const rows = db
        .prepare(
          `SELECT code, description, category FROM permissions
            WHERE code IN (${EMPLOYEE_PERMISSION_CODES.map(() => '?').join(',')})
            ORDER BY category, code`,
        )
        .all(...EMPLOYEE_PERMISSION_CODES);
      return reply.send({ data: rows });
    },
  );

  app.get('/api/employees', { preHandler: [authGuard(db), permit(db, 'user.manage')] }, async (request, reply) => {
    const query = z
      .object({
        search: z.string().max(100).optional(),
        role: z.string().max(40).optional(),
        includeInactive: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(request.query);
    return reply.send({ data: { rows: listEmployees(db, query) } });
  });

  app.post(
    '/api/employees/bulk-delete',
    { preHandler: [authGuard(db), permit(db, 'user.manage')] },
    async (request, reply) => {
      const body = z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(100),
          reason: z.string().min(3).max(500).optional(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = withTransaction(db, () => bulkDeleteEmployees(db, body.ids, user, body.reason));
      return reply.send({ data: result });
    },
  );

  app.post('/api/employees', { preHandler: [authGuard(db), permit(db, 'user.manage')] }, async (request, reply) => {
    const body = z
      .object({
        employeeCode: z.string().max(20).optional(),
        name: z.string().min(2).max(120),
        email: z.string().email().max(190),
        password: z.string().min(8).max(200).optional(),
        role: z.enum(['FIELD_OPERATOR', 'PICKER']).optional(),
        permissions: z.array(z.string().max(80)).max(50).optional(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = withTransaction(db, () => createEmployee(db, body, user));
    return reply.code(201).send({ data: result });
  });

  app.patch(
    '/api/employees/:id',
    { preHandler: [authGuard(db), permit(db, 'user.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          employeeCode: z.string().max(20).optional(),
          name: z.string().min(2).max(120).optional(),
          email: z.string().email().max(190).optional(),
          role: z.enum(['FIELD_OPERATOR', 'PICKER']).optional(),
          isActive: z.boolean().optional(),
          permissions: z.array(z.string().max(80)).max(50).optional(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = withTransaction(db, () => updateEmployee(db, id, body, user));
      return reply.send({ data: result });
    },
  );

  app.post(
    '/api/employees/:id/reset-password',
    { preHandler: [authGuard(db), permit(db, 'user.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      const result = withTransaction(db, () => resetEmployeePassword(db, id, user));
      return reply.send({ data: result });
    },
  );
}
