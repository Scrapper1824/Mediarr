import { fetchJson } from './http.js';

/**
 * AnimeSchedule.net: whether an anime has an English dub, and when the dub started / starts.
 * Public endpoint, no key. Their terms ask for a visible credit, which the pages show next to the dub info.
 */

export interface DubSchedule {
  /** An English dub exists or is announced. */
  dubExists: boolean;
  subExists: boolean;
  /** First dubbed episode (ISO), null when unknown. */
  dubPremier: string | null;
  /** A current/past pause in the dub. */
  dubDelayedFrom: string | null;
  dubDelayedUntil: string | null;
  /** One-off days when several dubbed episodes came out together. */
  dubBatches: { date: string; extra: number }[];
  episodes: number | null;
  status: string | null;
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
    dubPremier: realDate(a.dubPremier),
    dubDelayedFrom: realDate(a.dubDelayedFrom),
    dubDelayedUntil: realDate(a.dubDelayedUntil),
    dubBatches: overrides
      .filter((o) => realDate(o.overrideDate) && (o.episodesAired ?? 0) > 0)
      .map((o) => ({ date: o.overrideDate!, extra: o.episodesAired! })),
    episodes: typeof a.episodes === 'number' && a.episodes > 0 ? a.episodes : null,
    status: typeof a.status === 'string' ? a.status : null,
    url: `${BASE}/anime/${typeof a.route === 'string' ? a.route : ''}`,
  };
}

/** The dub schedule for an AniList entry, or null when AnimeSchedule doesn't know the title. */
export async function dubScheduleFor(anilistId: number): Promise<DubSchedule | null> {
  const r = await fetchJson<{ anime?: Record<string, unknown>[] }>(`${BASE}/api/v3/anime?anilist-ids=${anilistId}`, {
    headers: { accept: 'application/json', 'user-agent': 'Mediarr (self-hosted media manager)' },
  });
  const a = r.anime?.[0];
  return a ? parseDubSchedule(a) : null;
}
