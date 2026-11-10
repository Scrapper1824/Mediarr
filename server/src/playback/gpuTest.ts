import { getSettings } from '../settings.js';
import { ffmpegInfo, requireFfmpeg, run, type Encoder } from './ffmpeg.js';
import { gpuFallbackActive, resetGpuFallback } from './sessions.js';

/**
 * "Test graphics card": tries a real GPU encode right now and says which Windows session Mediarr runs in.
 * Made for servers: run `tscon %sessionname% /dest:console`, then press Test from another device to see
 * whether the graphics card still works with Remote Desktop closed.
 */

export interface WindowsSession {
  /** "console", "rdp-tcp#0", or "" for a disconnected Remote Desktop session. */
  name: string;
  id: number;
  /** As Windows reports it: Active, Disc (disconnected), … */
  state: string;
}

export interface GpuTestResult {
  testedAt: string;
  session: WindowsSession | null;
  encoders: { encoder: Encoder; label: string; works: boolean; error: string | null }[];
  /** What videos convert with from now on. */
  using: Encoder;
  usingLabel: string;
  /** Videos were on the CPU because the graphics card had failed. Cleared when the test passes. */
  wasFallingBack: boolean;
  verdict: 'gpu' | 'cpu-only' | 'gpu-off';
  advice: string;
}

export const ENCODER_LABELS: Record<Encoder, string> = {
  h264_amf: 'AMD (AMF)',
  h264_nvenc: 'NVIDIA (NVENC)',
  h264_qsv: 'Intel (Quick Sync)',
  libx264: 'CPU (x264)',
};

/** The current session from `query session` output (the line marked with ">"). */
export function parseQuerySession(out: string): WindowsSession | null {
  const line = out.split(/\r?\n/).find((l) => l.startsWith('>'));
  if (!line) return null;
  const tokens = line.slice(1).trim().split(/\s+/);
  const idAt = tokens.findIndex((t) => /^\d+$/.test(t));
  if (idAt < 0) return null;
  // Columns: SESSIONNAME USERNAME ID STATE. A disconnected session has no name, so only USERNAME comes before ID.
  return { name: idAt >= 2 ? tokens[0] : '', id: Number(tokens[idAt]), state: tokens[idAt + 1] ?? '' };
}

async function windowsSession(): Promise<WindowsSession | null> {
  if (process.platform !== 'win32') return null;
  const r = await run('query', ['session'], 10_000).catch(() => null);
  return r ? parseQuerySession(r.stdout) : null;
}

/** One-frame encode with `encoder`; the error line when it fails. */
async function tryEncoder(ffmpeg: string, encoder: Encoder): Promise<string | null> {
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'], 20_000).catch(
    (e: Error) => ({ code: -1, stdout: '', stderr: e.message }),
  );
  if (r.code === 0) return null;
  const lines = r.stderr.trim().split(/\r?\n/).filter(Boolean);
  // The most telling line: one that names the GPU library, else the last.
  return (lines.find((l) => /amf|nvenc|cuda|qsv|mfx|d3d|device|driver/i.test(l)) ?? lines.at(-1) ?? `FFmpeg stopped (code ${r.code})`).trim().slice(0, 300);
}

export async function testGpu(): Promise<GpuTestResult> {
  const settings = getSettings();
  const tools = requireFfmpeg(settings.ffmpegPath);
  const wasFallingBack = gpuFallbackActive();
  const session = await windowsSession();
  const encoders: GpuTestResult['encoders'] = [];
  for (const encoder of ['h264_amf', 'h264_nvenc', 'h264_qsv'] as const) {
    const error = await tryEncoder(tools.ffmpeg, encoder);
    encoders.push({ encoder, label: ENCODER_LABELS[encoder], works: !error, error });
  }
  // Fresh detection, so playback uses what works right now.
  const info = await ffmpegInfo({ force: true, path: settings.ffmpegPath, hwAccel: settings.hwAccel });
  const anyGpu = encoders.some((e) => e.works);
  if (anyGpu) resetGpuFallback();
  const disconnected = !!session && /^disc/i.test(session.state);
  const verdict: GpuTestResult['verdict'] = info.encoder !== 'libx264' ? 'gpu' : anyGpu ? 'gpu-off' : 'cpu-only';
  const where = session ? (session.name ? `the “${session.name}” session (${session.state})` : `a disconnected Remote Desktop session`) : null;
  const advice =
    verdict === 'gpu'
      ? `The graphics card works${where ? ` in ${where}` : ''}. Videos convert with ${ENCODER_LABELS[info.encoder]}.`
      : verdict === 'gpu-off'
        ? `The graphics card works, but Settings → Playback → “Convert with” is set to the CPU.`
        : disconnected
          ? 'The graphics card can’t be used: Mediarr is in a disconnected Remote Desktop session. Next time, instead of closing Remote Desktop, run “tscon %sessionname% /dest:console” as administrator, then test again from another device.'
          : session && /^rdp/i.test(session.name)
            ? 'The graphics card can’t be used from this Remote Desktop session. Videos convert on the CPU (slower).'
            : 'No graphics card encoder works right now, so videos convert on the CPU (slower). If no monitor is plugged in, a virtual display driver or an HDMI dummy plug may help.';
  return {
    testedAt: new Date().toISOString(),
    session,
    encoders,
    using: info.encoder,
    usingLabel: ENCODER_LABELS[info.encoder],
    wasFallingBack,
    verdict,
    advice,
  };
}
