import fs from 'node:fs';
import path from 'node:path';
import { toPostgresMigration } from '../src/db/migrations/generate.ts';

const sourceDir = path.resolve(import.meta.dirname, '..', 'src', 'db', 'migrations');
const targetDir = path.join(sourceDir, 'postgres');
fs.mkdirSync(targetDir, { recursive: true });

const files = fs
  .readdirSync(sourceDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

for (const file of files) {
  const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  fs.writeFileSync(path.join(targetDir, file), toPostgresMigration(source));
  console.log(`generated postgres/${file}`);
}
