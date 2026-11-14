import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb, now } from '../db.js';
import { getParty, resetParties, sweepParties } from './store.js';
import { EMPTY_END_MS } from './state.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let lib: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  resetParties();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-party-'));
  lib = path.join(dataDir, 'Shows');
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
  resetParties();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Res = { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string };
const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const call = (cookie: string | undefined, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Res> =>
  app.inject({ method, url, headers: { ...CSRF, ...(cookie ? { cookie } : {}) }, payload: payload as object }) as unknown as Promise<Res>;

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
  const host = await add('host', true);
  const friend = await add('friend', false);
  const fan = await add('fan', true);
  return { boss, host, friend, fan };
}

/** A show with two downloaded episodes, each a real file in its folder. */
function addShow(title: string, adult = 0): { id: number; eps: number[] } {
  const folder = path.join(lib, title);
  fs.mkdirSync(folder, { recursive: true });
  const id = Number(
    db
      .prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, poster, added_at, adult) VALUES ('show', ?, ?, 2020, ?, ?, ?, ?, ?)`)
      .run(100 + title.length, title, lib, title, `https://img/${title}.jpg`, now(), adult).lastInsertRowid,
  );
  const eps = [1, 2].map((n) => {
    const file = path.join(folder, `${title} - S01E0${n}.mkv`);
    fs.writeFileSync(file, 'x');
    return Number(db.prepare('INSERT INTO episodes (media_id, season, episode, title, has_file, file_path) VALUES (?, 1, ?, ?, 1, ?)').run(id, n, `Ep ${n}`, file).lastInsertRowid);
  });
  return { id, eps };
}

async function startParty(cookie: string, ep: number) {
  const res = await call(cookie, 'POST', '/api/party', { kind: 'episode', id: ep, position: 12 });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; url: string };
}

async function joinAsGuest(cookie: string, partyId: string, name?: string) {
  const link = await call(cookie, 'POST', `/api/party/${partyId}/guest-link`);
  expect(link.statusCode, link.body).toBe(200);
  const url = link.json().url as string;
  expect(url).toMatch(new RegExp(`^/party/${partyId}/guest#[A-Za-z0-9_-]{22,}$`));
  const code = url.split('#')[1];
  const join = await call(undefined, 'POST', `/api/party/${partyId}/guest-join`, { code, ...(name === undefined ? {} : { name }) });
  expect(join.statusCode, join.body).toBe(200);
  expect(join.json()).toEqual({ ok: true });
  return { guest: cookieFrom(join), setCookie: String(join.headers['set-cookie']), code, url };
}

