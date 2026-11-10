import type { ProwlarrRelease } from '../clients/prowlarr.js';
import type { AnimeAudio, MediaType } from '../db.js';
import type { Settings } from '../settings.js';
import { asStandaloneSequel, matchAnime, type AnimeSeason } from './animeMatch.js';
import { parseRelease, titleMatches, type ParsedRelease } from './releaseParser.js';

export type SearchScope =
  | { kind: 'movie' }
  | { kind: 'episode'; season: number; episode: number }
  | { kind: 'season'; season: number; episodes: number[] };

export interface ScoreContext {
  type: MediaType;
  titles: string[];
  year: number | null;
  animeAudio: AnimeAudio | null;
  scope: SearchScope;
  settings: Settings;
  /** Anime only: the series' seasons, for season-aware matching. */
  animeSeasons?: AnimeSeason[];
  /** Shows: episodes per season (season 0 excluded), to size and label multi-season bundles. */
  seasonEpisodeCounts?: Record<number, number>;
}

/** exact = just what was asked for; bundle = that plus other seasons (only grabbed after the user agrees). */
export type Coverage = 'exact' | 'bundle';

export interface ScoredRelease extends ProwlarrRelease {
  parsed: ParsedRelease;
  score: number;
  rejections: string[];
  coverage: Coverage | null;
  /** Seasons a pack/bundle contains. */
  covers: number[];
}

const LADDER = ['480p', '720p', '1080p', '2160p'];
const GB = 1024 ** 3;

interface ScopeResult {
  error: string | null;
  coverage: Coverage | null;
  covers: number[];
}

function seasonCounts(ctx: ScoreContext): Record<number, number> {
  if (ctx.animeSeasons) return Object.fromEntries(ctx.animeSeasons.map((s) => [s.season, s.episodes]));
  return ctx.seasonEpisodeCounts ?? {};
}

export function coverageLabel(covers: number[], known: number[]): string {
  const real = covers.filter((s) => s > 0);
  if (known.length > 1 && known.filter((s) => s > 0).every((s) => real.includes(s))) return 'Complete series';
  if (!real.length) return 'Bundle';
  const contiguous = real.every((s, i) => i === 0 || s === real[i - 1] + 1);
  return contiguous && real.length > 1 ? `S${real[0]}–S${real[real.length - 1]}` : real.map((s) => `S${s}`).join(' + ');
}

function checkScope(p: ParsedRelease, ctx: ScoreContext): ScopeResult {
  const { scope, type } = ctx;
  const ok = (coverage: Coverage, covers: number[] = []): ScopeResult => ({ error: null, coverage, covers });
  const fail = (error: string, covers: number[] = []): ScopeResult => ({ error, coverage: null, covers });

  if (scope.kind === 'movie') {
    if (p.episodes.length || p.isSeasonPack) return fail('Looks like a TV release');
    if (ctx.year && p.year && Math.abs(p.year - ctx.year) > 1) return fail(`Wrong year (${p.year})`);
    return ok('exact');
  }

  if (scope.kind === 'episode') {
    if (type === 'anime') {
      const m = ctx.animeSeasons && matchAnime(p, ctx.animeSeasons);
      const hit = m?.episodes?.length === 1 && m.episodes[0].season === scope.season && m.episodes[0].episode === scope.episode;
      return hit ? ok('exact', [scope.season]) : fail(m && !m.episodes?.length ? 'Batch, not a single episode' : 'Wrong episode');
    }
    if (p.season === scope.season && p.episodes.includes(scope.episode)) return ok('exact', [scope.season]);
    return fail('Wrong episode');
  }

  // Season search: packs for just this season are exact; packs that also hold other seasons are bundles.
  const known = Object.keys(seasonCounts(ctx)).map(Number).filter((s) => s > 0);
  let covers: number[];
  if (type === 'anime') {
    const m = ctx.animeSeasons && matchAnime(p, ctx.animeSeasons);
    if (!m) return fail('Wrong season');
    if (m.episodes !== null) {
      // Episode ranges ("01-48") must hold every wanted episode of this season.
      const got = new Set(m.episodes.filter((e) => e.season === scope.season).map((e) => e.episode));
      if (!m.seasons.includes(scope.season)) return fail(`Wrong season (S${m.seasons.join(', S')})`, m.seasons);
      if (!scope.episodes.every((e) => got.has(e))) return fail('Not a full batch', m.seasons);
    }
    covers = m.seasons;
  } else {
    if (!p.isSeasonPack) return fail('Not a season pack');
    covers = p.isComplete ? known : p.seasons;
  }
  if (!covers.includes(scope.season)) return fail(covers.length ? `Wrong season (S${covers.join(', S')})` : 'Wrong season', covers);
  const others = covers.filter((s) => s !== scope.season && (known.length === 0 || known.includes(s)));
  return ok(others.length ? 'bundle' : 'exact', covers);
}

const MOVIE_WORDS = /\b(movie|film|gekijouban|gekijoban)\b/i;
const EXTRA_WORDS = /\b(ova|oad|ovas|recap|compilation)\b/i;

