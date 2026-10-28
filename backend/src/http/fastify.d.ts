import type { AuthUser } from '../services/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
    correlationId: string;
  }
}

export {};
