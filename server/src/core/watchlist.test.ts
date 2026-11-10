import { describe, expect, it } from 'vitest';
import type { AniListEntry } from '../clients/anilist.js';
import { itemBody, parseAllItems, type SimklItem } from '../clients/simkl.js';
import { fromAniList, fromSimkl, mergeLists, toAniList, toSimkl, WATCH_STATUSES } from './watchlist.js';

const simklItem = (over: Partial<SimklItem>): SimklItem => ({
  kind: 'anime',
  status: 'plantowatch',
  title: 'Frieren',
  year: 2023,
  poster: 'https://simkl.in/posters/x_m.jpg',
  ids: {},
  watched: null,
  total: null,
  ...over,
});
const anilistEntry = (over: Partial<AniListEntry>): AniListEntry => ({
  entryId: 1,
  status: 'CURRENT',
  progress: 4,
  anilistId: 154587,
  malId: 52991,
  title: "Frieren: Beyond Journey's End",
  year: 2023,
  poster: 'https://s4.anilist.co/x.jpg',
  episodes: 28,
  ...over,
});

describe('watchlist statuses', () => {
  it('round-trips every status through Simkl and AniList', () => {
    for (const s of WATCH_STATUSES) {
      expect(fromSimkl(toSimkl(s))).toBe(s);
      expect(fromAniList(toAniList(s))).toBe(s);
    }
    expect(toSimkl('planned')).toBe('plantowatch');
    expect(toSimkl('paused')).toBe('hold');
    expect(fromAniList('REPEATING')).toBe('watching');
  });
});

describe('merging the two lists', () => {
  it('shows an anime on both services once, with AniList as the anime source', () => {
    const merged = mergeLists([simklItem({ ids: { simkl: 9, anilist: 154587 } })], [anilistEntry({})]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      key: 'anime:154587',
      status: 'watching',
      services: { simkl: 'planned', anilist: 'watching' },
      progress: { watched: 4, total: 28 },
    });
  });

  it('maps Simkl anime that only have a MAL id onto AniList', () => {
    const merged = mergeLists([simklItem({ ids: { simkl: 9, mal: 52991 } })], [anilistEntry({})], new Map([[52991, 154587]]));
    expect(merged).toHaveLength(1);
    expect(merged[0].anilistId).toBe(154587);
  });

  it('keys movies and shows by TMDB id, and keeps titles Mediarr cannot match', () => {
    const merged = mergeLists(
      [
        simklItem({ kind: 'movies', title: 'Dune', status: 'completed', ids: { simkl: 1, tmdb: 438631 } }),
        simklItem({ kind: 'shows', title: 'Severance', status: 'watching', ids: { simkl: 2, tmdb: 95396 }, watched: 5, total: 19 }),
        simklItem({ kind: 'shows', title: 'Obscure', ids: { simkl: 3 } }),
      ],
      [],
    );
    expect(merged.map((m) => m.key)).toEqual(['movie:438631', 'show:95396', 'simkl:3']);
    expect(merged[1].progress).toEqual({ watched: 5, total: 19 });
    expect(merged[2].tmdbId).toBeUndefined();
  });
});

describe('Simkl responses and requests', () => {
  it('parses all-items into flat items', () => {
    const items = parseAllItems({
      movies: [{ status: 'plantowatch', movie: { title: 'Dune', year: 2021, poster: '12/abc', ids: { simkl: 1, tmdb: '438631', imdb: 'tt1160419' } } }],
      anime: [{ status: 'watching', watched_episodes_count: 3, total_episodes_count: 12, show: { title: 'Dandadan', ids: { simkl: 2, mal: '57334' } } }],
      shows: [{ status: 'unknown-status', show: { title: 'Skip me', ids: {} } }],
    });
    expect(items).toEqual([
      { kind: 'movies', status: 'plantowatch', title: 'Dune', year: 2021, poster: 'https://simkl.in/posters/12/abc_m.jpg', ids: expect.objectContaining({ tmdb: 438631, imdb: 'tt1160419' }), watched: null, total: null },
      { kind: 'anime', status: 'watching', title: 'Dandadan', year: null, poster: null, ids: expect.objectContaining({ mal: 57334 }), watched: 3, total: 12 },
    ]);
    expect(parseAllItems(null)).toEqual([]);
  });

  it('sends movies by TMDB id, shows typed, and anime by AniList id', () => {
    expect(itemBody('movie', { tmdb: 438631 }, 'plantowatch')).toEqual({ movies: [{ to: 'plantowatch', ids: { tmdb: 438631 } }] });
    expect(itemBody('show', { tmdb: 95396 }, 'watching')).toEqual({ shows: [{ to: 'watching', ids: { tmdb: 95396 }, type: 'show' }] });
    expect(itemBody('anime', { anilist: 21 })).toEqual({ shows: [{ ids: { anilist: 21 }, type: 'anime' }] });
  });
});
