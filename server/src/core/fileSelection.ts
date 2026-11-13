import fs from 'node:fs';
import path from 'node:path';
import { listTorrents, renameFile, setFilePriority, torrentFiles, type QbitFile } from '../clients/qbittorrent.js';
import { db, getEpisodes, getMedia, logHistory, now, type DownloadRow, type EpisodeRow, type MediaRow } from '../db.js';
import { isExtra, matchFile, releaseFallbackSeason } from './importer.js';
import { episodeFileName, movieFileName, sanitize, seasonFolder } from './naming.js';
import { parseRelease } from './releaseParser.js';
import { titleDirFor } from './rootFolders.js';

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv|webm|mov)$/i;
const SUBS = /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i;
/** Small companions (subtitles, fonts) next to a kept episode are kept too. */
const COMPANION_MAX_BYTES = 50 * 1024 ** 2;

export interface FilePlan {
  skip: number[];
  keepVideos: number;
  /** Videos skipped because they are other seasons' episodes or extras (OVA/OAD, NCOP, featurettes…). */
  skipVideos: number;
  /** Videos Mediarr couldn't identify; they're downloaded to be safe. */
  unknownVideos: number;
  seasons: number[];
}

/**
 * Which files of a pack/bundle to skip so only the wanted episodes download.
 * Only files that are definitely unwanted are skipped: episodes of other seasons, and extras.
 * Videos that can't be identified are kept. Null when no wanted episode could be found at all.
 */
/** How a torrent's files are laid out: its own top folder (if every file shares one) and the season to assume. */
function torrentLayout(m: MediaRow, releaseTitle: string, wanted: Set<number>, episodes: EpisodeRow[], files: QbitFile[]) {
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  const sharedTop = tops.size === 1 && !tops.has('') ? [...tops][0] : null;
  // The torrent's own folder ("[Group] Show (Season 1 + OADs) [BD]") is only a season hint: its words
  // ("OADs", "Specials") describe the whole pack, not each file, so it never counts for extras.
  const top = sharedTop ? parseRelease(sharedTop) : null;
  const topSeason = top && (top.seasons.length === 1 ? top.seasons[0] : top.episodes.length === 0 ? top.season : null);
  return {
    sharedTop,
    fallback: topSeason ?? releaseFallbackSeason(m, releaseTitle, wanted, episodes),
    inner: (name: string) => (sharedTop ? name.slice(sharedTop.length + 1) : name),
  };
}

export function planFileSelection(m: MediaRow, dl: Pick<DownloadRow, 'episode_ids' | 'release_title'>, files: QbitFile[]): FilePlan | null {
  const episodes = getEpisodes(m.id);
  const wanted = new Set(JSON.parse(dl.episode_ids) as number[]);
  const { fallback, inner } = torrentLayout(m, dl.release_title, wanted, episodes, files);

  const keepDirs = new Map<string, string[]>(); // dir -> kept video base names
  const keep = new Set<number>();
  const seasons = new Set<number>();
  let skipVideos = 0;
  let unknownVideos = 0;
  let wantedFound = 0;
  const keepVideo = (f: QbitFile) => {
    keep.add(f.index);
    const dir = path.posix.dirname(f.name);
    keepDirs.set(dir, [...(keepDirs.get(dir) ?? []), path.posix.basename(f.name).replace(/\.[^.]+$/, '')]);
  };
  for (const f of files) {
    if (!VIDEO.test(f.name)) continue;
    const rel = inner(f.name);
    if (isExtra(rel)) {
      skipVideos++;
      continue;
    }
    const matched = matchFile(m, rel, episodes, fallback);
    if (matched.some((e) => wanted.has(e.id))) {
      keepVideo(f);
      wantedFound++;
      matched.forEach((e) => seasons.add(e.season));
    } else if (matched.length) {
      skipVideos++; // identified as an episode you didn't ask for
    } else {
      keepVideo(f); // can't tell what it is: download rather than risk losing an episode
      unknownVideos++;
    }
  }
  if (!wantedFound) return null;

  for (const f of files) {
    if (VIDEO.test(f.name) || f.size > COMPANION_MAX_BYTES) continue;
    const dir = path.posix.dirname(f.name);
    const base = path.posix.basename(f.name);
    // Subtitles named after a kept episode, or loose files in a kept episode's folder.
    const kept = keepDirs.get(dir);
    const parentKept = [...keepDirs.keys()].some((d) => path.posix.dirname(dir) === d && /sub/i.test(path.posix.basename(dir)));
    if ((kept && (kept.some((k) => base.startsWith(k)) || !/\.(srt|ass|ssa|sub|idx|vtt|sup)$/i.test(base))) || parentKept) keep.add(f.index);
  }
  return {
    skip: files.filter((f) => !keep.has(f.index)).map((f) => f.index),
    keepVideos: files.filter((f) => keep.has(f.index) && VIDEO.test(f.name)).length,
    skipVideos,
    unknownVideos,
    seasons: [...seasons].sort((a, b) => a - b),
  };
}

