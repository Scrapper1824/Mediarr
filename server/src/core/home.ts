import { db, getEpisodes, getMedia, type EpisodeRow, type MediaRow, type MediaType } from '../db.js';

/**
 * The Home page: what you're watching and what's downloaded, across movies, shows and anime.
 * Everything here is per user (progress) or the shared library (titles with files).
 */

/** A title on the Home page: enough for a card, the banner and the info popup. */
export interface HomeTitle {
  mediaId: number;
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  tmdbId?: number;
  anilistId?: number;
  /** When its newest file arrived (download import, or when a library scan found it). */
  addedAt: string;
  /** Series: downloaded episodes. */
  episodeFiles: number;
}

export interface PlayTarget {
  kind: 'movie' | 'episode';
  id: number;
  /** "S01E05", or null for a movie. */
  label: string | null;
  episodeTitle: string | null;
  resume: boolean;
  position: number;
  duration: number;
  minutesLeft: number | null;
}

export interface ContinueItem extends HomeTitle, PlayTarget {
  upNext: boolean;
  updatedAt: string;
}

/** A poster on Home: what clicking it plays (null if nothing can be played). */
export interface PlayableTitle extends HomeTitle {
  play: PlayTarget | null;
}

export interface FeaturedItem extends HomeTitle {
  play: PlayTarget;
  /** Why it is in the banner: partway through, the next episode of something you watch, or newly downloaded. */
  reason: 'continue' | 'upnext' | 'new';
}

interface ProgressRow {
  media_id: number;
  episode_id: number;
  position: number;
  duration: number;
  watched: number;
  updated_at: string;
}

const epLabel = (e: EpisodeRow) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
const minutesLeft = (position: number, duration: number) => (duration > 0 ? Math.max(1, Math.round((duration - position) / 60)) : null);

/** Episodes you can play, in watching order (specials last are skipped entirely). */
export function playableEpisodes(mediaId: number): EpisodeRow[] {
  return getEpisodes(mediaId).filter((e) => e.has_file && e.file_path && e.season > 0);
}

const LAST_ADDED = `COALESCE((SELECT MAX(h.created_at) FROM history h WHERE h.media_id = m.id AND h.event = 'imported'), m.added_at)`;
const HAS_FILES = `(m.has_file = 1 OR EXISTS (SELECT 1 FROM episodes e WHERE e.media_id = m.id AND e.has_file = 1 AND e.file_path IS NOT NULL))`;

function toTitle(m: MediaRow & { last_added?: string; episode_files?: number }): HomeTitle {
  return {
    mediaId: m.id,
    type: m.type,
    title: m.title,
    year: m.year,
    poster: m.poster,
    backdrop: m.backdrop || null,
    overview: m.overview ?? '',
    tmdbId: m.tmdb_id ?? undefined,
    anilistId: m.anilist_id ?? undefined,
    addedAt: m.last_added ?? m.added_at,
    episodeFiles: m.episode_files ?? 0,
  };
}

/** Titles with something downloaded, newest first. */
export function downloadedTitles(opts: { type?: MediaType; limit: number }): HomeTitle[] {
  const rows = db
    .prepare(
      `SELECT m.*, ${LAST_ADDED} AS last_added,
         (SELECT COUNT(*) FROM episodes e WHERE e.media_id = m.id AND e.has_file = 1 AND e.season > 0) AS episode_files
       FROM media m WHERE ${HAS_FILES} ${opts.type ? 'AND m.type = ?' : ''}
       ORDER BY last_added DESC, m.id DESC LIMIT ?`,
    )
    .all(...(opts.type ? [opts.type, opts.limit] : [opts.limit])) as unknown as (MediaRow & { last_added: string; episode_files: number })[];
  return rows.map(toTitle);
}

const titleOf = (media: MediaRow): HomeTitle => toTitle(media);

/**
 * Continue watching (started, not finished) and up next (the episode after the last one you finished),
 * one entry per title, most recently watched first.
 */
export function continueWatching(userId: number, limit = 20): ContinueItem[] {
  const rows = db
    .prepare('SELECT media_id, episode_id, position, duration, watched, updated_at FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300')
    .all(userId) as unknown as ProgressRow[];
  const seen = new Set<number>();
  const items: ContinueItem[] = [];
  for (const r of rows) {
    if (seen.has(r.media_id)) continue;
    const media = getMedia(r.media_id);
    if (!media) continue;
    seen.add(r.media_id);
    const base = titleOf(media);
    if (!r.watched && r.position > 30) {
      if (!r.episode_id) {
        if (!media.has_file || !media.file_path) continue;
        items.push({ ...base, kind: 'movie', id: media.id, label: null, episodeTitle: null, resume: true, position: r.position, duration: r.duration, minutesLeft: minutesLeft(r.position, r.duration), upNext: false, updatedAt: r.updated_at });
      } else {
        const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(r.episode_id) as EpisodeRow | undefined;
        if (!ep?.file_path || !ep.has_file) continue;
        items.push({ ...base, kind: 'episode', id: ep.id, label: epLabel(ep), episodeTitle: ep.title, resume: true, position: r.position, duration: r.duration, minutesLeft: minutesLeft(r.position, r.duration), upNext: false, updatedAt: r.updated_at });
      }
    } else if (r.watched && r.episode_id) {
      const eps = playableEpisodes(media.id);
      const i = eps.findIndex((e) => e.id === r.episode_id);
      const next = i >= 0 ? eps[i + 1] : undefined;
      if (next && !progressOf(userId, media.id, next.id).watched) {
        items.push({ ...base, kind: 'episode', id: next.id, label: epLabel(next), episodeTitle: next.title, resume: false, position: 0, duration: 0, minutesLeft: null, upNext: true, updatedAt: r.updated_at });
      }
    }
    if (items.length >= limit) break;
  }
  return items;
}

