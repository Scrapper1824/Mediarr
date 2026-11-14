import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb, now } from '../db.js';
import { saveSettings } from '../settings.js';
import type { Decision } from '../playback/decide.js';
import type { MediaProbe } from '../playback/probe.js';
import { createSession, useLauncher } from '../playback/sessions.js';
import { tickParties } from './socket.js';
import { MAX_LEAD_MS, positionAt, SKIP_BUFFERING_MS } from './state.js';
import { endParty, getParty, resetParties } from './store.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let lib: string;
let base: string;
let host: string;
const open: WebSocket[] = [];

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  resetParties();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-socket-'));
  lib = path.join(dataDir, 'Shows');
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  host = `127.0.0.1:${addr.port}`;
  base = `http://${host}`;
});
afterEach(async () => {
  for (const ws of open) ws.terminate();
  open.length = 0;
  await app.close();
  resetParties();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Res = { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string };
const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const call = (cookie: string | undefined, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Res> =>
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
  return { alice: await add('alice', true), bob: await add('bob', true), kid: await add('kid', false) };
}

/** A show with `count` downloaded episodes, each a real file in its folder. */
function addShow(title: string, opts: { adult?: number; count?: number } = {}): { id: number; eps: number[] } {
  const folder = path.join(lib, title);
  fs.mkdirSync(folder, { recursive: true });
  const id = Number(
    db
      .prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, poster, added_at, adult) VALUES ('show', ?, ?, 2020, ?, ?, ?, ?, ?)`)
      .run(100 + [...title].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7) % 100_000, title, lib, title, `https://img/${title}.jpg`, now(), opts.adult ?? 0).lastInsertRowid,
  );
  const eps = Array.from({ length: opts.count ?? 2 }, (_, i) => {
    const file = path.join(folder, `${title} - S01E0${i + 1}.mp4`);
    fs.writeFileSync(file, 'x');
    return Number(db.prepare('INSERT INTO episodes (media_id, season, episode, title, has_file, file_path) VALUES (?, 1, ?, ?, 1, ?)').run(id, i + 1, `Ep ${i + 1}`, file).lastInsertRowid);
  });
  return { id, eps };
}

async function startParty(cookie: string, ep: number): Promise<string> {
  const res = await call(cookie, 'POST', '/api/party', { kind: 'episode', id: ep, position: 12 });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

async function guestOf(hostCookie: string, partyId: string): Promise<string> {
  const code = (await call(hostCookie, 'POST', `/api/party/${partyId}/guest-link`)).json().url.split('#')[1];
  return cookieFrom(await call(undefined, 'POST', `/api/party/${partyId}/guest-join`, { code, name: 'Gus' }));
}

type Msg = { t: string; [k: string]: any };

/** A socket that records what it receives, with a way to wait for the next matching message. */
class Client {
  msgs: Msg[] = [];
  private seen = 0;
  private waiters: (() => void)[] = [];
  closed: Promise<{ code: number }>;
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(String(d)));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve({ code })));
  }
  send(m: unknown) {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  /** The next not-yet-consumed message matching `pred` (earlier non-matching ones are skipped). */
  async next(pred: (m: Msg) => boolean = () => true, ms = 2000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      while (this.seen < this.msgs.length) {
        const m = this.msgs[this.seen++];
        if (pred(m)) return m;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching message; got ${JSON.stringify(this.msgs)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
  /** Waits until the server has handled everything sent before (messages are handled in order). */
  async sync() {
    const c = Math.random();
    this.send({ t: 'ping', c });
    await this.next((m) => m.t === 'pong' && m.c === c);
  }
}

const isState = (m: Msg) => m.t === 'state';

function rawSocket(partyId: string, cookie: string | undefined, origin: string | null = base) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const ws = new WebSocket(`ws://${host}/api/party/${partyId}/socket`, { headers });
  ws.on('error', () => undefined); // refused upgrades are checked through 'unexpected-response'
  open.push(ws);
  return ws;
}

async function connectAs(partyId: string, cookie: string): Promise<Client> {
  const ws = rawSocket(partyId, cookie);
  const c = new Client(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return c;
}

/** The HTTP status an upgrade attempt was refused with. */
function refusedWith(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('upgrade was accepted')));
  });
}

