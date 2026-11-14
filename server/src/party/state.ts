// Authoritative watch-party state. Pure functions over a Party object: no I/O,
// no timers. Times `now`/`at` are server milliseconds; `position` is seconds.

export type Title = { kind: 'movie' | 'episode'; id: number };
export type Principal =
  | { type: 'user'; userId: number; name: string }
  | { type: 'guest'; guestId: number; name: string };

export const SKIP_BUFFERING_MS = 20_000;
export const EMPTY_END_MS = 600_000;
export const MAX_LEAD_MS = 300;

export const principalKey = (p: Principal): string =>
  p.type === 'user' ? `u:${p.userId}` : `g:${p.guestId}`;

/** Playback session owner id: users their id, guests -guestId (never collides). */
export const viewerId = (p: Principal): number => (p.type === 'user' ? p.userId : -p.guestId);

export interface PlayState {
  playing: boolean;
  position: number;
  at: number; // server ms at which `position` is (or will be) valid
  version: number;
}

export interface Member {
  principal: Principal;
  connected: number; // open socket count
  buffering: number | null; // since (server ms), or null
}

export interface Party {
  id: string;
  hostUserId: number;
  mediaId: number;
  title: Title;
  state: PlayState;
  members: Map<string, Member>;
  guestTokenHash: string | null;
  nextGuestNumber: number;
  emptySince: number | null;
  ended: boolean;
  createdAt: number;
  /** Paused only because someone buffered: resume once everyone is ready. */
  resumeAfterBuffer: boolean;
}

export function newParty(
  id: string,
  host: Principal & { type: 'user' },
  mediaId: number,
  title: Title,
  position: number,
  now: number,
): Party {
  return {
    id,
    hostUserId: host.userId,
    mediaId,
    title,
    state: { playing: false, position, at: now, version: 0 },
    members: new Map(),
    guestTokenHash: null,
    nextGuestNumber: 1,
    emptySince: now,
    ended: false,
    createdAt: now,
    resumeAfterBuffer: false,
  };
}

/** Playback position (seconds) at server time `now`. Frozen until `at` is reached. */
export function positionAt(s: PlayState, now: number): number {
  return s.playing ? s.position + Math.max(0, now - s.at) / 1000 : s.position;
}

const lead = (leadMs: number) => Math.min(Math.max(leadMs, 0), MAX_LEAD_MS);

function anyBuffering(p: Party): boolean {
  for (const m of p.members.values()) if (m.connected > 0 && m.buffering !== null) return true;
  return false;
}

function set(p: Party, playing: boolean, position: number, at: number): PlayState {
  p.state = { playing, position, at, version: p.state.version + 1 };
  return p.state;
}

export function applyCommand(
  p: Party,
  c: { type: 'play' } | { type: 'pause' } | { type: 'seek'; position: number },
  now: number,
  leadMs: number,
): PlayState {
  const pos = positionAt(p.state, now);
  const waiting = anyBuffering(p);
  switch (c.type) {
    case 'play':
      if (waiting) {
        // Someone is still buffering: stay paused, start as soon as they are ready.
        p.resumeAfterBuffer = true;
        return set(p, false, pos, now);
      }
      return set(p, true, pos, now + lead(leadMs));
    case 'pause':
      p.resumeAfterBuffer = false;
      return set(p, false, pos, now);
    case 'seek': {
      const playing = p.state.playing;
      return set(p, playing, c.position, playing ? now + lead(leadMs) : now);
    }
  }
}

/** Resume after a buffer pause if nobody is buffering any more. */
function resumeIfReady(p: Party, now: number, leadMs: number): PlayState | null {
  if (!p.resumeAfterBuffer || p.state.playing || anyBuffering(p)) return null;
  p.resumeAfterBuffer = false;
  return set(p, true, p.state.position, now + lead(leadMs));
}

/** Returns the new state when this changed play/pause, otherwise null. */
export function setBuffering(
  p: Party,
  key: string,
  buffering: boolean,
  now: number,
  leadMs: number,
): PlayState | null {
  const m = p.members.get(key);
  if (!m) return null;
  if (!buffering) {
    m.buffering = null;
    return resumeIfReady(p, now, leadMs);
  }
  if (m.buffering === null) m.buffering = now;
  if (m.connected > 0 && p.state.playing) {
    p.resumeAfterBuffer = true;
    return set(p, false, positionAt(p.state, now), now);
  }
  return null;
}

/** Skips members stuck buffering for over 20 s; returns the new state if that resumed play. */
export function tickBuffering(p: Party, now: number, leadMs: number): PlayState | null {
  for (const m of p.members.values()) {
    if (m.buffering !== null && now - m.buffering > SKIP_BUFFERING_MS) {
      m.buffering = null;
    }
  }
  return resumeIfReady(p, now, leadMs);
}

export function connect(p: Party, principal: Principal, now: number): void {
  void now;
  const key = principalKey(principal);
  const m = p.members.get(key);
  if (m) m.connected += 1;
  else p.members.set(key, { principal, connected: 1, buffering: null });
  p.emptySince = null;
}

export function disconnect(p: Party, key: string, now: number): void {
  const m = p.members.get(key);
  if (!m) return;
  m.connected = Math.max(0, m.connected - 1);
  if (m.connected === 0) m.buffering = null;
  if (![...p.members.values()].some((x) => x.connected > 0)) p.emptySince = now;
}

export function shouldEnd(p: Party, now: number): boolean {
  return p.ended || (p.emptySince !== null && now - p.emptySince > EMPTY_END_MS);
}

/** Moves to another title (next episode): position 0, playing, buffering cleared. */
export function advance(p: Party, mediaId: number, title: Title, now: number): PlayState {
  p.mediaId = mediaId;
  p.title = title;
  for (const m of p.members.values()) m.buffering = null;
  p.resumeAfterBuffer = false;
  return set(p, true, 0, now);
}
