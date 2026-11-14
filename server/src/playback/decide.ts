import type { Encoder } from './ffmpeg.js';
import type { MediaProbe } from './probe.js';

/** What the browser says it can play (from canPlayType / MediaSource.isTypeSupported). */
export interface ClientCaps {
  mp4: boolean;
  webm: boolean;
  h264: boolean;
  hevc: boolean;
  av1: boolean;
  vp9: boolean;
  aac: boolean;
  mp3: boolean;
  opus: boolean;
  flac: boolean;
  ac3: boolean;
  eac3: boolean;
}

export type Quality = 'auto' | 'original' | '1080' | '720' | '480';
export const QUALITIES: Quality[] = ['auto', 'original', '1080', '720', '480'];

export interface PlayChoice {
  /** Audio track (order among audio tracks); null = the file's default. */
  audio: number | null;
  /** Subtitle track (order among subtitle tracks); null = off. */
  subtitle: number | null;
  quality: Quality;
}

export interface Decision {
  mode: 'direct' | 'transcode';
  /** Why, in plain words (shown in the player's info). */
  reason: string;
  audio: number | null;
  /** Image subtitle burned into the picture. */
  burnSubtitle: number | null;
  /** Output height; null keeps the source size. */
  height: number | null;
  /** Video bitrate in bits/s for transcodes. */
  videoBitrate: number;
  /**
   * The video is H.264 the browser can play, only its container (or audio) isn't: it's copied into the
   * stream pieces as it is (no conversion, original picture, almost no CPU) and only the audio is converted.
   */
  copyVideo?: boolean;
}

const MBPS = 1_000_000;
const QUALITY_STEPS: { height: number; bitrate: number }[] = [
  { height: 1080, bitrate: 8 * MBPS },
  { height: 720, bitrate: 4 * MBPS },
  { height: 480, bitrate: 1.5 * MBPS },
];

/** Bitrate for the source's own size when nothing caps it ("Original"). */
const originalBitrate = (height: number) => (height > 1440 ? 40 : height > 1080 ? 25 : height > 720 ? 15 : 8) * MBPS;

const VIDEO_OK: Record<string, (c: ClientCaps, bitDepth: number) => boolean> = {
  h264: (c, depth) => c.h264 && depth <= 8,
  hevc: (c) => c.hevc,
  av1: (c) => c.av1,
  vp9: (c) => c.vp9,
};
const AUDIO_OK: Record<string, keyof ClientCaps> = { aac: 'aac', mp3: 'mp3', opus: 'opus', flac: 'flac', ac3: 'ac3', eac3: 'eac3' };

export function defaultAudio(probe: MediaProbe): number | null {
  if (!probe.audio.length) return null;
  return (probe.audio.find((a) => a.isDefault) ?? probe.audio[0]).order;
}

/**
 * Direct play when the browser can take the file as it is (and it fits the bitrate), otherwise transcode
 * to H.264/AAC HLS at the chosen quality. `remoteMaxBitrate` (bits/s) applies to viewers away from home.
 */
