import { airingFor, type AiringInfo } from '../clients/anilist.js';
import { dubScheduleFor, type DubSchedule } from '../clients/animeschedule.js';

/**
 * What's out for an anime, subbed and dubbed, and when the rest should arrive.
 * Subs follow AniList's exact airing schedule (simulcast). Dubs come from AnimeSchedule's premiere date
 * and are counted at one episode a week from there (how simuldubs are released), so dub numbers and dates
 * are estimates and are marked as such.
 */

const WEEK = 7 * 24 * 3600_000;

export interface Availability {
  total: number | null;
  /** A film or other one-off (no episode counts shown). */
  single: boolean;
  sub: {
    out: number;
    complete: boolean;
    /** Not started yet: when episode 1 airs. */
    startsAt: string | null;
    next: { episode: number; at: string } | null;
    /** When the last episode airs; null when the length isn't known. */
    allOutBy: string | null;
  };
  /** null: no dub information for this title. */
  dub: {
    exists: boolean;
    /** null when the count can't be estimated (no premiere date, or no known length). */
    out: number | null;
    complete: boolean;
    startsAt: string | null;
    allOutBy: string | null;
    /** On a break right now; `until` null when no return date is known. */
    paused: { until: string | null } | null;
    estimated: boolean;
    source: { name: string; url: string };
  } | null;
}

const ms = (s: string) => new Date(s).getTime();

export function subAvailability(a: AiringInfo, now: number): Availability['sub'] {
  const complete = a.status === 'FINISHED';
  const total = a.episodes;
  const out = complete ? (total ?? 0) : a.next ? a.next.episode - 1 : 0;
  const startsAt = a.status === 'NOT_YET_RELEASED' ? (a.next?.at ?? a.startDate) : null;
  let allOutBy: string | null = null;
  if (!complete && total) {
    const last = a.upcoming.find((u) => u.episode === total);
    if (last) allOutBy = last.at;
    else if (a.next) allOutBy = new Date(ms(a.next.at) + (total - a.next.episode) * WEEK).toISOString();
  }
  return { out: Math.max(0, out), complete, startsAt, next: complete ? null : a.next, allOutBy };
}

export function dubAvailability(d: DubSchedule, sub: Availability['sub'], total: number | null, now: number): NonNullable<Availability['dub']> {
  const base = { source: { name: 'AnimeSchedule', url: d.url }, estimated: true };
  if (!d.dubExists) return { ...base, exists: false, out: 0, complete: false, startsAt: null, allOutBy: null, paused: null };
  // No premiere date: a finished show whose dub exists has it all (e.g. a streaming service's same-day dub).
  if (!d.dubPremier) {
    const all = sub.complete && total ? total : null;
    return { ...base, exists: true, out: all, complete: all !== null, startsAt: null, allOutBy: null, paused: null, estimated: false };
  }
  const premier = ms(d.dubPremier);
  // Pause: from / until (until may be unknown).
  const from = d.dubDelayedFrom ? ms(d.dubDelayedFrom) : null;
  const until = d.dubDelayedUntil ? ms(d.dubDelayedUntil) : null;
  const pausedNow = from !== null && from <= now && (until === null || until > now);
  const pauseWeeksSoFar = from !== null && from <= now ? Math.max(0, Math.floor(((until !== null && until < now ? until : now) - from) / WEEK)) : 0;
  const pauseWeeksTotal = from !== null ? (until !== null ? Math.max(0, Math.round((until - from) / WEEK)) : null) : 0;
  const extraSoFar = d.dubBatches.filter((b) => ms(b.date) <= now).reduce((n, b) => n + b.extra, 0);
  const extraAll = d.dubBatches.reduce((n, b) => n + b.extra, 0);

  if (premier > now) {
    const allOutBy = total ? new Date(premier + Math.max(0, total - 1 - extraAll) * WEEK + (pauseWeeksTotal ?? 0) * WEEK).toISOString() : null;
    return { ...base, exists: true, out: 0, complete: false, startsAt: d.dubPremier, allOutBy, paused: null };
  }
  if (!total) {
    // Length not announced (still airing). A simuldub that started with the show can still be counted
    // weekly, up to what's subbed. A dub that started years after the show (a long runner like One Piece,
    // where the "premiere" is a later restart) can't, so that stays unknown.
    const simuldub = !!d.premier && premier - ms(d.premier) < 365 * 24 * 3600_000;
    const weekly = Math.floor((now - premier) / WEEK) + 1 - pauseWeeksSoFar + extraSoFar;
    const out = simuldub && sub.out > 0 ? Math.max(0, Math.min(sub.out, weekly)) : null;
    return { ...base, exists: true, out, complete: false, startsAt: null, allOutBy: null, paused: pausedNow ? { until: d.dubDelayedUntil } : null };
  }

  const weekly = Math.floor((now - premier) / WEEK) + 1 - pauseWeeksSoFar + extraSoFar;
  // A dub can't run ahead of the subs while the show is still airing.
  const cap = sub.complete ? total : Math.min(total, sub.out);
  const out = Math.max(0, Math.min(cap, weekly));
  const complete = out >= total;
  const allOutBy =
    complete || pauseWeeksTotal === null
      ? null
      : new Date(premier + Math.max(0, total - 1 - extraAll) * WEEK + pauseWeeksTotal * WEEK).toISOString();
  return { ...base, exists: true, out, complete, startsAt: null, allOutBy, paused: pausedNow ? { until: d.dubDelayedUntil } : null };
}

export function availability(a: AiringInfo, d: DubSchedule | null, now = Date.now()): Availability {
  const sub = subAvailability(a, now);
  // AniList's count first; AnimeSchedule sometimes knows the length when AniList doesn't yet.
  const total = a.episodes ?? d?.episodes ?? (sub.complete ? sub.out : null);
  return {
    total,
    single: a.format === 'MOVIE' || (a.episodes === 1 && sub.complete),
    sub,
    dub: d ? dubAvailability(d, sub, total, now) : null,
  };
}

// AniList and AnimeSchedule are asked at most every few hours per title.
const cache = new Map<number, { at: number; value: Availability }>();
const TTL_MS = 3 * 3600_000;

export async function availabilityFor(anilistId: number): Promise<Availability> {
  const hit = cache.get(anilistId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [airing, dub] = await Promise.all([airingFor(anilistId), dubScheduleFor(anilistId).catch(() => null)]);
  const value = availability(airing, dub);
  cache.set(anilistId, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}
