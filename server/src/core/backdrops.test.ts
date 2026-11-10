import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '../db.js';
import { saveSettings } from '../settings.js';
import { backfillBackdrops } from './library.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const insert = (type: string, ids: { tmdb?: number; anilist?: number }, seasons?: unknown) =>
  Number(
    dbModule.db
      .prepare('INSERT INTO media (type, tmdb_id, anilist_id, title, root_folder, folder_name, anime_seasons, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(type, ids.tmdb ?? null, ids.anilist ?? null, `t${ids.tmdb ?? ids.anilist}`, 'C:\\lib', 'x', seasons ? JSON.stringify(seasons) : null, dbModule.now()).lastInsertRowid,
  );
const backdropOf = (id: number) => (dbModule.db.prepare('SELECT backdrop FROM media WHERE id = ?').get(id) as { backdrop: string | null }).backdrop;

describe('backdrops for the Home page', () => {
  beforeEach(() => {
    dbModule.initDb(':memory:');
    saveSettings({ tmdbApiKey: 'a'.repeat(32) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fills in titles added before backdrops were stored, and stops asking about ones that have none', async () => {
    const movie = insert('movie', { tmdb: 438631 });
    const show = insert('show', { tmdb: 95396 });
    // The anime's first season has no banner, its second does.
    const anime = insert('anime', { anilist: 1 }, [{ season: 1, anilistIds: [1] }, { season: 2, anilistIds: [2] }]);
    const bare = insert('anime', { anilist: 9 });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === 'api.themoviedb.org') {
        asked.push(u.pathname);
        return json({ id: 1, title: 'X', name: 'X', poster_path: '/p.jpg', backdrop_path: u.pathname.includes('/tv/') ? '/show.jpg' : '/movie.jpg', status: 'Released', seasons: [] });
      }
      const ids = (JSON.parse(String(init?.body)).variables.ids as number[]) ?? [];
      asked.push(`anilist ${ids.join(',')}`);
      return json({ data: { Page: { media: ids.map((id) => ({ id, bannerImage: id === 2 ? 'https://anilist/banner2.jpg' : null })) } } });
    });

    expect(await backfillBackdrops({ delayMs: 0 })).toBe(3);
    expect(backdropOf(movie)).toBe('https://image.tmdb.org/t/p/w1280/movie.jpg');
    expect(backdropOf(show)).toBe('https://image.tmdb.org/t/p/w1280/show.jpg');
    expect(backdropOf(anime)).toBe('https://anilist/banner2.jpg');
    expect(backdropOf(bare)).toBe('');
    expect(asked).toContain('anilist 1,2');

    // Next start: nothing left to ask about.
    asked.length = 0;
    expect(await backfillBackdrops({ delayMs: 0 })).toBe(0);
    expect(asked).toEqual([]);
  });

  it('leaves a title for next time when the request fails', async () => {
    const movie = insert('movie', { tmdb: 1 });
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await backfillBackdrops({ delayMs: 0 });
    expect(backdropOf(movie)).toBeNull();
  });

  it('adds the column to a database from an older version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-backdrop-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE media (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, tmdb_id INTEGER, anilist_id INTEGER, title TEXT NOT NULL,
      alt_titles TEXT NOT NULL DEFAULT '[]', year INTEGER, poster TEXT, overview TEXT, root_folder TEXT NOT NULL, folder_name TEXT NOT NULL,
      monitored INTEGER NOT NULL DEFAULT 1, anime_audio TEXT, status TEXT, release_date TEXT, has_file INTEGER NOT NULL DEFAULT 0, file_path TEXT,
      last_search TEXT, last_refresh TEXT, added_at TEXT NOT NULL)`);
    old.close();
    const db = dbModule.initDb(file);
    const cols = (db.prepare('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('backdrop');
    db.close();
    dbModule.initDb(':memory:');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
