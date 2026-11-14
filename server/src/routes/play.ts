import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { continueWatching, homeFor, playableEpisodes, progressOf } from '../core/home.js';
import { isInside } from '../core/importer.js';
import { db, getMedia, now, type EpisodeRow, type MediaRow } from '../db.js';
import { getSettings } from '../settings.js';
import { decidePlayback, QUALITIES, segmentStarts, type ClientCaps, type PlayChoice, type Quality } from '../playback/decide.js';
import { ffmpegInfo, requireFfmpeg } from '../playback/ffmpeg.js';
import { dumpFonts, extractSubtitle, keyframesWithin, probeFile } from '../playback/probe.js';
import { copyFailedFor, createSession, endSession, getSession, playlistPath, waitForSegment } from '../playback/sessions.js';
import { queueMediaWork, workPending } from '../playback/jobs.js';
import { getSegments } from '../playback/segments.js';
import { trickplayManifest, trickplaySheet } from '../playback/trickplay.js';
import { inTitleDirs } from '../core/rootFolders.js';

type Kind = 'movie' | 'episode';

interface Playable {
  kind: Kind;
  id: number;
  media: MediaRow;
  episode: EpisodeRow | null;
  file: string;
}

const bad = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The file for a movie/episode, only when it's inside the title's own library folder. */
function playable(kindParam: string, idParam: string): Playable {
  const id = Number(idParam);
  if ((kindParam !== 'movie' && kindParam !== 'episode') || !Number.isInteger(id) || id <= 0) throw bad(400, 'Bad request');
  const kind = kindParam as Kind;
  let media: MediaRow | undefined;
  let episode: EpisodeRow | null = null;
  if (kind === 'movie') {
    media = getMedia(id);
  } else {
    episode = (db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined) ?? null;
    media = episode ? getMedia(episode.media_id) : undefined;
  }
  const file = kind === 'movie' ? media?.file_path : episode?.file_path;
  if (!media || !file) throw bad(404, 'Nothing to play here yet');
  if (!inTitleDirs(media, file)) throw bad(403, 'That file isn’t in the library');
  if (!fs.existsSync(file)) throw bad(404, 'The file is missing from disk');
  return { kind, id, media, episode, file };
}

/** Home network (or this PC): private and loopback addresses. */
export function isLocalAddress(ip: string): boolean {
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = addr.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

const label = (p: Playable) =>
  p.episode
    ? `S${String(p.episode.season).padStart(2, '0')}E${String(p.episode.episode).padStart(2, '0')}${p.episode.title ? ` · ${p.episode.title}` : ''}`
    : null;

/** The episode with a file just after (step 1) or before (step -1) this one; specials are skipped. */
function episodeAround(p: Playable, step: 1 | -1): EpisodeRow | null {
  if (!p.episode) return null;
  const eps = playableEpisodes(p.media.id);
  const i = eps.findIndex((e) => e.id === p.episode!.id);
  return i >= 0 ? (eps[i + step] ?? null) : null;
}
const nextEpisode = (p: Playable) => episodeAround(p, 1);
const episodeLink = (e: EpisodeRow | null) =>
  e ? { kind: 'episode' as const, id: e.id, label: `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}` } : null;

const CONTENT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };

function sendRange(req: FastifyRequest, reply: FastifyReply, file: string) {
  const size = fs.statSync(file).size;
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', type);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (!m[1] && !m[2])) {
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(file));
  }
  let startByte = m[1] ? Number(m[1]) : size - Number(m[2]);
  let endByte = m[1] && m[2] ? Number(m[2]) : size - 1;
  startByte = Math.max(0, startByte);
  endByte = Math.min(size - 1, endByte);
  if (startByte > endByte) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  reply.code(206).header('Content-Range', `bytes ${startByte}-${endByte}/${size}`).header('Content-Length', endByte - startByte + 1);
  return reply.send(fs.createReadStream(file, { start: startByte, end: endByte }));
}

const CAP_KEYS: (keyof ClientCaps)[] = ['mp4', 'webm', 'h264', 'hevc', 'av1', 'vp9', 'aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'];
const parseCaps = (raw: unknown): ClientCaps =>
  Object.fromEntries(CAP_KEYS.map((k) => [k, !!(raw as Record<string, unknown> | undefined)?.[k]])) as unknown as ClientCaps;

