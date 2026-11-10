import { COMPLETE_SERIES, findSeasons, YEAR_SPAN } from './seasonSpec.js';

export type Resolution = '2160p' | '1080p' | '720p' | '480p';
export type Audio = 'sub' | 'dub' | 'dual';

export interface ParsedRelease {
  title: string;
  year: number | null;
  resolution: Resolution | null;
  source: string | null;
  group: string | null;
  /** Season for SxxEyy releases, or the single season of a pack. */
  season: number | null;
  /** All seasons covered by a season pack (empty when unknown or a complete series). */
  seasons: number[];
  /** "Complete Series" style release with no season numbers: covers every season. */
  isComplete: boolean;
  /** Episode numbers within `season` (SxxEyy style). */
  episodes: number[];
  /** Anime-style absolute episode numbers ("Title - 05", "Title 01-12"). */
  absoluteEpisodes: number[];
  isSeasonPack: boolean;
  /** Anime batch with no episode numbers at all ("[Group] Title [BD 1080p]"). */
  isBatch: boolean;
  audio: Audio;
  isCam: boolean;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|webm|mov|torrent)$/i;
const QUALITY_TOKEN =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|bd|web-?dl|web-?rip|web|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac|flac|ddp?5\.1|atmos|hdr|10bit|dual[\s-]?audio|multi[\s-]?audio|proper|repack|complete|batch|dubbed)\b/i;
const YEAR = /\b(19\d{2}|20\d{2})\b/g;

const DUAL = /\b(dual[\s._-]?audio|multi[\s._-]?audio|dual)\b/i;
const DUB = /\b(dub|dubbed|eng(?:lish)?[\s._-]?dub(?:bed)?)\b/i;
const CAM = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|hdtc|screener|scr)\b/i;

