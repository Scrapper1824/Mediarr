import { normalizeTitle, splitSequel, titleMatches, type ParsedRelease } from './releaseParser.js';

/** One season of an anime series; usually one AniList entry (split cours are merged). */
export interface AnimeSeason {
  season: number;
  anilistIds: number[];
  title: string;
  /** Searchable titles of this season's AniList entries (romaji, English, synonyms). */
  titles: string[];
  episodes: number;
  /** Episodes in all earlier seasons, for absolute numbering. */
  offset: number;
  year: number | null;
}

export interface AnimeMatch {
  /** Seasons the release covers. */
  seasons: number[];
  /** Specific episodes, or null when the release is a whole-season batch. */
  episodes: { season: number; episode: number }[] | null;
}

/** Season whose own title the release title equals, e.g. "Mushoku Tensei II" → season 2. */
function seasonFromTitle(title: string, seasons: AnimeSeason[]): number | null {
  const t = normalizeTitle(title);
  if (!t) return null;
  for (const s of [...seasons].reverse()) {
    if (s.titles.some((x) => normalizeTitle(x) === t)) return s.season;
  }
  return null;
}

function fromAbsolute(nums: number[], seasons: AnimeSeason[]): AnimeMatch | null {
  const eps = [];
  for (const n of nums) {
    const s = seasons.find((x) => n > x.offset && n <= x.offset + x.episodes);
    if (!s) return null;
    eps.push({ season: s.season, episode: n - s.offset });
  }
  return { seasons: [...new Set(eps.map((e) => e.season))], episodes: eps };
}

/**
 * A sequel AniList lists as its own series ("Cyberpunk: Edgerunners 2", season 1) that release groups
 * number as a later season of the original ("Cyberpunk Edgerunners S02"): the original's name and the
 * season its releases use.
 */
export function standaloneSequel(seasons: AnimeSeason[]): { base: string; n: number } | null {
  const first = seasons[0];
  if (!first || first.season !== 1) return null;
  for (const t of [first.title, ...first.titles]) {
    const s = splitSequel(t);
    if (s) return s;
  }
  return null;
}

/** "Cyberpunk Edgerunners S02" read as "Cyberpunk: Edgerunners 2" season 1. Returns null when it isn't such a release. */
export function asStandaloneSequel(p: ParsedRelease, seasons: AnimeSeason[]): ParsedRelease | null {
  const sequel = standaloneSequel(seasons);
  if (!sequel) return null;
  const claimed = p.season ?? (p.seasons.length ? Math.min(...p.seasons) : null);
  if (claimed === null || claimed < sequel.n) return null;
  // Named after the original, not the sequel itself ("Cyberpunk Edgerunners 2 - 06" needs no remapping).
  if (!titleMatches(p.title, [sequel.base]) || titleMatches(p.title, seasons[0].titles)) return null;
  const shift = (s: number) => s - (sequel.n - 1);
  return { ...p, season: p.season === null ? null : shift(p.season), seasons: p.seasons.map(shift) };
}

/**
 * Works out which season/episodes of an anime series a release (or file name) contains.
 * Returns null when it clearly doesn't fit the series (e.g. episode numbers past the end).
 */
export function matchAnime(p: ParsedRelease, seasons: AnimeSeason[], fallbackSeason: number | null = null): AnimeMatch | null {
  if (!seasons.length) return null;
  p = asStandaloneSequel(p, seasons) ?? p;
  const explicit = p.season ?? (p.seasons.length === 1 ? p.seasons[0] : null);
  const nums = p.episodes.length ? p.episodes : p.absoluteEpisodes;

  if (nums.length) {
    // The containing release's season (fallback) beats a bare series name in the file name.
    const season = explicit ?? fallbackSeason ?? seasonFromTitle(p.title, seasons);
    if (season !== null) {
      const info = seasons.find((s) => s.season === season);
      if (info && nums.every((n) => n >= 1 && n <= info.episodes)) {
        return { seasons: [season], episodes: nums.map((n) => ({ season, episode: n })) };
      }
      // "Show S2 - 13" where S1 had 12 episodes: numbering continues across seasons.
      return fromAbsolute(nums, seasons);
    }
    const first = seasons[0];
    if (nums.every((n) => n >= 1 && n <= first.episodes)) {
      return { seasons: [first.season], episodes: nums.map((n) => ({ season: first.season, episode: n })) };
    }
    return fromAbsolute(nums, seasons);
  }

  // Whole-season batch.
  if (p.seasons.length > 1) return { seasons: p.seasons.filter((n) => seasons.some((s) => s.season === n)), episodes: null };
  if (explicit !== null) return seasons.some((s) => s.season === explicit) ? { seasons: [explicit], episodes: null } : null;
  // "Complete" packs with no season number cover the whole series.
  if (p.isComplete) {
    return { seasons: seasons.map((s) => s.season), episodes: null };
  }
  const byTitle = seasonFromTitle(p.title, seasons) ?? fallbackSeason ?? seasons[0].season;
  return { seasons: [byTitle], episodes: null };
}
