// The watch-party sync channel: one websocket per viewer per party, for commands and state pushes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { crossSite } from '../auth/security.js';
import { playableEpisodes } from '../core/home.js';
import { partyForUser } from './routes.js';
import {
  advance, applyCommand, connect, disconnect, MAX_LEAD_MS, principalKey, setBuffering, tickBuffering,
  type Party, type Principal,
} from './state.js';
import { getParty, onPartyEnded, onPartyLeft, partyAdvanced } from './store.js';

/** Commands (play/pause/seek/buffering/next) a socket may send per second; more are dropped. */
export const MAX_COMMANDS_PER_SEC = 20;
/** The same cap for everything else (ping, rtt, junk). */
const MAX_OTHER_PER_SEC = 20;
const PING_MS = 30_000;
const TICK_MS = 1_000;
/** Lead assumed for a viewer that hasn't reported a round trip yet. */
const DEFAULT_LEAD_MS = 100;
/** A `next` without `from` this soon after a move is taken as the same press (every client's countdown fires). */
const NEXT_DEBOUNCE_MS = 5_000;
const MAX_POSITION = 1e6;
const MAX_RTT_MS = 60_000;

/** The bits of a `ws` WebSocket used here. */
interface Sock {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void;
  on(event: 'close' | 'pong', cb: () => void): void;
}
const OPEN = 1;

interface Conn {
  sock: Sock;
  partyId: string;
  key: string;
  /** Last round trip the client reported (ms). */
  rtt: number | null;
  alive: boolean;
  /** Dropped (closed, replaced, ended, left): it no longer counts or receives anything. */
  done: boolean;
  windowStart: number;
  commands: number;
  others: number;
}

interface Room {
  conns: Map<string, Conn>;
  lastNextAt: number;
}

/** Open sockets by party, one per principal. */
const rooms = new Map<string, Room>();
/** Who an accepted upgrade is, worked out before the upgrade completes. */
const principals = new WeakMap<object, Principal>();

const COMMANDS = new Set(['play', 'pause', 'seek', 'buffering', 'next']);

