import { db } from './db.js';

export interface Settings {
  tmdbApiKey: string;
  /** Optional: IMDb and Rotten Tomatoes ratings on the details screen (free key from omdbapi.com). */
  omdbApiKey: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  qbitUrl: string;
  qbitUsername: string;
  qbitPassword: string;
  qbitCategory: string;
  /** Library folders per type; new titles go to the first one with room (see chooseRoot). */
  moviesRoots: string[];
  showsRoots: string[];
  animeRoots: string[];
  /** A drive with less free space than this is skipped for new titles while another folder has room. */
  minFreeSpaceGb: number;
  preferredResolution: '2160p' | '1080p' | '720p' | '480p';
  allow4k: boolean;
  minSeeders: number;
  maxMovieSizeGb: number;
  maxEpisodeSizeGb: number;
  monitorIntervalMinutes: number;
  researchIntervalHours: number;
  defaultAnimeAudio: 'sub' | 'dub';
  /** Watchlists: Mediarr's app IDs on Simkl and AniList; each user then connects their own account. */
  simklClientId: string;
  /** Only for Simkl apps registered as "Server apps & services". */
  simklClientSecret: string;
  anilistClientId: string;
  /** Playback: FFmpeg location (empty = find it automatically) and transcoding limits. */
  ffmpegPath: string;
  hwAccel: 'auto' | 'amf' | 'nvenc' | 'qsv' | 'none';
  remoteMaxBitrateMbps: number;
  maxTranscodes: number;
  /** Find intros/credits (chapters, and by comparing a season's episodes) for the Skip buttons. */
  introDetection: boolean;
  /** Thumbnail previews on the seek bar. */
  trickplay: boolean;
  /** Updates: "owner/repo" on GitHub (empty = this folder's Git remote), and whether to look for new releases. */
  updateRepo: string;
  autoCheckUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tmdbApiKey: '',
  omdbApiKey: '',
  prowlarrUrl: 'http://localhost:9696',
  prowlarrApiKey: '',
  qbitUrl: 'http://localhost:8080',
  qbitUsername: 'admin',
  qbitPassword: '',
  qbitCategory: 'mediarr',
  moviesRoots: [],
  showsRoots: [],
  animeRoots: [],
  minFreeSpaceGb: 50,
  preferredResolution: '1080p',
  allow4k: false,
  minSeeders: 1,
  maxMovieSizeGb: 20,
  maxEpisodeSizeGb: 4,
  monitorIntervalMinutes: 30,
  researchIntervalHours: 6,
  defaultAnimeAudio: 'sub',
  simklClientId: '',
  simklClientSecret: '',
  anilistClientId: '',
  ffmpegPath: '',
  hwAccel: 'auto',
  remoteMaxBitrateMbps: 8,
  maxTranscodes: 3,
  introDetection: true,
  trickplay: true,
  updateRepo: '',
  autoCheckUpdates: true,
};

const LEGACY_ROOTS: Record<string, 'moviesRoots' | 'showsRoots' | 'animeRoots'> = {
  moviesRoot: 'moviesRoots',
  showsRoot: 'showsRoots',
  animeRoot: 'animeRoots',
};

export const SECRET_KEYS: (keyof Settings)[] = ['tmdbApiKey', 'omdbApiKey', 'prowlarrApiKey', 'qbitPassword', 'simklClientSecret'];

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const legacy: Record<string, string> = {};
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) s[key] = JSON.parse(value);
    else if (LEGACY_ROOTS[key]) legacy[key] = JSON.parse(value);
  }
  // Before multiple folders, each type had a single folder setting.
  for (const [oldKey, newKey] of Object.entries(LEGACY_ROOTS)) {
    if (!(s[newKey] as string[]).length && legacy[oldKey]) s[newKey] = [legacy[oldKey]];
  }
  return s as unknown as Settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    const def = DEFAULT_SETTINGS[key as keyof Settings];
    const coerced = Array.isArray(def)
      ? [...new Set((Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean))]
      : typeof def === 'number'
        ? Number(value)
        : typeof def === 'boolean'
          ? Boolean(value)
          : value;
    stmt.run(key, JSON.stringify(coerced));
  }
  return getSettings();
}

export const ROOT_KEYS = { movie: 'moviesRoots', show: 'showsRoots', anime: 'animeRoots' } as const;

export function rootsFor(s: Settings, type: 'movie' | 'show' | 'anime'): string[] {
  return s[ROOT_KEYS[type]];
}
