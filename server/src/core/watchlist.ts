import * as anilist from '../clients/anilist.js';
import * as simkl from '../clients/simkl.js';
import { HttpError } from '../clients/http.js';
import { open, seal } from '../auth/secretBox.js';
import { db, now, type MediaType } from '../db.js';
import { getSettings } from '../settings.js';
import { withLibraryIds } from './library.js';

export type WatchStatus = 'watching' | 'planned' | 'completed' | 'paused' | 'dropped';
export type Service = 'simkl' | 'anilist';
export const WATCH_STATUSES: WatchStatus[] = ['watching', 'planned', 'completed', 'paused', 'dropped'];
export const SERVICES: Service[] = ['simkl', 'anilist'];

const TO_SIMKL: Record<WatchStatus, simkl.SimklStatus> = {
  watching: 'watching',
  planned: 'plantowatch',
  completed: 'completed',
  paused: 'hold',
  dropped: 'dropped',
};
const FROM_SIMKL: Record<simkl.SimklStatus, WatchStatus> = {
  watching: 'watching',
  plantowatch: 'planned',
  completed: 'completed',
  hold: 'paused',
  dropped: 'dropped',
};
const TO_ANILIST: Record<WatchStatus, anilist.AniListStatus> = {
  watching: 'CURRENT',
  planned: 'PLANNING',
  completed: 'COMPLETED',
  paused: 'PAUSED',
  dropped: 'DROPPED',
};
const FROM_ANILIST: Record<anilist.AniListStatus, WatchStatus> = {
  CURRENT: 'watching',
  REPEATING: 'watching',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  DROPPED: 'dropped',
};

export const toSimkl = (s: WatchStatus) => TO_SIMKL[s];
export const fromSimkl = (s: simkl.SimklStatus) => FROM_SIMKL[s];
export const toAniList = (s: WatchStatus) => TO_ANILIST[s];
export const fromAniList = (s: anilist.AniListStatus) => FROM_ANILIST[s];

export interface WatchItem {
  /** Stable id within the list: "movie:603", "anime:21", or "simkl:123" when Mediarr has no id for it. */
  key: string;
  type: MediaType;
  status: WatchStatus;
  title: string;
  year: number | null;
  poster: string | null;
  tmdbId?: number;
  anilistId?: number;
  /** Status on each service the title is on. */
  services: Partial<Record<Service, WatchStatus>>;
  progress: { watched: number | null; total: number | null } | null;
  libraryId: number | null;
}

// ---- Connected accounts ----

export interface Link {
  token: string;
  accountId: string | null;
  accountName: string | null;
}

export function getLink(userId: number, service: Service): Link | null {
  const row = db.prepare('SELECT token_enc, account_id, account_name FROM user_links WHERE user_id = ? AND service = ?').get(userId, service) as
    | { token_enc: string; account_id: string | null; account_name: string | null }
    | undefined;
  if (!row) return null;
  try {
    return { token: open(row.token_enc), accountId: row.account_id, accountName: row.account_name };
  } catch {
    return null; // sealed with a key that's gone: treat as disconnected
  }
}

export function saveLink(userId: number, service: Service, token: string, accountId: string | null, accountName: string | null) {
  db.prepare(
    `INSERT INTO user_links (user_id, service, token_enc, account_id, account_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, service) DO UPDATE SET token_enc = excluded.token_enc, account_id = excluded.account_id,
       account_name = excluded.account_name, created_at = excluded.created_at`,
  ).run(userId, service, seal(token), accountId, accountName, now());
  forget(userId);
}

/** Disconnects a service; for Simkl the sign-in is also revoked (best effort). */
export async function disconnect(userId: number, service: Service) {
  const link = service === 'simkl' ? getLink(userId, 'simkl') : null;
  deleteLink(userId, service);
  if (link) {
    const tokens = simklTokens(link);
    if (tokens.refresh) await simkl.revoke(simklApp(), tokens.refresh);
  }
}

export function deleteLink(userId: number, service: Service) {
  db.prepare('DELETE FROM user_links WHERE user_id = ? AND service = ?').run(userId, service);
  if (service === 'simkl') db.prepare('DELETE FROM simkl_sync WHERE user_id = ?').run(userId);
  forget(userId);
}

// ---- Simkl sign-in ----

export const simklApp = (): simkl.SimklApp => {
  const s = getSettings();
  return { clientId: s.simklClientId, ...(s.simklClientSecret ? { secret: s.simklClientSecret } : {}) };
};

/** Simkl sign-ins are stored as JSON tokens; a bare string is an old OAuth V1 token that never expires. */
export function simklTokens(link: Link): simkl.SimklTokens {
  if (link.token.startsWith('{')) return JSON.parse(link.token) as simkl.SimklTokens;
  return { access: link.token, refresh: null, expiresAt: null };
}

