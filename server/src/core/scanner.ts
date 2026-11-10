import fs from 'node:fs';
import path from 'node:path';
import { searchAnime } from '../clients/anilist.js';
import { searchMovies, searchShows, type SearchResult } from '../clients/tmdb.js';
import { db, getEpisodes, getMedia, logHistory, now, type MediaRow, type MediaType } from '../db.js';
import { rootsFor, getSettings } from '../settings.js';
import { isExtra, isInside, isSample, matchFile, walk } from './importer.js';
import { addMedia } from './library.js';
import { normalizeTitle, parseRelease } from './releaseParser.js';

/**
 * Library scan, like Jellyfin's: title folders already in the library folders are identified on
 * TMDB/AniList and added (not downloaded, nothing renamed or moved), and the video files in them are
 * linked to their episodes. Known titles pick up files added by hand and drop files that are gone.
 */

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv|webm|mov)$/i;
/** Folders that are never titles. */
const SKIP = /^(\.|@eaDir$|\$RECYCLE\.BIN$|System Volume Information$|lost\+found$|#recycle$)/i;

export interface FolderGuess {
  title: string;
  year: number | null;
  tmdbId?: number;
  anilistId?: number;
}

/** What a folder name says: "Dune (2021)", "Dune.2021.1080p.BluRay", "Frieren [anilist-154587]", "Severance {tmdb-95396}". */
export function parseFolderName(name: string): FolderGuess {
  const tag = (re: RegExp) => {
    const m = re.exec(name);
    return m ? Number(m[1]) : undefined;
  };
  const tmdbId = tag(/[[{(]\s*tmdb(?:id)?\s*[-=:]\s*(\d+)\s*[\]})]/i);
  const anilistId = tag(/[[{(]\s*anilist(?:id)?\s*[-=:]\s*(\d+)\s*[\]})]/i);
  const bare = name.replace(/[[{(]\s*(?:tmdb|tvdb|imdb|anilist|anidb|mal)(?:id)?\s*[-=:][^\]})]*[\]})]/gi, '').trim();
  const plain = /^(.*?)\s*\((\d{4})\)\s*$/.exec(bare);
  let title: string;
  let year: number | null;
  if (plain) {
    title = plain[1];
    year = Number(plain[2]);
  } else {
    // Release-style ("Dune.2021.1080p.WEB-DL") or just a name ("Frieren").
    const p = parseRelease(bare);
    title = p.title || bare;
    year = p.year;
  }
  title = title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, year, ...(tmdbId ? { tmdbId } : {}), ...(anilistId ? { anilistId } : {}) };
}

/**
 * The search result a folder name confidently refers to, or null (then the user picks it).
 * The name must equal one of the result's titles; with a year, it must agree (±1).
 */
export function pickMatch(guess: FolderGuess, results: SearchResult[]): SearchResult | null {
  const want = normalizeTitle(guess.title);
  if (!want) return null;
  const sameName = results.filter((r) => [r.title, ...(r.altTitles ?? [])].some((t) => normalizeTitle(t) === want));
  if (guess.year) {
    const dated = sameName.filter((r) => r.year && Math.abs(r.year - guess.year!) <= 1);
    return dated[0] ?? null;
  }
  // No year: only when the name is unambiguous.
  return sameName.length === 1 ? sameName[0] : null;
}

const SEARCH: Record<MediaType, (q: string) => Promise<SearchResult[]>> = { movie: searchMovies, show: searchShows, anime: searchAnime };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Linking files ----

