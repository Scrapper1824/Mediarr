import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getMedia, initDb, now, type EpisodeRow } from '../db.js';
import { findSharedAudio, malEpisodes, POINT_SECONDS } from '../playback/segments.js';
import { aniSkipTimes, pickSkipTimes, SAME_CUT_SECONDS } from './aniskip.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => vi.unstubAllGlobals());

const result = (skipType: string, start: number, end: number, episodeLength: number) =>
  ({ interval: { startTime: start, endTime: end }, skipType, episodeLength }) as Parameters<typeof pickSkipTimes>[0][number];

describe('AniSkip times', () => {
  it('takes the opening and ending, and says how long a file they were measured on', () => {
    expect(pickSkipTimes([result('op', 57.4, 145.7, 1491.5), result('ed', 1357.9, 1480, 1480.2)], 1490)).toEqual({
      intro: { start: 57.4, end: 145.7 },
      credits: { start: 1357.9, end: 1480 },
      measuredOn: 1491.5,
    });
  });

  it('prefers the submission closest in length, and accepts mixed openings/endings', () => {
    const t = pickSkipTimes([result('op', 90, 180, 1494), result('op', 88, 178, 1490.5), result('mixed-ed', 1300, 1390, 1490)], 1490);
    expect(t).toMatchObject({ intro: { start: 88, end: 178 }, credits: { start: 1300, end: 1390 } });
  });

  it('a release a little longer (26 s here) still gets times, flagged as measured on another cut', () => {
    const t = pickSkipTimes([result('op', 61.3, 151.3, 1466.5)], 1492);
    expect(t.intro).toEqual({ start: 61.3, end: 151.3 });
    expect(Math.abs(t.measuredOn! - 1492)).toBeGreaterThan(SAME_CUT_SECONDS);
    // Something minutes off is a different thing altogether.
    expect(pickSkipTimes([result('op', 61.3, 151.3, 1200)], 1492)).toEqual({});
  });

  it('asks by MyAnimeList id and episode; nothing found is just empty', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return url.includes('/1/1?')
        ? Response.json({ found: true, results: [result('op', 57.4, 145.7, 1491.5)] })
        : new Response('{"found":false}', { status: 404 });
    });
    expect(await aniSkipTimes(1, 1, 1490)).toMatchObject({ intro: { start: 57.4, end: 145.7 } });
    expect(urls[0]).toMatch(/skip-times\/1\/1\?.*types=op/);
    expect(await aniSkipTimes(1, 99, 1490)).toEqual({});
  });
});

describe('lining up AniSkip with a file cut differently', () => {
  /** Deterministic pseudo-random fingerprint values. */
  const rng = (seed: number) => {
    let x = seed >>> 0 || 1;
    return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x >>> 0);
  };
  const pts = (s: number) => Math.round(s / POINT_SECONDS);
  const clip = (seed: number, seconds: number) => {
    const r = rng(seed);
    return Uint32Array.from({ length: pts(seconds) }, () => r());
  };
  const episode = (seed: number, parts: [Uint32Array, number][]) => {
    const r = rng(seed);
    const out = Uint32Array.from({ length: pts(400) }, () => r());
    for (const [c, at] of parts) out.set(c, pts(at));
    return out;
  };

  it('finds the stretch as long as the opening, not a longer recurring track', () => {
    // Both episodes share a 120 s recurring track (a recap / cold-open music) and the 90 s opening.
    const recurring = clip(7, 120);
    const opening = clip(8, 90);
    const a = episode(1, [[recurring, 0], [opening, 150]]);
    const b = episode(2, [[recurring, 10], [opening, 200]]);
    // Unguided, the longest shared stretch wins: the wrong one.
    const guess = findSharedAudio(a, b, { maxSeconds: 130 })!;
    expect(guess.a.end - guess.a.start).toBeGreaterThan(110);
    // Knowing from AniSkip that the opening is 90 s long finds the opening.
    const guided = findSharedAudio(a, b, { minSeconds: 82, maxSeconds: 98 })!;
    expect(guided.a.start).toBeCloseTo(150, 0);
    expect(guided.a.end).toBeCloseTo(240, 0);
  });
});

describe('MyAnimeList episodes for a season', () => {
  it("maps a split-cour season (two entries back to back) to each entry's own numbering", async () => {
    const id = Number(
      db.prepare(`INSERT INTO media (type, anilist_id, title, root_folder, folder_name, anime_seasons, added_at) VALUES ('anime', 10, 'Show', 'x', 'Show', ?, ?)`)
        .run(JSON.stringify([{ season: 1, anilistIds: [10, 11], title: 'Show', titles: ['Show'], episodes: 24, offset: 0, year: 2020 }]), now()).lastInsertRowid,
    );
    vi.stubGlobal('fetch', async () =>
      Response.json({ data: { Page: { media: [{ id: 10, idMal: 500, episodes: 12 }, { id: 11, idMal: 501, episodes: 12 }] } } }),
    );
    const eps = [3, 12, 13, 20].map((n, i) => ({ id: i + 1, season: 1, episode: n }) as EpisodeRow);
    const map = await malEpisodes(getMedia(id)!, 1, eps);
    expect([...map.values()]).toEqual([
      { malId: 500, episode: 3 },
      { malId: 500, episode: 12 },
      { malId: 501, episode: 1 },
      { malId: 501, episode: 8 },
    ]);
  });
});
