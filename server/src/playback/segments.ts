import fs from 'node:fs';
import { db, getEpisodes, getMedia, now } from '../db.js';
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

const INTRO_CHAPTER = /^(?:op(?:ening)?(?:\s*(?:song|theme|credits))?|intro(?:duction)?|title sequence|main titles?)(?:\s*\d+)?$/i;
const CREDITS_CHAPTER = /^(?:ed|ending(?:\s*(?:song|theme|credits))?|end(?:ing)?\s*credits|credits|outro|closing(?:\s*credits)?)(?:\s*\d+)?$/i;

/** Intro/credits from chapter names ("Opening", "OP", "Ending", "Credits"…), when the release has them. */
export function segmentsFromChapters(chapters: Chapter[]): Partial<Record<SegmentKind, Segment>> {
  const out: Partial<Record<SegmentKind, Segment>> = {};
  for (const c of chapters) {
    const title = (c.title ?? '').trim();
    const len = c.end - c.start;
    if (!title || len < 10 || len > 240) continue;
    if (!out.intro && INTRO_CHAPTER.test(title)) out.intro = { start: c.start, end: c.end };
    else if (!out.credits && CREDITS_CHAPTER.test(title)) out.credits = { start: c.start, end: c.end };
  }
  return out;
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

export function getSegments(file: string): Partial<Record<SegmentKind, Segment>> {
  const rows = db.prepare('SELECT kind, start, end FROM media_segments WHERE file = ?').all(file) as { kind: SegmentKind; start: number; end: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, { start: r.start, end: r.end }]));
}

function saveSegment(file: string, kind: SegmentKind, seg: Segment, source: 'chapters' | 'audio') {
  db.prepare(
    `INSERT INTO media_segments (file, kind, start, end, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file, kind) DO UPDATE SET start = excluded.start, end = excluded.end, source = excluded.source`,
  ).run(file, kind, seg.start, seg.end, source);
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
 * Finds intros and credits for a season's episodes: chapter names first, then by comparing each
 * episode's audio with its neighbours'. Episodes already analysed are skipped.
 */
export async function analyseSeason(mediaId: number, season: number): Promise<void> {
  const media = getMedia(mediaId);
  if (!media) return;
  const eps = getEpisodes(mediaId).filter((e) => e.season === season && e.has_file && e.file_path && fs.existsSync(e.file_path));
  const todo = eps.filter((e) => !analysed(e.file_path!, 'segments'));
  if (!todo.length) return;

  const info = new Map<string, { duration: number; head?: Uint32Array; tail?: Uint32Array; found: Partial<Record<SegmentKind, Segment>> }>();
  for (const e of eps) {
    const probe = await probeFile(e.file_path!);
    const found = segmentsFromChapters(probe.chapters);
    info.set(e.file_path!, { duration: probe.duration, found: { ...getSegments(e.file_path!), ...found } });
    for (const [kind, seg] of Object.entries(found)) saveSegment(e.file_path!, kind as SegmentKind, seg, 'chapters');
  }

  const load = async (file: string, part: 'head' | 'tail') => {
    const i = info.get(file)!;
    if (i[part]) return i[part]!;
    const len = part === 'head' ? HEAD_SECONDS(i.duration) : TAIL_SECONDS(i.duration);
    const fp = await fingerprint(file, part === 'head' ? 0 : Math.max(0, i.duration - len), len).catch(() => new Uint32Array());
    i[part] = fp;
    return fp;
  };

  // Each episode is compared with the next (or previous) ones until its intro and credits are found.
  const files = eps.map((e) => e.file_path!);
  for (const file of todo.map((e) => e.file_path!)) {
    const me = info.get(file)!;
    const others = files.filter((f) => f !== file).sort((x, y) => Math.abs(files.indexOf(x) - files.indexOf(file)) - Math.abs(files.indexOf(y) - files.indexOf(file)));
    for (const kind of ['intro', 'credits'] as const) {
      if (me.found[kind]) continue;
      const part = kind === 'intro' ? 'head' : 'tail';
      for (const other of others.slice(0, 3)) {
        const m = findSharedAudio(await load(file, part), await load(other, part), { maxSeconds: kind === 'intro' ? 130 : 200 });
        if (!m) continue;
        const offset = (f: string) => (part === 'head' ? 0 : Math.max(0, info.get(f)!.duration - TAIL_SECONDS(info.get(f)!.duration)));
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

/** Movies: only chapter names can say where the credits are. */
export async function analyseMovie(file: string): Promise<void> {
  if (analysed(file, 'segments')) return;
  const probe = await probeFile(file);
  for (const [kind, seg] of Object.entries(segmentsFromChapters(probe.chapters))) saveSegment(file, kind as SegmentKind, seg, 'chapters');
  markAnalysed(file, 'segments');
}
