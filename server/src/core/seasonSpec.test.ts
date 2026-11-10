import { describe, expect, it } from 'vitest';
import { parseRelease } from './releaseParser.js';

const seasonsOf = (t: string) => {
  const p = parseRelease(t);
  return p.isComplete ? 'complete' : p.seasons;
};

describe('season naming styles', () => {
  it.each([
    // Single seasons
    ['Breaking.Bad.S03.1080p.BluRay.x264-ROVERS', [3]],
    ['Breaking Bad S3 1080p WEB', [3]],
    ['Breaking Bad Season 3 Complete 1080p', [3]],
    ['Breaking Bad - Season 03 [1080p]', [3]],
    ['Tensei Shitara Slime Datta Ken 2nd Season [BD 1080p]', [2]],
    ['Attack on Titan Second Season 1080p', [2]],
    ['Attack on Titan Season Two 1080p', [2]],
    ['Doctor Who Series 2 1080p BluRay', [2]],
    ['Dark Staffel 2 German 1080p', [2]],
    ['Lupin Saison 2 FRENCH 1080p', [2]],
    ['La Casa de Papel Temporada 3 1080p', [3]],
    ['Gomorra Stagione 4 1080p', [4]],

    // Ranges
    ['Breaking.Bad.S01-S05.1080p.BluRay', [1, 2, 3, 4, 5]],
    ['Breaking Bad S01 - S05 1080p', [1, 2, 3, 4, 5]],
    ['Breaking Bad S01~S03 1080p', [1, 2, 3]],
    ['Breaking Bad S01-03 1080p', [1, 2, 3]],
    ['Breaking Bad S1-3 720p', [1, 2, 3]],
    ['Breaking Bad Seasons 1-5 1080p', [1, 2, 3, 4, 5]],
    ['Breaking Bad Seasons 1 to 3 1080p', [1, 2, 3]],
    ['Breaking Bad Season 1-3 1080p', [1, 2, 3]],
    ['Breaking Bad Season 1 - Season 3 1080p', [1, 2, 3]],
    ['Tensei Shitara Slime Datta Ken 1st-3rd Season [BD]', [1, 2, 3]],
    ['Dark Staffel 1 bis 3 German', [1, 2, 3]],
    ['Lupin Saisons 1 à 3 FRENCH', [1, 2, 3]],
    ['Doctor Who Series 1-4 BluRay', [1, 2, 3, 4]],
    ['Show.S01E01-S03E10.1080p.WEB', [1, 2, 3]],

    // Lists
    ['Breaking Bad S01+S02 1080p', [1, 2]],
    ['Breaking Bad S1 & S2 1080p', [1, 2]],
    ['Breaking Bad S01, S02, S03 1080p', [1, 2, 3]],
    ['Breaking.Bad.S01.S02.S03.1080p', [1, 2, 3]],
    ['Breaking Bad Season 1 & 2 1080p', [1, 2]],
    ['Breaking Bad Seasons 1, 2 and 3 1080p', [1, 2, 3]],
    ['Breaking Bad Season 1 + Season 2 1080p', [1, 2]],
    ['Breaking Bad Season 1+2+3 1080p', [1, 2, 3]],
    ['[Judas] Tensei Shitara Slime Datta Ken 1st & 2nd Season [BD 1080p][Dual-Audio]', [1, 2]],

    // Whole series
    ['Breaking Bad Complete Series 1080p BluRay', 'complete'],
    ['Breaking.Bad.The.Complete.Series.1080p', 'complete'],
    ['Breaking Bad - Complete Collection [1080p]', 'complete'],
    ['Breaking Bad Complete Box Set 720p', 'complete'],
    ['Breaking Bad Boxset 1080p', 'complete'],
    ['Breaking Bad All Seasons 1080p', 'complete'],
    ['Breaking Bad Full Series 1080p', 'complete'],
    ['Kaamelott Intégrale FRENCH 1080p', 'complete'],
    ['Breaking Bad (2008-2013) 1080p BluRay', 'complete'],
    ['[Erai-raws] Cowboy Bebop - Complete [1080p]', 'complete'],
  ])('%s', (title, expected) => {
    expect(seasonsOf(title)).toEqual(expected);
  });

  it('keeps anime "Season N - EP" as a single episode, not a range', () => {
    expect(parseRelease('[Group] Show Season 2 - 05 [1080p]')).toMatchObject({ season: 2, episodes: [5], isSeasonPack: false });
    expect(parseRelease('[SubsPlease] Show S2 - 05 (1080p)')).toMatchObject({ season: 2, episodes: [5], isSeasonPack: false });
  });

  it('does not read season markers as episode numbers', () => {
    expect(parseRelease('Breaking Bad Seasons 1-5 1080p').absoluteEpisodes).toEqual([]);
    expect(parseRelease('Show Season 1 + Season 2 1080p').absoluteEpisodes).toEqual([]);
  });

  it('cuts the title before the season marker', () => {
    expect(parseRelease('Breaking.Bad.S01-S05.1080p.BluRay').title).toBe('Breaking Bad');
    expect(parseRelease('Breaking Bad Complete Series 1080p').title).toBe('Breaking Bad');
    expect(parseRelease('[Judas] Tensei Shitara Slime Datta Ken 1st & 2nd Season [BD]').title).toBe('Tensei Shitara Slime Datta Ken');
  });

  it('handles episode ranges inside one season', () => {
    expect(parseRelease('Show.S01E01-S01E12.1080p')).toMatchObject({ season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
  });

  it('does not treat movie collections as a series', () => {
    expect(parseRelease('Some Saga Movie Collection 1080p').isComplete).toBe(false);
  });
});
