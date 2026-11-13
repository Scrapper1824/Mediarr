import fs from 'node:fs/promises';
import path from 'node:path';
import { db, getEpisodes, getMedia, logHistory, type DownloadRow, type EpisodeRow, type MediaRow } from '../db.js';
import { matchAnime } from './animeMatch.js';
import { seasonsFor } from './library.js';
import { episodeFileName, movieFileName, seasonFolder } from './naming.js';
import { parseRelease } from './releaseParser.js';
import { titleDirFor } from './rootFolders.js';

const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.wmv', '.webm', '.mov']);
const SUBS = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.sup']);

interface FoundFile {
  full: string;
  size: number;
}

export async function walk(p: string): Promise<FoundFile[]> {
  const st = await fs.stat(p);
  if (st.isFile()) return [{ full: p, size: st.size }];
  const out: FoundFile[] = [];
  for (const ent of await fs.readdir(p, { withFileTypes: true })) {
    out.push(...(await walk(path.join(p, ent.name))));
  }
  return out;
}

export const isSample = (f: FoundFile) => /(^|[\W_])sample([\W_]|$)/i.test(path.basename(f.full)) && f.size < 500 * 1024 ** 2;

/**
 * Bonus material that ships inside season packs and bundles: creditless openings/endings, OVAs,
 * trailers, featurettes. These must never be matched to (and overwrite) a real episode.
 */
const EXTRAS =
  /(^|[\W_])(nc ?op|nc ?ed|creditless|(?:op|ed)\s?\d{1,2}(?:v\d)?|extras?|bonus|featurettes?|behind[\W_]the[\W_]scenes|deleted[\W_]scenes|interviews?|trailers?|teasers?|promos?|pv\s?\d*|cm\s?\d*|menus?|previews?|specials?|sp\s?\d{1,2}|ovas?\s?\d*|oads?\s?\d*|omake|recap|picture[\W_]drama)([\W_]|$)/i;

export function isExtra(relPath: string): boolean {
  const p = parseRelease(path.basename(relPath));
  if (p.season === 0) return false; // explicit S00Exx specials are real episodes
  return EXTRAS.test(relPath.replace(/\.[^.]+$/, ''));
}

/** Season named by the folders in a relative path ("Season 2/x.mkv", "S02/x.mkv", "Show 2nd Season/x.mkv"). */
export function seasonFromDirs(relPath: string): number | null {
  const dirs = relPath.split(/[\\/]/).slice(0, -1);
  for (const dir of dirs.reverse()) {
    const p = parseRelease(dir);
    if (p.season !== null && p.episodes.length === 0) return p.season;
    if (p.seasons.length === 1) return p.seasons[0];
  }
  return null;
}

/** Season to assume for files whose own name doesn't say (from the release name or what the download was for). */
export function releaseFallbackSeason(m: MediaRow, releaseTitle: string, episodeIds: Set<number>, episodes: EpisodeRow[]): number | null {
  const releaseMatch = m.type === 'anime' ? matchAnime(parseRelease(releaseTitle), seasonsFor(m)) : null;
  const dlSeasons = new Set(episodes.filter((e) => episodeIds.has(e.id)).map((e) => e.season));
  return (
    (releaseMatch?.seasons.length === 1 ? releaseMatch.seasons[0] : null) ??
    parseRelease(releaseTitle).season ??
    (dlSeasons.size === 1 ? [...dlSeasons][0] : null)
  );
}

/**
 * Episodes a file in a download holds, from its path inside the download
 * ("Season 2/[Group] Show - 05.mkv"). Extras never match.
 */
export function matchFile(m: MediaRow, relPath: string, episodes: EpisodeRow[], fallbackSeason: number | null): EpisodeRow[] {
  if (isExtra(relPath)) return [];
  return matchEpisodes(m, path.basename(relPath), episodes, seasonFromDirs(relPath) ?? fallbackSeason);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Moves a file, retrying while Windows still has it locked, falling back to copy across drives. */
export async function moveFile(from: string, to: string): Promise<void> {
  if (path.resolve(from) === path.resolve(to)) return;
  // On Windows a case-only rename points at the same file, so the destination must not be removed first.
  const sameFile = path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase();
  await fs.mkdir(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      if (!sameFile) await fs.rm(to, { force: true });
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
        return;
      }
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && attempt < 5) {
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }
}

/** Subtitle files next to a video that share its base name, e.g. "video.en.srt". */
function companionSubs(video: string, files: FoundFile[]): { file: string; suffix: string }[] {
  const base = path.basename(video, path.extname(video));
  const dir = path.dirname(video);
  return files
    .filter((f) => SUBS.has(path.extname(f.full).toLowerCase()) && path.dirname(f.full) === dir)
    .filter((f) => path.basename(f.full).startsWith(base))
    .map((f) => ({ file: f.full, suffix: path.basename(f.full).slice(base.length) }));
}

