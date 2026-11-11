import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getSettings, ROOT_KEYS } from '../settings.js';

/**
 * How full each drive with a library folder is, and how much of that is the library itself
 * (everything inside the Movies / Shows / Anime folders). Sizes are added up in the background and
 * kept for a while, since walking a big library takes a moment.
 */

export interface DriveUsage {
  /** "D:" on Windows, the mount's folder elsewhere. */
  label: string;
  totalBytes: number;
  freeBytes: number;
  /** Inside the library folders on this drive. */
  mediaBytes: number;
  /** Which libraries live here ("Movies", "Anime"). */
  libraries: string[];
}

const LABELS = { moviesRoots: 'Movies', showsRoots: 'Shows', animeRoots: 'Anime' } as const;
const TTL_MS = 10 * 60_000;

/** Total size of the files under a folder (symlinks aren't followed; unreadable entries are skipped). */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += await fsp.stat(p).then((s) => s.size, () => 0);
    }
  }
  return total;
}

/** Folders that sit inside another listed folder are counted once, through their parent. */
export function outermost(folders: string[]): string[] {
  const norm = (p: string) => path.resolve(p).toLowerCase() + path.sep;
  return folders.filter((f) => !folders.some((o) => o !== f && norm(f).startsWith(norm(o)) && norm(f) !== norm(o)));
}

const driveLabel = (p: string) => {
  const root = path.parse(path.resolve(p)).root;
  return process.platform === 'win32' ? root.replace(/[\\/]+$/, '') || root : root;
};

async function measure(): Promise<DriveUsage[]> {
  const s = getSettings();
  const drives = new Map<string, DriveUsage & { folders: string[] }>();
  for (const key of Object.values(ROOT_KEYS)) {
    for (const folder of s[key]) {
      let st: fs.StatsFs;
      let dev: number;
      try {
        dev = fs.statSync(folder).dev;
        st = fs.statfsSync(folder);
      } catch {
        continue; // unplugged or missing
      }
      const id = String(dev);
      const d = drives.get(id) ?? {
        label: driveLabel(folder),
        totalBytes: Number(st.blocks) * Number(st.bsize),
        freeBytes: Number(st.bavail) * Number(st.bsize),
        mediaBytes: 0,
        libraries: [],
        folders: [],
      };
      const lib = LABELS[key as keyof typeof LABELS];
      if (lib && !d.libraries.includes(lib)) d.libraries.push(lib);
      d.folders.push(folder);
      drives.set(id, d);
    }
  }
  const out: DriveUsage[] = [];
  for (const d of drives.values()) {
    let media = 0;
    for (const f of outermost(d.folders)) media += await folderBytes(f);
    const used = Math.max(0, d.totalBytes - d.freeBytes);
    out.push({ label: d.label, totalBytes: d.totalBytes, freeBytes: d.freeBytes, mediaBytes: Math.min(media, used), libraries: d.libraries });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

let cached: { at: number; value: DriveUsage[] } | null = null;
let running: Promise<DriveUsage[]> | null = null;

/** Drive usage; measured fresh at most every 10 minutes (one measurement at a time). */
export async function storageUsage(opts: { fresh?: boolean } = {}): Promise<DriveUsage[]> {
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  running ??= measure()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      running = null;
    });
  // An older answer now beats waiting while a big library is walked again.
  return cached && !opts.fresh ? cached.value : running;
}

export const resetStorageCache = () => {
  cached = null;
};