function range(a: number, b: number): number[] {
  if (b < a || b - a > 2000) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const isYear = (n: number) => n >= 1900 && n <= 2099;

export function parseRelease(raw: string): ParsedRelease {
  let s = raw.trim().replace(VIDEO_EXT, '');

  let group: string | null = null;
  const lead = s.match(/^\[([^\]]+)\]\s*/);
  if (lead) {
    group = lead[1];
    s = s.slice(lead[0].length);
  } else {
    const trail = s.match(/-([A-Za-z0-9]+)$/);
    if (trail && !/^\d+$/.test(trail[1])) group = trail[1];
  }

  // Spaces instead of dots/underscores, but keep things like "5.1" and "H.264" intact enough.
  const spaced = s.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  const resMatch = spaced.match(/\b(2160|1080|720|576|480)p\b/i);
  let resolution: Resolution | null = null;
  if (resMatch) {
    const n = Number(resMatch[1]);
    resolution = n === 2160 ? '2160p' : n === 1080 ? '1080p' : n === 720 ? '720p' : '480p';
  } else if (/\b(4k|uhd)\b/i.test(spaced)) resolution = '2160p';

  let source: string | null = null;
  if (/\bremux\b/i.test(spaced)) source = 'remux';
  else if (/\b(bluray|blu-ray|bdrip|brrip|bd)\b/i.test(spaced)) source = 'bluray';
  else if (/\bweb-?dl\b/i.test(spaced)) source = 'webdl';
  else if (/\bweb-?rip\b/i.test(spaced) || /\bweb\b/i.test(spaced)) source = 'webrip';
  else if (/\bhdtv\b/i.test(spaced)) source = 'hdtv';
  else if (/\bdvd(rip)?\b/i.test(spaced)) source = 'dvd';

  const audio: Audio = DUAL.test(spaced) ? 'dual' : DUB.test(spaced) ? 'dub' : 'sub';
  const isCam = CAM.test(spaced.replace(/\[[^\]]*\]/g, ' ')) && !/\b(web|bluray|hdtv)\b/i.test(spaced);

  let season: number | null = null;
  let seasons: number[] = [];
  let episodes: number[] = [];
  let absoluteEpisodes: number[] = [];
  let isSeasonPack = false;
  let isComplete = false;
  let cutAt = spaced.length;
  let seasonText = '';

  // "S01E01-S03E10": a span across seasons is a multi-season bundle; within one season, an episode range.
  const span = spaced.match(/\bS(\d{1,2})E(\d{1,4})\s?(?:-|~|to)\s?S(\d{1,2})E(\d{1,4})\b/i);
  const sxe = span ? null : spaced.match(/\bS(\d{1,2})\s?E(\d{1,4})(?:(?:\s?-\s?E?|E)(\d{1,4}))?\b/i);
  const xFmt = !sxe ? spaced.match(/\b(\d{1,2})x(\d{2,3})\b/) : null;
  if (span && Number(span[1]) !== Number(span[3])) {
    isSeasonPack = true;
    seasons = range(Number(span[1]), Number(span[3]));
    cutAt = Math.min(cutAt, span.index!);
    seasonText = span[0];
  } else if (span) {
    season = Number(span[1]);
    episodes = range(Number(span[2]), Number(span[4]));
    cutAt = Math.min(cutAt, span.index!);
  } else if (sxe) {
    season = Number(sxe[1]);
    const a = Number(sxe[2]);
    const b = sxe[3] ? Number(sxe[3]) : a;
    episodes = b - a <= 50 ? range(a, b) : [a];
    cutAt = Math.min(cutAt, sxe.index!);
  } else if (xFmt) {
    season = Number(xFmt[1]);
    episodes = [Number(xFmt[2])];
    cutAt = Math.min(cutAt, xFmt.index!);
  } else {
    const found = findSeasons(spaced);
    if (found) {
      isSeasonPack = true;
      seasons = found.seasons;
      season = seasons.length === 1 ? seasons[0] : null;
      cutAt = Math.min(cutAt, found.index);
      seasonText = found.text;
    } else if ((COMPLETE_SERIES.test(spaced) || YEAR_SPAN.test(spaced)) && !/\b(movie|film)s?\b/i.test(spaced)) {
      isSeasonPack = true;
      isComplete = true;
      const idx = spaced.search(COMPLETE_SERIES);
      if (idx > 0) cutAt = Math.min(cutAt, idx);
    }
  }

  // Anime absolute numbering only applies when there is no SxxEyy.
  if (!sxe && !xFmt && !span) {
    // Season markers ("Seasons 1-3") must not be read as episode numbers.
    const noBrackets = (seasonText ? spaced.replace(seasonText, ' ') : spaced).replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    const q = noBrackets.search(QUALITY_TOKEN);
    const core = (q >= 0 ? noBrackets.slice(0, q) : noBrackets).trim();

    const rangeM = core.match(/(?:^|\s)(?:-\s)?(?:E|EP)?(\d{1,4})\s?(?:-|~|to)\s?(?:E|EP)?(\d{1,4})(?:v\d)?(?:\s|$)/i);
    const dashM = core.match(/\s-\s(?:E|EP|Episode\s?)?(\d{1,4})(?:v\d)?(?:\s|$)/i);
    const epWord = core.match(/\b(?:E|EP|Episode)\s?(\d{1,4})(?:v\d)?\b/i);
    const trailing = core.match(/\s(\d{1,4})(?:v\d)?$/);

    const cutTo = (fragment: string) => {
      const idx = spaced.indexOf(fragment.trim());
      if (idx >= 0) cutAt = Math.min(cutAt, idx);
    };

    // "Title 2 - 06" is episode 6 of "Title 2", not episodes 2-6 (batches look like "01 - 12" or "1 - 12").
    const sequelDash = rangeM && /\s-\s/.test(rangeM[0]) && /^[1-9]$/.test(rangeM[1]) && rangeM[2].startsWith('0');
    if (rangeM && !sequelDash && !(isYear(Number(rangeM[1])) && isYear(Number(rangeM[2]))) && Number(rangeM[2]) > Number(rangeM[1])) {
      absoluteEpisodes = range(Number(rangeM[1]), Number(rangeM[2]));
      cutTo(rangeM[0]);
    } else if (dashM) {
      absoluteEpisodes = [Number(dashM[1])];
      cutTo(dashM[0]);
    } else if (epWord) {
      absoluteEpisodes = [Number(epWord[1])];
      cutTo(epWord[0]);
    } else if (trailing && !isYear(Number(trailing[1])) && !isSeasonPack && core.split(' ').length > 1) {
      absoluteEpisodes = [Number(trailing[1])];
      cutTo(trailing[0]);
    }

    // "Title S2 - 05" / "Title 2nd Season - 05": a single episode of that season, not a pack.
    if (isSeasonPack && season !== null && seasons.length === 1 && absoluteEpisodes.length === 1) {
      isSeasonPack = false;
      episodes = [...absoluteEpisodes];
    }
  }

  // Year: the last year-looking token before quality info, but not at the very start (e.g. "1917").
  const qIdx = spaced.search(QUALITY_TOKEN);
  const limit = qIdx >= 0 ? qIdx : spaced.length;
  let year: number | null = null;
  let yearIdx = -1;
  for (const m of spaced.matchAll(YEAR)) {
    if (m.index! === 0 || m.index! > limit) continue;
    year = Number(m[1]);
    yearIdx = m.index!;
  }
  if (yearIdx > 0) cutAt = Math.min(cutAt, yearIdx);

  const firstBracket = spaced.search(/[[({]/);
  if (firstBracket > 0) cutAt = Math.min(cutAt, firstBracket);
  if (qIdx > 0) cutAt = Math.min(cutAt, qIdx);

  let title = spaced
    .slice(0, Math.max(0, cutAt))
    .replace(/\s-\s*$/, '')
    .replace(/[\s\-–:]+$/, '')
    .trim();

  // Everything in brackets: "【Group】★New★[Chinese / Japanese / English Title][08][1080p]".
  if (!/[a-z]{2}/i.test(title)) {
    const parts = [...spaced.matchAll(/[[【]([^\]】]+)[\]】]/g)].map((m) => m[1].trim());
    const named = parts.find((x) => x !== group && /[a-z]{3}/i.test(x) && !QUALITY_TOKEN.test(x));
    if (named) {
      title = named;
      const ep = parts.find((x) => /^\d{1,4}(?:v\d)?$/i.test(x) && !isYear(parseInt(x, 10)));
      if (ep && season === null && !episodes.length && !absoluteEpisodes.length) absoluteEpisodes = [parseInt(ep, 10)];
    }
  }

  const isBatch =
    absoluteEpisodes.length === 0 &&
    episodes.length === 0 &&
    (isSeasonPack || /\b(batch|complete|bd|bluray)\b/i.test(spaced) || !!lead);

  return {
    title,
    year,
    resolution,
    source,
    group,
    season,
    seasons,
    episodes,
    absoluteEpisodes,
    isSeasonPack,
    isComplete,
    isBatch: isBatch || absoluteEpisodes.length > 1,
    audio,
    isCam,
  };
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORD_NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, second: 2, third: 3, fourth: 4, fifth: 5 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : (ROMAN[s] ?? WORD_NUM[s] ?? null));

/** The sequel number a normalized title tail means ("2", "ii", "season2", "2ndseason", "parttwo"), or null. */
function sequelNumber(tail: string): number | null {
  const m =
    tail.match(/^(\d{1,2}|ii|iii|iv|v|vi|vii|viii|ix|x)$/) ??
    tail.match(/^season(\d{1,2})$/) ??
    tail.match(/^(\d{1,2})(?:st|nd|rd|th)season$/) ??
    tail.match(/^(second|third|fourth|fifth)season$/) ??
    tail.match(/^(?:part|cour)(\d{1,2}|ii|iii|two|three)$/);
  const n = m ? num(m[1]) : null;
  return n && n >= 2 ? n : null;
}

const SEQUEL_TAIL =
  /(?:^|[^a-z0-9])((?:season|part|cour)\s*(?:\d{1,2}|ii|iii|two|three)|\d{1,2}(?:st|nd|rd|th)\s+season|(?:second|third|fourth|fifth)\s+season|\d{1,2}|ii|iii|iv|v|vi|vii|viii|ix|x)\s*$/i;

/** The normalized sequel ending of a title ("Cyberpunk: Edgerunners 2" -> "2"), or null if it has none. */
function sequelTail(title: string): string | null {
  const m = title.match(SEQUEL_TAIL);
  const tail = m ? normalizeTitle(m[1]) : null;
  return tail && sequelNumber(tail) !== null ? tail : null;
}

/** "Cyberpunk: Edgerunners 2" -> { base: "Cyberpunk: Edgerunners", n: 2 }; null when the title isn't numbered. */
export function splitSequel(title: string): { base: string; n: number } | null {
  const m = title.match(SEQUEL_TAIL);
  const n = m ? sequelNumber(normalizeTitle(m[1])) : null;
  if (!m || n === null) return null;
  const base = title.slice(0, m.index).replace(/[\s:–-]+$/, '').trim();
  return normalizeTitle(base).length >= 3 ? { base, n } : null;
}

/**
 * Loose match between a parsed release title and any of the media's known titles.
 * A sequel number makes it a different title: "Cyberpunk Edgerunners" is not "Cyberpunk Edgerunners 2".
 * A release name that adds a number ("Mob Psycho 100 II") still matches while that number is one of
 * the series' own seasons (`maxSeason`); without `maxSeason` that case isn't checked.
 */
export function titleMatches(releaseTitle: string, candidates: string[], maxSeason?: number): boolean {
  const p = normalizeTitle(releaseTitle);
  if (!p) return false;
  for (const c of candidates) {
    const n = normalizeTitle(c);
    if (!n) continue;
    if (p === n) return true;
    const [short, long] = p.length < n.length ? [p, n] : [n, p];
    if (short.length < 5 || !long.includes(short)) continue;
    // A sequel's releases carry its number: "[Group] Cyberpunk S01 - Edgerunners" is not "Cyberpunk: Edgerunners 2".
    const tail = sequelTail(c);
    if (tail && !p.endsWith(tail)) continue;
    const sequel = long.startsWith(short) ? sequelNumber(long.slice(short.length)) : null;
    if (sequel !== null) {
      if (long === n) continue; // the media is the sequel, the release isn't
      if (maxSeason !== undefined && sequel > maxSeason) continue; // the release is a sequel the media doesn't have
    }
    return true;
  }
  return false;
}
