import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, getMedia, initDb, now, type MediaRow } from '../db.js';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../settings.js';
import { chooseRoot, ensureRoom, movesSettled, type FolderSpace } from './rootFolders.js';

const GB = 1024 ** 3;
let tmp: string;
let driveA: string;
let driveB: string;

beforeEach(() => {
  initDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-roots-'));
  driveA = path.join(tmp, 'A');
  driveB = path.join(tmp, 'B');
  fs.mkdirSync(driveA);
  fs.mkdirSync(driveB);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const settings = (moviesRoots: string[], minFreeSpaceGb = 50): Settings => ({ ...DEFAULT_SETTINGS, moviesRoots, minFreeSpaceGb });
const fakeSpace = (free: Record<string, number>) => (p: string): FolderSpace => ({
  path: p,
  exists: fs.existsSync(p),
  freeBytes: free[p] ?? null,
  totalBytes: 2000 * GB,
});

describe('choosing a library folder', () => {
  it('uses the first folder while its drive has room', () => {
    const space = fakeSpace({ [driveA]: 500 * GB, [driveB]: 900 * GB });
    expect(chooseRoot(settings([driveA, driveB]), 'movie', 'Dune (2021)', space)).toBe(driveA);
  });

  it('moves on to the next folder when a drive is nearly full', () => {
    const space = fakeSpace({ [driveA]: 10 * GB, [driveB]: 900 * GB });
    expect(chooseRoot(settings([driveA, driveB]), 'movie', 'Dune (2021)', space)).toBe(driveB);
  });

  it('picks the emptiest drive when every drive is nearly full', () => {
    const space = fakeSpace({ [driveA]: 10 * GB, [driveB]: 30 * GB });
    expect(chooseRoot(settings([driveA, driveB]), 'movie', 'Dune (2021)', space)).toBe(driveB);
  });

  it('keeps a title with its existing folder', () => {
    fs.mkdirSync(path.join(driveB, 'Dune (2021)'));
    const space = fakeSpace({ [driveA]: 500 * GB, [driveB]: 10 * GB });
    expect(chooseRoot(settings([driveA, driveB]), 'movie', 'Dune (2021)', space)).toBe(driveB);
  });

  it('skips a folder that no longer exists', () => {
    const gone = path.join(tmp, 'unplugged');
    expect(chooseRoot(settings([gone, driveB]), 'movie', 'Dune (2021)', fakeSpace({ [driveB]: 900 * GB }))).toBe(driveB);
  });

  it('has nothing to choose without folders', () => {
    expect(chooseRoot(settings([]), 'movie', 'Dune (2021)')).toBeNull();
  });
});

describe('downloads that do not fit', () => {
  function addMovie(): MediaRow {
    const id = Number(
      db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('movie', 1, 'Dune', 2021, ?, 'Dune (2021)', ?)`)
        .run(driveA, now()).lastInsertRowid,
    );
    return getMedia(id)!;
  }
  const useFolders = () => saveSettings({ moviesRoots: [driveA, driveB] });

  it('leaves the title where it is when the download fits', async () => {
    useFolders();
    const m = addMovie();
    const after = await ensureRoom(m, 5 * GB, fakeSpace({ [driveA]: 100 * GB, [driveB]: 900 * GB }));
    expect(after.root_folder).toBe(driveA);
  });

  it('moves the title, files and all, to a folder with room', async () => {
    useFolders();
    const m = addMovie();
    const oldFile = path.join(driveA, 'Dune (2021)', 'Dune (2021) [720p].mkv');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, 'x');
    db.prepare('UPDATE media SET has_file = 1, file_path = ? WHERE id = ?').run(oldFile, m.id);

    const after = await ensureRoom(getMedia(m.id)!, 5 * GB, fakeSpace({ [driveA]: 3 * GB, [driveB]: 900 * GB }));
    await movesSettled();

    const newFile = path.join(driveB, 'Dune (2021)', 'Dune (2021) [720p].mkv');
    expect(after.root_folder).toBe(driveB);
    expect(getMedia(m.id)!.file_path).toBe(newFile);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(path.join(driveA, 'Dune (2021)'))).toBe(false);
  });

  it('refuses when no folder has room', async () => {
    useFolders();
    const m = addMovie();
    await expect(ensureRoom(m, 5 * GB, fakeSpace({ [driveA]: 3 * GB, [driveB]: 4 * GB }))).rejects.toThrow(/Not enough space/);
    expect(getMedia(m.id)!.root_folder).toBe(driveA);
  });

  it('waits for downloads still arriving in the old folder', async () => {
    useFolders();
    const m = addMovie();
    db.prepare(`INSERT INTO downloads (media_id, release_title, save_path, state, created_at, updated_at) VALUES (?, 'x', ?, 'downloading', ?, ?)`)
      .run(m.id, path.join(driveA, 'Dune (2021)'), now(), now());
    await expect(ensureRoom(m, 5 * GB, fakeSpace({ [driveA]: 3 * GB, [driveB]: 900 * GB }))).rejects.toThrow(/once its current downloads finish/);
  });

  it('counts downloads still in flight against the drive', async () => {
    useFolders();
    const m = addMovie();
    const other = Number(
      db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('movie', 2, 'Other', 2020, ?, 'Other (2020)', ?)`)
        .run(driveA, now()).lastInsertRowid,
    );
    db.prepare(`INSERT INTO downloads (media_id, release_title, size, save_path, state, created_at, updated_at) VALUES (?, 'x', ?, ?, 'downloading', ?, ?)`)
      .run(other, 90 * GB, path.join(driveA, 'Other (2020)'), now(), now());
    // 100 GB free, but 90 GB of it is already spoken for.
    const after = await ensureRoom(m, 20 * GB, fakeSpace({ [driveA]: 100 * GB, [driveB]: 900 * GB }));
    expect(after.root_folder).toBe(driveB);
  });
});

describe('folder settings', () => {
  it('carries over the single folder from before', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('moviesRoot', ?)").run(JSON.stringify('D:\\Movies'));
    expect(getSettings().moviesRoots).toEqual(['D:\\Movies']);
  });

  it('saves a clean list (no blanks or repeats)', () => {
    saveSettings({ showsRoots: [' D:\\Shows ', '', 'E:\\Shows', 'D:\\Shows'] });
    expect(getSettings().showsRoots).toEqual(['D:\\Shows', 'E:\\Shows']);
  });
});
