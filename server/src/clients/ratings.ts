import { getSettings } from '../settings.js';

/** One rating badge on the details screen. `percent` (0–100) is for colouring; `value` is what's shown. */
export interface Rating {
  source: 'tmdb' | 'imdb' | 'rt' | 'anilist' | 'mal' | 'kitsu';
  label: string;
  value: string;
  percent: number;
  url?: string;
  /** The site knows the title but has no score yet (e.g. too few IMDb votes for a new release). */
  pending?: boolean;
}

// Optional extras: a slow or unavailable source must never hold up the details screen.
const EXTRA_TIMEOUT_MS = 3500;

async function getJson<T>(url: string, accept = 'application/json'): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(EXTRA_TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** IMDb and Rotten Tomatoes scores via OMDb (needs a free key from omdbapi.com in Settings). */
export async function omdbRatings(imdbId: string | null | undefined, apiKey = getSettings().omdbApiKey): Promise<Rating[]> {
  if (!imdbId || !apiKey) return [];
  const r = await getJson<{ Response: string; imdbRating?: string; imdbVotes?: string; Ratings?: { Source: string; Value: string }[] }>(
    `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`,
  );
  if (!r || r.Response !== 'True') return [];
  const out: Rating[] = [];
  const imdb = Number(r.imdbRating);
  const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
  if (imdb) out.push({ source: 'imdb', label: 'IMDb', value: imdb.toFixed(1), percent: imdb * 10, url: imdbUrl });
  // New releases often have no IMDb score yet: say so instead of leaving it out.
  else out.push({ source: 'imdb', label: 'IMDb', value: 'N/A', percent: 0, url: imdbUrl, pending: true });
  const rt = r.Ratings?.find((x) => x.Source === 'Rotten Tomatoes')?.Value;
  if (rt) out.push({ source: 'rt', label: 'Rotten Tomatoes', value: rt, percent: Number.parseInt(rt, 10) || 0 });
  return out;
}

export async function testOmdb(apiKey: string): Promise<void> {
  const r = await fetch(`https://www.omdbapi.com/?i=tt0133093&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15000) });
  const j = (await r.json().catch(() => ({}))) as { Response?: string; Error?: string };
  if (j.Response !== 'True') throw new Error(j.Error ?? `OMDb answered ${r.status}`);
}

/** MyAnimeList score (and age rating) via the free Jikan API. */
export async function malInfo(idMal: number | null | undefined): Promise<{ rating: Rating | null; ageRating: string | null }> {
  if (!idMal) return { rating: null, ageRating: null };
  const r = await getJson<{ data?: { score: number | null; rating: string | null; url: string } }>(`https://api.jikan.moe/v4/anime/${idMal}`);
  const d = r?.data;
  return {
    rating: d?.score ? { source: 'mal', label: 'MyAnimeList', value: d.score.toFixed(2), percent: d.score * 10, url: d.url } : null,
    ageRating: d?.rating ?? null,
  };
}

/** Kitsu community rating and age rating, looked up by MyAnimeList id. */
export async function kitsuInfo(idMal: number | null | undefined): Promise<{ rating: Rating | null; ageRating: string | null }> {
  if (!idMal) return { rating: null, ageRating: null };
  const r = await getJson<{ included?: { attributes: { averageRating: string | null; ageRating: string | null; ageRatingGuide: string | null; slug: string } }[] }>(
    `https://kitsu.app/api/edge/mappings?${new URLSearchParams({ 'filter[externalSite]': 'myanimelist/anime', 'filter[externalId]': String(idMal), include: 'item' })}`,
    // Kitsu only answers clients asking for its JSON:API format.
    'application/vnd.api+json',
  );
  const a = r?.included?.[0]?.attributes;
  if (!a) return { rating: null, ageRating: null };
  const avg = Number(a.averageRating);
  return {
    rating: avg ? { source: 'kitsu', label: 'Kitsu', value: `${Math.round(avg)}%`, percent: avg, url: `https://kitsu.app/anime/${a.slug}` } : null,
    ageRating: a.ageRating ? [a.ageRating, a.ageRatingGuide].filter(Boolean).join(' – ') : null,
  };
}
