import { HttpError } from './http.js';

/**
 * TheIntroDB (theintrodb.org): community-submitted intro and credits times for TV episodes and movies,
 * by TMDB id. Public; without a key it allows 25 requests per 10 seconds and a daily allowance.
 */

export interface IntroDbTimes {
  intro?: { start: number; end: number };
  credits?: { start: number; end: number };
}

interface Range {
  start_ms: number | null;
  end_ms: number | null;
}

const BASE = 'https://api.theintrodb.org/v4/media';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => performance.now();

// Requests go out one after another, ~2.3 a second (under their 25 per 10 s). When they say the day's
// allowance is used up, nothing more is sent until they say so.
const GAP_MS = 450;
let nextStart = 0;
let blockedUntil = 0;

async function takeTurn() {
  const start = Math.max(tick(), nextStart);
  nextStart = start + GAP_MS;
  if (start > tick()) await sleep(start - tick());
}

export class IntroDbBusy extends Error {}

/** A section from their answer: no start means from the beginning, no end means to the end of the file. */
function toSegment(r: Range | undefined, duration: number): { start: number; end: number } | undefined {
  if (!r) return undefined;
  const start = (r.start_ms ?? 0) / 1000;
  const end = r.end_ms !== null ? r.end_ms / 1000 : duration;
  if (!(end > start) || end - start < 5 || (duration && start >= duration)) return undefined;
  return { start, end: duration ? Math.min(end, duration) : end };
}

export function parseIntroDb(body: { intro?: Range[]; credits?: Range[] }, duration: number): IntroDbTimes {
  const out: IntroDbTimes = {};
  const intro = toSegment(body.intro?.[0], duration);
  const credits = toSegment(body.credits?.[0], duration);
  if (intro) out.intro = intro;
  if (credits) out.credits = credits;
  return out;
}

/**
 * Times for a TV episode (season + episode, TMDB numbering) or a movie. The file's length lets them pick
 * the times submitted for that release. Empty when they have none; throws IntroDbBusy when their limit
 * is reached (try again later).
 */
export async function introDbTimes(q: { tmdbId: number; season?: number; episode?: number; duration: number }, retry = true): Promise<IntroDbTimes> {
  if (Date.now() < blockedUntil) throw new IntroDbBusy('TheIntroDB’s daily limit is used up; trying again later.');
  const url = new URL(BASE);
  url.searchParams.set('tmdb_id', String(q.tmdbId));
  if (q.season !== undefined && q.episode !== undefined) {
    url.searchParams.set('season', String(q.season));
    url.searchParams.set('episode', String(q.episode));
  }
  if (q.duration > 0) url.searchParams.set('duration_ms', String(Math.round(q.duration * 1000)));
  await takeTurn();
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mediarr (self-hosted media manager)' }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new HttpError(`Could not reach TheIntroDB: ${(err as Error).message}`);
  }
  if (res.status === 404 || res.status === 400) return {};
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after')) || 60;
    // Minutes or more: the day's allowance, not a burst.
    if (after > 300 || !retry) {
      blockedUntil = Date.now() + after * 1000;
      throw new IntroDbBusy('TheIntroDB’s limit is reached; trying again later.');
    }
    nextStart = Math.max(nextStart, tick() + after * 1000);
    return introDbTimes(q, false);
  }
  if (!res.ok) throw new HttpError(`TheIntroDB answered ${res.status}`, res.status);
  return parseIntroDb((await res.json()) as { intro?: Range[]; credits?: Range[] }, q.duration);
}
