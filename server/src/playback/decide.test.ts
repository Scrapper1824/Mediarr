import { describe, expect, it } from 'vitest';
import { decidePlayback, hlsArgs, hlsPlaylist, segmentCount, SEGMENT_SECONDS, type ClientCaps, type PlayChoice } from './decide.js';
import { parseProbe, type MediaProbe } from './probe.js';

const chrome: ClientCaps = { mp4: true, webm: true, h264: true, hevc: false, av1: true, vp9: true, aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false };
const MBPS = 1_000_000;

function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 1440,
    bitrate: 5 * MBPS,
    video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, width: 1920, height: 1080 },
    audio: [
      { index: 1, order: 0, codec: 'aac', channels: 2, language: 'jpn', title: null, isDefault: true },
      { index: 2, order: 1, codec: 'aac', channels: 2, language: 'eng', title: null, isDefault: false },
    ],
    subtitles: [
      { index: 3, order: 0, codec: 'ass', language: 'eng', title: 'Full', isDefault: true, forced: false, text: true },
      { index: 4, order: 1, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'PGS', isDefault: false, forced: false, text: false },
    ],
    fonts: [],
    ...over,
  };
}
const auto: PlayChoice = { audio: null, subtitle: null, quality: 'auto' };

describe('direct play or convert', () => {
  it('plays an MP4 with H.264/AAC as it is', () => {
    expect(decidePlayback(probe(), '.mp4', chrome, auto, false, 8 * MBPS).mode).toBe('direct');
    // Styled text subtitles are drawn by the browser, so they don't force a conversion.
    expect(decidePlayback(probe(), '.mp4', chrome, { ...auto, subtitle: 0 }, false, 8 * MBPS).mode).toBe('direct');
  });

  it('converts MKV and 10-bit HEVC', () => {
    const mkv = decidePlayback(probe(), '.mkv', chrome, auto, false, 8 * MBPS);
    expect(mkv).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/MKV/) });
    const hevc = probe({ video: { index: 0, codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', bitDepth: 10, width: 1920, height: 1080 } });
    expect(decidePlayback(hevc, '.mp4', chrome, auto, false, 8 * MBPS).reason).toMatch(/HEVC 10-bit/);
    // A browser that can play HEVC gets it directly.
    expect(decidePlayback(hevc, '.mp4', { ...chrome, hevc: true }, auto, false, 8 * MBPS).mode).toBe('direct');
  });

  it('converts to switch audio track or draw picture subtitles', () => {
    expect(decidePlayback(probe(), '.mp4', chrome, { ...auto, audio: 1 }, false, 8 * MBPS)).toMatchObject({ mode: 'transcode', audio: 1 });
    expect(decidePlayback(probe(), '.mp4', chrome, { ...auto, subtitle: 1 }, false, 8 * MBPS)).toMatchObject({ mode: 'transcode', burnSubtitle: 1 });
  });

  it('fits remote viewers under the bitrate limit, but not people at home', () => {
    const big = probe({ bitrate: 20 * MBPS });
    expect(decidePlayback(big, '.mp4', chrome, auto, false, 8 * MBPS).mode).toBe('direct');
    const remote = decidePlayback(big, '.mp4', chrome, auto, true, 8 * MBPS);
    expect(remote).toMatchObject({ mode: 'transcode', height: null, videoBitrate: 8 * MBPS });
    expect(decidePlayback(big, '.mkv', chrome, auto, true, 3 * MBPS)).toMatchObject({ height: 480, videoBitrate: 1.5 * MBPS });
  });

  it('never converts at a higher bitrate than the file has', () => {
    const lean = probe({ bitrate: 6 * MBPS });
    expect(decidePlayback(lean, '.mkv', chrome, auto, false, 8 * MBPS).videoBitrate).toBeCloseTo(6.6 * MBPS);
    expect(decidePlayback(lean, '.mkv', chrome, { ...auto, quality: '720' }, false, 8 * MBPS).videoBitrate).toBe(4 * MBPS);
    expect(decidePlayback(probe({ bitrate: 500_000 }), '.mkv', chrome, auto, false, 8 * MBPS).videoBitrate).toBe(1.5 * MBPS); // a floor for tiny files
  });

  it('honours a chosen quality and never upscales', () => {
    expect(decidePlayback(probe(), '.mp4', chrome, { ...auto, quality: '720' }, false, 8 * MBPS)).toMatchObject({ mode: 'transcode', height: 720, videoBitrate: 4 * MBPS });
    const small = probe({ video: { index: 0, codec: 'h264', profile: null, pixFmt: 'yuv420p', bitDepth: 8, width: 1280, height: 720 } });
    expect(decidePlayback(small, '.mkv', chrome, { ...auto, quality: '1080' }, false, 8 * MBPS).height).toBeNull();
  });
});