/** The library title a playback route is about (an episode belongs to its title), if any. */
function mediaForRoute(route: string, params: Record<string, string | undefined>): MediaRow | undefined {
  if (route.startsWith('/api/play/:kind/:id')) {
    const id = Number(params.id);
    if (params.kind === 'movie') return getMedia(id);
    const ep = db.prepare('SELECT media_id FROM episodes WHERE id = ?').get(id) as { media_id: number } | undefined;
    return ep ? getMedia(ep.media_id) : undefined;
  }
  if (route.startsWith('/api/play/progress/:mediaId')) return getMedia(Number(params.mediaId));
  if (route.startsWith('/api/media/:id')) return getMedia(Number(params.id));
  return undefined;
}

/** Watching: every signed-in user can play titles that are in the library. */
export async function playRoutes(app: FastifyInstance) {
  // 18+ titles can only be played by users allowed to see them.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user || req.user.allow_adult) return;
    const m = mediaForRoute(req.routeOptions.url ?? '', req.params as Record<string, string | undefined>);
    if (m?.adult) return reply.code(404).send({ error: 'Nothing to play here yet' });
  });

  app.get<{ Params: { kind: string; id: string } }>('/api/play/:kind/:id/info', async (req) => {
    const p = playable(req.params.kind, req.params.id);
    requireFfmpeg();
    const probe = await probeFile(p.file);
    const progress = progressOf(req.user!.id, p.media.id, p.episode?.id ?? 0);
    // About to be watched: its thumbnails and its season's intros go to the front of the queue.
    queueMediaWork(p.media.id, { urgent: true, focusEpisode: p.episode?.id ?? null });
    const next = nextEpisode(p);
    return {
      kind: p.kind,
      id: p.id,
      mediaId: p.media.id,
      title: p.media.title,
      subtitle: label(p),
      poster: p.media.poster,
      /** Anime: the Sub/Dub choice made when it was requested, to pick the audio track. */
      audioPreference: p.media.anime_audio,
      duration: probe.duration,
      audio: probe.audio.map((a) => ({ order: a.order, language: a.language, title: a.title, codec: a.codec, channels: a.channels, isDefault: a.isDefault })),
      subtitles: probe.subtitles.map((s) => ({ order: s.order, language: s.language, title: s.title, codec: s.codec, text: s.text, isDefault: s.isDefault, forced: s.forced })),
      hasFonts: probe.fonts.length > 0,
      /** Intro/credits for the Skip buttons (found in the background; may still be on the way). */
      segments: getSettings().introDetection ? getSegments(p.file, probe.duration) : {},
      trickplay: getSettings().trickplay ? trickplayManifest(p.file) : null,
      pending: workPending(p.file, p.media.id, p.episode?.season ?? null),
      position: progress.watched ? 0 : progress.position,
      next: episodeLink(next),
      prev: episodeLink(episodeAround(p, -1)),
      remote: !isLocalAddress(req.ip),
    };
  });

  app.post<{ Params: { kind: string; id: string }; Body: { audio?: number | null; subtitle?: number | null; quality?: string; caps?: unknown; startAt?: number } }>(
    '/api/play/:kind/:id/start',
    async (req) => {
      const p = playable(req.params.kind, req.params.id);
      const tools = requireFfmpeg();
      const probe = await probeFile(p.file);
      const quality = (QUALITIES.includes(req.body?.quality as Quality) ? req.body!.quality : 'auto') as Quality;
      const track = (v: unknown, list: { order: number }[]) => (typeof v === 'number' && list.some((t) => t.order === v) ? v : null);
      const choice: PlayChoice = { audio: track(req.body?.audio, probe.audio), subtitle: track(req.body?.subtitle, probe.subtitles), quality };
      const remote = !isLocalAddress(req.ip);
      let decision = decidePlayback(probe, path.extname(p.file), parseCaps(req.body?.caps), choice, remote, getSettings().remoteMaxBitrateMbps * 1_000_000);
      // Copying the video needs its keyframes (read once per file); if they can't be read, convert instead.
      let starts: number[] | undefined;
      if (decision.copyVideo) {
        const keys = copyFailedFor(p.file) ? [] : await keyframesWithin(p.file, 3000);
        if (keys?.length) starts = segmentStarts(probe.duration, keys);
        else decision = { ...decision, copyVideo: false, reason: decision.reason.replace(/: repackaged.*$/, '') };
      }
      if (decision.mode === 'direct') return { mode: 'direct', url: `/api/play/direct/${p.kind}/${p.id}`, reason: decision.reason };
      const info = await ffmpegInfo();
      const startAt = Math.min(Math.max(0, Number(req.body?.startAt) || 0), Math.max(0, probe.duration - 1));
      const s = createSession({
        userId: req.user!.id,
        title: `${p.kind}:${p.id}`,
        file: p.file,
        ffmpeg: tools.ffmpeg,
        probe,
        decision,
        encoder: info.encoder,
        startAt,
        starts,
      });
      return {
        mode: 'hls',
        url: `/api/play/hls/${s.id}/main.m3u8`,
        sessionId: s.id,
        reason: decision.reason,
        encoder: decision.copyVideo ? 'copy' : info.encoder,
        copy: !!decision.copyVideo,
        height: decision.height,
        bitrate: decision.videoBitrate,
      };
    },
  );

  app.get<{ Params: { kind: string; id: string } }>('/api/play/direct/:kind/:id', async (req, reply) => {
    const p = playable(req.params.kind, req.params.id);
    return sendRange(req, reply, p.file);
  });

  app.get<{ Params: { session: string; file: string } }>('/api/play/hls/:session/:file', async (req, reply) => {
    const s = getSession(req.params.session, req.user!.id);
    if (!s) return reply.code(404).send({ error: 'This stream has ended. Press play again.' });
    if (req.params.file === 'main.m3u8') {
      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      return reply.send(fs.createReadStream(playlistPath(s)));
    }
    const m = /^seg(\d+)\.ts$/.exec(req.params.file);
    if (!m) return reply.code(404).send({ error: 'Not found' });
    // The player abandons requests when you seek again; stop waiting for those.
    const seg = await waitForSegment(s, Number(m[1]), 45_000, () => reply.raw.destroyed || req.raw.destroyed);
    reply.header('Content-Type', 'video/mp2t');
    return reply.send(fs.createReadStream(seg));
  });

  app.delete<{ Params: { session: string } }>('/api/play/hls/:session', async (req) => {
    if (getSession(req.params.session, req.user!.id)) endSession(req.params.session);
    return { ok: true };
  });

  app.get<{ Params: { kind: string; id: string; track: string } }>('/api/play/:kind/:id/subtitle/:track', async (req, reply) => {
    const p = playable(req.params.kind, req.params.id);
    const probe = await probeFile(p.file);
    const track = probe.subtitles.find((s) => s.order === Number(req.params.track));
    if (!track || !track.text) return reply.code(404).send({ error: 'No such subtitle track' });
    const file = await extractSubtitle(p.file, track);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(fs.createReadStream(file));
  });

  /** Intro/credits and thumbnails as they become ready (the player asks again while they're being made). */
  app.get<{ Params: { kind: string; id: string } }>('/api/play/:kind/:id/extras', async (req) => {
    const p = playable(req.params.kind, req.params.id);
    const s = getSettings();
    const probe = await probeFile(p.file).catch(() => null); // cached; gives the length for placing sections
    return {
      segments: s.introDetection ? getSegments(p.file, probe?.duration) : {},
      trickplay: s.trickplay ? trickplayManifest(p.file) : null,
      /** Still being worked out (the player shows "Making previews…" meanwhile). */
      pending: workPending(p.file, p.media.id, p.episode?.season ?? null),
    };
  });

  app.get<{ Params: { kind: string; id: string; sheet: string } }>('/api/play/:kind/:id/trickplay/:sheet', async (req, reply) => {
    const p = playable(req.params.kind, req.params.id);
    const m = /^(\d+)\.jpg$/.exec(req.params.sheet);
    const file = m ? trickplaySheet(p.file, Number(m[1])) : null;
    if (!file) return reply.code(404).send({ error: 'Not found' });
    reply.header('Content-Type', 'image/jpeg');
    return reply.send(fs.createReadStream(file));
  });

  app.get<{ Params: { kind: string; id: string } }>('/api/play/:kind/:id/fonts', async (req) => {
    const p = playable(req.params.kind, req.params.id);
    const probe = await probeFile(p.file);
    if (!probe.fonts.length) return [];
    return (await dumpFonts(p.file, probe)).names;
  });

  app.get<{ Params: { kind: string; id: string; name: string } }>('/api/play/:kind/:id/fonts/:name', async (req, reply) => {
    const p = playable(req.params.kind, req.params.id);
    const probe = await probeFile(p.file);
    const { dir, names } = await dumpFonts(p.file, probe);
    if (!names.includes(req.params.name)) return reply.code(404).send({ error: 'No such font' });
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(fs.createReadStream(path.join(dir, req.params.name)));
  });

  app.put<{ Params: { kind: string; id: string }; Body: { position?: number; duration?: number; watched?: boolean } }>(
    '/api/play/:kind/:id/progress',
    async (req) => {
      const p = playable(req.params.kind, req.params.id);
      const episodeId = p.episode?.id ?? 0;
      const before = progressOf(req.user!.id, p.media.id, episodeId);
      const duration = Math.max(0, Number(req.body?.duration) || 0) || before.duration;
      let position = Math.max(0, Number(req.body?.position) || 0);
      if (duration) position = Math.min(position, duration);
      let watched: boolean;
      if (typeof req.body?.watched === 'boolean') {
        // Marked by hand: either way, the next play starts from the beginning.
        watched = req.body.watched;
        position = 0;
      } else {
        // Reached 90%: watched (and stays watched while re-watching).
        watched = !!before.watched || (duration > 0 && position / duration >= 0.9);
      }
      db.prepare(
        `INSERT INTO watch_progress (user_id, media_id, episode_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, media_id, episode_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
           watched = excluded.watched, updated_at = excluded.updated_at`,
      ).run(req.user!.id, p.media.id, episodeId, position, duration, watched ? 1 : 0, now());
      return { ok: true, watched };
    },
  );

  /** Watched state of each episode of a title (or the movie), for the library page. */
  /**
   * Mark episodes (or a movie: episode 0) watched or not, for you. Several at once are recorded in order,
   * so the last one counts as your latest and Continue watching offers the next. Unmarking doesn't
   * change when you last watched.
   */
  app.put<{ Params: { id: string }; Body: { episodeIds?: unknown; watched?: unknown } }>('/api/media/:id/watched', async (req, reply) => {
    const media = getMedia(Number(req.params.id));
    if (!media) return reply.code(404).send({ error: 'Not found' });
    const ids = Array.isArray(req.body?.episodeIds) ? req.body.episodeIds.filter((x): x is number => Number.isInteger(x)) : [];
    if (typeof req.body?.watched !== 'boolean' || !ids.length || ids.length > 5000) return reply.code(400).send({ error: 'Bad request' });
    let episodes: EpisodeRow[] = [];
    if (media.type === 'movie') {
      if (ids.some((x) => x !== 0)) return reply.code(400).send({ error: 'A movie has no episodes' });
    } else {
      const wanted = new Set(ids);
      // Only this title's own episodes, in watching order.
      episodes = db.prepare('SELECT * FROM episodes WHERE media_id = ? ORDER BY season, episode').all(media.id) as unknown as EpisodeRow[];
      episodes = episodes.filter((e) => wanted.has(e.id));
      if (episodes.length !== wanted.size) return reply.code(400).send({ error: 'Unknown episode' });
    }
    const userId = req.user!.id;
    const targets = media.type === 'movie' ? [0] : episodes.map((e) => e.id);
    if (req.body.watched) {
      const up = db.prepare(
        `INSERT INTO watch_progress (user_id, media_id, episode_id, position, duration, watched, updated_at) VALUES (?, ?, ?, 0, 0, 1, ?)
         ON CONFLICT(user_id, media_id, episode_id) DO UPDATE SET watched = 1, position = 0, updated_at = excluded.updated_at`,
      );
      const base = Date.now();
      targets.forEach((epId, i) => up.run(userId, media.id, epId, new Date(base + i).toISOString()));
    } else {
      const down = db.prepare('UPDATE watch_progress SET watched = 0, position = 0 WHERE user_id = ? AND media_id = ? AND episode_id = ?');
      for (const epId of targets) down.run(userId, media.id, epId);
    }
    return { ok: true, count: targets.length };
  });

  app.get<{ Params: { mediaId: string } }>('/api/play/progress/:mediaId', async (req) => {
    const rows = db
      .prepare('SELECT episode_id, position, duration, watched FROM watch_progress WHERE user_id = ? AND media_id = ?')
      .all(req.user!.id, Number(req.params.mediaId)) as { episode_id: number; position: number; duration: number; watched: number }[];
    return Object.fromEntries(rows.map((r) => [r.episode_id, { position: r.position, duration: r.duration, watched: !!r.watched }]));
  });

  /** Continue Watching (started, not finished) and Next Up (the episode after the last one finished). */
  app.get('/api/continue', async (req) => continueWatching(req.user!.id, 20, !!req.user!.allow_adult));

  /** The Home page: banner, continue watching, recently added, and what is downloaded per type (your own progress only). */
  app.get('/api/home', async (req) => homeFor(req.user!.id, !!req.user!.allow_adult));
}
