import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type MediaType = 'movie' | 'show' | 'anime';
export type AnimeAudio = 'sub' | 'dub';
export type DownloadState = 'queued' | 'downloading' | 'importing' | 'imported' | 'failed';

export interface MediaRow {
  id: number;
  type: MediaType;
  tmdb_id: number | null;
  anilist_id: number | null;
  title: string;
  alt_titles: string; // JSON string[]
  year: number | null;
  poster: string | null;
  overview: string | null;
  root_folder: string;
  folder_name: string;
  monitored: number;
  anime_audio: AnimeAudio | null;
  anime_seasons: string | null; // JSON AnimeSeason[]
  status: string | null;
  release_date: string | null;
  has_file: number;
  file_path: string | null;
  last_search: string | null;
  last_refresh: string | null;
  added_at: string;
}

export interface EpisodeRow {
  id: number;
  media_id: number;
  season: number;
  episode: number;
  absolute_number: number | null;
  title: string | null;
  air_date: string | null;
  monitored: number;
  has_file: number;
  file_path: string | null;
  last_search: string | null;
}

export interface DownloadRow {
  id: number;
  media_id: number;
  episode_ids: string; // JSON number[]
  release_title: string;
  indexer: string | null;
  size: number | null;
  qbit_hash: string | null;
  tag: string;
  save_path: string;
  content_path: string | null;
  /** Bundle grabbed for some seasons only: skip the other files in qBittorrent. */
  select_files: number;
  /** 1 once file priorities and clean names were set in qBittorrent (or given up on). */
  files_selected: number;
  /** JSON: paths (relative to save_path) of files qBittorrent was told not to download. */
  skipped_files: string | null;
  /** JSON: video path (relative to save_path) that qBittorrent already gave its clean name -> episode ids it holds ([] = the movie). */
  renamed: string | null;
  /** JSON: paths (relative to save_path) of the files qBittorrent downloaded, saved when it finished. */
  torrent_files: string | null;
  state: DownloadState;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** A bigger pack (e.g. S1–S3) found when the requested season has no pack of its own. */
export interface SuggestionRow {
  id: number;
  media_id: number;
  season: number;
  title: string;
  label: string;
  release: string; // JSON of the release needed to grab it
  status: 'pending' | 'accepted' | 'dismissed';
  created_at: string;
}

export interface HistoryRow {
  id: number;
  media_id: number | null;
  event: string;
  message: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  tmdb_id INTEGER,
  anilist_id INTEGER,
  title TEXT NOT NULL,
  alt_titles TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  poster TEXT,
  overview TEXT,
  root_folder TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  monitored INTEGER NOT NULL DEFAULT 1,
  anime_audio TEXT,
  anime_seasons TEXT,
  status TEXT,
  release_date TEXT,
  has_file INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  last_search TEXT,
  last_refresh TEXT,
  added_at TEXT NOT NULL,
  UNIQUE (type, tmdb_id),
  UNIQUE (type, anilist_id)
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  absolute_number INTEGER,
  title TEXT,
  air_date TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  has_file INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  last_search TEXT,
  UNIQUE (media_id, season, episode)
);
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  episode_ids TEXT NOT NULL DEFAULT '[]',
  release_title TEXT NOT NULL,
  indexer TEXT,
  size INTEGER,
  qbit_hash TEXT,
  tag TEXT NOT NULL DEFAULT '',
  save_path TEXT NOT NULL,
  content_path TEXT,
  select_files INTEGER NOT NULL DEFAULT 0,
  files_selected INTEGER NOT NULL DEFAULT 0,
  skipped_files TEXT,
  renamed TEXT,
  torrent_files TEXT,
  state TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  title TEXT NOT NULL,
  label TEXT NOT NULL,
  release TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_links (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, service)
);
-- Each user's Simkl lists as last synced, so only changes are fetched (Simkl's sync rules).
CREATE TABLE IF NOT EXISTS simkl_sync (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activity_all TEXT,
  activity_removed TEXT,
  items TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- ffprobe results per file, reused while the file is unchanged.
CREATE TABLE IF NOT EXISTS file_probes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  json TEXT NOT NULL
);
-- Detected intros/credits per file (from chapters or by comparing episodes' audio).
CREATE TABLE IF NOT EXISTS media_segments (
  file TEXT NOT NULL,
  kind TEXT NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (file, kind)
);
-- Which files were already analysed (so nothing is redone), with the file's size/mtime at the time.
CREATE TABLE IF NOT EXISTS media_analysis (
  file TEXT NOT NULL,
  what TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (file, what)
);
-- Where each user is in each movie/episode.
CREATE TABLE IF NOT EXISTS watch_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id, episode_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_media ON episodes(media_id);
CREATE INDEX IF NOT EXISTS idx_downloads_state ON downloads(state);
`;

export let db: DatabaseSync;

export function defaultDbPath(): string {
  const dataDir = process.env.MEDIARR_DATA ?? path.resolve(import.meta.dirname, '../../data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'mediarr.db');
}

/** Opens (or creates) the database. Pass ':memory:' in tests. */
export function initDb(file: string = defaultDbPath()): DatabaseSync {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate();
  return db;
}

function migrate() {
  const cols = (db.prepare('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('anime_seasons')) db.exec('ALTER TABLE media ADD COLUMN anime_seasons TEXT');
  const dlCols = (db.prepare('PRAGMA table_info(downloads)').all() as { name: string }[]).map((c) => c.name);
  if (!dlCols.includes('select_files')) {
    db.exec('ALTER TABLE downloads ADD COLUMN select_files INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE downloads ADD COLUMN files_selected INTEGER NOT NULL DEFAULT 0');
  }
  if (!dlCols.includes('skipped_files')) db.exec('ALTER TABLE downloads ADD COLUMN skipped_files TEXT');
  if (!dlCols.includes('renamed')) {
    db.exec('ALTER TABLE downloads ADD COLUMN renamed TEXT');
    db.exec('ALTER TABLE downloads ADD COLUMN torrent_files TEXT');
  }
  // Accounts created before roles existed were the owner's: they become admins.
  const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
}

export const now = () => new Date().toISOString();

export function logHistory(mediaId: number | null, event: string, message: string) {
  db.prepare('INSERT INTO history (media_id, event, message, created_at) VALUES (?, ?, ?, ?)').run(
    mediaId,
    event,
    message,
    now(),
  );
}

export function getMedia(id: number): MediaRow | undefined {
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
}

export function getEpisodes(mediaId: number): EpisodeRow[] {
  return db
    .prepare('SELECT * FROM episodes WHERE media_id = ? ORDER BY season, episode')
    .all(mediaId) as unknown as EpisodeRow[];
}

/** Episode ids that belong to downloads still in flight. */
export function activeEpisodeIds(mediaId: number): Set<number> {
  const rows = db
    .prepare("SELECT episode_ids FROM downloads WHERE media_id = ? AND state IN ('queued','downloading','importing')")
    .all(mediaId) as { episode_ids: string }[];
  const ids = new Set<number>();
  for (const r of rows) for (const id of JSON.parse(r.episode_ids) as number[]) ids.add(id);
  return ids;
}

export function hasActiveDownload(mediaId: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM downloads WHERE media_id = ? AND state IN ('queued','downloading','importing')")
    .get(mediaId);
}
