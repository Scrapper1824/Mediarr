import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import { decidePlayback, segmentStarts } from './decide.js';
import { ffmpegInfo, findFfmpeg, run, usePlaybackDataDir } from './ffmpeg.js';
import { dumpFonts, extractSubtitle, keyframes, probeFile } from './probe.js';
import { createSession, startPlayback, stopPlayback, waitForSegment } from './sessions.js';

/** Real FFmpeg end to end. Skipped on machines without FFmpeg (install: winget install Gyan.FFmpeg). */
initDb(':memory:'); // finding FFmpeg reads the (default) settings
const tools = findFfmpeg();
const FONT = ['C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));

describe.skipIf(!tools || !FONT)('with real FFmpeg', () => {
  let tmp: string;
  let clip: string;

  beforeAll(async () => {
    initDb(':memory:');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-ffmpeg-'));
    usePlaybackDataDir(tmp);
    startPlayback();
    // An anime-release-shaped file: HEVC 10-bit, Japanese + English audio, styled ASS subtitles, an embedded font.
    const ass = path.join(tmp, 'subs.ass');
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 1280',
        'PlayResY: 720',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,40,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,{\\an8}Hello from Mediarr',
      ].join('\n'),
    );
    clip = path.join(tmp, 'Show - S01E01.mkv');
    const r = await run(
      tools!.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=20',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20',
        '-i', ass,
        '-map', '0', '-map', '1', '-map', '2', '-map', '3',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error',
        '-c:a', 'aac', '-c:s', 'ass',
        '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=eng',
        '-attach', FONT!, '-metadata:s:t', 'mimetype=font/ttf',
        clip,
      ],
      120_000,
    );
    expect(r.code, r.stderr).toBe(0);
  }, 180_000);

  afterAll(() => {
    stopPlayback();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reads the tracks', async () => {
    const p = await probeFile(clip);
    expect(p.video).toMatchObject({ codec: 'hevc', bitDepth: 10, height: 720 });
    expect(p.audio.map((a) => a.language)).toEqual(['jpn', 'eng']);
    expect(p.subtitles).toEqual([expect.objectContaining({ codec: 'ass', text: true })]);
    // Attached by path here, so FFmpeg kept the folder in the name; Mediarr only ever uses the base name.
    expect(p.fonts).toHaveLength(1);
    expect(path.win32.basename(p.fonts[0].filename)).toBe(path.basename(FONT!));
    expect(p.duration).toBeCloseTo(20, 0);
  });

  it('extracts the styled subtitles and the embedded font', async () => {
    const p = await probeFile(clip);
    const ass = fs.readFileSync(await extractSubtitle(clip, p.subtitles[0]), 'utf8');
    expect(ass).toContain('Hello from Mediarr');
    expect(ass).toContain('{\\an8}');
    const fonts = await dumpFonts(clip, p);
    expect(fonts.names).toEqual([path.basename(FONT!)]);
    expect(fs.statSync(path.join(fonts.dir, fonts.names[0])).size).toBe(fs.statSync(FONT!).size);
  }, 60_000);

  it('converts to HLS with the best encoder, including after a seek', async () => {
    const info = await ffmpegInfo({ force: true });
    const p = await probeFile(clip);
    const caps = { mp4: true, webm: true, h264: true, hevc: false, av1: false, vp9: true, aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false };
    const d = decidePlayback(p, '.mkv', caps, { audio: 1, subtitle: null, quality: '480' }, true, 8e6);
    const s = createSession({ userId: 1, title: 'episode:1', file: clip, ffmpeg: tools!.ffmpeg, probe: p, decision: d, encoder: info.encoder, startAt: 0 });
    const first = await waitForSegment(s, 0, 60_000);
    const later = await waitForSegment(s, 4, 60_000); // 16 s in
    for (const seg of [first, later]) {
      const r = await run(tools!.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,height', '-of', 'json', seg], 30_000);
      const streams = JSON.parse(r.stdout).streams as { codec_name: string; height?: number }[];
      expect(streams.map((x) => x.codec_name).sort()).toEqual(['aac', 'h264']);
      expect(streams.find((x) => x.codec_name === 'h264')!.height).toBe(480);
    }
    console.log(`encoder: ${info.encoder}, GPU encoders that work: ${info.hardware.join(', ') || 'none'}`);
  }, 120_000);

  it('copies H.264 from an MKV without converting it, every piece starting on its planned keyframe', async () => {
    // H.264 with a keyframe every 2.5 s (60 frames at 24 fps) and AC-3 audio the browser can't play.
    const mkv = path.join(tmp, 'Movie (2026).mkv');
    const r = await run(
      tools!.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-c:a', 'ac3', mkv,
      ],
      120_000,
    );
    expect(r.code, r.stderr).toBe(0);
    const p = await probeFile(mkv);
    const caps = { mp4: true, webm: true, h264: true, hevc: false, av1: false, vp9: true, aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false };
    const d = decidePlayback(p, '.mkv', caps, { audio: null, subtitle: null, quality: 'auto' }, false, 8e6);
    expect(d.copyVideo).toBe(true);
    const keys = await keyframes(mkv);
    expect(keys.slice(0, 4)).toEqual([0, 2.5, 5, 7.5]);
    const starts = segmentStarts(p.duration, keys);
    expect(starts).toEqual([0, 5, 10, 15, 20, 25]);
    const check = async (s: ReturnType<typeof createSession>, n: number) => {
      const seg = await waitForSegment(s, n, 60_000);
      const pr = await run(tools!.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,height', '-of', 'json', seg], 30_000);
      const streams = JSON.parse(pr.stdout).streams as { codec_name: string; height?: number }[];
      expect(streams.map((x) => x.codec_name).sort()).toEqual(['aac', 'h264']);
      expect(streams.find((x) => x.codec_name === 'h264')!.height).toBe(720); // the original picture
      const pk = await run(tools!.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-read_intervals', '%+#1', '-of', 'json', seg], 30_000);
      const first = (JSON.parse(pk.stdout).packets as { pts_time: string; flags: string }[])[0];
      expect(Math.abs(Number(first.pts_time) - starts[n]), `piece ${n} starts at ${first.pts_time}`).toBeLessThan(0.1);
      expect(first.flags).toContain('K');
    };
    const s = createSession({ userId: 3, title: 'movie:1', file: mkv, ffmpeg: tools!.ffmpeg, probe: p, decision: d, encoder: 'libx264', startAt: 0, starts });
    for (const n of [0, 1, 2]) await check(s, n);
    // Starting part-way in (a resume or a seek) lands on the same pieces.
    const later = createSession({ userId: 4, title: 'movie:1', file: mkv, ffmpeg: tools!.ffmpeg, probe: p, decision: d, encoder: 'libx264', startAt: 17, starts });
    for (const n of [3, 4, 5]) await check(later, n);
  }, 120_000);

  // Each piece must start exactly where the playlist says, or the player skips and stalls
  // (AMD's encoder ignored forced keyframes and made 10-second pieces until forced_idr was set).
  it.each(['gpu', 'libx264'] as const)('cuts pieces exactly on the playlist’s 4-second marks (%s)', async (which) => {
    const info = await ffmpegInfo({ force: true });
    const encoder = which === 'gpu' ? info.encoder : 'libx264';
    const p = await probeFile(clip);
    const d = decidePlayback(p, '.mkv', { mp4: true, webm: true, h264: true, hevc: false, av1: false, vp9: true, aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false }, { audio: 0, subtitle: null, quality: 'auto' }, false, 8e6);
    const s = createSession({ userId: 2, title: `episode:${which}`, file: clip, ffmpeg: tools!.ffmpeg, probe: p, decision: d, encoder, startAt: 0 });
    for (const n of [0, 1, 2, 3]) {
      const seg = await waitForSegment(s, n, 60_000);
      const r = await run(tools!.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-read_intervals', '%+#1', '-of', 'json', seg], 30_000);
      const pk = (JSON.parse(r.stdout).packets as { pts_time: string; flags: string }[])[0];
      // Within a few frames (B-frame reordering can delay the first one); the bug was whole seconds off.
      expect(Math.abs(Number(pk.pts_time) - n * 4), `segment ${n} with ${encoder} starts at ${pk.pts_time}`).toBeLessThan(0.25);
      expect(pk.flags).toContain('K');
    }
  }, 120_000);
});