/** Records the video files in a title's folder against the title / its episodes. Returns how many were linked. */
export async function linkFiles(m: MediaRow): Promise<number> {
  const dir = path.join(m.root_folder, m.folder_name);
  if (!fs.existsSync(dir)) return 0;
  const videos = (await walk(dir)).filter((f) => VIDEO.test(f.full) && !isSample(f) && !isExtra(path.relative(dir, f.full)));
  if (!videos.length) return 0;

  if (m.type === 'movie') {
    if (m.file_path && fs.existsSync(m.file_path)) return 0;
    const main = videos.reduce((a, b) => (b.size > a.size ? b : a));
    db.prepare('UPDATE media SET has_file = 1, file_path = ? WHERE id = ?').run(main.full, m.id);
    return 1;
  }

  const episodes = getEpisodes(m.id);
  const known = new Set(episodes.filter((e) => e.file_path).map((e) => path.resolve(e.file_path!).toLowerCase()));
  const setFile = db.prepare('UPDATE episodes SET has_file = 1, file_path = ? WHERE id = ?');
  let linked = 0;
  const regular = episodes.filter((e) => e.season > 0);
  for (const v of videos) {
    if (known.has(path.resolve(v.full).toLowerCase())) continue;
    let matched = matchFile(m, path.relative(dir, v.full), episodes, null);
    // A one-episode title (an anime film, a special) whose file has no episode number.
    if (!matched.length && regular.length === 1 && videos.length === 1) matched = regular;
    for (const e of matched.filter((x) => !x.has_file || !x.file_path || !fs.existsSync(x.file_path))) {
      setFile.run(v.full, e.id);
      linked++;
    }
  }
  return linked;
}

/** Files that were deleted outside Mediarr: forget them (only when their library folder is there, so an unplugged drive changes nothing). */
function dropMissing(m: MediaRow): number {
  if (!fs.existsSync(m.root_folder)) return 0;
  let dropped = 0;
  if (m.type === 'movie') {
    if (m.file_path && !fs.existsSync(m.file_path)) {
      db.prepare('UPDATE media SET has_file = 0, file_path = NULL WHERE id = ?').run(m.id);
      dropped++;
    }
    return dropped;
  }
  const clear = db.prepare('UPDATE episodes SET has_file = 0, file_path = NULL WHERE id = ?');
  for (const e of getEpisodes(m.id)) {
    if (e.file_path && !fs.existsSync(e.file_path)) {
      clear.run(e.id);
      dropped++;
    }
  }
  return dropped;
}

// ---- Scanning ----

export interface Unmatched {
  type: MediaType;
  root: string;
  folder: string;
  guess: FolderGuess;
  reason: string;
}

export interface ScanStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Folder being looked at right now ("Movies: Dune (2021)"). */
  current: string | null;
  added: { id: number; type: MediaType; title: string }[];
  /** Files newly linked to titles that were already known. */
  linked: number;
  /** Files that had disappeared from disk. */
  missing: number;
  unmatched: Unmatched[];
  error: string | null;
}

let status: ScanStatus = { running: false, startedAt: null, finishedAt: null, current: null, added: [], linked: 0, missing: 0, unmatched: [], error: null };
export const scanStatus = () => status;

const sameFolder = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const TYPE_LABEL: Record<MediaType, string> = { movie: 'Movies', show: 'Shows', anime: 'Anime' };

/** The title folders in every library folder, and which known title (if any) each belongs to. */
function folders(): { type: MediaType; root: string; folder: string; media: MediaRow | null }[] {
  const library = db.prepare('SELECT * FROM media').all() as unknown as MediaRow[];
  const out: { type: MediaType; root: string; folder: string; media: MediaRow | null }[] = [];
  for (const type of ['movie', 'show', 'anime'] as const) {
    for (const root of rootsFor(getSettings(), type)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue; // folder missing (drive unplugged): leave its titles alone
      }
      for (const e of entries) {
        if (!e.isDirectory() || SKIP.test(e.name)) continue;
        const media = library.find((m) => sameFolder(path.join(m.root_folder, m.folder_name), path.join(root, e.name))) ?? null;
        out.push({ type, root, folder: e.name, media });
      }
    }
  }
  return out;
}

/** Adds an unknown folder as the given TMDB/AniList title and links its files. */
export async function addFolder(type: MediaType, root: string, folder: string, ids: { tmdbId?: number; anilistId?: number }): Promise<MediaRow> {
  const roots = rootsFor(getSettings(), type);
  const dir = path.join(root, folder);
  if (!roots.some((r) => sameFolder(r, root)) || !isInside(dir, root) || path.dirname(path.resolve(dir)).toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw Object.assign(new Error('That folder isn’t one of the library folders.'), { statusCode: 400 });
  }
  if (!fs.existsSync(dir)) throw Object.assign(new Error('That folder no longer exists.'), { statusCode: 404 });
  const id = await addMedia({ type, ...ids, monitored: false, seasons: [], location: { root, folder } });
  const m = getMedia(id)!;
  // Already in the library under another folder (e.g. a duplicate copy): keep the existing one.
  if (!sameFolder(path.join(m.root_folder, m.folder_name), dir)) {
    throw Object.assign(new Error(`“${m.title}” is already in the library at ${path.join(m.root_folder, m.folder_name)}.`), { statusCode: 409 });
  }
  await linkFiles(m);
  return getMedia(id)!;
}

