import { getSettings } from '../settings.js';
import { fetchJson, HttpError, trimSlash } from './http.js';

export interface ProwlarrRelease {
  guid: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
  indexerId: number;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  publishDate?: string;
  protocol: string;
}

export const CATEGORIES = {
  movie: [2000],
  show: [5000],
  anime: [5070, 5000],
} as const;

/**
 * Prowlarr categories to search for a title. 18+ releases are filed under XXX (6000), and some sites
 * put them in Other (8000), so those are searched too, but only for titles marked 18+.
 */
export function categoriesFor(m: { type: keyof typeof CATEGORIES; adult?: number | boolean | null }): number[] {
  return m.adult ? [...CATEGORIES[m.type], 6000, 8000] : [...CATEGORIES[m.type]];
}

export async function testProwlarr(url: string, apiKey: string) {
  const r = await fetchJson<{ version: string }>(`${trimSlash(url)}/api/v1/system/status`, {
    headers: { 'X-Api-Key': apiKey },
  });
  return r.version;
}

export async function searchProwlarr(query: string, categories: readonly number[]): Promise<ProwlarrRelease[]> {
  const s = getSettings();
  if (!s.prowlarrUrl || !s.prowlarrApiKey) throw new HttpError('Prowlarr URL/API key are not set (Settings).');
  const url = new URL(`${trimSlash(s.prowlarrUrl)}/api/v1/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('type', 'search');
  url.searchParams.set('limit', '100');
  for (const c of categories) url.searchParams.append('categories', String(c));
  const results = await fetchJson<ProwlarrRelease[]>(url.toString(), { headers: { 'X-Api-Key': s.prowlarrApiKey } }, 90000);
  return results.filter((r) => r.protocol === 'torrent');
}

/**
 * Resolves a release to something qBittorrent can take: a magnet link, or the .torrent bytes.
 * Prowlarr's download URL sometimes redirects to a magnet, which qBittorrent won't follow itself.
 */
export async function resolveTorrent(r: Pick<ProwlarrRelease, 'magnetUrl' | 'downloadUrl'>): Promise<
  { magnet: string } | { file: Uint8Array<ArrayBuffer> }
> {
  if (r.magnetUrl?.startsWith('magnet:')) return { magnet: r.magnetUrl };
  let url = r.downloadUrl ?? r.magnetUrl;
  if (!url) throw new Error('Release has no download link');
  for (let hop = 0; hop < 5; hop++) {
    if (url.startsWith('magnet:')) return { magnet: url };
    const res: Response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (res.status >= 300 && res.status < 400) {
      const loc: string | null = res.headers.get('location');
      if (!loc) throw new Error('Redirect without location');
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Torrent download failed: ${res.status} ${res.statusText}`);
    return { file: new Uint8Array(await res.arrayBuffer()) };
  }
  throw new Error('Too many redirects fetching torrent');
}
