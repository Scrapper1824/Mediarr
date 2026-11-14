// Pure helpers for the watch-party socket: message parsing, reconnect timing, close codes, buffer readiness.
import type { PartyMember, PartyPlayState, PartyTitle } from '../api';

export type ServerMessage =
  | { t: 'pong'; c: number; s: number }
  | { t: 'state'; state: PartyPlayState; title: PartyTitle; members: PartyMember[]; waitingFor: string[] }
  | { t: 'ended' }
  | { t: 'replaced' };

export type ClientCommand =
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'seek'; p: number }
  | { t: 'buffering'; on: boolean }
  | { t: 'next'; from: number };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseTitle(v: unknown): PartyTitle | null {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || (t.kind !== 'movie' && t.kind !== 'episode') || !num(t.id)) return null;
  return { kind: t.kind, id: t.id };
}

function parseState(v: unknown): PartyPlayState | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.playing !== 'boolean' || !num(s.position) || !num(s.at) || !num(s.version)) return null;
  return { playing: s.playing, position: s.position, at: s.at, version: s.version };
}

function parseMembers(v: unknown): PartyMember[] | null {
  if (!Array.isArray(v)) return null;
  const out: PartyMember[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object' || typeof m.key !== 'string' || typeof m.name !== 'string') return null;
    out.push({ key: m.key, name: m.name, connected: !!m.connected, buffering: !!m.buffering });
  }
  return out;
}

/** A server message, or null for anything malformed or unknown. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.t) {
    case 'pong':
      return num(m.c) && num(m.s) ? { t: 'pong', c: m.c, s: m.s } : null;
    case 'state': {
      const state = parseState(m.state);
      const title = parseTitle(m.title);
      const members = parseMembers(m.members);
      const waitingFor = Array.isArray(m.waitingFor) && m.waitingFor.every((n) => typeof n === 'string') ? (m.waitingFor as string[]) : null;
      return state && title && members && waitingFor ? { t: 'state', state, title, members, waitingFor } : null;
    }
    case 'ended':
    case 'replaced':
      return { t: m.t };
    default:
      return null;
  }
}

/** Reconnect delay after `attempt` failed tries in a row (0-based): 0.5, 1, 2, 4, 8 s, then 10 s. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 10_000);
}

/** Clock pings: every 5 s for the first 30 s of a connection, then every 30 s. */
export function pingDelayMs(sinceOpenMs: number): number {
  return sinceOpenMs < 30_000 ? 5_000 : 30_000;
}

/** What a socket close means: the party ended, another tab took over, we left, or just a dropped line. */
export function closeOutcome(code: number, reason: string): 'ended' | 'replaced' | 'left' | 'reconnect' {
  if (code === 1000 && reason === 'ended') return 'ended';
  if (code === 4001) return 'replaced';
  if (code === 4002) return 'left';
  return 'reconnect';
}

/** Seconds buffered ahead of `t` in the range that contains it (0 when `t` isn't buffered). */
export function bufferedAhead(ranges: { length: number; start(i: number): number; end(i: number): number }, t: number): number {
  for (let i = 0; i < ranges.length; i++) {
    // A small tolerance: the playhead can sit a hair before a range's start.
    if (t >= ranges.start(i) - 0.1 && t <= ranges.end(i)) return ranges.end(i) - t;
  }
  return 0;
}

/** "Waiting for alex…", "Waiting for alex, sam…". */
export function waitingLabel(names: string[]): string {
  return `Waiting for ${names.join(', ')}…`;
}
