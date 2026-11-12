import { describe, expect, it } from 'vitest';
import { parseKitsuEpisode, type KitsuEpisode } from '../clients/kitsu.js';
import * as dbModule from '../db.js';
import type { AnimeSeason } from './animeMatch.js';
import { matchKitsu, saveEpisodeDetails } from './episodeDetails.js';

const ep = (number: number, title: string | null = `Title ${number}`): KitsuEpisode => ({
  number,
  title,
  synopsis: `What happens in ${number}`,
  still: `https://kitsu/${number}.png`,
  airDate: null,
});
const season = (n: number, anilistIds: number[], episodes: number): AnimeSeason => ({ season: n, anilistIds, title: `S${n}`, titles: [], episodes, offset: 0, year: 2024 });

describe('anime episode details from Kitsu', () => {
  it('reads Kitsu episodes, dropping placeholder titles', () => {
    expect(parseKitsuEpisode({ number: 3, canonicalTitle: 'Killing Magic', synopsis: ' Frieren… ', thumbnail: { original: 'https://k/3.png' }, airdate: '2023-09-29' })).toEqual({
      number: 3,
      title: 'Killing Magic',
      synopsis: 'Frieren…',
      still: 'https://k/3.png',
      airDate: '2023-09-29',
    });
    expect(parseKitsuEpisode({ number: 4, canonicalTitle: 'Episode 4', titles: { en_us: 'Real Name' } })?.title).toBe('Real Name');
    expect(parseKitsuEpisode({ number: 5, canonicalTitle: 'Episode 5' })?.title).toBeNull();
    expect(parseKitsuEpisode({ number: null })).toBeNull();
  });

  it('numbers split cours on from each other within a season', () => {
    // Season 2 is two AniList entries; the second cour is numbered 13–24 on Kitsu, the first 1–12.
    const byEntry = new Map([
      [1, [1, 2, 3].map((n) => ep(n))],
      [2, Array.from({ length: 12 }, (_, i) => ep(i + 1))],
      [3, Array.from({ length: 12 }, (_, i) => ep(i + 13))],
    ]);
    const out = matchKitsu([season(1, [1], 3), season(2, [2, 3], 24)], byEntry);
    expect(out.filter((d) => d.season === 1).map((d) => d.episode)).toEqual([1, 2, 3]);
    const s2 = out.filter((d) => d.season === 2);
    expect(s2.map((d) => d.episode)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(s2[12]).toMatchObject({ episode: 13, title: 'Title 13' });
    // Nothing past the season's length.
    expect(matchKitsu([season(1, [1], 2)], byEntry).map((d) => d.episode)).toEqual([1, 2]);
  });

  it('fills in only what is missing, never blanking what is there', () => {
    dbModule.initDb(':memory:');
    const db = dbModule.db;
    const mediaId = Number(
      db.prepare("INSERT INTO media (type, anilist_id, title, root_folder, folder_name, added_at) VALUES ('anime', 1, 'X', 'lib', 'X', ?)").run(dbModule.now()).lastInsertRowid,
    );
    db.prepare("INSERT INTO episodes (media_id, season, episode, title) VALUES (?, 1, 1, 'Kept')").run(mediaId);
    db.prepare('INSERT INTO episodes (media_id, season, episode) VALUES (?, 1, 2)').run(mediaId);
    const n = saveEpisodeDetails(mediaId, [
      { season: 1, episode: 1, title: null, overview: 'One', still: 'https://s/1.png' },
      { season: 1, episode: 2, title: 'Two', overview: 'Two happens', still: null },
      { season: 1, episode: 9, title: 'Not in the library', overview: null, still: null },
    ]);
    expect(n).toBe(2);
    const rows = db.prepare('SELECT episode, title, overview, still FROM episodes WHERE media_id = ? ORDER BY episode').all(mediaId);
    expect(rows).toEqual([
      expect.objectContaining({ episode: 1, title: 'Kept', overview: 'One', still: 'https://s/1.png' }),
      expect.objectContaining({ episode: 2, title: 'Two', overview: 'Two happens', still: null }),
    ]);
  });
});
