import { describe, it, expect } from 'vitest';
import { backoffMs, bufferedAhead, closeOutcome, parseServerMessage, pingDelayMs, waitingLabel } from './protocol';

const ranges = (...r: [number, number][]) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] });

describe('parseServerMessage', () => {
  it('reads a state push', () => {
    const msg = JSON.stringify({
      t: 'state',
      state: { playing: true, position: 12.5, at: 1000, version: 3 },
      title: { kind: 'episode', id: 7 },
      members: [{ key: 'u:1', name: 'alex', connected: true, buffering: false }],
      waitingFor: ['alex'],
    });
    expect(parseServerMessage(msg)).toEqual({
      t: 'state',
      state: { playing: true, position: 12.5, at: 1000, version: 3 },
      title: { kind: 'episode', id: 7 },
      members: [{ key: 'u:1', name: 'alex', connected: true, buffering: false }],
      waitingFor: ['alex'],
    });
  });
  it('reads pong, ended and replaced', () => {
    expect(parseServerMessage('{"t":"pong","c":5,"s":9}')).toEqual({ t: 'pong', c: 5, s: 9 });
    expect(parseServerMessage('{"t":"ended"}')).toEqual({ t: 'ended' });
    expect(parseServerMessage('{"t":"replaced"}')).toEqual({ t: 'replaced' });
  });
  it('drops junk', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('[1]')).toBeNull();
    expect(parseServerMessage('{"t":"nope"}')).toBeNull();
    expect(parseServerMessage('{"t":"pong","c":"x","s":1}')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: 'state', state: { playing: 'yes', position: 1, at: 1, version: 1 }, title: { kind: 'movie', id: 1 }, members: [], waitingFor: [] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: 'state', state: { playing: true, position: 1, at: 1, version: 1 }, title: { kind: 'show', id: 1 }, members: [], waitingFor: [] }))).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('backoffMs', () => {
  it('doubles from 0.5 s and stops at 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });
});

describe('pingDelayMs', () => {
  it('pings often at first, then every 30 s', () => {
    expect(pingDelayMs(0)).toBe(5000);
    expect(pingDelayMs(29_999)).toBe(5000);
    expect(pingDelayMs(30_000)).toBe(30_000);
  });
});

describe('closeOutcome', () => {
  it('maps close codes', () => {
    expect(closeOutcome(1000, 'ended')).toBe('ended');
    expect(closeOutcome(4001, 'replaced')).toBe('replaced');
    expect(closeOutcome(4002, 'left')).toBe('left');
    expect(closeOutcome(1006, '')).toBe('reconnect');
    expect(closeOutcome(1000, '')).toBe('reconnect');
  });
});

describe('bufferedAhead', () => {
  it('measures the range holding the playhead', () => {
    expect(bufferedAhead(ranges([0, 10], [20, 30]), 4)).toBe(6);
    expect(bufferedAhead(ranges([0, 10], [20, 30]), 25)).toBe(5);
    expect(bufferedAhead(ranges([0, 10], [20, 30]), 15)).toBe(0);
    expect(bufferedAhead(ranges(), 0)).toBe(0);
  });
});

describe('waitingLabel', () => {
  it('joins names', () => {
    expect(waitingLabel(['alex'])).toBe('Waiting for alex…');
    expect(waitingLabel(['alex', 'sam'])).toBe('Waiting for alex, sam…');
  });
});
