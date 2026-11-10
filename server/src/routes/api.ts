import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { browseAnime, featuredAnime, getAnimeSeries, searchAnime } from '../clients/anilist.js';
import { testProwlarr } from '../clients/prowlarr.js';
import { deleteTorrent, testQbit } from '../clients/qbittorrent.js';
import {
  browseTmdb,
  featuredTmdb,
  getShow,
  searchMovies,
  searchShows,
  testTmdb,
  type BrowseRow,
  type FeaturedItem,
  type SearchResult,
} from '../clients/tmdb.js';
import { runImport } from '../core/downloads.js';
import {
  acceptSuggestion,
  autoSearch,
  dismissSuggestion,
  episodesForRelease,
  grabRelease,
  searchEvents,
  searchReleases,
  searchStatus,
} from '../core/grabber.js';
import { addMedia, animeSeasons, isAired, refreshMedia, withLibraryIds, type AddMediaInput } from '../core/library.js';
import { getMediaInfo, type MediaInfo } from '../core/mediaInfo.js';
import { testOmdb } from '../clients/ratings.js';
import { autostartSupported, getAutostart, setAutostart } from '../system/autostart.js';
import { runMonitor } from '../core/monitor.js';
import type { SearchScope } from '../core/scoring.js';
import { activeEpisodeIds, db, getEpisodes, getMedia, hasActiveDownload, logHistory, now, type DownloadRow, type MediaRow, type MediaType } from '../db.js';
import { getSettings, ROOT_KEYS, saveSettings, SECRET_KEYS, type Settings } from '../settings.js';
import { folderSpace } from '../core/rootFolders.js';
import { identifyFolder, scanLibrary, scanStatus } from '../core/scanner.js';
import { queueMediaWork } from '../playback/jobs.js';
import { beginInstall, checkForUpdate, updateInfo } from '../system/updater.js';
import { ffmpegInfo } from '../playback/ffmpeg.js';

const MASK = '********';

function publicSettings(): Settings {
  const s = getSettings();
  for (const k of SECRET_KEYS) if (s[k]) (s as unknown as Record<string, unknown>)[k] = MASK;
  return s;
}

/** Fills masked secrets in a submitted form with the stored values. */
function unmask(body: Partial<Settings>): Partial<Settings> {
  const stored = getSettings();
  const out = { ...body };
  for (const k of SECRET_KEYS) if (out[k] === MASK) (out as Record<string, unknown>)[k] = stored[k];
  return out;
}

function mediaSummary(m: MediaRow) {
  const eps = m.type === 'movie' ? [] : getEpisodes(m.id);
  const aired = eps.filter((e) => isAired(e.air_date) && e.season > 0);
  return {
    ...m,
    alt_titles: JSON.parse(m.alt_titles) as string[],
    anime_seasons: animeSeasons(m).map((s) => ({ season: s.season, title: s.title, episodes: s.episodes, year: s.year })),
    monitored: !!m.monitored,
    has_file: !!m.has_file,
    downloading: hasActiveDownload(m.id),
    search: searchStatus(m.id),
    episodeCount: aired.length,
    episodeFileCount: aired.filter((e) => e.has_file).length,
    pendingSuggestions: (
      db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE media_id = ? AND status = 'pending'").get(m.id) as { n: number }
    ).n,
  };
}

function notFound(): never {
  throw Object.assign(new Error('Not found'), { statusCode: 404 });
}