describe('party socket: who may connect', () => {
  it('runs the sign-in check on the upgrade: no session or guest cookie is refused', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    expect(await refusedWith(rawSocket(party, undefined))).toBe(401);
    expect(await refusedWith(rawSocket(party, 'mediarr_session=forged'))).toBe(401);
  });

  it('a cross-site Origin is refused, and so is a missing one', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    expect(await refusedWith(rawSocket(party, alice.cookie, 'https://evil.example'))).toBe(403);
    expect(await refusedWith(rawSocket(party, alice.cookie, null))).toBe(403);
    await connectAs(party, alice.cookie); // same origin works
  });

  it('an account that may not see the title, an unknown party and an ended one are refused', async () => {
    const { alice, kid } = await users();
    const adult = await startParty(alice.cookie, addShow('Spicy', { adult: 1 }).eps[0]);
    expect(await refusedWith(rawSocket(adult, kid.cookie))).toBe(404);
    expect(await refusedWith(rawSocket('0'.repeat(32), alice.cookie))).toBe(404);
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    endParty(party);
    expect(await refusedWith(rawSocket(party, alice.cookie))).toBe(404);
  });

  it('a guest reaches only their own party', async () => {
    const { alice } = await users();
    const show = addShow('Bluey');
    const a = await startParty(alice.cookie, show.eps[0]);
    const b = await startParty(alice.cookie, show.eps[1]);
    const guest = await guestOf(alice.cookie, a);
    expect(await refusedWith(rawSocket(b, guest))).toBe(404);
    const c = await connectAs(a, guest);
    expect((await c.next(isState)).members.map((m: { name: string }) => m.name)).toContain('Gus');
  });

  it('an account allowed to see the title joins as a member on connect', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    expect(getParty(party)!.members.has(`u:${bob.id}`)).toBe(false);
    const c = await connectAs(party, bob.cookie);
    const s = await c.next(isState);
    expect(s.members).toContainEqual({ key: `u:${bob.id}`, name: 'bob', connected: true, buffering: false });
    expect(getParty(party)!.members.get(`u:${bob.id}`)?.connected).toBe(1);
  });
});

