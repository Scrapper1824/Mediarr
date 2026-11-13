import { describe, expect, it } from 'vitest';
import { categoriesFor, type ProwlarrRelease } from '../clients/prowlarr.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { namedAfterOnly, rankReleases } from './scoring.js';

describe('searching for 18+ titles', () => {
  it('also searches the XXX and Other categories, only for titles marked 18+', () => {
    expect(categoriesFor({ type: 'anime', adult: 0 })).toEqual([5070, 5000]);
    expect(categoriesFor({ type: 'anime', adult: 1 })).toEqual([5070, 5000, 6000, 8000]);
    expect(categoriesFor({ type: 'movie', adult: 1 })).toEqual([2000, 6000, 8000]);
  });
});

describe('releases that only name the title in brackets', () => {
  const titles = ['Ane wa Yanmama Junyuu-chuu', 'Gishi wa Yanmama Junyuu-chuu'];

  it('are something else named after it', () => {
    expect(namedAfterOnly('[VAMA] Aika Sano (Ane wa Yanmama Junyuu-chuu)', titles)).toBe('Aika Sano');
    expect(namedAfterOnly('[261025][VAMA] Aika Sano (Ane wa Yanmama Junyuu chuu)', titles)).toBe('Aika Sano');
  });

  it('but the title itself, or two of its own names, still count', () => {
    expect(namedAfterOnly('Ane wa Yanmama Junyuu chuu', titles)).toBeNull();
    expect(namedAfterOnly('[hshare. net] Ane wa Yanmama Junyuu chuu', titles)).toBeNull();
    expect(namedAfterOnly('Ane wa Yanmama Junyuu chuu (2020)', titles)).toBeNull();
    expect(namedAfterOnly('Shingeki no Kyojin (Attack on Titan) S01 1080p', ['Attack on Titan', 'Shingeki no Kyojin'])).toBeNull();
    expect(namedAfterOnly('[SubsPlease] Frieren (Sousou no Frieren) - 01 (1080p)', ['Frieren: Beyond Journey’s End', 'Sousou no Frieren'])).toBeNull();
  });

  it('are rejected when ranking, with the reason shown', () => {
    const release = (title: string, seeders: number): ProwlarrRelease =>
      ({ guid: title, title, indexer: 'x', size: 1e9, seeders, leechers: 0, protocol: 'torrent', downloadUrl: 'http://x/' + title }) as unknown as ProwlarrRelease;
    const ranked = rankReleases([release('[VAMA] Aika Sano (Ane wa Yanmama Junyuu-chuu)', 88), release('Ane wa Yanmama Junyuu chuu', 29)], {
      type: 'anime',
      titles,
      year: 2020,
      animeAudio: 'sub',
      scope: { kind: 'season', season: 1, episodes: [1, 2] },
      settings: { ...DEFAULT_SETTINGS },
      animeSeasons: [{ season: 1, anilistIds: [115138], title: titles[0], titles, episodes: 2, offset: 0, year: 2020 }],
    });
    const vama = ranked.find((r) => r.title.includes('VAMA'))!;
    expect(vama.rejections.length).toBeGreaterThan(0);
    expect(vama.rejections.join(' ')).toMatch(/Aika Sano/);
    expect(ranked.find((r) => r.title === 'Ane wa Yanmama Junyuu chuu')!.rejections).toEqual([]);
  });
});
