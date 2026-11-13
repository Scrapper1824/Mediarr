import { animeGenres, filterAnime, type FilteredAnime } from '../clients/anilist.js';
import { dubbedAmong } from '../clients/animeschedule.js';
import { filterTmdb, tmdbGenres, type SearchResult } from '../clients/tmdb.js';
import type { MediaType } from '../db.js';

/**
 * Discover filters. Movies and shows are filtered by TMDB, anime by AniList; for anime, "Dubbed" /
 * "Sub only" is checked against AnimeSchedule (AniList doesn't know about dubs).
 */
export interface DiscoverFilter {
  /** TMDB genre ids (movies/shows) or AniList genre names (anime). A title must have all of them. */
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  /** 0–10. */
  minRating: number | null;
  sort: 'popular' | 'trending' | 'top' | 'newest' | 'oldest' | 'title';
  /** Original language (movies/shows), e.g. "en", "ko". */
  language: string | null;
  /** Movies: released / upcoming. Shows: airing / ended / upcoming. Anime: airing / finished / upcoming. */
  status: 'released' | 'airing' | 'ended' | 'finished' | 'upcoming' | null;
  /** Anime formats: TV, MOVIE, OVA, ONA, SPECIAL. */
  formats: string[];
  /** Anime: the season it started (any year, or the one year picked). */
  season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL' | null;
  /** Anime: has an English dub, or doesn't (yet). */
  audio: 'dub' | 'sub' | null;
  /** Anime: text search combined with the filters. */
  q: string | null;
}

export interface FilteredPage {
  items: (SearchResult & { dubbed?: boolean | null })[];
  /** Ask for this page next; null when there's nothing more. */
  nextPage: number | null;
}

const SORTS = ['popular', 'trending', 'top', 'newest', 'oldest', 'title'] as const;
const STATUSES = ['released', 'airing', 'ended', 'finished', 'upcoming'] as const;
const FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'] as const;
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;

const list = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
const year = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);

/** Reads (and cleans) the filter from a query string; anything unknown is ignored. */
export function parseFilter(q: Record<string, unknown>): DiscoverFilter {
  const rating = Number(q.minRating);
  let yearFrom = year(q.yearFrom);
  let yearTo = year(q.yearTo);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const text = String(q.q ?? '').trim().slice(0, 200);
  return {
    genres: list(q.genres).map((g) => g.slice(0, 60)),
    yearFrom,
    yearTo,
    minRating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : null,
    sort: oneOf(q.sort, SORTS) ?? 'popular',
    language: /^[a-z]{2}$/.test(String(q.language ?? '')) ? String(q.language) : null,
    status: oneOf(q.status, STATUSES),
    formats: list(q.formats).filter((f): f is (typeof FORMATS)[number] => (FORMATS as readonly string[]).includes(f)),
    season: oneOf(q.season, SEASONS),
    audio: oneOf(q.audio, ['dub', 'sub'] as const),
    q: text || null,
  };
}

/** How many anime cards a page should have, at least, when "Dubbed"/"Sub only" thins out AniList's pages. */
const ANIME_TARGET = 24;
const MAX_ANIME_PAGES = 3;

export async function discoverFiltered(type: MediaType, f: DiscoverFilter, page: number, adult = false): Promise<FilteredPage> {
  if (type !== 'anime') return filterTmdb(type, f, page, adult);

  const items: FilteredPage['items'] = [];
  let next: number | null = page;
  for (let i = 0; next !== null && i < MAX_ANIME_PAGES && items.length < ANIME_TARGET; i++) {
    // Dub/sub filtering thins pages out, so look at more titles per page.
    const r: { media: FilteredAnime[]; hasNext: boolean } = await filterAnime(f, next, f.audio ? 50 : 30, adult);
    next = r.hasNext ? next + 1 : null;
    // Which of them have an English dub (shown on the cards; needed for the Dubbed/Sub only filter).
    let dubbed: Map<number, boolean | null>;
    try {
      dubbed = await dubbedAmong(r.media);
    } catch (err) {
      if (f.audio) throw new Error(`Couldn't check which anime are dubbed right now (${(err as Error).message}). Try again in a minute.`);
      dubbed = new Map();
    }
    for (const m of r.media) {
      const d = dubbed.get(m.anilistId) ?? null;
      if (f.audio === 'dub' && d !== true) continue;
      if (f.audio === 'sub' && d === true) continue;
      items.push({ ...m.result, dubbed: d });
    }
    // Without the audio filter one AniList page is a page.
    if (!f.audio) break;
  }
  return { items, nextPage: next };
}

/** The genres to choose from on each tab. */
export async function genresFor(type: MediaType, adult = false): Promise<{ id: string; name: string; group?: 'genre' | 'theme'; popular?: boolean; adult?: boolean }[]> {
  if (type === 'anime') return (await animeGenres()).filter((g) => adult || !g.adult);
  return tmdbGenres(type);
}
