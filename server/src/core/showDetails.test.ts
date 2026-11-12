import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as dbModule from '../db.js';

vi.mock('../clients/tmdb.js', async (orig) => {
  const real = await orig<typeof import('../clients/tmdb.js')>();
  return {
    ...real,
    getShow: async () => ({
      tmdbId: 57243,
      title: 'Doctor Who',
      originalTitle: 'Doctor Who',
      year: 2005,
      poster: null,
      backdrop: null,
      overview: '',
      status: 'Ended',
      seasons: [
        { season: 1, name: 'Series 1', episodeCount: 2, airDate: '2005-03-26' },
        { season: 2, name: 'The Second Coming', episodeCount: 1, airDate: '2006-04-15' },
      ],
    }),
    getShowEpisodes: async () => [
      { season: 1, episode: 1, title: 'Rose', airDate: '2005-03-26', overview: 'Rose meets the Doctor.', still: 'https://image.tmdb.org/t/p/w300/rose.jpg' },
      { season: 1, episode: 2, title: 'The End of the World', airDate: '2005-04-02', overview: 'Five billion years ahead.', still: 'https://image.tmdb.org/t/p/w300/end.jpg' },
      { season: 2, episode: 1, title: 'New Earth', airDate: '2006-04-15', overview: null, still: null },
    ],
  };
});

const { refreshMedia } = await import('./library.js');

describe('TV show episode details', () => {
  it('a refresh stores each episode’s summary and still, and the season names', async () => {
    dbModule.initDb(':memory:');
    const db = dbModule.db;
    const id = Number(
      db.prepare("INSERT INTO media (type, tmdb_id, title, root_folder, folder_name, monitored, added_at) VALUES ('show', 57243, 'Doctor Who', 'lib', 'Doctor Who', 0, ?)").run(dbModule.now()).lastInsertRowid,
    );
    // Added before details were stored: titles only.
    db.prepare("INSERT INTO episodes (media_id, season, episode, title) VALUES (?, 1, 1, 'Rose'), (?, 1, 2, 'The End of the World')").run(id, id);

    await refreshMedia(id);
    const eps = db.prepare('SELECT season, episode, overview, still FROM episodes WHERE media_id = ? ORDER BY season, episode').all(id);
    expect(eps).toEqual([
      expect.objectContaining({ season: 1, episode: 1, overview: 'Rose meets the Doctor.', still: 'https://image.tmdb.org/t/p/w300/rose.jpg' }),
      expect.objectContaining({ season: 1, episode: 2, overview: 'Five billion years ahead.', still: 'https://image.tmdb.org/t/p/w300/end.jpg' }),
      expect.objectContaining({ season: 2, episode: 1, overview: null, still: null }),
    ]);
    expect(JSON.parse((db.prepare('SELECT season_names FROM media WHERE id = ?').get(id) as { season_names: string }).season_names)).toEqual({
      1: 'Series 1',
      2: 'The Second Coming',
    });
  });

  it('series from before the update are refreshed once, on the first start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-details-'));
    const file = path.join(dir, 'm.db');
    let db = dbModule.initDb(file);
    const add = (type: string, tmdb: number) =>
      db.prepare("INSERT INTO media (type, tmdb_id, title, root_folder, folder_name, added_at, last_refresh) VALUES (?, ?, 'x', 'lib', 'x', ?, ?)").run(type, tmdb, dbModule.now(), dbModule.now());
    add('show', 1);
    add('movie', 2);
    // As if this database came from before the update: the one-time marker isn't there yet.
    db.prepare("DELETE FROM settings WHERE key = 'internal.episodeDetailsBackfill'").run();
    db.close();

    db = dbModule.initDb(file);
    const refreshed = () => db.prepare('SELECT type, last_refresh FROM media ORDER BY id').all() as { type: string; last_refresh: string | null }[];
    expect(refreshed().map((r) => [r.type, r.last_refresh === null])).toEqual([
      ['show', true],
      ['movie', false],
    ]);
    // Only once: after the next refresh, a restart leaves it alone.
    db.prepare('UPDATE media SET last_refresh = ?').run(dbModule.now());
    db.close();
    db = dbModule.initDb(file);
    expect(refreshed().every((r) => r.last_refresh !== null)).toBe(true);
    db.close();
    dbModule.initDb(':memory:');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
