import { kitsuEpisodes, type KitsuEpisode } from '../clients/kitsu.js';
import { db, getEpisodes, getMedia } from '../db.js';
import type { AnimeSeason } from './animeMatch.js';
import { animeSeasons } from './library.js';

/**
 * Anime episode titles, summaries and stills from Kitsu, matched to Mediarr's numbering: a season can
 * be several AniList entries (split cours), each numbered from 1 on Kitsu, so they follow on.
 */

export interface EpisodeDetail {
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  still: string | null;
}

/** Kitsu episodes for each entry of each season → Mediarr's season/episode numbers. */
export function matchKitsu(seasons: AnimeSeason[], byEntry: Map<number, KitsuEpisode[]>): EpisodeDetail[] {
  const out: EpisodeDetail[] = [];
  for (const s of seasons) {
    let offset = 0;
    for (const anilistId of s.anilistIds) {
      const eps = byEntry.get(anilistId) ?? [];
      if (!eps.length) continue;
      // Some entries are numbered on from the previous cour (13, 14…) instead of from 1.
      const first = Math.min(...eps.map((e) => e.number));
      for (const e of eps) {
        const episode = offset + (e.number - first + 1);
        if (episode > s.episodes) continue;
        out.push({ season: s.season, episode, title: e.title, overview: e.synopsis, still: e.still });
      }
      offset += Math.max(...eps.map((e) => e.number)) - first + 1;
    }
  }
  return out;
}

/** Saves details onto the episodes that exist; only fills in what Kitsu has (never blanks a field). */
export function saveEpisodeDetails(mediaId: number, details: EpisodeDetail[]): number {
  const rows = new Map(getEpisodes(mediaId).map((e) => [`${e.season}x${e.episode}`, e.id]));
  const upd = db.prepare('UPDATE episodes SET title = COALESCE(?, title), overview = COALESCE(?, overview), still = COALESCE(?, still) WHERE id = ?');
  let n = 0;
  for (const d of details) {
    const id = rows.get(`${d.season}x${d.episode}`);
    if (!id || (!d.title && !d.overview && !d.still)) continue;
    upd.run(d.title, d.overview, d.still, id);
    n++;
  }
  return n;
}

/** Fetches and saves Kitsu details for an anime in the library. Errors are swallowed (it's extra info). */
export async function fillAnimeEpisodeDetails(mediaId: number): Promise<number> {
  const m = getMedia(mediaId);
  if (!m || m.type !== 'anime') return 0;
  const seasons = animeSeasons(m);
  const byEntry = new Map<number, KitsuEpisode[]>();
  for (const id of seasons.flatMap((s) => s.anilistIds)) {
    byEntry.set(id, await kitsuEpisodes(id).catch(() => []));
  }
  return saveEpisodeDetails(mediaId, matchKitsu(seasons, byEntry));
}
