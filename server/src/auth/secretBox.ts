import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypts secrets at rest (AES-256-GCM), e.g. users' Simkl/AniList tokens, so a copy of the
 * database alone doesn't hand them out. The key lives next to the database in `secret.key`.
 */
let keyDir: string | null = null;
let key: Buffer | null = null;

export function useSecretDir(dir: string) {
  if (dir !== keyDir) key = null;
  keyDir = dir;
}

function getKey(): Buffer {
  if (key) return key;
  if (!keyDir) throw new Error('Secret storage is not set up');
  const file = path.join(keyDir, 'secret.key');
  if (fs.existsSync(file)) {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is damaged`);
  } else {
    key = crypto.randomBytes(32);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  return key;
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** Throws if the value was tampered with or sealed with another key. */
export function open(sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
