import { afterEach, describe, expect, it, vi } from 'vitest';
import { aniListPacing, animeFilterVariables, filterAnime } from './anilist.js';

afterEach(() => vi.unstubAllGlobals());

const page = { data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } };
const filter = { genres: [], yearFrom: null, yearTo: null, minRating: null, sort: 'popular' as const, status: null, formats: [], season: null, q: null };

describe('staying within AniList rate limits', () => {
  it('waits out a "too many requests" answer and tries again instead of failing', async () => {
    const times: number[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      times.push(Date.now());
      calls++;
      if (calls === 1) return new Response('{"errors":[{"message":"Too Many Requests.","status":429}]}', { status: 429, headers: { 'retry-after': '1' } });
      return Response.json(page, { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '25' } });
    });
    const r = await filterAnime(filter, 1);
    expect(r.media).toEqual([]);
    expect(calls).toBe(2);
    // It waited the second AniList asked for.
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  it('gives a clear message when AniList keeps refusing', async () => {
    const before = { ...aniListPacing };
    aniListPacing.maxRetries = 1;
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }));
    await expect(filterAnime(filter, 1)).rejects.toThrow(/too many requests right now/i);
    Object.assign(aniListPacing, before);
  });

  it('spaces requests out when few are left this minute', async () => {
    const times: number[] = [];
    vi.stubGlobal('fetch', async () => {
      times.push(Date.now());
      // 10 of 30 left: spread over the minute (2 s apart).
      return Response.json(page, { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '10' } });
    });
    // The first answer tells Mediarr how many are left; the next two then start 2 s apart.
    await filterAnime(filter, 1);
    await Promise.all([filterAnime(filter, 2), filterAnime(filter, 3)]);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1900);
    // Back to normal once there's room again.
    vi.stubGlobal('fetch', async () => Response.json(page, { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '29' } }));
    await filterAnime(filter, 3);
    expect(animeFilterVariables(filter, 1)).toMatchObject({ page: 1 });
  }, 15_000);
});
