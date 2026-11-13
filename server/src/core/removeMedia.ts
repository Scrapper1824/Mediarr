import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deleteTorrent } from '../clients/qbittorrent.js';
import { db, getEpisodes, logHistory, type MediaRow } from '../db.js';
import { getSettings, rootsFor } from '../settings.js';
import { isInside } from './importer.js';
import { titleDirs } from './rootFolders.js';

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * What deleting a title's files would remove: its folder on each drive (a split series has several) plus
 * any of its files kept elsewhere. Only ever inside the library folders set for its type, and never a
 * library folder itself.
 */
export function deletablePaths(m: MediaRow): { folders: string[]; files: string[] } {
  const roots = rootsFor(getSettings(), m.type);
  const safe = (p: string) => roots.some((r) => isInside(p, r) && !same(p, r));
  const folders = titleDirs(m, { existingOnly: true }).filter((d) => m.folder_name.trim() && fs.existsSync(d) && safe(d));
  const referenced = [m.file_path, ...getEpisodes(m.id).map((e) => e.file_path)].filter((p): p is string => !!p);
  const files = [...new Set(referenced)].filter((f) => fs.existsSync(f) && safe(f) && !folders.some((d) => isInside(f, d)));
  return { folders, files };
}

async function walk(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walk(full);
      count += sub.count;
      bytes += sub.bytes;
    } else if (ent.isFile()) {
      count++;
      bytes += (await fsp.stat(full).catch(() => null))?.size ?? 0;
    }
  }
  return { count, bytes };
}

/** How much is on disk for a title (for the remove dialog). */
export async function filesSummary(m: MediaRow): Promise<{ count: number; bytes: number; folders: string[] }> {
  const { folders, files } = deletablePaths(m);
  let count = 0;
  let bytes = 0;
  for (const d of folders) {
    const w = await walk(d);
    count += w.count;
    bytes += w.bytes;
  }
  for (const f of files) {
    count++;
    bytes += (await fsp.stat(f).catch(() => null))?.size ?? 0;
  }
  return { count, bytes, folders: [...folders, ...files.map((f) => path.dirname(f))].filter((p, i, a) => a.findIndex((q) => same(p, q)) === i) };
}

const GB = 1024 ** 3;

/**
 * Removes a title from Mediarr. With `deleteFiles`, its downloads still in qBittorrent are cancelled
 * (with their data) and its files are deleted from disk.
 */
export async function removeMedia(m: MediaRow, deleteFiles: boolean, by: string): Promise<{ deleted: number; bytes: number; errors: string[] }> {
  let deleted = 0;
  let bytes = 0;
  const errors: string[] = [];
  if (deleteFiles) {
    const active = db
      .prepare("SELECT qbit_hash FROM downloads WHERE media_id = ? AND state IN ('queued','downloading','importing') AND qbit_hash IS NOT NULL")
      .all(m.id) as { qbit_hash: string }[];
    for (const d of active) await deleteTorrent(d.qbit_hash, true).catch((err) => errors.push(`qBittorrent: ${(err as Error).message}`));
    const summary = await filesSummary(m);
    const { folders, files } = deletablePaths(m);
    for (const p of [...files, ...folders]) {
      try {
        await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      } catch (err) {
        errors.push(`${p}: ${(err as Error).message}`);
      }
    }
    deleted = summary.count;
    bytes = summary.bytes;
  }
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  logHistory(
    null,
    'removed',
    deleteFiles
      ? `${by} removed ${m.title} and deleted its files (${deleted} file(s), ${(bytes / GB).toFixed(1)} GB)${errors.length ? `; some couldn't be deleted` : ''}`
      : `${by} removed ${m.title} from the library (files kept)`,
  );
  return { deleted, bytes, errors };
}
