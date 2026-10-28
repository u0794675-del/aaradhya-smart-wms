import { Worker } from 'node:worker_threads';
import type { DB, RunResult, Statement } from '../types.ts';
import { normalizeParams, translateExec, translateQuery } from './sql.ts';

const REQUEST_BYTES = 8 * 1024 * 1024;
const RESPONSE_BYTES = 48 * 1024 * 1024;
const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const STATE_FATAL = 3;
const READY = 3;
const QUERY_TIMEOUT_MS = Number(process.env.PG_BRIDGE_TIMEOUT_MS ?? 120_000);

interface BridgeError {
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  name?: string;
}

interface BridgeResponse {
  ok: boolean;
  row?: Record<string, unknown> | null;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  error?: BridgeError;
}

export interface PostgresOptions {
  connectionString: string;
  schema?: string;
}

export function openPostgresDatabase(options: PostgresOptions): DB {
  return new PostgresDatabase(options);
}

class PostgresDatabase implements DB {
  readonly dialect = 'postgres' as const;

  private readonly worker: Worker;
  private readonly control: Int32Array;
  private readonly requestBytes: Uint8Array;
  private readonly responseBytes: Uint8Array;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private closed = false;
  private sequence = 0;

  constructor(options: PostgresOptions) {
    const control = new SharedArrayBuffer(32);
    const request = new SharedArrayBuffer(REQUEST_BYTES);
    const response = new SharedArrayBuffer(RESPONSE_BYTES);
    this.control = new Int32Array(control);
    this.requestBytes = new Uint8Array(request);
    this.responseBytes = new Uint8Array(response);

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        control,
        request,
        response,
        connectionString: options.connectionString,
        schema: options.schema ?? 'public',
      },
    });
    this.worker.on('error', () => {
      Atomics.store(this.control, READY, -1);
      Atomics.notify(this.control, READY);
    });
    this.worker.unref();
    this.waitReady();
  }

  private waitReady(): void {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const ready = Atomics.load(this.control, READY);
      if (ready === 1) return;
      if (ready === -1) throw new Error('PostgreSQL bridge worker failed to start');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('PostgreSQL bridge worker did not start in time');
      Atomics.wait(this.control, READY, ready, remaining);
    }
  }

  private readResponse(): BridgeResponse {
    const length = Atomics.load(this.control, 2);
    const text = this.decoder.decode(this.responseBytes.subarray(0, length));
    Atomics.store(this.control, 0, STATE_IDLE);
    Atomics.notify(this.control, 0);
    try {
      return JSON.parse(text) as BridgeResponse;
    } catch {
      throw new Error('PostgreSQL bridge returned an unreadable response');
    }
  }

  private call(payload: unknown): BridgeResponse {
    if (this.closed) throw new Error('PostgreSQL database connection is closed');
    if (Atomics.load(this.control, 0) !== STATE_IDLE) throw new Error('PostgreSQL bridge is busy');

    const bytes = this.encoder.encode(
      JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
    );
    if (bytes.byteLength > this.requestBytes.byteLength) {
      throw new Error('PostgreSQL request exceeds the bridge buffer');
    }
    this.requestBytes.set(bytes);
    const sequence = ++this.sequence;
    Atomics.store(this.control, 1, bytes.byteLength);
    Atomics.store(this.control, 4, sequence);
    Atomics.store(this.control, 0, STATE_REQUEST);
    Atomics.notify(this.control, 0);

    const deadline = Date.now() + QUERY_TIMEOUT_MS;
    for (;;) {
      const state = Atomics.load(this.control, 0);
      if (state === STATE_RESPONSE) {
        const responseSequence = Atomics.load(this.control, 5);
        if (responseSequence !== sequence) {
          this.closed = true;
          void this.worker.terminate();
          throw new Error(
            `PostgreSQL bridge response mismatch (expected ${sequence}, received ${responseSequence})`,
          );
        }
        const response = this.readResponse();
        if (!response.ok) {
          const error = new Error(response.error?.message ?? 'PostgreSQL query failed');
          Object.assign(error, {
            code: response.error?.code,
            name: response.error?.name ?? 'PostgresError',
            detail: response.error?.detail,
            constraint: response.error?.constraint,
          });
          throw error;
        }
        return response;
      }
      if (state === STATE_FATAL) {
        this.closed = true;
        throw new Error('PostgreSQL bridge failed');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.closed = true;
        void this.worker.terminate();
        throw new Error(
          `PostgreSQL query timed out (state=${Atomics.load(this.control, 0)}, length=${Atomics.load(this.control, 2)})`,
        );
      }
      Atomics.wait(this.control, 0, state, remaining);
    }
  }

  prepare(sql: string): Statement {
    const text = translateQuery(sql);
    return {
      get: <T = Record<string, unknown>>(...params: unknown[]): T | undefined => {
        const response = this.call({ op: 'query', mode: 'get', text, values: normalizeParams(params) });
        return (response.row ?? undefined) as T | undefined;
      },
      all: <T = Record<string, unknown>>(...params: unknown[]): T[] => {
        const response = this.call({ op: 'query', mode: 'all', text, values: normalizeParams(params) });
        return (response.rows ?? []) as T[];
      },
      run: (...params: unknown[]): RunResult => {
        const response = this.call({ op: 'query', mode: 'run', text, values: normalizeParams(params) });
        return { changes: Number(response.rowCount ?? 0), lastInsertRowid: 0 };
      },
    };
  }

  exec(sql: string): void {
    this.call({ op: 'exec', text: translateExec(sql) });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.call({ op: 'close' });
    } catch {
      // the worker may already be gone; terminate below regardless
    }
    this.closed = true;
    void this.worker.terminate();
  }
}
