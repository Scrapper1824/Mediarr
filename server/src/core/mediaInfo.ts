import { anilistDetails } from '../clients/anilist.js';
import { kitsuInfo, malInfo, omdbRatings, type Rating } from '../clients/ratings.js';
import { tmdbDetails } from '../clients/tmdb.js';
import type { MediaType } from '../db.js';

/** Everything the Discover details screen shows about a title. */
export interface MediaInfo {
  type: MediaType;
  tmdbId?: number;
  anilistId?: number;
  title: string;
  originalTitle: string | null;
  tagline: string | null;
  year: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  /** e.g. "PG-13", "TV-14", "PG – Teens 13 or older" */
  certification: string | null;
  /** e.g. "1h 43m", "24 min per episode" */
  runtime: string | null;
  /** e.g. ["2 seasons", "18 episodes"] */
  length: string[];
  status: string | null;
  released: string | null;
  /** ISO 639-1 code; the page shows its name. */
  originalLanguage: string | null;
  genres: string[];
  /** Studios (movies/anime) or networks (shows). */
  studios: string[];
  studioLabel: string;
  ratings: Rating[];
  links: { label: string; url: string }[];
  /** A YouTube trailer to play on the details screen. */
  trailer: { youtubeId: string; title: string } | null;
}

export async function getMediaInfo(type: MediaType, id: number): Promise<MediaInfo> {
  if (type === 'anime') {
    const a = await anilistDetails(id);
    // Extra rating sites are looked up together and skipped if they don't answer in time.
    const [mal, kitsu] = await Promise.all([malInfo(a.idMal), kitsuInfo(a.idMal)]);
    const ratings = [a.rating, mal.rating, kitsu.rating].filter((r): r is Rating => !!r);
    return {
      type,
      anilistId: a.anilistId,
      title: a.title,
      originalTitle: a.originalTitle,
      tagline: null,
      year: a.year,
      overview: a.overview,
      poster: a.poster,
      backdrop: a.backdrop,
      certification: kitsu.ageRating ?? mal.ageRating,
      runtime: a.runtime,
      length: a.length,
      status: a.status,
      released: a.released,
      originalLanguage: a.originalLanguage,
      genres: a.genres,
      studios: a.studios,
      studioLabel: 'Studio',
      ratings,
      trailer: a.trailer,
      links: [
        { label: 'AniList', url: a.url },
        ...(a.idMal ? [{ label: 'MyAnimeList', url: `https://myanimelist.net/anime/${a.idMal}` }] : []),
      ],
    };
  }

  const t = await tmdbDetails(type, id);
  const ratings = [t.rating, ...(await omdbRatings(t.imdbId))].filter((r): r is Rating => !!r);
  return {
    type,
    tmdbId: id,
    title: t.title,
    originalTitle: t.originalTitle,
    tagline: t.tagline,
    year: t.year,
    overview: t.overview,
    poster: t.poster,
    backdrop: t.backdrop,
    certification: t.certification,
    runtime: t.runtime,
    length: t.length,
    status: t.status,
    released: t.released,
    originalLanguage: t.originalLanguage,
    genres: t.genres,
    studios: t.studios,
    studioLabel: type === 'show' ? 'Network' : 'Studio',
    trailer: t.trailer,
    ratings,
    links: [
      { label: 'TMDB', url: `https://www.themoviedb.org/${type === 'movie' ? 'movie' : 'tv'}/${id}` },
      ...(t.imdbId ? [{ label: 'IMDb', url: `https://www.imdb.com/title/${t.imdbId}/` }] : []),
    ],
  };
}