export interface RenamePlan {
  /** qBittorrent renames, both paths relative to the save path. */
  renames: { from: string; to: string }[];
  /** Clean video path (relative to the save path) -> episode ids it holds ([] = the movie). */
  targets: Record<string, number[]>;
}

const isSampleFile = (f: QbitFile) => /(^|[\W_])sample([\W_]|$)/i.test(path.posix.basename(f.name)) && f.size < 500 * 1024 ** 2;

/**
 * Clean names for a torrent's files, so qBittorrent writes them straight into the media's folder:
 * `Season 01/Show - S01E05 - Title.mkv`, `Dune (2021) [1080p].mkv`. Subtitles follow their video.
 * Files that already exist on disk are left alone (the import replaces them once the download is complete),
 * and anything not renamed (nfo, samples, extras, skipped files) is kept in a folder of its own that's
 * cleaned up after import, so it never litters the media's folder.
 */
export function planRenames(
  m: MediaRow,
  dl: Pick<DownloadRow, 'episode_ids' | 'release_title' | 'select_files' | 'save_path'>,
  files: QbitFile[],
  skip: Set<number> = new Set(),
  exists: (absPath: string) => boolean = fs.existsSync,
): RenamePlan {
  const plan: RenamePlan = { renames: [], targets: {} };
  const mediaDir = titleDirFor(m, dl.save_path);
  const episodes = getEpisodes(m.id);
  const wanted = new Set(JSON.parse(dl.episode_ids) as number[]);
  const { sharedTop, fallback, inner } = torrentLayout(m, dl.release_title, wanted, episodes, files);
  const renamed = new Set<number>();
  const used = new Set<string>();
  const relToSave = (abs: string) => {
    const rel = path.relative(dl.save_path, abs);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
  };

  const rename = (f: QbitFile, abs: string): string | null => {
    const to = relToSave(abs);
    if (!to || used.has(to.toLowerCase()) || exists(abs)) return null;
    used.add(to.toLowerCase());
    renamed.add(f.index);
    if (to !== f.name) plan.renames.push({ from: f.name, to });
    return to;
  };
  const assign = (video: QbitFile, destNoExt: string, episodeIds: number[]) => {
    const to = rename(video, destNoExt + path.posix.extname(video.name).toLowerCase());
    if (!to) return;
    plan.targets[to] = episodeIds;
    const dir = path.posix.dirname(video.name);
    const base = path.posix.basename(video.name).replace(/\.[^.]+$/, '');
    for (const sub of files) {
      const name = path.posix.basename(sub.name);
      if (skip.has(sub.index) || !SUBS.test(name) || path.posix.dirname(sub.name) !== dir || !name.startsWith(base)) continue;
      rename(sub, destNoExt + name.slice(base.length));
    }
  };

  const videos = files.filter((f) => !skip.has(f.index) && VIDEO.test(f.name) && !isSampleFile(f) && !isExtra(inner(f.name)));
  if (m.type === 'movie') {
    if (videos.length) {
      const main = videos.reduce((a, b) => (b.size > a.size ? b : a));
      const res = parseRelease(path.posix.basename(main.name)).resolution ?? parseRelease(dl.release_title).resolution;
      assign(main, path.join(mediaDir, movieFileName(m.folder_name, res, '')), []);
    }
  } else {
    for (const v of videos) {
      const matched = matchFile(m, inner(v.name), episodes, fallback)
        // Same rule as the import: never replace episodes you already have unless this download was meant for them.
        .filter((e) => (dl.select_files ? wanted.has(e.id) : !e.has_file || wanted.has(e.id)));
      if (!matched.length) continue;
      const season = matched[0].season;
      const nums = matched.map((e) => e.episode).sort((a, b) => a - b);
      const name = episodeFileName(m.folder_name, season, nums, matched[0].title, '');
      assign(v, path.join(mediaDir, seasonFolder(season), name), matched.map((e) => e.id));
    }
  }

  // A torrent without a folder of its own: park the rest in one named after the release.
  if (!sharedTop) {
    const holding = sanitize(dl.release_title);
    for (const f of files) if (!renamed.has(f.index)) plan.renames.push({ from: f.name, to: `${holding}/${f.name}` });
  }
  return plan;
}

