import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from '../settings.js';
import { hlsArgs, hlsPlaylist, SEGMENT_SECONDS, segmentCount, type Decision } from './decide.js';
import { cacheDir, start, type Encoder } from './ffmpeg.js';
import type { MediaProbe } from './probe.js';

export interface Session {
  id: string;
  userId: number;
  /** "movie:12" / "episode:345", so a user's earlier stream of the same thing can be replaced. */
  title: string;
  file: string;
  probe: MediaProbe;
  decision: Decision;
  encoder: Encoder;
  /** The ffmpeg executable. */
  encoderPath: string;
  dir: string;
  proc: ChildProcess | null;
  /** First segment of the current FFmpeg run, and the next one it hasn't finished yet. */
  runStart: number;
  next: number;
  lastRequested: number;
  /** Counts segment requests; only the newest may move FFmpeg (older ones were overtaken by a seek). */
  requestSeq: number;
  lastAccess: number;
  error: string | null;
}

const sessions = new Map<string, Session>();
/** Restart FFmpeg rather than wait when a request is further ahead than this. */
const AHEAD_WAIT = Math.ceil(30 / SEGMENT_SECONDS);
/** Stop encoding once this far ahead of the player (resumes when it catches up). */
const AHEAD_STOP = Math.ceil(300 / SEGMENT_SECONDS);
/** Old segments behind the player are deleted to save disk. */
const KEEP_BEHIND = Math.ceil(240 / SEGMENT_SECONDS);
const IDLE_MS = 60_000;

/** Starts the encoder process; tests swap in a stand-in that writes segments like FFmpeg does. */
let launcher: (file: string, args: string[], s: Session, segment: number) => ChildProcess = (file, args) => start(file, args);
export const useLauncher = (fn: typeof launcher) => (launcher = fn);

/**
 * When a graphics-card encoder last failed. For a while after, new streams use the CPU straight away.
 * Typical cause: a Windows server whose Remote Desktop window was closed, which takes the GPU away from the session.
 */
let gpuFailedAt = 0;
const GPU_RETRY_MS = 10 * 60_000;
export const resetGpuFallback = () => (gpuFailedAt = 0);
/** True while transcodes are on the CPU because the graphics card stopped working. */
export const gpuFallbackActive = () => gpuFailedAt > 0 && Date.now() - gpuFailedAt < GPU_RETRY_MS;
const usable = (e: Encoder): Encoder => (e !== 'libx264' && gpuFallbackActive() ? 'libx264' : e);

const segPath = (s: Session, n: number) => path.join(s.dir, `seg${n}.ts`);
const running = () => [...sessions.values()].filter((s) => s.proc).length;

function stopProc(s: Session) {
  if (s.proc) {
    s.proc.removeAllListeners('close');
    s.proc.kill('SIGKILL');
    s.proc = null;
  }
}

function launch(s: Session, segment: number) {
  stopProc(s);
  s.runStart = segment;
  s.next = segment;
  s.error = null;
  const proc = launcher(s.encoderPath, hlsArgs(s.file, s.probe, s.decision, s.encoder, s.dir, segment), s, segment);
  let stderr = '';
  proc.stderr!.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  proc.on('close', (code) => {
    if (s.proc !== proc) return;
    s.proc = null;
    if (code === 0) return;
    const reason = stderr.trim().split('\n').pop() || `FFmpeg stopped (code ${code})`;
    if (s.encoder !== 'libx264') {
      // The graphics card failed: carry on from where it stopped, on the CPU.
      gpuFailedAt = Date.now();
      console.warn(`[playback] ${s.encoder} failed (${reason}); converting on the CPU instead`);
      s.encoder = 'libx264';
      advance(s);
      launch(s, Math.min(s.next, segmentCount(s.probe.duration) - 1));
      return;
    }
    s.error = reason;
  });
  proc.on('error', (err) => {
    if (s.proc === proc) {
      s.proc = null;
      s.error = err.message;
    }
  });
  s.proc = proc;
}

/** Moves `next` past every segment that's finished (FFmpeg renames each one into place when it's complete). */
function advance(s: Session) {
  const total = segmentCount(s.probe.duration);
  while (s.next < total && fs.existsSync(segPath(s, s.next))) s.next++;
}

export interface NewSession {
  userId: number;
  title: string;
  file: string;
  ffmpeg: string;
  probe: MediaProbe;
  decision: Decision;
  encoder: Encoder;
  startAt: number;
}

