import crypto from 'node:crypto';

// RFC 6238 time-based one-time codes (what Google Authenticator, Authy, 1Password, Bitwarden use).
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function codeAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

export const currentCounter = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * Checks a code allowing one step of clock drift either way. Returns the matched counter, or null.
 * Callers reject counters <= the last one used, so a code can't be replayed.
 */
export function verifyCode(secret: string, code: unknown, nowMs = Date.now()): number | null {
  if (typeof code !== 'string') return null;
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = currentCounter(nowMs);
  for (const c of [now, now - 1, now + 1]) {
    const expected = Buffer.from(codeAt(secret, c));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return c;
  }
  return null;
}

export function otpauthUri(secret: string, username: string): string {
  const label = encodeURIComponent(`Mediarr:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Mediarr&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
