import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  if (process.env.WMS_OTP_KEY_FILE) return path.resolve(process.env.WMS_OTP_KEY_FILE);
  const dir =
    config.dbPath === ':memory:'
      ? path.resolve(process.cwd(), 'data')
      : path.dirname(path.resolve(config.dbPath));
  return path.join(dir, 'otp.key');
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.WMS_OTP_KEY;
  if (fromEnv) {
    const decoded = Buffer.from(fromEnv, 'base64');
    if (decoded.length !== 32) {
      throw new Error('WMS_OTP_KEY must be a base64-encoded 32-byte key');
    }
    cachedKey = decoded;
    return cachedKey;
  }
  const file = keyFilePath();
  try {
    const existing = fs.readFileSync(file);
    if (existing.length !== 32) {
      throw new Error(`OTP key file ${file} must contain exactly 32 bytes`);
    }
    cachedKey = existing;
    return cachedKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = randomBytes(32);
  fs.writeFileSync(file, generated, { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, bodyB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !bodyB64) {
    throw new Error('Unsupported encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
}

export function resetSecretBoxForTests(): void {
  cachedKey = null;
}

/** Keyed digest for low-entropy one-time codes, so a leaked row cannot be brute-forced offline. */
export function hmacDigest(scope: string, value: string): string {
  return createHmac('sha256', loadKey()).update(scope).update('\u0000').update(value).digest('hex');
}
