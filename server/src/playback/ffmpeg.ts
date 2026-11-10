import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from '../settings.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

/** Folders to look in: the Settings path, PATH, and where `winget install Gyan.FFmpeg` puts its links. */
function candidateDirs(override?: string): string[] {
  const s = (override ?? getSettings().ffmpegPath).trim();
  const dirs: string[] = [];
  if (s) dirs.push(fs.existsSync(s) && fs.statSync(s).isFile() ? path.dirname(s) : s);
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) if (d) dirs.push(d);
  // A program started before FFmpeg was installed still has the old PATH, so look where installers put it too.
  if (process.platform === 'win32') dirs.push(...windowsInstallDirs());
  return dirs;
}

/** `<dir>/<entry>/bin` for every entry of `dir` whose name matches. */
function binsUnder(dir: string, match: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && match.test(e.name))
      .map((e) => path.join(dir, e.name, 'bin'));
  } catch {
    return [];
  }
}

function windowsInstallDirs(): string[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const out = [path.join(local, 'Microsoft', 'WinGet', 'Links')];
  // winget: Packages\Gyan.FFmpeg_…\ffmpeg-<version>-full_build\bin (and the BtbN/other FFmpeg packages).
  for (const pkg of binsUnder(path.join(local, 'Microsoft', 'WinGet', 'Packages'), /ffmpeg/i)) out.push(...binsUnder(path.dirname(pkg), /^ffmpeg/i));
  out.push('C:\\ffmpeg\\bin', path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin'));
  out.push(path.join(process.env.USERPROFILE ?? '', 'scoop', 'shims'), 'C:\\ProgramData\\chocolatey\\bin');
  return out;
}

/**
 * ffmpeg and ffprobe from the same folder, or null. Only files named ffmpeg/ffprobe are ever run,
 * so the Settings path can't point Mediarr at some other program.
 */
export function findFfmpeg(override?: string): FfmpegTools | null {
  for (const dir of candidateDirs(override)) {
    const ffmpeg = path.join(dir, `ffmpeg${EXE}`);
    const ffprobe = path.join(dir, `ffprobe${EXE}`);
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) return { ffmpeg, ffprobe };
  }
  return null;
}

export function requireFfmpeg(override?: string): FfmpegTools {
  const tools = findFfmpeg(override);
  if (!tools) {
    throw Object.assign(new Error('FFmpeg isn’t installed. Install it with “winget install Gyan.FFmpeg”, or set its folder in Settings → Playback.'), {
      statusCode: 503,
    });
  }
  return tools;
}

/** Starts a tool with an argument list (never a shell). */
export function start(file: string, args: string[], opts: { cwd?: string } = {}): ChildProcess {
  return spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
}

/** Runs a tool to completion and returns its output. */
export function run(file: string, args: string[], timeoutMs = 60_000, opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = start(file, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Runs a tool and returns its raw stdout (for binary output). */
export function runBinary(file: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = start(file, args);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => chunks.push(d));
    child.stderr!.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

export type Encoder = 'h264_amf' | 'h264_nvenc' | 'h264_qsv' | 'libx264';
const HW: Record<Exclude<ReturnType<typeof getSettings>['hwAccel'], 'auto' | 'none'>, Encoder> = {
  amf: 'h264_amf',
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
};

export interface FfmpegInfo {
  ffmpeg: string;
  version: string;
  /** Hardware encoders that really work on this machine (a test encode succeeded). */
  hardware: Encoder[];
  /** The encoder transcodes will use. */
  encoder: Encoder;
}

let cached: { key: string; info: FfmpegInfo } | null = null;

/** Tries a 1-frame encode: an encoder can be compiled in but have no GPU behind it. */
async function encoderWorks(ffmpeg: string, encoder: Encoder): Promise<boolean> {
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'], 20_000).catch(
    () => null,
  );
  return r?.code === 0;
}

/** FFmpeg's version and the encoder to use; cached until the settings or the FFmpeg location change. */
export async function ffmpegInfo(opts: { force?: boolean; path?: string; hwAccel?: string } = {}): Promise<FfmpegInfo> {
  const force = opts.force ?? false;
  const tools = requireFfmpeg(opts.path);
  const pref = (opts.hwAccel ?? getSettings().hwAccel) as ReturnType<typeof getSettings>['hwAccel'];
  const key = `${tools.ffmpeg}|${pref}`;
  if (!force && cached?.key === key) return cached.info;
  const v = await run(tools.ffmpeg, ['-hide_banner', '-version'], 15_000);
  const version = v.stdout.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
  const hardware: Encoder[] = [];
  for (const enc of ['h264_amf', 'h264_nvenc', 'h264_qsv'] as const) if (await encoderWorks(tools.ffmpeg, enc)) hardware.push(enc);
  const encoder: Encoder = pref === 'none' ? 'libx264' : pref === 'auto' ? (hardware[0] ?? 'libx264') : hardware.includes(HW[pref]) ? HW[pref] : 'libx264';
  cached = { key, info: { ffmpeg: tools.ffmpeg, version, hardware, encoder } };
  return cached.info;
}

let dataDir = process.env.MEDIARR_DATA ?? path.resolve(import.meta.dirname, '../../../data');
export const usePlaybackDataDir = (dir: string) => (dataDir = dir);

/** Where Mediarr keeps transcodes and extracted subtitles/fonts (inside its data folder). */
export function cacheDir(...parts: string[]): string {
  const dir = path.join(dataDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
