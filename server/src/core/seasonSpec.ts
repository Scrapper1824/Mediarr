/**
 * Season detection for release names. Covers the many ways uploaders write seasons:
 *
 *   single     S02 · S2 · Season 2 · Season 02 · 2nd Season · Second Season · Season Two · Series 2 (UK)
 *              Saison 2 · Temporada 2 · Staffel 2 · Stagione 2 · Sezon 2 · Seizoen 2 · Säsong 2 · Sæson 2 · Kausi 2
 *   ranges     S01-S03 · S01 - S03 · S01~S03 · S01 to S03 · S01-03 · S1-3 · Seasons 1-3 · Seasons 1 to 3
 *              Season 1-3 · Season 1 - Season 3 · 1st-3rd Season · Saisons 1 à 3 · Staffel 1 bis 3 · Series 1-3
 *   lists      S01+S02 · S1 & S2 · S01, S02, S03 · S01 S02 S03 · Season 1 & 2 · Seasons 1, 2 and 3
 *              Season 1 + Season 2 · 1st & 2nd Season · Season 1+2+3
 *   whole show Complete Series · The Complete Series · Complete Collection · Complete Seasons · Complete Box Set
 *              Full Series · Entire Series · All Seasons · Whole Series · Box Set · Boxset · Anthology
 *              Integrale / Intégrale · Komplett · Completa · a year span like (2008-2013)
 *
 * "Season 2 - 05" (spaced dash, no second "Season") is an episode of season 2, not a range.
 */

export interface SeasonSpec {
  seasons: number[];
  /** Index in the text where the season marker starts (for cutting the title). */
  index: number;
  /** The matched text, so callers can ignore its digits when looking for episode numbers. */
  text: string;
}

const MAX_SEASON = 60;
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const FOREIGN = '(?:Saisons?|Temporadas?|Staffeln?|Stagioni|Stagione|Sezon|Seizoen|S[äa]song|Sesong|S[æa]son|Kausi)';
// Word separators need spaces around them so single letters ("a", "y", "e") never match inside words.
const RANGE_SEP = '(?:\\s?(?:-|~|–)\\s?|\\s(?:to|thru|through|à|a|bis|al)\\s)';
const LIST_SEP = '(?:\\s?(?:\\+|&|,)\\s?|\\s(?:and|et|und|y|e)\\s)';

export const COMPLETE_SERIES =
  /\b(?:the\s)?(?:complete(?:[\s-](?:series|collection|seasons|box[\s-]?set|edition|show))?|full[\s-]series|entire[\s-]series|all[\s-]seasons|whole[\s-]series|box[\s-]?set|boxset|anthology|int[ée]grale|integral|komplett|completa|completo)\b/i;
export const YEAR_SPAN = /\b(?:19|20)\d{2}\s?[-–~]\s?(?:19|20)\d{2}\b/;

