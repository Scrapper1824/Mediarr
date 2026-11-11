import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { resetRateLimits } from '../auth/rateLimit.js';
import { prepareSetupCode } from '../auth/routes.js';
import { db, initDb, now } from '../db.js';
import { isLocalAddress } from './play.js';

const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let dataDir: string;
let lib: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-playroutes-'));
  lib = path.join(dataDir, 'Movies');
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

async function users() {
  const boss = cookieFrom(
    await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: prepareSetupCode(dataDir), username: 'boss', password: PASSWORD } }),
  );
  await app.inject({ method: 'POST', url: '/api/users', headers: { ...CSRF, cookie: boss }, payload: { username: 'viewer', password: `${PASSWORD} x`, role: 'user' } });
  const viewer = cookieFrom(await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'viewer', password: `${PASSWORD} x` } }));
  return { boss, viewer };
}

/** A movie in the library whose file is `file` (by default inside its own folder). */
function addMovie(file?: string): number {
  const folder = path.join(lib, 'Dune (2021)');
  const target = file ?? path.join(folder, 'Dune (2021) [1080p].mp4');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from('0123456789abcdef'));
  return Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, has_file, file_path, added_at) VALUES ('movie', 1, 'Dune', 2021, ?, 'Dune (2021)', 1, ?, ?)`)
      .run(lib, target, now()).lastInsertRowid,
  );
}

const call = (cookie: string, method: 'GET' | 'PUT', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, cookie, ...headers }, payload });

describe('watching', () => {
  it('streams the original file with byte ranges', async () => {
    const { viewer } = await users();
    const id = addMovie();
    const part = await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=4-7' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 4-7/16');
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.body).toBe('4567');
    const tail = await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=-3' });
    expect(tail.body).toBe('def');
    expect((await call(viewer, 'GET', `/api/play/direct/movie/${id}`, undefined, { range: 'bytes=40-50' })).statusCode).toBe(416);
  });

  it('only plays files inside the title’s own library folder', async () => {
    const { viewer } = await users();
    const id = addMovie(path.join(dataDir, 'elsewhere', 'secret.mp4'));
    expect((await call(viewer, 'GET', `/api/play/direct/movie/${id}`)).statusCode).toBe(403);
    expect((await call(viewer, 'GET', '/api/play/direct/movie/999')).statusCode).toBe(404);
    expect((await call(viewer, 'GET', '/api/play/direct/show/1')).statusCode).toBe(400);
  });

  it('keeps each user’s progress to themselves, and lists what to continue', async () => {
    const { boss, viewer } = await users();
    const id = addMovie();
    expect((await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { position: 600, duration: 9000 })).json()).toEqual({ ok: true, watched: false });
    expect((await call(viewer, 'GET', `/api/play/progress/${id}`)).json()).toEqual({ 0: { position: 600, duration: 9000, watched: false } });
    expect((await call(boss, 'GET', `/api/play/progress/${id}`)).json()).toEqual({});

    const cont = (await call(viewer, 'GET', '/api/continue')).json();
    expect(cont).toEqual([expect.objectContaining({ kind: 'movie', id, position: 600, upNext: false, tmdbId: 1, year: 2021 })]);
    expect((await call(boss, 'GET', '/api/continue')).json()).toEqual([]);

    // 90% in counts as watched, and it leaves Continue Watching.
    expect((await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { position: 8200, duration: 9000 })).json().watched).toBe(true);
    expect((await call(viewer, 'GET', '/api/continue')).json()).toEqual([]);
    // Marked unwatched by hand: starts over.
    await call(viewer, 'PUT', `/api/play/movie/${id}/progress`, { watched: false });
    expect((await call(viewer, 'GET', `/api/play/progress/${id}`)).json()[0]).toMatchObject({ position: 0, watched: false });
  });

  it('never hands out someone else’s stream', async () => {
    const { viewer } = await users();
    const res = await call(viewer, 'GET', '/api/play/hls/0123456789abcdef0123456789abcdef/main.m3u8');
    expect(res.statusCode).toBe(404);
  });

  it('allows the player in the security policy', async () => {
    const { viewer } = await users();
    const csp = String((await call(viewer, 'GET', '/api/continue')).headers['content-security-policy']);
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain('unsafe-inline\'; script'); // scripts still can't be inline
  });
});

/** A show or anime with `files` downloaded episodes (of `total`), each a real file in its folder. */
function addSeries(type: 'show' | 'anime', title: string, files: number, total = files): { id: number; eps: number[] } {
  const folder = path.join(lib, title);
  fs.mkdirSync(folder, { recursive: true });
  const id = Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, anilist_id, title, year, root_folder, folder_name, backdrop, added_at) VALUES (?, ?, ?, ?, 2020, ?, ?, ?, ?)`)
      .run(type, type === 'show' ? 100 + title.length : null, type === 'anime' ? 200 + title.length : null, title, lib, title, `https://img/${title}.jpg`, now()).lastInsertRowid,
  );
  const eps: number[] = [];
  for (let n = 1; n <= total; n++) {
    const file = n <= files ? path.join(folder, `${title} - S01E0${n}.mkv`) : null;
    if (file) fs.writeFileSync(file, 'x');
    eps.push(
      Number(db.prepare('INSERT INTO episodes (media_id, season, episode, title, has_file, file_path) VALUES (?, 1, ?, ?, ?, ?)').run(id, n, `Ep ${n}`, file ? 1 : 0, file).lastInsertRowid),
    );
  }
  return { id, eps };
}
const imported = (mediaId: number, at: string) =>
  db.prepare("INSERT INTO history (media_id, event, message, created_at) VALUES (?, 'imported', 'Imported 1 file(s)', ?)").run(mediaId, at);
