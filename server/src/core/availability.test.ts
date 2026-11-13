import { describe, expect, it } from 'vitest';
import type { AiringInfo } from '../clients/anilist.js';
import { parseDubSchedule, type DubSchedule } from '../clients/animeschedule.js';
import { availability } from './availability.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const day = (s: string) => new Date(`${s}T15:00:00Z`).toISOString();
const airing = (over: Partial<AiringInfo>): AiringInfo => ({ format: 'TV', status: 'RELEASING', episodes: 12, next: null, upcoming: [], startDate: '2026-10-02', ...over });
const dub = (over: Partial<DubSchedule>): DubSchedule => ({
  dubExists: true,
  subExists: true,
  premier: '2026-10-02T00:00:00Z',
  dubPremier: null,
  dubDelayedFrom: null,
  dubDelayedUntil: null,
  dubBatches: [],
  episodes: 12,
  status: 'Ongoing',
  dubNext: null,
  url: 'https://animeschedule.net/anime/x',
  ...over,
});

describe('what is out, subbed and dubbed', () => {
  it('counts subs from the airing schedule and dates the last episode', () => {
    const a = airing({
      next: { episode: 7, at: day('2026-11-13') },
      upcoming: [7, 8, 9, 10, 11, 12].map((e, i) => ({ episode: e, at: new Date(Date.parse(day('2026-11-13')) + i * 7 * 86400_000).toISOString() })),
    });
    const r = availability(a, null, NOW);
    expect(r.sub).toMatchObject({ out: 6, complete: false, next: { episode: 7 }, allOutBy: day('2026-12-18') });
    expect(r.dub).toBeNull();
  });

  it('estimates a weekly simuldub from its premiere, never ahead of the subs', () => {
    // Dub started 2026-10-16 (Fridays): 4 episodes by 2026-11-10; the subs are at 6.
    const r = availability(airing({ next: { episode: 7, at: day('2026-11-13') } }), dub({ dubPremier: '2026-10-16T00:00:00Z' }), NOW);
    expect(r.dub).toMatchObject({ exists: true, out: 4, complete: false, estimated: true });
    // 12 episodes, weekly from 16 Oct: the last on 1 Jan.
    expect(r.dub!.allOutBy!.slice(0, 10)).toBe('2027-01-01');
    // A dub that started long ago is capped by the subs.
    const early = availability(airing({ next: { episode: 3, at: day('2026-11-13') } }), dub({ dubPremier: '2026-08-01T00:00:00Z' }), NOW);
    expect(early.dub!.out).toBe(2);
  });

  it('knows when a dub has not started, has none, or is all out', () => {
    const coming = availability(airing({ next: { episode: 7, at: day('2026-11-13') } }), dub({ dubPremier: '2026-11-20T00:00:00Z' }), NOW);
    expect(coming.dub).toMatchObject({ out: 0, startsAt: '2026-11-20T00:00:00Z' });
    expect(coming.dub!.allOutBy!.slice(0, 10)).toBe('2027-02-05');

    expect(availability(airing({}), dub({ dubExists: false }), NOW).dub).toMatchObject({ exists: false });

    // Finished show, dub with no date (released together, e.g. on Netflix): all of it.
    const netflix = availability(airing({ status: 'FINISHED', episodes: 10 }), dub({ episodes: 10 }), NOW);
    expect(netflix.sub).toMatchObject({ out: 10, complete: true });
    expect(netflix.dub).toMatchObject({ out: 10, complete: true, estimated: false });
  });

  it('accounts for breaks and batch releases', () => {
    // Two-week break that ended: two fewer episodes, and the end moves two weeks.
    const r = availability(
      airing({ status: 'FINISHED' }),
      dub({ dubPremier: '2026-09-04T00:00:00Z', dubDelayedFrom: '2026-10-02T00:00:00Z', dubDelayedUntil: '2026-10-16T00:00:00Z' }),
      NOW,
    );
    // Weekly since 4 Sep: 10 episodes by 10 Nov, minus the 2-week break = 8.
    expect(r.dub).toMatchObject({ out: 8, paused: null });
    expect(r.dub!.allOutBy!.slice(0, 10)).toBe('2026-12-04');
    // A break with no end date: paused, no finish estimate.
    const paused = availability(airing({ status: 'FINISHED' }), dub({ dubPremier: '2026-09-04T00:00:00Z', dubDelayedFrom: '2026-11-01T00:00:00Z' }), NOW);
    expect(paused.dub).toMatchObject({ paused: { until: null }, allOutBy: null });
    // Three episodes dropped at once on the premiere.
    const batch = availability(airing({ status: 'FINISHED' }), dub({ dubPremier: '2026-10-16T00:00:00Z', dubBatches: [{ date: '2026-10-16T00:00:00Z', extra: 2 }] }), NOW);
    expect(batch.dub!.out).toBe(6);
  });

  it('counts a simuldub weekly even when the show\'s length isn\'t announced yet', () => {
    // The World's Strongest Witch, 11 Nov: 6 subbed, dub weekly since 21 Oct → 4.
    const witch = availability(
      airing({ episodes: null, next: { episode: 7, at: day('2026-11-18') } }),
      dub({ premier: '2026-10-07T00:00:00Z', dubPremier: '2026-10-21T00:00:00Z', episodes: null }),
      Date.parse('2026-11-11T12:00:00Z'),
    );
    expect(witch.total).toBeNull();
    expect(witch.dub).toMatchObject({ exists: true, out: 4, complete: false, allOutBy: null, estimated: true });
    // A long runner whose dub "premiere" is a restart years later: no guess.
    const onePiece = availability(
      airing({ episodes: null, next: { episode: 1181, at: day('2027-01-03') } }),
      dub({ premier: '1999-10-20T00:00:00Z', dubPremier: '2020-11-24T00:00:00Z', episodes: null }),
      NOW,
    );
    expect(onePiece.dub).toMatchObject({ exists: true, out: null });
    // AnimeSchedule's length is used when AniList hasn't got one.
    expect(availability(airing({ episodes: null, next: { episode: 7, at: day('2026-11-13') } }), dub({ episodes: 12 }), NOW).total).toBe(12);
  });

  it('reads AnimeSchedule data, treating its "no date" value as empty', () => {
    const d = parseDubSchedule({
      route: 'frieren',
      dubExists: true,
      subExists: true,
      dubPremier: '0001-01-01T00:00:00Z',
      episodes: 28,
      status: 'Finished',
      dubEpisodeOverrides: [{ overrideDate: '2026-01-01T00:00:00Z', episodesAired: 3 }],
    });
    expect(d).toMatchObject({ dubPremier: null, episodes: 28, dubBatches: [{ date: '2026-01-01T00:00:00Z', extra: 3 }], url: 'https://animeschedule.net/anime/frieren' });
  });
});
