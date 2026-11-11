import { getSettings } from '../settings.js';
import { fetchJson, HttpError } from './http.js';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

export interface SearchResult {
  type: 'movie' | 'show' | 'anime';
  tmdbId?: number;
  anilistId?: number;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
  extra?: string;
  /** TMDB show that is really Japanese anime (it belongs in the Anime tab). */
  isAnime?: boolean;
  /** Other names (original title, romaji…), for matching folder names when scanning the library. */
  altTitles?: string[];
}

export interface TmdbEpisode {
  season: number;
  episode: number;
  title: string;
  airDate: string | null;
}

export interface TmdbShowDetails {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  status: string;
  seasons: { season: number; name: string; episodeCount: number; airDate: string | null }[];
}

async function tmdb<T>(path: string, params: Record<string, string> = {}, apiKey = getSettings().tmdbApiKey): Promise<T> {
  if (!apiKey) throw new HttpError('TMDB API key is not set (Settings).');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: 'application/json' };
  // v4 read access tokens are JWTs; v3 keys are 32-char hex.
  if (apiKey.length > 40) headers.authorization = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);
  return fetchJson<T>(url.toString(), { headers });
}

const yearOf = (d?: string | null) => (d ? Number(d.slice(0, 4)) || null : null);
const poster = (p?: string | null) => (p ? IMG + p : null);
/** Library backdrops: sharp enough for a full-width banner, light enough for a row of cards. */
const LIBRARY_BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const backdrop = (p?: string | null) => (p ? LIBRARY_BACKDROP + p : null);

export async function testTmdb(apiKey: string) {
  await tmdb('/configuration', {}, apiKey);
}

const ANIMATION_GENRE = 16;

/**
 * TMDB lists Japanese anime as ordinary TV and movies (including recap/compilation films). It's anime
 * when it's tagged Animation and is Japanese (origin country or original language), so western
 * animation (Arcane, The Simpsons, Inside Out) stays in Shows/Movies. Anime belongs in the Anime tab.
 */
export function isAnimeTitle(s: { genre_ids?: number[]; genres?: { id: number }[]; origin_country?: string[]; original_language?: string }): boolean {
  const genres = s.genre_ids ?? s.genres?.map((g) => g.id) ?? [];
  return genres.includes(ANIMATION_GENRE) && (!!s.origin_country?.includes('JP') || s.original_language === 'ja');
}

const toMovie = (m: any): SearchResult => ({
  type: 'movie',
  tmdbId: m.id,
  title: m.title,
  year: yearOf(m.release_date),
  poster: poster(m.poster_path),
  overview: m.overview ?? '',
  ...(isAnimeTitle(m) ? { isAnime: true } : {}),
  ...(m.original_title && m.original_title !== m.title ? { altTitles: [m.original_title] } : {}),
});

const toShow = (s: any): SearchResult => ({
  type: 'show',
  tmdbId: s.id,
  title: s.name,
  year: yearOf(s.first_air_date),
  poster: poster(s.poster_path),
  overview: s.overview ?? '',
  ...(isAnimeTitle(s) ? { isAnime: true } : {}),
  ...(s.original_name && s.original_name !== s.name ? { altTitles: [s.original_name] } : {}),
});

// Episode counts, remembered for a while: a Discover row refresh asks about the same shows again.
const episodeCountCache = new Map<number, { at: number; count: number | null }>();
const EPISODE_COUNT_TTL_MS = 12 * 3600_000;

/** Lookups already on their way: rows load in parallel and share shows, so they wait for the same answer. */
const episodeCountInFlight = new Map<number, Promise<number | null>>();

function episodeCount(id: number): Promise<number | null> {
  const hit = episodeCountCache.get(id);
  if (hit && Date.now() - hit.at < EPISODE_COUNT_TTL_MS) return Promise.resolve(hit.count);
  const pending = episodeCountInFlight.get(id);
  if (pending) return pending;
  const lookup = tmdb<{ number_of_episodes?: number }>(`/tv/${id}`)
    .catch(() => null)
    .then((s) => {
      const count = s && typeof s.number_of_episodes === 'number' && s.number_of_episodes > 0 ? s.number_of_episodes : null;
      if (s) episodeCountCache.set(id, { at: Date.now(), count });
      if (episodeCountCache.size > 2000) episodeCountCache.delete(episodeCountCache.keys().next().value!);
      return count;
    })
    .finally(() => episodeCountInFlight.delete(id));
  episodeCountInFlight.set(id, lookup);
  return lookup;
}

/** Adds "120 eps" to TV shows (for Discover cards). A few lookups at a time; failures just leave it off. */
export async function withEpisodeCounts(items: SearchResult[]): Promise<SearchResult[]> {
  const ids = [...new Set(items.filter((i) => i.type === 'show' && i.tmdbId).map((i) => i.tmdbId!))];
  const counts = new Map<number, number | null>();
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8);
    const found = await Promise.all(batch.map(episodeCount));
    batch.forEach((id, j) => counts.set(id, found[j]));
  }
  return items.map((it) => {
    const n = it.type === 'show' && it.tmdbId ? counts.get(it.tmdbId) : null;
    return n ? { ...it, extra: `${n} eps` } : it;
  });
}