function range(a: number, b: number): number[] {
  if (b < a || b - a > 50) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** Expands "1st & 2nd" / "1-3" / "1, 2 and 3" style sequences of numbers into seasons. */
function expand(text: string): number[] {
  const tokens = [...text.matchAll(/(\d{1,2})|(-|~|–|\bto\b|\bthru\b|\bthrough\b|\bbis\b|à)/gi)];
  const out: number[] = [];
  let pendingRange = false;
  for (const t of tokens) {
    if (t[1]) {
      const n = Number(t[1]);
      if (pendingRange && out.length) out.push(...range(out[out.length - 1] + 1, n).filter((x) => x > out[out.length - 1]));
      else out.push(n);
      pendingRange = false;
    } else pendingRange = true;
  }
  return out;
}

interface Candidate extends SeasonSpec {}

export function findSeasons(text: string): SeasonSpec | null {
  const found: Candidate[] = [];
  const add = (m: RegExpMatchArray | null, seasons: number[]) => {
    if (!m) return;
    const valid = [...new Set(seasons)].filter((n) => n >= 0 && n <= MAX_SEASON).sort((a, b) => a - b);
    if (valid.length) found.push({ seasons: valid, index: m.index!, text: m[0] });
  };
  const all = (re: RegExp) => [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];

  // S-number ranges and lists.
  for (const m of all(/\bS(\d{1,2})\s?(?:-|~|–|to|thru)\s?S(\d{1,2})\b/i)) add(m, range(+m[1], +m[2]));
  for (const m of all(/\bS(\d{1,2})(?:-|~)(\d{1,2})\b/i)) add(m, range(+m[1], +m[2]));
  for (const m of all(/\bS\d{1,2}(?:\s?(?:\+|&|,|and)\s?S\d{1,2})+\b/i)) add(m, [...m[0].matchAll(/\d{1,2}/g)].map((x) => +x[0]));
  for (const m of all(/\bS\d{1,2}(?:\s+S\d{1,2})+\b/i)) add(m, [...m[0].matchAll(/\d{1,2}/g)].map((x) => +x[0]));

  // "Season(s) 1-3", "Seasons 1 to 3", "Season 1 - Season 3" (but not "Season 2 - 05").
  for (const m of all(/\bSeasons?\s?(\d{1,2})\s?(?:-|~|–|to|thru|through)\s?(Seasons?\s?)?(\d{1,2})\b/i)) {
    const spacedDash = /^Season\s?\d{1,2}\s[-–]\s\d/i.test(m[0]);
    if (spacedDash && !m[2]) continue;
    add(m, range(+m[1], +m[3]));
  }
  // "Season 1 & 2", "Seasons 1, 2 and 3", "Season 1 + Season 2", "Season 1+2+3".
  for (const m of all(new RegExp(`\\bSeasons?\\s?\\d{1,2}(?:${LIST_SEP}(?:Seasons?\\s?)?\\d{1,2}\\b)+`, 'i'))) add(m, expand(m[0]));

  // Ordinals: "2nd Season", "1st & 2nd Season", "1st-3rd Season".
  for (const m of all(
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)(?:\\s?Seasons?)?(?:(?:${LIST_SEP}|${RANGE_SEP})\\d{1,2}(?:st|nd|rd|th))*\\s?Seasons?\\b`, 'i'),
  )) add(m, expand(m[0]));

  // Words: "Season Two", "Second Season".
  for (const m of all(/\bSeason\s(one|two|three|four|five|six|seven|eight|nine|ten)\b/i)) add(m, [WORD_NUM[m[1].toLowerCase()]]);
  for (const m of all(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\sSeason\b/i)) add(m, [WORD_NUM[m[1].toLowerCase()]]);

  // Other languages and UK "Series 2".
  for (const m of all(new RegExp(`\\b${FOREIGN}\\s?(\\d{1,2})(?:${RANGE_SEP}(\\d{1,2}))?\\b`, 'i'))) add(m, range(+m[1], m[2] ? +m[2] : +m[1]));
  for (const m of all(new RegExp(`\\b${FOREIGN}\\s?\\d{1,2}(?:${LIST_SEP}\\d{1,2}\\b)+`, 'i'))) add(m, expand(m[0]));
  for (const m of all(/\bSeries\s?(\d{1,2})(?:\s?(?:-|to)\s?(\d{1,2}))?\b/i)) add(m, range(+m[1], m[2] ? +m[2] : +m[1]));

  // Singles.
  for (const m of all(/\bS(\d{1,2})\b/i)) add(m, [+m[1]]);
  for (const m of all(/\bSeason\s?(\d{1,2})\b/i)) add(m, [+m[1]]);

  if (!found.length) return null;
  // The widest description wins ("S01-S03" over the "S01" inside it); ties go to the earliest.
  found.sort((a, b) => b.seasons.length - a.seasons.length || a.index - b.index);
  const best = found[0];
  return { ...best, index: Math.min(best.index, ...found.filter((f) => f.seasons.every((s) => best.seasons.includes(s))).map((f) => f.index)) };
}
