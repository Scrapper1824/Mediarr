import { fetchJson } from './http.js';

/**
 * Kitsu: episode titles, summaries and stills for anime (AniList has none per episode).
 * Free, no key; found by AniList id. Kitsu only answers clients asking for its JSON:API format.
 */

const BASE = 'https://kitsu.app/api/edge';
const HEADERS = { accept: 'application/vnd.api+json', 'user-agent': 'Mediarr (self-hosted media manager)' };

export interface KitsuEpisode {
  number: number;
  title: string | null;
  synopsis: string | null;
  still: string | null;
  airDate: string | null;
}

/** Kitsu's own "Episode 3" placeholder titles carry no information. */
const realTitle = (t: unknown): string | null => (typeof t === 'string' && t.trim() && !/^episode\s*\d+$/i.test(t.trim()) ? t.trim() : null);

export function parseKitsuEpisode(attrs: Record<string, any>): KitsuEpisode | null {
  const number = Number(attrs.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const synopsis = typeof attrs.synopsis === 'string' && attrs.synopsis.trim() ? attrs.synopsis.trim() : null;
  return {
    number,
    title: realTitle(attrs.canonicalTitle) ?? realTitle(attrs.titles?.en_us) ?? realTitle(attrs.titles?.en),
    synopsis,
    still: attrs.thumbnail?.original ?? null,
    airDate: typeof attrs.airdate === 'string' ? attrs.airdate : null,
  };
}

/** The Kitsu anime for an AniList entry, or null when Kitsu doesn't know it. */
async function kitsuIdFor(anilistId: number): Promise<string | null> {
  const q = new URLSearchParams({ 'filter[externalSite]': 'anilist/anime', 'filter[externalId]': String(anilistId), include: 'item' });
  const r = await fetchJson<{ included?: { type: string; id: string }[] }>(`${BASE}/mappings?${q}`, { headers: HEADERS });
  return r.included?.find((i) => i.type === 'anime')?.id ?? null;
}

const PAGE = 20;
/** Long runners are capped; their newest episodes come first in any case. */
const MAX_PAGES = 60;

/** Every episode Kitsu has for an AniList entry, in order. */
export async function kitsuEpisodes(anilistId: number): Promise<KitsuEpisode[]> {
  const id = await kitsuIdFor(anilistId);
  if (!id) return [];
  const out: KitsuEpisode[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      'page[limit]': String(PAGE),
      'page[offset]': String(page * PAGE),
      sort: 'number',
      'fields[episodes]': 'number,canonicalTitle,titles,synopsis,airdate,thumbnail',
    });
    const r = await fetchJson<{ data?: { attributes: Record<string, any> }[]; links?: { next?: string } }>(`${BASE}/anime/${id}/episodes?${q}`, { headers: HEADERS });
    for (const d of r.data ?? []) {
      const e = parseKitsuEpisode(d.attributes);
      if (e) out.push(e);
    }
    if (!r.links?.next || !r.data?.length) break;
  }
  return out;
}