export function saveSimkl(userId: number, tokens: simkl.SimklTokens, accountName: string | null) {
  saveLink(userId, 'simkl', JSON.stringify(tokens), null, accountName);
}

const REFRESH_EARLY_MS = 10 * 60_000;

/** The user's Simkl access token, renewed first if it's about to expire. */
async function simklAccess(userId: number, link: Link, force = false): Promise<string> {
  const tokens = simklTokens(link);
  if (!tokens.refresh || (!force && (tokens.expiresAt === null || tokens.expiresAt - REFRESH_EARLY_MS > Date.now()))) return tokens.access;
  const fresh = await simkl.refreshTokens(simklApp(), tokens.refresh);
  db.prepare("UPDATE user_links SET token_enc = ? WHERE user_id = ? AND service = 'simkl'").run(seal(JSON.stringify(fresh)), userId);
  return fresh.access;
}

/** Runs a Simkl call with the user's token, renewing it once if Simkl says it has expired. */
async function withSimkl<T>(userId: number, link: Link, run: (token: string) => Promise<T>): Promise<T> {
  try {
    return await run(await simklAccess(userId, link));
  } catch (err) {
    if ((err as HttpError).status !== 401 || !simklTokens(link).refresh) throw err;
    return run(await simklAccess(userId, getLink(userId, 'simkl') ?? link, true));
  }
}

/**
 * The user's Simkl lists, following Simkl's sync rules: the cheap activities call first, the full list
 * only once, after that only what changed (date_from), and the ids alone to spot removals.
 */
export async function syncSimkl(userId: number, clientId: string, token: string): Promise<simkl.SimklItem[]> {
  const act = await simkl.activities(clientId, token);
  const saved = db.prepare('SELECT activity_all, activity_removed, items FROM simkl_sync WHERE user_id = ?').get(userId) as
    | { activity_all: string | null; activity_removed: string | null; items: string }
    | undefined;
  let items: simkl.SimklItem[];
  if (!saved || !saved.activity_all) {
    items = await simkl.fetchLists(clientId, token);
  } else {
    items = JSON.parse(saved.items) as simkl.SimklItem[];
    if (act.all === saved.activity_all) return items;
    const keyOf = (i: simkl.SimklItem) => (i.ids.simkl !== undefined ? `simkl:${i.ids.simkl}` : `${i.kind}:${i.title}:${i.year}`);
    const byKey = new Map(items.map((i) => [keyOf(i), i]));
    for (const changed of await simkl.fetchLists(clientId, token, saved.activity_all)) byKey.set(keyOf(changed), changed);
    items = [...byKey.values()];
    if (act.removed !== saved.activity_removed) {
      const still = await simkl.fetchListIds(clientId, token);
      items = items.filter((i) => i.ids.simkl === undefined || still.has(i.ids.simkl));
    }
  }
  db.prepare(
    `INSERT INTO simkl_sync (user_id, activity_all, activity_removed, items, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET activity_all = excluded.activity_all, activity_removed = excluded.activity_removed,
       items = excluded.items, updated_at = excluded.updated_at`,
  ).run(userId, act.all, act.removed, JSON.stringify(items), now());
  return items;
}

// ---- Reading the lists ----

const CACHE_MS = 60_000;
const cache = new Map<number, { at: number; items: WatchItem[]; errors: string[] }>();
export const forget = (userId: number) => cache.delete(userId);

const KIND_TYPE: Record<simkl.SimklKind, MediaType> = { movies: 'movie', shows: 'show', anime: 'anime' };

/** Merges both services' lists into one, an anime on both appearing once. Pure, for testing. */
export function mergeLists(simklItems: simkl.SimklItem[], anilistItems: anilist.AniListEntry[], malToAnilist = new Map<number, number>()): Omit<WatchItem, 'libraryId'>[] {
  const byKey = new Map<string, Omit<WatchItem, 'libraryId'>>();
  for (const s of simklItems) {
    const type = KIND_TYPE[s.kind];
    const anilistId = type === 'anime' ? (s.ids.anilist ?? (s.ids.mal ? malToAnilist.get(s.ids.mal) : undefined)) : undefined;
    const tmdbId = type !== 'anime' ? s.ids.tmdb : undefined;
    const id = type === 'anime' ? anilistId : tmdbId;
    const key = id ? `${type}:${id}` : `simkl:${s.ids.simkl ?? `${s.title}:${s.year}`}`;
    const status = fromSimkl(s.status);
    byKey.set(key, {
      key,
      type,
      status,
      title: s.title,
      year: s.year,
      poster: s.poster,
      ...(tmdbId ? { tmdbId } : {}),
      ...(anilistId ? { anilistId } : {}),
      services: { simkl: status },
      progress: s.total || s.watched ? { watched: s.watched, total: s.total } : null,
    });
  }
  for (const a of anilistItems) {
    const key = `anime:${a.anilistId}`;
    const status = fromAniList(a.status);
    const existing = byKey.get(key);
    const progress = { watched: a.progress, total: a.episodes };
    if (existing) {
      // AniList is the anime source of truth: its status, title and cover win.
      existing.services.anilist = status;
      existing.status = status;
      existing.title = a.title;
      existing.poster = a.poster ?? existing.poster;
      existing.progress = progress;
    } else {
      byKey.set(key, { key, type: 'anime', status, title: a.title, year: a.year, poster: a.poster, anilistId: a.anilistId, services: { anilist: status }, progress });
    }
  }
  return [...byKey.values()];
}

