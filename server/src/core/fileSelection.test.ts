import { beforeEach, describe, expect, it } from 'vitest';
import type { QbitFile } from '../clients/qbittorrent.js';
import { db, getMedia, initDb, now } from '../db.js';
import { planFileSelection } from './fileSelection.js';

let fileIndex = 0;
const file = (name: string, size = 500 * 1024 ** 2): QbitFile => ({ index: fileIndex++, name, size, priority: 1 });

function addShow(): number {
  const id = Number(
    db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Breaking Bad', 2008, 'C:\\lib', 'Breaking Bad (2008)', ?)`)
      .run(now()).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, monitored) VALUES (?, ?, ?, ?)');
  for (const s of [1, 2, 3]) for (let e = 1; e <= 3; e++) ins.run(id, s, e, s === 1 ? 1 : 0);
  return id;
}

const season1Ids = (mediaId: number) =>
  JSON.stringify((db.prepare('SELECT id FROM episodes WHERE media_id = ? AND season = 1').all(mediaId) as { id: number }[]).map((r) => r.id));

beforeEach(() => {
  initDb(':memory:');
  fileIndex = 0;
});

describe('planFileSelection', () => {
  it('keeps only Season 1 episodes (and their subtitles) from an S01-S03 bundle', () => {
    const id = addShow();
    const files = [
      ...[1, 2, 3].flatMap((s) => [1, 2, 3].map((e) => file(`Breaking.Bad.S01-S03.1080p/Season ${s}/Breaking.Bad.S0${s}E0${e}.1080p.mkv`))),
      file('Breaking.Bad.S01-S03.1080p/Season 1/Breaking.Bad.S01E01.1080p.en.srt', 50_000),
      file('Breaking.Bad.S01-S03.1080p/Season 2/Breaking.Bad.S02E01.1080p.en.srt', 50_000),
      file('Breaking.Bad.S01-S03.1080p/Featurettes/Making of.mkv'),
      file('Breaking.Bad.S01-S03.1080p/info.nfo', 2_000),
    ];
    const plan = planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: 'Breaking.Bad.S01-S03.1080p' }, files)!;
    const kept = files.filter((f) => !plan.skip.includes(f.index)).map((f) => f.name.split('/').slice(1).join('/'));
    expect(kept).toEqual([
      'Season 1/Breaking.Bad.S01E01.1080p.mkv',
      'Season 1/Breaking.Bad.S01E02.1080p.mkv',
      'Season 1/Breaking.Bad.S01E03.1080p.mkv',
      'Season 1/Breaking.Bad.S01E01.1080p.en.srt',
    ]);
    expect(plan).toMatchObject({ keepVideos: 3, skipVideos: 7, seasons: [1] });
  });

  it('uses season folders when file names have no season (anime-style numbering)', () => {
    const id = Number(
      db.prepare(`INSERT INTO media (type, anilist_id, title, year, root_folder, folder_name, added_at) VALUES ('anime', 1, 'Slime', 2018, 'C:\\lib', 'Slime', ?)`)
        .run(now()).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, absolute_number, monitored) VALUES (?, ?, ?, ?, ?)');
    for (const s of [1, 2]) for (let e = 1; e <= 3; e++) ins.run(id, s, e, (s - 1) * 3 + e, s === 1 ? 1 : 0);
    const files = [1, 2].flatMap((s) =>
      [1, 2, 3].map((e) => file(`[Judas] Slime 1st & 2nd Season [BD]/Season ${s}/[Judas] Slime - 0${e}.mkv`)),
    );
    files.push(file('[Judas] Slime 1st & 2nd Season [BD]/Season 1/Extras/[Judas] Slime - NCOP 01.mkv'));
    const plan = planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: '[Judas] Slime 1st & 2nd Season [BD]' }, files)!;
    expect(plan.keepVideos).toBe(3);
    expect(files.filter((f) => !plan.skip.includes(f.index)).every((f) => f.name.includes('/Season 1/') && !f.name.includes('NCOP'))).toBe(true);
  });

  it('ignores words like "Specials" in the bundle folder name', () => {
    const id = addShow();
    const files = [1, 2].map((e) => file(`Breaking Bad Complete Series + Specials/Breaking.Bad.S01E0${e}.mkv`));
    const plan = planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: 'Breaking Bad Complete Series + Specials' }, files)!;
    expect(plan.keepVideos).toBe(2);
  });

  it('returns null (download everything) when no file can be matched', () => {
    const id = addShow();
    const files = [file('Some Bundle/disc1.mkv'), file('Some Bundle/disc2.mkv')];
    expect(planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: 'Breaking Bad Complete Series' }, files)).toBeNull();
  });
});

describe('season pack with extras (the reported Judas layout)', () => {
  const TOP = '[Judas] Tensei Shitara Slime Datta Ken (That Time I Got Reincarnated as a Slime) (Season 1 + OADs) [BD 1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]';

  function addSlime(): number {
    const id = Number(
      db.prepare(`INSERT INTO media (type, anilist_id, title, year, root_folder, folder_name, added_at) VALUES ('anime', 1, 'That Time I Got Reincarnated as a Slime', 2018, 'C:\lib', 'Slime', ?)`)
        .run(now()).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, absolute_number, monitored) VALUES (?, 1, ?, ?, 1)');
    for (let e = 1; e <= 24; e++) ins.run(id, e, e);
    return id;
  }

  it('skips the Extras and OADs folders and keeps all 24 episodes', () => {
    const id = addSlime();
    const files = [
      file(`${TOP}/Extras/[Judas] Tensei Shitara Slime Datta Ken - NCOP 01.mkv`),
      file(`${TOP}/Extras/[Judas] Tensei Shitara Slime Datta Ken - NCED 01.mkv`),
      file(`${TOP}/Extras/[Judas] Tensei Shitara Slime Datta Ken - Menu 01.mkv`),
      ...[1, 2, 3, 4, 5].map((n) => file(`${TOP}/OADs/[Judas] Tensei Shitara Slime Datta Ken - OAD 0${n}.mkv`)),
      ...Array.from({ length: 24 }, (_, i) => file(`${TOP}/[Judas] Tensei Shitara Slime Datta Ken - S01E${String(i + 1).padStart(2, '0')}.mkv`)),
    ];
    const plan = planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: TOP }, files)!;
    const kept = files.filter((f) => !plan.skip.includes(f.index)).map((f) => f.name.slice(TOP.length + 1));
    expect(kept).toHaveLength(24);
    expect(kept.every((n) => /S01E\d\d\.mkv$/.test(n) && !n.includes('/'))).toBe(true);
    expect(plan).toMatchObject({ keepVideos: 24, skipVideos: 8, unknownVideos: 0, seasons: [1] });
  });

  it('keeps a video it cannot identify instead of skipping it', () => {
    const id = addSlime();
    const files = [
      file(`${TOP}/[Judas] Tensei Shitara Slime Datta Ken - S01E01.mkv`),
      file(`${TOP}/Unlabelled Video.mkv`),
      file(`${TOP}/OADs/[Judas] Tensei Shitara Slime Datta Ken - OAD 01.mkv`),
    ];
    const plan = planFileSelection(getMedia(id)!, { episode_ids: season1Ids(id), release_title: TOP }, files)!;
    expect(plan.skip).toEqual([files[2].index]);
    expect(plan.unknownVideos).toBe(1);
  });
});
