import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, findFfmpeg, run } from './ffmpeg.js';
import { fileKey, probeFile } from './probe.js';

/** One thumbnail every 10 s, 10×10 per sheet (so one sheet covers 1000 s). */
export const TRICKPLAY = { interval: 10, width: 320, columns: 10, rows: 10 };

export interface TrickplayManifest {
  interval: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  count: number;
  sheets: number;
}

const dirFor = (file: string) => path.join(cacheDir('cache', 'trickplay'), fileKey(file));

/** The finished thumbnails of a file, or null when they haven't been made yet. */
export function trickplayManifest(file: string): TrickplayManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirFor(file), 'manifest.json'), 'utf8')) as TrickplayManifest;
  } catch {
    return null;
  }
}

export function trickplaySheet(file: string, n: number): string | null {
  const p = path.join(dirFor(file), `sheet${n}.jpg`);
  return Number.isInteger(n) && n >= 0 && fs.existsSync(p) ? p : null;
}

/** Thumbnail sheet layout for a video, so every thumb has the video's shape. */
export function sheetLayout(duration: number, width: number, height: number) {
  const thumbH = Math.max(2, Math.round((TRICKPLAY.width * (height || 9)) / (width || 16) / 2) * 2);
  // No extra thumbnail for a fraction of a second at the very end.
  const count = Math.max(1, Math.ceil((duration - 0.5) / TRICKPLAY.interval));
  const perSheet = TRICKPLAY.columns * TRICKPLAY.rows;
  return { thumbH, count, sheets: Math.ceil(count / perSheet) };
}

/**
 * Makes the seek-bar thumbnails. Only keyframes are decoded (`-skip_frame nokey`), so even a long movie
 * takes a minute or two; each thumb is the keyframe nearest its time, which is plenty for a preview.
 */
export async function makeTrickplay(file: string): Promise<TrickplayManifest> {
  const done = trickplayManifest(file);
  if (done) return done;
  const tools = findFfmpeg();
  if (!tools) throw new Error('FFmpeg isn’t installed');
  const probe = await probeFile(file);
  if (!probe.video) throw new Error('No video track');
  const { thumbH, count, sheets } = sheetLayout(probe.duration, probe.video.width, probe.video.height);
  const dir = dirFor(file);
  const work = `${dir}.part`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const r = await run(
    tools.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-skip_frame', 'nokey',
      '-i', file,
      '-map', `0:${probe.video.index}`,
      '-vf', `fps=1/${TRICKPLAY.interval},scale=${TRICKPLAY.width}:${thumbH},tile=${TRICKPLAY.columns}x${TRICKPLAY.rows}`,
      '-fps_mode', 'passthrough',
      '-an', '-sn',
      '-threads', '2',
      '-q:v', '6',
      '-start_number', '0',
      path.join(work, 'sheet%d.jpg'),
    ],
    30 * 60_000,
  );
  if (r.code !== 0) {
    fs.rmSync(work, { recursive: true, force: true });
    throw new Error(r.stderr.trim().split('\n').pop() || 'making thumbnails failed');
  }
  const made = fs.readdirSync(work).filter((f) => /^sheet\d+\.jpg$/.test(f)).length;
  const manifest: TrickplayManifest = {
    interval: TRICKPLAY.interval,
    width: TRICKPLAY.width,
    height: thumbH,
    columns: TRICKPLAY.columns,
    rows: TRICKPLAY.rows,
    count: Math.min(count, made * TRICKPLAY.columns * TRICKPLAY.rows),
    sheets: Math.min(sheets, made),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(work, dir);
  return manifest;
}