export async function searchMovies(query: string): Promise<SearchResult[]> {
  const r = await tmdb<{ results: any[] }>('/search/movie', { query, include_adult: 'false' });
  return r.results.map(toMovie);
}

export async function searchShows(query: string): Promise<SearchResult[]> {
  const r = await tmdb<{ results: any[] }>('/search/tv', { query, include_adult: 'false' });
  return r.results.map(toShow);
}

export interface BrowseRow {
  id: string;
  title: string;
  items: SearchResult[];
}

const MOVIE_ROWS: [string, string, string][] = [
  ['trending', 'Trending this week', '/trending/movie/week'],
  ['now-playing', 'In theaters now', '/movie/now_playing'],
  ['popular', 'Popular', '/movie/popular'],
  ['upcoming', 'Coming soon', '/movie/upcoming'],
  ['top-rated', 'Top rated', '/movie/top_rated'],
];

const SHOW_ROWS: [string, string, string][] = [
  ['trending', 'Trending this week', '/trending/tv/week'],
  ['airing-today', 'Airing today', '/tv/airing_today'],
  ['on-the-air', 'On the air this week', '/tv/on_the_air'],
  ['popular', 'Popular', '/tv/popular'],
  ['top-rated', 'Top rated', '/tv/top_rated'],
];

const ROW_SIZE = 20;

/** Curated lists for the Discover page when you're not searching. */
export async function browseTmdb(type: 'movie' | 'show'): Promise<BrowseRow[]> {
  const rows = type === 'movie' ? MOVIE_ROWS : SHOW_ROWS;
  const map = type === 'movie' ? toMovie : toShow;
  return Promise.all(
    rows.map(async ([id, title, path]) => {
      // Anime is dropped (it has its own tab), so take two pages to still fill the row.
      const pages = ['1', '2'];
      const results = (
        await Promise.all(pages.map((page) => tmdb<{ results: any[] }>(path, { include_adult: 'false', page })))
      ).flatMap((r) => r.results);
      const seen = new Set<number>();
      const items = results
        // Entries without a poster are usually obscure or broken; they make a poor browse row.
        .filter((x) => x.poster_path && !x.adult && !isAnimeTitle(x) && !seen.has(x.id) && seen.add(x.id))
        .slice(0, ROW_SIZE)
        .map(map);
      return { id, title, items: type === 'show' ? await withEpisodeCounts(items) : items };
    }),
  );
}

export async function getMovie(id: number) {
  const m = await tmdb<any>(`/movie/${id}`);
  return {
    tmdbId: m.id as number,
    title: m.title as string,
    originalTitle: m.original_title as string,
    year: yearOf(m.release_date),
    releaseDate: (m.release_date as string) || null,
    poster: poster(m.poster_path),
    backdrop: backdrop(m.backdrop_path),
    overview: (m.overview as string) ?? '',
    status: m.status as string,
  };
}

export async function getShow(id: number): Promise<TmdbShowDetails> {
  const s = await tmdb<any>(`/tv/${id}`);
  return {
    tmdbId: s.id,
    title: s.name,
    originalTitle: s.original_name,
    year: yearOf(s.first_air_date),
    poster: poster(s.poster_path),
    backdrop: backdrop(s.backdrop_path),
    overview: s.overview ?? '',
    status: s.status,
    seasons: (s.seasons ?? []).map((x: any) => ({
      season: x.season_number,
      name: x.name,
      episodeCount: x.episode_count,
      airDate: x.air_date || null,
    })),
  };
}

export async function getShowEpisodes(id: number, seasons: number[]): Promise<TmdbEpisode[]> {
  const out: TmdbEpisode[] = [];
  for (const n of seasons) {
    const season = await tmdb<any>(`/tv/${id}/season/${n}`);
    for (const e of season.episodes ?? []) {
      out.push({ season: n, episode: e.episode_number, title: e.name, airDate: e.air_date || null });
    }
  }
  return out;
}

/** A title shown big in the Discover banner. */
export interface FeaturedItem extends SearchResult {
  backdrop: string | null;
  /** Transparent title artwork (like Jellyfin's), when TMDB has one. */
  logo: string | null;
  /** 0–10 */
  rating: number | null;
  genres: string[];
  /** Short facts for the meta line: "2 seasons", "2h 15m", "24 eps". */
  facts: string[];
  /** Age rating, e.g. "PG-13" or "TV-14". */
  certification: string | null;
}

// Full resolution: the banner spans the whole screen, and w1280 looks soft on 1440p/4K monitors.
const BACKDROP = 'https://image.tmdb.org/t/p/original';
const LOGO = 'https://image.tmdb.org/t/p/w500';
const FEATURED_COUNT = 6;

function pickLogo(logos: { file_path: string; iso_639_1: string | null }[] | undefined): string | null {
  const best = logos?.find((l) => l.iso_639_1 === 'en') ?? logos?.find((l) => !l.iso_639_1);
  return best ? LOGO + best.file_path : null;
}