export function decidePlayback(
  probe: MediaProbe,
  ext: string,
  caps: ClientCaps,
  choice: PlayChoice,
  remote: boolean,
  remoteMaxBitrate: number,
): Decision {
  const audio = choice.audio ?? defaultAudio(probe);
  const sub = choice.subtitle === null ? null : (probe.subtitles.find((s) => s.order === choice.subtitle) ?? null);
  const burnSubtitle = sub && !sub.text ? sub.order : null;
  const srcHeight = probe.video?.height || 1080;
  const capped = choice.quality === 'auto' && remote;

  // Target size and bitrate for a transcode.
  let height: number | null = null;
  let videoBitrate = originalBitrate(srcHeight);
  if (choice.quality === '1080' || choice.quality === '720' || choice.quality === '480') {
    const step = QUALITY_STEPS.find((q) => String(q.height) === choice.quality)!;
    height = step.height < srcHeight ? step.height : null;
    videoBitrate = step.bitrate;
  } else if (capped) {
    const step = QUALITY_STEPS.find((q) => q.bitrate <= remoteMaxBitrate) ?? QUALITY_STEPS[QUALITY_STEPS.length - 1];
    height = step.height < srcHeight ? step.height : null;
    videoBitrate = Math.min(remoteMaxBitrate, step.bitrate);
  }

  // Never spend more than the source has: converting a 6 Mbps file at 15 Mbps only makes pieces bigger and seeks slower.
  if (probe.bitrate > 0) videoBitrate = Math.min(videoBitrate, Math.max(1.5 * MBPS, probe.bitrate * 1.1));

  const transcode = (reason: string): Decision => ({ mode: 'transcode', reason, audio, burnSubtitle, height, videoBitrate });

  if (!probe.video) return transcode('No video track found');
  const videoOk = !!VIDEO_OK[probe.video.codec]?.(caps, probe.video.bitDepth);
  // H.264 (8-bit) the browser plays can go into the stream as it is when nothing else needs the picture
  // changed: no picture subtitles to draw in, no smaller size chosen or needed for the connection.
  const canCopy =
    videoOk &&
    probe.video.codec === 'h264' &&
    burnSubtitle === null &&
    (choice.quality === 'auto' || choice.quality === 'original') &&
    !(capped && probe.bitrate > remoteMaxBitrate);
  const convert = (reason: string): Decision =>
    canCopy ? { mode: 'transcode', reason: `${reason}: repackaged for the browser (the picture isn’t converted)`, audio, burnSubtitle: null, height: null, videoBitrate, copyVideo: true } : transcode(reason);

  const container = ext.toLowerCase();
  const containerOk = ((container === '.mp4' || container === '.m4v') && caps.mp4) || (container === '.webm' && caps.webm);
  if (!videoOk) {
    return transcode(`The browser can’t play ${probe.video.codec.toUpperCase()}${probe.video.bitDepth > 8 ? ` ${probe.video.bitDepth}-bit` : ''} video`);
  }
  if (!containerOk) return convert(`The browser can’t play ${container.replace('.', '').toUpperCase() || 'this'} files directly`);
  if (audio !== null) {
    const track = probe.audio.find((a) => a.order === audio)!;
    if (audio !== defaultAudio(probe)) return convert('Switching audio tracks needs a conversion');
    const cap = AUDIO_OK[track.codec];
    if (!cap || !caps[cap]) return convert(`The browser can’t play ${track.codec.toUpperCase()} audio`);
  }
  if (burnSubtitle !== null) return transcode('Picture-based subtitles are drawn into the video');
  if (choice.quality !== 'auto' && choice.quality !== 'original') return transcode(`${choice.quality}p chosen`);
  if (capped && probe.bitrate > remoteMaxBitrate) return transcode('Lowered to fit your connection');
  return { mode: 'direct', reason: 'Playing the original file', audio, burnSubtitle: null, height: null, videoBitrate: 0 };
}

// ---- HLS ----

export const SEGMENT_SECONDS = 4;

export function segmentCount(duration: number): number {
  return Math.max(1, Math.ceil(duration / SEGMENT_SECONDS - 1e-6));
}

/**
 * Where each piece starts (seconds). Converted video gets even 4 s pieces (keyframes are forced there).
 * Copied video can only be cut at its own keyframes: each piece runs to the first keyframe at least
 * 4 s after its start.
 */
export function segmentStarts(duration: number, keys?: number[] | null): number[] {
  if (!keys?.length) return Array.from({ length: segmentCount(duration) }, (_, i) => i * SEGMENT_SECONDS);
  const starts = [0];
  for (const k of keys) if (k < duration - 0.5 && k - starts[starts.length - 1] >= SEGMENT_SECONDS - 0.05) starts.push(k);
  return starts;
}

