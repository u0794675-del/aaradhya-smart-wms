import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { hashRequest, runIdempotent } from '../services/idempotency.ts';
import { currentUser } from './auth-guards.ts';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function idempotentMutation<T>(
  db: DB,
  request: FastifyRequest,
  reply: FastifyReply,
  work: () => T,
): { data: T } {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.trim().length < 8 || key.length > 200) {
    throw badRequest(
      'IDEMPOTENCY_KEY_REQUIRED',
      'A unique Idempotency-Key header (8-200 chars) is required for stock-changing operations',
    );
  }
  const user = currentUser(request);
  const result = runIdempotent(
    db,
    {
      userId: user.id,
      key: key.trim(),
      method: request.method,
      path: request.url.split('?')[0],
      requestHash: hashRequest(request.body ?? null),
    },
    work,
  );
  reply.header('Idempotent-Replayed', String(result.replayed));
  return { data: result.data };
}
