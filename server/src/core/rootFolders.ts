import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, getEpisodes, getMedia, hasActiveDownload, logHistory, type MediaRow } from '../db.js';
import { getSettings, rootsFor, type Settings } from '../settings.js';

const GB = 1024 ** 3;
/** Never fill a drive to the last byte. */
const SAFETY_MARGIN = GB;

export interface FolderSpace {
  path: string;
  exists: boolean;
  /** Bytes free on the folder's drive, null when it can't be read. */
  freeBytes: number | null;
  totalBytes: number | null;
}

export function folderSpace(p: string): FolderSpace {
  try {
    if (!fs.statSync(p).isDirectory()) return { path: p, exists: false, freeBytes: null, totalBytes: null };
  } catch {
    return { path: p, exists: false, freeBytes: null, totalBytes: null };
  }
  try {
    const st = fs.statfsSync(p);
    return { path: p, exists: true, freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return { path: p, exists: true, freeBytes: null, totalBytes: null };
  }
}

/**
 * Where a newly added title goes, among the folders set for its type:
 * - the one that already has a folder by that name (re-adding keeps things together), else
 * - the first, in the order listed, whose drive has at least the minimum free space, else
 * - the one with the most free space (every drive is getting full).
 * Null when no folder is set.
 */
export function chooseRoot(
  s: Settings,
  type: 'movie' | 'show' | 'anime',
  folder: string,
  space: (p: string) => FolderSpace = folderSpace,
): string | null {
  const roots = rootsFor(s, type);
  if (!roots.length) return null;
  const infos = roots.map(space);
  const existing = infos.find((i) => i.exists && fs.existsSync(path.join(i.path, folder)));
  if (existing) return existing.path;
  const usable = infos.filter((i) => i.exists);
  if (!usable.length) return roots[0];
  const minFree = Math.max(0, s.minFreeSpaceGb) * 1024 ** 3;
  const roomy = usable.find((i) => i.freeBytes === null || i.freeBytes >= minFree);
  if (roomy) return roomy.path;
  return usable.reduce((a, b) => ((b.freeBytes ?? 0) > (a.freeBytes ?? 0) ? b : a)).path;
}

const driveOf = (p: string) => path.parse(path.resolve(p)).root.toLowerCase();
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const gbText = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

/** Bytes that downloads already in flight will still write to the drive holding `p`. */
function pendingBytes(p: string): number {
  const rows = db
    .prepare("SELECT save_path, size, progress FROM downloads WHERE state IN ('queued','downloading') AND size IS NOT NULL")
    .all() as { save_path: string; size: number; progress: number }[];
  return rows.filter((r) => driveOf(r.save_path) === driveOf(p)).reduce((sum, r) => sum + r.size * (1 - r.progress), 0);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(full)));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const f of await listFiles(dir)) total += (await fsp.stat(f).catch(() => null))?.size ?? 0;
  return total;
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

type Placed = Pick<MediaRow, 'type' | 'root_folder' | 'folder_name'>;

/**
 * Every folder a title may keep files in. A movie has one. A show or anime can be split across drives:
 * its own folder, plus a folder with the same name in any of its type's other library folders.
 */
export function titleDirs(m: Placed, opts: { existingOnly?: boolean } = {}): string[] {
  const main = path.join(m.root_folder, m.folder_name);
  if (m.type === 'movie') return [main];
  const others = rootsFor(getSettings(), m.type)
    .filter((r) => !samePath(r, m.root_folder))
    .map((r) => path.join(r, m.folder_name))
    .filter((d) => !opts.existingOnly || fs.existsSync(d));
  return [main, ...others];
}

/** True when `file` is inside one of the title's folders (on any of its drives). */
export const inTitleDirs = (m: Placed, file: string) => titleDirs(m).some((d) => inside(file, d));

/** The title's folder a download was saved into: its own, or the one on the drive it spilled onto. */
export function titleDirFor(m: Placed, savePath: string): string {
  return titleDirs(m).find((d) => samePath(d, savePath)) ?? path.join(m.root_folder, m.folder_name);
}

/**
 * Where a show's or anime's next download goes. Its own drive while that keeps the free space set in
 * Settings (Minimum free space), else the next library folder that does: one already holding part of
 * the series first, then the rest in the order listed. Nothing is moved; the series is just split.
 * When no drive can keep that much free, the drive with the most room left takes it (never filling it).
 */