/** A complete VOD playlist written up front, so the player knows the whole timeline before anything is encoded. */
export function hlsPlaylist(duration: number, starts: number[] = segmentStarts(duration)): string {
  const lens = starts.map((t, i) => Math.max(0.1, (starts[i + 1] ?? duration) - t));
  const target = Math.max(SEGMENT_SECONDS, Math.ceil(Math.max(...lens)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  lens.forEach((len, i) => lines.push(`#EXTINF:${len.toFixed(3)},`, `seg${i}.ts`));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** The file FFmpeg adds each finished piece's name to, when copying (pieces are written in place). */
export const COPY_LIST = 'done.txt';

/**
 * FFmpeg arguments that copy the video (cut at the planned keyframes) and convert only the audio,
 * writing seg<N>.ts from piece `startSegment` on. Timestamps stay the file's own, so every piece sits
 * exactly where the playlist says.
 */
export function copyArgs(file: string, probe: MediaProbe, d: Decision, dir: string, starts: number[], startSegment: number): string[] {
  const start = starts[startSegment];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  // Just past the keyframe: FFmpeg copies from the keyframe at or before this time.
  if (start > 0) args.push('-ss', (start + 0.01).toFixed(3));
  args.push('-copyts', '-i', file, '-map', `0:${probe.video!.index}`);
  if (d.audio !== null) args.push('-map', `0:a:${d.audio}`);
  args.push('-c:v', 'copy');
  if (d.audio !== null) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  // Cut points, counted from where this run starts.
  const cuts = starts.slice(startSegment + 1).map((t) => (t - start).toFixed(3));
  args.push(
    '-sn', '-dn',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-avoid_negative_ts', 'disabled',
    '-f', 'segment',
    '-segment_format', 'mpegts',
    ...(cuts.length ? ['-segment_times', cuts.join(',')] : []),
    '-segment_start_number', String(startSegment),
    '-segment_list', `${dir}/${COPY_LIST}`,
    '-segment_list_type', 'flat',
    '-reset_timestamps', '0',
    '-muxdelay', '0',
    '-muxpreload', '0',
    `${dir}/seg%d.ts`,
  );
  return args;
}

const encoderArgs = (encoder: Encoder): string[] => {
  switch (encoder) {
    case 'h264_amf':
      // forced_idr: without it AMF ignores the forced keyframes and cuts ~10 s pieces, which breaks the playlist's timeline.
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak', '-forced_idr', '1'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'film'];
  }
};

/**
 * FFmpeg arguments that write HLS segments `seg<N>.ts` into `dir`, starting at segment `startSegment`.
 * Keyframes are forced on segment boundaries, so a restart at any segment lines up with the playlist.
 */
export function hlsArgs(file: string, probe: MediaProbe, d: Decision, encoder: Encoder, dir: string, startSegment: number): string[] {
  const start = startSegment * SEGMENT_SECONDS;
  const v = probe.video!;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  // Decode on the GPU when possible; FFmpeg falls back to the CPU by itself.
  if (encoder !== 'libx264') args.push('-hwaccel', 'auto');
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file);

  const filters: string[] = [];
  if (d.height) filters.push(`scale=-2:${d.height}`);
  filters.push('format=yuv420p');
  if (d.burnSubtitle !== null) {
    args.push('-filter_complex', `[0:${v.index}][0:s:${d.burnSubtitle}]overlay,${filters.join(',')}[v]`, '-map', '[v]');
  } else {
    args.push('-map', `0:${v.index}`, '-vf', filters.join(','));
  }
  if (d.audio !== null) args.push('-map', `0:a:${d.audio}`);

  const rate = Math.round(d.videoBitrate);
  args.push(
    ...encoderArgs(encoder),
    '-b:v', String(rate),
    '-maxrate', String(rate),
    '-bufsize', String(rate * 2),
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
  );
  if (d.audio !== null) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push(
    '-sn', '-dn',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    // MPEG-TS adds a 1.4 s start delay by default, which would shift every segment off the playlist.
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-hls_flags', 'temp_file',
    '-start_number', String(startSegment),
    '-output_ts_offset', String(start),
    '-hls_segment_filename', `${dir}/seg%d.ts`,
    `${dir}/ffmpeg.m3u8`,
  );
  return args;
}
