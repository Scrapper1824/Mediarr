import { getAnimeSeries } from '../clients/anilist.js';
import { getMovie, getShow } from '../clients/tmdb.js';
import { db, logHistory, now, type MediaType } from '../db.js';
import { autoSearch } from './grabber.js';
import { addMedia, requestedMedia, withLibraryIds, type AddMediaInput } from './library.js';

/** A title asked for by a user whose requests wait for an admin. */
export interface RequestRow {
  id: number;
  user_id: number | null;
  username: string;
  type: MediaType;
  tmdb_id: number | null;
  anilist_id: number | null;
  title: string;
  year: number | null;
  poster: string | null;
  /** JSON: what to add once approved (AddMediaInput without folder/requester, plus searchNow). */
  input: string;
  status: 'pending' | 'approved' | 'denied';
  media_id: number | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export type RequestInput = AddMediaInput & { searchNow?: boolean };

const TYPES: MediaType[] = ['movie', 'show', 'anime'];

export function getRequest(id: number): RequestRow | undefined {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
}

/** The library title this would add, if it's already there. */
function inLibrary(input: AddMediaInput): number | null {
  return withLibraryIds(input.type, [{ tmdbId: input.tmdbId, anilistId: input.anilistId }])[0].libraryId;
}

function pendingFor(input: AddMediaInput): RequestRow | undefined {
  return db
    .prepare("SELECT * FROM requests WHERE status = 'pending' AND type = ? AND (tmdb_id = ? OR anilist_id = ?)")
    .get(input.type, input.tmdbId ?? -1, input.anilistId ?? -1) as RequestRow | undefined;
}

/**
 * Records a request to approve later. Name, year and poster come from TMDB/AniList (never from the client).
 * Asking again for something already waiting returns that request; something already in the library is just that title.
 */
export async function createRequest(user: { id: number; username: string }, body: RequestInput): Promise<{ pending: true; requestId: number } | { id: number }> {
  const input = requestedMedia(body);
  if (!TYPES.includes(input.type)) throw Object.assign(new Error('Unknown type.'), { statusCode: 400 });
  const id = input.type === 'anime' ? input.anilistId : input.tmdbId;
  if (!Number.isInteger(id) || id! <= 0) throw Object.assign(new Error('Missing title id.'), { statusCode: 400 });
  const clean: RequestInput = {
    type: input.type,
    ...(input.type === 'anime' ? { anilistId: id } : { tmdbId: id }),
    monitored: input.monitored !== false,
    ...(Array.isArray(input.seasons) ? { seasons: input.seasons.map(Number).filter((n) => Number.isInteger(n) && n >= 0) } : {}),
    ...(input.type === 'anime' && (input.animeAudio === 'sub' || input.animeAudio === 'dub') ? { animeAudio: input.animeAudio } : {}),
    searchNow: body.searchNow !== false,
  };

  const existing = inLibrary(clean);
  if (existing) return { id: existing };
  const waiting = pendingFor(clean);
  if (waiting) return { pending: true, requestId: waiting.id };

  const info =
    clean.type === 'movie' ? await getMovie(id!) : clean.type === 'show' ? await getShow(id!) : await getAnimeSeries(id!);
  const r = db
    .prepare(`INSERT INTO requests (user_id, username, type, tmdb_id, anilist_id, title, year, poster, input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(user.id, user.username, clean.type, clean.tmdbId ?? null, clean.anilistId ?? null, info.title, info.year, info.poster, JSON.stringify(clean), now());
  logHistory(null, 'requested', `${user.username} requested ${info.title}${info.year ? ` (${info.year})` : ''}: waiting for an admin`);
  return { pending: true, requestId: Number(r.lastInsertRowid) };
}

/** Pending first, then what was decided in the last 30 days. Users see only their own. */
export function listRequests(userId: number | null): RequestRow[] {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  return db
    .prepare(
      `SELECT * FROM requests WHERE (status = 'pending' OR created_at >= ?) ${userId === null ? '' : 'AND user_id = ?'}
       ORDER BY status = 'pending' DESC, created_at DESC LIMIT 200`,
    )
    .all(...(userId === null ? [since] : [since, userId])) as unknown as RequestRow[];
}

export const pendingCount = () => (db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get() as { n: number }).n;

const notPending = () => Object.assign(new Error('That request was already handled.'), { statusCode: 409 });

/** An admin says yes: the title is added (as requested by the user) and searching starts. */
export async function approveRequest(id: number, admin: string): Promise<number> {
  const r = getRequest(id);
  if (!r) throw Object.assign(new Error('Request not found.'), { statusCode: 404 });
  if (r.status !== 'pending') throw notPending();
  const input = JSON.parse(r.input) as RequestInput;
  const mediaId = await addMedia({ ...requestedMedia(input), requestedBy: r.username });
  db.prepare("UPDATE requests SET status = 'approved', media_id = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(mediaId, admin, now(), id);
  logHistory(mediaId, 'approved', `${admin} approved ${r.username}'s request for ${r.title}`);
  if (input.searchNow !== false) {
    autoSearch(mediaId, { force: true, userId: r.user_id ?? undefined }).catch((err) => logHistory(mediaId, 'failed', `Search failed: ${err.message}`));
  }
  return mediaId;
}

export function denyRequest(id: number, admin: string) {
  const r = getRequest(id);
  if (!r) throw Object.assign(new Error('Request not found.'), { statusCode: 404 });
  if (r.status !== 'pending') throw notPending();
  db.prepare("UPDATE requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?").run(admin, now(), id);
  logHistory(null, 'denied', `${admin} declined ${r.username}'s request for ${r.title}`);
}

/** Withdrawn by whoever asked (or an admin) while it's still waiting. */
export function cancelRequest(id: number, user: { id: number; role: string }) {
  const r = getRequest(id);
  if (!r || (user.role !== 'admin' && r.user_id !== user.id)) throw Object.assign(new Error('Request not found.'), { statusCode: 404 });
  if (r.status !== 'pending') throw notPending();
  db.prepare('DELETE FROM requests WHERE id = ?').run(id);
}
