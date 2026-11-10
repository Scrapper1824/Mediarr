import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, seal, useSecretDir } from './secretBox.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-secret-'));
  useSecretDir(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('secret storage', () => {
  it('round-trips and never stores the plain text', () => {
    const sealed = seal('my-simkl-token');
    expect(sealed).not.toContain('my-simkl-token');
    expect(seal('my-simkl-token')).not.toBe(sealed); // fresh IV every time
    expect(open(sealed)).toBe('my-simkl-token');
    expect(fs.existsSync(path.join(dir, 'secret.key'))).toBe(true);
  });

  it('rejects tampered values', () => {
    const parts = seal('token').split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => open(parts.join('.'))).toThrow();
    expect(() => open('garbage')).toThrow();
  });

  it('cannot open values sealed with another key', () => {
    const sealed = seal('token');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-secret-'));
    useSecretDir(other);
    expect(() => open(sealed)).toThrow();
    fs.rmSync(other, { recursive: true, force: true });
  });
});
