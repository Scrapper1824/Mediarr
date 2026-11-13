import fs from 'node:fs';
import { animeBanner, getAnimeSeries, type AnimeSeries } from '../clients/anilist.js';
import { getMovie, getShow, getShowEpisodes } from '../clients/tmdb.js';
import { db, getEpisodes, getMedia, logHistory, now, type AnimeAudio, type MediaRow, type MediaType } from '../db.js';
import { getSettings, rootsFor } from '../settings.js';
import type { AnimeSeason } from './animeMatch.js';
import { folderName } from './naming.js';
import { chooseRoot } from './rootFolders.js';
import { fillAnimeEpisodeDetails } from './episodeDetails.js';

export interface AddMediaInput {
  type: MediaType;
  tmdbId?: number;
  anilistId?: number;
  /** Keep downloading new episodes/seasons as they air. The picked seasons are downloaded either way. */
  monitored?: boolean;
  /** Shows and anime: seasons to monitor. Defaults to every season except specials. */
  seasons?: number[];
  animeAudio?: AnimeAudio;
  /** Username of whoever asked for it, for History. */
  requestedBy?: string;
  /** Already on disk (library scan): use this folder as it is instead of choosing/naming one. */
  location?: { root: string; folder: string };
}

interface EpisodeInput {
  season: number;
  episode: number;
  absolute: number | null;
  title: string | null;
  airDate: string | null;
  overview?: string | null;
  still?: string | null;
}

const seasonNamesJson = (seasons: { season: number; name: string }[]) =>
  JSON.stringify(Object.fromEntries(seasons.filter((x) => x.name).map((x) => [x.season, x.name])));

const by = (input: AddMediaInput) =>
  input.location ? ` (found in ${input.location.root})` : input.requestedBy ? ` (requested by ${input.requestedBy})` : '';

/**
 * What a request from the web app may set when adding a title. Where it's stored is never taken from the
 * client (only the server's own library scan passes `location`), so nobody can point a title at any folder.
 */
export function requestedMedia(body: AddMediaInput): AddMediaInput {
  const { location: _ignored, requestedBy: _by, ...rest } = body ?? ({} as AddMediaInput);
  return rest as AddMediaInput;
}