describe('party socket: sync', () => {
  it('two members get the same state when one pauses', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const a = await connectAs(party, alice.cookie);
    const g = await connectAs(party, guest);
    a.send({ t: 'play' });
    const playing = await g.next((m) => isState(m) && m.state.playing);
    expect((await a.next((m) => isState(m) && m.state.playing)).state).toEqual(playing.state);
    a.send({ t: 'pause' });
    const pa = await a.next((m) => isState(m) && !m.state.playing);
    const pg = await g.next((m) => isState(m) && !m.state.playing);
    expect(pa.state).toEqual(pg.state);
    expect(pa.state.version).toBe(playing.state.version + 1);
    expect(pa.title).toEqual(pg.title);
  });

  it('seek moves everyone', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    b.send({ t: 'seek', p: 99.5 });
    expect((await a.next((m) => isState(m) && m.state.position === 99.5)).state.playing).toBe(false);
  });

  it('pong carries server time', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const before = Date.now();
    a.send({ t: 'ping', c: 1234.5 });
    const pong = await a.next((m) => m.t === 'pong');
    expect(pong.c).toBe(1234.5);
    expect(pong.s).toBeGreaterThanOrEqual(before);
    expect(pong.s).toBeLessThanOrEqual(Date.now());
  });

  it('play is scheduled ahead by half the slowest round trip, capped', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    a.send({ t: 'rtt', ms: 80 });
    b.send({ t: 'rtt', ms: 240 });
    await b.sync();
    const t0 = Date.now();
    a.send({ t: 'play' });
    const s = (await a.next((m) => isState(m) && m.state.playing)).state;
    expect(s.at - t0).toBeGreaterThanOrEqual(115);
    expect(s.at - t0).toBeLessThanOrEqual(120 + 100);
    a.send({ t: 'pause' });
    b.send({ t: 'rtt', ms: 5000 });
    await b.sync();
    const t1 = Date.now();
    a.send({ t: 'play' });
    const s2 = (await a.next((m) => isState(m) && m.state.playing && m.state.version > s.version)).state;
    expect(s2.at - t1).toBeLessThanOrEqual(MAX_LEAD_MS + 100);
    expect(s2.at - t1).toBeGreaterThanOrEqual(MAX_LEAD_MS - 5);
  });

  it('reconnect gets current state first', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    a.send({ t: 'play' });
    await b.next((m) => isState(m) && m.state.playing);
    b.ws.close();
    await b.closed;
    await a.next((m) => isState(m) && m.members.some((x: { key: string; connected: boolean }) => x.key === `u:${bob.id}` && !x.connected));
    const again = await connectAs(party, bob.cookie);
    const first = await again.next();
    expect(first.t).toBe('state');
    const t = Date.now();
    expect(positionAt(first.state, t)).toBeCloseTo(positionAt(getParty(party)!.state, t), 3);
    expect(first.state.playing).toBe(true);
  });

  it('a second socket for the same principal replaces the first; the count stays right', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const first = await connectAs(party, alice.cookie);
    await first.next(isState);
    const second = await connectAs(party, alice.cookie);
    expect((await first.next((m) => m.t === 'replaced')).t).toBe('replaced');
    await first.closed;
    await second.next(isState);
    await second.sync();
    const m = getParty(party)!.members.get(`u:${alice.id}`)!;
    expect(m.connected).toBe(1);
    expect(getParty(party)!.emptySince).toBeNull();
    // Commands from the new socket still work.
    second.send({ t: 'seek', p: 5 });
    await second.next((x) => isState(x) && x.state.position === 5);
    second.ws.close();
    await second.closed;
    await waitFor(() => m.connected === 0);
    expect(getParty(party)!.emptySince).not.toBeNull();
  });

  it('ignores malformed messages and keeps the socket open', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    await a.next(isState);
    const v = getParty(party)!.state.version;
    for (const bad of ['not json', '[]', 'null', '{"t":5}', '{"t":"seek","p":"x"}', '{"t":"seek","p":-1e400}', '{"t":"seek"}', '{"t":"buffering","on":"yes"}', '{"t":"nope"}', '{"t":"ping","c":"x"}', '{"t":"rtt","ms":-5}']) {
      a.send(bad);
    }
    a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await a.sync();
    expect(getParty(party)!.state.version).toBe(v);
    expect(a.msgs.filter((m) => m.t !== 'state' && m.t !== 'pong')).toEqual([]);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('drops more than 20 commands per second from one socket', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    await a.next(isState);
    const v = getParty(party)!.state.version;
    for (let i = 0; i < 30; i++) a.send({ t: 'seek', p: i });
    await a.sync();
    expect(getParty(party)!.state.version - v).toBe(20);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('buffering pauses everyone and shows who we wait for; ready resumes together', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    a.send({ t: 'play' });
    await b.next((m) => isState(m) && m.state.playing);
    await a.next((m) => isState(m) && m.state.playing);
    b.send({ t: 'buffering', on: true });
    const wait = await a.next((m) => isState(m) && m.waitingFor.length > 0);
    expect(wait.state.playing).toBe(false);
    expect(wait.waitingFor).toEqual(['bob']);
    b.send({ t: 'buffering', on: false });
    const go = await a.next((m) => isState(m) && m.state.playing);
    expect(go.waitingFor).toEqual([]);
  });

  it('someone who drops while everyone waits for them doesn’t hold the party up', async () => {
    const { alice, bob } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    a.send({ t: 'play' });
    await b.next((m) => isState(m) && m.state.playing);
    await a.next((m) => isState(m) && m.state.playing);
    b.send({ t: 'buffering', on: true });
    expect((await a.next((m) => isState(m) && m.waitingFor.length > 0)).state.playing).toBe(false);
    b.ws.close();
    expect((await a.next((m) => isState(m) && m.state.playing)).waitingFor).toEqual([]);
  });
});

