import { afterEach, describe, expect, it, vi } from 'vitest';
import { animeFilterVariables } from '../clients/anilist.js';
import { matchDubs } from '../clients/animeschedule.js';
import { tmdbFilterParams } from '../clients/tmdb.js';
import { discoverFiltered, parseFilter } from './discoverFilter.js';

const NOW = new Date('2026-11-12T12:00:00Z');

describe('reading the filter', () => {
  it('keeps what it understands and drops the rest', () => {
    const f = parseFilter({ genres: 'Action, Romance,', yearFrom: '2020', yearTo: '2012', minRating: '7', sort: 'top', status: 'finished', formats: 'TV,MOVIE,BOGUS', season: 'FALL', audio: 'dub', language: 'ja', q: '  frieren ' });
    expect(f).toEqual({
      genres: ['Action', 'Romance'],
      yearFrom: 2012,
      yearTo: 2020,
      minRating: 7,
      sort: 'top',
      language: 'ja',
      status: 'finished',
      formats: ['TV', 'MOVIE'],
      season: 'FALL',
      audio: 'dub',
      q: 'frieren',
    });
    expect(parseFilter({ sort: 'drop table', audio: 'loud', language: 'english', yearFrom: '99999', minRating: '-3' })).toMatchObject({
      sort: 'popular',
      audio: null,
      language: null,
      yearFrom: null,
      minRating: null,
    });
  });
});

describe('movies and shows (TMDB)', () => {
  it('turns the filter into discover parameters', () => {
    const p = tmdbFilterParams('movie', parseFilter({ genres: '28,12', yearFrom: '2010', yearTo: '2019', minRating: '7', language: 'ko', sort: 'top' }), 2, NOW);
    expect(p).toMatchObject({
      page: '2',
      sort_by: 'vote_average.desc',
      with_genres: '28,12',
      'primary_release_date.gte': '2010-01-01',
      'primary_release_date.lte': '2019-12-31',
      'vote_average.gte': '7',
      'vote_count.gte': '300',
      with_original_language: 'ko',
      include_adult: 'false',
    });
  });

  it('"newest" and "released" never include films that are not out yet; "upcoming" only those', () => {
    expect(tmdbFilterParams('movie', parseFilter({ sort: 'newest' }), 1, NOW)['primary_release_date.lte']).toBe('2026-11-12');
    expect(tmdbFilterParams('movie', parseFilter({ status: 'released', yearTo: '2030' }), 1, NOW)['primary_release_date.lte']).toBe('2026-11-12');
    expect(tmdbFilterParams('movie', parseFilter({ status: 'upcoming' }), 1, NOW)['primary_release_date.gte']).toBe('2026-11-13');
  });

  it('show status: airing, ended, upcoming', () => {
    expect(tmdbFilterParams('show', parseFilter({ status: 'airing' }), 1, NOW).with_status).toBe('0');
    expect(tmdbFilterParams('show', parseFilter({ status: 'ended' }), 1, NOW).with_status).toBe('3|4');
    expect(tmdbFilterParams('show', parseFilter({ status: 'upcoming', yearFrom: '2026' }), 1, NOW)).toMatchObject({ with_status: '1|2', 'first_air_date.gte': '2026-01-01' });
  });
});

describe('anime (AniList)', () => {
  it('turns the filter into AniList variables', () => {
    const v = animeFilterVariables(parseFilter({ genres: 'Action', status: 'finished', formats: 'TV,OVA', yearFrom: '2015', yearTo: '2020', minRating: '8', sort: 'top' }), 3);
    expect(v).toMatchObject({
      page: 3,
      sort: ['SCORE_DESC'],
      genres: ['Action'],
      status: 'FINISHED',
      formats: ['TV', 'TV_SHORT', 'OVA'],
      from: 20150000,
      to: 20210000,
      score: 79,
      seasonYear: null,
    });
  });

  it('a season in one year, text search, and newest without unaired shows', () => {
    expect(animeFilterVariables(parseFilter({ season: 'FALL', yearFrom: '2025', yearTo: '2025' }), 1)).toMatchObject({ season: 'FALL', seasonYear: 2025 });
    expect(animeFilterVariables(parseFilter({ q: 'frieren' }), 1)).toMatchObject({ search: 'frieren', sort: ['SEARCH_MATCH', 'POPULARITY_DESC'] });
    expect(animeFilterVariables(parseFilter({ sort: 'newest' }), 1)).toMatchObject({ statusNot: 'NOT_YET_RELEASED' });
    expect(animeFilterVariables(parseFilter({ sort: 'newest', status: 'upcoming' }), 1)).toMatchObject({ statusNot: null, status: 'NOT_YET_RELEASED' });
  });
});

