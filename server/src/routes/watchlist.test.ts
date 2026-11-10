import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { resetPendingChanges } from '../core/watchlist.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
const TOKENS: Record<string, { id: number; name: string; list: number[] }> = {
  'tok-boss-0123456789abcdefghij': { id: 1, name: 'BossOnAniList', list: [154587] },
  'tok-viewer-0123456789abcdefgh': { id: 2, name: 'ViewerOnAniList', list: [21] },
};

let app: FastifyInstance;
let dataDir: string;
let calls: { url: string; body: any; auth: string | null }[];

/** The fake Simkl account. */
let simklState: {
  v2: boolean;
  approved: boolean;
  access: string;
  items: unknown[];
  activity: { all: string; removed: string };
  ids: number[];
};

/** Fake AniList and Simkl: answers by the bearer token, so each user has their own account. */
function fakeServices() {
  calls = [];
  simklState = {
    v2: true,
    approved: false,
    access: 'simkl_at_first-secret-token',
    items: [{ status: 'plantowatch', movie: { title: 'Dune', year: 2021, ids: { simkl: 1, tmdb: 438631 } } }],
    activity: { all: '2026-11-01T00:00:00Z', removed: '' },
    ids: [1],
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const auth = (init.headers as Record<string, string>)?.authorization?.replace('Bearer ', '') ?? null;
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://graphql.anilist.co')) {
      const who = auth ? TOKENS[auth] : undefined;
      if (!who) return json({ errors: [{ message: 'Invalid token', status: 400 }] });
      const q: string = body.query;
      if (q.includes('Viewer')) return json({ data: { Viewer: { id: who.id, name: who.name } } });
      if (q.includes('MediaListCollection')) {
        return json({
          data: {
            MediaListCollection: {
              lists: [{ entries: who.list.map((id) => ({ id: id * 10, status: 'PLANNING', progress: 0, media: { id, idMal: null, title: { romaji: `Anime ${id}`, english: null }, seasonYear: 2023, coverImage: { large: null }, episodes: 12 } })) }],
            },
          },
        });
      }
      if (q.includes('MediaList(')) return json({ data: { MediaList: { id: body.variables.mediaId * 10 } } });
      if (q.includes('SaveMediaListEntry')) return json({ data: { SaveMediaListEntry: { id: 1 } } });
      if (q.includes('DeleteMediaListEntry')) return json({ data: { DeleteMediaListEntry: { deleted: true } } });
    }
    if (url === 'https://api.simkl.com/oauth2/device') {
      if (!simklState.v2) return json({ error: 'invalid_client', error_description: 'This client_id is not enabled for OAuth 2.0' }, 401);
      return json({ device_code: 'DEVICE-SECRET-123', user_code: 'BDWP-HQPK', verification_uri: 'https://simkl.com/pin', verification_uri_complete: 'https://simkl.com/pin?user_code=BDWP-HQPK', expires_in: 900, interval: 5 });
    }
    if (url === 'https://api.simkl.com/oauth2/token') {
      if (body.grant_type === 'refresh_token') {
        simklState.access = 'simkl_at_renewed-secret-token';
        return json({ access_token: simklState.access, refresh_token: body.refresh_token, expires_in: 604800, token_type: 'Bearer' });
      }
      if (!simklState.approved) return json({ error: 'authorization_pending' }, 400);
      return json({ access_token: simklState.access, refresh_token: 'simkl_rt_refresh-secret', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.startsWith('https://api.simkl.com/oauth2/revoke')) return json({});
    if (url.startsWith('https://api.simkl.com/oauth/pin/')) return json({ result: 'OK', access_token: 'simkl-v1-secret-token' });
    if (url.startsWith('https://api.simkl.com/oauth/pin')) return json({ user_code: 'ABCDE', verification_uri: 'https://simkl.com/pin', expires_in: 900, interval: 5 });
    if (url.startsWith('https://api.simkl.com/')) {
      if (auth !== simklState.access && auth !== 'simkl-v1-secret-token') return json({ error: 'unauthorized' }, 401);
    }
    if (url.startsWith('https://api.simkl.com/users/settings')) return json({ user: { name: 'BossOnSimkl' } });
    if (url.startsWith('https://api.simkl.com/sync/activities')) {
      return json({ all: simklState.activity.all, movies: { removed_from_list: simklState.activity.removed }, tv_shows: {}, anime: {} });
    }
    if (url.startsWith('https://api.simkl.com/sync/all-items/all/all')) {
      if (url.includes('simkl_ids_only')) return json({ movies: simklState.ids.map((id) => ({ movie: { ids: { simkl: id } } })) });
      return json({ movies: simklState.items });
    }
    if (url.startsWith('https://api.simkl.com/sync/')) return json({ added: {}, not_found: { movies: [], shows: [] } });
    return json({ error: `unexpected ${url}` }, 404);
  });
}

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-watch-'));
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
  saveSettings({ simklClientId: 'simkl-app', anilistClientId: '12345' });
  fakeServices();
  resetPendingChanges();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

