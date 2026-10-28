import { workerData } from 'node:worker_threads';
import { Client, types } from 'pg';

interface WorkerData {
  control: SharedArrayBuffer;
  request: SharedArrayBuffer;
  response: SharedArrayBuffer;
  connectionString: string;
  schema: string;
}

const data = workerData as WorkerData;
const control = new Int32Array(data.control);
const requestBytes = new Uint8Array(data.request);
const responseBytes = new Uint8Array(data.response);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// COUNT/SUM/AVG return int8/numeric in PostgreSQL; the services expect numbers.
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));
types.setTypeParser(700, (value) => Number(value));
types.setTypeParser(701, (value) => Number(value));

const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const READY = 3;

type Request =
  | { op: 'query'; mode: 'get' | 'all' | 'run'; text: string; values: unknown[] }
  | { op: 'exec'; text: string }
  | { op: 'close' };

let client: Client | null = null;
let inTransaction = false;

async function connect(): Promise<Client> {
  const next = new Client({
    connectionString: data.connectionString,
    application_name: 'aaradhya-wms',
    options: process.env.PG_BRIDGE_OPTIONS,
  });
  await next.connect();
  if (data.schema && data.schema !== 'public') {
    const existing = await next.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [data.schema]);
    if (existing.rowCount === 0) {
      await next.query(`CREATE SCHEMA "${data.schema.replace(/"/g, '""')}"`);
    }
    await next.query(`SET search_path TO "${data.schema.replace(/"/g, '""')}"`);
  }
  next.on('error', () => {
    client = null;
    inTransaction = false;
  });
  client = next;
  return next;
}

async function ensureClient(): Promise<Client> {
  if (!client) return connect();
  return client;
}

function serializeError(error: unknown) {
  const value = error as {
    message?: unknown;
    code?: unknown;
    detail?: unknown;
    constraint?: unknown;
    name?: unknown;
  };
  return {
    ok: false as const,
    error: {
      message: String(value?.message ?? error),
      code: value?.code === undefined ? undefined : String(value.code),
      detail: value?.detail === undefined ? undefined : String(value.detail),
      constraint: value?.constraint === undefined ? undefined : String(value.constraint),
      name: value?.name === undefined ? undefined : String(value.name),
    },
  };
}

function isConnectionError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? '');
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03', '08003', '08006'].includes(code);
}

async function execute(request: Request) {
  if (request.op === 'close') {
    if (client) await client.end().catch(() => undefined);
    client = null;
    return { ok: true as const, closing: true };
  }

  const connection = await ensureClient();
  if (request.op === 'exec') {
    const command = request.text.trim().toUpperCase();
    await connection.query(request.text);
    if (command === 'BEGIN') inTransaction = true;
    else if (command === 'COMMIT' || command === 'ROLLBACK') inTransaction = false;
    return { ok: true as const };
  }

  const result = request.values.length
    ? await connection.query({ text: request.text, values: request.values })
    : await connection.query(request.text);
  if (request.mode === 'get') return { ok: true as const, row: result.rows[0] ?? null };
  if (request.mode === 'all') return { ok: true as const, rows: result.rows };
  return { ok: true as const, rowCount: result.rowCount ?? 0 };
}

async function handle(request: Request) {
  try {
    return await execute(request);
  } catch (error) {
    if (!inTransaction && isConnectionError(error)) {
      client = null;
      try {
        return await execute(request);
      } catch (retryError) {
        return serializeError(retryError);
      }
    }
    return serializeError(error);
  }
}

function writeResponse(payload: unknown, sequence: number): void {
  let bytes = encoder.encode(
    JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
  );
  if (bytes.byteLength > responseBytes.byteLength) {
    bytes = encoder.encode(
      JSON.stringify({ ok: false, error: { message: 'PostgreSQL response exceeds the bridge buffer' } }),
    );
  }
  responseBytes.set(bytes);
  Atomics.store(control, 2, bytes.byteLength);
  Atomics.store(control, 5, sequence);
  Atomics.store(control, 0, STATE_RESPONSE);
  Atomics.notify(control, 0);
}

Atomics.store(control, READY, 1);
Atomics.notify(control, READY);

function fail(error: unknown): void {
  try {
    writeResponse(serializeError(error), Atomics.load(control, 4));
  } catch {
    // fall through to the fatal state below
  }
  Atomics.store(control, 0, 3);
  Atomics.notify(control, 0);
}

process.on('uncaughtException', (error) => {
  fail(error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  fail(error);
  process.exit(1);
});
process.on('exit', () => {
  Atomics.store(control, 0, 3);
  Atomics.notify(control, 0);
});

let running = true;
while (running) {
  for (;;) {
    const state = Atomics.load(control, 0);
    if (state === STATE_REQUEST) break;
    // waitAsync keeps the worker event loop free so pg can finish its
    // post-query bookkeeping while the caller is blocked on the result.
    const wait = Atomics.waitAsync(control, 0, state, 1000);
    if (wait.async) await wait.value;
  }

  const length = Atomics.load(control, 1);
  const sequence = Atomics.load(control, 4);
  let request: Request;
  try {
    request = JSON.parse(decoder.decode(requestBytes.subarray(0, length))) as Request;
  } catch (error) {
    writeResponse(serializeError(error), sequence);
    continue;
  }

  const result = await handle(request);
  // Let pg finish its ReadyForQuery bookkeeping before reporting completion.
  await new Promise<void>((resolve) => setImmediate(resolve));
  writeResponse(result, sequence);
  if (request.op === 'close') running = false;
}

if (client) await (client as Client).end().catch(() => undefined);
