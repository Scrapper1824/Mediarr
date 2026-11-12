import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
import JASSUB from 'jassub';
import { api } from '../api';
import { useAuth } from '../components/AuthGate';
import { detectCaps } from '../player/caps';

interface Track {
  order: number;
  language: string | null;
  title: string | null;
  codec: string;
  isDefault: boolean;
}
interface SubTrack extends Track {
  text: boolean;
  forced: boolean;
}
interface PlayInfo {
  kind: 'movie' | 'episode';
  id: number;
  mediaId: number;
  title: string;
  subtitle: string | null;
  duration: number;
  audioPreference: 'sub' | 'dub' | null;
  audio: (Track & { channels: number })[];
  subtitles: SubTrack[];
  hasFonts: boolean;
  segments: Segments;
  trickplay: Trickplay | null;
  pending: { trickplay: boolean; segments: boolean };
  position: number;
  next: { kind: 'episode'; id: number; label: string } | null;
  prev: { kind: 'episode'; id: number; label: string } | null;
  remote: boolean;
}
type Segments = Partial<Record<'intro' | 'credits', { start: number; end: number }>>;
interface Trickplay {
  interval: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  count: number;
  sheets: number;
}

interface StartResult {
  mode: 'direct' | 'hls';
  url: string;
  sessionId?: string;
  reason: string;
}

type Quality = 'auto' | 'original' | '1080' | '720' | '480';
// In menu order (number-like object keys would otherwise sort first).
const QUALITY_ORDER: Quality[] = ['auto', 'original', '1080', '720', '480'];
const QUALITY_LABEL: Record<Quality, string> = { auto: 'Auto', original: 'Original', '1080': '1080p', '720': '720p', '480': '480p' };
const QUALITY_HINT: Record<Quality, (remote: boolean) => string> = {
  auto: (remote) => (remote ? 'Fits your connection' : 'Full quality at home'),
  original: () => 'As high as the file allows',
  '1080': () => 'About 8 Mbps',
  '720': () => 'About 4 Mbps',
  '480': () => 'About 1.5 Mbps · saves data',
};

/** MKV files often use the older ISO 639-2/B codes; the browser knows the standard (/T) ones. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'zho', cze: 'ces', dut: 'nld', fre: 'fra', geo: 'kat', ger: 'deu',
  gre: 'ell', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa', per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym',
};
const SPECIAL: Record<string, string> = { und: 'Unknown language', zxx: 'No language', mul: 'Multiple languages', fil: 'Filipino' };
let languageNames: Intl.DisplayNames | null = null;
try {
  languageNames = new Intl.DisplayNames(undefined, { type: 'language', fallback: 'none' });
} catch {
  languageNames = null;
}

/** "ara" → "Arabic", "cze" → "Czech", "pt-BR" → "Brazilian Portuguese"; unknown codes stay as they are. */
export function languageName(code: string): string {
  const c = code.trim().toLowerCase();
  if (SPECIAL[c]) return SPECIAL[c];
  try {
    const name = languageNames?.of(BIBLIOGRAPHIC[c] ?? c);
    if (name && name.toLowerCase() !== c) return name;
  } catch {
    // not a valid language tag
  }
  return code.toUpperCase();
}

const isEnglish = (l: string | null) => l === 'eng' || l === 'en';
const trackName = (t: Track, i: number) => {
  const lang = t.language ? languageName(t.language) : null;
  return [lang, t.title && t.title !== lang ? t.title : null].filter(Boolean).join(' · ') || `Track ${i + 1}`;
};

/** Audio: the dub when the title was requested as Dub, else the file's default. */
function pickAudio(info: PlayInfo): number | null {
  if (!info.audio.length) return null;
  if (info.audioPreference === 'dub') {
    const eng = info.audio.find((a) => isEnglish(a.language));
    if (eng) return eng.order;
  }
  if (info.audioPreference === 'sub') {
    const jpn = info.audio.find((a) => a.language === 'jpn' || a.language === 'ja');
    if (jpn) return jpn.order;
  }
  return (info.audio.find((a) => a.isDefault) ?? info.audio[0]).order;
}

/** Subtitles: full English subs for foreign audio; only signs/forced ones when the audio is already English. */
function pickSubtitle(info: PlayInfo, audio: number | null): number | null {
  const lang = info.audio.find((a) => a.order === audio)?.language ?? null;
  const signs = (s: SubTrack) => s.forced || /sign|song/i.test(s.title ?? '');
  if (isEnglish(lang)) return info.subtitles.find(signs)?.order ?? null;
  const eng = info.subtitles.filter((s) => isEnglish(s.language) || !s.language);
  return (eng.find((s) => !signs(s) && s.isDefault) ?? eng.find((s) => !signs(s)) ?? info.subtitles.find((s) => s.isDefault) ?? info.subtitles[0])?.order ?? null;
}