export function chooseSeriesRoot(m: MediaRow, size: number | null | undefined, space: (p: string) => FolderSpace = folderSpace): string {
  const s = getSettings();
  const others = rootsFor(s, m.type).filter((r) => !samePath(r, m.root_folder));
  const holding = (r: string) => fs.existsSync(path.join(r, m.folder_name));
  const order = [m.root_folder, ...others.filter(holding), ...others.filter((r) => !holding(r))];
  const infos = order.map(space).filter((i) => i.exists);
  if (!infos.length) return m.root_folder;
  if (!size || size <= 0) return infos[0].path;
  const keep = Math.max(SAFETY_MARGIN, Math.max(0, s.minFreeSpaceGb) * GB);
  const left = (i: FolderSpace) => (i.freeBytes === null ? Infinity : i.freeBytes - pendingBytes(i.path) - size);
  const roomy = infos.find((i) => left(i) >= keep);
  if (roomy) return roomy.path;
  const best = infos.reduce((a, b) => (left(b) > left(a) ? b : a));
  if (left(best) >= SAFETY_MARGIN) return best.path;
  throw new Error(
    `Not enough space for "${m.title}": the download needs ${gbText(size)} and no ${m.type === 'show' ? 'Shows' : 'Anime'} folder has room. Free up space or add a folder on another drive in Settings.`,
  );
}

/** Titles whose files are being moved to another library folder right now. */
const moving = new Map<number, Promise<void>>();

/** Resolves once every move in progress has finished. */
export async function movesSettled(): Promise<void> {
  await Promise.all(moving.values());
}

/**
 * Before downloading `size` bytes for a title: if its drive can't take it, move the title to another of
 * its type's library folders (on another drive) with room for the whole title plus the download.
 * Returns the media as it is now (with its new folder). Throws when no folder has room.
 */
export async function ensureRoom(m: MediaRow, size: number | null | undefined, space: (p: string) => FolderSpace = folderSpace): Promise<MediaRow> {
  if (!size || size <= 0) return m;
  const fits = (info: FolderSpace, bytes: number) => info.freeBytes === null || info.freeBytes - pendingBytes(info.path) - bytes >= SAFETY_MARGIN;
  const here = space(m.root_folder);
  if (here.exists && fits(here, size)) return m;

  const oldDir = path.join(m.root_folder, m.folder_name);
  const existing = await folderBytes(oldDir);
  const target = rootsFor(getSettings(), m.type)
    .filter((r) => !samePath(r, m.root_folder))
    .map(space)
    // (A folder on the same drive shares its free space, so it never fits either.)
    .find((info) => info.exists && fits(info, size + existing));
  if (!target) {
    throw new Error(
      `Not enough space for "${m.title}": the download needs ${gbText(size)} and no ${m.type === 'movie' ? 'Movies' : m.type === 'show' ? 'Shows' : 'Anime'} folder has room. Free up space or add a folder on another drive in Settings.`,
    );
  }
  // Files still arriving in the old folder would be left behind.
  if (hasActiveDownload(m.id) || moving.has(m.id)) {
    throw new Error(`Not enough space for "${m.title}" on its drive; it will move to ${target.path} once its current downloads finish.`);
  }
  return relocateMedia(m, target.path);
}

/**
 * Points a title (and its files) at another library folder right away, then moves its existing
 * files there in the background. Files already at the destination are never overwritten.
 */
export function relocateMedia(m: MediaRow, newRoot: string): MediaRow {
  const oldDir = path.join(m.root_folder, m.folder_name);
  const newDir = path.join(newRoot, m.folder_name);
  const moved = (p: string | null) => {
    if (!p) return p;
    const rel = path.relative(oldDir, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(newDir, rel) : p;
  };
  db.prepare('UPDATE media SET root_folder = ?, file_path = ? WHERE id = ?').run(newRoot, moved(m.file_path), m.id);
  const setPath = db.prepare('UPDATE episodes SET file_path = ? WHERE id = ?');
  for (const e of getEpisodes(m.id)) if (e.file_path) setPath.run(moved(e.file_path), e.id);
  logHistory(m.id, 'moved', `Not enough space on ${m.root_folder}: moving "${m.title}" to ${newRoot}`);

  const job = moveTree(oldDir, newDir)
    .then(({ moved: n, kept }) =>
      logHistory(m.id, 'moved', `Moved ${n} file(s) of "${m.title}" to ${newDir}` + (kept ? `; ${kept} left in ${oldDir} (already at the destination)` : '')),
    )
    .catch((err) => logHistory(m.id, 'failed', `Moving "${m.title}" to ${newDir} stopped: ${(err as Error).message}`))
    .finally(() => moving.delete(m.id));
  moving.set(m.id, job);
  return getMedia(m.id)!;
}

/** Moves every file under `from` into `to`, skipping ones that already exist there, then removes emptied folders. */
export async function moveTree(from: string, to: string): Promise<{ moved: number; kept: number }> {
  let moved = 0;
  let kept = 0;
  for (const file of await listFiles(from)) {
    const dest = path.join(to, path.relative(from, file));
    if (fs.existsSync(dest)) {
      kept++;
      continue;
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(file, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      // Another drive: copy, then remove the original only once the copy is complete.
      await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
      await fsp.rm(file);
    }
    moved++;
  }
  await removeEmptyDirs(from);
  return { moved, kept };
}

async function removeEmptyDirs(dir: string): Promise<void> {
  const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!ents) return;
  for (const e of ents) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  if (!(await fsp.readdir(dir).catch(() => ['x'])).length) await fsp.rmdir(dir).catch(() => {});
}