const markPrepared = (id: number) => db.prepare('UPDATE downloads SET files_selected = 1, updated_at = ? WHERE id = ?').run(now(), id);

/**
 * Once qBittorrent knows a torrent's files: switches off the unwanted ones of a bundle and gives the
 * rest their clean names. Returns true when finished (or not needed), false when qBittorrent doesn't
 * have the file list yet (magnet metadata still loading).
 */
export async function prepareFiles(dlId: number): Promise<boolean> {
  const dl = db.prepare('SELECT * FROM downloads WHERE id = ?').get(dlId) as DownloadRow | undefined;
  if (!dl || dl.files_selected || !['queued', 'downloading'].includes(dl.state)) return true;
  const m = getMedia(dl.media_id);
  if (!m) return true;

  let hash = dl.qbit_hash;
  if (!hash) {
    const t = (await listTorrents()).find((x) => x.tags.split(',').map((s) => s.trim()).includes(dl.tag));
    if (!t) return false;
    hash = t.hash;
    db.prepare('UPDATE downloads SET qbit_hash = ? WHERE id = ?').run(hash, dl.id);
  }
  const files = await torrentFiles(hash);
  if (!files.length) return false;

  let skip = new Set<number>();
  if (dl.select_files) {
    const plan = planFileSelection(m, dl, files);
    if (!plan) {
      logHistory(m.id, 'grabbed', `Couldn't tell which files in "${dl.release_title}" are the wanted episodes, so all of it is downloading`);
    } else {
      try {
        await setFilePriority(hash, plan.skip, 0);
      } catch (err) {
        if ((err as { status?: number }).status === 409) return false; // metadata not ready yet
        throw err;
      }
      skip = new Set(plan.skip);
      const label = plan.seasons.map((s) => `Season ${s}`).join(', ');
      if (plan.skip.length) {
        logHistory(
          m.id,
          'grabbed',
          `Only downloading ${label}: ${plan.keepVideos} episode file(s) kept, ${plan.skipVideos} other episode(s)/extra(s) skipped` +
            (plan.unknownVideos ? ` (${plan.unknownVideos} unrecognised file(s) kept to be safe)` : ''),
        );
      }
    }
  }

  const { renames, targets } = planRenames(m, dl, files, skip);
  const newName = new Map<string, string>();
  let failed = 0;
  for (const r of renames) {
    try {
      await renameFile(hash, r.from, r.to);
      newName.set(r.from, r.to);
    } catch (err) {
      // Not fatal: the import moves anything qBittorrent couldn't rename.
      failed++;
      delete targets[r.to];
      console.warn(`[files] rename "${r.from}" failed: ${(err as Error).message}`);
    }
  }
  const skippedNames = files.filter((f) => skip.has(f.index)).map((f) => newName.get(f.name) ?? f.name);
  db.prepare('UPDATE downloads SET skipped_files = ?, renamed = ? WHERE id = ?').run(
    skippedNames.length ? JSON.stringify(skippedNames) : null,
    JSON.stringify(targets),
    dl.id,
  );
  markPrepared(dl.id);
  const clean = Object.keys(targets).length;
  if (clean) logHistory(m.id, 'grabbed', `qBittorrent is saving ${clean} file(s) under clean names in ${path.join(m.root_folder, m.folder_name)}`);
  if (failed) logHistory(m.id, 'grabbed', `qBittorrent couldn't rename ${failed} file(s); they'll be renamed after the download`);
  return true;
}

/** Right after a grab: keep trying for a few minutes until qBittorrent knows the file list. */
export function watchFiles(dlId: number) {
  let tries = 0;
  const tick = async () => {
    try {
      if (await prepareFiles(dlId)) return;
    } catch (err) {
      console.warn(`[files] ${(err as Error).message}`);
    }
    if (++tries < 90) setTimeout(tick, 2000);
  };
  setTimeout(tick, 1000);
}
