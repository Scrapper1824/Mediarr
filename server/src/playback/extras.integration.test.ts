import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDb, now } from '../db.js';
import { findFfmpeg, run, usePlaybackDataDir } from './ffmpeg.js';
import { analyseSeason, getSegments } from './segments.js';
import { makeTrickplay, trickplaySheet } from './trickplay.js';

/** Intro detection and seek-bar thumbnails with real FFmpeg (skipped without it). */
initDb(':memory:');
const tools = findFfmpeg();

// The same "opening song" in every episode; each episode's own scenes sound different.
const OPENING = "aevalsrc='0.5*sin(2*PI*(300+250*sin(2*PI*0.37*t)+120*sin(2*PI*1.3*t))*t)+0.3*sin(2*PI*(660+180*sin(2*PI*0.21*t))*t)':s=44100:d=40";
const scene = (seed: number, d: number) =>
  `aevalsrc='0.4*sin(2*PI*(${150 + seed * 53}+${90 + seed * 17}*sin(2*PI*${0.11 * seed + 0.3}*t)+60*sin(2*PI*${0.7 + seed * 0.19}*t))*t)*(0.6+0.4*sin(2*PI*${0.05 * seed + 0.2}*t))':s=44100:d=${d}`;

describe.skipIf(!tools)('intro detection and thumbnails with real FFmpeg', () => {
  let tmp: string;
  const files: string[] = [];
  let mediaId: number;

  /** An episode: picture, then scene audio / opening / scene audio. Optional chapters. */
  async function episode(name: string, openingAt: number, seed: number, chapters?: string) {
    const out = path.join(tmp, 'Show', 'Season 01', name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const total = openingAt + 40 + 60;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${total}`,
      '-f', 'lavfi', '-i', `${scene(seed, openingAt)},aformat=channel_layouts=mono`,
      '-f', 'lavfi', '-i', `${OPENING},aformat=channel_layouts=mono`,
      '-f', 'lavfi', '-i', `${scene(seed + 1, 60)},aformat=channel_layouts=mono`,
    ];
    if (chapters) args.push('-i', chapters);
    args.push('-filter_complex', '[1][2][3]concat=n=3:v=0:a=1[a]', '-map', '0:v', '-map', '[a]');
    if (chapters) args.push('-map_chapters', '4');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out);
    const r = await run(tools!.ffmpeg, args, 120_000);
    expect(r.code, r.stderr).toBe(0);
    return out;
  }

  beforeAll(async () => {
    initDb(':memory:');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-extras-'));
    usePlaybackDataDir(tmp);
    const meta = path.join(tmp, 'chapters.txt');
    fs.writeFileSync(
      meta,
      [';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=10000', 'title=Prologue', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=10000', 'END=50000', 'title=Opening', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=50000', 'END=110000', 'title=Part A'].join('\n'),
    );
    files.push(await episode('Show - S01E01.mkv', 20, 1));
    files.push(await episode('Show - S01E02.mkv', 5, 3));
    files.push(await episode('Show - S01E03.mkv', 10, 5, meta));
    mediaId = Number(
      db.prepare(`INSERT INTO media (type, tmdb_id, title, year, root_folder, folder_name, added_at) VALUES ('show', 1, 'Show', 2026, ?, 'Show', ?)`).run(tmp, now()).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO episodes (media_id, season, episode, monitored, has_file, file_path) VALUES (?, 1, ?, 1, 1, ?)');
    files.forEach((f, i) => ins.run(mediaId, i + 1, f));
  }, 300_000);

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it('finds each episode’s intro, from the audio or from chapters', async () => {
    await analyseSeason(mediaId, 1);
    const [e1, e2, e3] = files.map((f) => getSegments(f));
    // Matched by audio: within a couple of seconds of where the song really is.
    expect(Math.abs(e1.intro!.start - 20)).toBeLessThan(2);
    expect(Math.abs(e1.intro!.end - 60)).toBeLessThan(3);
    expect(Math.abs(e2.intro!.start - 5)).toBeLessThan(2);
    expect(Math.abs(e2.intro!.end - 45)).toBeLessThan(3);
    // From the "Opening" chapter: exact.
    expect(e3.intro).toEqual({ start: 10, end: 50 });
    const source = db.prepare('SELECT file, source FROM media_segments WHERE kind = ? ORDER BY file').all('intro') as { source: string }[];
    expect(source.map((s) => s.source)).toEqual(['audio', 'audio', 'chapters']);
    // Nothing is redone the second time.
    const before = Date.now();
    await analyseSeason(mediaId, 1);
    expect(Date.now() - before).toBeLessThan(200);
  }, 180_000);

  it('makes seek-bar thumbnail sheets for the whole video', async () => {
    const m = await makeTrickplay(files[0]);
    expect(m).toMatchObject({ interval: 10, width: 320, height: 180, columns: 10, rows: 10, sheets: 1 });
    expect(m.count).toBe(12); // 120 s at one per 10 s
    expect(trickplaySheet(files[0], 0)).not.toBeNull();
    expect(trickplaySheet(files[0], 1)).toBeNull();
  }, 120_000);
});
