import { getSettings } from '../settings.js';
import { HttpError, trimSlash } from './http.js';

export interface QbitTorrent {
  hash: string;
  name: string;
  progress: number;
  state: string;
  save_path: string;
  content_path?: string;
  tags: string;
  category: string;
  size: number;
  dlspeed: number;
  eta: number;
}

interface Conn {
  url: string;
  username: string;
  password: string;
}

let cookie: string | null = null;
let cookieFor = '';

function conn(): Conn {
  const s = getSettings();
  return { url: trimSlash(s.qbitUrl), username: s.qbitUsername, password: s.qbitPassword };
}

async function login(c: Conn): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${c.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: c.username, password: c.password }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new HttpError(`Could not reach qBittorrent at ${c.url}: ${(err as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok || body.trim() === 'Fails.') throw new HttpError('qBittorrent login failed (check username/password)', res.status);
  // qBittorrent 4.x names the cookie "SID"; 5.x uses "QBT_SID_<port>".
  const sid = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0].trim())
    .find((c) => /^(QBT_)?SID(_\d+)?=/.test(c));
  // No cookie means auth is bypassed (e.g. "bypass authentication for localhost").
  cookie = sid ?? '';
  cookieFor = `${c.url}|${c.username}|${c.password}`;
}

async function call(path: string, init: RequestInit = {}, c: Conn = conn(), retry = true): Promise<Response> {
  if (cookie === null || cookieFor !== `${c.url}|${c.username}|${c.password}`) await login(c);
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  let res: Response;
  try {
    res = await fetch(`${c.url}/api/v2${path}`, { ...init, headers, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new HttpError(`Could not reach qBittorrent at ${c.url}: ${(err as Error).message}`);
  }
  if (res.status === 403 && retry) {
    cookie = null;
    return call(path, init, c, false);
  }
  if (res.status === 403)
    throw new HttpError(
      'qBittorrent refused the session (403). Check the username/password, and that the Web UI URL matches qBittorrent exactly.',
      403,
    );
  if (!res.ok) throw new HttpError(`qBittorrent ${path}: ${res.status} ${await res.text().catch(() => '')}`, res.status);
  return res;
}

export async function testQbit(url: string, username: string, password: string) {
  cookie = null;
  const res = await call('/app/version', {}, { url: trimSlash(url), username, password });
  return (await res.text()).trim();
}

async function ensureCategory(name: string) {
  try {
    await call('/torrents/createCategory', {
      method: 'POST',
      body: new URLSearchParams({ category: name, savePath: '' }),
    });
  } catch (err) {
    // 409 = category already exists.
    if ((err as HttpError).status !== 409) throw err;
  }
}

export async function addTorrent(
  source: { magnet: string } | { file: Uint8Array<ArrayBuffer> },
  opts: { savePath: string; tag: string },
): Promise<void> {
  const category = getSettings().qbitCategory || 'mediarr';
  await ensureCategory(category);
  const form = new FormData();
  if ('magnet' in source) form.append('urls', source.magnet);
  else form.append('torrents', new Blob([source.file], { type: 'application/x-bittorrent' }), 'release.torrent');
  form.append('savepath', opts.savePath);
  form.append('category', category);
  form.append('tags', opts.tag);
  form.append('autoTMM', 'false');
  const res = await call('/torrents/add', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (text === 'Fails.') throw new HttpError('qBittorrent rejected the torrent (already added, or invalid)');
}

export async function listTorrents(): Promise<QbitTorrent[]> {
  const category = getSettings().qbitCategory || 'mediarr';
  const res = await call(`/torrents/info?category=${encodeURIComponent(category)}`);
  return (await res.json()) as QbitTorrent[];
}

export async function deleteTorrent(hash: string, deleteFiles: boolean) {
  await call('/torrents/delete', {
    method: 'POST',
    body: new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) }),
  });
}

const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);
const ERROR_STATES = new Set(['error', 'missingFiles']);

export function torrentStatus(t: QbitTorrent): 'downloading' | 'done' | 'error' {
  if (ERROR_STATES.has(t.state)) return 'error';
  // 'moving' / 'checkingUP' mean files are still being relocated or verified.
  if (t.progress >= 1 && DONE_STATES.has(t.state)) return 'done';
  return 'downloading';
}

export interface QbitFile {
  index: number;
  /** Path inside the torrent, e.g. "Show S01-S02/Season 1/Show - 01.mkv". */
  name: string;
  size: number;
  priority: number;
}

/** Files in a torrent. Empty until a magnet link's metadata has been fetched. */
export async function torrentFiles(hash: string): Promise<QbitFile[]> {
  const res = await call(`/torrents/files?hash=${encodeURIComponent(hash)}`);
  const files = (await res.json()) as (QbitFile & { index?: number })[];
  // `index` exists since WebUI API 2.8.2; older versions use the array position.
  return files.map((f, i) => ({ ...f, index: f.index ?? i }));
}

/** Sets file priorities; 0 means "do not download". */
export async function setFilePriority(hash: string, indexes: number[], priority: 0 | 1): Promise<void> {
  if (!indexes.length) return;
  await call('/torrents/filePrio', {
    method: 'POST',
    body: new URLSearchParams({ hash, id: indexes.join('|'), priority: String(priority) }),
  });
}

/** Renames/moves a file inside a torrent; both paths are relative to its save path (WebUI API 2.8.0+, qBittorrent 4.3.3+). */
export async function renameFile(hash: string, oldPath: string, newPath: string): Promise<void> {
  await call('/torrents/renameFile', {
    method: 'POST',
    body: new URLSearchParams({ hash, oldPath, newPath }),
  });
}
