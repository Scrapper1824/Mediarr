import { describe, it, expect } from 'vitest';
import { Clock, correction, expectedPosition, isEcho } from './sync';

describe('Clock', () => {
  it('picks the offset from the lowest-RTT sample', () => {
    const c = new Clock();
    c.sample(1000, 5000, 1400); // rtt 400, offset 5000-1200=3800
    c.sample(2000, 5100, 2040); // rtt 40, offset 5100-2020=3080
    c.sample(3000, 6000, 3300); // rtt 300
    expect(c.rtt()).toBe(40);
    expect(c.offset()).toBe(3080);
  });
  it('only considers the last 5 samples', () => {
    const c = new Clock();
    c.sample(0, 1000, 10); // rtt 10, falls out
    for (let i = 0; i < 5; i++) c.sample(100 * i, 2000, 100 * i + 100);
    expect(c.rtt()).toBe(100);
  });
  it('now() applies the offset', () => {
    const c = new Clock();
    c.sample(0, 10_000, 0);
    const n = c.now();
    expect(Math.abs(n - (Date.now() + 10_000))).toBeLessThan(50);
  });
});

describe('expectedPosition', () => {
  it('advances while playing', () => {
    expect(expectedPosition({ playing: true, position: 10, at: 1000 }, 3000)).toBe(12);
  });
  it('stays put before a scheduled start', () => {
    expect(expectedPosition({ playing: true, position: 10, at: 5000 }, 3000)).toBe(10);
  });
  it('stays put when paused', () => {
    expect(expectedPosition({ playing: false, position: 10, at: 1000 }, 9000)).toBe(10);
  });
});

describe('correction', () => {
  it('ignores small drift', () => {
    expect(correction(10.05, 10, 1)).toEqual({ kind: 'none' });
    expect(correction(10.099, 10, 1)).toEqual({ kind: 'none' });
  });
  it('slows down when ahead', () => {
    expect(correction(10.3, 10, 1)).toEqual({ kind: 'rate', rate: 0.95 });
  });
  it('speeds up when behind', () => {
    expect(correction(9.7, 10, 1)).toEqual({ kind: 'rate', rate: 1.05 });
  });
  it('uses rate at exactly 1s, jumps above', () => {
    expect(correction(11, 10, 1)).toEqual({ kind: 'rate', rate: 0.95 });
    expect(correction(11.5, 10, 1)).toEqual({ kind: 'jump', to: 10 });
    expect(correction(8.5, 10, 1.05)).toEqual({ kind: 'jump', to: 10 });
  });
  it('keeps the rate until within 0.05, then resets', () => {
    expect(correction(10.08, 10, 0.95)).toEqual({ kind: 'rate', rate: 0.95 });
    expect(correction(10.05, 10, 0.95)).toEqual({ kind: 'reset-rate' });
    expect(correction(9.99, 10, 1.05)).toEqual({ kind: 'reset-rate' });
  });
  it('switches direction if drift flips sign', () => {
    expect(correction(9.8, 10, 0.95)).toEqual({ kind: 'rate', rate: 1.05 });
    expect(correction(10.2, 10, 1.05)).toEqual({ kind: 'rate', rate: 0.95 });
  });
});

describe('isEcho', () => {
  const applied = { type: 'pause' as const, position: 30, atClient: 1000 };
  it('true for the same event shortly after', () => {
    expect(isEcho(applied, { type: 'pause', position: 30.1, atClient: 1100 })).toBe(true);
  });
  it('false later', () => {
    expect(isEcho(applied, { type: 'pause', position: 30, atClient: 2000 })).toBe(false);
  });
  it('false for a different position or type, or no prior', () => {
    expect(isEcho(applied, { type: 'pause', position: 35, atClient: 1100 })).toBe(false);
    expect(isEcho(applied, { type: 'play', position: 30, atClient: 1100 })).toBe(false);
    expect(isEcho(null, { type: 'pause', position: 30, atClient: 1100 })).toBe(false);
  });
});
