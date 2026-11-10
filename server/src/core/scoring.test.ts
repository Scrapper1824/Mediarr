import { describe, expect, it } from 'vitest';
import type { ProwlarrRelease } from '../clients/prowlarr.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { matchAnime, type AnimeSeason } from './animeMatch.js';
import { parseRelease } from './releaseParser.js';
import { rankReleases, scoreRelease, type ScoreContext } from './scoring.js';

const rel = (title: string, extra: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title,
  title,
  size: 1024 ** 3,
  seeders: 50,
  leechers: 0,
  indexer: 'test',
  indexerId: 1,
  protocol: 'torrent',
  ...extra,
});

const anime = (audio: 'sub' | 'dub'): ScoreContext => ({
  type: 'anime',
  titles: ['Dandadan'],
  year: 2024,
  animeAudio: audio,
  scope: { kind: 'episode', season: 1, episode: 3 },
  settings: DEFAULT_SETTINGS,
  animeSeasons: [{ season: 1, anilistIds: [1], title: 'Dandadan', titles: ['Dandadan'], episodes: 12, offset: 0, year: 2024 }],
});

describe('sequels', () => {
  it('does not grab the first show for a standalone sequel', () => {
    // AniList has Edgerunners 2 as its own one-season series, so "S01" alone would fit it.
    const titles = ['Cyberpunk: Edgerunners 2', 'Cyberpunk: Edgerunners II'];
    const ctx: ScoreContext = {
      type: 'anime',
      titles,
      year: 2026,
      animeAudio: 'dub',
      scope: { kind: 'season', season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      settings: DEFAULT_SETTINGS,
      animeSeasons: [{ season: 1, anilistIds: [195539], title: titles[0], titles, episodes: 10, offset: 0, year: 2026 }],
    };
    const first = scoreRelease(rel('[GetItTwisted] Cyberpunk: Edgerunners S01 v2 [BD 1080p HEVC Opus Dual-Audio]'), ctx);
    expect(first.rejections).toContain('Title mismatch ("Cyberpunk: Edgerunners")');
    const animeTime = scoreRelease(rel('[Anime Time] Cyberpunk S01 - Edgerunners [NF][Dual Audio] [1080p][HEVC 10bit x265][Multi Sub] [Batch]'), ctx);
    expect(animeTime.rejections.some((r) => r.startsWith('Title mismatch'))).toBe(true);
    expect(scoreRelease(rel('[Group] Cyberpunk Edgerunners 2 S01 [1080p][Dual Audio]'), ctx).rejections).toEqual([]);
  });

  const two = ['Cyberpunk: Edgerunners 2', 'Cyberpunk: Edgerunners II'];
  const sequelSeasons: AnimeSeason[] = [{ season: 1, anilistIds: [195539], title: two[0], titles: two, episodes: 10, offset: 0, year: 2026 }];
  const firstSeasons: AnimeSeason[] = [
    { season: 1, anilistIds: [120377], title: 'Cyberpunk: Edgerunners', titles: ['Cyberpunk: Edgerunners'], episodes: 10, offset: 0, year: 2022 },
  ];
  const ctxFor = (seasons: AnimeSeason[], scope: ScoreContext['scope']): ScoreContext => ({
    type: 'anime',
    titles: seasons[0].titles,
    year: seasons[0].year,
    animeAudio: 'sub',
    scope,
    settings: DEFAULT_SETTINGS,
    animeSeasons: seasons,
  });
  const wholeSeason = { kind: 'season' as const, season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
  const ok = (title: string, ctx: ScoreContext) => scoreRelease(rel(title), ctx).rejections;

  it('finds a standalone sequel released as season 2 of the original', () => {
    const ctx = ctxFor(sequelSeasons, wholeSeason);
    expect(ok('[WOR] Cyberpunk Edgerunners S02 [WebEncode HEVC 1080p HDR10+ DV EAC3] (Multi Audio Multi-Subs)', ctx)).toEqual([]);
    expect(ok('[Judas] Cyberpunk Edgerunners (S2) [1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs] (Batch)', ctx)).toEqual([]);
    expect(ok('[VoidWalkers] Cyberpunk Edgerunners Season 2 S01 (2026) [WEBRip][1080p Multi Opus AV1][Multi-subs]', ctx)).toEqual([]);
  });

  it('finds single episodes of a standalone sequel, however they are named', () => {
    const ep = (n: number) => ctxFor(sequelSeasons, { kind: 'episode', season: 1, episode: n });
    expect(ok('[喵萌奶茶屋&LoliHouse] 赛博浪客 / 赛博朋克：边缘行者 / Cyberpunk Edgerunners 2 - 06 [WebRip 1080p HEVC-10bit AAC]', ep(6))).toEqual([]);
    expect(ok('【喵萌奶茶屋】★10月新番★[赛博浪客 / 電馭叛客：邊緣行者 / Cyberpunk Edgerunners 2][08][1080p][繁日雙語]', ep(8))).toEqual([]);
    expect(ok('[SubsPlease] Cyberpunk Edgerunners S02E03 (1080p)', ep(3))).toEqual([]);
  });

  it('keeps the original and its sequel apart', () => {
    // The original show must not take the sequel's releases...
    const first = ctxFor(firstSeasons, wholeSeason);
    expect(ok('[WOR] Cyberpunk Edgerunners S02 [WebEncode HEVC 1080p]', first)).not.toEqual([]);
    expect(ok('[Group] Cyberpunk Edgerunners 2 - 06 [1080p]', ctxFor(firstSeasons, { kind: 'episode', season: 1, episode: 6 }))).not.toEqual([]);
    // ...and the sequel must not take the original's.
    const sequel = ctxFor(sequelSeasons, wholeSeason);
    expect(ok('[Anime Time] Cyberpunk S01 - Edgerunners [NF][Dual Audio] [1080p][HEVC 10bit x265][Multi Sub] [Batch]', sequel)).not.toEqual([]);
    expect(ok('[GetItTwisted] Cyberpunk: Edgerunners S01 v2 [BD 1080p HEVC Opus Dual-Audio]', sequel)).not.toEqual([]);
  });

  it('matches episode files of an "S02" pack to the sequel\'s own episodes', () => {
    expect(matchAnime(parseRelease('Cyberpunk Edgerunners S02E04 1080p.mkv'), sequelSeasons)).toEqual({ seasons: [1], episodes: [{ season: 1, episode: 4 }] });
  });
});

describe('scoring', () => {
  it('only accepts dub/dual for dub preference', () => {
    expect(scoreRelease(rel('[SubsPlease] Dandadan - 03 (1080p)'), anime('dub')).rejections).toContain('Not dubbed');
    expect(scoreRelease(rel('[Group] Dandadan - 03 [Dual Audio][1080p]'), anime('dub')).rejections).toEqual([]);
    expect(scoreRelease(rel('[Group] Dandadan - 03 (English Dub) [1080p]'), anime('dub')).rejections).toEqual([]);
  });

  it('rejects dub-only and prefers pure sub for sub preference', () => {
    expect(scoreRelease(rel('[Group] Dandadan - 03 (English Dub) [1080p]'), anime('sub')).rejections).toContain('Dub only');
    const ranked = rankReleases(
      [rel('[Group] Dandadan - 03 [Dual Audio][1080p]'), rel('[SubsPlease] Dandadan - 03 (1080p)')],
      anime('sub'),
    );
    expect(ranked[0].title).toContain('SubsPlease');
  });

  it('rejects wrong episodes, low seeders, oversize, and 4K', () => {
    expect(scoreRelease(rel('[SubsPlease] Dandadan - 04 (1080p)'), anime('sub')).rejections).toContain('Wrong episode');
    expect(scoreRelease(rel('[SubsPlease] Dandadan - 03 (1080p)', { seeders: 0 }), anime('sub')).rejections[0]).toMatch(/seeders/);
    expect(scoreRelease(rel('[SubsPlease] Dandadan - 03 (1080p)', { size: 10 * 1024 ** 3 }), anime('sub')).rejections[0]).toMatch(/Too big/);
    expect(scoreRelease(rel('[SubsPlease] Dandadan - 03 (2160p)'), anime('sub')).rejections).toContain('4K not allowed');
  });

  it('prefers the configured resolution for movies and rejects TV releases', () => {
    const ctx: ScoreContext = {
      type: 'movie',
      titles: ['Dune'],
      year: 2021,
      animeAudio: null,
      scope: { kind: 'movie' },
      settings: DEFAULT_SETTINGS,
    };
    const ranked = rankReleases([rel('Dune.2021.720p.WEB-DL'), rel('Dune.2021.1080p.WEB-DL'), rel('Dune.S01E01.1080p')], ctx);
    expect(ranked[0].title).toBe('Dune.2021.1080p.WEB-DL');
    expect(ranked[2].rejections).toContain('Looks like a TV release');
  });

  it('season scope requires a pack', () => {
    const ctx: ScoreContext = {
      type: 'show',
      titles: ['Severance'],
      year: 2022,
      animeAudio: null,
      scope: { kind: 'season', season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      settings: DEFAULT_SETTINGS,
    };
    expect(scoreRelease(rel('Severance.S01.1080p.WEB-DL'), ctx).rejections).toEqual([]);
    expect(scoreRelease(rel('Severance.S01E01.1080p.WEB-DL'), ctx).rejections).toContain('Not a season pack');
  });
});

describe('reasonKey', async () => {
  const { reasonKey } = await import('./grabber.js');
  it('groups rejection reasons', () => {
    expect(reasonKey('Too big (12.3 GB)')).toBe('Too big');
    expect(reasonKey('Only 0 seeders')).toBe('Not enough seeders');
    expect(reasonKey('Wrong season (S4)')).toBe('Wrong season');
    expect(reasonKey('Title mismatch ("Other Show")')).toBe('Title mismatch');
    expect(reasonKey('Not dubbed')).toBe('Not dubbed');
  });
});
