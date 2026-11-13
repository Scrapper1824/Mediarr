import { fetchJson } from './http.js';

/**
 * AnimeSchedule.net: whether an anime has an English dub, and when the dub started / starts.
 * Public endpoint, no key. Their terms ask for a visible credit, which the pages show next to the dub info.
 */

export interface DubSchedule {
  /** An English dub exists or is announced. */
  dubExists: boolean;
  subExists: boolean;
  /** The show's own first episode in Japan (ISO), null when unknown. */
  premier: string | null;
  /** First dubbed episode (ISO), null when unknown. */
  dubPremier: string | null;
  /** A current/past pause in the dub. */
  dubDelayedFrom: string | null;
  dubDelayedUntil: string | null;
  /** One-off days when several dubbed episodes came out together. */
  dubBatches: { date: string; extra: number }[];
  episodes: number | null;
  status: string | null;
  /** The next English-dubbed episode and when it comes out (from the title's page), null when not listed. */
  dubNext: { episode: number; at: string } | null;
  /** AnimeSchedule's page, for the credit link. */
  url: string;
}

const BASE = 'https://animeschedule.net';
/** Their "no date" value. */
const realDate = (s: unknown): string | null => (typeof s === 'string' && !s.startsWith('0001-') ? s : null);

interface Override {
  overrideDate?: string;
  episodesAired?: number;
}

export function parseDubSchedule(a: Record<string, unknown>): DubSchedule {
  const overrides = (Array.isArray(a.dubEpisodeOverrides) ? a.dubEpisodeOverrides : []) as Override[];
  return {
    dubExists: !!a.dubExists,
    subExists: !!a.subExists,
    premier: realDate(a.premier),
    dubPremier: realDate(a.dubPremier),
    dubDelayedFrom: realDate(a.dubDelayedFrom),
    dubDelayedUntil: realDate(a.dubDelayedUntil),
    dubBatches: overrides
      .filter((o) => realDate(o.overrideDate) && (o.episodesAired ?? 0) > 0)
      .map((o) => ({ date: o.overrideDate!, extra: o.episodesAired! })),
    episodes: typeof a.episodes === 'number' && a.episodes > 0 ? a.episodes : null,
    status: typeof a.status === 'string' ? a.status : null,
    dubNext: null,
    url: `${BASE}/anime/${typeof a.route === 'string' ? a.route : ''}`,
  };
}

/**
 * The next dubbed episode from a title's AnimeSchedule page ("Episode 1160 Dub: Tuesday 17 Nov").
 * Their API has the dub's start date but not which episode it's on, which matters for long runners
 * whose dub restarted years later (One Piece). Null when the page doesn't list one.
 */
export function parseDubNext(html: string): DubSchedule['dubNext'] {
  const m = /release-time-type-dub[^>]*>\s*<span class="release-time-episode-number">\s*Episode\s+(\d+)\s*<\/span>[\s\S]{0,600}?id="release-time-dub"[^>]*datetime="([^"]+)"/.exec(html);
  if (!m) return null;
  const episode = Number(m[1]);
  const at = new Date(m[2]);
  if (!Number.isInteger(episode) || episode <= 0 || Number.isNaN(at.getTime())) return null;
  return { episode, at: at.toISOString() };
}

const HEADERS = { 'user-agent': 'Mediarr (self-hosted media manager)' };

/** The dub schedule for an AniList entry, or null when AnimeSchedule doesn't know the title. */
export async function dubScheduleFor(anilistId: number): Promise<DubSchedule | null> {
  const r = await fetchJson<{ anime?: Record<string, unknown>[] }>(`${BASE}/api/v3/anime?anilist-ids=${anilistId}`, {
    headers: { accept: 'application/json', ...HEADERS },
  });
  const a = r.anime?.[0];
  if (!a) return null;
  const d = parseDubSchedule(a);
  // Still being dubbed: which episode is next (the page shows it; the API doesn't).
  if (d.dubExists && d.status !== 'Finished' && typeof a.route === 'string' && a.route) {
    try {
      const res = await fetch(`${BASE}/anime/${encodeURIComponent(a.route)}`, { headers: { accept: 'text/html', ...HEADERS }, signal: AbortSignal.timeout(20000) });
      if (res.ok) d.dubNext = parseDubNext(await res.text());
    } catch {
      // the estimate from the start date still works
    }
  }
  return d;
}
