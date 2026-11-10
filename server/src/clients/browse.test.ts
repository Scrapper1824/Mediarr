import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { animeSeasonOf } from './anilist.js';
import { browseTmdb } from './tmdb.js';

describe('browseTmdb', () => {
  const calls: string[] = [];
  beforeEach(() => {
    initDb(':memory:');
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(new URL(url).pathname);
      const results = [
        { id: 1, title: 'Dune: Part Two', name: 'Severance', release_date: '2024-03-01', first_air_date: '2022-02-18', poster_path: '/p.jpg', overview: 'x' },
        { id: 2, title: 'No Poster', name: 'No Poster', poster_path: null },
      ];
      return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds the movie rows from trending / now playing / popular / upcoming / top rated', async () => {
    const rows = await browseTmdb('movie');
    expect(rows.map((r) => r.title)).toEqual(['Trending this week', 'In theaters now', 'Popular', 'Coming soon', 'Top rated']);
    expect([...new Set(calls)]).toEqual(['/3/trending/movie/week', '/3/movie/now_playing', '/3/movie/popular', '/3/movie/upcoming', '/3/movie/top_rated']);
    expect(rows[0].items).toEqual([
      { type: 'movie', tmdbId: 1, title: 'Dune: Part Two', year: 2024, poster: 'https://image.tmdb.org/t/p/w342/p.jpg', overview: 'x' },
    ]);
  });

  it('builds the show rows', async () => {
    const rows = await browseTmdb('show');
    expect(rows.map((r) => r.title)).toEqual(['Trending this week', 'Airing today', 'On the air this week', 'Popular', 'Top rated']);
    expect(rows[1].items[0]).toMatchObject({ type: 'show', title: 'Severance', year: 2022 });
  });
});

describe('animeSeasonOf', () => {
  it.each([
    ['2026-01-15', 'WINTER'],
    ['2026-04-01', 'SPRING'],
    ['2026-08-30', 'SUMMER'],
    ['2026-11-02', 'FALL'],
  ])('%s is %s', (date, season) => {
    expect(animeSeasonOf(new Date(`${date}T12:00:00`)).season).toBe(season);
  });
});

describe('featuredTmdb', () => {
  beforeEach(() => {
    initDb(':memory:');
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      let body: unknown;
      if (u.pathname.startsWith('/3/trending/')) {
        body = { results: [{ id: 84958, name: 'Loki', backdrop_path: '/b.jpg', poster_path: '/p.jpg' }, { id: 2, name: 'No art' }] };
      } else if (u.pathname === '/3/tv/84958') {
        expect(u.searchParams.get('append_to_response')).toBe('images,content_ratings');
        body = {
          id: 84958, name: 'Loki', first_air_date: '2021-06-09', poster_path: '/p.jpg', backdrop_path: '/b2.jpg', overview: 'God of Mischief',
          vote_average: 8.234, number_of_seasons: 2, genres: [{ name: 'Sci-Fi & Fantasy' }, { name: 'Drama' }],
          images: { logos: [{ file_path: '/fr.png', iso_639_1: 'fr' }, { file_path: '/en.png', iso_639_1: 'en' }] },
          content_ratings: { results: [{ iso_3166_1: 'DE', rating: '12' }, { iso_3166_1: 'US', rating: 'TV-14' }] },
        };
      } else throw new Error('unexpected ' + u.pathname);
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds a Jellyfin-style banner item', async () => {
    const { featuredTmdb } = await import('./tmdb.js');
    const [loki, ...rest] = await featuredTmdb('show');
    expect(rest).toHaveLength(0); // titles without artwork are skipped
    expect(loki).toMatchObject({
      title: 'Loki',
      year: 2021,
      backdrop: 'https://image.tmdb.org/t/p/original/b2.jpg',
      logo: 'https://image.tmdb.org/t/p/w500/en.png', // English logo preferred
      rating: 8.2,
      genres: ['Sci-Fi & Fantasy', 'Drama'],
      facts: ['2 seasons'],
      certification: 'TV-14',
    });
  });
});

describe('keeping anime out of Shows', () => {
  it.each([
    [{ genre_ids: [16, 10759], origin_country: ['JP'], original_language: 'ja' }, true], // e.g. Frieren
    [{ genre_ids: [16], origin_country: ['US'], original_language: 'ja' }, true], // Japanese-language co-production
    [{ genre_ids: [16, 18], origin_country: ['US'], original_language: 'en' }, false], // Arcane
    [{ genre_ids: [16, 35], origin_country: ['US'], original_language: 'en' }, false], // The Simpsons
    [{ genre_ids: [18], origin_country: ['JP'], original_language: 'ja' }, false], // Japanese live-action drama
    [{ genres: [{ id: 16 }], origin_country: ['JP'] }, true], // details shape
  ])('%j -> %s', async (show, expected) => {
    const { isAnimeTitle } = await import('./tmdb.js');
    expect(isAnimeTitle(show)).toBe(expected);
  });

  it('drops anime from the Shows rows and banner, but not western animation', async () => {
    initDb(':memory:');
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
    const shows = [
      { id: 1, name: 'Frieren', genre_ids: [16], origin_country: ['JP'], original_language: 'ja', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
      { id: 2, name: 'Arcane', genre_ids: [16], origin_country: ['US'], original_language: 'en', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
      { id: 3, name: 'Severance', genre_ids: [18], origin_country: ['US'], original_language: 'en', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
    ];
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const body = /^\/3\/tv\/\d+$/.test(u.pathname)
        ? { ...shows.find((s) => `/3/tv/${s.id}` === u.pathname), genres: [] }
        : { results: u.searchParams.get('page') === '2' ? [] : shows };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { browseTmdb, featuredTmdb } = await import('./tmdb.js');
    const rows = await browseTmdb('show');
    expect(rows[0].items.map((i) => i.title)).toEqual(['Arcane', 'Severance']);
    expect((await featuredTmdb('show')).map((i) => i.title)).toEqual(['Arcane', 'Severance']);
    vi.unstubAllGlobals();
  });
});

describe('keeping anime out of Movies', () => {
  it('drops Japanese anime films from the Movies rows and banner, keeps western animation', async () => {
    initDb(':memory:');
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
    const movies = [
      { id: 1, title: 'Demon Slayer: Infinity Castle', genre_ids: [16, 28], original_language: 'ja', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
      { id: 2, title: 'Inside Out 2', genre_ids: [16, 10751], original_language: 'en', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
      { id: 3, title: 'Dune: Part Two', genre_ids: [878], original_language: 'en', poster_path: '/a.jpg', backdrop_path: '/b.jpg' },
    ];
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const body = /^\/3\/movie\/\d+$/.test(u.pathname)
        ? { ...movies.find((m) => `/3/movie/${m.id}` === u.pathname), genres: [] }
        : { results: u.searchParams.get('page') === '2' ? [] : movies };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { browseTmdb, featuredTmdb, searchMovies } = await import('./tmdb.js');
    expect((await browseTmdb('movie'))[0].items.map((i) => i.title)).toEqual(['Inside Out 2', 'Dune: Part Two']);
    expect((await featuredTmdb('movie')).map((i) => i.title)).toEqual(['Inside Out 2', 'Dune: Part Two']);
    // Search keeps them but flags them, so the page can hide them and point to the Anime tab.
    expect((await searchMovies('x')).filter((m) => m.isAnime).map((m) => m.title)).toEqual(['Demon Slayer: Infinity Castle']);
    vi.unstubAllGlobals();
  });
});