export async function addMedia(input: AddMediaInput): Promise<number> {
  const s = getSettings();
  const rootFor = (folder: string) => input.location?.root ?? chooseRoot(s, input.type, folder)!;
  const nameFor = (folder: string) => input.location?.folder ?? folder;
  if (!rootsFor(s, input.type).length) throw new Error(`Set the ${input.type === 'movie' ? 'Movies' : input.type === 'show' ? 'Shows' : 'Anime'} folder in Settings first.`);
  const monitored = input.monitored ?? true;

  if (input.type !== 'anime') {
    const existing = db
      .prepare('SELECT id FROM media WHERE type = ? AND tmdb_id = ?')
      .get(input.type, input.tmdbId ?? -1) as { id: number } | undefined;
    if (existing) return existing.id;
  }

  const insert = db.prepare(`INSERT INTO media
    (type, tmdb_id, anilist_id, title, alt_titles, year, poster, overview, root_folder, folder_name, monitored, anime_audio, status, release_date, added_at, last_refresh, anime_seasons, backdrop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  if (input.type === 'movie') {
    const m = await getMovie(input.tmdbId!);
    const alt = m.originalTitle && m.originalTitle !== m.title ? [m.originalTitle] : [];
    const r = insert.run('movie', m.tmdbId, null, m.title, JSON.stringify(alt), m.year, m.poster, m.overview, rootFor(folderName('movie', m.title, m.year)),
      nameFor(folderName('movie', m.title, m.year)), monitored ? 1 : 0, null, m.status, m.releaseDate, now(), now(), null, m.backdrop ?? null);
    logHistory(Number(r.lastInsertRowid), 'added', `Added movie ${m.title}${by(input)}`);
    return Number(r.lastInsertRowid);
  }

  if (input.type === 'show') {
    const show = await getShow(input.tmdbId!);
    const alt = show.originalTitle && show.originalTitle !== show.title ? [show.originalTitle] : [];
    const r = insert.run('show', show.tmdbId, null, show.title, JSON.stringify(alt), show.year, show.poster, show.overview, rootFor(folderName('show', show.title, show.year)),
      nameFor(folderName('show', show.title, show.year)), monitored ? 1 : 0, null, show.status, null, now(), now(), null, show.backdrop ?? null);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE media SET season_names = ? WHERE id = ?').run(seasonNamesJson(show.seasons), id);
    const eps = await getShowEpisodes(show.tmdbId, show.seasons.map((x) => x.season));
    const wanted = new Set(input.seasons ?? show.seasons.filter((x) => x.season > 0).map((x) => x.season));
    upsertEpisodes(
      id,
      eps.map((e) => ({ season: e.season, episode: e.episode, absolute: null, title: e.title, airDate: e.airDate, overview: e.overview, still: e.still })),
      (e) => wanted.has(e.season),
    );
    logHistory(id, 'added', `Added show ${show.title}${by(input)}`);
    return id;
  }

  const a = await getAnimeSeries(input.anilistId!);
  const existing = findAnime(a);
  if (existing) return existing;
  const audio = input.animeAudio ?? s.defaultAnimeAudio;
  const r = insert.run('anime', null, a.anilistId, a.title, JSON.stringify(a.altTitles), a.year, a.poster, a.overview, rootFor(folderName('anime', a.title, a.year)),
    nameFor(folderName('anime', a.title, a.year)), monitored ? 1 : 0, audio, a.status, null, now(), now(), JSON.stringify(a.seasons), a.backdrop ?? null);
  const id = Number(r.lastInsertRowid);
  const wanted = new Set(input.seasons ?? a.seasons.map((x) => x.season));
  upsertEpisodes(id, animeEpisodes(a), (e) => wanted.has(e.season));
  // Episode titles, summaries and stills (Kitsu) arrive in the background; adding doesn't wait for them.
  void fillAnimeEpisodeDetails(id).catch(() => 0);
  logHistory(id, 'added', `Added anime ${a.title} (${a.seasons.length} season(s), ${audio})${by(input)}`);
  return id;
}

const animeEpisodes = (a: AnimeSeries): EpisodeInput[] =>
  a.episodes.map((e) => ({ season: e.season, episode: e.episode, absolute: e.absolute, title: null, airDate: e.airDate }));

/** An anime already in the library that shares any AniList entry with this series. */
function findAnime(a: AnimeSeries): number | null {
  const ids = new Set(a.seasons.flatMap((s) => s.anilistIds));
  const rows = db.prepare("SELECT id, anilist_id, anime_seasons FROM media WHERE type = 'anime'").all() as {
    id: number;
    anilist_id: number;
    anime_seasons: string | null;
  }[];
  for (const r of rows) {
    if (ids.has(r.anilist_id)) return r.id;
    if (r.anime_seasons && animeSeasons(r).some((s) => s.anilistIds.some((x) => ids.has(x)))) return r.id;
  }
  return null;
}

export function animeSeasons(m: Pick<MediaRow, 'anime_seasons'>): AnimeSeason[] {
  return m.anime_seasons ? (JSON.parse(m.anime_seasons) as AnimeSeason[]) : [];
}

/** Anime seasons, falling back to the stored episode list for rows added before seasons existed. */
export function seasonsFor(m: MediaRow): AnimeSeason[] {
  const stored = animeSeasons(m);
  if (stored.length) return stored;
  const counts = new Map<number, number>();
  for (const e of getEpisodes(m.id)) counts.set(e.season, (counts.get(e.season) ?? 0) + 1);
  let offset = 0;
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => {
      const s = { season, anilistIds: [], title: m.title, titles: season === 1 ? mediaTitles(m) : [], episodes, offset, year: m.year };
      offset += episodes;
      return s;
    });
}

/** Marks episodes/movies whose file was deleted from disk as missing again. */
function clearMissingFiles(m: MediaRow) {
  if (m.type === 'movie') {
    if (m.has_file && m.file_path && !fs.existsSync(m.file_path)) {
      db.prepare('UPDATE media SET has_file = 0, file_path = NULL WHERE id = ?').run(m.id);
    }
    return;
  }
  const reset = db.prepare('UPDATE episodes SET has_file = 0, file_path = NULL WHERE id = ?');
  for (const e of getEpisodes(m.id)) if (e.has_file && e.file_path && !fs.existsSync(e.file_path)) reset.run(e.id);
}

/** Inserts new episodes (monitored per `monitorNew`) and updates titles/air dates of existing ones. */
function upsertEpisodes(mediaId: number, eps: EpisodeInput[], monitorNew: (e: EpisodeInput) => boolean): number {
  const existing = new Map(getEpisodes(mediaId).map((e) => [`${e.season}x${e.episode}`, e]));
  const ins = db.prepare(
    'INSERT INTO episodes (media_id, season, episode, absolute_number, title, air_date, overview, still, monitored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const upd = db.prepare(
    'UPDATE episodes SET title = COALESCE(?, title), air_date = ?, absolute_number = ?, overview = COALESCE(?, overview), still = COALESCE(?, still) WHERE id = ?',
  );
  let added = 0;
  for (const e of eps) {
    const row = existing.get(`${e.season}x${e.episode}`);
    if (row) upd.run(e.title, e.airDate, e.absolute, e.overview ?? null, e.still ?? null, row.id);
    else {
      ins.run(mediaId, e.season, e.episode, e.absolute, e.title, e.airDate, e.overview ?? null, e.still ?? null, monitorNew(e) ? 1 : 0);
      added++;
    }
  }
  return added;
}

export async function refreshMedia(id: number): Promise<void> {
  const m = getMedia(id);
  if (!m) throw new Error('Media not found');
  clearMissingFiles(m);
  // New episodes are wanted when their season was requested; brand-new seasons only when the series is monitored.
  const monitoredSeasons = new Set(
    getEpisodes(id).filter((e) => e.monitored).map((e) => e.season),
  );
  if (m.type === 'movie') {
    const d = await getMovie(m.tmdb_id!);
    db.prepare('UPDATE media SET status = ?, release_date = ?, poster = ?, backdrop = ?, overview = ?, last_refresh = ? WHERE id = ?').run(
      d.status, d.releaseDate, d.poster, d.backdrop ?? null, d.overview, now(), id);
    return;
  }
  if (m.type === 'show') {
    const show = await getShow(m.tmdb_id!);
    const known = new Set(getEpisodes(id).map((e) => e.season));
    const eps = await getShowEpisodes(show.tmdbId, show.seasons.map((x) => x.season));
    const added = upsertEpisodes(
      id,
      eps.map((e) => ({ season: e.season, episode: e.episode, absolute: null, title: e.title, airDate: e.airDate, overview: e.overview, still: e.still })),
      (e) => e.season > 0 && (monitoredSeasons.has(e.season) || (!!m.monitored && !known.has(e.season))),
    );
    db.prepare('UPDATE media SET status = ?, poster = ?, backdrop = ?, overview = ?, season_names = ?, last_refresh = ? WHERE id = ?').run(
      show.status, show.poster, show.backdrop ?? null, show.overview, seasonNamesJson(show.seasons), now(), id);
    if (added) logHistory(id, 'refreshed', `Found ${added} new episode(s)`);
    return;
  }
  const a = await getAnimeSeries(m.anilist_id!);
  const known = new Set(getEpisodes(id).map((e) => e.season));
  const added = upsertEpisodes(
    id,
    animeEpisodes(a),
    (e) => monitoredSeasons.has(e.season) || (!!m.monitored && !known.has(e.season)),
  );
  db.prepare('UPDATE media SET status = ?, alt_titles = ?, anime_seasons = ?, poster = ?, backdrop = ?, overview = ?, last_refresh = ? WHERE id = ?').run(
    a.status, JSON.stringify(a.altTitles), JSON.stringify(a.seasons), a.poster, a.backdrop ?? null, a.overview, now(), id);
  if (added) logHistory(id, 'refreshed', `Found ${added} new episode(s)`);
  await fillAnimeEpisodeDetails(id).catch(() => 0);
}

export function mediaTitles(m: MediaRow): string[] {
  return [m.title, ...(JSON.parse(m.alt_titles) as string[])].filter((t, i, a) => t && a.indexOf(t) === i);
}

export function isAired(airDate: string | null): boolean {
  return !!airDate && new Date(airDate).getTime() <= Date.now();
}

/** Marks titles that are already in the library (any season of an anime counts). */
export function withLibraryIds<T extends { tmdbId?: number; anilistId?: number }>(type: MediaType, results: T[]) {
  const lib = db.prepare('SELECT id, tmdb_id, anilist_id, anime_seasons FROM media WHERE type = ?').all(type) as {
    id: number;
    tmdb_id: number | null;
    anilist_id: number | null;
    anime_seasons: string | null;
  }[];
  // Waiting for an admin's approval (shown as "Requested").
  const asked = db.prepare("SELECT tmdb_id, anilist_id FROM requests WHERE status = 'pending' AND type = ?").all(type) as {
    tmdb_id: number | null;
    anilist_id: number | null;
  }[];
  return results.map((r) => ({
    ...r,
    requested: asked.some((a) => (r.tmdbId && a.tmdb_id === r.tmdbId) || (r.anilistId && a.anilist_id === r.anilistId)),
    libraryId:
      lib.find(
        (l) =>
          (r.tmdbId && l.tmdb_id === r.tmdbId) ||
          (r.anilistId && (l.anilist_id === r.anilistId || animeSeasons(l).some((s) => s.anilistIds.includes(r.anilistId!)))),
      )?.id ?? null,
  }));
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backdrops for titles added before Mediarr stored them (the Home page uses them). One small request per
 * title, spaced out. A title with no backdrop anywhere is marked '' so it isn't asked about again;
 * a failed request leaves it for next time.
 */
export async function backfillBackdrops(opts: { delayMs?: number } = {}): Promise<number> {
  const rows = db.prepare('SELECT * FROM media WHERE backdrop IS NULL ORDER BY added_at DESC').all() as unknown as MediaRow[];
  let filled = 0;
  for (const m of rows) {
    try {
      let url: string | null = null;
      if (m.type === 'movie' && m.tmdb_id) url = (await getMovie(m.tmdb_id)).backdrop;
      else if (m.type === 'show' && m.tmdb_id) url = (await getShow(m.tmdb_id)).backdrop;
      else if (m.type === 'anime' && m.anilist_id) {
        const seasons = JSON.parse(m.anime_seasons ?? '[]') as { anilistIds?: number[] }[];
        url = await animeBanner([...new Set([m.anilist_id, ...seasons.flatMap((s) => s.anilistIds ?? [])])]);
      } else continue;
      db.prepare('UPDATE media SET backdrop = ? WHERE id = ?').run(url ?? '', m.id);
      if (url) filled++;
    } catch {
      // Offline or rate-limited: try again on the next start.
    }
    await pause(opts.delayMs ?? (m.type === 'anime' ? 800 : 250));
  }
  return filled;
}
