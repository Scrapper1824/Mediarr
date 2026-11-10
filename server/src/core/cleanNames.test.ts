import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QbitFile } from '../clients/qbittorrent.js';
import { db, getEpisodes, getMedia, initDb, now, type DownloadRow } from '../db.js';
import { planRenames } from './fileSelection.js';
import { importDownload } from './importer.js';

let fileIndex = 0;
const file = (name: string, size = 500 * 1024 ** 2): QbitFile => ({ index: fileIndex++, name, size, priority: 1 });
const nothingExists = () => false;
let root: string;

function addMedia(type: 'movie' | 'show', title: string, folder: string, year: number): number {
  return Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(type, Math.floor(Math.random() * 1e9), title, year, root, folder, now()).lastInsertRowid,
  );
}

function addShow(): number {
  const id = addMedia('show', 'Breaking Bad', 'Breaking Bad (2008)', 2008);
  const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, monitored) VALUES (?, ?, ?, 1)');
  for (const s of [1, 2]) for (let e = 1; e <= 3; e++) ins.run(id, s, e);
  return id;
}

const ids = (mediaId: number, season: number) => getEpisodes(mediaId).filter((e) => e.season === season).map((e) => e.id);

function download(mediaId: number, release: string, episodeIds: number[], extra: Partial<DownloadRow> = {}): DownloadRow {
  const m = getMedia(mediaId)!;
  return {
    id: 1, media_id: mediaId, episode_ids: JSON.stringify(episodeIds), release_title: release, indexer: null, size: null,
    qbit_hash: null, tag: 'mediarr-1', save_path: path.join(m.root_folder, m.folder_name), content_path: null,
    select_files: 0, files_selected: 1, skipped_files: null, renamed: null, torrent_files: null,
    state: 'importing', progress: 1, error: null, created_at: now(), updated_at: now(), ...extra,
  };
}

function touch(p: string, size = 10) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
}

