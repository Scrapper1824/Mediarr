export type MediaType = 'movie' | 'show' | 'anime';

export interface SearchResult {
  type: MediaType;
  tmdbId?: number;
  anilistId?: number;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
  extra?: string;
  /** A TMDB show that is really Japanese anime. */
  isAnime?: boolean;
  libraryId: number | null;
  /** Asked for and waiting for an admin's approval. */
  requested?: boolean;
  /** Anime in filtered lists: has an English dub (null: not known). */
  dubbed?: boolean | null;
}

export interface Media {
  id: number;
  type: MediaType;
  tmdb_id: number | null;
  anilist_id: number | null;
  /** Shows: TMDB's season names by number. */
  season_names: Record<string, string>;
  title: string;
  alt_titles: string[];
  year: number | null;
  poster: string | null;
  /** Wide artwork (TMDB backdrop / AniList banner); empty when the title has none. */
  backdrop: string | null;
  overview: string | null;
  root_folder: string;
  folder_name: string;
  monitored: boolean;
  anime_audio: 'sub' | 'dub' | null;
  anime_seasons: { season: number; title: string; episodes: number; year: number | null; anilistId: number | null }[];
  status: string | null;
  release_date: string | null;
  has_file: boolean;
  file_path: string | null;
  downloading: boolean;
  episodeCount: number;
  episodeFileCount: number;
  pendingSuggestions: number;
  search: { running: boolean; step: string | null; message: string | null; finishedAt: string | null };
}

/** A bigger pack (e.g. S1–S3) offered because the requested season had no pack of its own. */
export interface Suggestion {
  id: number;
  season: number;
  title: string;
  label: string;
  release: {
    title: string;
    indexer: string;
    size: number;
    seeders: number;
    covers: number[];
    resolution: string | null;
    audio: 'sub' | 'dub' | 'dual';
  };
}

export interface Episode {
  id: number;
  season: number;
  episode: number;
  absolute_number: number | null;
  title: string | null;
  air_date: string | null;
  /** What happens (TMDB / Kitsu). */
  overview: string | null;
  /** A still from the episode. */
  still: string | null;
  monitored: boolean;
  has_file: boolean;
  file_path: string | null;
  aired: boolean;
  downloading: boolean;
}

export interface Download {
  id: number;
  media_id: number;
  media_title?: string;
  media_type?: MediaType;
  release_title: string;
  indexer: string | null;
  size: number | null;
  state: 'queued' | 'downloading' | 'importing' | 'imported' | 'failed';
  progress: number;
  error: string | null;
  save_path: string;
  select_files: number;
  created_at: string;
  updated_at: string;
  /** Live from qBittorrent while downloading: bytes per second and seconds left. */
  speed?: number | null;
  eta?: number | null;
}

export interface MediaDetail extends Media {
  episodes: Episode[];
  downloads: Download[];
  suggestions: Suggestion[];
  /** What your Play button starts; null when nothing is downloaded. */
  play: { kind: 'movie' | 'episode'; id: number; label: string | null; episodeTitle: string | null; resume: boolean; minutesLeft: number | null } | null;
}

export interface Release {
  guid: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
  magnetUrl?: string;
  downloadUrl?: string;
  publishDate?: string;
  score: number;
  rejections: string[];
  coverage: 'exact' | 'bundle' | null;
  covers: number[];
  parsed: { resolution: string | null; audio: 'sub' | 'dub' | 'dual'; source: string | null; group: string | null };
}

/** A search you started that came back empty (shown as a popup). */
export interface SearchEvent {
  id: number;
  mediaId: number;
  title: string;
  type: MediaType;
  kind: 'none' | 'idle' | 'error';
  message: string;
  results: number;
  reasons: { reason: string; count: number }[];
  season: number | null;
  at: string;
}

export interface HistoryItem {
  id: number;
  media_id: number | null;
  media_title: string | null;
  event: string;
  message: string;
  created_at: string;
}

export interface Settings {
  tmdbApiKey: string;
  omdbApiKey: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  qbitUrl: string;
  qbitUsername: string;
  qbitPassword: string;
  qbitCategory: string;
  moviesRoots: string[];
  showsRoots: string[];
  animeRoots: string[];
  minFreeSpaceGb: number;
  libraryScanHours: number;
  preferredResolution: string;
  allow4k: boolean;
  minSeeders: number;
  maxMovieSizeGb: number;
  maxEpisodeSizeGb: number;
  monitorIntervalMinutes: number;
  researchIntervalHours: number;
  defaultAnimeAudio: 'sub' | 'dub';
  simklClientId: string;
  simklClientSecret: string;
  anilistClientId: string;
  ffmpegPath: string;
  hwAccel: 'auto' | 'amf' | 'nvenc' | 'qsv' | 'none';
  remoteMaxBitrateMbps: number;
  maxTranscodes: number;
  introDetection: boolean;
  trickplay: boolean;
  autoCheckUpdates: boolean;
}

/** Fired when the server says we're not signed in (e.g. the session expired), so the login screen shows. */
export const UNAUTHORIZED_EVENT = 'mediarr:unauthorized';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'mediarr' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status, data);
  return data as T;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user: { id: number; username: string; role: 'admin' | 'user'; needsApproval: boolean; allowAdult: boolean; totpEnabled: boolean; sessions: number } | null;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export const typeLabel: Record<MediaType, string> = { movie: 'Movies', show: 'Shows', anime: 'Anime' };

// ---- Watchlists (Simkl / AniList) ----

export type WatchStatus = 'watching' | 'planned' | 'completed' | 'paused' | 'dropped';
export type WatchService = 'simkl' | 'anilist';
export const WATCH_STATUSES: WatchStatus[] = ['watching', 'planned', 'completed', 'paused', 'dropped'];
export const watchStatusLabel: Record<WatchStatus, string> = {
  watching: 'Watching',
  planned: 'Plan to watch',
  completed: 'Completed',
  paused: 'On hold',
  dropped: 'Dropped',
};
export const serviceLabel: Record<WatchService, string> = { simkl: 'Simkl', anilist: 'AniList' };

export interface WatchItem {
  key: string;
  type: MediaType;
  status: WatchStatus;
  title: string;
  year: number | null;
  poster: string | null;
  tmdbId?: number;
  anilistId?: number;
  services: Partial<Record<WatchService, WatchStatus>>;
  progress: { watched: number | null; total: number | null } | null;
  libraryId: number | null;
}

export interface WatchLinks {
  simkl: { configured: boolean; connected: boolean; account: string | null };
  anilist: { configured: boolean; connected: boolean; account: string | null; authorizeUrl: string | null };
}

/** The id the watchlist uses for a title: TMDB for movies/shows, AniList for anime. */
export const watchId = (r: { type: MediaType; tmdbId?: number; anilistId?: number }) => (r.type === 'anime' ? r.anilistId : r.tmdbId);

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return 'TBA';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(d: string): string {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
