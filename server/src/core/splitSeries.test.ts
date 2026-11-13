import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, getMedia, initDb, now, type DownloadRow, type MediaRow } from '../db.js';
import { saveSettings } from '../settings.js';
import { importDownload } from './importer.js';
import { chooseSeriesRoot, inTitleDirs, titleDirFor, titleDirs, type FolderSpace } from './rootFolders.js';
import { linkFiles } from './scanner.js';

const GB = 1024 ** 3;
let tmp: string;
let A: string;
let B: string;
let C: string;

const touch = (p: string, size = 10) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};
const fakeSpace = (free: Record<string, number>) => (p: string): FolderSpace => ({ path: p, exists: fs.existsSync(p), freeBytes: free[p] ?? null, totalBytes: 2000 * GB });

function addShow(): MediaRow {
  const id = Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Severance', 2022, ?, 'Severance (2022)', ?)`)
      .run(A, now()).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, title) VALUES (?, 1, ?, ?)');
  ins.run(id, 1, 'Good News About Hell');
  ins.run(id, 2, 'Half Loop');
  ins.run(id, 3, 'In Perpetuity');
  return getMedia(id)!;
}

beforeEach(() => {
  initDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-split-'));
  [A, B, C] = ['A', 'B', 'C'].map((d) => path.join(tmp, d));
  for (const d of [A, B, C]) fs.mkdirSync(d);
  saveSettings({ showsRoots: [A, B, C], minFreeSpaceGb: 50 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('where a series download goes', () => {
  it('stays on its own drive while that keeps the minimum free space', () => {
    expect(chooseSeriesRoot(addShow(), 10 * GB, fakeSpace({ [A]: 100 * GB, [B]: 900 * GB }))).toBe(A);
  });

  it('spills onto the next drive instead of going below it', () => {
    // 55 GB free - 10 GB would leave 45 GB, under the 50 GB kept free.
    expect(chooseSeriesRoot(addShow(), 10 * GB, fakeSpace({ [A]: 55 * GB, [B]: 900 * GB, [C]: 900 * GB }))).toBe(B);
  });

  it('prefers a drive that already holds part of the series', () => {
    fs.mkdirSync(path.join(C, 'Severance (2022)'));
    expect(chooseSeriesRoot(addShow(), 10 * GB, fakeSpace({ [A]: 55 * GB, [B]: 900 * GB, [C]: 900 * GB }))).toBe(C);
  });

  it('uses the drive with the most room when none can keep that much free, and refuses to fill one', () => {
    const m = addShow();
    expect(chooseSeriesRoot(m, 10 * GB, fakeSpace({ [A]: 20 * GB, [B]: 40 * GB, [C]: 30 * GB }))).toBe(B);
    expect(() => chooseSeriesRoot(m, 10 * GB, fakeSpace({ [A]: 5 * GB, [B]: 6 * GB, [C]: 2 * GB }))).toThrow(/Not enough space/);
  });

  it('skips a drive that is unplugged', () => {
    saveSettings({ showsRoots: [A, path.join(tmp, 'gone'), C] });
    expect(chooseSeriesRoot(addShow(), 10 * GB, fakeSpace({ [A]: 55 * GB, [C]: 900 * GB }))).toBe(C);
  });
});

describe('a series split across drives', () => {
  it('knows all its folders', () => {
    const m = addShow();
    fs.mkdirSync(path.join(B, 'Severance (2022)'));
    expect(titleDirs(m, { existingOnly: true })).toEqual([path.join(A, 'Severance (2022)'), path.join(B, 'Severance (2022)')]);
    expect(titleDirFor(m, path.join(B, 'Severance (2022)'))).toBe(path.join(B, 'Severance (2022)'));
    expect(titleDirFor(m, path.join(tmp, 'elsewhere'))).toBe(path.join(A, 'Severance (2022)'));
    expect(inTitleDirs(m, path.join(C, 'Severance (2022)', 'Season 01', 'x.mkv'))).toBe(true);
    expect(inTitleDirs(m, path.join(C, 'Other Show', 'x.mkv'))).toBe(false);
  });

  it('a library scan links the episodes on every drive', async () => {
    const m = addShow();
    touch(path.join(A, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E01 - Good News About Hell.mkv'));
    touch(path.join(B, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E02 - Half Loop.mkv'));
    expect(await linkFiles(m)).toBe(2);
    const files = db.prepare('SELECT episode, file_path FROM episodes WHERE media_id = ? AND has_file = 1 ORDER BY episode').all(m.id);
    expect(files).toEqual([
      { episode: 1, file_path: path.join(A, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E01 - Good News About Hell.mkv') },
      { episode: 2, file_path: path.join(B, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E02 - Half Loop.mkv') },
    ]);
  });

  it('a download saved on the other drive is imported there, next to nothing else', async () => {
    const m = addShow();
    touch(path.join(A, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E01 - Good News About Hell.mkv'));
    const save = path.join(B, 'Severance (2022)');
    const dir = path.join(save, 'Severance.S01E03.1080p.WEB-DL');
    touch(path.join(dir, 'Severance.S01E03.1080p.WEB-DL.mkv'), 5000);
    const ep3 = (db.prepare('SELECT id FROM episodes WHERE media_id = ? AND episode = 3').get(m.id) as { id: number }).id;
    const dl = {
      id: 1, media_id: m.id, episode_ids: JSON.stringify([ep3]), release_title: 'Severance.S01E03.1080p.WEB-DL', indexer: null, size: null,
      qbit_hash: null, tag: 'mediarr-1', save_path: save, content_path: dir, state: 'importing', progress: 1, error: null, created_at: now(), updated_at: now(),
    } as DownloadRow;

    const r = await importDownload(dl, dir);

    expect(r.imported).toHaveLength(1);
    expect(r.imported[0].startsWith(path.join(B, 'Severance (2022)', 'Season 01'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // The first episode on drive A is untouched; the title still lives on A.
    expect(fs.existsSync(path.join(A, 'Severance (2022)', 'Season 01', 'Severance (2022) - S01E01 - Good News About Hell.mkv'))).toBe(true);
    expect(getMedia(m.id)!.root_folder).toBe(A);
  });
});