beforeEach(() => {
  initDb(':memory:');
  fileIndex = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-names-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('clean names in qBittorrent', () => {
  it('names a movie file inside the movie folder', () => {
    const id = addMedia('movie', 'Dune', 'Dune (2021)', 2021);
    const dl = download(id, 'Dune.2021.1080p.WEB-DL.x264-GRP', []);
    const plan = planRenames(getMedia(id)!, dl, [file('Dune.2021.1080p.WEB-DL.x264-GRP.mkv')], new Set(), nothingExists);
    expect(plan.renames).toEqual([{ from: 'Dune.2021.1080p.WEB-DL.x264-GRP.mkv', to: 'Dune (2021) [1080p].mkv' }]);
    expect(plan.targets).toEqual({ 'Dune (2021) [1080p].mkv': [] });
  });

  it('moves episodes and their subtitles into season folders and leaves junk in the torrent folder', () => {
    const id = addShow();
    const dl = download(id, 'Breaking.Bad.S01.1080p', ids(id, 1));
    const files = [
      file('Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.1080p.mkv'),
      file('Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.1080p.en.srt', 50_000),
      file('Breaking.Bad.S01.1080p/Breaking.Bad.S01E02.1080p.mkv'),
      file('Breaking.Bad.S01.1080p/Sample/sample.mkv', 20_000_000),
      file('Breaking.Bad.S01.1080p/info.nfo', 2_000),
    ];
    const plan = planRenames(getMedia(id)!, dl, files, new Set(), nothingExists);
    expect(plan.renames).toEqual([
      { from: 'Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.1080p.mkv', to: 'Season 01/Breaking Bad (2008) - S01E01.mkv' },
      { from: 'Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.1080p.en.srt', to: 'Season 01/Breaking Bad (2008) - S01E01.en.srt' },
      { from: 'Breaking.Bad.S01.1080p/Breaking.Bad.S01E02.1080p.mkv', to: 'Season 01/Breaking Bad (2008) - S01E02.mkv' },
    ]);
    expect(Object.keys(plan.targets)).toHaveLength(2);
  });

  it('never renames skipped files, and parks loose junk of a folderless torrent in its own folder', () => {
    const id = addShow();
    const dl = download(id, 'Breaking.Bad.S01-S02', ids(id, 1), { select_files: 1 });
    const files = [file('Breaking.Bad.S01E01.mkv'), file('Breaking.Bad.S02E01.mkv'), file('info.nfo', 2_000)];
    const plan = planRenames(getMedia(id)!, dl, files, new Set([1]), nothingExists);
    expect(plan.renames).toEqual([
      { from: 'Breaking.Bad.S01E01.mkv', to: 'Season 01/Breaking Bad (2008) - S01E01.mkv' },
      { from: 'Breaking.Bad.S02E01.mkv', to: 'Breaking.Bad.S01-S02/Breaking.Bad.S02E01.mkv' },
      { from: 'info.nfo', to: 'Breaking.Bad.S01-S02/info.nfo' },
    ]);
  });

  it('does not point qBittorrent at a file that already exists (the import replaces it when done)', () => {
    const id = addShow();
    const dl = download(id, 'Breaking.Bad.S01.1080p', ids(id, 1));
    const files = [file('Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.mkv'), file('Breaking.Bad.S01.1080p/Breaking.Bad.S01E02.mkv')];
    const plan = planRenames(getMedia(id)!, dl, files, new Set(), (p) => p.endsWith('S01E01.mkv'));
    expect(plan.renames.map((r) => r.to)).toEqual(['Season 01/Breaking Bad (2008) - S01E02.mkv']);
  });

  it('imports files already in place, moves the rest, and removes only the torrent leftovers', async () => {
    const id = addShow();
    const [e1, e2, e3] = ids(id, 1);
    const mediaDir = path.join(root, 'Breaking Bad (2008)');
    const older = path.join(mediaDir, 'Season 01', 'Breaking Bad (2008) - S01E03.mkv');
    touch(older);
    db.prepare('UPDATE episodes SET has_file = 1, file_path = ? WHERE id = ?').run(older, e3);
    touch(path.join(mediaDir, 'Season 01', 'Breaking Bad (2008) - S01E01.mkv'));
    touch(path.join(mediaDir, 'Breaking.Bad.S01.1080p', 'Breaking.Bad.S01E02.mkv')); // qBittorrent couldn't rename this one
    touch(path.join(mediaDir, 'Breaking.Bad.S01.1080p', 'info.nfo'));
    const files = ['Season 01/Breaking Bad (2008) - S01E01.mkv', 'Breaking.Bad.S01.1080p/Breaking.Bad.S01E02.mkv', 'Breaking.Bad.S01.1080p/info.nfo'];
    const dl = download(id, 'Breaking.Bad.S01.1080p', [e1, e2], { renamed: JSON.stringify({ [files[0]]: [e1] }) });

    const r = await importDownload(dl, mediaDir, files);

    expect(r.imported).toHaveLength(2);
    const eps = getEpisodes(id);
    expect(eps.find((e) => e.id === e1)!.file_path).toBe(path.join(mediaDir, 'Season 01', 'Breaking Bad (2008) - S01E01.mkv'));
    expect(eps.find((e) => e.id === e2)!.file_path).toBe(path.join(mediaDir, 'Season 01', 'Breaking Bad (2008) - S01E02.mkv'));
    expect(fs.existsSync(path.join(mediaDir, 'Season 01', 'Breaking Bad (2008) - S01E02.mkv'))).toBe(true);
    expect(fs.existsSync(older)).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'Breaking.Bad.S01.1080p'))).toBe(false);
  });

  it('imports every renamed episode even when qBittorrent lists only some files at the end', async () => {
    const id = addShow();
    const [e1, e2, e3] = ids(id, 1);
    const mediaDir = path.join(root, 'Breaking Bad (2008)');
    const names = [1, 2, 3].map((n) => `Season 01/Breaking Bad (2008) - S01E0${n}.mkv`);
    for (const n of names) touch(path.join(mediaDir, n));
    const renamed = { [names[0]]: [e1], [names[1]]: [e2], [names[2]]: [e3] };
    const dl = download(id, 'Breaking.Bad.S01', [e1, e2, e3], { renamed: JSON.stringify(renamed) });

    const r = await importDownload(dl, mediaDir, [names[1]]);

    expect(r.imported).toHaveLength(3);
    expect(getEpisodes(id).filter((e) => e.season === 1 && e.has_file)).toHaveLength(3);
  });

  it('never sweeps the whole media folder when the torrent file list is unknown', async () => {
    const id = addShow();
    const mediaDir = path.join(root, 'Breaking Bad (2008)');
    touch(path.join(mediaDir, 'Breaking.Bad.S01E01.mkv'));
    await expect(importDownload(download(id, 'Breaking.Bad.S01', ids(id, 1)), mediaDir)).rejects.toThrow(/belong to this download/);
  });
});