const friendly = (service: Service, err: unknown) => {
  const status = (err as HttpError).status;
  const name = service === 'simkl' ? 'Simkl' : 'AniList';
  if (status === 401 || status === 403 || /invalid token|unauthorized/i.test((err as Error).message)) {
    return `Your ${name} connection has expired. Reconnect it in Settings → Watchlists.`;
  }
  return `${name}: ${(err as Error).message}`;
};

export async function watchlistFor(userId: number): Promise<{ items: WatchItem[]; errors: string[] }> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const s = getSettings();
  const errors: string[] = [];
  const sk = s.simklClientId ? getLink(userId, 'simkl') : null;
  const al = s.anilistClientId ? getLink(userId, 'anilist') : null;
  const [simklItems, anilistItems] = await Promise.all([
    sk
      ? withSimkl(userId, sk, (token) => syncSimkl(userId, s.simklClientId, token)).catch((err) => (errors.push(friendly('simkl', err)), []))
      : [],
    al ? anilist.userAnimeList(al.token, Number(al.accountId)).catch((err) => (errors.push(friendly('anilist', err)), [])) : [],
  ]);
  const needMal = [...new Set(simklItems.filter((i) => i.kind === 'anime' && !i.ids.anilist && i.ids.mal).map((i) => i.ids.mal!))];
  const malMap = needMal.length ? await anilist.anilistIdsForMal(needMal).catch(() => new Map<number, number>()) : new Map<number, number>();
  const merged = mergeLists(simklItems, anilistItems, malMap);
  const items: WatchItem[] = [];
  for (const type of ['movie', 'show', 'anime'] as const) items.push(...withLibraryIds(type, merged.filter((i) => i.type === type)));
  items.sort((a, b) => a.title.localeCompare(b.title));
  const result = { at: Date.now(), items, errors };
  // Don't remember a failed read for a whole minute.
  if (!errors.length) cache.set(userId, result);
  return result;
}

// ---- Changing the lists ----

/** Services that can hold this kind of title for this user. */
export function servicesFor(userId: number, type: MediaType): Service[] {
  const s = getSettings();
  const out: Service[] = [];
  if (s.simklClientId && getLink(userId, 'simkl')) out.push('simkl');
  if (type === 'anime' && s.anilistClientId && getLink(userId, 'anilist')) out.push('anilist');
  return out;
}

const simklIds = (type: MediaType, id: number): simkl.SimklIds => (type === 'anime' ? { anilist: id } : { tmdb: id });

async function eachService(userId: number, type: MediaType, run: (service: Service, link: Link) => Promise<void>) {
  const services = servicesFor(userId, type);
  if (!services.length) {
    throw Object.assign(new Error(type === 'anime' ? 'Connect Simkl or AniList first (Settings → Watchlists).' : 'Connect Simkl first (Settings → Watchlists).'), {
      statusCode: 400,
    });
  }
  const errors: string[] = [];
  for (const service of services) {
    try {
      await run(service, getLink(userId, service)!);
    } catch (err) {
      errors.push(friendly(service, err));
    }
  }
  forget(userId);
  if (errors.length === services.length) throw Object.assign(new Error(errors.join(' ')), { statusCode: 502 });
  return { warnings: errors };
}

/** Adds a title to the user's lists, or moves it to another status. `id` is TMDB's (movie/show) or AniList's (anime). */
export function setStatus(userId: number, type: MediaType, id: number, status: WatchStatus) {
  const clientId = getSettings().simklClientId;
  return eachService(userId, type, async (service, link) => {
    if (service === 'simkl') await withSimkl(userId, link, (token) => simkl.addToList(clientId, token, type, simklIds(type, id), toSimkl(status)));
    else await anilist.saveEntry(link.token, id, toAniList(status));
  });
}

export function removeTitle(userId: number, type: MediaType, id: number) {
  const clientId = getSettings().simklClientId;
  return eachService(userId, type, async (service, link) => {
    if (service === 'simkl') await withSimkl(userId, link, (token) => simkl.removeFromList(clientId, token, type, simklIds(type, id)));
    else await anilist.deleteEntry(link.token, Number(link.accountId), id);
  });
}
