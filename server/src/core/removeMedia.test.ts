import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, getMedia, initDb, now } from '../db.js';
import { saveSettings } from '../settings.js';
import { filesSummary, removeMedia } from './removeMedia.js';

let tmp: string;
let A: string;
let B: string;
let outside: string;
const touch = (p: string, size = 100) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};

beforeEach(() => {
  initDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-remove-'));
  A = path.join(tmp, 'A');
  B = path.join(tmp, 'B');
  outside = path.join(tmp, 'Elsewhere');
  for (const d of [A, B, outside]) fs.mkdirSync(d);
  saveSettings({ showsRoots: [A, B] });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function show(folder = 'Severance (2022)') {
  const id = Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Severance', 2022, ?, ?, ?)`)
      .run(A, folder, now()).lastInsertRowid,
  );
  return id;
}

describe('removing a title', () => {
  it('keeps the files unless asked to delete them', async () => {
    const id = show();
    touch(path.join(A, 'Severance (2022)', 'Season 01', 'ep1.mkv'));
    await removeMedia(getMedia(id)!, false, 'owner');
    expect(getMedia(id)).toBeUndefined();
    expect(fs.existsSync(path.join(A, 'Severance (2022)', 'Season 01', 'ep1.mkv'))).toBe(true);
  });

  it('deletes its folder on every drive (a split series), and nothing else', async () => {
    const id = show();
    touch(path.join(A, 'Severance (2022)', 'Season 01', 'ep1.mkv'), 1000);
    touch(path.join(B, 'Severance (2022)', 'Season 02', 'ep1.mkv'), 2000);
    touch(path.join(A, 'Other Show (2020)', 'ep.mkv'));
    // A file of it outside the library folders is never touched.
    const stray = path.join(outside, 'Severance.S01E02.mkv');
    touch(stray);
    db.prepare('INSERT INTO episodes (media_id, season, episode, has_file, file_path) VALUES (?, 1, 2, 1, ?)').run(id, stray);

    const summary = await filesSummary(getMedia(id)!);
    expect(summary).toMatchObject({ count: 2, bytes: 3000 });
    expect(summary.folders.sort()).toEqual([path.join(A, 'Severance (2022)'), path.join(B, 'Severance (2022)')].sort());

    const r = await removeMedia(getMedia(id)!, true, 'owner');
    expect(r).toMatchObject({ deleted: 2, bytes: 3000, errors: [] });
    expect(fs.existsSync(path.join(A, 'Severance (2022)'))).toBe(false);
    expect(fs.existsSync(path.join(B, 'Severance (2022)'))).toBe(false);
    expect(fs.existsSync(A) && fs.existsSync(B)).toBe(true);
    expect(fs.existsSync(path.join(A, 'Other Show (2020)', 'ep.mkv'))).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('never deletes a library folder itself', async () => {
    // A broken entry whose folder name is empty would point at the library folder.
    const id = show('');
    touch(path.join(A, 'Other Show (2020)', 'ep.mkv'));
    expect((await filesSummary(getMedia(id)!)).count).toBe(0);
    await removeMedia(getMedia(id)!, true, 'owner');
    expect(fs.existsSync(path.join(A, 'Other Show (2020)', 'ep.mkv'))).toBe(true);
  });
});
