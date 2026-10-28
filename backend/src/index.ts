import fs from 'node:fs';
import process from 'node:process';
import { config } from './config.ts';
import { openConfiguredDatabase } from './db/open.ts';
import { runMigrations } from './db/migrate.ts';
import { buildServer } from './http/server.ts';

const db = openConfiguredDatabase();
const applied = runMigrations(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
console.log(`Database driver: ${db.dialect}`);

const app = await buildServer({ db });

const httpsEnabled =
  fs.existsSync(config.httpsKeyPath) && fs.existsSync(config.httpsCertPath);
const secureApp = httpsEnabled
  ? await buildServer({
      db,
      https: {
        key: fs.readFileSync(config.httpsKeyPath),
        cert: fs.readFileSync(config.httpsCertPath),
      },
    })
  : null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await secureApp?.close();
    db.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  if (secureApp) {
    await secureApp.listen({ host: config.host, port: config.httpsPort });
  } else {
    app.log.warn(
      `HTTPS disabled: missing certificate at ${config.httpsCertPath}. Camera scanning on phones needs HTTPS.`,
    );
  }
  const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (Number(userCount) === 0) {
    app.log.warn('No users exist. Run `npm run bootstrap` before signing in.');
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
