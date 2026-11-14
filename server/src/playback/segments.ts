import fs from 'node:fs';
import { aniSkipTimes, SAME_CUT_SECONDS } from '../clients/aniskip.js';
import { malIdsFor } from '../clients/anilist.js';
import { IntroDbBusy, introDbTimes } from '../clients/theintrodb.js';
import { seasonsFor } from '../core/library.js';
import { db, getEpisodes, getMedia, now, type EpisodeRow, type MediaRow } from '../db.js';
import { findFfmpeg, runBinary } from './ffmpeg.js';
import { probeFile, type Chapter } from './probe.js';

export type SegmentKind = 'intro' | 'credits';
export interface Segment {
  start: number;
  end: number;
}

/** Seconds of audio per Chromaprint point (11025 Hz, 4096-sample frames, 1/3 overlap). */
export const POINT_SECONDS = 4096 / 11025 / 3;

// ---- Chapters ----

/** Marks files whose chapters were read under the current naming rules (bumped when the rules change). */
export const CHAPTER_RULES = 'chapters-v2';

/** The opening song itself. */
const OPENING_CHAPTER = /^(?:op(?:ening)?(?:\s*(?:song|theme|credits))?|title sequence|main titles?)(?:\s*\d+)?$/i;
/**
 * "Intro" is only the opening when nothing is called Opening/OP: some releases (EMBER, for one) call the
 * cold open before the song "Intro" and the song "Opening".
 */
const GENERIC_INTRO_CHAPTER = /^intro(?:duction)?(?:\s*\d+)?$/i;
const CREDITS_CHAPTER = /^(?:ed|ending(?:\s*(?:song|theme|credits))?|end(?:ing)?\s*credits|credits|outro|closing(?:\s*credits)?)(?:\s*\d+)?$/i;

/**
 * Puts each section where it belongs by position: something in the second half of an episode is the
 * credits, whatever it's called. First episodes often play the opening song over the end credits, and
 * releases name that chapter "Opening"; it must not become a "Skip intro" at 23 minutes.
 */
export function placeSegments(segs: Partial<Record<SegmentKind, Segment>>, duration: number | null | undefined): Partial<Record<SegmentKind, Segment>> {
  if (!duration || duration <= 0) return segs;
  const half = duration / 2;
  const out: Partial<Record<SegmentKind, Segment>> = {};
  for (const kind of ['intro', 'credits'] as const) {
    const seg = segs[kind];
    if (!seg) continue;
    const where: SegmentKind = seg.start >= half ? 'credits' : seg.end <= half ? 'intro' : kind;
    // Its own kind wins a tie (an intro and credits both in the same half: keep the one named for it).
    if (!out[where] || where === kind) out[where] = seg;
  }
  return out;
}

/** Intro/credits from chapter names ("Opening", "OP", "Ending", "Credits"…), when the release has them. */
export function segmentsFromChapters(chapters: Chapter[]): Partial<Record<SegmentKind, Segment>> {
  const out: Partial<Record<SegmentKind, Segment>> = {};
  const length = chapters.reduce((m, c) => Math.max(m, c.end), 0);
  const hasOpening = chapters.some((c) => OPENING_CHAPTER.test((c.title ?? '').trim()));
  const isIntro = (title: string) => OPENING_CHAPTER.test(title) || (!hasOpening && GENERIC_INTRO_CHAPTER.test(title));
  for (const c of chapters) {
    const title = (c.title ?? '').trim();
    const len = c.end - c.start;
    if (!title || len < 10 || len > 240) continue;
    if (!out.intro && isIntro(title)) out.intro = { start: c.start, end: c.end };
    else if (!out.credits && CREDITS_CHAPTER.test(title)) out.credits = { start: c.start, end: c.end };
  }
  return placeSegments(out, length);
}

// ---- Audio fingerprints ----