function send(c: Conn, msg: unknown) {
  if (!c.done && c.sock.readyState === OPEN) c.sock.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

/** How far ahead a play is scheduled: half the slowest viewer's round trip, capped. */
function leadFor(partyId: string): number {
  const room = rooms.get(partyId);
  let lead = 0;
  for (const c of room?.conns.values() ?? []) lead = Math.max(lead, c.rtt === null ? DEFAULT_LEAD_MS : c.rtt / 2);
  return Math.min(lead, MAX_LEAD_MS);
}

const waitingFor = (p: Party) =>
  [...p.members.values()].filter((m) => m.connected > 0 && m.buffering !== null).map((m) => m.principal.name);

function stateMessage(p: Party): string {
  return JSON.stringify({
    t: 'state',
    state: p.state,
    title: p.title,
    members: [...p.members.entries()].map(([key, m]) => ({ key, name: m.principal.name, connected: m.connected > 0, buffering: m.buffering !== null })),
    waitingFor: waitingFor(p),
  });
}

function broadcast(p: Party) {
  const room = rooms.get(p.id);
  if (!room) return;
  const msg = stateMessage(p);
  for (const c of room.conns.values()) send(c, msg);
}

/** Takes a socket out of its party, exactly once. `settle`: a real departure (not a replacement), so re-check waiting and tell everyone. */
function drop(c: Conn, settle: boolean) {
  if (c.done) return;
  c.done = true;
  const room = rooms.get(c.partyId);
  if (room?.conns.get(c.key) === c) room.conns.delete(c.key);
  if (room && room.conns.size === 0) rooms.delete(c.partyId);
  const p = getParty(c.partyId);
  if (!p) return;
  const now = Date.now();
  disconnect(p, c.key, now);
  if (!settle) return;
  // If everyone was waiting for them, the party resumes now.
  tickBuffering(p, now, leadFor(p.id));
  broadcast(p);
}

/** Fixed one-second windows; false when this message is over the cap. */
function allowed(c: Conn, command: boolean, now: number): boolean {
  if (now - c.windowStart >= 1000) {
    c.windowStart = now;
    c.commands = 0;
    c.others = 0;
  }
  if (command) return ++c.commands <= MAX_COMMANDS_PER_SEC;
  return ++c.others <= MAX_OTHER_PER_SEC;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The next playable episode after the party's current one, or null (a movie, or the last episode). */
function nextEpisode(p: Party): { kind: 'episode'; id: number } | null {
  if (p.title.kind !== 'episode') return null;
  const eps = playableEpisodes(p.mediaId);
  const i = eps.findIndex((e) => e.id === p.title.id);
  const next = i >= 0 ? eps[i + 1] : undefined;
  return next ? { kind: 'episode', id: next.id } : null;
}

function onMessage(c: Conn, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) {
  if (c.done) return;
  const now = Date.now();
  let m: Record<string, unknown>;
  try {
    if (isBinary) throw new Error('binary');
    const parsed: unknown = JSON.parse(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as Buffer).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    m = parsed as Record<string, unknown>;
  } catch {
    allowed(c, false, now);
    return;
  }
  const t = m.t;
  if (!allowed(c, typeof t === 'string' && COMMANDS.has(t), now)) return;
  const p = getParty(c.partyId);
  if (!p) return;

  switch (t) {
    case 'ping':
      if (finite(m.c)) send(c, { t: 'pong', c: m.c, s: Date.now() });
      return;
    case 'rtt':
      if (finite(m.ms) && m.ms >= 0 && m.ms <= MAX_RTT_MS) c.rtt = m.ms;
      return;
    case 'play':
    case 'pause':
      applyCommand(p, { type: t }, now, leadFor(p.id));
      broadcast(p);
      return;
    case 'seek':
      if (!finite(m.p) || m.p < 0) return;
      applyCommand(p, { type: 'seek', position: Math.min(m.p, MAX_POSITION) }, now, leadFor(p.id));
      broadcast(p);
      return;
    case 'buffering': {
      if (typeof m.on !== 'boolean') return;
      const before = p.members.get(c.key)?.buffering ?? null;
      const changed = setBuffering(p, c.key, m.on, now, leadFor(p.id));
      const after = p.members.get(c.key)?.buffering ?? null;
      if (changed || (before === null) !== (after === null)) broadcast(p);
      return;
    }
    case 'next': {
      const room = rooms.get(p.id);
      if (m.from !== undefined) {
        // Pressed while on another episode than the party's: already moved on.
        if (!finite(m.from) || m.from !== p.title.id) return;
      } else if (room && now - room.lastNextAt < NEXT_DEBOUNCE_MS) {
        return;
      }
      const next = nextEpisode(p);
      if (!next) return;
      advance(p, p.mediaId, next, now);
      partyAdvanced(p);
      if (room) room.lastNextAt = now;
      broadcast(p);
      return;
    }
  }
}

/** Skips viewers stuck buffering for too long (the server calls it every second; tests with a later `now`). */
export function tickParties(now = Date.now()) {
  for (const id of [...rooms.keys()]) {
    const p = getParty(id);
    if (!p || !waitingFor(p).length) continue;
    const before = waitingFor(p).join('\n');
    const resumed = tickBuffering(p, now, leadFor(id));
    if (resumed || waitingFor(p).join('\n') !== before) broadcast(p);
  }
}

/** ws ping frames keep the socket alive through Cloudflare; a socket that missed the last one is cut. */
function pingAll() {
  for (const room of rooms.values()) {
    for (const c of room.conns.values()) {
      if (!c.alive) {
        c.sock.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.sock.ping();
      } catch {
        // closing already
      }
    }
  }
}

/** Who may open this party's socket: a guest of it, or an account allowed to see its title. */
function principalFor(req: FastifyRequest<{ Params: { id: string } }>): Principal | null {
  const id = req.params.id;
  if (req.guest) {
    return req.guest.partyId === id && getParty(id) ? { type: 'guest', guestId: req.guest.guestId, name: req.guest.name } : null;
  }
  if (!req.user || !partyForUser(req, id)) return null;
  return { type: 'user', userId: req.user.id, name: req.user.username };
}

/** Needs @fastify/websocket registered first. */
export async function partySocketRoutes(app: FastifyInstance) {
  const offEnded = onPartyEnded((p) => {
    const room = rooms.get(p.id);
    rooms.delete(p.id);
    for (const c of room?.conns.values() ?? []) {
      send(c, { t: 'ended' });
      c.done = true;
      c.sock.close(1000, 'ended');
    }
  });
  const offLeft = onPartyLeft((p, key) => {
    const c = rooms.get(p.id)?.conns.get(key);
    if (c) {
      drop(c, true); // the member is already gone, so this only tells everyone else
      c.sock.close(4002, 'left');
    }
  });
  const tick = setInterval(() => tickParties(), TICK_MS).unref();
  const ping = setInterval(pingAll, PING_MS).unref();
  app.addHook('onClose', async () => {
    offEnded();
    offLeft();
    clearInterval(tick);
    clearInterval(ping);
  });

  app.get<{ Params: { id: string } }>(
    '/api/party/:id/socket',
    {
      websocket: true,
      // Runs after the sign-in check (onRequest) and before the upgrade completes.
      preHandler: async (req, reply) => {
        if (!req.ws) return; // a plain GET gets the plugin's 404
        if (crossSite(req, true)) return reply.code(403).send({ error: 'Cross-site request blocked' });
        const principal = principalFor(req);
        if (!principal) return reply.code(404).send({ error: 'Not found' });
        principals.set(req.raw, principal);
      },
    },
    (sock: Sock, req) => {
      const principal = principals.get(req.raw);
      const p = getParty(req.params.id);
      if (!principal || !p) {
        sock.close(1000, 'ended');
        return;
      }
      const key = principalKey(principal);
      const old = rooms.get(p.id)?.conns.get(key);
      if (old) {
        send(old, { t: 'replaced' });
        drop(old, false);
        old.sock.close(4001, 'replaced');
      }
      let room = rooms.get(p.id);
      if (!room) rooms.set(p.id, (room = { conns: new Map(), lastNextAt: 0 }));
      const now = Date.now();
      connect(p, principal, now);
      // A replaced socket's buffering was cleared without a resume check (and a connect can settle waiting too):
      // resume now if nobody is left to wait for, so the party never sits paused with nobody loading.
      tickBuffering(p, now, leadFor(p.id));
      const c: Conn = { sock, partyId: p.id, key, rtt: null, alive: true, done: false, windowStart: 0, commands: 0, others: 0 };
      room.conns.set(key, c);
      sock.on('message', (data, isBinary) => onMessage(c, data, isBinary));
      sock.on('pong', () => (c.alive = true));
      sock.on('close', () => drop(c, true));
      broadcast(p); // the newcomer's first message is the current state
    },
  );
}