async function users() {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: CSRF,
    payload: { code: prepareSetupCode(dataDir), username: 'boss', password: PASSWORD },
  });
  const boss = cookieFrom(setup);
  const add = await app.inject({ method: 'POST', url: '/api/users', headers: { ...CSRF, cookie: boss }, payload: { username: 'viewer', password: `${PASSWORD} x`, role: 'user' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'viewer', password: `${PASSWORD} x` } });
  return { boss, viewer: cookieFrom(login), viewerId: (add.json() as { id: number }).id };
}

/** Moves the clock forward (only Date is faked). */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Connects Simkl the way the page does: start, the user approves, a poll after the interval. */
async function connectSimkl(cookie: string) {
  const start = await call(cookie, 'POST', '/api/watchlist/simkl/start');
  simklState.approved = true;
  later(6000);
  const poll = await call(cookie, 'POST', '/api/watchlist/simkl/poll');
  return { start, poll };
}

const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { ...CSRF, cookie }, payload: payload as object });

describe('per-user watchlists', () => {
  it('keeps each user’s connections and lists to themselves, and never returns tokens', async () => {
    const { boss, viewer } = await users();
    expect((await call(boss, 'POST', '/api/watchlist/anilist', { token: 'tok-boss-0123456789abcdefghij' })).statusCode).toBe(200);
    expect((await call(viewer, 'POST', '/api/watchlist/anilist', { token: 'tok-viewer-0123456789abcdefgh' })).statusCode).toBe(200);

    const bossList = await call(boss, 'GET', '/api/watchlist');
    const viewerList = await call(viewer, 'GET', '/api/watchlist');
    expect(bossList.json().items.map((i: { key: string }) => i.key)).toEqual(['anime:154587']);
    expect(viewerList.json().items.map((i: { key: string }) => i.key)).toEqual(['anime:21']);
    expect((await call(viewer, 'GET', '/api/watchlist/links')).json().anilist).toMatchObject({ connected: true, account: 'ViewerOnAniList' });

    // Nothing that reaches the browser contains a token, and the database only has sealed ones.
    for (const res of [bossList, viewerList, await call(boss, 'GET', '/api/watchlist/links'), await call(boss, 'GET', '/api/settings')]) {
      expect(res.body).not.toContain('tok-');
    }
    const stored = db.prepare('SELECT token_enc FROM user_links').all() as { token_enc: string }[];
    expect(stored).toHaveLength(2);
    for (const r of stored) expect(r.token_enc).not.toContain('tok-');
  });

  it('rejects a token AniList doesn’t accept', async () => {
    const { viewer } = await users();
    const res = await call(viewer, 'POST', '/api/watchlist/anilist', { token: 'not-a-real-token-0123456789' });
    expect(res.statusCode).toBe(400);
    expect((await call(viewer, 'GET', '/api/watchlist/links')).json().anilist.connected).toBe(false);
  });

  it('connects Simkl with the device flow, keeping the device code on the server', async () => {
    const { boss } = await users();
    const start = await call(boss, 'POST', '/api/watchlist/simkl/start');
    expect(start.json()).toEqual({
      userCode: 'BDWP-HQPK',
      verificationUrl: 'https://simkl.com/pin',
      verificationUrlComplete: 'https://simkl.com/pin?user_code=BDWP-HQPK',
      interval: 5,
    });
    expect(start.body).not.toContain('DEVICE-SECRET');

    // Asking again right away doesn't reach Simkl (it bans apps that poll too fast).
    const before = calls.length;
    expect((await call(boss, 'POST', '/api/watchlist/simkl/poll')).json()).toMatchObject({ status: 'waiting' });
    expect(calls.length).toBe(before);
    later(6000);
    expect((await call(boss, 'POST', '/api/watchlist/simkl/poll')).json()).toMatchObject({ status: 'waiting' });
    simklState.approved = true;
    later(6000);
    expect((await call(boss, 'POST', '/api/watchlist/simkl/poll')).json()).toEqual({ status: 'connected' });
    expect(calls.find((c) => c.url.endsWith('/oauth2/token'))!.body).toMatchObject({ device_code: 'DEVICE-SECRET-123', client_id: 'simkl-app' });

    const links = await call(boss, 'GET', '/api/watchlist/links');
    expect(links.json().simkl).toMatchObject({ connected: true, account: 'BossOnSimkl' });
    expect(links.body).not.toContain('simkl_');
    const stored = (db.prepare("SELECT token_enc FROM user_links WHERE service = 'simkl'").get() as { token_enc: string }).token_enc;
    expect(stored).not.toContain('simkl_');
  });

  it('falls back to the PIN flow for Simkl apps without OAuth 2.0', async () => {
    const { boss } = await users();
    simklState.v2 = false;
    const { start, poll } = await connectSimkl(boss);
    expect(start.json()).toMatchObject({ userCode: 'ABCDE', verificationUrlComplete: null });
    expect(poll.json()).toEqual({ status: 'connected' });
    expect((await call(boss, 'GET', '/api/watchlist')).json().items[0]).toMatchObject({ key: 'movie:438631' });
  });

  it('renews an expired Simkl sign-in by itself', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    later(2 * 3600_000); // this fake access token lasts an hour
    const list = await call(boss, 'GET', '/api/watchlist');
    expect(list.json().errors).toEqual([]);
    expect(calls.some((c) => c.body?.grant_type === 'refresh_token' && c.body.refresh_token === 'simkl_rt_refresh-secret')).toBe(true);
    expect(calls.at(-1)!.auth).toBe('simkl_at_renewed-secret-token');
  });

  it('only fetches the whole Simkl list once, then just the changes', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    const fullFetches = () => calls.filter((c) => c.url.includes('/sync/all-items/all/all') && !c.url.includes('date_from')).length;
    await call(boss, 'GET', '/api/watchlist');
    expect(fullFetches()).toBe(1);

    // Nothing changed on Simkl: only the activities call.
    later(120_000);
    await call(boss, 'GET', '/api/watchlist');
    expect(fullFetches()).toBe(1);

    // Something changed: only the delta since the last sync.
    simklState.activity.all = '2026-11-02T00:00:00Z';
    simklState.items = [{ status: 'completed', movie: { title: 'Dune', year: 2021, ids: { simkl: 1, tmdb: 438631 } } }];
    later(120_000);
    const changed = await call(boss, 'GET', '/api/watchlist');
    expect(changed.json().items[0].status).toBe('completed');
    expect(calls.some((c) => c.url.includes('date_from=2026-11-01T00%3A00%3A00Z'))).toBe(true);
    expect(fullFetches()).toBe(1);

    // Something was removed: Simkl doesn't report removals in the delta, so the ids are compared.
    simklState.activity = { all: '2026-11-03T00:00:00Z', removed: '2026-11-03T00:00:00Z' };
    simklState.items = [];
    simklState.ids = [];
    later(120_000);
    expect((await call(boss, 'GET', '/api/watchlist')).json().items).toEqual([]);
  });

  it('writes Simkl changes with the right ids', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    expect((await call(boss, 'GET', '/api/watchlist')).json().items[0]).toMatchObject({ key: 'movie:438631', status: 'planned', services: { simkl: 'planned' } });

    expect((await call(boss, 'PUT', '/api/watchlist/item', { type: 'movie', id: 438631, status: 'completed' })).statusCode).toBe(200);
    const add = calls.find((c) => c.url.includes('/sync/add-to-list'))!;
    expect(add.body).toEqual({ movies: [{ to: 'completed', ids: { tmdb: 438631 } }] });
    expect(add.auth).toBe('simkl_at_first-secret-token');

    expect((await call(boss, 'DELETE', '/api/watchlist/item?type=movie&id=438631')).statusCode).toBe(200);
    expect(calls.find((c) => c.url.includes('/sync/history/remove'))!.body).toEqual({ movies: [{ ids: { tmdb: 438631 } }] });
  });

  it('shows your change straight away, even before Simkl reports it', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    const list = async () => (await call(boss, 'GET', '/api/watchlist')).json().items as { key: string; status: string }[];
    const summary = async () => (await list()).map((i) => `${i.key} ${i.status}`);
    expect((await list())[0]).toMatchObject({ key: 'movie:438631', status: 'planned' });

    // Simkl took the change but hasn't moved its activity time yet (the fake never does on its own).
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'movie', id: 438631, status: 'completed' });
    expect((await list())[0]).toMatchObject({ key: 'movie:438631', status: 'completed', services: { simkl: 'completed' } });
    // A title new to the list shows up with the name and poster the page sent.
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'movie', id: 27205, status: 'planned', title: 'Inception', year: 2010, poster: 'https://image.tmdb.org/p.jpg' });
    expect(await summary()).toEqual(['movie:438631 completed', 'movie:27205 planned']);
    // The details popup reads the same list.
    expect((await call(boss, 'GET', '/api/watchlist/item?type=movie&id=27205')).json().item).toMatchObject({ title: 'Inception', status: 'planned' });

    // Simkl catches up with the first change; the second is still shown from Mediarr's side.
    simklState.activity = { all: '2026-11-02T00:00:00Z', removed: '' };
    simklState.items = [{ status: 'completed', movie: { title: 'Dune', year: 2021, ids: { simkl: 1, tmdb: 438631 } } }];
    later(120_000);
    expect(await summary()).toEqual(['movie:438631 completed', 'movie:27205 planned']);
    // Removing hides it at once too; after 10 minutes only what Simkl says counts.
    await call(boss, 'DELETE', '/api/watchlist/item?type=movie&id=438631');
    expect((await list()).map((i) => i.key)).toEqual(['movie:27205']);
    later(11 * 60_000);
    expect((await list()).map((i) => i.key)).toEqual(['movie:438631']);
  });

  it('adds anime only to AniList when it is connected, and removes it everywhere', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    await call(boss, 'POST', '/api/watchlist/anilist', { token: 'tok-boss-0123456789abcdefghij' });

    calls.length = 0;
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'anime', id: 21, status: 'planned' });
    expect(calls.some((c) => c.body?.query?.includes('SaveMediaListEntry') && c.body.variables.status === 'PLANNING')).toBe(true);
    expect(calls.some((c) => c.url.includes('/sync/add-to-list'))).toBe(false);
    // Changing its status: AniList only too.
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'anime', id: 21, status: 'completed' });
    expect(calls.some((c) => c.url.includes('/sync/'))).toBe(false);
    // Movies and shows still go to Simkl.
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'show', id: 95396, status: 'watching' });
    expect(calls.filter((c) => c.url.includes('/sync/add-to-list')).map((c) => Object.keys(c.body))).toEqual([['shows']]);

    // Removing clears it from both, in case it was on Simkl from before; AniList's entry is looked up first.
    calls.length = 0;
    await call(boss, 'DELETE', '/api/watchlist/item?type=anime&id=21');
    expect(calls.find((c) => c.body?.query?.includes('DeleteMediaListEntry'))!.body.variables).toEqual({ id: 210 });
    expect(calls.some((c) => c.url.includes('/sync/history/remove') && c.body.shows[0].ids.anilist === 21)).toBe(true);
  });

  it('adds anime to Simkl when AniList is not connected', async () => {
    const { boss } = await users();
    await connectSimkl(boss);
    await call(boss, 'PUT', '/api/watchlist/item', { type: 'anime', id: 21, status: 'planned' });
    expect(calls.some((c) => c.url.includes('/sync/add-to-list') && c.body.shows[0].ids.anilist === 21)).toBe(true);
  });

  it('refuses bad input and needs a connected service', async () => {
    const { viewer } = await users();
    expect((await call(viewer, 'PUT', '/api/watchlist/item', { type: 'movie', id: 1, status: 'planned' })).statusCode).toBe(400);
    await call(viewer, 'POST', '/api/watchlist/anilist', { token: 'tok-viewer-0123456789abcdefgh' });
    expect((await call(viewer, 'PUT', '/api/watchlist/item', { type: 'anime', id: 21, status: 'nope' })).statusCode).toBe(400);
    expect((await call(viewer, 'PUT', '/api/watchlist/item', { type: 'anime', id: -3, status: 'planned' })).statusCode).toBe(400);
    // AniList only takes anime.
    expect((await call(viewer, 'PUT', '/api/watchlist/item', { type: 'movie', id: 1, status: 'planned' })).statusCode).toBe(400);
  });

  it('removes a user’s connections when the user is deleted', async () => {
    const { boss, viewer, viewerId } = await users();
    await call(viewer, 'POST', '/api/watchlist/anilist', { token: 'tok-viewer-0123456789abcdefgh' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_links WHERE user_id = ?').get(viewerId)).toEqual({ n: 1 });
    expect((await call(boss, 'DELETE', `/api/users/${viewerId}`)).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_links WHERE user_id = ?').get(viewerId)).toEqual({ n: 0 });
  });
});
