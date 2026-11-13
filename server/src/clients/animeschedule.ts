import { fetchJson, HttpError } from './http.js';

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

// AnimeSchedule allows only a few requests a second: they go out one at a time, a little apart,
// and a 'too many requests' answer is retried once after a short wait.
const GAP_MS = 350;
let queue: Promise<unknown> = Promise.resolve();
let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function paced<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      return await task();
    } catch (err) {
      if ((err as HttpError).status !== 429) throw err;
      await sleep(3000);
      last = Date.now();
      return task();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
const getJson = <T>(url: string) => paced(() => fetchJson<T>(url, { headers: { accept: 'application/json', 'user-agent': 'Mediarr (self-hosted media manager)' } }));
async function getHtml(url: string): Promise<string | null> {
  return paced(async () => {
    const res = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'Mediarr (self-hosted media manager)' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) throw new HttpError('429 Too Many Requests', 429);
    return res.ok ? res.text() : null;
  });
}
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


/** The dub schedule for an AniList entry, or null when AnimeSchedule doesn't know the title. */
export async function dubScheduleFor(anilistId: number): Promise<DubSchedule | null> {
  const r = await getJson<{ anime?: Record<string, unknown>[] }>(`${BASE}/api/v3/anime?anilist-ids=${anilistId}`);
  const a = r.anime?.[0];
  if (!a) return null;
  const d = parseDubSchedule(a);
  // Still being dubbed: which episode is next (the page shows it; the API doesn't).
  if (d.dubExists && d.status !== 'Finished' && typeof a.route === 'string' && a.route) {
    try {
      const html = await getHtml(`${BASE}/anime/${encodeURIComponent(a.route)}`);
      if (html) d.dubNext = parseDubNext(html);
    } catch {
      // the estimate from the start date still works
    }
  }
  return d;
}

// ---- Which anime have an English dub (for Discover's Dubbed / Sub only filter) ----

const dubCache = new Map<number, { at: number; dub: boolean | null }>();
const DUB_TTL_MS = 24 * 3600_000;
/** AnimeSchedule returns this many per page. */
const AS_PAGE = 18;

/** Letters and digits only, lower case: "Re:Zero" and "re zero" compare equal. */
export const sameName = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

export interface DubCandidate {
  anilistId: number;
  /** Official titles (romaji, English, native). */
  names: string[];
  /** Other names; only used when the official ones don't match (they're often shared, e.g. "Gintama"). */
  aliases?: string[];
  year: number | null;
  episodes: number | null;
}

/**
 * Matches AnimeSchedule entries back to the AniList titles they were asked for (their list answers
 * don't include the AniList id): by official title, then by other names, then by year + episode count
 * when that's unique.
 */
export function matchDubs(asked: DubCandidate[], found: Record<string, unknown>[]): { dub: Map<number, boolean>; unmatched: number } {
  const dub = new Map<number, boolean>();
  const namesOf = (a: Record<string, unknown>, withAliases: boolean) => {
    const n = a.names as Record<string, unknown> | undefined;
    return new Set(
      [a.title, a.preferredTitle, n?.romaji, n?.english, n?.native, ...(withAliases ? ((n?.synonyms as unknown[]) ?? []) : [])]
        .filter((x): x is string => typeof x === 'string')
        .map(sameName)
        .filter(Boolean),
    );
  };
  let left = found;
  for (const withAliases of [false, true]) {
    const next: Record<string, unknown>[] = [];
    for (const a of left) {
      const theirs = namesOf(a, withAliases);
      const ours = (c: DubCandidate) => (withAliases ? [...c.names, ...(c.aliases ?? [])] : c.names);
      const hit = asked.find((c) => !dub.has(c.anilistId) && ours(c).some((n) => theirs.has(sameName(n))));
      if (hit) dub.set(hit.anilistId, !!a.dubExists);
      else next.push(a);
    }
    left = next;
  }
  let unmatched = 0;
  for (const a of left) {
    const fits = asked.filter((c) => !dub.has(c.anilistId) && c.year !== null && c.year === a.year && c.episodes !== null && c.episodes === a.episodes);
    if (fits.length === 1) dub.set(fits[0].anilistId, !!a.dubExists);
    else unmatched++;
  }
  return { dub, unmatched };
}

async function asList(query: string): Promise<{ anime: Record<string, unknown>[]; total: number }> {
  try {
    const r = await getJson<{ anime?: Record<string, unknown>[]; totalAmount?: number }>(`${BASE}/api/v3/anime?${query}`);
    return { anime: r.anime ?? [], total: r.totalAmount ?? 0 };
  } catch (err) {
    // "Couldn't find anime with these parameters." comes back as a 404.
    if ((err as { status?: number }).status === 404) return { anime: [], total: 0 };
    throw err;
  }
}

/**
 * For each AniList title: true (has an English dub), false (no dub), or null (AnimeSchedule doesn't
 * know it). Asked in one batch (a few pages), remembered for a day.
 */
export async function dubbedAmong(titles: DubCandidate[]): Promise<Map<number, boolean | null>> {
  const out = new Map<number, boolean | null>();
  const todo: DubCandidate[] = [];
  for (const t of titles) {
    const hit = dubCache.get(t.anilistId);
    if (hit && Date.now() - hit.at < DUB_TTL_MS) out.set(t.anilistId, hit.dub);
    else todo.push(t);
  }
  if (!todo.length) return out;
  const ids = todo.map((t) => `anilist-ids=${t.anilistId}`).join('&');
  const found: Record<string, unknown>[] = [];
  for (let page = 1; page <= Math.ceil(todo.length / AS_PAGE) + 1; page++) {
    const r = await asList(`mt=any&${ids}&page=${page}`);
    found.push(...r.anime);
    if (!r.anime.length || found.length >= r.total) break;
  }
  const { dub, unmatched } = matchDubs(todo, found);
  // A few couldn't be matched by name: ask about those one at a time.
  const unresolved = todo.filter((t) => !dub.has(t.anilistId));
  if (unmatched > 0 && unresolved.length <= 2) {
    for (const t of unresolved) {
      const r = await asList(`anilist-ids=${t.anilistId}`);
      if (r.anime[0]) dub.set(t.anilistId, !!r.anime[0].dubExists);
    }
  }
  for (const t of todo) {
    const d = dub.has(t.anilistId) ? dub.get(t.anilistId)! : null;
    out.set(t.anilistId, d);
    dubCache.set(t.anilistId, { at: Date.now(), dub: d });
  }
  if (dubCache.size > 5000) for (const k of [...dubCache.keys()].slice(0, 1000)) dubCache.delete(k);
  return out;
}
