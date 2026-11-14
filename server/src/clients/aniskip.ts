import { fetchJson } from './http.js';

/**
 * AniSkip (api.aniskip.com): community-submitted opening/ending times for anime episodes, by
 * MyAnimeList id and episode number. Public, no key.
 */

export interface SkipTimes {
  intro?: { start: number; end: number };
  credits?: { start: number; end: number };
  /** Length of the file the chosen times were measured on (seconds). */
  measuredOn?: number;
}

interface AniSkipResult {
  interval: { startTime: number; endTime: number };
  skipType: 'op' | 'ed' | 'mixed-op' | 'mixed-ed' | 'recap';
  episodeLength: number;
}

/** Times from a file this close in length line up with yours as they are (trailing frames differ a little). */
export const SAME_CUT_SECONDS = 15;

/**
 * The submissions closest in length to this file, one opening and one ending. `measuredOn` says how long
 * that file was: when it differs from yours by more than SAME_CUT_SECONDS your release is cut differently
 * and the times may be shifted (the caller then only trusts how long the opening/ending is).
 */
export function pickSkipTimes(results: AniSkipResult[], duration: number, maxDifference = 120): SkipTimes {
  const out: SkipTimes = {};
  const diff = (r: AniSkipResult) => (duration && r.episodeLength ? Math.abs(r.episodeLength - duration) : 0);
  const sorted = results.filter((r) => diff(r) <= maxDifference).sort((a, b) => diff(a) - diff(b));
  for (const r of sorted) {
    const seg = { start: Math.max(0, r.interval.startTime), end: Math.min(duration || Infinity, r.interval.endTime) };
    if (seg.end - seg.start < 5) continue;
    const kind = r.skipType === 'op' || r.skipType === 'mixed-op' ? 'intro' : r.skipType === 'ed' || r.skipType === 'mixed-ed' ? 'credits' : null;
    if (!kind || out[kind]) continue;
    out[kind] = seg;
    out.measuredOn ??= r.episodeLength || undefined;
  }
  return out;
}

/** Opening/ending times for one episode; empty when AniSkip has none. */
export async function aniSkipTimes(malId: number, episode: number, duration: number): Promise<SkipTimes> {
  const url = new URL(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}`);
  for (const t of ['op', 'ed', 'mixed-op', 'mixed-ed']) url.searchParams.append('types', t);
  // 0: every submission (the closest in length is picked here, so a slightly different release still gets times).
  url.searchParams.set('episodeLength', '0');
  try {
    const r = await fetchJson<{ found: boolean; results?: AniSkipResult[] }>(url.toString(), {
      headers: { accept: 'application/json', 'user-agent': 'Mediarr (self-hosted media manager)' },
    });
    return r.found && r.results ? pickSkipTimes(r.results, duration) : {};
  } catch (err) {
    // "Not found" comes back as a 404.
    if ((err as { status?: number }).status === 404) return {};
    throw err;
  }
}