const touched = (mediaId: number, at: string) => db.prepare('UPDATE watch_progress SET updated_at = ? WHERE media_id = ?').run(at, mediaId);

describe('the Home page', () => {
  it('mixes movies, shows and anime, per user, newest first', async () => {
    const { boss, viewer } = await users();
    const movie = addMovie();
    const show = addSeries('show', 'Severance', 3);
    const anime = addSeries('anime', 'Frieren', 2);
    const empty = addSeries('show', 'Nothing Yet', 0, 4); // requested, nothing downloaded
    imported(movie, '2026-01-01T00:00:00.000Z');
    imported(show.id, '2026-03-01T00:00:00.000Z');
    imported(anime.id, '2026-02-01T00:00:00.000Z');

    // The viewer is partway through the movie and finished Severance episode 1.
    await call(viewer, 'PUT', `/api/play/movie/${movie}/progress`, { position: 1200, duration: 9000 });
    await call(viewer, 'PUT', `/api/play/episode/${show.eps[0]}/progress`, { position: 2900, duration: 3000 });
    touched(movie, '2026-04-01T00:00:00.000Z');
    touched(show.id, '2026-04-02T00:00:00.000Z');

    const res = await call(viewer, 'GET', '/api/home');
    expect(res.statusCode).toBe(200);
    const home = res.json();
    // Most recently watched first; Severance is "up next" episode 2.
    expect(home.continue.map((c: { title: string }) => c.title)).toEqual(['Severance', 'Dune']);
    expect(home.continue[0]).toMatchObject({ kind: 'episode', id: show.eps[1], label: 'S01E02', upNext: true, backdrop: 'https://img/Severance.jpg' });
    expect(home.continue[1]).toMatchObject({ kind: 'movie', id: movie, resume: true, minutesLeft: 130 });
    // Recently added: only titles with files, newest import first.
    expect(home.recent.map((r: { title: string }) => r.title)).toEqual(['Severance', 'Frieren', 'Dune']);
    expect(home.recent.some((r: { mediaId: number }) => r.mediaId === empty.id)).toBe(false);
    expect(home.libraries.anime.map((r: { title: string }) => r.title)).toEqual(['Frieren']);
    expect(home.libraries.show[0]).toMatchObject({ title: 'Severance', episodeFiles: 3 });
    // Every poster knows what clicking it plays: the next episode, the half-watched movie, the first episode.
    const playOf = (title: string) => home.recent.find((r: { title: string }) => r.title === title).play;
    expect(playOf('Severance')).toMatchObject({ kind: 'episode', id: show.eps[1], resume: false });
    expect(playOf('Dune')).toMatchObject({ kind: 'movie', id: movie, resume: true });
    expect(home.libraries.anime[0].play).toMatchObject({ kind: 'episode', id: anime.eps[0] });
    // The banner plays the right thing for each title.
    const byTitle = Object.fromEntries(home.featured.map((f: { title: string; play: unknown }) => [f.title, f.play]));
    expect(byTitle.Severance).toMatchObject({ kind: 'episode', id: show.eps[1], resume: false });
    expect(byTitle.Dune).toMatchObject({ kind: 'movie', id: movie, resume: true });
    expect(byTitle.Frieren).toMatchObject({ kind: 'episode', id: anime.eps[0], resume: false });

    // Someone else sees the same library but none of the viewer's progress.
    const theirs = (await call(boss, 'GET', '/api/home')).json();
    expect(theirs.continue).toEqual([]);
    expect(theirs.recent).toHaveLength(3);
    expect(theirs.featured.find((f: { title: string }) => f.title === 'Severance').play).toMatchObject({ id: show.eps[0] });
  });

  it('plays what you watched most recently, the same on Home and the title page', async () => {
    const { viewer } = await users();
    const show = addSeries('show', 'Severance', 3);
    // Episode 2 was opened for a few seconds a while ago; episode 1 is half watched, more recently.
    await call(viewer, 'PUT', `/api/play/episode/${show.eps[1]}/progress`, { position: 8, duration: 3000 });
    db.prepare("UPDATE watch_progress SET updated_at = '2026-01-01T00:00:00.000Z' WHERE episode_id = ?").run(show.eps[1]);
    await call(viewer, 'PUT', `/api/play/episode/${show.eps[0]}/progress`, { position: 1500, duration: 3000 });

    const home = (await call(viewer, 'GET', '/api/home')).json();
    expect(home.featured[0].play).toMatchObject({ id: show.eps[0], resume: true, minutesLeft: 25 });
    expect(home.continue[0]).toMatchObject({ id: show.eps[0], resume: true });
    expect((await call(viewer, 'GET', `/api/media/${show.id}`)).json().play).toMatchObject({ kind: 'episode', id: show.eps[0], resume: true });

    // Finishing it moves Play on to episode 2.
    await call(viewer, 'PUT', `/api/play/episode/${show.eps[0]}/progress`, { position: 2950, duration: 3000 });
    expect((await call(viewer, 'GET', `/api/media/${show.id}`)).json().play).toMatchObject({ id: show.eps[1], resume: false, label: 'S01E02' });
  });

  it('needs you to be signed in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/home' })).statusCode).toBe(401);
  });
});

describe('home or away', () => {
  it('treats private addresses as home', () => {
    for (const ip of ['127.0.0.1', '::1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '::ffff:192.168.0.9', 'fd12::1']) expect(isLocalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1', '::ffff:1.1.1.1']) expect(isLocalAddress(ip), ip).toBe(false);
  });
});
