import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, initDb, now, type DownloadRow } from '../db.js';
import { importDownload } from './importer.js';

let root: string;

function touch(p: string, size = 10) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
}

function addMedia(type: string, title: string, folder: string, year: number | null) {
  return Number(
    db
      .prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(type, Math.floor(Math.random() * 1e9), title, year, root, folder, now()).lastInsertRowid,
  );
}

function download(mediaId: number, release: string, episodeIds: number[] = []): DownloadRow {
  return {
    id: 1,
    media_id: mediaId,
    episode_ids: JSON.stringify(episodeIds),
    release_title: release,
    indexer: null,
    size: null,
    qbit_hash: null,
    tag: 'mediarr-1',
    save_path: root,
    content_path: null,
    state: 'importing',
    progress: 1,
    error: null,
    created_at: now(),
    updated_at: now(),
  };
}

beforeEach(() => {
  initDb(':memory:');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-test-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('importDownload', () => {
  it('renames a movie folder and removes leftovers', async () => {
    const id = addMedia('movie', 'Dune', 'Dune (2021)', 2021);
    const torrentDir = path.join(root, 'Dune.2021.1080p.WEB-DL.x264-GRP');
    touch(path.join(torrentDir, 'Dune.2021.1080p.WEB-DL.x264-GRP.mkv'), 5000);
    touch(path.join(torrentDir, 'Dune.2021.1080p.WEB-DL.x264-GRP.en.srt'));
    touch(path.join(torrentDir, 'Sample', 'sample.mkv'));
    touch(path.join(torrentDir, 'info.nfo'));

    const r = await importDownload(download(id, 'Dune.2021.1080p.WEB-DL.x264-GRP'), torrentDir);

    const dest = path.join(root, 'Dune (2021)', 'Dune (2021) [1080p].mkv');
    expect(r.imported).toEqual([dest]);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(root, 'Dune (2021)', 'Dune (2021) [1080p].en.srt'))).toBe(true);
    expect(fs.existsSync(torrentDir)).toBe(false);
    expect((db.prepare('SELECT has_file FROM media WHERE id = ?').get(id) as { has_file: number }).has_file).toBe(1);
  });

  it('renames a show season pack into a season folder', async () => {
    const id = addMedia('show', 'Severance', 'Severance (2022)', 2022);
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, title) VALUES (?, 1, ?, ?)');
    ins.run(id, 1, 'Good News About Hell');
    ins.run(id, 2, 'Half Loop');
    const dir = path.join(root, 'Severance.S01.1080p.WEB-DL');
    touch(path.join(dir, 'Severance.S01E01.1080p.WEB-DL.mkv'));
    touch(path.join(dir, 'Severance.S01E02.1080p.WEB-DL.mkv'));

    await importDownload(download(id, 'Severance.S01.1080p.WEB-DL'), dir);

    const season = path.join(root, 'Severance (2022)', 'Season 01');
    expect(fs.readdirSync(season).sort()).toEqual([
      'Severance (2022) - S01E01 - Good News About Hell.mkv',
      'Severance (2022) - S01E02 - Half Loop.mkv',
    ]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('renames a single-file anime episode', async () => {
    const id = addMedia('anime', 'Frieren', 'Frieren', 2023);
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, absolute_number) VALUES (?, 1, ?, ?)');
    for (let i = 1; i <= 28; i++) ins.run(id, i, i);
    const file = path.join(root, '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD].mkv');
    touch(file);

    await importDownload(download(id, '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD]'), file);

    expect(fs.existsSync(path.join(root, 'Frieren', 'Season 01', 'Frieren - S01E05.mkv'))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses paths outside the save folder', async () => {
    const id = addMedia('movie', 'X', 'X', null);
    await expect(importDownload(download(id, 'X'), os.tmpdir())).rejects.toThrow(/outside/);
  });
});
