import { describe, expect, it } from 'vitest';
import {
  advance, applyCommand, connect, disconnect, newParty, positionAt, principalKey,
  setBuffering, shouldEnd, tickBuffering, viewerId,
  type Party, type Principal,
} from './state.js';

const host = { type: 'user', userId: 1, name: 'Host' } as const;
const guest: Principal = { type: 'guest', guestId: 3, name: 'Guest' };

function make(position = 10): Party {
  const p = newParty('p1', host, 100, { kind: 'movie', id: 100 }, position, 0);
  connect(p, host, 0);
  connect(p, guest, 0);
  return p;
}

describe('party state', () => {
  it('play schedules a common start', () => {
    const p = make(10);
    const s = applyCommand(p, { type: 'play' }, 1000, 200);
    expect(s).toMatchObject({ playing: true, at: 1200, position: 10 });
    expect(positionAt(s, 2200)).toBe(11);
    expect(positionAt(s, 1000)).toBe(10);
  });

  it('caps the lead at MAX_LEAD_MS', () => {
    const p = make();
    expect(applyCommand(p, { type: 'play' }, 1000, 5000).at).toBe(1300);
  });

  it('pause freezes the position', () => {
    const p = make(10);
    const s = applyCommand(p, { type: 'play' }, 1000, 200);
    const t = s.at + 5000;
    const paused = applyCommand(p, { type: 'pause' }, t, 200);
    expect(paused.playing).toBe(false);
    expect(paused.position).toBe(15);
    expect(paused.at).toBe(t);
  });

  it('seek while playing stays playing', () => {
    const p = make();
    applyCommand(p, { type: 'play' }, 1000, 200);
    const s = applyCommand(p, { type: 'seek', position: 50 }, 2000, 200);
    expect(s).toMatchObject({ playing: true, position: 50, at: 2200 });
    const q = make();
    expect(applyCommand(q, { type: 'seek', position: 5 }, 2000, 200)).toMatchObject({ playing: false, position: 5, at: 2000 });
  });

  it('version increments on each command', () => {
    const p = make();
    const v0 = p.state.version;
    applyCommand(p, { type: 'play' }, 1, 0);
    applyCommand(p, { type: 'seek', position: 3 }, 2, 0);
    applyCommand(p, { type: 'pause' }, 3, 0);
    expect(p.state.version).toBe(v0 + 3);
  });

  it('buffering pauses everyone and resumes when all are ready', () => {
    const p = make(10);
    applyCommand(p, { type: 'play' }, 1000, 200);
    const a = principalKey(host);
    const paused = setBuffering(p, a, true, 3200, 200);
    expect(paused).toMatchObject({ playing: false, position: 12 });
    const resumed = setBuffering(p, a, false, 4000, 200);
    expect(resumed).toMatchObject({ playing: true, at: 4200, position: 12 });
  });

  it('does not resume until every buffering member is ready', () => {
    const p = make();
    applyCommand(p, { type: 'play' }, 1000, 0);
    setBuffering(p, principalKey(host), true, 2000, 0);
    setBuffering(p, principalKey(guest), true, 2100, 0);
    expect(setBuffering(p, principalKey(host), false, 2200, 0)).toBeNull();
    expect(setBuffering(p, principalKey(guest), false, 2300, 0)?.playing).toBe(true);
  });

  it('buffering while paused does not resume on ready', () => {
    const p = make();
    const a = principalKey(host);
    expect(setBuffering(p, a, true, 1000, 200)).toBeNull();
    expect(setBuffering(p, a, false, 2000, 200)).toBeNull();
    expect(p.state.playing).toBe(false);
  });

  it('a viewer stuck buffering is skipped after 20 s', () => {
    const p = make();
    applyCommand(p, { type: 'play' }, 1000, 0);
    const a = principalKey(host);
    setBuffering(p, a, true, 2000, 0);
    expect(tickBuffering(p, 2000 + 20_000, 200)).toBeNull();
    const s = tickBuffering(p, 2000 + 20_001, 200);
    expect(s?.playing).toBe(true);
    expect(p.members.get(a)?.buffering).toBeNull();
  });

  it('disconnecting while buffering clears it and lets tick resume', () => {
    const p = make();
    applyCommand(p, { type: 'play' }, 1000, 0);
    const a = principalKey(guest);
    setBuffering(p, a, true, 2000, 0);
    disconnect(p, a, 2500);
    expect(p.members.get(a)?.buffering).toBeNull();
    expect(tickBuffering(p, 2600, 0)?.playing).toBe(true);
  });

  it('survives everyone dropping briefly', () => {
    const p = make();
    const t = 1000;
    disconnect(p, principalKey(host), t);
    disconnect(p, principalKey(guest), t);
    expect(p.emptySince).toBe(t);
    expect(shouldEnd(p, t + 599_999)).toBe(false);
    connect(p, host, t + 1000);
    expect(p.emptySince).toBeNull();
    expect(shouldEnd(p, t + 700_000)).toBe(false);
    const t2 = t + 800_000;
    disconnect(p, principalKey(host), t2);
    expect(shouldEnd(p, t2 + 600_001)).toBe(true);
  });

  it('ended flag ends the party', () => {
    const p = make();
    p.ended = true;
    expect(shouldEnd(p, 0)).toBe(true);
  });

  it('counts multiple sockets per member', () => {
    const p = make();
    connect(p, host, 10);
    disconnect(p, principalKey(host), 20);
    expect(p.members.get(principalKey(host))?.connected).toBe(1);
    expect(p.emptySince).toBeNull();
  });

  it('advance clears buffering and resets position', () => {
    const p = make(40);
    applyCommand(p, { type: 'play' }, 1000, 0);
    setBuffering(p, principalKey(host), true, 2000, 0);
    const s = advance(p, 101, { kind: 'episode', id: 101 }, 3000);
    expect(p.title).toEqual({ kind: 'episode', id: 101 });
    expect(p.mediaId).toBe(101);
    expect(s).toMatchObject({ playing: true, position: 0 });
    expect([...p.members.values()].some((m) => m.buffering !== null)).toBe(false);
    expect(p.resumeAfterBuffer).toBe(false);
  });

  it('viewerId never collides', () => {
    expect(viewerId({ type: 'user', userId: 3, name: 'u' })).toBe(3);
    expect(viewerId({ type: 'guest', guestId: 3, name: 'g' })).toBe(-3);
    expect(principalKey(host)).toBe('u:1');
    expect(principalKey(guest)).toBe('g:3');
  });
});
