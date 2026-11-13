import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { resetRateLimits } from './rateLimit.js';
import { prepareSetupCode } from './routes.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let lib: string;
let setupCode: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-req-'));
  lib = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-lib-'));
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
  setupCode = prepareSetupCode(dataDir)!;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(lib, { recursive: true, force: true });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers: { ...CSRF, cookie }, payload: method === 'GET' ? undefined : (payload ?? {}) as object });

async function admin() {
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: setupCode, username: 'owner', password: PASSWORD } });
  return cookieFrom(res);
}
async function user(adminCookie: string, username: string, needsApproval: boolean) {
  const res = await call(adminCookie, 'POST', '/api/users', { username, password: `${PASSWORD} x`, role: 'user', needsApproval });
  expect(res.statusCode, res.body).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username, password: `${PASSWORD} x` } });
  return { id: (res.json() as { id: number }).id, cookie: cookieFrom(login) };
}
const mediaCount = () => (db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n;

function fakeTmdb() {
  saveSettings({ tmdbApiKey: 'a'.repeat(32), moviesRoots: [lib] });
  vi.stubGlobal('fetch', async (url: string) =>
    String(url).includes('/movie/603')
      ? new Response(
          JSON.stringify({ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-31', poster_path: '/p.jpg', backdrop_path: null, overview: '', status: 'Released' }),
          { status: 200 },
        )
      : new Response('{}', { status: 404 }),
  );
}

describe('requests that need an admin', () => {
  it('turning the toggle on and off', async () => {
    const a = await admin();
    const v = await user(a, 'viewer', false);
    expect((await call(a, 'PATCH', `/api/users/${v.id}`, { needsApproval: true })).json().needsApproval).toBe(true);
    expect((await call(v.cookie, 'GET', '/api/auth/status')).json().user.needsApproval).toBe(true);
    expect((await call(a, 'PATCH', `/api/users/${v.id}`, { needsApproval: false })).json().needsApproval).toBe(false);
  });

  it('wait until an admin approves, then the title is added', async () => {
    const a = await admin();
    const v = await user(a, 'viewer', true);
    fakeTmdb();
    const ask = { type: 'movie', tmdbId: 603, searchNow: false, location: { root: 'C:/', folder: 'Windows' } };
    const first = await call(v.cookie, 'POST', '/api/media', ask);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ pending: true });
    expect(mediaCount()).toBe(0);
    // Asking twice is still one request.
    expect((await call(v.cookie, 'POST', '/api/media', ask)).json().requestId).toBe(first.json().requestId);
    expect((await call(v.cookie, 'GET', '/api/requests')).json()).toMatchObject([{ title: 'The Matrix', year: 1999, status: 'pending', username: 'viewer' }]);

    const id = first.json().requestId;
    expect((await call(v.cookie, 'POST', `/api/requests/${id}/approve`)).statusCode).toBe(403);
    expect((await call(a, 'GET', '/api/requests/count')).json()).toEqual({ pending: 1 });
    const ok = await call(a, 'POST', `/api/requests/${id}/approve`);
    expect(ok.statusCode, ok.body).toBe(200);
    // Added in a library folder Mediarr chose, never the one the user sent.
    expect(db.prepare('SELECT title, root_folder FROM media WHERE id = ?').get(ok.json().mediaId)).toEqual({ title: 'The Matrix', root_folder: lib });
    expect((await call(a, 'POST', `/api/requests/${id}/deny`)).statusCode).toBe(409);
    expect((await call(v.cookie, 'GET', '/api/requests')).json()[0]).toMatchObject({ status: 'approved', decidedBy: 'owner' });
    // Asking for it now just points at the library title.
    expect((await call(v.cookie, 'POST', '/api/media', ask)).json()).toEqual({ id: ok.json().mediaId });
  });

  it("can't start downloads some other way", async () => {
    const a = await admin();
    const v = await user(a, 'viewer', true);
    const routes: [string, string][] = [
      ['POST', '/api/media/1/search'],
      ['POST', '/api/media/1/grab'],
      ['PATCH', '/api/media/1/seasons/1'],
      ['PATCH', '/api/episodes/1'],
      ['PATCH', '/api/media/1'],
      ['POST', '/api/suggestions/1/accept'],
    ];
    for (const [method, url] of routes) {
      const res = await call(v.cookie, method, url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toMatch(/approval/);
    }
    // Users without the toggle are unaffected.
    const free = await user(a, 'free', false);
    expect((await call(free.cookie, 'POST', '/api/media/1/search')).statusCode).toBe(404);
  });

  it('declined or withdrawn requests add nothing; users only see their own', async () => {
    const a = await admin();
    const alice = await user(a, 'alice', true);
    const bob = await user(a, 'bobby', true);
    const insert = db.prepare("INSERT INTO requests (user_id, username, type, tmdb_id, title, input, status, created_at) VALUES (?, 'alice', 'movie', ?, ?, '{}', 'pending', ?)");
    const r1 = Number(insert.run(alice.id, 1, 'One', new Date().toISOString()).lastInsertRowid);
    const r2 = Number(insert.run(alice.id, 2, 'Two', new Date().toISOString()).lastInsertRowid);
    expect((await call(bob.cookie, 'GET', '/api/requests')).json()).toEqual([]);
    expect((await call(bob.cookie, 'DELETE', `/api/requests/${r1}`)).statusCode).toBe(404);
    expect((await call(alice.cookie, 'DELETE', `/api/requests/${r1}`)).statusCode).toBe(200);
    expect((await call(a, 'POST', `/api/requests/${r2}/deny`)).statusCode).toBe(200);
    expect((await call(alice.cookie, 'GET', '/api/requests')).json()).toMatchObject([{ title: 'Two', status: 'denied' }]);
    expect((await call(a, 'GET', '/api/requests')).json()).toHaveLength(1);
    expect(mediaCount()).toBe(0);
  });
});
