import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProwlarrRelease } from '../clients/prowlarr.js';
import { db, initDb, now, type DownloadRow } from '../db.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { AnimeSeason } from './animeMatch.js';
import { importDownload } from './importer.js';
import { coverageLabel, scoreRelease, type ScoreContext } from './scoring.js';

const rel = (title: string): ProwlarrRelease => ({
  guid: title, title, size: 2 * 1024 ** 3, seeders: 50, leechers: 0, indexer: 'x', indexerId: 1, protocol: 'torrent',
});

const show = (season: number): ScoreContext => ({
  type: 'show',
  titles: ['Breaking Bad'],
  year: 2008,
  animeAudio: null,
  scope: { kind: 'season', season, episodes: [1, 2, 3, 4, 5, 6, 7] },
  settings: { ...DEFAULT_SETTINGS, maxEpisodeSizeGb: 10 },
  seasonEpisodeCounts: { 1: 7, 2: 13, 3: 13, 4: 13, 5: 16 },
});

describe('exact vs bundle', () => {
  it.each([
    ['Breaking.Bad.S01.1080p.BluRay', 'exact', [1]],
    ['Breaking Bad Season 1 Complete 1080p', 'exact', [1]],
    ['Breaking.Bad.S01-S05.1080p.BluRay', 'bundle', [1, 2, 3, 4, 5]],
    ['Breaking Bad Season 1 & 2 1080p', 'bundle', [1, 2]],
    ['Breaking Bad Complete Series 1080p', 'bundle', [1, 2, 3, 4, 5]],
    ['Breaking Bad (2008-2013) 1080p BluRay', 'bundle', [1, 2, 3, 4, 5]],
  ])('%s → %s', (title, coverage, covers) => {
    const r = scoreRelease(rel(title), show(1));
    expect(r.rejections).toEqual([]);
    expect(r.coverage).toBe(coverage);
    expect(r.covers).toEqual(covers);
  });

  it('rejects bundles that do not include the season', () => {
    expect(scoreRelease(rel('Breaking.Bad.S02-S03.1080p'), show(1)).rejections[0]).toMatch(/Wrong season/);
  });

  it('labels bundles', () => {
    expect(coverageLabel([1, 2, 3], [1, 2, 3, 4, 5])).toBe('S1–S3');
    expect(coverageLabel([1, 3], [1, 2, 3])).toBe('S1 + S3');
    expect(coverageLabel([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe('Complete series');
  });

  it('classifies anime batches across seasons', () => {
    const seasons: AnimeSeason[] = [
      { season: 1, anilistIds: [1], title: 'Slime', titles: ['Tensei Shitara Slime Datta Ken'], episodes: 24, offset: 0, year: 2018 },
      { season: 2, anilistIds: [2], title: 'Slime 2', titles: ['Tensei Shitara Slime Datta Ken 2nd Season'], episodes: 24, offset: 24, year: 2021 },
    ];
    const ctx: ScoreContext = {
      type: 'anime', titles: ['Tensei Shitara Slime Datta Ken'], year: 2018, animeAudio: 'sub',
      scope: { kind: 'season', season: 1, episodes: Array.from({ length: 24 }, (_, i) => i + 1) },
      settings: { ...DEFAULT_SETTINGS, maxEpisodeSizeGb: 10 }, animeSeasons: seasons,
    };
    expect(scoreRelease(rel('[Judas] Tensei Shitara Slime Datta Ken (Season 1) [BD 1080p]'), ctx).coverage).toBe('exact');
    expect(scoreRelease(rel('[Judas] Tensei Shitara Slime Datta Ken 1st & 2nd Season [BD 1080p]'), ctx).coverage).toBe('bundle');
    expect(scoreRelease(rel('[Group] Tensei Shitara Slime Datta Ken 01-48 [1080p]'), ctx).coverage).toBe('bundle');
    expect(scoreRelease(rel('[Group] Tensei Shitara Slime Datta Ken S1-S2 [Batch]'), ctx).covers).toEqual([1, 2]);
  });
});

describe('importing a bundle', () => {
  let root: string;
  beforeEach(() => {
    initDb(':memory:');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-bundle-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const touch = (p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  };

  it('uses season folders, skips extras, and keeps episodes you already have', async () => {
    const id = Number(
      db.prepare(`INSERT INTO media (type, anilist_id, title, year, root_folder, folder_name, added_at) VALUES ('anime', 1, 'Slime', 2018, ?, 'Slime', ?)`)
        .run(root, now()).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, absolute_number, has_file, file_path) VALUES (?, ?, ?, ?, ?, ?)');
    for (let e = 1; e <= 3; e++) ins.run(id, 1, e, e, e === 1 ? 1 : 0, e === 1 ? path.join(root, 'existing.mkv') : null);
    for (let e = 1; e <= 3; e++) ins.run(id, 2, e, 24 + e, 0, null);
    touch(path.join(root, 'existing.mkv'));

    const dir = path.join(root, '[Group] Slime S1-S2 [Batch]');
    for (let e = 1; e <= 3; e++) touch(path.join(dir, 'Season 1', `[Group] Slime - 0${e}.mkv`));
    for (let e = 1; e <= 3; e++) touch(path.join(dir, 'Season 2', `[Group] Slime - 0${e}.mkv`));
    touch(path.join(dir, 'Season 1', 'Extras', '[Group] Slime - NCOP 01.mkv'));
    touch(path.join(dir, 'Season 2', '[Group] Slime - OVA 01.mkv'));

    const dl: DownloadRow = {
      id: 1, media_id: id, episode_ids: JSON.stringify([2, 3, 4, 5, 6]), release_title: '[Group] Slime S1-S2 [Batch]',
      indexer: null, size: null, qbit_hash: null, tag: 'mediarr-1', save_path: root, content_path: dir, state: 'importing',
      progress: 1, error: null, created_at: now(), updated_at: now(),
    };
    const r = await importDownload(dl, dir);

    expect(r.imported.map((p) => path.relative(root, p)).sort()).toEqual([
      path.join('Slime', 'Season 01', 'Slime - S01E02.mkv'),
      path.join('Slime', 'Season 01', 'Slime - S01E03.mkv'),
      path.join('Slime', 'Season 02', 'Slime - S02E01.mkv'),
      path.join('Slime', 'Season 02', 'Slime - S02E02.mkv'),
      path.join('Slime', 'Season 02', 'Slime - S02E03.mkv'),
    ]);
    expect(fs.existsSync(path.join(root, 'existing.mkv'))).toBe(true); // S01E01 already existed and was kept
    expect(r.skipped.some((p) => p.includes('NCOP'))).toBe(true);
    expect(r.skipped.some((p) => p.includes('OVA'))).toBe(true);
  });
});

describe('bundle cleanup', () => {
  it('removes the leftover folder when only extras remain', async () => {
    initDb(':memory:');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-clean-'));
    try {
      const id = Number(
        db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Show', 2020, ?, 'Show (2020)', ?)`)
          .run(root, now()).lastInsertRowid,
      );
      db.prepare('INSERT INTO episodes (media_id, season, episode) VALUES (?, 1, 1)').run(id);
      const dir = path.join(root, 'Show.S01.1080p');
      fs.mkdirSync(path.join(dir, 'Featurettes'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Show.S01E01.1080p.mkv'), 'x');
      fs.writeFileSync(path.join(dir, 'Featurettes', 'Behind the Scenes.mkv'), 'x');
      const dl: DownloadRow = {
        id: 1, media_id: id, episode_ids: '[]', release_title: 'Show.S01.1080p', indexer: null, size: null, qbit_hash: null,
        tag: 't', save_path: root, content_path: dir, state: 'importing', progress: 1, error: null, created_at: now(), updated_at: now(),
      };
      await importDownload(dl, dir);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(path.join(root, 'Show (2020)', 'Season 01', 'Show (2020) - S01E01.mkv'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cleanup after a partial bundle', () => {
  it('removes fragments of skipped files, but never an unmatched wanted file', async () => {
    initDb(':memory:');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-partial-'));
    try {
      const id = Number(
        db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Show', 2020, ?, 'Show (2020)', ?)`)
          .run(root, now()).lastInsertRowid,
      );
      db.prepare('INSERT INTO episodes (media_id, season, episode) VALUES (?, 1, 1)').run(id);
      db.prepare('INSERT INTO episodes (media_id, season, episode) VALUES (?, 2, 1)').run(id);
      const mk = (rel: string) => {
        const full = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, 'x');
      };
      const run = async (extra: string[]) => {
        const dir = path.join(root, 'Show.S01-S02');
        mk('Show.S01-S02/Season 1/Show.S01E01.mkv');
        mk('Show.S01-S02/Season 2/Show.S02E01.mkv'); // fragment of a skipped file
        extra.forEach(mk);
        db.prepare('UPDATE episodes SET has_file = 0, file_path = NULL').run();
        const dl: DownloadRow = {
          id: 1, media_id: id, episode_ids: '[1]', release_title: 'Show.S01-S02', indexer: null, size: null, qbit_hash: null,
          tag: 't', save_path: root, content_path: dir, select_files: 1, files_selected: 1,
          skipped_files: JSON.stringify(['Show.S01-S02/Season 2/Show.S02E01.mkv']),
          state: 'importing', progress: 1, error: null, created_at: now(), updated_at: now(),
        };
        await importDownload(dl, dir);
        return fs.existsSync(dir);
      };
      expect(await run([])).toBe(false); // only the skipped fragment was left: removed
      expect(await run(['Show.S01-S02/Season 1/weird name.mkv'])).toBe(true); // an unknown full file: kept
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