/**
 * Your last caption choice, remembered in this browser for your account. Kept apart for English audio
 * (dubs) and other audio, so turning captions off on a dub doesn't also turn them off for subbed shows.
 */
interface CaptionChoice {
  on: boolean;
  language: string | null;
  signsOnly: boolean;
  /** The track's name ("SDH", "Full"…), to pick the same kind again when there's a match. */
  title?: string | null;
}
type AudioKind = 'english' | 'other';
const captionKey = (user: string) => `mediarr.captions.v1:${user}`;
const isSigns = (s: SubTrack) => s.forced || /sign|song/i.test(s.title ?? '');
const audioKind = (info: PlayInfo, audio: number | null): AudioKind => (isEnglish(info.audio.find((a) => a.order === audio)?.language ?? null) ? 'english' : 'other');

function loadCaptions(user: string | undefined): Partial<Record<AudioKind, CaptionChoice>> {
  if (!user) return {};
  try {
    return JSON.parse(localStorage.getItem(captionKey(user)) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveCaptions(user: string | undefined, kind: AudioKind, choice: CaptionChoice) {
  if (!user) return;
  try {
    localStorage.setItem(captionKey(user), JSON.stringify({ ...loadCaptions(user), [kind]: choice }));
  } catch {
    // Private window or storage blocked: the choice just isn't remembered.
  }
}

/** Diagnostics readout for the player (Shift+D): mouse events, control state and where the bars are. */
function DiagReadout({
  diag,
  controls,
  playing,
  shell,
}: {
  diag: React.MutableRefObject<{ moves: number; accepted: number; ignored: number; shows: number; hides: number; last: null | { x: number; y: number; mx: number; my: number; target: string; at: number } }>;
  controls: boolean;
  playing: boolean;
  shell: React.RefObject<HTMLDivElement>;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const d = diag.current;
  const fs = document.fullscreenElement as HTMLElement | null;
  const w = shell.current;
  const bar = w?.querySelector('.watch-bottom') as HTMLElement | null;
  const cs = bar ? getComputedStyle(bar) : null;
  const r = bar?.getBoundingClientRect();
  const wr = w?.getBoundingClientRect();
  const mid = wr ? document.elementFromPoint(wr.left + wr.width / 2, wr.top + wr.height / 2) : null;
  const lines = [
    `fullscreen: ${fs ? fs.tagName.toLowerCase() + '.' + (fs.className.split(' ')[0] || '') : 'no'}   window: ${window.innerWidth}x${window.innerHeight}`,
    `mouse moves: ${d.moves}   accepted: ${d.accepted}   ignored: ${d.ignored}`,
    d.last
      ? `last move: x ${d.last.x} y ${d.last.y}   movement ${d.last.mx},${d.last.my}   on ${d.last.target}   ${Math.round((Date.now() - d.last.at) / 100) / 10}s ago`
      : 'last move: none yet',
    `controls state: ${controls ? 'on' : 'off'}   playing: ${playing ? 'yes' : 'no'}   class: ${w?.classList.contains('show-controls') ? 'show-controls' : '-'}   shows ${d.shows} / hides ${d.hides}`,
    cs && r ? `bottom bar: opacity ${cs.opacity}  visibility ${cs.visibility}  top ${Math.round(r.top)} height ${Math.round(r.height)}` : 'bottom bar: not found',
    `player box: ${wr ? `${Math.round(wr.width)}x${Math.round(wr.height)} at ${Math.round(wr.left)},${Math.round(wr.top)}` : '?'}   centre: ${mid ? mid.tagName.toLowerCase() + '.' + ((mid as HTMLElement).className?.toString().split(' ')[0] || '') : '?'}`,
  ];
  return (
    <pre className="watch-diag" aria-hidden>
      {lines.join('\n')}
    </pre>
  );
}

/** Auto-skip of intros and credits: off unless you turned it on (this account, this browser). */
const autoSkipKey = (user: string) => `mediarr.autoskip.v1:${user}`;
function loadAutoSkip(user: string | undefined): boolean {
  if (!user) return false;
  try {
    return localStorage.getItem(autoSkipKey(user)) === 'on';
  } catch {
    return false;
  }
}
function saveAutoSkip(user: string | undefined, on: boolean) {
  if (!user) return;
  try {
    localStorage.setItem(autoSkipKey(user), on ? 'on' : 'off');
  } catch {
    // Storage blocked: the switch still works for this episode.
  }
}

/** The subtitle track to start with: your remembered choice when it applies, else the usual pick. */
function startSubtitle(info: PlayInfo, audio: number | null, user: string | undefined): number | null {
  const choice = loadCaptions(user)[audioKind(info, audio)];
  if (!choice) return pickSubtitle(info, audio);
  if (!choice.on) return null;
  const same = info.subtitles.filter((t) => (t.language ?? null) === choice.language && isSigns(t) === choice.signsOnly);
  return (same.find((t) => choice.title && t.title === choice.title) ?? same.find((t) => t.isDefault) ?? same[0])?.order ?? pickSubtitle(info, audio);
}

const clock = (sec: number) => {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

/** Sends a request that survives the page closing (progress, ending the stream). */
const keepalive = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'mediarr', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => undefined);

export default function Watch() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const navigate = useNavigate();
  const info = useQuery({
    queryKey: ['play', kind, id],
    queryFn: () => api.get<PlayInfo>(`/api/play/${kind}/${id}/info`),
    staleTime: 0,
    gcTime: 0,
  });
  const d = info.data;
  if (info.error) {
    return (
      <div className="watch watch-message">
        <p>{(info.error as Error).message}</p>
        <button className="btn" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>
    );
  }
  if (!d) return <div className="watch watch-message">Loading…</div>;
  return <Player key={`${kind}-${id}`} info={d} />;
}

function Player({ info }: { info: PlayInfo }) {
  const navigate = useNavigate();
  const shell = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const subs = useRef<JASSUB | null>(null);
  const session = useRef<string | null>(null);
  const base = `/api/play/${info.kind}/${info.id}`;

  const [audio, setAudio] = useState<number | null>(() => pickAudio(info));
  const user = useAuth().data?.user?.username;
  const [subtitle, setSubtitle] = useState<number | null>(() => startSubtitle(info, pickAudio(info), user));
  const [autoSkip, setAutoSkip] = useState(() => loadAutoSkip(user));
  const [debug, setDebug] = useState(() => new URLSearchParams(window.location.search).has('debug'));
  // Fullscreen workaround. Chrome on Windows stops updating the controls over a fullscreen video unless
  // something reads their state (as the Shift+D readout does). So, while fullscreen, 4 times a second: read
  // the bars' style and position and rewrite an invisible line of text. Fading is also off in fullscreen.
  // Test modes: ?fs=nofade (no fading only), ?fs=beat (reading only), ?fs=off (neither).
  const fsMode = useState(() => new URLSearchParams(window.location.search).get('fs') ?? 'both')[0];
  const keepDrawn = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fsMode !== 'both' && fsMode !== 'beat') return;
    const t = window.setInterval(() => {
      const el = keepDrawn.current;
      const w = shell.current;
      if (!el || !w || !document.fullscreenElement) return;
      let out = '';
      for (const bar of w.querySelectorAll<HTMLElement>('.watch-top, .watch-bottom')) {
        const cs = getComputedStyle(bar);
        const r = bar.getBoundingClientRect();
        out += `${cs.opacity}${cs.visibility[0]}${Math.round(r.top)} `;
      }
      const wr = w.getBoundingClientRect();
      const mid = document.elementFromPoint(wr.left + wr.width / 2, wr.top + wr.height / 2);
      el.textContent = `${out}${mid?.tagName ?? ''}${Date.now() % 1000}`;
    }, 250);
    return () => window.clearInterval(t);
  }, [fsMode]);
  /** When you last moved the playhead yourself: landing inside an intro on purpose is never undone. */
  const lastUserSeek = useRef(0);
  /** Intros/credits already skipped (or let play) this episode, so each is handled once. */
  const skipHandled = useRef(new Set<string>());
  const [skipNote, setSkipNote] = useState<{ text: string; back: number } | null>(null);
  const [quality, setQuality] = useState<Quality>('auto');
  const [resumeAsked, setResumeAsked] = useState(info.position > 30);
  // A new object each time, so starting again at the same second still restarts the stream.
  const [start, setStart] = useState<{ at: number } | null>(info.position > 30 ? null : { at: 0 });
  const [mode, setMode] = useState<StartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // Which menu page is open: CC opens audio + subtitles together; ⚙ opens the main page, which leads to the others.
  const [menu, setMenu] = useState<null | 'tracks' | 'main' | 'audio' | 'subtitles' | 'quality'>(null);
  const [controls, setControls] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const hideTimer = useRef<number>();
  /** When the stream last restarted itself after a failed load. */
  const lastRecovery = useRef(0);

  const duration = info.duration;
  const currentTime = useCallback(() => video.current?.currentTime ?? 0, []);

  const endStream = useCallback(() => {
    hls.current?.destroy();
    hls.current = null;
    if (session.current) keepalive('DELETE', `/api/play/hls/${session.current}`);
    session.current = null;
  }, []);

  const saveProgress = useCallback(() => {
    const t = currentTime();
    if (t > 0) keepalive('PUT', `${base}/progress`, { position: t, duration });
  }, [base, duration, currentTime]);

  // Start (or restart, after changing audio/quality) the stream at `startAt`.
  useEffect(() => {
    if (start === null) return;
    const startAt = start.at;
    const v = video.current!;
    let cancelled = false;
    setError(null);
    setWaiting(true);
    (async () => {
      try {
        const r = await api.post<StartResult>(`${base}/start`, { audio, subtitle, quality, startAt, caps: detectCaps() });
        if (cancelled) {
          if (r.sessionId) keepalive('DELETE', `/api/play/hls/${r.sessionId}`);
          return;
        }
        endStream();
        session.current = r.sessionId ?? null;
        setMode(r);
        if (r.mode === 'hls' && Hls.isSupported()) {
          const h = new Hls({
            startPosition: startAt,
            // Keep the browser's video memory well under its ~150 MB limit: buffer 30 s ahead, drop what's
            // 30 s behind. Without this, a long watch fills it and new pieces after a seek can't be added.
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            backBufferLength: 30,
          });
          h.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            const status = (data.response as { code?: number } | undefined)?.code;
            if (status === 503) {
              setError('The server is busy converting other videos right now. Try again in a little while.');
              return;
            }
            // A piece that didn't arrive: quietly start the stream again from here, once per minute at most.
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && Date.now() - lastRecovery.current > 60_000) {
              lastRecovery.current = Date.now();
              restartHere();
              return;
            }
            setError(
              data.type === Hls.ErrorTypes.NETWORK_ERROR
                ? 'The video stopped loading. Check your connection, then try again.'
                : `The video couldn’t be played (${data.details}).`,
            );
          });
          h.loadSource(r.url);
          h.attachMedia(v);
          hls.current = h;
        } else {
          // Direct play, or Safari's own HLS.
          v.src = r.url;
          v.addEventListener('loadedmetadata', () => (v.currentTime = startAt), { once: true });
        }
        v.play().catch(() => setPlaying(false));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only a new start request restarts the stream; it reads the audio/subtitle/quality chosen with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  // Leaving the page: save where we are and stop the server's conversion.
  useEffect(
    () => () => {
      saveProgress();
      endStream();
      subs.current?.destroy();
    },
    [saveProgress, endStream],
  );
  useEffect(() => {
    const t = setInterval(() => !video.current?.paused && saveProgress(), 10_000);
    window.addEventListener('pagehide', saveProgress);
    return () => {
      clearInterval(t);
      window.removeEventListener('pagehide', saveProgress);
    };
  }, [saveProgress]);

  // Styled subtitles drawn over the video.
  useEffect(() => {
    subs.current?.destroy();
    subs.current = null;
    const track = info.subtitles.find((s) => s.order === subtitle);
    if (!track?.text || !video.current) return;
    let cancelled = false;
    (async () => {
      const fonts = info.hasFonts ? await api.get<string[]>(`${base}/fonts`).catch(() => []) : [];
      if (cancelled) return;
      subs.current = new JASSUB({
        video: video.current!,
        subUrl: `${base}/subtitle/${track.order}`,
        fonts: fonts.map((f) => `${base}/fonts/${encodeURIComponent(f)}`),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [subtitle, base, info.subtitles, info.hasFonts]);

  /** Restarts the stream from where we are (new audio track, picture subtitles or quality). */
  const restartHere = () => setStart({ at: Math.max(0, currentTime() - 1) });

  const chooseAudio = (order: number) => {
    setAudio(order);
    setMenu(null);
    restartHere();
  };
  const chooseSubtitle = (order: number | null) => {
    const wasBurned = info.subtitles.find((s) => s.order === subtitle && !s.text);
    const isBurned = info.subtitles.find((s) => s.order === order && !s.text);
    setSubtitle(order);
    setMenu(null);
    // Remembered for next time (this kind of audio, this account, this browser).
    const track = info.subtitles.find((t) => t.order === order);
    saveCaptions(user, audioKind(info, audio), track ? { on: true, language: track.language ?? null, signsOnly: isSigns(track), title: track.title ?? null } : { on: false, language: null, signsOnly: false });
    // Picture subtitles are drawn into the video, so the stream has to change.
    if (wasBurned || isBurned) restartHere();
  };
  const chooseQuality = (q: Quality) => {
    setQuality(q);
    setMenu(null);
    restartHere();
  };

  const togglePlay = () => {
    const v = video.current!;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  };
  const seek = (t: number, byUser = true) => {
    if (byUser) lastUserSeek.current = Date.now();
    const v = video.current!;
    const to = Math.min(Math.max(0, t), duration - 0.5);
    v.currentTime = to;
    setTime(to); // the bar and clock move right away, before the new frame arrives
  };

  // Dragging the bar only previews the time; the jump happens once, when you let go
  // (each intermediate jump would make the server restart its conversion).
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubTimer = useRef<number>();
  const commitScrub = (value: number) => {
    window.clearTimeout(scrubTimer.current);
    setScrub(null);
    seek(value);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else shell.current?.requestFullscreen().catch(() => undefined);
  };
  const goTo = (to: PlayInfo['next']) => {
    if (!to) return;
    saveProgress();
    navigate(`/watch/${to.kind}/${to.id}`, { replace: true });
  };
  const goNext = () => goTo(info.next);
  const goPrev = () => goTo(info.prev);

  // Controls: shown on any real mouse movement, hidden 3 s later while playing. They stay up while the
  // pointer is on them or a menu is open. Chrome also sends "moves" when nothing moved (e.g. when the
  // cursor hides in fullscreen); those are ignored, or the controls would flash back right after hiding.
  const overControls = useRef(false);
  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const shown = useRef(true);
  /** Diagnostics (Shift+D): what the mouse and the controls are doing. */
  const diag = useRef({
    moves: 0,
    accepted: 0,
    ignored: 0,
    shows: 0,
    hides: 0,
    last: null as null | { x: number; y: number; mx: number; my: number; target: string; at: number },
  });
  const show = (on: boolean) => {
    if (shown.current === on) return; // no re-render for every mouse event
    shown.current = on;
    if (on) diag.current.shows++;
    else diag.current.hides++;
    setControls(on);
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(function hide() {
      if (overControls.current || menuOpen.current) {
        hideTimer.current = window.setTimeout(hide, 1000); // look again once they've moved off / closed it
        return;
      }
      if (!video.current?.paused) show(false);
    }, 3000);
  };
  const poke = () => {
    show(true);
    scheduleHide();
  };
  // Mouse moves anywhere on the page (fullscreen included) show the controls. Listened for on the document,
  // so nothing in between can swallow them. A real move reports how far the mouse went (movementX/Y);
  // Chrome's phantom "moves" (when the cursor hides or the layout changes) report none. Only when a browser
  // gives no movement at all does the position decide (3 px from where the controls last reacted).
  const pokeRef = useRef(poke);
  pokeRef.current = poke;
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = diag.current;
      d.moves++;
      const t = e.target as HTMLElement | null;
      d.last = {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        mx: e.movementX ?? 0,
        my: e.movementY ?? 0,
        target: t ? `${t.tagName.toLowerCase()}${typeof t.className === 'string' && t.className ? '.' + t.className.split(' ')[0] : ''}` : '?',
        at: Date.now(),
      };
      const moved = (e.movementX ?? 0) !== 0 || (e.movementY ?? 0) !== 0;
      const anchor = lastPointer.current;
      if (!moved && anchor && Math.abs(e.clientX - anchor.x) < 3 && Math.abs(e.clientY - anchor.y) < 3) {
        d.ignored++;
        return;
      }
      d.accepted++;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      pokeRef.current();
    };
    document.addEventListener('mousemove', onMove, true);
    return () => document.removeEventListener('mousemove', onMove, true);
  }, []);
  const onControls = {
    onMouseEnter: () => {
      overControls.current = true;
      show(true);
    },
    onMouseLeave: () => {
      overControls.current = false;
      scheduleHide();
    },
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      const v = video.current;
      if (!v) return;
      if (e.key === ' ' || e.key === 'k') togglePlay();
      else if (e.key === 'ArrowRight') seek(v.currentTime + 10);
      else if (e.key === 'ArrowLeft') seek(v.currentTime - 10);
      else if (e.key === 'f') fullscreen();
      else if (e.key === 'm') v.muted = !v.muted;
      else if (e.key === 'N' && e.shiftKey) goNext();
      else if (e.key === 'D' && e.shiftKey) setDebug((v) => !v);
      else if (e.key === 'P' && e.shiftKey) goPrev();
      else if (e.key === 'Escape' && menu) setMenu(null);
      else return;
      e.preventDefault();
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // "Next episode" countdown when an episode ends.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  });

  const audioTrack = info.audio.find((a) => a.order === audio);
  const audioLabel = audioTrack ? trackName(audioTrack, info.audio.indexOf(audioTrack)) : 'None';
  const subTrack = info.subtitles.find((s) => s.order === subtitle);
  const subtitleLabel = subTrack ? trackName(subTrack, info.subtitles.indexOf(subTrack)) : 'Off';

  const menuRow = (label: string, value: string, page: 'audio' | 'subtitles' | 'quality') => (
    <button className="watch-row" onClick={() => setMenu(page)}>
      <span>{label}</span>
      <span className="watch-row-value">
        {value} <span aria-hidden>›</span>
      </span>
    </button>
  );
  const menuBack = (title: string) => (
    <button className="watch-back" onClick={() => setMenu('main')}>
      <span aria-hidden>‹</span> {title}
    </button>
  );
  const audioOptions = () =>
    info.audio.length ? (
      <>
        {info.audio.map((a, i) => (
          <button key={a.order} className={`watch-option${a.order === audio ? ' on' : ''}`} onClick={() => a.order !== audio && chooseAudio(a.order)}>
            <span>{trackName(a, i)}</span>
            <small>{[a.codec.toUpperCase(), a.channels > 2 ? `${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : `${a.channels} ch`}` : 'Stereo'].join(' · ')}</small>
          </button>
        ))}
      </>
    ) : (
      <div className="watch-menu-note">No audio tracks</div>
    );
  const subtitleOptions = () => (
    <>
      <button className={`watch-option${subtitle === null ? ' on' : ''}`} onClick={() => chooseSubtitle(null)}>
        <span>Off</span>
      </button>
      {info.subtitles.map((s, i) => (
        <button key={s.order} className={`watch-option${s.order === subtitle ? ' on' : ''}`} onClick={() => chooseSubtitle(s.order)}>
          <span>{trackName(s, i)}</span>
          <small>{[s.forced ? 'Forced' : null, s.text ? 'Styled' : 'Picture'].filter(Boolean).join(' · ')}</small>
        </button>
      ))}
    </>
  );

  const [extras, setExtras] = useState<{ segments: Segments; trickplay: Trickplay | null; pending?: PlayInfo['pending'] }>({
    segments: info.segments,
    trickplay: info.trickplay,
    pending: info.pending,
  });
  useEffect(() => {
    if (extras.trickplay && extras.segments.intro) return;
    let tries = 0;
    const t = setInterval(async () => {
      if (++tries > 120) return clearInterval(t); // stop asking after ~10 minutes
      const r = await api.get<{ segments: Segments; trickplay: Trickplay | null; pending: PlayInfo['pending'] }>(`${base}/extras`).catch(() => null);
      if (!r) return;
      setExtras(r);
      if (r.trickplay && r.segments.intro) clearInterval(t);
    }, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Skip buttons while inside an intro or the credits.
  const intro = extras.segments.intro;
  const credits = extras.segments.credits;
  const inIntro = !!intro && time >= intro.start && time < intro.end - 1;
  const inCredits = !!credits && time >= credits.start && time < credits.end - 1;
  const skipCredits = () => {
    if (info.next) goNext();
    else seek(credits!.end);
  };

  // Auto-skip: when playback reaches an intro or the credits, skip it once. If you jumped into it
  // yourself (to watch it), it's left alone.
  useEffect(() => {
    if (!autoSkip || !playing || resumeAsked || countdown !== null || scrub !== null) return;
    const seg = inIntro ? intro! : inCredits ? credits! : null;
    if (!seg) return;
    const kind = inIntro ? 'intro' : 'credits';
    const key = `${kind}:${seg.start}`;
    if (skipHandled.current.has(key)) return;
    skipHandled.current.add(key);
    if (Date.now() - lastUserSeek.current < 2500) return;
    if (kind === 'credits' && info.next) {
      goNext();
      return;
    }
    seek(seg.end, false);
    setSkipNote({ text: kind === 'intro' ? 'Skipped the intro' : 'Skipped the credits', back: seg.start });
  });
  useEffect(() => {
    if (!skipNote) return;
    const t = setTimeout(() => setSkipNote(null), 5000);
    return () => clearTimeout(t);
  }, [skipNote]);
  const toggleAutoSkip = () => {
    const on = !autoSkip;
    setAutoSkip(on);
    saveAutoSkip(user, on);
  };

  // Thumbnail preview over the seek bar (hover, or while dragging).
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const seekBox = useRef<HTMLDivElement>(null);
  const previewAt = (clientX: number) => {
    const box = seekBox.current?.getBoundingClientRect();
    if (!box) return null;
    const x = Math.min(Math.max(0, clientX - box.left), box.width);
    return { t: (x / box.width) * duration, x };
  };
  const preview = scrub !== null && seekBox.current ? { t: scrub, x: (scrub / duration) * seekBox.current.clientWidth } : hover;
  const thumb = (() => {
    const tp = extras.trickplay;
    if (!tp || !preview) return null;
    const n = Math.min(tp.count - 1, Math.floor(preview.t / tp.interval));
    const perSheet = tp.columns * tp.rows;
    const sheet = Math.floor(n / perSheet);
    const cell = n % perSheet;
    return {
      url: `${base}/trickplay/${sheet}.jpg`,
      x: (cell % tp.columns) * tp.width,
      y: Math.floor(cell / tp.columns) * tp.height,
      w: tp.width,
      h: tp.height,
    };
  })();

  const nearEnd = info.next && duration - time < 60;
  const title = info.subtitle ? `${info.title} — ${info.subtitle}` : info.title;

  return (
    <div
      ref={shell}
      data-debug={debug || undefined}
      data-fs-fade={fsMode === 'beat' || fsMode === 'off' ? '' : undefined}
      className={`watch${controls || !playing ? ' show-controls' : ''}`}
      onTouchStart={poke}
    >
      <video
        ref={video}
        className="watch-video"
        playsInline
        onClick={togglePlay}
        onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          saveProgress();
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setTime(v.currentTime);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onEnded={() => {
          saveProgress();
          if (info.next) setCountdown(10);
        }}
      />

      {waiting && !error && !resumeAsked && <div className="watch-spinner" aria-label="Loading" />}

      {resumeAsked && (
        <div className="watch-dialog">
          <h2>{title}</h2>
          <button
            className="btn primary"
            autoFocus
            onClick={() => {
              setResumeAsked(false);
              setStart({ at: info.position });
            }}
          >
            Resume from {clock(info.position)}
          </button>
          <button
            className="btn"
            onClick={() => {
              setResumeAsked(false);
              setStart({ at: 0 });
            }}
          >
            Start over
          </button>
        </div>
      )}

      {error && (
        <div className="watch-dialog">
          <p>{error}</p>
          <button className="btn primary" onClick={restartHere}>
            Try again
          </button>
          <button className="btn" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      )}

      {skipNote && (
        <div className="watch-skip-note" role="status">
          {skipNote.text}
          <button
            onClick={() => {
              seek(skipNote.back);
              setSkipNote(null);
            }}
          >
            Watch it
          </button>
        </div>
      )}
      {(inIntro || inCredits) && countdown === null && !resumeAsked && !(autoSkip && playing && Date.now() - lastUserSeek.current >= 2500) && (
        <button className="watch-skip" onClick={inIntro ? () => seek(intro!.end) : skipCredits}>
          {inIntro ? 'Skip intro' : info.next ? 'Next episode' : 'Skip credits'} <span aria-hidden>⏭</span>
        </button>
      )}

      {countdown !== null && info.next && (
        <div className="watch-dialog">
          <p>Up next: {info.next.label}</p>
          <button className="btn primary" onClick={goNext}>
            Play now ({countdown})
          </button>
          <button className="btn" onClick={() => setCountdown(null)}>
            Cancel
          </button>
        </div>
      )}

      {/* Always drawn over the video. Without anything on top, Chrome (Windows) hands a fullscreen video
          straight to the graphics card and then doesn't redraw the controls when they come back. */}
      <div ref={keepDrawn} className="watch-keepdrawn" data-fs={fsMode} aria-hidden />
      {debug && <DiagReadout diag={diag} controls={controls} playing={playing} shell={shell} />}
      <div className="watch-top" {...onControls}>
        <button className="watch-icon" aria-label="Back" onClick={() => navigate(-1)}>
          ←
        </button>
        <div className="watch-title">
          <strong>{info.title}</strong>
          {info.subtitle && <span>{info.subtitle}</span>}
        </div>
      </div>

      <div className="watch-bottom" onClick={(e) => e.stopPropagation()} {...onControls}>
        <div
          className="watch-seek"
          ref={seekBox}
          onMouseMove={(e) => setHover(previewAt(e.clientX))}
          onMouseLeave={() => setHover(null)}
        >
          {preview && (
            <div
              className="watch-preview"
              style={{
                left: `clamp(${(thumb?.w ?? 60) / 2}px, ${preview.x}px, calc(100% - ${(thumb?.w ?? 60) / 2}px))`,
                width: thumb ? `${thumb.w}px` : undefined,
              }}
            >
              {thumb && (
                <div
                  className="watch-preview-img"
                  style={{ width: thumb.w, height: thumb.h, backgroundImage: `url(${thumb.url})`, backgroundPosition: `-${thumb.x}px -${thumb.y}px` }}
                />
              )}
              <span>
                {intro && preview.t >= intro.start && preview.t < intro.end ? 'Intro · ' : credits && preview.t >= credits.start && preview.t < credits.end ? 'Credits · ' : ''}
                {clock(preview.t)}
              </span>
              {!thumb && extras.pending?.trickplay && <small className="watch-preview-note">Making previews…</small>}
            </div>
          )}
          <div className="watch-track" />
          <div className="watch-buffered" style={{ width: `${(buffered / duration) * 100}%` }} />
          <div className="watch-played" style={{ width: `${(Math.min(scrub ?? time, duration) / duration) * 100}%` }} />
          {[intro, credits].map(
            (seg, i) =>
              seg && (
                <div
                  key={i}
                  className="watch-segment"
                  title={i === 0 ? 'Intro' : 'Credits'}
                  style={{ left: `${(seg.start / duration) * 100}%`, width: `${((seg.end - seg.start) / duration) * 100}%` }}
                />
              ),
          )}
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={duration}
            step={1}
            value={Math.min(scrub ?? time, duration)}
            onChange={(e) => {
              const value = Number(e.target.value);
              setScrub(value);
              // Keyboard arrows and clicks have no "let go": jump once the value settles.
              window.clearTimeout(scrubTimer.current);
              scrubTimer.current = window.setTimeout(() => commitScrub(value), 350);
            }}
            onPointerDown={() => window.clearTimeout(scrubTimer.current)}
            onPointerUp={(e) => commitScrub(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitScrub(Number((e.target as HTMLInputElement).value))}
          />
        </div>
        <div className="watch-bar">
          {info.kind === 'episode' && (
            <button className="watch-icon" aria-label="Previous episode" title={info.prev ? `Previous: ${info.prev.label} (Shift+P)` : 'No previous episode'} disabled={!info.prev} onClick={goPrev}>
              ⏮
            </button>
          )}
          <button className="watch-icon" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
            {playing ? '❚❚' : '▶'}
          </button>
          {info.kind === 'episode' && (
            <button className="watch-icon" aria-label="Next episode" title={info.next ? `Next: ${info.next.label} (Shift+N)` : 'No next episode'} disabled={!info.next} onClick={goNext}>
              ⏭
            </button>
          )}
          <button className="watch-icon" aria-label="Back 10 seconds" onClick={() => seek(currentTime() - 10)}>
            ↺10
          </button>
          <button className="watch-icon" aria-label="Forward 10 seconds" onClick={() => seek(currentTime() + 10)}>
            10↻
          </button>
          <button className="watch-icon" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => (video.current!.muted = !muted)}>
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            className="watch-volume"
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              video.current!.volume = Number(e.target.value);
              video.current!.muted = false;
            }}
          />
          <span className="watch-time">
            {clock(scrub ?? time)} / {clock(duration)}
          </span>
          <span className="watch-spacer" />
          {nearEnd && (
            <button className="btn small" onClick={goNext}>
              Next episode ▸
            </button>
          )}
          <div className="watch-menu-wrap">
            <button
              className={`watch-icon watch-cc${subtitle !== null ? ' on' : ''}`}
              aria-label="Audio and subtitles"
              aria-expanded={menu === 'tracks'}
              onClick={() => setMenu(menu === 'tracks' ? null : 'tracks')}
            >
              CC
            </button>
            <button
              className="watch-icon"
              aria-label="Settings"
              aria-expanded={!!menu && menu !== 'tracks'}
              onClick={() => setMenu(menu && menu !== 'tracks' ? null : 'main')}
            >
              ⚙
            </button>

            {menu === 'tracks' && (
              <div className="watch-menu watch-tracks" role="dialog" aria-label="Audio and subtitles">
                <div className="watch-tracks-col">
                  <div className="watch-menu-head">Audio</div>
                  {audioOptions()}
                </div>
                <div className="watch-tracks-col">
                  <div className="watch-menu-head">Subtitles</div>
                  {subtitleOptions()}
                </div>
              </div>
            )}

            {menu === 'main' && (
              <div className="watch-menu" role="menu" aria-label="Settings">
                {menuRow('Audio', audioLabel, 'audio')}
                {menuRow('Subtitles', subtitleLabel, 'subtitles')}
                {menuRow('Quality', QUALITY_LABEL[quality], 'quality')}
                <button className="watch-row" role="menuitemcheckbox" aria-checked={autoSkip} onClick={toggleAutoSkip}>
                  <span>
                    Auto-skip intro &amp; credits
                    <small className="watch-row-hint">{info.next ? 'Credits go straight to the next episode' : 'Jumps past them when they start'}</small>
                  </span>
                  <span className={`watch-switch${autoSkip ? ' on' : ''}`} aria-hidden />
                </button>
                {mode && (
                  <div className="watch-menu-note">
                    {mode.mode === 'direct' ? 'Playing the original file — no conversion needed.' : `Converting for this browser: ${mode.reason.charAt(0).toLowerCase()}${mode.reason.slice(1)}.`}
                  </div>
                )}
              </div>
            )}

            {menu === 'audio' && (
              <div className="watch-menu" role="menu" aria-label="Audio">
                {menuBack('Audio')}
                {audioOptions()}
              </div>
            )}
            {menu === 'subtitles' && (
              <div className="watch-menu" role="menu" aria-label="Subtitles">
                {menuBack('Subtitles')}
                {subtitleOptions()}
              </div>
            )}
            {menu === 'quality' && (
              <div className="watch-menu" role="menu" aria-label="Quality">
                {menuBack('Quality')}
                {QUALITY_ORDER.map((q) => (
                  <button key={q} className={`watch-option${q === quality ? ' on' : ''}`} onClick={() => chooseQuality(q)}>
                    <span>{QUALITY_LABEL[q]}</span>
                    <small>{QUALITY_HINT[q](info.remote)}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="watch-icon" aria-label="Fullscreen" onClick={fullscreen}>
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}