/** Starts a transcode for one viewer. Their earlier streams end (one stream per user at a time). */
export function createSession(n: NewSession): Session {
  for (const s of sessions.values()) if (s.userId === n.userId) endSession(s.id);
  if (running() >= Math.max(1, getSettings().maxTranscodes)) {
    throw Object.assign(new Error('The server is busy converting other videos right now. Try again in a little while.'), { statusCode: 503 });
  }
  const id = crypto.randomBytes(16).toString('hex');
  const dir = cacheDir('transcode', id);
  fs.writeFileSync(path.join(dir, 'main.m3u8'), hlsPlaylist(n.probe.duration));
  const first = Math.min(Math.floor(Math.max(0, n.startAt) / SEGMENT_SECONDS), segmentCount(n.probe.duration) - 1);
  const s: Session = {
    id,
    userId: n.userId,
    title: n.title,
    file: n.file,
    probe: n.probe,
    decision: n.decision,
    encoder: usable(n.encoder),
    encoderPath: n.ffmpeg,
    dir,
    proc: null,
    runStart: first,
    next: first,
    lastRequested: first,
    requestSeq: 0,
    lastAccess: Date.now(),
    error: null,
  };
  sessions.set(id, s);
  launch(s, first);
  return s;
}

/** A session, only for the user who owns it. */
export function getSession(id: string, userId: number): Session | null {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return null;
  s.lastAccess = Date.now();
  return s;
}

export function playlistPath(s: Session) {
  return path.join(s.dir, 'main.m3u8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Path of segment `n` once it exists, restarting FFmpeg there if it's not on its way.
 * `gone()` says the player stopped waiting (it seeked elsewhere or closed); such requests never move FFmpeg.
 */
export async function waitForSegment(s: Session, n: number, timeoutMs = 45_000, gone: () => boolean = () => false): Promise<string> {
  const total = segmentCount(s.probe.duration);
  if (!Number.isInteger(n) || n < 0 || n >= total) throw Object.assign(new Error('No such segment'), { statusCode: 404 });
  s.lastRequested = n;
  const seq = ++s.requestSeq;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(segPath(s, n))) {
      advance(s);
      return segPath(s, n);
    }
    if (gone()) throw Object.assign(new Error('The player stopped waiting'), { statusCode: 499 });
    advance(s);
    const onTheWay = s.proc && n >= s.runStart && n <= s.next + AHEAD_WAIT;
    // A newer request (after a seek) decides where FFmpeg runs; this one just waits for its piece.
    if (!onTheWay && seq === s.requestSeq) {
      if (!s.proc && s.error && n >= s.runStart && n <= s.next) {
        throw Object.assign(new Error(`Converting failed: ${s.error}`), { statusCode: 500 });
      }
      if (!s.proc && running() >= Math.max(1, getSettings().maxTranscodes)) {
        throw Object.assign(new Error('The server is busy converting other videos right now.'), { statusCode: 503 });
      }
      launch(s, n);
    }
    if (Date.now() > deadline) throw Object.assign(new Error('Converting is taking too long'), { statusCode: 504 });
    s.lastAccess = Date.now();
    await sleep(150);
  }
}

export function endSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  stopProc(s);
  // Retries: Windows can hold a just-killed FFmpeg's files for a moment.
  fs.rm(s.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }, () => {});
}

export function endUserSessions(userId: number) {
  for (const s of [...sessions.values()]) if (s.userId === userId) endSession(s.id);
}

/** Housekeeping: ends idle sessions, pauses runs far ahead of the player, deletes segments long behind it. */
export function sweep(now = Date.now()) {
  for (const s of [...sessions.values()]) {
    if (now - s.lastAccess > IDLE_MS) {
      endSession(s.id);
      continue;
    }
    advance(s);
    if (s.proc && s.next - s.lastRequested > AHEAD_STOP) stopProc(s);
    for (let n = s.lastRequested - KEEP_BEHIND; n >= 0 && fs.existsSync(segPath(s, n)); n--) fs.rmSync(segPath(s, n), { force: true });
  }
}

let timer: NodeJS.Timeout | null = null;

/** Clears transcodes left over from a previous run and starts the housekeeping timer. */
export function startPlayback() {
  fs.rmSync(cacheDir('transcode'), { recursive: true, force: true });
  if (!timer) timer = setInterval(sweep, 10_000).unref();
}

export function stopPlayback() {
  for (const id of [...sessions.keys()]) endSession(id);
  if (timer) clearInterval(timer);
  timer = null;
}

export const activeSessions = () => [...sessions.values()];
