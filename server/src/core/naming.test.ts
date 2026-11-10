import { describe, expect, it } from 'vitest';
import { episodeFileName, folderName, sanitize } from './naming.js';

describe('naming', () => {
  it('sanitizes Windows-illegal characters', () => {
    expect(sanitize('Mission: Impossible')).toBe('Mission - Impossible');
    expect(sanitize('What If...?')).toBe('What If');
    expect(sanitize('A/B "C" <D>|E*')).toBe('AB C DE');
    expect(sanitize('CON')).toBe('CON_');
  });

  it('builds folder and file names', () => {
    expect(folderName('movie', 'Dune: Part Two', 2024)).toBe('Dune - Part Two (2024)');
    expect(folderName('anime', 'Frieren', 2023)).toBe('Frieren');
    expect(episodeFileName('Severance (2022)', 1, [5], 'The Grim Barbarity of Optics and Design', '.mkv')).toBe(
      'Severance (2022) - S01E05 - The Grim Barbarity of Optics and Design.mkv',
    );
    expect(episodeFileName('Show', 2, [1, 2], 'Ignored', '.mkv')).toBe('Show - S02E01-E02.mkv');
  });
});
