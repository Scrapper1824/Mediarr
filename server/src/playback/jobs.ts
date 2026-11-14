import fs from 'node:fs';
import { db, getEpisodes, getMedia } from '../db.js';
import { getSettings } from '../settings.js';
import { findFfmpeg } from './ffmpeg.js';
import { analyseMovie, analyseSeason, analysed } from './segments.js';
import { makeTrickplay, trickplayManifest } from './trickplay.js';

/**
 * Background work (intro detection, seek-bar thumbnails): one job at a time so it never competes with
 * itself, duplicates ignored, and whatever someone is about to watch goes to the front.
 */
const queue: { key: string; run: () => Promise<unknown> }[] = [];
const queued = new Set<string>();
let running: string | null = null;

function enqueue(key: string, run: () => Promise<unknown>, urgent = false) {
  if (queued.has(key) || running === key) return;
  queued.add(key);
  const job = { key, run };
  if (urgent) queue.unshift(job);
  else queue.push(job);
  void pump();
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  queued.delete(job.key);
  running = job.key;
  try {
    await job.run();
  } catch (err) {
    console.warn(`[media] ${job.key}: ${(err as Error).message}`);
  } finally {
    running = null;
    void pump();
  }
}

/** For tests and the status display. */
export const pendingJobs = () => [...(running ? [running] : []), ...queue.map((j) => j.key)];

/** Whether thumbnails / intro detection for a file are still queued or being made. */
export function workPending(file: string, mediaId: number, season: number | null) {
  const keys = new Set(pendingJobs());
  return {
    trickplay: keys.has(`thumbs:${file}`),
    segments: keys.has(`segments:${file}`) || (season !== null && keys.has(`segments:${mediaId}:${season}`)),
  };
}

/**
 * Everything already in the library, behind anything urgent: so previews and Skip intro are ready
 * before something is first played (new downloads are queued as they're imported).
 */
export function queueLibraryWork() {
  const ids = db.prepare('SELECT id FROM media ORDER BY added_at DESC').all() as { id: number }[];
  for (const { id } of ids) queueMediaWork(id);
}

/**
 * Queues intro/credits detection and thumbnails for a title's files. `focusEpisode` (the one being
 * played) and its season jump the queue.
 */
export function queueMediaWork(mediaId: number, opts: { urgent?: boolean; focusEpisode?: number | null } = {}) {
  const s = getSettings();
  if ((!s.introDetection && !s.trickplay) || !findFfmpeg()) return;
  const media = getMedia(mediaId);
  if (!media) return;

  if (media.type === 'movie') {
    const file = media.file_path;
    if (!file || !fs.existsSync(file)) return;
    if (s.trickplay && !trickplayManifest(file)) enqueue(`thumbs:${file}`, () => makeTrickplay(file), opts.urgent);
    if (s.introDetection && (!analysed(file, 'segments') || (!!media.tmdb_id && !analysed(file, 'introdb')))) {
      enqueue(`segments:${file}`, () => analyseMovie(file, media.tmdb_id), opts.urgent);
    }
    return;
  }

  const eps = getEpisodes(mediaId).filter((e) => e.has_file && e.file_path);
  const focus = eps.find((e) => e.id === opts.focusEpisode);
  // The episode being played first, then the rest of its season, then everything else.
  const ordered = focus ? [focus, ...eps.filter((e) => e !== focus && e.season === focus.season), ...eps.filter((e) => e.season !== focus.season)] : eps;
  const urgentFor = (season: number) => !!opts.urgent && (!focus || season === focus.season);

  if (s.introDetection) {
    const seasons = [...new Set(ordered.map((e) => e.season))];
    for (const season of seasons) {
      const pending = (e: (typeof ordered)[number]) =>
        !analysed(e.file_path!, 'segments') ||
        (media.type === 'anime' && !analysed(e.file_path!, 'aniskip')) ||
        (media.type === 'show' && !!media.tmdb_id && !analysed(e.file_path!, 'introdb'));
      if (ordered.some((e) => e.season === season && pending(e))) {
        enqueue(`segments:${mediaId}:${season}`, () => analyseSeason(mediaId, season), urgentFor(season));
      }
    }
  }
  if (s.trickplay) {
    // Thumbnails for the focused episode come before the season's intro scan (they show right away).
    for (const e of [...ordered].reverse()) {
      const file = e.file_path!;
      if (!trickplayManifest(file)) enqueue(`thumbs:${file}`, () => makeTrickplay(file), e === focus || urgentFor(e.season));
    }
  }
}
