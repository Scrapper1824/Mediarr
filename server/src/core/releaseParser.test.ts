import { describe, expect, it } from 'vitest';
import { parseRelease, titleMatches } from './releaseParser.js';

describe('parseRelease', () => {
  it('parses a scene movie', () => {
    const p = parseRelease('The.Matrix.1999.1080p.BluRay.x264-GROUP');
    expect(p).toMatchObject({ title: 'The Matrix', year: 1999, resolution: '1080p', source: 'bluray', group: 'GROUP' });
    expect(p.episodes).toEqual([]);
    expect(p.isCam).toBe(false);
  });

  it('keeps numbers that are part of a movie title', () => {
    expect(parseRelease('Blade.Runner.2049.2017.2160p.UHD.BluRay').title).toBe('Blade Runner 2049');
    expect(parseRelease('1917.2019.1080p.WEB-DL').title).toBe('1917');
  });

  it('detects CAM releases', () => {
    expect(parseRelease('Some.Movie.2024.HDCAM.x264').isCam).toBe(true);
    expect(parseRelease('Some.Movie.2024.1080p.WEB-DL').isCam).toBe(false);
  });

  it('parses SxxEyy and multi-episode', () => {
    expect(parseRelease('Breaking.Bad.S02E05.720p.HDTV.x264-CTU')).toMatchObject({
      title: 'Breaking Bad',
      season: 2,
      episodes: [5],
      resolution: '720p',
    });
    expect(parseRelease('Show.Name.S01E01-E03.1080p.WEB').episodes).toEqual([1, 2, 3]);
    expect(parseRelease('Show Name S01E01E02 1080p').episodes).toEqual([1, 2]);
  });

  it('parses season packs', () => {
    const p = parseRelease('The.Office.US.S03.1080p.BluRay.x265-RARBG');
    expect(p).toMatchObject({ title: 'The Office US', isSeasonPack: true, season: 3, seasons: [3], episodes: [] });
    expect(parseRelease('Dark Season 1-3 Complete 1080p').seasons).toEqual([1, 2, 3]);
  });

  it('parses anime single episodes', () => {
    const p = parseRelease('[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv');
    expect(p).toMatchObject({
      title: 'Sousou no Frieren',
      group: 'SubsPlease',
      absoluteEpisodes: [5],
      resolution: '1080p',
      audio: 'sub',
      isBatch: false,
    });
    expect(parseRelease('[Erai-raws] One Piece - 1100 [1080p][Multiple Subtitle]').absoluteEpisodes).toEqual([1100]);
  });

  it('parses anime batches', () => {
    const range = parseRelease('[Judas] Jujutsu Kaisen (Season 1) [01-24] [1080p][HEVC x265 10bit][Dual-Audio]');
    expect(range.isBatch).toBe(true);
    expect(range.audio).toBe('dual');
    const r2 = parseRelease('[Anime Time] Frieren 01-28 [Dual Audio][1080p]');
    expect(r2.absoluteEpisodes).toHaveLength(28);
    expect(r2.title).toBe('Frieren');
    expect(parseRelease('[Group] Cowboy Bebop [BD 1080p]').isBatch).toBe(true);
  });

  it('detects sub vs dub', () => {
    expect(parseRelease('[SubsPlease] Dandadan - 03 (1080p)').audio).toBe('sub');
    expect(parseRelease('Dandadan S01E03 1080p WEB H264 Dual Audio').audio).toBe('dual');
    expect(parseRelease('[Group] Dandadan - 03 (English Dub) [1080p]').audio).toBe('dub');
    expect(parseRelease('Dandadan.S01E03.DUBBED.1080p.WEB').audio).toBe('dub');
    expect(parseRelease('[Group] Dandadan - 03 [Multi-Audio][1080p]').audio).toBe('dual');
  });
});

describe('titleMatches', () => {
  it('matches loosely', () => {
    expect(titleMatches('The Office US', ['The Office'])).toBe(true);
    expect(titleMatches('Sousou no Frieren', ['Frieren: Beyond Journey’s End', 'Sousou no Frieren'])).toBe(true);
    expect(titleMatches('Frieren', ['Sousou no Frieren'])).toBe(true);
    expect(titleMatches('Breaking Bad', ['Better Call Saul'])).toBe(false);
    expect(titleMatches('', ['Anything'])).toBe(false);
  });

  it('treats a sequel number as a different title', () => {
    const two = ['Cyberpunk: Edgerunners 2', 'Cyberpunk: Edgerunners II'];
    expect(titleMatches('Cyberpunk: Edgerunners', two, 1)).toBe(false);
    expect(titleMatches('Cyberpunk', two, 1)).toBe(false); // "[Anime Time] Cyberpunk S01 - Edgerunners"
    expect(titleMatches('Edgerunners 2', two, 1)).toBe(true);
    expect(titleMatches('Kaiju No 8', ['Kaiju No. 8'], 1)).toBe(true);
    expect(titleMatches('Cyberpunk Edgerunners 2', two, 1)).toBe(true);
    expect(titleMatches('Cyberpunk Edgerunners II', two, 1)).toBe(true);
    // The other way round: the first show must not take the sequel's releases.
    expect(titleMatches('Cyberpunk Edgerunners 2', ['Cyberpunk: Edgerunners'], 1)).toBe(false);
    expect(titleMatches('Toy Story 2', ['Toy Story'], 1)).toBe(false);
    expect(titleMatches('Dune Part Two', ['Dune'], 1)).toBe(false);
    // ...but a numbered name for one of the series' own seasons is fine.
    expect(titleMatches('Mob Psycho 100 II', ['Mob Psycho 100'], 3)).toBe(true);
    expect(titleMatches('Stranger Things 4', ['Stranger Things'], 4)).toBe(true);
    // Numbers that are part of the name aren't sequels.
    expect(titleMatches('Blade Runner', ['Blade Runner 2049'], 1)).toBe(true);
    expect(titleMatches('Mob Psycho', ['Mob Psycho 100'], 3)).toBe(true);
  });
});