/**
 * Series searches must not pick up a franchise's movies or OVAs, which share the series name
 * but have no season/episode numbers ("Slime the Movie - Tears of the Azure Sea").
 */
function notSeriesRejection(title: string, p: ParsedRelease, ctx: ScoreContext): string | null {
  if (ctx.scope.kind === 'movie') return null;
  const ownTitles = ctx.titles.join(' ');
  const movie = title.match(MOVIE_WORDS);
  if (movie && !MOVIE_WORDS.test(ownTitles)) return 'Movie, not a series release';
  const hasNumbers = p.season !== null || p.seasons.length > 0 || p.episodes.length > 0 || p.absoluteEpisodes.length > 0;
  // "Season 1 + OVA" packs are fine; a bare OVA release is not.
  if (!hasNumbers && EXTRA_WORDS.test(title) && !EXTRA_WORDS.test(ownTitles)) return 'OVA/special, not a series release';
  return null;
}

/** Highest season the media has (a movie counts as one), so a "Title 2" release can be told apart from the media. */
function maxSeason(ctx: ScoreContext): number | undefined {
  if (ctx.type === 'movie') return 1;
  if (ctx.animeSeasons?.length) return Math.max(...ctx.animeSeasons.map((s) => s.season));
  const counts = Object.keys(ctx.seasonEpisodeCounts ?? {}).map(Number);
  return counts.length ? Math.max(...counts) : undefined;
}

export function scoreRelease(r: ProwlarrRelease, ctx: ScoreContext): ScoredRelease {
  const p = parseRelease(r.title);
  const s = ctx.settings;
  const rejections: string[] = [];

  const titleOk =
    titleMatches(p.title, ctx.titles, maxSeason(ctx)) || (!!ctx.animeSeasons && asStandaloneSequel(p, ctx.animeSeasons) !== null);
  if (!titleOk) rejections.push(`Title mismatch ("${p.title}")`);
  const scope = checkScope(p, ctx);
  if (scope.error) rejections.push(scope.error);
  const notSeries = notSeriesRejection(r.title, p, ctx);
  if (notSeries) rejections.push(notSeries);
  if ((r.seeders ?? 0) < s.minSeeders) rejections.push(`Only ${r.seeders ?? 0} seeders`);
  if (p.isCam) rejections.push('CAM/TS quality');
  if (p.resolution === '2160p' && !s.allow4k) rejections.push('4K not allowed');

  // Size limit scales with how many episodes the release holds (whole bundles included).
  const counts = seasonCounts(ctx);
  const bundleEps = scope.coverage === 'bundle' ? scope.covers.reduce((n, x) => n + (counts[x] ?? 0), 0) : 0;
  const epCount = ctx.scope.kind === 'season' ? Math.max(1, ctx.scope.episodes.length, bundleEps) : 1;
  const maxBytes = (ctx.scope.kind === 'movie' ? s.maxMovieSizeGb : s.maxEpisodeSizeGb * epCount) * GB;
  if (r.size && maxBytes > 0 && r.size > maxBytes) rejections.push(`Too big (${(r.size / GB).toFixed(1)} GB)`);

  if (ctx.type === 'anime' && ctx.animeAudio) {
    if (ctx.animeAudio === 'dub' && p.audio === 'sub') rejections.push('Not dubbed');
    if (ctx.animeAudio === 'sub' && p.audio === 'dub') rejections.push('Dub only');
  }

  let score = 0;
  if (p.resolution) {
    const dist = Math.abs(LADDER.indexOf(p.resolution) - LADDER.indexOf(s.preferredResolution));
    score += 100 - dist * 30;
  } else score += 20;
  score += Math.min(40, Math.round(Math.log2((r.seeders ?? 0) + 1) * 4));
  if (p.source === 'bluray' || p.source === 'webdl') score += 15;
  else if (p.source === 'webrip') score += 10;
  else if (p.source === 'hdtv') score += 5;
  else if (p.source === 'remux') score -= 10;
  if (ctx.type === 'anime' && ctx.animeAudio === 'dub') score += p.audio === 'dub' ? 15 : p.audio === 'dual' ? 10 : 0;
  if (ctx.type === 'anime' && ctx.animeAudio === 'sub') score += p.audio === 'sub' ? 15 : 5;

  return { ...r, parsed: p, score, rejections, coverage: scope.coverage, covers: scope.covers };
}

export function rankReleases(releases: ProwlarrRelease[], ctx: ScoreContext): ScoredRelease[] {
  const seen = new Set<string>();
  const scored: ScoredRelease[] = [];
  for (const r of releases) {
    const key = r.infoHash?.toLowerCase() || `${r.title}|${r.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push(scoreRelease(r, ctx));
  }
  return scored.sort(
    (a, b) =>
      Number(a.rejections.length > 0) - Number(b.rejections.length > 0) ||
      b.score - a.score ||
      (b.seeders ?? 0) - (a.seeders ?? 0),
  );
}
