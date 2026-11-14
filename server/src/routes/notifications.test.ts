import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb } from '../db.js';
import { notify, setPartyActiveCheck, type PartyInvitePayload } from '../core/notifications.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  setPartyActiveCheck(() => false);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-notif-'));
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const call = (cookie: string | undefined, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { ...CSRF, ...(cookie ? { cookie } : {}) }, payload: payload as object });

async function users() {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: CSRF,
    payload: { code: prepareSetupCode(dataDir), username: 'boss', password: PASSWORD },
  });
  const boss = cookieFrom(setup);
  const add = async (username: string, allowAdult: boolean) => {
    const r = await call(boss, 'POST', '/api/users', { username, password: `${PASSWORD} x`, role: 'user', allowAdult });
    const login = await call(undefined, 'POST', '/api/auth/login', { username, password: `${PASSWORD} x` });
    return { cookie: cookieFrom(login), id: (r.json() as { id: number }).id };
  };
  const viewer = await add('viewer', false);
  const adultFan = await add('Adult', true);
  const bossId = (db.prepare('SELECT id FROM users WHERE username = ?').get('boss') as { id: number }).id;
  return { boss, bossId, viewer, adultFan };
}

const payload = (partyId = 'p1'): PartyInvitePayload => ({ partyId, from: 'boss', title: 'Dune', subtitle: null, poster: null });
const addMedia = (title: string, adult: number) =>
  Number(
    db
      .prepare("INSERT INTO media (type, title, root_folder, folder_name, added_at, adult) VALUES ('movie', ?, '/m', ?, '2026-01-01', ?)")
      .run(title, title, adult).lastInsertRowid,
  );

describe('notifications', () => {
  it('a user sees only their own notifications', async () => {
    const { viewer, boss, bossId } = await users();
    notify(bossId, 'party_invite', payload());
    const mine = (await call(boss, 'GET', '/api/notifications')).json();
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({ kind: 'party_invite', read: false, active: false, payload: { partyId: 'p1', title: 'Dune' } });
    const theirs = (await call(viewer.cookie, 'GET', '/api/notifications')).json();
    expect(theirs).toEqual({ unread: 0, items: [] });
  });

  it('reports active from the injected check', async () => {
    const { boss, bossId } = await users();
    setPartyActiveCheck((id) => id === 'p1');
    notify(bossId, 'party_invite', payload('p1'));
    notify(bossId, 'party_invite', payload('p2'));
    const items = (await call(boss, 'GET', '/api/notifications')).json().items as { payload: { partyId: string }; active: boolean }[];
    expect(Object.fromEntries(items.map((i) => [i.payload.partyId, i.active]))).toEqual({ p1: true, p2: false });
  });

  it('unread count drops after marking read', async () => {
    const { boss, bossId } = await users();
    const a = notify(bossId, 'party_invite', payload('a'));
    notify(bossId, 'party_invite', payload('b'));
    expect((await call(boss, 'GET', '/api/notifications')).json().unread).toBe(2);
    expect((await call(boss, 'POST', '/api/notifications/read', { ids: [a] })).statusCode).toBe(200);
    expect((await call(boss, 'GET', '/api/notifications')).json().unread).toBe(1);
    await call(boss, 'POST', '/api/notifications/read', { ids: 'all' });
    expect((await call(boss, 'GET', '/api/notifications')).json().unread).toBe(0);
    expect((await call(boss, 'POST', '/api/notifications/read', { ids: 'nope' })).statusCode).toBe(400);
    expect((await call(boss, 'POST', '/api/notifications/read', {})).statusCode).toBe(400);
  });

  it('marking read ignores someone else ids', async () => {
    const { boss, bossId, viewer } = await users();
    const id = notify(bossId, 'party_invite', payload());
    await call(viewer.cookie, 'POST', '/api/notifications/read', { ids: [id] });
    expect((await call(boss, 'GET', '/api/notifications')).json().unread).toBe(1);
  });

  it('dismiss removes it', async () => {
    const { boss, bossId } = await users();
    const id = notify(bossId, 'party_invite', payload());
    expect((await call(boss, 'DELETE', `/api/notifications/${id}`)).statusCode).toBe(200);
    expect((await call(boss, 'GET', '/api/notifications')).json().items).toEqual([]);
  });

  it('cannot dismiss someone else notification', async () => {
    const { boss, bossId, viewer } = await users();
    const id = notify(bossId, 'party_invite', payload());
    expect((await call(viewer.cookie, 'DELETE', `/api/notifications/${id}`)).statusCode).toBe(404);
    expect((await call(boss, 'GET', '/api/notifications')).json().items).toHaveLength(1);
  });
});

describe('party invitees', () => {
  it('excludes yourself and, for an 18+ title, accounts without NSFW access', async () => {
    const { boss, viewer, adultFan } = await users();
    const plain = addMedia('Dune', 0);
    const nsfw = addMedia('Spicy', 1);

    const forPlain = (await call(viewer.cookie, 'GET', `/api/party/invitees?mediaId=${plain}`)).json();
    expect(forPlain.map((u: { username: string }) => u.username)).toEqual(['Adult', 'boss']);

    // The 18+ title: only NSFW-allowed accounts are listed, and only to someone allowed to see it.
    expect((await call(boss, 'GET', `/api/party/invitees?mediaId=${nsfw}`)).statusCode).toBe(404);
    expect((await call(viewer.cookie, 'GET', `/api/party/invitees?mediaId=${nsfw}`)).statusCode).toBe(404);
    db.prepare('UPDATE users SET allow_adult = 1 WHERE username = ?').run('boss');
    const forNsfw = (await call(boss, 'GET', `/api/party/invitees?mediaId=${nsfw}`)).json();
    expect(forNsfw).toEqual([{ id: adultFan.id, username: 'Adult' }]);

    expect((await call(boss, 'GET', '/api/party/invitees?mediaId=9999')).statusCode).toBe(404);
    expect((await call(boss, 'GET', '/api/party/invitees')).statusCode).toBe(404);
  });
});

describe('access', () => {
  it('a regular user can call these; signed out gets 401', async () => {
    const { viewer } = await users();
    const m = addMedia('Dune', 0);
    expect((await call(viewer.cookie, 'GET', '/api/notifications')).statusCode).toBe(200);
    expect((await call(viewer.cookie, 'POST', '/api/notifications/read', { ids: 'all' })).statusCode).toBe(200);
    expect((await call(viewer.cookie, 'DELETE', '/api/notifications/1')).statusCode).toBe(404);
    expect((await call(viewer.cookie, 'GET', `/api/party/invitees?mediaId=${m}`)).statusCode).toBe(200);
    for (const [method, url] of [
      ['GET', '/api/notifications'],
      ['POST', '/api/notifications/read'],
      ['DELETE', '/api/notifications/1'],
      ['GET', `/api/party/invitees?mediaId=${m}`],
    ] as const) {
      expect((await call(undefined, method, url, method === 'POST' ? { ids: 'all' } : undefined)).statusCode).toBe(401);
    }
  });
});