export function progressOf(userId: number, mediaId: number, episodeId: number) {
  return (db.prepare('SELECT position, duration, watched FROM watch_progress WHERE user_id = ? AND media_id = ? AND episode_id = ?').get(userId, mediaId, episodeId) as
    | { position: number; duration: number; watched: number }
    | undefined) ?? { position: 0, duration: 0, watched: 0 };
}

/**
 * What Play starts for a title (same rule as the title page's Play button and Continue watching), going by
 * the episode you watched most recently: resume it if you're partway through, else the one after it once
 * it's finished; the first episode if you haven't started. Null when nothing is downloaded.
 */
export function playTarget(userId: number, media: MediaRow): PlayTarget | null {
  if (media.type === 'movie') {
    if (!media.has_file || !media.file_path) return null;
    const p = progressOf(userId, media.id, 0);
    const resume = !p.watched && p.position > 30;
    return { kind: 'movie', id: media.id, label: null, episodeTitle: null, resume, position: resume ? p.position : 0, duration: p.duration, minutesLeft: resume ? minutesLeft(p.position, p.duration) : null };
  }
  const eps = playableEpisodes(media.id);
  if (!eps.length) return null;
  const rows = db
    .prepare('SELECT episode_id, position, duration, watched, updated_at FROM watch_progress WHERE user_id = ? AND media_id = ? ORDER BY updated_at DESC, rowid DESC')
    .all(userId, media.id) as unknown as ProgressRow[];
  const at = (e: EpisodeRow, p?: ProgressRow): PlayTarget => {
    const resume = !!p && !p.watched && p.position > 30;
    // A one-episode title (an anime film) needs no "S1 E1".
    return { kind: 'episode', id: e.id, label: eps.length > 1 ? epLabel(e) : null, episodeTitle: eps.length > 1 ? e.title : null, resume, position: resume ? p!.position : 0, duration: p?.duration ?? 0, minutesLeft: resume ? minutesLeft(p!.position, p!.duration) : null };
  };
  const latest = rows.find((r) => eps.some((e) => e.id === r.episode_id));
  if (!latest) return at(eps[0]);
  const i = eps.findIndex((e) => e.id === latest.episode_id);
  if (!latest.watched) return at(eps[i], latest);
  return at(eps[i + 1] ?? eps[0]);
}

export interface HomeData {
  featured: FeaturedItem[];
  continue: ContinueItem[];
  recent: PlayableTitle[];
  libraries: Record<MediaType, PlayableTitle[]>;
}

export function homeFor(userId: number): HomeData {
  const cont = continueWatching(userId);
  const recent = downloadedTitles({ limit: 20 });
  // The banner: what you're in the middle of, then what's new, one per title, ones with a backdrop preferred.
  const featured: FeaturedItem[] = [];
  const used = new Set<number>();
  const candidates = [...cont.map((c) => c.mediaId), ...recent.map((r) => r.mediaId)];
  for (const id of candidates) {
    if (featured.length >= 6 || used.has(id)) continue;
    used.add(id);
    const media = getMedia(id);
    if (!media) continue;
    const play = playTarget(userId, media);
    if (!play) continue;
    const t = recent.find((r) => r.mediaId === id) ?? toTitle(media);
    const c = cont.find((x) => x.mediaId === id);
    featured.push({ ...t, play, reason: c ? (c.upNext ? 'upnext' : 'continue') : 'new' });
  }
  // What you are watching stays first; among new titles, ones with a backdrop look best up front.
  const rank = (f: FeaturedItem) => (f.reason === 'new' ? 2 : 0) + (f.backdrop ? 0 : 1);
  featured.sort((a, b) => rank(a) - rank(b));
  // Every poster plays straight away (resume, next episode, or the first), like the banner.
  const playable = (list: HomeTitle[]): PlayableTitle[] =>
    list.map((t) => {
      const media = getMedia(t.mediaId);
      return { ...t, play: media ? playTarget(userId, media) : null };
    });
  return {
    featured,
    continue: cont,
    recent: playable(recent),
    libraries: {
      movie: playable(downloadedTitles({ type: 'movie', limit: 30 })),
      show: playable(downloadedTitles({ type: 'show', limit: 30 })),
      anime: playable(downloadedTitles({ type: 'anime', limit: 30 })),
    },
  };
}
