import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('could not allocate a port'));
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function testFiles(): string[] {
  const dir = import.meta.dirname;
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .map((file) => path.join('test', file));
}

function runTests(url: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-concurrency=1', ...testFiles()],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, WMS_TEST_DB: 'postgres', WMS_TEST_PG_URL: url },
      },
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const externalUrl = process.env.WMS_TEST_PG_URL;
if (externalUrl) {
  process.exitCode = await runTests(externalUrl);
} else {
  const port = await freePort();
  const databaseDir = fs.mkdtempSync('/tmp/wms-pg-test-');
  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    // The server's stderr is drained by this (otherwise idle) event loop.
    // Never enable statement logging here: the synchronous bridge blocks the
    // thread that drains this pipe while a query is in flight.
    onLog: () => undefined,
    onError: (error) => console.error('[embedded-postgres]', error),
  });

  let finished = false;
  const shutdown = async (code: number) => {
    if (finished) return;
    finished = true;
    await server.stop().catch(() => undefined);
    fs.rmSync(databaseDir, { recursive: true, force: true });
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(130));
  process.on('SIGTERM', () => void shutdown(143));

  await server.initialise();
  await server.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  try {
    await shutdown(await runTests(url));
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}
