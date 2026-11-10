import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb, now } from '../db.js';
import { isLocalAddress } from './play.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let lib: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-playroutes-'));
  lib = path.join(dataDir, 'Movies');
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

async function users() {
  const boss = cookieFrom(
    await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: prepareSetupCode(dataDir), username: 'boss', password: PASSWORD } }),
  );
  await app.inject({ method: 'POST', url: '/api/users', headers: { ...CSRF, cookie: boss }, payload: { username: 'viewer', password: `${PASSWORD} x`, role: 'user' } });
  const viewer = cookieFrom(await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'viewer', password: `${PASSWORD} x` } }));
  return { boss, viewer };
}

/** A movie in the library whose file is `file` (by default inside its own folder). */
function addMovie(file?: string): number {
  const folder = path.join(lib, 'Dune (2021)');
  const target = file ?? path.join(folder, 'Dune (2021) [1080p].mp4');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from('0123456789abcdef'));
  return Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, has_file, file_path, added_at) VALUES ('movie', 1, 'Dune', 2021, ?, 'Dune (2021)', 1, ?, ?)`)
      .run(lib, target, now()).lastInsertRowid,
  );
}

const call = (cookie: string, method: 'GET' | 'PUT', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, cookie, ...headers }, payload });

describe('watching', () => {
  it('streams the original file with byte ranges', async () => {
    const { viewer } = await users();
    const id = addMovie();
    const part = await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=4-7' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 4-7/16');
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.body).toBe('4567');
    const tail = await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=-3' });
    expect(tail.body).toBe('def');
    expect((await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=40-50' })).statusCode).toBe(416);
  });

  it('only plays files inside the title’s own library folder', async () => {
    const { viewer } = await users();
    const id = addMovie(path.join(dataDir, 'elsewhere', 'secret.mp4'));
    expect((await call(viewer, 'GET', `/api/play/direct/movie/${id}`)).statusCode).toBe(403);
    expect((await call(viewer, 'GET', '/api/play/direct/movie/999')).statusCode).toBe(404);
    expect((await call(viewer, 'GET', '/api/play/direct/show/1')).statusCode).toBe(400);
  });

  it('keeps each user’s progress to themselves, and lists what to continue', async () => {
    const { boss, viewer } = await users();
    const id = addMovie();
    expect((await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { position: 600, duration: 9000 })).json()).toEqual({ ok: true, watched: false });
    expect((await call(viewer, 'GET', `/api/play/progress/${id}`)).json()).toEqual({ 0: { position: 600, duration: 9000, watched: false } });
    expect((await call(boss, 'GET', `/api/play/progress/${id}`)).json()).toEqual({});

    const cont = (await call(viewer, 'GET', '/api/continue')).json();
    expect(cont).toEqual([expect.objectContaining({ kind: 'movie', id, position: 600, upNext: false, tmdbId: 1, year: 2021 })]);
    expect((await call(boss, 'GET', '/api/continue')).json()).toEqual([]);

    // 90% in counts as watched, and it leaves Continue Watching.
    expect((await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { position: 8200, duration: 9000 })).json().watched).toBe(true);
    expect((await call(viewer, 'GET', '/api/continue')).json()).toEqual([]);
    // Marked unwatched by hand: starts over.
    await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { watched: false });
    expect((await call(viewer, 'GET', `/api/play/progress/${id}`)).json()[0]).toMatchObject({ position: 0, watched: false });
  });

  it('never hands out someone else’s stream', async () => {
    const { viewer } = await users();
    const res = await call(viewer, 'GET', '/api/play/hls/0123456789abcdef0123456789abcdef/main.m3u8');
    expect(res.statusCode).toBe(404);
  });

  it('allows the player in the security policy', async () => {
    const { viewer } = await users();
    const csp = String((await call(viewer, 'GET', '/api/continue')).headers['content-security-policy']);
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain('unsafe-inline\'; script'); // scripts still can't be inline
  });
});

describe('home or away', () => {
  it('treats private addresses as home', () => {
    for (const ip of ['127.0.0.1', '::1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '::ffff:192.168.0.9', 'fd12::1']) expect(isLocalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1', '::ffff:1.1.1.1']) expect(isLocalAddress(ip), ip).toBe(false);
  });
});
