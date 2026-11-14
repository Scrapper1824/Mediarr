import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { initDb } from '../db.js';

let app: FastifyInstance;
let dataDir: string;
let web: string;

beforeEach(async () => {
  initDb(':memory:');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-static-'));
  web = path.join(dataDir, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><script src="/assets/index-abc123.js"></script>');
  fs.writeFileSync(path.join(web, 'assets', 'index-abc123.js'), 'console.log(1)');
  app = await buildApp({ dataDir, webDist: web, logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('serving the web app', () => {
  it('never lets a browser or proxy keep the page, so updates show on the next load', async () => {
    for (const url of ['/', '/index.html', '/watch/episode/5', '/settings?section=system']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache, private');
    }
  });

  it('keeps the hashed scripts for good (their names change with every build)', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('sends the compressed copy made at build time to browsers that accept it', async () => {
    const js = 'console.log("hello from mediarr");'.repeat(200);
    fs.writeFileSync(path.join(web, 'assets', 'big-def456.js'), js);
    fs.writeFileSync(path.join(web, 'assets', 'big-def456.js.br'), zlib.brotliCompressSync(js));
    const br = await app.inject({ method: 'GET', url: '/assets/big-def456.js', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(zlib.brotliDecompressSync(br.rawPayload).toString()).toBe(js);
    // A browser that doesn't accept it gets the plain file.
    const plain = await app.inject({ method: 'GET', url: '/assets/big-def456.js', headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(js);
  });
});