const popcount = (n: number) => {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

export interface MatchOptions {
  /** Points whose fingerprints differ in more bits than this don't match. */
  maxBitDiff?: number;
  /** Short mismatches inside a match are tolerated (seconds). */
  maxGap?: number;
  minSeconds?: number;
  maxSeconds?: number;
}

export interface Match {
  a: Segment;
  b: Segment;
}

/**
 * The longest stretch of audio two fingerprints share (an anime opening, a show's theme), as time ranges
 * in each. Candidate alignments come from points that are identical in both; each is then walked to find
 * the longest run of near-identical points. Null when nothing long enough matches.
 */
export function findSharedAudio(a: Uint32Array, b: Uint32Array, opts: MatchOptions = {}): Match | null {
  const maxBitDiff = opts.maxBitDiff ?? 6;
  const maxGap = Math.round((opts.maxGap ?? 3.5) / POINT_SECONDS);
  const minPoints = Math.round((opts.minSeconds ?? 15) / POINT_SECONDS);
  const maxPoints = Math.round((opts.maxSeconds ?? 130) / POINT_SECONDS);

  // Where each fingerprint value appears in b.
  const where = new Map<number, number[]>();
  for (let j = 0; j < b.length; j++) {
    const list = where.get(b[j]);
    if (list) {
      if (list.length < 8) list.push(j); // very common values (silence) say nothing about alignment
    } else where.set(b[j], [j]);
  }
  const shifts = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    for (const j of where.get(a[i]) ?? []) shifts.set(j - i, (shifts.get(j - i) ?? 0) + 1);
  }
  // Only alignments supported by several exact hits are worth walking.
  const exact = [...shifts.entries()].filter(([, hits]) => hits >= 3).sort((x, y) => y[1] - x[1]).slice(0, 30);
  // Encoding the same song twice can flip a bit or two in every point, leaving few exact hits; so also
  // score every alignment on a sample of points, counting near-matches.
  const step = 4;
  const sampled: [number, number][] = [];
  for (let shift = -a.length + minPoints; shift < b.length - minPoints; shift++) {
    let hits = 0;
    for (let i = Math.max(0, -shift); i < a.length && i + shift < b.length; i += step) if (popcount(a[i] ^ b[i + shift]) <= maxBitDiff) hits++;
    if (hits * step >= minPoints / 2) sampled.push([shift, hits]);
  }
  sampled.sort((x, y) => y[1] - x[1]);
  const candidates = [...new Map([...exact, ...sampled.slice(0, 10)]).entries()];

  let best: { start: number; end: number; shift: number } | null = null;
  for (const [shift] of candidates) {
    const from = Math.max(0, -shift);
    const to = Math.min(a.length, b.length - shift);
    let runStart = -1;
    let lastGood = -1;
    const finish = () => {
      if (runStart < 0) return;
      const len = lastGood - runStart + 1;
      if (len >= minPoints && len <= maxPoints && (!best || len > best.end - best.start)) best = { start: runStart, end: lastGood + 1, shift };
    };
    for (let i = from; i < to; i++) {
      if (popcount(a[i] ^ b[i + shift]) <= maxBitDiff) {
        if (runStart < 0) runStart = i;
        lastGood = i;
      } else if (runStart >= 0 && i - lastGood > maxGap) {
        finish();
        runStart = -1;
      }
    }
    finish();
  }
  if (!best) return null;
  let { start, end } = best as { start: number; end: number; shift: number };
  const { shift } = best as { start: number; end: number; shift: number };
  // Gaps are allowed inside a match, so a few chance look-alikes just outside it can get attached.
  // Trim the edges to where it matches steadily (≥75% of points over ~2 s).
  const good = (i: number) => popcount(a[i] ^ b[i + shift]) <= maxBitDiff;
  const window = Math.round(2 / POINT_SECONDS);
  const steady = (from: number) => {
    let hits = 0;
    for (let i = from; i < from + window && i < end; i++) if (good(i)) hits++;
    return hits >= window * 0.75;
  };
  while (start < end - window && !(good(start) && steady(start))) start++;
  while (end - 1 > start + window && !(good(end - 1) && steady(end - window))) end--;
  if (end - start < minPoints) return null;
  const t = (p: number) => Math.round(p * POINT_SECONDS * 100) / 100;
  return { a: { start: t(start), end: t(end) }, b: { start: t(start + shift), end: t(end + shift) } };
}