function matchEpisodes(m: MediaRow, fileName: string, episodes: EpisodeRow[], fallbackSeason: number | null): EpisodeRow[] {
  const p = parseRelease(fileName);
  if (m.type === 'anime') {
    const match = matchAnime(p, seasonsFor(m), fallbackSeason);
    if (!match?.episodes) return [];
    // One file holds episodes of one season; multi-season matches come from absolute numbering.
    const season = match.episodes[0].season;
    const nums = match.episodes.filter((x) => x.season === season).map((x) => x.episode);
    return episodes.filter((e) => e.season === season && nums.includes(e.episode));
  }
  const season = p.season ?? fallbackSeason;
  const nums = p.episodes.length ? p.episodes : p.absoluteEpisodes;
  if (season === null || !nums.length) return [];
  return episodes.filter((e) => e.season === season && nums.includes(e.episode));
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
}

/**
 * Puts a completed download into the media's clean folder. Files qBittorrent already saved under their
 * clean names just get recorded; anything else is matched and moved/renamed here.
 * `files` are the torrent's downloaded files relative to the save path (when known), so only this
 * torrent's files are touched even though it was saved inside the media's own folder.
 */
export async function importDownload(dl: DownloadRow, contentPath: string, files?: string[]): Promise<ImportResult> {
  const m = getMedia(dl.media_id);
  if (!m) throw new Error('Media for this download no longer exists');
  // The series folder on the drive this download was saved to (a series can be split across drives).
  const mediaDir = titleDirFor(m, dl.save_path);

  const renamedRels = Object.keys(JSON.parse(dl.renamed ?? '{}') as Record<string, number[]>);
  let found: FoundFile[];
  if (files) {
    found = [];
    // Files qBittorrent was told to rename are this torrent's too, even if its final file list left them out.
    for (const rel of new Set([...files, ...renamedRels])) {
      const full = path.join(dl.save_path, rel);
      if (!isInside(full, dl.save_path)) continue;
      const st = await fs.stat(full).catch(() => null);
      if (st?.isFile()) found.push({ full, size: st.size });
    }
  } else {
    if (!isInside(contentPath, dl.save_path) && path.resolve(contentPath) !== path.resolve(dl.save_path)) {
      throw new Error(`Download is at ${contentPath}, outside the expected folder ${dl.save_path}`);
    }
    // Without the torrent's file list, never sweep the media's whole folder (it holds earlier downloads too).
    if (isInside(mediaDir, contentPath) || path.resolve(contentPath) === path.resolve(mediaDir)) {
      throw new Error(`Can't tell which files in ${contentPath} belong to this download`);
    }
    found = await walk(contentPath);
  }
  const videos = found.filter((f) => VIDEO.has(path.extname(f.full).toLowerCase()) && !isSample(f));
  if (!videos.length) throw new Error('No video files found in download');

  // Videos qBittorrent already saved under their clean name -> the episode ids they hold ([] = the movie).
  const placed = new Map<string, number[]>();
  for (const [rel, ids] of Object.entries(JSON.parse(dl.renamed ?? '{}') as Record<string, number[]>)) {
    placed.set(path.resolve(dl.save_path, rel).toLowerCase(), ids);
  }
  const placedIds = (v: FoundFile) => placed.get(path.resolve(v.full).toLowerCase());

  const result: ImportResult = { imported: [], skipped: [] };
  const releaseRes = parseRelease(dl.release_title).resolution;
  const removeOld = async (oldPath: string | null, dest: string) => {
    if (oldPath && path.resolve(oldPath).toLowerCase() !== path.resolve(dest).toLowerCase()) await fs.rm(oldPath, { force: true }).catch(() => {});
  };

  const moveWithSubs = async (video: string, destNoExt: string) => {
    const dest = destNoExt + path.extname(video).toLowerCase();
    for (const sub of companionSubs(video, found)) await moveFile(sub.file, destNoExt + sub.suffix);
    await moveFile(video, dest);
    result.imported.push(dest);
    return dest;
  };

  if (m.type === 'movie') {
    const ready = videos.find((v) => placedIds(v));
    let dest: string;
    if (ready) {
      dest = ready.full;
      await removeOld(m.file_path, dest);
      result.imported.push(dest);
    } else {
      const main = videos.reduce((a, b) => (b.size > a.size ? b : a));
      const res = parseRelease(path.basename(main.full)).resolution ?? releaseRes;
      const destNoExt = path.join(mediaDir, movieFileName(m.folder_name, res, ''));
      await removeOld(m.file_path, destNoExt + path.extname(main.full).toLowerCase());
      dest = await moveWithSubs(main.full, destNoExt);
    }
    db.prepare('UPDATE media SET has_file = 1, file_path = ? WHERE id = ?').run(dest, m.id);
    for (const v of videos) if (path.resolve(v.full) !== path.resolve(dest)) result.skipped.push(v.full);
  } else {
    const episodes = getEpisodes(m.id);
    const dlEpisodeIds = new Set(JSON.parse(dl.episode_ids) as number[]);
    const fallbackSeason = releaseFallbackSeason(m, dl.release_title, dlEpisodeIds, episodes);
    const setFile = db.prepare('UPDATE episodes SET has_file = 1, file_path = ? WHERE id = ?');
    const done = new Set<number>();

    for (const v of videos) {
      const ids = placedIds(v);
      if (!ids) continue;
      for (const e of episodes.filter((x) => ids.includes(x.id))) {
        await removeOld(e.file_path, v.full);
        setFile.run(v.full, e.id);
        done.add(e.id);
      }
      result.imported.push(v.full);
    }

    const base = files ? dl.save_path : contentPath;
    for (const v of videos) {
      if (placedIds(v)) continue;
      // A season folder inside a bundle ("Season 2/") beats the release-level guess.
      const matched = matchFile(m, path.relative(base, v.full) || path.basename(v.full), episodes, fallbackSeason)
        // Bundles may repeat seasons you already have: keep existing files unless this download was meant for them.
        // When only some files were downloaded on purpose, the skipped (partial) ones are never imported.
        .filter((e) => !done.has(e.id) && (dl.select_files ? dlEpisodeIds.has(e.id) : !e.has_file || dlEpisodeIds.has(e.id)));
      if (!matched.length) {
        result.skipped.push(v.full);
        continue;
      }
      const nums = matched.map((e) => e.episode).sort((a, b) => a - b);
      const season = matched[0].season;
      const destNoExt = path.join(mediaDir, seasonFolder(season), episodeFileName(m.folder_name, season, nums, matched[0].title, ''));
      for (const e of matched) await removeOld(e.file_path, destNoExt + path.extname(v.full).toLowerCase());
      const dest = await moveWithSubs(v.full, destNoExt);
      for (const e of matched) {
        setFile.run(dest, e.id);
        done.add(e.id);
      }
    }
    if (!result.imported.length) throw new Error('Could not match any files to episodes');
  }

  // Clean up what's left of the torrent's own folder (nfo, samples, etc.) unless unmatched videos remain.
  const skippedNames = JSON.parse(dl.skipped_files ?? '[]') as string[];
  let leftoverDirs: string[];
  if (files) {
    // The torrent's own top folders, never one holding the files that were just put in place (e.g. "Season 01").
    const topOf = (rel: string) => (/[\\/]/.test(rel) ? rel.split(/[\\/]/)[0] : null);
    const keepTops = new Set(result.imported.map((f) => topOf(path.relative(dl.save_path, f))?.toLowerCase()));
    const tops = new Set([...files, ...skippedNames].map(topOf).filter((t): t is string => !!t && !keepTops.has(t.toLowerCase())));
    leftoverDirs = [...tops].map((t) => path.join(dl.save_path, t));
  } else {
    leftoverDirs = [contentPath];
  }
  for (const dir of leftoverDirs) {
    const st = await fs.stat(dir).catch(() => null);
    const leftoverIsSafe =
      st?.isDirectory() &&
      isInside(dir, path.dirname(mediaDir)) &&
      !isInside(mediaDir, dir) &&
      path.resolve(dir) !== path.resolve(mediaDir) &&
      !result.imported.some((f) => isInside(f, dir));
    if (!leftoverIsSafe) continue;
    // Leftover extras (NCOP/NCED, trailers...) don't count as content worth keeping.
    const remaining = (await walk(dir)).filter(
      (f) => VIDEO.has(path.extname(f.full).toLowerCase()) && !isSample(f) && !isExtra(path.relative(dir, f.full)),
    );
    // A bundle downloaded for some seasons only leaves fragments of the files we told qBittorrent to skip.
    // Only when every leftover video is one of exactly those is the folder junk (never guess here).
    const skipped = new Set(skippedNames.map((n) => n.toLowerCase()));
    // qBittorrent's "keep unselected files in .unwanted folder" option moves them into a ".unwanted" subfolder.
    const relToSave = (full: string) =>
      path.relative(dl.save_path, full).split(path.sep).filter((p) => p !== '.unwanted').join('/').toLowerCase();
    const onlySkippedLeft = skipped.size > 0 && remaining.every((f) => skipped.has(relToSave(f.full)));
    if (!remaining.length || onlySkippedLeft) await fs.rm(dir, { recursive: true, force: true });
  }

  logHistory(
    m.id,
    'imported',
    `Imported ${result.imported.length} file(s) from "${dl.release_title}"${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`,
  );
  return result;
}
