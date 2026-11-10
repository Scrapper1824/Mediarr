import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { getMediaInfo } from './mediaInfo.js';

describe('getMediaInfo (movie)', () => {
  beforeEach(() => {
    initDb(':memory:');
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      let body: unknown;
      if (u.hostname === 'api.themoviedb.org') {
        expect(u.searchParams.get('append_to_response')).toBe('release_dates,external_ids,videos');
        body = {
          title: 'Coyote vs. Acme', original_title: 'Coyote vs. Acme', release_date: '2026-08-28', runtime: 103, overview: 'Lawsuit.',
          vote_average: 8.0, original_language: 'en', status: 'Released', genres: [{ name: 'Comedy' }, { name: 'Family' }],
          production_companies: [{ name: 'Troll Court Entertainment' }], poster_path: '/p.jpg', backdrop_path: '/b.jpg',
          external_ids: { imdb_id: 'tt1234567' },
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG' }] }] },
        };
      } else if (u.hostname === 'www.omdbapi.com') {
        expect(u.searchParams.get('i')).toBe('tt1234567');
        body = { Response: 'True', imdbRating: '7.3', Ratings: [{ Source: 'Rotten Tomatoes', Value: '96%' }] };
      } else throw new Error('unexpected ' + url);
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('collects ratings, age rating, length, language and studio', async () => {
    saveSettings({ tmdbApiKey: 'a'.repeat(32), omdbApiKey: 'k' });
    const info = await getMediaInfo('movie', 42);
    expect(info).toMatchObject({
      title: 'Coyote vs. Acme',
      year: 2026,
      certification: 'PG',
      runtime: '1h 43m',
      originalLanguage: 'en',
      genres: ['Comedy', 'Family'],
      studios: ['Troll Court Entertainment'],
      studioLabel: 'Studio',
    });
    expect(info.ratings.map((r) => `${r.label} ${r.value}`)).toEqual(['TMDB 80%', 'IMDb 7.3', 'Rotten Tomatoes 96%']);
  });

  it('shows IMDb as not rated yet for new releases, keeping Rotten Tomatoes', async () => {
    saveSettings({ tmdbApiKey: 'a'.repeat(32), omdbApiKey: 'k' });
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const body =
        u.hostname === 'www.omdbapi.com'
          ? { Response: 'True', imdbRating: 'N/A', Ratings: [{ Source: 'Rotten Tomatoes', Value: '31%' }] }
          : { title: 'Verity', release_date: '2026-09-29', vote_average: 6.8, external_ids: { imdb_id: 'tt32261958' } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const info = await getMediaInfo('movie', 1283515);
    expect(info.ratings.map((r) => `${r.label} ${r.value}${r.pending ? ' (pending)' : ''}`)).toEqual(['TMDB 68%', 'IMDb N/A (pending)', 'Rotten Tomatoes 31%']);
  });

  it('still works without an OMDb key (TMDB rating only)', async () => {
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
    const info = await getMediaInfo('movie', 42);
    expect(info.ratings.map((r) => r.label)).toEqual(['TMDB']);
    expect(info.links.map((l) => l.label)).toEqual(['TMDB', 'IMDb']);
  });
});

describe('pickTrailer', () => {
  it('prefers an official English YouTube trailer, newest first, over teasers and fan uploads', async () => {
    const { pickTrailer } = await import('../clients/tmdb.js');
    const videos = [
      { key: 'teaser', name: 'Teaser', site: 'YouTube', type: 'Teaser', official: true, iso_639_1: 'en', published_at: '2026-01-01' },
      { key: 'fan', name: 'Fan trailer', site: 'YouTube', type: 'Trailer', official: false, iso_639_1: 'en', published_at: '2026-06-01' },
      { key: 'old', name: 'Trailer 1', site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2026-02-01' },
      { key: 'new', name: 'Official Trailer 2', site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2026-05-01' },
      { key: 'vimeo', name: 'Trailer', site: 'Vimeo', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2026-07-01' },
      { key: 'bts', name: 'Behind the scenes', site: 'YouTube', type: 'Behind the Scenes', official: true, iso_639_1: 'en' },
    ];
    expect(pickTrailer(videos)).toEqual({ youtubeId: 'new', title: 'Official Trailer 2' });
    expect(pickTrailer([videos[0]])).toEqual({ youtubeId: 'teaser', title: 'Teaser' });
    expect(pickTrailer([videos[4], videos[5]])).toBeNull();
    expect(pickTrailer(undefined)).toBeNull();
  });
});