describe('watch parties', () => {
  it('any account can start a party and invite another; the invitee gets a notification marked active', async () => {
    const { friend, fan } = await users();
    const show = addShow('Bluey');
    const party = await startParty(friend.cookie, show.eps[0]);
    expect(party.url).toBe(`/party/${party.id}`);
    expect(party.id).toMatch(/^[0-9a-f]{32}$/);

    const inv = await call(friend.cookie, 'POST', `/api/party/${party.id}/invite`, { userIds: [fan.id, 9999, friend.id] });
    expect(inv.statusCode, inv.body).toBe(200);
    expect(inv.json()).toEqual({ invited: [fan.id] });
    // Asking again notifies nobody new.
    expect((await call(friend.cookie, 'POST', `/api/party/${party.id}/invite`, { userIds: [fan.id] })).json()).toEqual({ invited: [] });

    const notes = (await call(fan.cookie, 'GET', '/api/notifications')).json();
    expect(notes.unread).toBe(1);
    expect(notes.items[0]).toMatchObject({
      kind: 'party_invite',
      active: true,
      payload: { partyId: party.id, from: 'friend', title: 'Bluey', subtitle: 'S01E01 · Ep 1', poster: 'https://img/Bluey.jpg' },
    });

    const info = await call(fan.cookie, 'GET', `/api/party/${party.id}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      id: party.id,
      title: { kind: 'episode', id: show.eps[0] },
      mediaId: show.id,
      titleLabel: 'Bluey',
      subtitle: 'S01E01 · Ep 1',
      hostUserId: friend.id,
      isHost: false,
      guestInviteAllowed: true,
      members: [{ key: `u:${friend.id}`, name: 'friend', connected: false, buffering: false }],
      state: { playing: false, position: 12 },
      ended: false,
    });
    expect((await call(friend.cookie, 'GET', `/api/party/${party.id}`)).json().isHost).toBe(true);

    // Ending it marks the invite inactive.
    await call(friend.cookie, 'POST', `/api/party/${party.id}/end`);
    expect((await call(fan.cookie, 'GET', '/api/notifications')).json().items[0].active).toBe(false);
  });

  it('a guest link joins as "Guest 2" and the cookie opens only that title', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const other = addShow('Bandit');
    const party = await startParty(host.cookie, show.eps[0]);
    const { guest, setCookie } = await joinAsGuest(host.cookie, party.id);
    expect(setCookie).toMatch(/^mediarr_guest=[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');

    const info = (await call(guest, 'GET', `/api/party/${party.id}`)).json();
    expect(info.members.map((m: { name: string }) => m.name)).toEqual(['host', 'Guest 2']);
    expect(info.isHost).toBe(false);
    expect(info.guestInviteAllowed).toBe(false);

    // The party's title: allowed (info needs FFmpeg, so it's only checked to get past the guards).
    expect((await call(guest, 'GET', `/api/play/episode/${show.eps[0]}/extras`)).statusCode).toBe(200);
    // Direct play of the party's title (what start hands out for files the browser plays as they are).
    const direct = await call(guest, 'GET', `/api/play/direct/episode/${show.eps[0]}`);
    expect(direct.statusCode).toBe(200);
    expect(direct.body).toBe('x');
    expect([401, 403, 404]).not.toContain((await call(guest, 'GET', `/api/play/episode/${show.eps[0]}/info`)).statusCode);
    // Another episode, another show: not found.
    expect((await call(guest, 'GET', `/api/play/episode/${show.eps[1]}/info`)).statusCode).toBe(404);
    expect((await call(guest, 'GET', `/api/play/episode/${other.eps[0]}/extras`)).statusCode).toBe(404);
    expect((await call(guest, 'GET', `/api/play/movie/${show.id}/info`)).statusCode).toBe(404);
    // Nothing else in Mediarr.
    for (const url of ['/api/media', '/api/home', '/api/notifications', '/api/party/invitees?mediaId=1', '/api/auth/status/x']) {
      expect((await call(guest, 'GET', url)).statusCode, url).toBe(401);
    }
    expect((await call(guest, 'POST', '/api/party', { kind: 'episode', id: show.eps[0] })).statusCode).toBe(401);
    expect((await call(guest, 'POST', `/api/party/${party.id}/guest-link`)).statusCode).toBe(401);
    expect((await call(guest, 'POST', `/api/party/${party.id}/invite`, { userIds: [] })).statusCode).toBe(401);
    expect((await call(guest, 'POST', `/api/party/${party.id}/end`)).statusCode).toBe(401);
    // Status says they're not a signed-in user.
    expect((await call(guest, 'GET', '/api/auth/status')).json().user ?? null).toBeNull();

    // A second guest (no cookie yet) gets the next number; names are cleaned up.
    const second = await joinAsGuest(host.cookie, party.id, '  \u0007Alex‮ the Great Destroyer of Worlds  ');
    const names = (await call(second.guest, 'GET', `/api/party/${party.id}`)).json().members.map((m: { name: string }) => m.name);
    expect(names).toEqual(['host', 'Guest 2', 'Alex the Great Destroyer']);
  });

  it('the same guest link comes back each time, and a wrong code is refused and rate limited', async () => {
    const { host, fan } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const a = (await call(host.cookie, 'POST', `/api/party/${party.id}/guest-link`)).json().url;
    const b = (await call(fan.cookie, 'POST', `/api/party/${party.id}/guest-link`)).json().url;
    expect(a).toBe(b);
    for (let i = 0; i < 5; i++) {
      const r = await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code: `wrong${i}` });
      expect(r.statusCode).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    // Locked now, even with the right code.
    const locked = await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code: a.split('#')[1] });
    expect(locked.statusCode).toBe(429);
    expect((await call(undefined, 'POST', '/api/party/0123456789abcdef0123456789abcdef/guest-join', { code: 'x' })).statusCode).toBe(404);
  });

  it('wrong codes from one address don’t lock out another', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const code = (await call(host.cookie, 'POST', `/api/party/${party.id}/guest-link`)).json().url.split('#')[1];
    const join = (ip: string, c: string) =>
      app.inject({ method: 'POST', url: `/api/party/${party.id}/guest-join`, headers: CSRF, payload: { code: c }, remoteAddress: ip });
    for (let i = 0; i < 6; i++) await join('203.0.113.5', `wrong${i}`);
    expect((await join('203.0.113.5', code)).statusCode).toBe(429);
    expect((await join('198.51.100.7', code)).statusCode).toBe(200);
  });

  it('links to ended or unknown parties don’t count against the sign-in lockout; wrong codes for a live one do', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const ended = await startParty(host.cookie, show.eps[0]);
    const { code: endedCode } = await joinAsGuest(host.cookie, ended.id);
    expect((await call(host.cookie, 'POST', `/api/party/${ended.id}/end`)).statusCode).toBe(200);
    const ip = '203.0.113.9';
    const join = (id: string, c: string) =>
      app.inject({ method: 'POST', url: `/api/party/${id}/guest-join`, headers: CSRF, payload: { code: c }, remoteAddress: ip });
    // Well past both the per-party (5) and the per-address login (10) limits.
    for (let i = 0; i < 12; i++) {
      expect((await join(ended.id, endedCode)).statusCode).toBe(404);
      expect((await join('0123456789abcdef0123456789abcdef', 'x')).statusCode).toBe(404);
    }
    // Signing in from that address still works.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'host', password: `${PASSWORD} x` }, remoteAddress: ip });
    expect(login.statusCode, login.body).toBe(200);
    // A live party: wrong codes still count and lock this address out of it.
    const live = await startParty(host.cookie, show.eps[1]);
    const code = (await call(host.cookie, 'POST', `/api/party/${live.id}/guest-link`)).json().url.split('#')[1];
    for (let i = 0; i < 5; i++) expect((await join(live.id, `wrong${i}`)).statusCode).toBe(403);
    expect((await join(live.id, code)).statusCode).toBe(429);
  });

  it('takes at most 10 guests', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const code = (await call(host.cookie, 'POST', `/api/party/${party.id}/guest-link`)).json().url.split('#')[1];
    for (let i = 0; i < 10; i++) expect((await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code })).statusCode).toBe(200);
    const full = await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code });
    expect(full.statusCode).toBe(403);
    expect(full.json().error).toBe('This watch party is full.');
    expect(full.headers['set-cookie']).toBeUndefined();
  });

  it('guest token for an ended party is refused everywhere', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const { guest, code } = await joinAsGuest(host.cookie, party.id);
    const stream = '/api/play/hls/0123456789abcdef0123456789abcdef/seg3.ts';
    expect((await call(guest, 'GET', stream)).statusCode).toBe(404); // past the guards, just no such stream
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/end`)).statusCode).toBe(200);
    expect((await call(guest, 'GET', `/api/party/${party.id}`)).statusCode).toBe(401);
    expect((await call(guest, 'GET', `/api/play/episode/${show.eps[0]}/extras`)).statusCode).toBe(401);
    expect((await call(guest, 'GET', stream)).statusCode).toBe(401);
    expect((await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code })).statusCode).toBe(404);
    expect(getParty(party.id)).toBeNull();
    // Members still see that it ended.
    expect((await call(host.cookie, 'GET', `/api/party/${party.id}`)).json().ended).toBe(true);
  });

  it('a party nobody joins ends by itself, and so does its guest link', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const { guest } = await joinAsGuest(host.cookie, party.id);
    sweepParties(Date.now() + EMPTY_END_MS + 1000);
    expect((await call(guest, 'GET', `/api/party/${party.id}`)).statusCode).toBe(401);
  });

  it('a guest who leaves loses access; a forged or tampered cookie gets nothing', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const { guest } = await joinAsGuest(host.cookie, party.id);
    const [, value] = guest.split('=');
    const [pid, gid, secret] = value.split('.');
    const flip = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
    for (const forged of [`mediarr_guest=${pid}.${gid}.${flip}`, `mediarr_guest=${pid}.${Number(gid) + 1}.${secret}`, `mediarr_guest=${pid}.${gid}`, 'mediarr_guest=garbage']) {
      expect((await call(forged, 'GET', `/api/party/${party.id}`)).statusCode, forged).toBe(401);
    }
    const left = await call(guest, 'POST', `/api/party/${party.id}/leave`);
    expect(left.statusCode).toBe(200);
    expect(String(left.headers['set-cookie'])).toMatch(/^mediarr_guest=;.*Max-Age=0/);
    expect((await call(guest, 'GET', `/api/party/${party.id}`)).statusCode).toBe(401);
  });

  it('guest can’t open another party, and can’t save progress', async () => {
    const { host, fan } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const otherParty = await startParty(fan.cookie, show.eps[1]);
    const { guest } = await joinAsGuest(host.cookie, party.id);
    expect((await call(guest, 'GET', `/api/party/${otherParty.id}`)).statusCode).toBe(404);
    expect((await call(guest, 'POST', `/api/party/${otherParty.id}/leave`)).statusCode).toBe(404);
    expect((await call(guest, 'GET', `/api/play/episode/${show.eps[1]}/extras`)).statusCode).toBe(404);
    expect((await call(guest, 'PUT', `/api/play/episode/${show.eps[0]}/progress`, { position: 10, duration: 100 })).statusCode).toBe(401);
    expect((await call(guest, 'GET', `/api/play/direct/episode/${show.eps[1]}`)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM watch_progress').get()).toEqual({ n: 0 });
  });

  it('a signed-in user’s session wins over a guest cookie', async () => {
    const { host, friend } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    const { guest } = await joinAsGuest(host.cookie, party.id);
    const both = `${friend.cookie}; ${guest}`;
    // As friend (a user), not as the guest: no guest-only restriction on the title, no guest membership.
    expect((await call(both, 'GET', `/api/play/episode/${show.eps[1]}/extras`)).statusCode).toBe(200);
    const res = await call(both, 'GET', `/api/party/${party.id}`);
    expect(res.statusCode).toBe(200);
    // A signed-in user can't become a guest.
    const code = (await call(host.cookie, 'POST', `/api/party/${party.id}/guest-link`)).json().url.split('#')[1];
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/guest-join`, { code })).statusCode).toBe(403);
  });

  it('no guest link for an 18+ title, and an account without NSFW access can’t start or join an 18+ party', async () => {
    const { host, friend } = await users();
    const show = addShow('Spicy', 1);
    expect((await call(friend.cookie, 'POST', '/api/party', { kind: 'episode', id: show.eps[0], position: 0 })).statusCode).toBe(404);
    const party = await startParty(host.cookie, show.eps[0]);
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/guest-link`)).statusCode).toBe(403);
    expect((await call(host.cookie, 'GET', `/api/party/${party.id}`)).json().guestInviteAllowed).toBe(false);
    expect((await call(friend.cookie, 'GET', `/api/party/${party.id}`)).statusCode).toBe(404);
    // Nor stream its file directly.
    expect((await call(friend.cookie, 'GET', `/api/play/direct/episode/${show.eps[0]}`)).statusCode).toBe(404);
    // Inviting them is skipped.
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/invite`, { userIds: [friend.id] })).json()).toEqual({ invited: [] });
    expect((await call(friend.cookie, 'GET', '/api/notifications')).json().unread).toBe(0);
  });

  it('only the host can end the party; anyone can leave', async () => {
    const { host, fan } = await users();
    const show = addShow('Bluey');
    const party = await startParty(host.cookie, show.eps[0]);
    expect((await call(fan.cookie, 'POST', `/api/party/${party.id}/end`)).statusCode).toBe(403);
    expect(getParty(party.id)).not.toBeNull();
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/leave`)).statusCode).toBe(200);
    // The host leaving doesn't end it.
    expect(getParty(party.id)).not.toBeNull();
    expect((await call(host.cookie, 'POST', '/api/party/0123456789abcdef0123456789abcdef/end')).statusCode).toBe(404);
  });

  it('checks what it is given', async () => {
    const { host } = await users();
    const show = addShow('Bluey');
    for (const body of [{ kind: 'show', id: show.id }, { kind: 'episode', id: -1 }, { kind: 'episode', id: 'x' }, {}]) {
      expect((await call(host.cookie, 'POST', '/api/party', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call(host.cookie, 'POST', '/api/party', { kind: 'episode', id: 99999 })).statusCode).toBe(404);
    const far = (await call(host.cookie, 'POST', '/api/party', { kind: 'episode', id: show.eps[0], position: 'Infinity' })).json();
    expect((await call(host.cookie, 'GET', `/api/party/${far.id}`)).json().state.position).toBe(0);
    const party = await startParty(host.cookie, show.eps[0]);
    expect((await call(host.cookie, 'POST', `/api/party/${party.id}/invite`, { userIds: 'all' })).statusCode).toBe(400);
    expect((await call(undefined, 'POST', `/api/party/${party.id}/guest-join`, { code: 42 })).statusCode).toBe(400);
  });
});

describe('the invitee list', () => {
  it('is not found for an 18+ title when you may not see it', async () => {
    const { host, friend } = await users();
    const spicy = addShow('Spicy', 1);
    expect((await call(friend.cookie, 'GET', `/api/party/invitees?mediaId=${spicy.id}`)).statusCode).toBe(404);
    const list = (await call(host.cookie, 'GET', `/api/party/invitees?mediaId=${spicy.id}`)).json() as { username: string }[];
    expect(list.map((u) => u.username)).toEqual(['fan']); // only accounts allowed 18+ titles
  });
});
