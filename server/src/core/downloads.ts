import path from 'node:path';
import { deleteTorrent, listTorrents, torrentFiles, torrentStatus } from '../clients/qbittorrent.js';
import { db, logHistory, now, type DownloadRow } from '../db.js';
import { prepareFiles } from './fileSelection.js';
import { importDownload } from './importer.js';
import { queueMediaWork } from '../playback/jobs.js';

const LOST_AFTER_MS = 10 * 60_000;

function setState(id: number, fields: Partial<DownloadRow>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE downloads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...(Object.values(fields) as (string | number | null)[]),
    now(),
    id,
  );
}

export async function runImport(dl: DownloadRow): Promise<void> {
  if (!dl.content_path) throw new Error('Unknown download location');
  setState(dl.id, { state: 'importing', error: null });
  try {
    const files = dl.torrent_files ? (JSON.parse(dl.torrent_files) as string[]) : undefined;
    await importDownload(dl, dl.content_path, files);
    setState(dl.id, { state: 'imported', progress: 1 });
    // New files: find their intros/credits and make seek-bar thumbnails in the background.
    queueMediaWork(dl.media_id);
  } catch (err) {
    setState(dl.id, { state: 'failed', error: `Import failed: ${(err as Error).message}` });
    logHistory(dl.media_id, 'failed', `Import of "${dl.release_title}" failed: ${(err as Error).message}`);
  }
}

/** Syncs active downloads with qBittorrent and imports finished ones. */
export async function pollDownloads(): Promise<void> {
  const active = db
    .prepare("SELECT * FROM downloads WHERE state IN ('queued','downloading')")
    .all() as unknown as DownloadRow[];
  if (!active.length) return;

  const torrents = await listTorrents();
  const byTag = new Map<string, (typeof torrents)[number]>();
  for (const t of torrents) for (const tag of t.tags.split(',')) byTag.set(tag.trim(), t);

  for (const dl of active) {
    // Skip unwanted files of bundles and give the rest clean names, as soon as qBittorrent knows them.
    const justPrepared = !dl.files_selected && (await prepareFiles(dl.id).catch(() => false));
    const t = byTag.get(dl.tag);
    if (!t) {
      if (dl.state === 'downloading' || Date.now() - new Date(dl.created_at).getTime() > LOST_AFTER_MS) {
        setState(dl.id, { state: 'failed', error: 'Torrent is no longer in qBittorrent' });
        logHistory(dl.media_id, 'failed', `"${dl.release_title}" disappeared from qBittorrent`);
      }
      continue;
    }

    const status = torrentStatus(t);
    const contentPath = t.content_path || path.join(t.save_path, t.name);
    if (status === 'error') {
      setState(dl.id, { state: 'failed', qbit_hash: t.hash, error: `qBittorrent reports ${t.state}` });
      logHistory(dl.media_id, 'failed', `"${dl.release_title}" errored in qBittorrent (${t.state})`);
      continue;
    }
    // Renaming a finished torrent's files happens in the background in qBittorrent: give it a poll to finish.
    if (status === 'downloading' || justPrepared) {
      setState(dl.id, { state: 'downloading', qbit_hash: t.hash, progress: t.progress, content_path: contentPath });
      continue;
    }

    // The exact files to import (by their final names); qBittorrent forgets them once the torrent is removed.
    const files = await torrentFiles(t.hash)
      .then((list) => list.filter((f) => f.priority > 0).map((f) => f.name))
      .catch(() => null);
    const torrentFilesJson = files?.length ? JSON.stringify(files) : null;

    // Done: remove from qBittorrent (keeping files) so Windows releases the file handles, then rename.
    setState(dl.id, {
      state: 'importing',
      qbit_hash: t.hash,
      progress: 1,
      content_path: contentPath,
      save_path: t.save_path,
      torrent_files: torrentFilesJson,
    });
    try {
      await deleteTorrent(t.hash, false);
    } catch (err) {
      setState(dl.id, { state: 'downloading', error: `Could not remove torrent: ${(err as Error).message}` });
      continue;
    }
    await runImport({ ...dl, content_path: contentPath, save_path: t.save_path, torrent_files: torrentFilesJson });
  }
}

// ---- Live progress for the Downloads page ----

let live: { at: number; torrents: Promise<Awaited<ReturnType<typeof listTorrents>>> } | null = null;
const LIVE_MS = 2000;

/** qBittorrent's torrents, asked at most every 2 s however many pages are open. */
function liveTorrents() {
  if (!live || Date.now() - live.at > LIVE_MS) {
    const torrents = listTorrents();
    live = { at: Date.now(), torrents };
    torrents.catch(() => (live = null));
  }
  return live.torrents;
}

export interface LiveDownload {
  progress: number;
  /** Bytes per second; 0 when stalled or paused. */
  speed: number | null;
  /** Seconds left, when qBittorrent can tell. */
  eta: number | null;
}

/**
 * Downloads with their progress as qBittorrent has it right now (the stored value is only updated by the
 * background check). If qBittorrent can't be reached, the stored progress is shown as it is.
 */
export async function withLiveProgress<T extends Pick<DownloadRow, 'tag' | 'state' | 'progress'>>(rows: T[]): Promise<(T & Partial<LiveDownload>)[]> {
  if (!rows.some((r) => r.state === 'queued' || r.state === 'downloading')) return rows;
  let torrents: Awaited<ReturnType<typeof listTorrents>>;
  try {
    torrents = await liveTorrents();
  } catch {
    return rows;
  }
  const byTag = new Map<string, (typeof torrents)[number]>();
  for (const t of torrents) for (const tag of t.tags.split(',')) byTag.set(tag.trim(), t);
  return rows.map((r) => {
    const t = r.state === 'queued' || r.state === 'downloading' ? byTag.get(r.tag) : undefined;
    if (!t) return r;
    // qBittorrent's "infinity" for an unknown ETA is 8640000 s (100 days).
    const eta = t.eta > 0 && t.eta < 8640000 ? t.eta : null;
    return { ...r, progress: Math.max(r.progress, t.progress), speed: t.dlspeed ?? null, eta };
  });
}