function runtime(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** The top trending titles with backdrops, logos and details for the Discover banner. */
export async function featuredTmdb(type: 'movie' | 'show'): Promise<FeaturedItem[]> {
  const trending = await tmdb<{ results: any[] }>(type === 'movie' ? '/trending/movie/week' : '/trending/tv/week');
  const picks = trending.results
    .filter((x) => x.backdrop_path && x.poster_path && !x.adult && !isAnimeTitle(x))
    .slice(0, FEATURED_COUNT);
  const items = await Promise.all(
    picks.map(async (p): Promise<FeaturedItem | null> => {
      try {
        const kind = type === 'movie' ? 'movie' : 'tv';
        const d = await tmdb<any>(`/${kind}/${p.id}`, {
          append_to_response: type === 'movie' ? 'images,release_dates' : 'images,content_ratings',
          include_image_language: 'en,null',
        });
        const base = type === 'movie' ? toMovie(d) : toShow(d);
        const certification =
          type === 'movie'
            ? (d.release_dates?.results?.find((r: any) => r.iso_3166_1 === 'US')?.release_dates ?? []).find((r: any) => r.certification)
                ?.certification ?? null
            : d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === 'US')?.rating ?? null;
        const facts =
          type === 'movie'
            ? [runtime(d.runtime)]
            : [d.number_of_seasons ? `${d.number_of_seasons} season${d.number_of_seasons === 1 ? '' : 's'}` : null];
        return {
          ...base,
          backdrop: BACKDROP + (d.backdrop_path ?? p.backdrop_path),
          logo: pickLogo(d.images?.logos),
          rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
          genres: (d.genres ?? []).map((g: { name: string }) => g.name).slice(0, 3),
          facts: facts.filter(Boolean) as string[],
          certification: certification || null,
        };
      } catch {
        return null; // one failed lookup shouldn't empty the whole banner
      }
    }),
  );
  return items.filter((x): x is FeaturedItem => x !== null);
}

interface TmdbVideo {
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
  iso_639_1?: string | null;
  published_at?: string;
}

/** Best YouTube trailer: official over fan uploads, English first, trailers before teasers, newest first. */
export function pickTrailer(videos: TmdbVideo[] | undefined): { youtubeId: string; title: string } | null {
  const candidates = (videos ?? []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const score = (v: TmdbVideo) =>
    (v.type === 'Trailer' ? 4 : 0) + (v.official ? 2 : 0) + (v.iso_639_1 === 'en' || !v.iso_639_1 ? 1 : 0);
  const best = candidates.sort(
    (a, b) => score(b) - score(a) || (b.published_at ?? '').localeCompare(a.published_at ?? ''),
  )[0];
  return best ? { youtubeId: best.key, title: best.name } : null;
}

/** Full details for the Discover details screen (one request: details + age rating + IMDb id). */
export async function tmdbDetails(type: 'movie' | 'show', id: number) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const d = await tmdb<any>(`/${kind}/${id}`, {
    append_to_response: type === 'movie' ? 'release_dates,external_ids,videos' : 'content_ratings,external_ids,videos',
  });
  const certification =
    type === 'movie'
      ? ((d.release_dates?.results?.find((r: any) => r.iso_3166_1 === 'US')?.release_dates ?? []).find((r: any) => r.certification)
          ?.certification ?? null)
      : (d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === 'US')?.rating ?? null);
  const episodeRuntime = d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return {
    title: (type === 'movie' ? d.title : d.name) as string,
    originalTitle: ((type === 'movie' ? d.original_title : d.original_name) as string) || null,
    tagline: (d.tagline as string) || null,
    year: yearOf(type === 'movie' ? d.release_date : d.first_air_date),
    overview: (d.overview as string) ?? '',
    poster: d.poster_path ? 'https://image.tmdb.org/t/p/w500' + d.poster_path : null,
    backdrop: d.backdrop_path ? BACKDROP + d.backdrop_path : null,
    certification: (certification as string) || null,
    runtime: type === 'movie' ? runtime(d.runtime) : episodeRuntime ? `${episodeRuntime} min per episode` : null,
    length:
      type === 'show'
        ? [d.number_of_seasons ? plural(d.number_of_seasons, 'season') : null, d.number_of_episodes ? plural(d.number_of_episodes, 'episode') : null].filter(
            (x): x is string => !!x,
          )
        : [],
    status: (d.status as string) || null,
    released: ((type === 'movie' ? d.release_date : d.first_air_date) as string) || null,
    originalLanguage: (d.original_language as string) || null,
    genres: (d.genres ?? []).map((g: { name: string }) => g.name),
    studios: (type === 'show' ? d.networks : d.production_companies ?? []).slice(0, 3).map((c: { name: string }) => c.name),
    imdbId: (d.external_ids?.imdb_id as string) || (d.imdb_id as string) || null,
    trailer: pickTrailer(d.videos?.results),
    rating: d.vote_average
      ? {
          source: 'tmdb' as const,
          label: 'TMDB',
          value: `${Math.round(d.vote_average * 10)}%`,
          percent: d.vote_average * 10,
          url: `https://www.themoviedb.org/${kind}/${id}`,
        }
      : null,
  };
}