export async function apiRoutes(app: FastifyInstance) {
  // ---- Settings ----
  // Admins get everything (secrets masked); regular users only the defaults the request dialog needs.
  app.get('/api/settings', async (req) =>
    req.user?.role === 'admin' ? publicSettings() : { defaultAnimeAudio: getSettings().defaultAnimeAudio },
  );

  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req, reply) => {
    const body = unmask(req.body);
    for (const key of Object.values(ROOT_KEYS)) {
      for (const p of body[key] ?? []) {
        if (p.trim() && !fs.existsSync(p.trim())) return reply.code(400).send({ error: `Folder does not exist: ${p}` });
      }
    }
    saveSettings(body);
    // New keys (TMDB, OMDb) should show up right away, not after cached details expire.
    infoCache.clear();
    browseCache.clear();
    return publicSettings();
  });

  app.post<{ Params: { service: string }; Body: Partial<Settings> }>('/api/settings/test/:service', async (req) => {
    const s = { ...getSettings(), ...unmask(req.body ?? {}) };
    try {
      if (req.params.service === 'tmdb') await testTmdb(s.tmdbApiKey);
      else if (req.params.service === 'omdb') await testOmdb(s.omdbApiKey);
      else if (req.params.service === 'ffmpeg') {
        const info = await ffmpegInfo({ force: true, path: s.ffmpegPath, hwAccel: s.hwAccel });
        const names: Record<string, string> = { h264_amf: 'AMD (AMF)', h264_nvenc: 'NVIDIA (NVENC)', h264_qsv: 'Intel (Quick Sync)', libx264: 'CPU (x264)' };
        return { ok: true, message: `FFmpeg ${info.version} · converting with ${names[info.encoder]}${info.hardware.length ? '' : ' (no GPU encoder found)'}` };
      } else if (req.params.service === 'prowlarr') return { ok: true, message: `Prowlarr ${await testProwlarr(s.prowlarrUrl, s.prowlarrApiKey)}` };
      else if (req.params.service === 'qbittorrent')
        return { ok: true, message: `qBittorrent ${await testQbit(s.qbitUrl, s.qbitUsername, s.qbitPassword)}` };
      else notFound();
      return { ok: true, message: 'Connected' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  app.post('/api/system/monitor', async () => runMonitor());

  // "Start when I log in to Windows" (admin-only like everything not opened to users in security.ts).
  // Library scan: titles already in the library folders (admins only).
  app.get('/api/library/scan', async () => scanStatus());
  app.post('/api/library/scan', async () => {
    void scanLibrary().then((s) => s.added.forEach((a) => queueMediaWork(a.id)));
    await new Promise((r) => setTimeout(r, 50));
    return scanStatus();
  });
  app.post<{ Body: { type?: string; root?: string; folder?: string; tmdbId?: number; anilistId?: number } }>('/api/library/identify', async (req, reply) => {
    const { type, root, folder } = req.body ?? {};
    const id = Number(type === 'anime' ? req.body?.anilistId : req.body?.tmdbId);
    if (!['movie', 'show', 'anime'].includes(String(type)) || typeof root !== 'string' || typeof folder !== 'string' || !Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Bad request' });
    }
    const m = await identifyFolder(type as MediaType, root, folder, type === 'anime' ? { anilistId: id } : { tmdbId: id });
    queueMediaWork(m.id);
    return { id: m.id, title: m.title, status: scanStatus() };
  });

  // Updates from the GitHub repo's releases (admins only).
  app.get('/api/system/update', async () => updateInfo());
  app.post('/api/system/update/check', async () => checkForUpdate());
  app.post('/api/system/update/install', async () => {
    beginInstall();
    return updateInfo();
  });

  // Free space on each library folder's drive, for Settings.
  app.get('/api/system/folders', async () => {
    const s = getSettings();
    return Object.fromEntries(Object.values(ROOT_KEYS).map((k) => [k, s[k].map(folderSpace)]));
  });

  app.get('/api/system/autostart', async () => ({ supported: autostartSupported(), enabled: await getAutostart() }));
  app.put<{ Body: { enabled?: boolean } }>('/api/system/autostart', async (req) => ({
    supported: autostartSupported(),
    enabled: await setAutostart(req.body?.enabled === true),
  }));

  // ---- Discover ----
  app.get<{ Querystring: { type: MediaType; q: string } }>('/api/discover/search', async (req) => {
    const { type, q } = req.query;
    if (!q?.trim()) return [];
    const results = type === 'movie' ? await searchMovies(q) : type === 'show' ? await searchShows(q) : await searchAnime(q);
    return withLibraryIds(type, results);
  });

  // Details screen for a Discover card: ratings, age rating, language, studio, length...
  // Cached for a few hours so reopening a title is instant and rating sites aren't hammered.
  const infoCache = new Map<string, { at: number; ttl: number; info: MediaInfo }>();
  const INFO_TTL_MS = 6 * 3600_000;
  // If a rating site didn't answer, try again soon rather than showing the gap for hours.
  const INCOMPLETE_TTL_MS = 15 * 60_000;
  const ratingsComplete = (info: MediaInfo) =>
    info.type === 'anime'
      ? info.ratings.length >= 3
      : !getSettings().omdbApiKey || info.ratings.some((r) => r.source === 'imdb' || r.source === 'rt');
  app.get<{ Querystring: { type: MediaType; id: string } }>('/api/discover/info', async (req, reply) => {
    const { type } = req.query;
    const id = Number(req.query.id);
    if (!['movie', 'show', 'anime'].includes(type) || !Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad request' });
    const key = `${type}:${id}`;
    let hit = infoCache.get(key);
    if (!hit || Date.now() - hit.at > hit.ttl) {
      const info = await getMediaInfo(type, id);
      hit = { at: Date.now(), ttl: ratingsComplete(info) ? INFO_TTL_MS : INCOMPLETE_TTL_MS, info };
      infoCache.set(key, hit);
      if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value!); // keep memory bounded
    }
    const [withLib] = withLibraryIds(type, [{ ...hit.info, type, year: hit.info.year, poster: hit.info.poster } as SearchResult & MediaInfo]);
    return withLib;
  });

  // Trending / new / popular rows for Discover. Cached so switching tabs doesn't hit TMDB/AniList each time.
  const browseCache = new Map<MediaType, { at: number; featured: FeaturedItem[]; rows: BrowseRow[] }>();
  const BROWSE_TTL_MS = 30 * 60_000;
  app.get<{ Querystring: { type: MediaType } }>('/api/discover/browse', async (req, reply) => {
    const type = req.query.type;
    if (!['movie', 'show', 'anime'].includes(type)) return reply.code(400).send({ error: 'Unknown type' });
    let cached = browseCache.get(type);
    if (!cached || Date.now() - cached.at > BROWSE_TTL_MS) {
      const [rows, featured] = await Promise.all([
        type === 'anime' ? browseAnime() : browseTmdb(type),
        // The banner is a nice-to-have: if it fails, the rows still load.
        (type === 'anime' ? featuredAnime() : featuredTmdb(type)).catch(() => [] as FeaturedItem[]),
      ]);
      cached = { at: Date.now(), featured, rows };
      browseCache.set(type, cached);
    }
    // Library flags are added fresh each time so "In library" is always current.
    return {
      featured: withLibraryIds(type, cached.featured),
      rows: cached.rows.map((r) => ({ ...r, items: withLibraryIds(type, r.items) })),
    };
  });

  app.get<{ Querystring: { type: MediaType; id: string } }>('/api/discover/details', async (req) => {
    const id = Number(req.query.id);
    if (req.query.type === 'show') return getShow(id);
    if (req.query.type === 'anime') {
      // Same shape as TMDB show details so the add dialog can pick seasons.
      const a = await getAnimeSeries(id);
      return {
        title: a.title,
        seasons: a.seasons.map((s) => ({ season: s.season, name: s.title, episodeCount: s.episodes, airDate: s.year ? String(s.year) : null })),
      };
    }
    return {};
  });

  // ---- Library ----
  app.get<{ Querystring: { type?: MediaType } }>('/api/media', async (req) => {
    const rows = (
      req.query.type
        ? db.prepare('SELECT * FROM media WHERE type = ? ORDER BY title').all(req.query.type)
        : db.prepare('SELECT * FROM media ORDER BY title').all()
    ) as unknown as MediaRow[];
    return rows.map(mediaSummary);
  });

  app.get<{ Params: { id: string } }>('/api/media/:id', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    const active = activeEpisodeIds(m.id);
    const episodes = getEpisodes(m.id).map((e) => ({
      ...e,
      monitored: !!e.monitored,
      has_file: !!e.has_file,
      aired: isAired(e.air_date),
      downloading: active.has(e.id),
    }));
    const downloads = db
      .prepare('SELECT * FROM downloads WHERE media_id = ? ORDER BY id DESC LIMIT 20')
      .all(m.id) as unknown as DownloadRow[];
    const suggestions = (
      db.prepare("SELECT * FROM suggestions WHERE media_id = ? AND status = 'pending' ORDER BY season, id").all(m.id) as {
        release: string;
      }[]
    ).map((x) => ({ ...x, release: JSON.parse(x.release) }));
    return { ...mediaSummary(m), episodes, downloads, suggestions };
  });

  app.post<{ Body: AddMediaInput & { searchNow?: boolean } }>('/api/media', async (req) => {
    const id = await addMedia({ ...req.body, requestedBy: req.user!.username });
    if (req.body.searchNow !== false) {
      // Run in the background; the UI polls the detail page for progress.
      autoSearch(id, { force: true, userId: req.user!.id }).catch((err) => logHistory(id, 'failed', `Search failed: ${err.message}`));
    }
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: { monitored?: boolean; animeAudio?: 'sub' | 'dub' } }>('/api/media/:id', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    if (req.body.monitored !== undefined) db.prepare('UPDATE media SET monitored = ? WHERE id = ?').run(req.body.monitored ? 1 : 0, m.id);
    if (req.body.animeAudio) db.prepare('UPDATE media SET anime_audio = ? WHERE id = ?').run(req.body.animeAudio, m.id);
    return mediaSummary(getMedia(m.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/media/:id', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
    logHistory(null, 'removed', `Removed ${m.title} from library (files kept)`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/media/:id/refresh', async (req) => {
    await refreshMedia(Number(req.params.id));
    return { ok: true };
  });

  app.patch<{ Params: { id: string; season: string }; Body: { monitored: boolean } }>(
    '/api/media/:id/seasons/:season',
    async (req) => {
      db.prepare('UPDATE episodes SET monitored = ? WHERE media_id = ? AND season = ?').run(
        req.body.monitored ? 1 : 0,
        Number(req.params.id),
        Number(req.params.season),
      );
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string }; Body: { monitored: boolean } }>('/api/episodes/:id', async (req) => {
    db.prepare('UPDATE episodes SET monitored = ? WHERE id = ?').run(req.body.monitored ? 1 : 0, Number(req.params.id));
    return { ok: true };
  });

  // ---- Searching & grabbing ----
  app.post<{ Params: { id: string }; Body: { episodeIds?: number[]; season?: number } }>('/api/media/:id/search', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    let episodeIds = req.body?.episodeIds;
    if (req.body?.season !== undefined) episodeIds = getEpisodes(m.id).filter((e) => e.season === req.body.season).map((e) => e.id);
    const grabs = await autoSearch(m.id, { force: true, episodeIds, userId: req.user!.id });
    return { grabs };
  });

  app.get<{ Params: { id: string }; Querystring: { season?: string; episodeId?: string } }>('/api/media/:id/releases', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    let scope: SearchScope = { kind: 'movie' };
    if (m.type !== 'movie') {
      const eps = getEpisodes(m.id);
      if (req.query.episodeId) {
        const e = eps.find((x) => x.id === Number(req.query.episodeId)) ?? notFound();
        scope = { kind: 'episode', season: e.season, episode: e.episode };
      } else {
        const season = Number(req.query.season ?? 1);
        scope = { kind: 'season', season, episodes: eps.filter((e) => e.season === season).map((e) => e.episode) };
      }
    }
    return searchReleases(m, scope, 'broad');
  });

  app.post<{
    Params: { id: string };
    Body: {
      title: string;
      indexer?: string;
      size?: number;
      magnetUrl?: string;
      downloadUrl?: string;
      episodeId?: number;
      /** Grabbing a bundle for this season: only download the wanted episodes from it. */
      onlySeason?: number;
    };
  }>('/api/media/:id/grab', async (req) => {
    const m = getMedia(Number(req.params.id)) ?? notFound();
    const { onlySeason, episodeId, ...release } = req.body;
    let eps = episodesForRelease(m, release.title, getEpisodes(m.id));
    if (onlySeason !== undefined) eps = eps.filter((e) => !e.has_file && (e.season === onlySeason || e.monitored));
    let ids = eps.map((e) => e.id);
    if (!ids.length && episodeId) ids = [episodeId];
    const id = await grabRelease(m, { indexer: '', size: 0, ...release }, ids, { selectFiles: onlySeason !== undefined });
    return { id };
  });

  // Searches you started that found nothing; the UI polls this to show a popup.
  // after=-1 returns just the latest id, so opening the page doesn't replay old popups.
  app.get<{ Querystring: { after?: string } }>('/api/search-events', async (req) =>
    searchEvents(Number(req.query.after ?? -1), req.user!.id),
  );

  // ---- Bundle suggestions ----
  app.post<{ Params: { id: string }; Body: { mode?: 'wanted' | 'all' } }>('/api/suggestions/:id/accept', async (req) => ({
    downloadId: await acceptSuggestion(Number(req.params.id), req.body?.mode === 'all' ? 'all' : 'wanted'),
  }));

  app.post<{ Params: { id: string } }>('/api/suggestions/:id/dismiss', async (req) => {
    dismissSuggestion(Number(req.params.id));
    return { ok: true };
  });

  // ---- Queue & history ----
  app.get('/api/queue', async () =>
    db
      .prepare(
        `SELECT d.*, m.title AS media_title, m.type AS media_type FROM downloads d JOIN media m ON m.id = d.media_id
         WHERE d.state IN ('queued','downloading','importing') OR (d.state = 'failed' AND d.updated_at > ?)
         ORDER BY d.id DESC`,
      )
      .all(new Date(Date.now() - 7 * 86400_000).toISOString()),
  );

  app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>('/api/queue/:id', async (req) => {
    const dl = (db.prepare('SELECT * FROM downloads WHERE id = ?').get(Number(req.params.id)) as DownloadRow | undefined) ?? notFound();
    if (dl.qbit_hash && dl.state !== 'imported' && dl.state !== 'failed') {
      await deleteTorrent(dl.qbit_hash, req.query.deleteFiles === 'true').catch(() => {});
    }
    db.prepare('DELETE FROM downloads WHERE id = ?').run(dl.id);
    logHistory(dl.media_id, 'removed', `Removed "${dl.release_title}" from queue`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/queue/:id/retry-import', async (req) => {
    const dl = (db.prepare('SELECT * FROM downloads WHERE id = ?').get(Number(req.params.id)) as DownloadRow | undefined) ?? notFound();
    await runImport(dl);
    return db.prepare('SELECT * FROM downloads WHERE id = ?').get(dl.id);
  });

  app.get('/api/history', async () =>
    db
      .prepare(
        `SELECT h.*, m.title AS media_title FROM history h LEFT JOIN media m ON m.id = h.media_id ORDER BY h.id DESC LIMIT 300`,
      )
      .all(),
  );

  app.get('/api/status', async () => ({ ok: true, time: now() }));
}
