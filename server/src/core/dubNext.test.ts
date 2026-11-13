import { describe, expect, it } from 'vitest';
import type { AiringInfo } from '../clients/anilist.js';
import { parseDubNext, type DubSchedule } from '../clients/animeschedule.js';
import { availability } from './availability.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const airing = (over: Partial<AiringInfo>): AiringInfo => ({ format: 'TV', status: 'RELEASING', episodes: null, next: null, upcoming: [], startDate: '1999-10-20', ...over });
const dub = (over: Partial<DubSchedule>): DubSchedule => ({
  dubExists: true,
  subExists: true,
  premier: '1999-10-20T00:00:00Z',
  dubPremier: '2020-11-24T00:00:00Z',
  dubDelayedFrom: null,
  dubDelayedUntil: null,
  dubBatches: [],
  episodes: null,
  status: 'Ongoing',
  dubNext: null,
  url: 'https://animeschedule.net/anime/one-piece',
  ...over,
});

// As on AnimeSchedule's One Piece page.
const PAGE = [
  '<h3 class="release-time-type-text release-time-type-dub" title="The earliest official English dubbed version of a release.">',
  '<span class="release-time-episode-number">Episode 1160</span> Dub: </h3>',
  '</div>',
  '<time id="release-time-dub" class="release-time" datetime="2026-11-17T12:00-05:00">Tuesday 17 Nov, 12:00 PM</time>',
].join('\n');

describe('long runners: the next dubbed episode from AnimeSchedule', () => {
  it('reads it from the page', () => {
    expect(parseDubNext(PAGE)).toEqual({ episode: 1160, at: '2026-11-17T17:00:00.000Z' });
    expect(parseDubNext('<html>no dub here</html>')).toBeNull();
  });

  it('counts One Piece from it instead of "unknown"', () => {
    const r = availability(airing({ next: { episode: 1181, at: '2027-01-03T01:00:00Z' } }), dub({ dubNext: parseDubNext(PAGE) }), NOW);
    expect(r.dub).toMatchObject({ exists: true, out: 1159, complete: false, next: { episode: 1160, at: '2026-11-17T17:00:00.000Z' }, estimated: false });
  });

  it('counts an episode once its date has passed', () => {
    const r = availability(airing({}), dub({ dubNext: { episode: 1160, at: '2026-11-10T17:00:00Z' } }), NOW);
    expect(r.dub).toMatchObject({ out: 1160, next: null });
  });

  it('dates the last dubbed episode when the length is known', () => {
    const r = availability(airing({ episodes: 12, next: { episode: 9, at: '2026-11-14T15:00:00Z' } }), dub({ dubPremier: '2026-10-20T00:00:00Z', dubNext: { episode: 5, at: '2026-11-17T17:00:00Z' } }), NOW);
    expect(r.dub).toMatchObject({ out: 4, next: { episode: 5 }, allOutBy: '2027-01-05T17:00:00.000Z' });
  });

  it('still estimates when the page lists nothing', () => {
    const r = availability(airing({}), dub({}), NOW);
    expect(r.dub).toMatchObject({ out: null, estimated: true, next: null });
  });
});