describe('HLS', () => {
  it('lists the whole timeline up front', () => {
    const pl = hlsPlaylist(10);
    expect(segmentCount(10)).toBe(3);
    expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(pl.match(/#EXTINF:([\d.]+)/g)).toEqual([`#EXTINF:${SEGMENT_SECONDS}.000`, `#EXTINF:${SEGMENT_SECONDS}.000`, '#EXTINF:2.000']);
    expect(pl.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('restarts FFmpeg exactly on a segment boundary', () => {
    const d = decidePlayback(probe(), '.mkv', chrome, { ...auto, audio: 1, quality: '720' }, false, 8 * MBPS);
    const args = hlsArgs('D:\\Anime\\Show\\ep.mkv', probe(), d, 'h264_amf', 'C:\\t\\abc', 25);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('-ss')).toBe(String(25 * SEGMENT_SECONDS));
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i')); // fast input seeking
    expect(at('-start_number')).toBe('25');
    expect(at('-output_ts_offset')).toBe(String(25 * SEGMENT_SECONDS));
    expect(at('-force_key_frames')).toBe(`expr:gte(t,n_forced*${SEGMENT_SECONDS})`);
    expect(at('-c:v')).toBe('h264_amf');
    expect(at('-forced_idr')).toBe('1'); // AMD only honours the forced keyframes with this
    expect(at('-muxdelay')).toBe('0'); // no 1.4 s shift at the start of each piece
    expect(at('-vf')).toBe('scale=-2:720,format=yuv420p');
    expect(args).toContain('0:a:1');
    expect(at('-hwaccel')).toBe('auto');
  });

  it('burns picture subtitles in with an overlay, and uses the CPU encoder without GPU decoding', () => {
    const d = decidePlayback(probe(), '.mkv', chrome, { ...auto, subtitle: 1 }, false, 8 * MBPS);
    const args = hlsArgs('ep.mkv', probe(), d, 'libx264', 'dir', 0);
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:0][0:s:1]overlay,format=yuv420p[v]');
    expect(args).not.toContain('-hwaccel');
    expect(args).not.toContain('-ss');
  });
});

describe('reading ffprobe output', () => {
  it('finds tracks, 10-bit video and embedded fonts', () => {
    const p = parseProbe({
      format: { format_name: 'matroska,webm', duration: '1420.5', bit_rate: '4000000' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', width: 1920, height: 1080 },
        { index: 1, codec_type: 'audio', codec_name: 'opus', channels: 2, tags: { language: 'jpn' }, disposition: { default: 1 } },
        { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'English Dub' }, disposition: { default: 0 } },
        { index: 3, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'eng', title: 'Signs & Songs' }, disposition: { forced: 1 } },
        { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
        { index: 5, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'Gandhi Sans.ttf', mimetype: 'font/ttf' } },
        { index: 6, codec_type: 'attachment', tags: { filename: 'cover.jpg' } },
      ],
    });
    expect(p).toMatchObject({ container: 'matroska,webm', duration: 1420.5, bitrate: 4_000_000 });
    expect(p.video).toMatchObject({ codec: 'hevc', bitDepth: 10 });
    expect(p.audio.map((a) => [a.order, a.language, a.isDefault])).toEqual([
      [0, 'jpn', true],
      [1, 'eng', false],
    ]);
    expect(p.subtitles.map((s) => [s.order, s.text, s.forced])).toEqual([
      [0, true, true],
      [1, false, false],
    ]);
    expect(p.fonts).toEqual([{ index: 5, filename: 'Gandhi Sans.ttf' }]);
  });
});
