import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { folderBytes, outermost, resetStorageCache, storageUsage } from './storage.js';

let tmp: string;
const write = (rel: string, bytes: number) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
};

beforeEach(() => {
  initDb(':memory:');
  resetStorageCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-storage-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('drive usage for the sidebar', () => {
  it('adds up everything inside a folder', async () => {
    write('Movies/Dune (2021)/Dune.mkv', 3000);
    write('Movies/Dune (2021)/Dune.en.srt', 200);
    write('Movies/Arrival (2016)/Arrival.mkv', 1500);
    expect(await folderBytes(path.join(tmp, 'Movies'))).toBe(4700);
    expect(await folderBytes(path.join(tmp, 'missing'))).toBe(0);
  });

  it('counts a folder inside another library folder only once', () => {
    expect(outermost([path.join('D:', 'Media'), path.join('D:', 'Media', 'Anime'), path.join('E:', 'Shows')])).toEqual([path.join('D:', 'Media'), path.join('E:', 'Shows')]);
  });

  it('groups the library folders by drive, with the library share and free space', async () => {
    write('Movies/Dune.mkv', 4000);
    write('Anime/Frieren/ep1.mkv', 1000);
    saveSettings({ moviesRoots: [path.join(tmp, 'Movies')], animeRoots: [path.join(tmp, 'Anime')], showsRoots: [path.join(tmp, 'Unplugged')] });
    const [drive, ...more] = await storageUsage({ fresh: true });
    expect(more).toEqual([]); // both folders are on the same drive; the missing one is skipped
    expect(drive.libraries).toEqual(['Movies', 'Anime']);
    expect(drive.mediaBytes).toBe(5000);
    expect(drive.totalBytes).toBeGreaterThan(drive.freeBytes);
    expect(drive.freeBytes).toBeGreaterThan(0);
    expect(drive.label).toBe(process.platform === 'win32' ? path.parse(tmp).root.replace(/[\\/]+$/, '') : '/');
  });
});
