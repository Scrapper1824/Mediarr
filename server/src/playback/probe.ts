import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { cacheDir, requireFfmpeg, run } from './ffmpeg.js';

export interface VideoTrack {
  index: number;
  codec: string;
  profile: string | null;
  pixFmt: string | null;
  bitDepth: number;
  width: number;
  height: number;
}

export interface AudioTrack {
  /** Stream index in the file. */
  index: number;
  /** Position among audio tracks (FFmpeg's 0:a:N). */
  order: number;
  codec: string;
  channels: number;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number;
  /** Position among subtitle tracks (0:s:N). */
  order: number;
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  forced: boolean;
  /** Text (ASS/SRT…, drawn in the browser) or image (PGS/VobSub, burned into the video). */
  text: boolean;
}

export interface FontAttachment {
  index: number;
  filename: string;
}

export interface Chapter {
  start: number;
  end: number;
  title: string | null;
}

export interface MediaProbe {
  /** Bumped when the probe gains fields, so cached older probes are redone. */
  version?: number;
  container: string;
  duration: number;
  /** Overall bitrate in bits/s, 0 if unknown. */
  bitrate: number;
  video: VideoTrack | null;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  fonts: FontAttachment[];
  chapters: Chapter[];
}

const PROBE_VERSION = 2;

const TEXT_SUBS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text']);
const FONT_EXT = /\.(ttf|otf|ttc|woff2?)$/i;

const tag = (s: any, k: string): string | null => {
  const v = s.tags?.[k] ?? s.tags?.[k.toUpperCase()];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** Turns `ffprobe -show_streams -show_format -of json` output into the tracks Mediarr cares about. */
export function parseProbe(json: any): MediaProbe {
  const streams: any[] = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const pixFmt: string | null = v?.pix_fmt ?? null;
  const bitDepth = Number(v?.bits_per_raw_sample) || (pixFmt && /(10|12)(le|be)?$/.test(pixFmt) ? Number(pixFmt.match(/(10|12)/)![1]) : 8);
  let a = 0;
  let sub = 0;
  return {
    version: PROBE_VERSION,
    container: String(json.format?.format_name ?? ''),
    duration: Number(json.format?.duration) || Number(v?.duration) || 0,
    bitrate: Number(json.format?.bit_rate) || 0,
    video: v
      ? { index: v.index, codec: v.codec_name, profile: v.profile ?? null, pixFmt, bitDepth, width: v.width ?? 0, height: v.height ?? 0 }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        index: s.index,
        order: a++,
        codec: s.codec_name,
        channels: s.channels ?? 2,
        language: tag(s, 'language'),
        title: tag(s, 'title'),
        isDefault: !!s.disposition?.default,
      })),
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        order: sub++,
        codec: s.codec_name ?? 'unknown',
        language: tag(s, 'language'),
        title: tag(s, 'title'),
        isDefault: !!s.disposition?.default,
        forced: !!s.disposition?.forced,
        text: TEXT_SUBS.has(s.codec_name),
      })),
    fonts: streams
      .filter((s) => s.codec_type === 'attachment' && FONT_EXT.test(tag(s, 'filename') ?? ''))
      .map((s) => ({ index: s.index, filename: tag(s, 'filename')! })),
    chapters: (json.chapters ?? []).map((c: any) => ({
      start: Number(c.start_time) || 0,
      end: Number(c.end_time) || 0,
      title: typeof c.tags?.title === 'string' ? c.tags.title.trim() : null,
    })),
  };
}

/** Probes a file, reusing the stored result while the file is unchanged. */
export async function probeFile(file: string): Promise<MediaProbe> {
  const st = fs.statSync(file);
  const row = db.prepare('SELECT size, mtime, json FROM file_probes WHERE path = ?').get(file) as { size: number; mtime: number; json: string } | undefined;
  if (row && row.size === st.size && row.mtime === Math.floor(st.mtimeMs)) {
    const cached = JSON.parse(row.json) as MediaProbe;
    if (cached.version === PROBE_VERSION) return cached;
  }
  const { ffprobe } = requireFfmpeg();
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file], 60_000);
  if (r.code !== 0) throw new Error(`Couldn’t read this file (${r.stderr.trim().split('\n').pop() ?? 'ffprobe failed'})`);
  const probe = parseProbe(JSON.parse(r.stdout));
  db.prepare(
    'INSERT INTO file_probes (path, size, mtime, json) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, json = excluded.json',
  ).run(file, st.size, Math.floor(st.mtimeMs), JSON.stringify(probe));
  return probe;
}

/** A stable folder name for things extracted from one version of a file. */
export function fileKey(file: string): string {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 20);
}

/** One text subtitle track as an .ass file (extracted once, then reused). */
export async function extractSubtitle(file: string, track: SubtitleTrack): Promise<string> {
  if (!track.text) throw new Error('Image subtitles are burned into the video instead');
  const out = path.join(cacheDir('cache', 'subs', fileKey(file)), `${track.order}.ass`);
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.part.ass`;
  const { ffmpeg } = requireFfmpeg();
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', `0:s:${track.order}`, '-c:s', 'ass', tmp], 180_000);
  if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(`Couldn’t extract the subtitles (${r.stderr.trim().split('\n').pop() ?? 'ffmpeg failed'})`);
  fs.renameSync(tmp, out);
  return out;
}

const safeFontName = (name: string) => path.basename(name).replace(/[^\w.\- ]/g, '_');

/** The file's embedded fonts in a folder (dumped once). Returns their file names. */
export async function dumpFonts(file: string, probe: MediaProbe): Promise<{ dir: string; names: string[] }> {
  const dir = cacheDir('cache', 'fonts', fileKey(file));
  const names = probe.fonts.map((f) => safeFontName(f.filename));
  const missing = probe.fonts.filter((f) => !fs.existsSync(path.join(dir, safeFontName(f.filename))));
  if (missing.length) {
    const { ffmpeg } = requireFfmpeg();
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const f of missing) args.push(`-dump_attachment:${f.index}`, path.join(dir, safeFontName(f.filename)));
    // FFmpeg dumps attachments while opening the input; with no output it then exits with an error, which is fine.
    args.push('-i', file);
    await run(ffmpeg, args, 120_000);
  }
  return { dir, names: names.filter((n) => fs.existsSync(path.join(dir, n))) };
}