describe('party socket: next episode', () => {
  it('next moves everyone to the next episode, paused at 0, and starts once all are ready', async () => {
    const { alice } = await users();
    const show = addShow('Bluey', { count: 3 });
    const party = await startParty(alice.cookie, show.eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const a = await connectAs(party, alice.cookie);
    const g = await connectAs(party, guest);
    a.send({ t: 'play' });
    await g.next((m) => isState(m) && m.state.playing);
    g.send({ t: 'next' });
    const na = await a.next((m) => isState(m) && m.title.id === show.eps[1]);
    const ng = await g.next((m) => isState(m) && m.title.id === show.eps[1]);
    expect(na.title).toEqual({ kind: 'episode', id: show.eps[1] });
    expect(na.state).toEqual(ng.state);
    expect(na.state).toMatchObject({ playing: false, position: 0 });
    expect(na.waitingFor.sort()).toEqual(['Gus', 'alice']);
    expect(getParty(party)!.mediaId).toBe(show.id);
    a.send({ t: 'buffering', on: false });
    expect((await g.next((m) => isState(m) && m.waitingFor.length === 1)).state.playing).toBe(false);
    g.send({ t: 'buffering', on: false });
    const go = await a.next((m) => isState(m) && m.state.playing);
    expect(go.state.position).toBe(0);
    expect(go.title.id).toBe(show.eps[1]);
  });

  it('a member who never loads the next episode is skipped after 20 s', async () => {
    const { alice, bob } = await users();
    const show = addShow('Bluey');
    const party = await startParty(alice.cookie, show.eps[0]);
    const a = await connectAs(party, alice.cookie);
    await connectAs(party, bob.cookie);
    a.send({ t: 'next' });
    await a.next((m) => isState(m) && m.title.id === show.eps[1]);
    a.send({ t: 'buffering', on: false });
    await a.next((m) => isState(m) && m.waitingFor.length === 1);
    tickParties(Date.now() + SKIP_BUFFERING_MS - 1000);
    expect(getParty(party)!.state.playing).toBe(false);
    tickParties(Date.now() + SKIP_BUFFERING_MS + 1000);
    const go = await a.next((m) => isState(m) && m.state.playing);
    expect(go.waitingFor).toEqual([]);
  });

  it('every client firing next at the same time moves only one episode', async () => {
    const { alice, bob } = await users();
    const show = addShow('Bluey', { count: 3 });
    const party = await startParty(alice.cookie, show.eps[0]);
    const a = await connectAs(party, alice.cookie);
    const b = await connectAs(party, bob.cookie);
    a.send({ t: 'next', from: show.eps[0] });
    b.send({ t: 'next', from: show.eps[0] });
    await a.sync();
    await b.sync();
    expect(getParty(party)!.title.id).toBe(show.eps[1]);
    // Without `from`, a second next right after one is taken as the same press.
    b.send({ t: 'next' });
    await b.sync();
    expect(getParty(party)!.title.id).toBe(show.eps[1]);
  });

  it('next is a no-op on the last episode and for a movie', async () => {
    const { alice } = await users();
    const show = addShow('Bluey');
    const party = await startParty(alice.cookie, show.eps[1]);
    const a = await connectAs(party, alice.cookie);
    await a.next(isState);
    const v = getParty(party)!.state.version;
    a.send({ t: 'next' });
    await a.sync();
    expect(getParty(party)!.title.id).toBe(show.eps[1]);
    expect(getParty(party)!.state.version).toBe(v);
  });

  it('after next, a guest’s stream of the previous episode is refused', async () => {
    const { alice } = await users();
    const show = addShow('Bluey');
    const party = await startParty(alice.cookie, show.eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const guestId = getParty(party)!.members.get([...getParty(party)!.members.keys()].find((k) => k.startsWith('g:'))!)!.principal;
    saveSettings({ maxTranscodes: 4 });
    useLauncher(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const probe: MediaProbe = {
      container: 'mp4', duration: 100, bitrate: 0,
      video: { index: 0, codec: 'h264', profile: null, pixFmt: 'yuv420p', bitDepth: 8, width: 1920, height: 1080 },
      audio: [], subtitles: [], fonts: [],
    };
    const decision: Decision = { mode: 'transcode', reason: '', audio: null, burnSubtitle: null, height: null, videoBitrate: 8e6 };
    const s = createSession({
      userId: -(guestId as { guestId: number }).guestId, title: `episode:${show.eps[0]}`, file: 'x.mp4', ffmpeg: 'ffmpeg',
      probe, decision, encoder: 'libx264', startAt: 0, exempt: true,
    });
    expect((await call(guest, 'GET', `/api/play/hls/${s.id}/main.m3u8`)).statusCode).toBe(200);
    const a = await connectAs(party, alice.cookie);
    a.send({ t: 'next' });
    await a.next((m) => isState(m) && m.title.id === show.eps[1]);
    expect((await call(guest, 'GET', `/api/play/hls/${s.id}/main.m3u8`)).statusCode).toBe(404);
  });
});

describe('party socket: ending and leaving', () => {
  it('ending the party closes sockets with ended', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const a = await connectAs(party, alice.cookie);
    const g = await connectAs(party, guest);
    await g.next(isState);
    expect((await call(alice.cookie, 'POST', `/api/party/${party}/end`)).statusCode).toBe(200);
    expect((await a.next((m) => m.t === 'ended')).t).toBe('ended');
    expect((await g.next((m) => m.t === 'ended')).t).toBe('ended');
    await a.closed;
    await g.closed;
  });

  it('ending the party cuts a guest’s open direct stream', async () => {
    const { alice } = await users();
    const show = addShow('Bluey');
    // A file big enough that the response can't finish before the party ends (sparse, so it's quick to make).
    const file = db.prepare('SELECT file_path FROM episodes WHERE id = ?').get(show.eps[0]) as { file_path: string };
    fs.truncateSync(file.file_path, 64 * 1024 * 1024);
    const party = await startParty(alice.cookie, show.eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get(`${base}/api/play/direct/episode/${show.eps[0]}`, { headers: { cookie: guest } }, resolve).on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    let got = 0;
    let stall = true;
    const done = new Promise<{ complete: boolean }>((resolve) => {
      res.on('data', (d: Buffer) => {
        got += d.length;
        if (stall) res.pause(); // read a little, then stall so the server can't finish
      });
      res.on('close', () => resolve({ complete: res.complete }));
      res.on('error', () => undefined);
    });
    await waitFor(() => got > 0);
    endParty(party);
    stall = false;
    res.resume(); // drain what already arrived; the response must stop short of the whole file
    const r = await done;
    expect(r.complete).toBe(false);
    expect(got).toBeLessThan(64 * 1024 * 1024);
  });

  it('next cuts a guest’s open direct stream of the previous episode', async () => {
    const { alice } = await users();
    const show = addShow('Bluey');
    const file = db.prepare('SELECT file_path FROM episodes WHERE id = ?').get(show.eps[0]) as { file_path: string };
    fs.truncateSync(file.file_path, 64 * 1024 * 1024);
    const party = await startParty(alice.cookie, show.eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get(`${base}/api/play/direct/episode/${show.eps[0]}`, { headers: { cookie: guest, range: 'bytes=0-' } }, resolve).on('error', reject);
    });
    expect(res.statusCode).toBe(206);
    let got = 0;
    let stall = true;
    const done = new Promise<{ complete: boolean }>((resolve) => {
      res.on('data', (d: Buffer) => {
        got += d.length;
        if (stall) res.pause();
      });
      res.on('close', () => resolve({ complete: res.complete }));
      res.on('error', () => undefined);
    });
    await waitFor(() => got > 0);
    const a = await connectAs(party, alice.cookie);
    a.send({ t: 'next' });
    await a.next((m) => isState(m) && m.title.id === show.eps[1]);
    expect(getParty(party)).not.toBeNull(); // the party goes on; only the old stream is cut
    stall = false;
    res.resume();
    expect((await done).complete).toBe(false);
    expect(got).toBeLessThan(64 * 1024 * 1024);
  });

  it('a guest who leaves is disconnected', async () => {
    const { alice } = await users();
    const party = await startParty(alice.cookie, addShow('Bluey').eps[0]);
    const guest = await guestOf(alice.cookie, party);
    const a = await connectAs(party, alice.cookie);
    const g = await connectAs(party, guest);
    await g.next(isState);
    expect((await call(guest, 'POST', `/api/party/${party}/leave`)).statusCode).toBe(200);
    await g.closed;
    const s = await a.next((m) => isState(m) && !m.members.some((x: { name: string }) => x.name === 'Gus'));
    expect(s.members.map((x: { name: string }) => x.name)).toEqual(['alice']);
  });
});

async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
