/** What this browser can play natively, so the server can decide between direct play and converting. */
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

export function detectCaps(): ClientCaps {
  const v = document.createElement('video');
  const can = (type: string) => {
    const mse = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
    return mse || v.canPlayType(type) === 'probably';
  };
  return {
    mp4: v.canPlayType('video/mp4') !== '',
    webm: v.canPlayType('video/webm') !== '',
    h264: can('video/mp4; codecs="avc1.640028"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    vp9: can('video/webm; codecs="vp9"'),
    aac: can('audio/mp4; codecs="mp4a.40.2"'),
    mp3: can('audio/mpeg'),
    opus: can('audio/webm; codecs="opus"'),
    flac: can('audio/flac'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
  };
}
