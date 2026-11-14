import { describe, expect, it } from 'vitest';
import { enoughBuffered, readyAhead, recordStall, STALL_WINDOW_MS } from './readiness';

describe('readyAhead / recordStall', () => {
  it('needs 2 s with no stalls and after a single one', () => {
    expect(readyAhead([], 0)).toBe(2);
    expect(readyAhead(recordStall([], 1000), 1500)).toBe(2);
  });

  it('needs 5 s after a second stall within a minute, 10 s after a third (and stays there)', () => {
    let s = recordStall([], 0);
    s = recordStall(s, 30_000);
    expect(readyAhead(s, 31_000)).toBe(5);
    s = recordStall(s, 80_000); // 50 s after the previous one: still the same run
    expect(readyAhead(s, 81_000)).toBe(10);
    s = recordStall(s, 90_000);
    expect(readyAhead(s, 91_000)).toBe(10);
    expect(s.length).toBeLessThanOrEqual(3);
  });

  it('drops back to 2 s after a minute without stalls', () => {
    let s = recordStall([], 0);
    s = recordStall(s, 10_000);
    s = recordStall(s, 20_000);
    expect(readyAhead(s, 20_000 + STALL_WINDOW_MS)).toBe(10);
    expect(readyAhead(s, 20_001 + STALL_WINDOW_MS)).toBe(2);
  });

  it('a stall more than a minute after the last starts a new run', () => {
    let s = recordStall([], 0);
    s = recordStall(s, 10_000);
    s = recordStall(s, 10_001 + STALL_WINDOW_MS);
    expect(s).toEqual([10_001 + STALL_WINDOW_MS]);
    expect(readyAhead(s, 10_002 + STALL_WINDOW_MS)).toBe(2);
    s = recordStall(s, 20_000 + STALL_WINDOW_MS);
    expect(readyAhead(s, 20_000 + STALL_WINDOW_MS)).toBe(5);
  });
});

describe('enoughBuffered', () => {
  it('needs the full amount ahead, whatever the browser says it can play', () => {
    expect(enoughBuffered(1.9, 100, 3600, 2)).toBe(false);
    expect(enoughBuffered(2, 100, 3600, 2)).toBe(true);
    expect(enoughBuffered(4.9, 100, 3600, 5)).toBe(false);
    expect(enoughBuffered(10, 100, 3600, 10)).toBe(true);
  });

  it('counts reaching the end of the file as enough', () => {
    expect(enoughBuffered(0.6, 3599, 3600, 2)).toBe(true);
    expect(enoughBuffered(0.4, 3599, 3600, 2)).toBe(false);
  });
});
