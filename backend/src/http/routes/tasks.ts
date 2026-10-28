import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { assignTask, blockTask, claimTask, completeTask, createTask, getTask, listTasks, startTask } from '../../services/tasks.ts';

export async function registerTaskRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/tasks', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(200).optional(),
        taskType: z.string().max(40).optional(),
        assignedTo: z.string().uuid().optional(),
        priority: z.string().max(20).optional(),
        overdue: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(300).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
    return reply.send({ data: listTasks(db, { ...query, warehouseId: warehouse.id }) });
  });

  app.get('/api/tasks/:id', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getTask(db, id) });
  });

  app.post('/api/tasks', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const body = z
      .object({
        taskType: z.enum(['PUTAWAY', 'PICKING', 'QC', 'PACKING', 'RETURN_INSPECTION', 'CYCLE_COUNT', 'TRANSFER', 'MAINTENANCE']),
        entityType: z.string().max(50).optional().nullable(),
        entityId: z.string().max(100).optional().nullable(),
        description: z.string().max(1000).optional().nullable(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
        assignedTo: z.string().uuid().optional().nullable(),
        dueInHours: z.number().int().min(1).max(720).optional(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
    const result = withTransaction(db, () => createTask(db, { ...body, warehouseId: warehouse.id }, user));
    return reply.code(201).send({ data: result });
  });

  app.post('/api/tasks/:id/assign', { preHandler: [authGuard(db), permit(db, 'task.assign')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ assignedTo: z.string().uuid().nullable() }).parse(request.body);
    const user = currentUser(request);
    withTransaction(db, () => assignTask(db, id, body.assignedTo, user));
    return reply.send({ data: getTask(db, id) });
  });

  app.post('/api/tasks/:id/claim', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = currentUser(request);
    withTransaction(db, () => claimTask(db, id, user));
    return reply.send({ data: getTask(db, id) });
  });

  app.post('/api/tasks/:id/start', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = currentUser(request);
    withTransaction(db, () => startTask(db, id, user));
    return reply.send({ data: getTask(db, id) });
  });

  app.post('/api/tasks/:id/block', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    const user = currentUser(request);
    withTransaction(db, () => blockTask(db, id, body.reason, user));
    return reply.send({ data: getTask(db, id) });
  });

  app.post('/api/tasks/:id/complete', { preHandler: [authGuard(db), permit(db, 'task.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = currentUser(request);
    withTransaction(db, () => completeTask(db, id, user));
    return reply.send({ data: getTask(db, id) });
  });
}