/** The Chromaprint fingerprint of `seconds` of audio starting at `from`. */
export async function fingerprint(file: string, from: number, seconds: number): Promise<Uint32Array> {
  const tools = findFfmpeg();
  if (!tools) throw new Error('FFmpeg isn’t installed');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (from > 0) args.push('-ss', String(from));
  args.push('-t', String(seconds), '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '11025', '-f', 'chromaprint', '-fp_format', 'raw', '-');
  const r = await runBinary(tools.ffmpeg, args, 180_000);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'fingerprinting failed');
  const buf = r.stdout;
  const out = new Uint32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

// ---- Stored results ----

/** Saved intro/credits for a file; with its length, sections saved before placeSegments existed are put right too. */
export function getSegments(file: string, duration?: number | null): Partial<Record<SegmentKind, Segment>> {
  const rows = db.prepare('SELECT kind, start, end FROM media_segments WHERE file = ?').all(file) as { kind: SegmentKind; start: number; end: number }[];
  return placeSegments(Object.fromEntries(rows.map((r) => [r.kind, { start: r.start, end: r.end }])), duration);
}

function saveSegment(file: string, kind: SegmentKind, seg: Segment, source: 'chapters' | 'aniskip' | 'introdb' | 'audio') {
  db.prepare(
    `INSERT INTO media_segments (file, kind, start, end, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file, kind) DO UPDATE SET start = excluded.start, end = excluded.end, source = excluded.source`,
  ).run(file, kind, seg.start, seg.end, source);
}

function deleteSegment(file: string, kind: SegmentKind) {
  db.prepare('DELETE FROM media_segments WHERE file = ? AND kind = ?').run(file, kind);
}

const stamp = (file: string) => {
  const st = fs.statSync(file);
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
};

export function analysed(file: string, what: string): boolean {
  if (!fs.existsSync(file)) return true;
  const row = db.prepare('SELECT size, mtime FROM media_analysis WHERE file = ? AND what = ?').get(file, what) as { size: number; mtime: number } | undefined;
  const st = stamp(file);
  return !!row && row.size === st.size && row.mtime === st.mtime;
}

export function markAnalysed(file: string, what: string) {
  const st = stamp(file);
  db.prepare(
    `INSERT INTO media_analysis (file, what, size, mtime, done_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file, what) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, done_at = excluded.done_at`,
  ).run(file, what, st.size, st.mtime, now());
}

/** How much of the start/end of an episode to compare: intros are early, credits late. */
// At least the first/last 3 minutes, so short episodes (and openings that start late) are covered.
const HEAD_SECONDS = (duration: number) => Math.min(duration, 600, Math.max(180, duration * 0.3));
const TAIL_SECONDS = (duration: number) => Math.min(duration, 360, Math.max(180, duration * 0.25));

/**
 * Which MyAnimeList entry and episode number an anime episode is (AniSkip works by those). A season can
 * be several AniList entries back to back (split cours), each numbered from 1.
 */
export async function malEpisodes(media: MediaRow, season: number, eps: EpisodeRow[]): Promise<Map<number, { malId: number; episode: number }>> {
  const out = new Map<number, { malId: number; episode: number }>();
  const ids = seasonsFor(media).find((x) => x.season === season)?.anilistIds ?? [];
  if (!ids.length) return out;
  const meta = await malIdsFor(ids);
  let before = 0;
  const ranges = ids.map((id) => {
    const m = meta.get(id);
    const from = before + 1;
    before += m?.episodes ?? 100_000; // still airing: the rest of the season
    return { malId: m?.idMal ?? null, from, to: before };
  });
  for (const e of eps) {
    const r = ranges.find((x) => e.episode >= x.from && e.episode <= x.to);
    if (r?.malId) out.set(e.id, { malId: r.malId, episode: e.episode - r.from + 1 });
  }
  return out;
}

/**
 * Finds intros and credits for a season's episodes: chapter names first, then (anime) the times people
 * submitted to AniSkip, then by comparing each episode's audio with its neighbours'. Episodes already
 * analysed are skipped.
 */
export async function analyseSeason(mediaId: number, season: number): Promise<void> {
  const media = getMedia(mediaId);
  if (!media) return;
  const eps = getEpisodes(mediaId).filter((e) => e.season === season && e.has_file && e.file_path && fs.existsSync(e.file_path));
  const todo = eps.filter((e) => !analysed(e.file_path!, 'segments'));
  // Anime asks AniSkip once per file, including files whose intro was guessed before AniSkip was used.
  const skipTodo = media.type === 'anime' ? eps.filter((e) => !analysed(e.file_path!, 'aniskip')) : [];
  // Shows ask TheIntroDB once per file the same way (TMDB numbering, which is what shows here use).
  const introDbTodo = media.type === 'show' && media.tmdb_id ? eps.filter((e) => !analysed(e.file_path!, 'introdb')) : [];
  // Chapters read again under the current rules (an "Intro" chapter used to win even when it was the cold open).
  const recheck = eps.filter((e) => !analysed(e.file_path!, CHAPTER_RULES));
  if (!todo.length && !skipTodo.length && !introDbTodo.length && !recheck.length) return;

  const info = new Map<string, { duration: number; head?: Uint32Array; tail?: Uint32Array; found: Partial<Record<SegmentKind, Segment>> }>();
  const fromChapters = new Map<string, Partial<Record<SegmentKind, Segment>>>();
  for (const e of eps) {
    const file = e.file_path!;
    const probe = await probeFile(file);
    const found = segmentsFromChapters(probe.chapters);
    fromChapters.set(file, found);
    // A section saved from chapters that the current rules don't give any more is dropped, and the other
    // sources look for it again.
    let dropped = false;
    for (const row of db.prepare("SELECT kind FROM media_segments WHERE file = ? AND source = 'chapters'").all(file) as { kind: SegmentKind }[]) {
      if (found[row.kind]) continue;
      deleteSegment(file, row.kind);
      dropped = true;
    }
    if (dropped) {
      if (media.type === 'anime' && !skipTodo.includes(e)) skipTodo.push(e);
      if (media.type === 'show' && media.tmdb_id && !introDbTodo.includes(e)) introDbTodo.push(e);
      if (!todo.includes(e)) todo.push(e);
    }
    for (const [kind, seg] of Object.entries(found)) saveSegment(file, kind as SegmentKind, seg, 'chapters');
    info.set(file, { duration: probe.duration, found: { ...getSegments(file), ...found } });
    markAnalysed(file, CHAPTER_RULES);
  }

  const load = async (file: string, part: 'head' | 'tail') => {
    const i = info.get(file)!;
    if (i[part]) return i[part]!;
    const len = part === 'head' ? HEAD_SECONDS(i.duration) : TAIL_SECONDS(i.duration);
    const fp = await fingerprint(file, part === 'head' ? 0 : Math.max(0, i.duration - len), len).catch(() => new Uint32Array());
    i[part] = fp;
    return fp;
  };
  const files = eps.map((e) => e.file_path!);
  const neighbours = (file: string) =>
    files.filter((f) => f !== file).sort((x, y) => Math.abs(files.indexOf(x) - files.indexOf(file)) - Math.abs(files.indexOf(y) - files.indexOf(file)));
  const partOffset = (f: string, part: 'head' | 'tail') => (part === 'head' ? 0 : Math.max(0, info.get(f)!.duration - TAIL_SECONDS(info.get(f)!.duration)));

  // Real times from AniSkip beat a guess from the audio (and replace one made earlier); chapters still win.
  if (skipTodo.length) {
    const mal = await malEpisodes(media, season, skipTodo).catch(() => new Map<number, { malId: number; episode: number }>());
    for (const e of skipTodo) {
      const file = e.file_path!;
      const me = info.get(file)!;
      const target = mal.get(e.id);
      try {
        if (target) {
          const times = await aniSkipTimes(target.malId, target.episode, me.duration);
          const sameCut = !times.measuredOn || Math.abs(times.measuredOn - me.duration) <= SAME_CUT_SECONDS;
          const placed = placeSegments(times, me.duration);
          for (const kind of ['intro', 'credits'] as const) {
            const seg = placed[kind];
            if (!seg || fromChapters.get(file)?.[kind]) continue;
            if (sameCut) {
              me.found[kind] = seg;
              saveSegment(file, kind, seg, 'aniskip');
              continue;
            }
            // A release cut differently: AniSkip's times may be shifted, but the opening/ending is just as
            // long. Find a stretch exactly that long that this episode shares with its neighbours.
            const length = seg.end - seg.start;
            const part = kind === 'intro' ? 'head' : 'tail';
            // The extra (or missing) time is somewhere in the file, so here it starts within that much of
            // where AniSkip has it.
            const shift = Math.abs(me.duration - (times.measuredOn ?? me.duration));
            const near = (start: number) => start >= seg.start - shift - 20 && start <= seg.start + shift + 20;
            let aligned: Segment | null = null;
            for (const other of neighbours(file).slice(0, 3)) {
              // The song can run straight into other audio every episode shares (a sponsor card, an
              // eyecatch), so the shared stretch may be longer than the song: then it's at one end of it.
              const m = findSharedAudio(await load(file, part), await load(other, part), { minSeconds: Math.max(10, length - 8), maxSeconds: length + 40 });
              if (!m) continue;
              const run = { start: m.a.start + partOffset(file, part), end: m.a.end + partOffset(file, part) };
              const options = run.end - run.start > length + 8 ? [{ start: run.start, end: run.start + length }, { start: run.end - length, end: run.end }] : [run];
              const pick = options.find((o) => near(o.start));
              if (!pick) continue;
              aligned = pick;
              break;
            }
            if (aligned) {
              me.found[kind] = aligned;
              saveSegment(file, kind, aligned, 'aniskip');
            } else if (me.found[kind] && (!near(me.found[kind]!.start) || Math.abs(me.found[kind]!.end - me.found[kind]!.start - length) > 10)) {
              // An earlier guess nowhere near where the opening/ending is, or not its length, isn't it: better none.
              deleteSegment(file, kind);
              delete me.found[kind];
            }
          }
        }
        markAnalysed(file, 'aniskip');
      } catch {
        // AniSkip unreachable: try again next time
      }
    }
  }

  // Shows: TheIntroDB picks the times submitted for a release this long, so they're used as they are.
  for (const e of introDbTodo) {
    const file = e.file_path!;
    const me = info.get(file)!;
    try {
      const times = placeSegments(await introDbTimes({ tmdbId: media.tmdb_id!, season: e.season, episode: e.episode, duration: me.duration }), me.duration);
      for (const kind of ['intro', 'credits'] as const) {
        const seg = times[kind];
        if (!seg || fromChapters.get(file)?.[kind]) continue;
        me.found[kind] = seg;
        saveSegment(file, kind, seg, 'introdb');
      }
      markAnalysed(file, 'introdb');
    } catch (err) {
      if (err instanceof IntroDbBusy) break; // their limit: the rest wait for the next run
    }
  }

  // Each episode is compared with the next (or previous) ones until its intro and credits are found.
  if (!todo.length) return;
  for (const file of todo.map((e) => e.file_path!)) {
    const me = info.get(file)!;
    const others = neighbours(file);
    for (const kind of ['intro', 'credits'] as const) {
      if (me.found[kind]) continue;
      const part = kind === 'intro' ? 'head' : 'tail';
      for (const other of others.slice(0, 3)) {
        const m = findSharedAudio(await load(file, part), await load(other, part), { maxSeconds: kind === 'intro' ? 130 : 200 });
        if (!m) continue;
        const offset = (f: string) => partOffset(f, part);
        const mine = { start: m.a.start + offset(file), end: m.a.end + offset(file) };
        me.found[kind] = mine;
        saveSegment(file, kind, mine, 'audio');
        const them = info.get(other)!;
        if (!them.found[kind]) {
          them.found[kind] = { start: m.b.start + offset(other), end: m.b.end + offset(other) };
          saveSegment(other, kind, them.found[kind]!, 'audio');
        }
        break;
      }
    }
    markAnalysed(file, 'segments');
  }
}

/** Movies: chapter names, then TheIntroDB (there are no other episodes to compare with). */
export async function analyseMovie(file: string, tmdbId?: number | null): Promise<void> {
  const needChapters = !analysed(file, 'segments') || !analysed(file, CHAPTER_RULES);
  let needIntroDb = !!tmdbId && !analysed(file, 'introdb');
  if (!needChapters && !needIntroDb) return;
  const probe = await probeFile(file);
  const chapters = segmentsFromChapters(probe.chapters);
  if (needChapters) {
    // Sections saved from chapters that the current rules don't give any more are dropped (TheIntroDB is asked again).
    for (const row of db.prepare("SELECT kind FROM media_segments WHERE file = ? AND source = 'chapters'").all(file) as { kind: SegmentKind }[]) {
      if (chapters[row.kind]) continue;
      deleteSegment(file, row.kind);
      needIntroDb = !!tmdbId;
    }
    for (const [kind, seg] of Object.entries(chapters)) saveSegment(file, kind as SegmentKind, seg, 'chapters');
    markAnalysed(file, 'segments');
    markAnalysed(file, CHAPTER_RULES);
  }
  // Then TheIntroDB (by TMDB id); chapters in the file still win.
  if (needIntroDb) {
    try {
      const times = placeSegments(await introDbTimes({ tmdbId: tmdbId!, duration: probe.duration }), probe.duration);
      for (const kind of ['intro', 'credits'] as const) {
        const seg = times[kind];
        if (seg && !chapters[kind]) saveSegment(file, kind, seg, 'introdb');
      }
      markAnalysed(file, 'introdb');
    } catch {
      // unreachable or over their limit: asked again next time
    }
  }
}