describe('matching AnimeSchedule answers back to AniList titles', () => {
  const asked = [
    { anilistId: 1, names: ['Shingeki no Kyojin', 'Attack on Titan'], aliases: ['AoT'], year: 2013, episodes: 25 },
    { anilistId: 2, names: ['Ansatsu Kyoushitsu (TV) 2nd Season'], aliases: [], year: 2016, episodes: 25 },
    { anilistId: 3, names: ['Gintama: THE FINAL'], aliases: ['Gintama'], year: 2021, episodes: 1 },
    { anilistId: 4, names: ['Gintama'], aliases: [], year: 2006, episodes: 201 },
  ];
  it('by title, then by other names, then by year and episode count', () => {
    const { dub, unmatched } = matchDubs(asked, [
      { title: 'Attack on Titan', names: { native: '進撃の巨人' }, dubExists: true, year: 2013, episodes: 25 },
      { title: 'Ansatsu Kyoushitsu 2', names: { english: 'Assassination Classroom 2' }, dubExists: true, year: 2016, episodes: 25 },
      { title: 'Gintama', names: {}, dubExists: true, year: 2006, episodes: 201 },
      { title: 'Gintama: THE FINAL', names: {}, dubExists: false, year: 2021, episodes: 1 },
      { title: 'Something else entirely', names: {}, dubExists: true, year: 1999, episodes: 3 },
    ]);
    expect([...dub.entries()].sort()).toEqual([
      [1, true],
      [2, true],
      [3, false],
      // "Gintama" is the TV series, not the film that lists it as another name.
      [4, true],
    ]);
    expect(unmatched).toBe(1);
  });
});

describe('dubbed / sub only', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps only dubbed (or only not dubbed) anime, reading more pages to fill one', async () => {
    const page = (start: number) =>
      Array.from({ length: 3 }, (_, i) => ({
        id: start + i,
        title: { romaji: `Show ${start + i}`, english: null, native: null },
        synonyms: [],
        format: 'TV',
        episodes: 12,
        seasonYear: 2020,
        startDate: { year: 2020 },
        coverImage: { large: 'x.jpg' },
        description: '',
      }));
    let anilistCalls = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('graphql.anilist.co')) {
        const { variables } = JSON.parse(String(init!.body));
        anilistCalls++;
        return Response.json({ data: { Page: { pageInfo: { hasNextPage: variables.page < 3 }, media: page(variables.page * 10) } } });
      }
      // AnimeSchedule: the even ids are dubbed.
      const ids = new URL(String(url)).searchParams.getAll('anilist-ids').map(Number);
      return Response.json({ anime: ids.map((id) => ({ title: `Show ${id}`, names: {}, dubExists: id % 2 === 0 })), totalAmount: ids.length });
    });
    const dubbed = await discoverFiltered('anime', parseFilter({ audio: 'dub', genres: 'Drama' }), 1);
    expect(dubbed.items.map((i) => i.anilistId)).toEqual([10, 12, 20, 22, 30, 32]);
    expect(dubbed.items.every((i) => i.dubbed === true)).toBe(true);
    expect(dubbed.nextPage).toBeNull();
    expect(anilistCalls).toBe(3);

    const subOnly = await discoverFiltered('anime', parseFilter({ audio: 'sub', genres: 'Drama' }), 1);
    expect(subOnly.items.map((i) => i.anilistId)).toEqual([11, 21, 31]);
  });
});
