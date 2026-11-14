import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntroDbBusy, introDbTimes, parseIntroDb } from './theintrodb.js';

afterEach(() => vi.unstubAllGlobals());

describe('TheIntroDB times', () => {
  it('reads intro and credits (no end = to the end of the file, no start = from the beginning)', () => {
    expect(
      parseIntroDb({ intro: [{ start_ms: 473681, end_ms: 571154 }], credits: [{ start_ms: 3630040, end_ms: null }] }, 3720),
    ).toEqual({ intro: { start: 473.681, end: 571.154 }, credits: { start: 3630.04, end: 3720 } });
    expect(parseIntroDb({ intro: [{ start_ms: null, end_ms: 40000 }] }, 8160)).toEqual({ intro: { start: 0, end: 40 } });
  });

  it('ignores sections that are too short or past the end of this file', () => {
    expect(parseIntroDb({ intro: [{ start_ms: 1000, end_ms: 3000 }], credits: [{ start_ms: 9_000_000, end_ms: null }] }, 3720)).toEqual({});
  });

  it('asks by TMDB id, season, episode and length; unknown titles are just empty', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      urls.push(String(url));
      return String(url).includes('tmdb_id=1399')
        ? Response.json({ intro: [{ start_ms: 473681, end_ms: 571154 }], credits: [] })
        : Response.json({ error: 'not found' }, { status: 404 });
    });
    expect(await introDbTimes({ tmdbId: 1399, season: 1, episode: 1, duration: 3720 })).toEqual({ intro: { start: 473.681, end: 571.154 } });
    expect(urls[0]).toContain('season=1');
    expect(urls[0]).toContain('episode=1');
    expect(urls[0]).toContain('duration_ms=3720000');
    expect(await introDbTimes({ tmdbId: 42, duration: 6000 })).toEqual({});
    expect(urls[1]).not.toContain('season=');
  });

  it('stops asking for the day when their daily limit is reached', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"error":"Daily usage limit reached"}', { status: 429, headers: { 'retry-after': '3600' } });
    });
    await expect(introDbTimes({ tmdbId: 1, season: 1, episode: 1, duration: 1300 })).rejects.toBeInstanceOf(IntroDbBusy);
    await expect(introDbTimes({ tmdbId: 1, season: 1, episode: 2, duration: 1300 })).rejects.toBeInstanceOf(IntroDbBusy);
    expect(calls).toBe(1);
  });
});
