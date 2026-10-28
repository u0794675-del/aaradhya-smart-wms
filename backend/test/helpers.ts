import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../src/db/index.ts';
import { openPostgresDatabase } from '../src/db/postgres/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapSystem } from '../src/db/bootstrap.ts';
import { buildServer } from '../src/http/server.ts';
import type { EmailSender } from '../src/services/email.ts';

export const TEST_PASSWORD = 'TestPass!2026';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class ApiClient {
  cookie = '';
  constructor(public readonly baseUrl: string) {}

  async login(email = 'admin@aaradhya.local', password = TEST_PASSWORD): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('aaradhya_session='));
    if (session) this.cookie = session.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  }

  async request<T = any>(
    method: string,
    apiPath: string,
    body?: unknown,
    options: { idempotencyKey?: string; headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const response = await fetch(`${this.baseUrl}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get<T = any>(p: string) {
    return this.request<T>('GET', p);
  }
  post<T = any>(p: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>('POST', p, body, { idempotencyKey });
  }
  patch<T = any>(p: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>('PATCH', p, body, { idempotencyKey });
  }
  delete<T = any>(p: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>('DELETE', p, body, { idempotencyKey });
  }

  async binary(
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
    };
  }
}

export interface Harness {
  db: DB;
  app: FastifyInstance;
  baseUrl: string;
  dir: string;
  client: (email?: string) => Promise<ApiClient>;
  close: () => Promise<void>;
}

export async function createHarness(options: { emailSender?: EmailSender } = {}): Promise<Harness> {
  const postgresUrl = process.env.WMS_TEST_DB === 'postgres' ? process.env.WMS_TEST_PG_URL : undefined;
  if (process.env.WMS_TEST_DB === 'postgres' && !postgresUrl) {
    throw new Error('WMS_TEST_DB=postgres requires WMS_TEST_PG_URL');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaradhya-wms-test-'));
  const schema = `wms_test_${randomUUID().replace(/-/g, '')}`;
  let db: DB;
  if (postgresUrl) {
    db = openPostgresDatabase({ connectionString: postgresUrl, schema });
  } else {
    db = openDatabase(path.join(dir, 'test.db'));
  }
  runMigrations(db);
  bootstrapSystem(db, { password: TEST_PASSWORD });
  const app = await buildServer({ db, logger: false, serveFrontend: false, emailSender: options.emailSender });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    db,
    app,
    baseUrl,
    dir,
    client: async (email = 'admin@aaradhya.local') => {
      const client = new ApiClient(baseUrl);
      const response = await client.login(email);
      if (response.status !== 200) {
        throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return client;
    },
    close: async () => {
      await app.close();
      if (postgresUrl) {
        db.exec(`DROP SCHEMA "${schema}" CASCADE`);
      }
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const idem = (): string => randomUUID();

export function expectedStatus(response: ApiResponse, status: number, context = ''): void {
  if (response.status !== status) {
    throw new Error(
      `Expected HTTP ${status}${context ? ` (${context})` : ''}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}
