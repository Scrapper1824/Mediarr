import { describe, expect, it } from 'vitest';
import { findSharedAudio, POINT_SECONDS, segmentsFromChapters } from './segments.js';

/** Deterministic pseudo-random 32-bit values. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}
const points = (seconds: number) => Math.round(seconds / POINT_SECONDS);

/** An episode's fingerprint: its own audio, with `shared` copied in at `at` seconds (a bit noisy, like a re-encode). */
function episode(seed: number, seconds: number, shared: Uint32Array, at: number, noiseBits = 2) {
  const r = rng(seed);
  const out = new Uint32Array(points(seconds));
  for (let i = 0; i < out.length; i++) out[i] = r();
  const start = points(at);
  for (let i = 0; i < shared.length && start + i < out.length; i++) {
    let v = shared[i];
    for (let b = 0; b < noiseBits; b++) v ^= 1 << (r() % 32);
    out[start + i] = v >>> 0;
  }
  return out;
}

describe('finding the shared opening', () => {
  const opening = (() => {
    const r = rng(42);
    return Uint32Array.from({ length: points(89) }, () => r());
  })();

  it('finds the same 89-second opening at different places in two episodes', () => {
    const a = episode(1, 600, opening, 95);
    const b = episode(2, 600, opening, 12);
    const m = findSharedAudio(a, b)!;
    expect(m.a.start).toBeCloseTo(95, 0);
    expect(m.a.end).toBeCloseTo(184, 0);
    expect(m.b.start).toBeCloseTo(12, 0);
    expect(m.b.end).toBeCloseTo(101, 0);
  });

  it('bridges a short glitch inside the opening', () => {
    const a = episode(3, 300, opening, 30);
    const b = episode(4, 300, opening, 30);
    // 2 seconds of the opening differ in b (a scene change mixed over the song).
    const r = rng(9);
    for (let i = points(70); i < points(72); i++) b[i] = r();
    const m = findSharedAudio(a, b)!;
    expect(m.a.end - m.a.start).toBeGreaterThan(85);
  });

  it('finds nothing between unrelated episodes, or when the match is too short to be an intro', () => {
    const r1 = rng(5);
    const r2 = rng(6);
    const a = Uint32Array.from({ length: points(300) }, () => r1());
    const b = Uint32Array.from({ length: points(300) }, () => r2());
    expect(findSharedAudio(a, b)).toBeNull();
    const jingle = opening.slice(0, points(8));
    expect(findSharedAudio(episode(7, 300, jingle, 40), episode(8, 300, jingle, 60))).toBeNull();
  });
});

describe('intro and credits from chapters', () => {
  it('recognises the usual chapter names', () => {
    const s = segmentsFromChapters([
      { start: 0, end: 92, title: 'Prologue' },
      { start: 92, end: 182, title: 'Opening' },
      { start: 182, end: 1300, title: 'Part A' },
      { start: 1300, end: 1390, title: 'ED' },
      { start: 1390, end: 1420, title: 'Preview' },
    ]);
    expect(s).toEqual({ intro: { start: 92, end: 182 }, credits: { start: 1300, end: 1390 } });
    expect(segmentsFromChapters([{ start: 0, end: 85, title: 'OP 2' }, { start: 5000, end: 5200, title: 'End Credits' }])).toEqual({
      intro: { start: 0, end: 85 },
      credits: { start: 5000, end: 5200 },
    });
  });

  it('ignores chapters that are just numbered or implausibly long', () => {
    expect(segmentsFromChapters([{ start: 0, end: 300, title: 'Chapter 1' }, { start: 300, end: 900, title: 'Opening' }])).toEqual({});
  });
});
