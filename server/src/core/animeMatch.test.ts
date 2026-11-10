import { describe, expect, it } from 'vitest';
import type { ProwlarrRelease } from '../clients/prowlarr.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { matchAnime, type AnimeSeason } from './animeMatch.js';
import { parseRelease } from './releaseParser.js';
import { scoreRelease, type ScoreContext } from './scoring.js';

// That Time I Got Reincarnated as a Slime, with split cours merged.
const SLIME: AnimeSeason[] = [
  { season: 1, anilistIds: [1], title: 'Slime', titles: ['That Time I Got Reincarnated as a Slime', 'Tensei Shitara Slime Datta Ken'], episodes: 24, offset: 0, year: 2018 },
  { season: 2, anilistIds: [2, 3], title: 'Slime S2', titles: ['Tensei Shitara Slime Datta Ken 2nd Season'], episodes: 24, offset: 24, year: 2021 },
  { season: 3, anilistIds: [4], title: 'Slime S3', titles: ['Tensei Shitara Slime Datta Ken 3rd Season'], episodes: 24, offset: 48, year: 2024 },
  { season: 4, anilistIds: [5], title: 'Slime S4', titles: ['Tensei Shitara Slime Datta Ken 4th Season'], episodes: 24, offset: 72, year: 2026 },
];
const IRONCLAD =
  '[Ironclad] Tensei Shitara Slime Datta Ken - S04 [WEB.1080p.AV1] | That Time I Got Reincarnated as a Slime (Multi-Audio, Multi-Subs)';

const m = (title: string, fallback: number | null = null) => matchAnime(parseRelease(title), SLIME, fallback);

describe('matchAnime', () => {
  it('reads explicit seasons from release names', () => {
    expect(m(IRONCLAD)).toEqual({ seasons: [4], episodes: null });
    expect(m('[SubsPlease] Tensei Shitara Slime Datta Ken S3 - 05 (1080p)')?.episodes).toEqual([{ season: 3, episode: 5 }]);
    expect(m('[Group] Tensei Shitara Slime Datta Ken 2nd Season - 07 [1080p]')?.episodes).toEqual([{ season: 2, episode: 7 }]);
    expect(m('Tensei.Shitara.Slime.Datta.Ken.S02E03.1080p.WEB')?.episodes).toEqual([{ season: 2, episode: 3 }]);
  });

  it('defaults bare episode numbers to season 1, and maps absolute numbers', () => {
    expect(m('[SubsPlease] Tensei Shitara Slime Datta Ken - 05 (1080p)')?.episodes).toEqual([{ season: 1, episode: 5 }]);
    expect(m('[Group] Tensei Shitara Slime Datta Ken - 50 (1080p)')?.episodes).toEqual([{ season: 3, episode: 2 }]);
    expect(m('[Group] Tensei Shitara Slime Datta Ken - 500')).toBeNull();
  });

  it('uses the containing batch season for files without one', () => {
    expect(m('Tensei Shitara Slime Datta Ken - 05.mkv', 4)?.episodes).toEqual([{ season: 4, episode: 5 }]);
  });

  it('treats unmarked batches as season 1 and complete packs as everything', () => {
    expect(m('[Judas] Tensei Shitara Slime Datta Ken [BD 1080p]')).toEqual({ seasons: [1], episodes: null });
    expect(m('Tensei Shitara Slime Datta Ken Complete 1080p')?.seasons).toEqual([1, 2, 3, 4]);
  });
});

describe('anime season scoring', () => {
  const rel = (title: string): ProwlarrRelease => ({
    guid: title, title, size: 1024 ** 3, seeders: 50, leechers: 0, indexer: 'x', indexerId: 1, protocol: 'torrent',
  });
  const ctx = (season: number): ScoreContext => ({
    type: 'anime',
    titles: SLIME.flatMap((s) => s.titles),
    year: 2018,
    animeAudio: 'dub',
    scope: { kind: 'season', season, episodes: Array.from({ length: 24 }, (_, i) => i + 1) },
    settings: { ...DEFAULT_SETTINGS, maxEpisodeSizeGb: 100 },
    animeSeasons: SLIME,
  });

  it('rejects franchise movies and bare OVAs for a season search', () => {
    const movie =
      '[neoDESU] That Time I Got Reincarnated as a Slime the Movie - Tears of the Azure Sea [BD 1080p AV1 OPUS AAC] [Dual Audio] Tensei shitara Slime Datta Ken Movie 2: Soukai no Namida-hen';
    expect(scoreRelease(rel(movie), ctx(1)).rejections).toContain('Movie, not a series release');
    expect(scoreRelease(rel('[Group] Tensei Shitara Slime Datta Ken OVA [BD 1080p][Dual Audio]'), ctx(1)).rejections).toContain(
      'OVA/special, not a series release',
    );
    // A season pack that bundles the OVA is still a season pack.
    expect(scoreRelease(rel('[Judas] Tensei Shitara Slime Datta Ken (Season 1 + OVA) [BD 1080p][Dual-Audio]'), ctx(1)).rejections).toEqual([]);
  });

  it('rejects a season 4 batch when season 1 was requested', () => {
    expect(scoreRelease(rel(IRONCLAD), ctx(1)).rejections).toContain('Wrong season (S4)');
    expect(scoreRelease(rel(IRONCLAD), ctx(4)).rejections).toEqual([]);
  });
});
