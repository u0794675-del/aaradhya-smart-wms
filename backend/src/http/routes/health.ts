import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/index.ts';
import { config } from '../../config.ts';
import { authGuard, permit } from '../auth-guards.ts';
import { nowIso } from '../../lib/time.ts';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    let databaseOk = false;
    try {
      db.prepare('SELECT 1').get();
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    return reply.code(databaseOk ? 200 : 503).send({
      data: {
        status: databaseOk ? 'ok' : 'degraded',
        database: databaseOk,
        timestamp: nowIso(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      },
    });
  });

  app.get(
    '/api/health/details',
    { preHandler: [authGuard(db), permit(db, 'control_tower.read')] },
    async (_request, reply) => {
      const migration = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
      const counts = {
        products: Number((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n),
        boxes: Number((db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }).n),
        ledgerTransactions: Number(
          (db.prepare('SELECT COUNT(*) AS n FROM inventory_transactions').get() as { n: number }).n,
        ),
        auditEvents: Number((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n),
        activeSessions: Number(
          (
            db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?").get(nowIso()) as {
              n: number;
            }
          ).n,
        ),
      };
      const failedImports = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM import_jobs WHERE status = 'FAILED'").get() as { n: number }).n,
      );
      const openExceptions = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM exceptions WHERE status IN ('OPEN','INVESTIGATING')").get() as { n: number })
          .n,
      );
      let dbSizeBytes: number | null = null;
      try {
        dbSizeBytes =
          db.dialect === 'postgres'
            ? Number(
                (
                  db.prepare('SELECT pg_database_size(current_database()) AS size').get() as {
                    size: number;
                  }
                ).size,
              )
            : fs.statSync(config.dbPath).size;
      } catch {
        dbSizeBytes = null;
      }
      return reply.send({
        data: {
          status: 'ok',
          database: { connected: true, driver: db.dialect, migration, sizeBytes: dbSizeBytes },
          counts,
          failedImports,
          openExceptions,
          backup: {
            available: false,
            note:
              db.dialect === 'postgres'
                ? 'Use pg_dump or managed-database snapshots; no backup provider is configured.'
                : 'No backup provider is configured. Use filesystem snapshots for this deployment.',
          },
          integrations: {
            marketplaces: { configured: false, status: 'not_configured' },
            notifications: { configured: false, status: 'not_configured' },
            aiProvider: { configured: false, status: 'not_configured' },
          },
          process: {
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            memoryRssBytes: process.memoryUsage().rss,
            nodeVersion: process.version,
          },
          checkedAt: nowIso(),
        },
      });
    },
  );
}
