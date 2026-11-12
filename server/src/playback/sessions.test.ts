import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import type { Decision } from './decide.js';
import { usePlaybackDataDir } from './ffmpeg.js';
import type { MediaProbe } from './probe.js';
import { activeSessions, createSession, gpuFallbackActive, resetGpuFallback, getSession, startPlayback, stopPlayback, sweep, useLauncher, waitForSegment } from './sessions.js';

let tmp: string;
let launches: number[];

/** Stand-in for FFmpeg: writes seg<N>.ts files from the start segment on, like the real thing, until killed. */
const FAKE = `
const fs = require('fs'), path = require('path');
const [dir, start, total] = process.argv.slice(1);
let n = Number(start);
const t = setInterval(() => {
  for (let i = 0; i < 5 && n < Number(total); i++, n++) {
    const f = path.join(dir, 'seg' + n + '.ts');
    fs.writeFileSync(f + '.tmp', 'x'); fs.renameSync(f + '.tmp', f);
  }
}, 5);
`;

const probe: MediaProbe = {
  container: 'matroska,webm',
  duration: 1440,
  bitrate: 0,
  video: { index: 0, codec: 'hevc', profile: null, pixFmt: 'yuv420p10le', bitDepth: 10, width: 1920, height: 1080 },
  audio: [{ index: 1, order: 0, codec: 'aac', channels: 2, language: 'jpn', title: null, isDefault: true }],
  subtitles: [],
  fonts: [],
};
const decision: Decision = { mode: 'transcode', reason: '', audio: 0, burnSubtitle: null, height: null, videoBitrate: 8e6 };
/** Waits for something that happens in the background (folder removal). */
async function eventually(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return check();
}

const session = (userId: number, startAt = 0) =>
  createSession({ userId, title: 'episode:1', file: 'C:\\lib\\ep.mkv', ffmpeg: 'ffmpeg', probe, decision, encoder: 'libx264', startAt });

beforeEach(() => {
  initDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-play-'));
  usePlaybackDataDir(tmp);
  saveSettings({ maxTranscodes: 2 });
  startPlayback();
  resetGpuFallback();
  launches = [];
  useLauncher((_file, _args, s, segment) => {
    launches.push(segment);
    return spawn(process.execPath, ['-e', FAKE, s.dir, String(segment), '360'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});
afterEach(() => {
  stopPlayback();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// These start real (stand-in) encoder processes, which can be slow while the whole suite runs at once.
describe('streaming sessions', { timeout: 20_000 }, () => {
  const fail = (msg: string) => spawn(process.execPath, ['-e', `console.error(${JSON.stringify(msg)}); process.exit(1)`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gpuSession = (userId: number, startAt: number) =>
    createSession({ userId, title: `episode:${userId}`, file: 'C:\\lib\\ep.mkv', ffmpeg: 'ffmpeg', probe, decision, encoder: 'h264_amf', startAt });

  it('switches to the CPU when the graphics card encoder fails, and keeps using it for new streams', async () => {
    const used: string[] = [];
    useLauncher((_file, args, s, segment) => {
      const enc = args[args.indexOf('-c:v') + 1];
      used.push(`${enc}@${segment}`);
      // The GPU encoder dies at once (as AMF does once Remote Desktop is closed); the CPU one works.
      if (enc !== 'libx264') return fail('Failed to initialize AMF');
      return spawn(process.execPath, ['-e', FAKE, s.dir, String(segment), '360'], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
    const s = gpuSession(1, 600);
    expect(await waitForSegment(s, 150)).toBe(path.join(s.dir, 'seg150.ts'));
    expect(used).toEqual(['h264_amf@150', 'libx264@150']);
    expect(s.encoder).toBe('libx264');
    expect(gpuFallbackActive()).toBe(true);
    // The next stream doesn't try the graphics card again for a while.
    const s2 = gpuSession(2, 0);
    expect(s2.encoder).toBe('libx264');
    await waitForSegment(s2, 0);
  }, 20_000);

  it('reports a failure that the CPU can’t get past either', async () => {
    useLauncher(() => fail('Invalid data found when processing input'));
    const s = gpuSession(1, 0);
    await expect(waitForSegment(s, 0, 5000)).rejects.toThrow(/Converting failed: Invalid data/);
  }, 20_000);

  it('serves segments as they are made, and restarts the encoder when you jump ahead', async () => {
    // A steadier stand-in (50 segments/s): the usual one is so fast that on a busy machine it could reach
    // segment 300 by itself before the jump, and then there'd rightly be nothing to restart.
    useLauncher((_file, _args, s, segment) => {
      launches.push(segment);
      return spawn(process.execPath, ['-e', FAKE.replace('i < 5 &&', 'i < 1 &&').replace('}, 5);', '}, 20);'), s.dir, String(segment), '360'], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
    const s = session(1);
    expect(fs.readFileSync(path.join(s.dir, 'main.m3u8'), 'utf8')).toContain('seg359.ts');
    expect(await waitForSegment(s, 0)).toBe(path.join(s.dir, 'seg0.ts'));
    await waitForSegment(s, 300);
    expect(launches).toEqual([0, 300]);
    await expect(waitForSegment(s, 360)).rejects.toThrow(/No such segment/);
  });

  it('lets only the newest request move the encoder, and drops abandoned ones', async () => {
    const s = session(1);
    // A drag across the bar: the player asks for 100, then (before that arrives) for 300. Asked right away,
    // before the stand-in encoder (which is very fast) could have reached either.
    let gone = false;
    const stale = waitForSegment(s, 100, 5000, () => gone);
    const latest = waitForSegment(s, 300);
    await latest;
    gone = true; // the player gave up on 100
    await expect(stale).rejects.toThrow(/stopped waiting/);
    expect(launches).toEqual([0, 100, 300]); // 100 never came back to undo the jump to 300
  });

  it('starts at the resume point', () => {
    session(1, 125);
    expect(launches).toEqual([31]); // 125 s is inside the 4-second segment 31
  });

  it('belongs to one user, who has one stream at a time', async () => {
    const a = session(1);
    expect(getSession(a.id, 2)).toBeNull();
    expect(getSession(a.id, 1)).not.toBeNull();
    const b = session(1);
    expect(getSession(a.id, 1)).toBeNull(); // replaced
    expect(await eventually(() => !fs.existsSync(a.dir))).toBe(true);
    expect(activeSessions().map((s) => s.id)).toEqual([b.id]);
  });

  it('refuses more conversions than the limit', () => {
    session(1);
    session(2);
    expect(() => session(3)).toThrow(/busy/);
  });

  it('stops running far ahead, then ends idle streams and deletes their files', async () => {
    const s = session(1);
    await waitForSegment(s, 0);
    await new Promise((r) => setTimeout(r, 900)); // the stand-in runs ahead
    sweep();
    expect(s.proc).toBeNull();
    sweep(Date.now() + 61_000);
    expect(activeSessions()).toEqual([]);
    expect(await eventually(() => !fs.existsSync(s.dir))).toBe(true);
  });
});
