import { fetchJson, HttpError } from './http.js';

const API = 'https://api.simkl.com';
const APP = { name: 'mediarr', version: '1.0' };

export type SimklStatus = 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped';
export type SimklKind = 'movies' | 'shows' | 'anime';

export interface SimklIds {
  simkl?: number;
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
  mal?: number;
  anilist?: number;
  anidb?: number;
}

export interface SimklItem {
  kind: SimklKind;
  status: SimklStatus;
  title: string;
  year: number | null;
  poster: string | null;
  ids: SimklIds;
  watched: number | null;
  total: number | null;
}

/** Mediarr's app on Simkl. `secret` is only needed for apps registered as "Server apps & services". */
export interface SimklApp {
  clientId: string;
  secret?: string;
}

/** A user's sign-in. OAuth V2 access tokens last a week and are renewed with the refresh token. */
export interface SimklTokens {
  access: string;
  refresh: string | null;
  /** ms since epoch; null when the token doesn't expire (old OAuth V1 apps). */
  expiresAt: number | null;
}

function url(path: string, clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ client_id: clientId, 'app-name': APP.name, 'app-version': APP.version, ...extra });
  return `${API}${path}?${q}`;
}

const headers = (clientId: string, token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': `${APP.name}/${APP.version}`,
  'simkl-api-key': clientId,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** POST to an /oauth2 endpoint; returns the JSON body and status, errors included (they carry the flow's state). */
async function oauth2(path: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': `${APP.name}/${APP.version}` },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new HttpError(`Could not reach Simkl: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const clientParams = (app: SimklApp) => ({ client_id: app.clientId, ...(app.secret ? { client_secret: app.secret } : {}) });

const toTokens = (b: { access_token: string; refresh_token?: string; expires_in?: number }): SimklTokens => ({
  access: b.access_token,
  refresh: b.refresh_token ?? null,
  expiresAt: b.refresh_token && b.expires_in ? Date.now() + b.expires_in * 1000 : null,
});

/** What the user sees while connecting. `deviceCode` is the polling secret and never leaves the server. */
export interface SimklDevice {
  version: 1 | 2;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Opens Simkl with the code already filled in (V2 only). */
  verificationUrlComplete: string | null;
  expiresIn: number;
  interval: number;
}

/** Step 1 of connecting: OAuth V2 device flow, or the older PIN flow for apps registered before V2. */
export async function deviceStart(app: SimklApp): Promise<SimklDevice> {
  const { status, body } = await oauth2('/oauth2/device', { client_id: app.clientId, scope: 'media:read media:write' });
  if (status === 200 && body.device_code) {
    return {
      version: 2,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUrl: body.verification_uri ?? 'https://simkl.com/pin',
      verificationUrlComplete: body.verification_uri_complete ?? null,
      expiresIn: body.expires_in ?? 900,
      interval: Math.max(5, body.interval ?? 5),
    };
  }
  if (body.error !== 'invalid_client') throw new HttpError(`Simkl: ${body.error_description ?? body.error ?? `error ${status}`}`, status);
  // An app registered for OAuth V1 only: the original PIN flow.
  const pin = await fetchJson<{ user_code: string; verification_uri?: string; verification_url?: string; expires_in: number; interval: number }>(
    url('/oauth/pin', app.clientId),
    { headers: headers(app.clientId) },
  ).catch((err) => {
    throw new HttpError(`Simkl didn’t accept Mediarr’s client ID. Check it in Settings → Watchlist apps. (${(err as Error).message})`, 400);
  });
  return {
    version: 1,
    deviceCode: pin.user_code,
    userCode: pin.user_code,
    verificationUrl: pin.verification_uri ?? pin.verification_url ?? 'https://simkl.com/pin',
    verificationUrlComplete: null,
    expiresIn: pin.expires_in ?? 900,
    interval: Math.max(5, pin.interval ?? 5),
  };
}

export type DevicePoll = { status: 'waiting' } | { status: 'slow_down' } | { status: 'expired' } | { status: 'ok'; tokens: SimklTokens };

/** Step 2: has the user approved yet? */
export async function devicePoll(app: SimklApp, device: Pick<SimklDevice, 'version' | 'deviceCode'>): Promise<DevicePoll> {
  if (device.version === 1) {
    const r = await fetchJson<{ result?: string; access_token?: string; device_code?: string }>(
      url(`/oauth/pin/${encodeURIComponent(device.deviceCode)}`, app.clientId),
      { headers: headers(app.clientId) },
    );
    if (r.access_token) return { status: 'ok', tokens: { access: r.access_token, refresh: null, expiresAt: null } };
    // A fresh code in the answer means ours is gone.
    return r.device_code ? { status: 'expired' } : { status: 'waiting' };
  }
  const { status, body } = await oauth2('/oauth2/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.deviceCode,
    ...clientParams(app),
  });
  if (status === 200 && body.access_token) return { status: 'ok', tokens: toTokens(body) };
  if (body.error === 'authorization_pending') return { status: 'waiting' };
  if (body.error === 'slow_down') return { status: 'slow_down' };
  if (body.error === 'expired_token') return { status: 'expired' };
  if (body.error === 'invalid_client') {
    throw new HttpError('Simkl rejected Mediarr’s app. If it’s registered as a server app, add its client secret in Settings → Watchlist apps.', 401);
  }
  throw new HttpError(`Simkl: ${body.error_description ?? body.error ?? `error ${status}`}`, status);
}

/** New access token from the refresh token (the refresh token's 180-day window slides forward). */
export async function refreshTokens(app: SimklApp, refresh: string): Promise<SimklTokens> {
  const { status, body } = await oauth2('/oauth2/token', { grant_type: 'refresh_token', refresh_token: refresh, ...clientParams(app) });
  if (status !== 200 || !body.access_token) throw new HttpError(`Simkl: ${body.error_description ?? body.error ?? 'refresh failed'}`, 401);
  return { ...toTokens(body), refresh: body.refresh_token ?? refresh };
}

/** Best effort: tells Simkl to forget the sign-in when a user disconnects. */
export async function revoke(app: SimklApp, token: string): Promise<void> {
  await oauth2('/oauth2/revoke', { token, ...clientParams(app) }).catch(() => undefined);
}

/** The Simkl account's name, for showing which account is connected. */
export async function accountName(clientId: string, token: string): Promise<string | null> {
  try {
    const r = await fetchJson<{ user?: { name?: string } }>(url('/users/settings', clientId), { method: 'POST', headers: headers(clientId, token) });
    return r.user?.name ?? null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

function parseIds(raw: Record<string, unknown> = {}): SimklIds {
  return {
    simkl: num(raw.simkl),
    tmdb: num(raw.tmdb),
    imdb: typeof raw.imdb === 'string' ? raw.imdb : undefined,
    tvdb: num(raw.tvdb),
    mal: num(raw.mal),
    anilist: num(raw.anilist),
    anidb: num(raw.anidb),
  };
}

const STATUSES = new Set<SimklStatus>(['watching', 'plantowatch', 'hold', 'completed', 'dropped']);
const mediaOf = (entry: any) => entry.movie ?? entry.show ?? entry.anime ?? {};

/** Parses `/sync/all-items` into flat items. */
export function parseAllItems(body: Partial<Record<SimklKind, any[]>> | null): SimklItem[] {
  const out: SimklItem[] = [];
  for (const kind of ['movies', 'shows', 'anime'] as const) {
    for (const entry of body?.[kind] ?? []) {
      const media = mediaOf(entry);
      if (!STATUSES.has(entry.status)) continue;
      out.push({
        kind,
        status: entry.status,
        title: media.title ?? 'Unknown',
        year: num(media.year) ?? null,
        poster: media.poster ? `https://simkl.in/posters/${media.poster}_m.jpg` : null,
        ids: parseIds(media.ids),
        watched: num(entry.watched_episodes_count) ?? null,
        total: num(entry.total_episodes_count) ?? null,
      });
    }
  }
  return out;
}

/** Simkl ids of everything on the user's lists (from an `extended=simkl_ids_only` call). */
export function parseSimklIds(body: Partial<Record<SimklKind, any[]>> | null): Set<number> {
  const ids = new Set<number>();
  for (const kind of ['movies', 'shows', 'anime'] as const) {
    for (const entry of body?.[kind] ?? []) {
      const id = num(mediaOf(entry).ids?.simkl);
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

/** Last-change timestamps per list (`GET /sync/activities`); cheap, call this before fetching any items. */
export interface SimklActivities {
  all: string | null;
  /** Combined "removed from list" stamps; a change means something was deleted. */
  removed: string;
}

export async function activities(clientId: string, token: string): Promise<SimklActivities> {
  const r = await fetchJson<any>(url('/sync/activities', clientId), { headers: headers(clientId, token) });
  return {
    all: r?.all ?? null,
    removed: ['movies', 'tv_shows', 'anime'].map((k) => r?.[k]?.removed_from_list ?? '').join('|'),
  };
}

/** Everything on the lists, or only what changed after `dateFrom` (as returned by activities). */
export async function fetchLists(clientId: string, token: string, dateFrom?: string): Promise<SimklItem[]> {
  const body = await fetchJson<Partial<Record<SimklKind, any[]>> | null>(
    url('/sync/all-items/all/all', clientId, { extended: 'full', ...(dateFrom ? { date_from: dateFrom } : {}) }),
    { headers: headers(clientId, token) },
  );
  return parseAllItems(body);
}

export async function fetchListIds(clientId: string, token: string): Promise<Set<number>> {
  const body = await fetchJson<Partial<Record<SimklKind, any[]>> | null>(url('/sync/all-items/all/all', clientId, { extended: 'simkl_ids_only' }), {
    headers: headers(clientId, token),
  });
  return parseSimklIds(body);
}

/** Request body for one title: movies by TMDB id, shows by TMDB id (typed), anime by AniList id. */
export function itemBody(kind: 'movie' | 'show' | 'anime', ids: SimklIds, to?: SimklStatus) {
  const item = { ...(to ? { to } : {}), ids: Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== undefined)) };
  if (kind === 'movie') return { movies: [item] };
  if (kind === 'show') return { shows: [{ ...item, type: 'show' }] };
  return { shows: [{ ...item, type: 'anime' }] };
}

export async function addToList(clientId: string, token: string, kind: 'movie' | 'show' | 'anime', ids: SimklIds, to: SimklStatus) {
  const r = await fetchJson<{ not_found?: Record<string, unknown[]> }>(url('/sync/add-to-list', clientId), {
    method: 'POST',
    headers: headers(clientId, token),
    body: JSON.stringify(itemBody(kind, ids, to)),
  });
  if (Object.values(r?.not_found ?? {}).some((list) => list.length)) throw new HttpError("Simkl doesn't know this title");
}

export async function removeFromList(clientId: string, token: string, kind: 'movie' | 'show' | 'anime', ids: SimklIds) {
  await fetchJson(url('/sync/history/remove', clientId), {
    method: 'POST',
    headers: headers(clientId, token),
    body: JSON.stringify(itemBody(kind, ids)),
  });
}
