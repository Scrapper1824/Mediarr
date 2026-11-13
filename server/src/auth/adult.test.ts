import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { db, initDb, logHistory, now } from '../db.js';
import { resetRateLimits } from './rateLimit.js';
import { prepareSetupCode } from './routes.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let dataDir: string;
let setupCode: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-adult-'));
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
  setupCode = prepareSetupCode(dataDir)!;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers: { ...CSRF, cookie }, payload: method === 'GET' ? undefined : ((payload ?? {}) as object) });

async function admin() {
  return cookieFrom(await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: setupCode, username: 'owner', password: PASSWORD } }));
}
async function user(a: string, username: string, allowAdult: boolean) {
  const res = await call(a, 'POST', '/api/users', { username, password: `${PASSWORD} x`, role: 'user', allowAdult });
  expect(res.statusCode, res.body).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username, password: `${PASSWORD} x` } });
  return { id: (res.json() as { id: number }).id, cookie: cookieFrom(login) };
}

/** A movie in the library with its file on disk (so it shows on Home). */
function movie(title: string, adult: boolean) {
  const file = path.join(dataDir, `${title}.mkv`);
  fs.writeFileSync(file, 'x');
  const id = Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, has_file, file_path, adult, added_at) VALUES ('movie', ?, ?, 2020, ?, ?, 1, ?, ?, ?)`)
      .run(Math.floor(Math.random() * 1e9), title, dataDir, title, file, adult ? 1 : 0, now()).lastInsertRowid,
  );
  logHistory(id, 'imported', `Imported ${title}`);
  return id;
}

describe('18+ content, per user', () => {
  it('is off by default and only admins turn it on', async () => {
    const a = await admin();
    const v = await user(a, 'viewer', false);
    expect((await call(v.cookie, 'GET', '/api/auth/status')).json().user.allowAdult).toBe(false);
    expect((await call(v.cookie, 'PATCH', `/api/users/${v.id}`, { allowAdult: true })).statusCode).toBe(403);
    expect((await call(a, 'PATCH', `/api/users/${v.id}`, { allowAdult: true })).json().allowAdult).toBe(true);
    expect((await call(v.cookie, 'GET', '/api/auth/status')).json().user.allowAdult).toBe(true);
    // Admins have the same switch, also off until turned on.
    expect((await call(a, 'GET', '/api/auth/status')).json().user.allowAdult).toBe(false);
  });

  it('hides 18+ titles in the library from users without it', async () => {
    const a = await admin();
    const sfw = await user(a, 'sfw', false);
    const nsfw = await user(a, 'nsfw', true);
    const normal = movie('Normal Film', false);
    const adult = movie('Adult Film', true);

    const titles = async (c: string) => (await call(c, 'GET', '/api/media')).json().map((m: { title: string }) => m.title);
    expect(await titles(sfw.cookie)).toEqual(['Normal Film']);
    expect((await titles(nsfw.cookie)).sort()).toEqual(['Adult Film', 'Normal Film']);

    expect((await call(sfw.cookie, 'GET', `/api/media/${adult}`)).statusCode).toBe(404);
    expect((await call(sfw.cookie, 'GET', `/api/media/${normal}`)).statusCode).toBe(200);
    expect((await call(nsfw.cookie, 'GET', `/api/media/${adult}`)).statusCode).toBe(200);
    expect((await call(sfw.cookie, 'GET', `/api/play/movie/${adult}/info`)).statusCode).toBe(404);
    expect((await call(sfw.cookie, 'GET', `/api/play/progress/${adult}`)).statusCode).toBe(404);

    const home = async (c: string) => (await call(c, 'GET', '/api/home')).json().recent.map((t: { title: string }) => t.title);
    expect(await home(sfw.cookie)).toEqual(['Normal Film']);
    expect((await home(nsfw.cookie)).sort()).toEqual(['Adult Film', 'Normal Film']);

    const history = async (c: string) => (await call(c, 'GET', '/api/history')).json().map((h: { message: string }) => h.message);
    expect(await history(sfw.cookie)).not.toContain('Imported Adult Film');
    expect(await history(nsfw.cookie)).toContain('Imported Adult Film');
  });

  it('anime search asks AniList for 18+ titles only when allowed; the 18+ genre and tags likewise', async () => {
    const a = await admin();
    const sfw = await user(a, 'sfw', false);
    const nsfw = await user(a, 'nsfw', true);
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('graphql.anilist.co')) {
        const { query } = JSON.parse(String(init!.body));
        queries.push(query);
        if (query.includes('GenreCollection'))
          return Response.json({ data: { GenreCollection: ['Action', 'Hentai'], MediaTagCollection: [{ name: 'Isekai', category: 'Theme-Fantasy', isAdult: false }, { name: 'Nudity', category: 'Sexual Content', isAdult: true }] } });
        if (query.includes('p1: Page')) return Response.json({ data: { p1: { media: [] }, p2: { media: [] }, p3: { media: [] }, p4: { media: [] } } });
        return Response.json({ data: { Page: { media: [] } } });
      }
      return new Response('{}', { status: 404 });
    });
    await call(sfw.cookie, 'GET', '/api/discover/search?type=anime&q=overflow');
    expect(queries.at(-1)).toContain('isAdult: false');
    await call(nsfw.cookie, 'GET', '/api/discover/search?type=anime&q=overflow');
    expect(queries.at(-1)).not.toContain('isAdult: false');

    const names = async (c: string) => (await call(c, 'GET', '/api/discover/genres?type=anime')).json().map((g: { name: string }) => g.name);
    expect(await names(sfw.cookie)).toEqual(['Action', 'Isekai']);
    expect(await names(nsfw.cookie)).toEqual(['Action', 'Hentai', 'Isekai', 'Nudity']);
  });
});
