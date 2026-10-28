import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = input.replace(/[\s-]/g, '').toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('Invalid base32 secret');
  }
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isInteger(counter) || counter < 0) throw new Error('HOTP counter must be a non-negative integer');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs = Date.now(), period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/**
 * Returns the matched time step, or null. A one-step window on either side
 * tolerates modest clock drift without widening the attack surface much.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: { now?: number; window?: number; period?: number; digits?: number } = {},
): number | null {
  const normalized = token.replace(/[\s-]/g, '');
  const digits = options.digits ?? TOTP_DIGITS;
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const step = totpStep(options.now, options.period ?? TOTP_PERIOD_SECONDS);
  const window = options.window ?? 1;
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateStep = step + offset;
    if (candidateStep < 0) continue;
    if (safeEqual(hotp(secret, candidateStep, digits), normalized)) matched = candidateStep;
  }
  return matched;
}

export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${input.issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
