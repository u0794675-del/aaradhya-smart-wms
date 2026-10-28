export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  run(...params: unknown[]): RunResult;
}

export interface DB {
  readonly dialect: 'sqlite' | 'postgres';
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
