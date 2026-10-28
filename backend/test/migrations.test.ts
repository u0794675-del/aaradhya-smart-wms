import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { toPostgresMigration } from '../src/db/migrations/generate.ts';

const migrationsDir = path.resolve(import.meta.dirname, '..', 'src', 'db', 'migrations');
const postgresDir = path.join(migrationsDir, 'postgres');

test('committed PostgreSQL migrations match the shared SQL source', () => {
  const sourceFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const generatedFiles = fs
    .readdirSync(postgresDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  assert.deepEqual(
    generatedFiles,
    sourceFiles,
    'PostgreSQL migration set is out of sync; run npm run generate:postgres',
  );

  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const committed = fs.readFileSync(path.join(postgresDir, file), 'utf8');
    assert.equal(
      committed,
      toPostgresMigration(source),
      `${file} is stale; run npm run generate:postgres`,
    );
  }
});