/** One pass over all library folders. Only one runs at a time. */
export async function scanLibrary(opts: { delayMs?: number } = {}): Promise<ScanStatus> {
  if (status.running) return status;
  status = { running: true, startedAt: now(), finishedAt: null, current: null, added: [], linked: 0, missing: 0, unmatched: [], error: null };
  try {
    for (const f of folders()) {
      status.current = `${TYPE_LABEL[f.type]}: ${f.folder}`;
      if (f.media) {
        status.missing += dropMissing(f.media);
        status.linked += await linkFiles(getMedia(f.media.id)!);
        continue;
      }
      const dir = path.join(f.root, f.folder);
      const hasVideo = (await walk(dir).catch(() => [])).some((x) => VIDEO.test(x.full));
      if (!hasVideo) continue; // empty or not a media folder
      const guess = parseFolderName(f.folder);
      try {
        let ids: { tmdbId?: number; anilistId?: number } | null = null;
        if (f.type === 'anime' ? guess.anilistId : guess.tmdbId) {
          ids = f.type === 'anime' ? { anilistId: guess.anilistId } : { tmdbId: guess.tmdbId };
        } else {
          const results = await SEARCH[f.type](guess.title);
          await sleep(opts.delayMs ?? (f.type === 'anime' ? 800 : 250)); // stay well under TMDB/AniList rate limits
          const match = pickMatch(guess, results);
          if (match) ids = f.type === 'anime' ? { anilistId: match.anilistId } : { tmdbId: match.tmdbId };
        }
        if (!ids) {
          status.unmatched.push({ ...f, guess, reason: 'Couldn’t tell which title this is' });
          continue;
        }
        const m = await addFolder(f.type, f.root, f.folder, ids);
        status.added.push({ id: m.id, type: m.type, title: m.title });
        status.linked += m.type === 'movie' ? m.has_file : getEpisodes(m.id).filter((e) => e.has_file).length;
      } catch (err) {
        status.unmatched.push({ ...f, guess, reason: (err as Error).message });
      }
    }
    // Library folders that are gone from disk (whole titles deleted outside Mediarr) are left alone on purpose:
    // removing titles is the user's call.
  } catch (err) {
    status.error = (err as Error).message;
  } finally {
    status.running = false;
    status.current = null;
    status.finishedAt = now();
    if (status.added.length || status.linked || status.missing) {
      logHistory(
        null,
        'scan',
        `Library scan: ${status.added.length} title(s) added, ${status.linked} file(s) found, ${status.missing} missing file(s) removed` +
          (status.unmatched.length ? `, ${status.unmatched.length} folder(s) to identify` : ''),
      );
    }
  }
  return status;
}

/** Identifying a folder by hand (from Settings → Library). */
export async function identifyFolder(type: MediaType, root: string, folder: string, ids: { tmdbId?: number; anilistId?: number }) {
  const m = await addFolder(type, root, folder, ids);
  status.unmatched = status.unmatched.filter((u) => !(u.type === type && sameFolder(u.root, root) && u.folder === folder));
  status.added.push({ id: m.id, type: m.type, title: m.title });
  logHistory(m.id, 'added', `Added ${m.title} from ${path.join(root, folder)} (identified by hand)`);
  return m;
}

let timer: NodeJS.Timeout | null = null;

/** Scans a couple of minutes after start and then every few hours (Settings → Library). */
export function startLibraryScans(afterSettled: () => void = () => {}) {
  const tick = async () => {
    if (getSettings().libraryScanHours > 0) await scanLibrary().catch(() => undefined);
    afterSettled();
  };
  setTimeout(tick, 2 * 60_000).unref();
  timer = setInterval(
    () => {
      const hours = getSettings().libraryScanHours;
      if (hours > 0 && (!status.finishedAt || Date.now() - new Date(status.finishedAt).getTime() >= hours * 3600_000 - 60_000)) void tick();
    },
    15 * 60_000,
  );
  timer.unref();
}
