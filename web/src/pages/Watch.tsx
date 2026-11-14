import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
// The light build: audio and subtitle tracks are handled by the server, so the rest of hls.js isn't needed.
import Hls from 'hls.js/light';
import type JASSUB from 'jassub';
import { api } from '../api';
import InvitePanel from '../components/InvitePanel';
import InvitePopup from '../components/InvitePopup';
import { useAuth } from '../components/AuthGate';
import { detectCaps } from '../player/caps';
import { correction, expectedPosition, isEcho } from '../party/sync';
import { bufferedAhead, waitingLabel } from '../party/protocol';
import { enoughBuffered, readyAhead, recordStall } from '../party/readiness';
import type { PartyBinding } from '../party/useParty';

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
export interface PlayInfo {
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

/** A paused party video further than this (s) from the party's position is moved to it. */
const PARTY_PAUSED_TOLERANCE = 0.15;
/** How long a converted (HLS) stream takes to start playing, roughly (s): a late joiner aims this far ahead. */
const HLS_STARTUP_S = 2;

/** Where the party is right now (s), kept inside the video. */
function partyPosition(party: PartyBinding, duration: number): number {
  const s = party.state;
  if (!s) return 0;
  return Math.min(Math.max(0, expectedPosition(s, party.clock.now())), Math.max(0, duration - 0.5));
}

export function Player({ info, party }: { info: PlayInfo; party?: PartyBinding }) {
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
  // In a party everyone's skips would fight over the shared position, so auto-skip stays off there.
  const [autoSkip, setAutoSkip] = useState(() => !party && loadAutoSkip(user));
  const [debug, setDebug] = useState(() => new URLSearchParams(window.location.search).has('debug'));
  /** When you last moved the playhead yourself: landing inside an intro on purpose is never undone. */
  const lastUserSeek = useRef(0);
  /** Intros/credits already skipped (or let play) this episode, so each is handled once. */
  const skipHandled = useRef(new Set<string>());
  const [skipNote, setSkipNote] = useState<{ text: string; back: number } | null>(null);
  const [quality, setQuality] = useState<Quality>('auto');
  // A party starts where the party is, never with the resume question.
  const [resumeAsked, setResumeAsked] = useState(!party && info.position > 30);
  // A new object each time, so starting again at the same second still restarts the stream.
  // `play: false` keeps it paused (a restart while you had it paused).
  const [start, setStart] = useState<{ at: number; play?: boolean } | null>(() =>
    party ? { at: partyPosition(party, info.duration) } : info.position > 30 ? null : { at: 0 },
  );
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

  // Party guests have no account, so nothing to save progress to.
  const noProgress = !!party?.guest;
  const saveProgress = useCallback(() => {
    if (noProgress) return;
    const t = currentTime();
    if (t > 0) keepalive('PUT', `${base}/progress`, { position: t, duration });
  }, [base, duration, currentTime, noProgress]);

  // ---- Party mode ----
  // The party (server) owns play/pause/position. Our controls send commands; the pushed state is applied here,
  // programmatically. Every change we make ourselves is recorded in `applied`, and media events that match one
  // (isEcho) are never sent back. Media events are only sent at all when the video differs from the party's state.
  const partyRef = useRef(party);
  partyRef.current = party;
  const applied = useRef<{ type: 'play' | 'pause' | 'seek'; position: number; atClient: number }[]>([]);
  /** When we last moved the playhead ourselves (pushed seek, drift jump, stream start). */
  const lastAppliedSeek = useRef(0);
  /** A stream has been attached to the video (state is only applied to a loaded video). */
  const streamReady = useRef(false);
  /** The browser refused to start playback without a click (autoplay rules). */
  const playBlocked = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const playTimer = useRef<number>();
  const stallTimer = useRef<number>();
  /** In 'waiting' (no data to play). */
  const stalled = useRef(false);
  /** We told the party we're buffering and haven't said we're ready since. */
  const bufferingSent = useRef(false);
  /** Tell the party once this stream can play (after each stream start and after reporting a stall). */
  const needReady = useRef(false);
  /** When we recently held the party up (for a bigger buffer before saying ready again after repeated stalls). */
  const stalls = useRef<number[]>([]);
  const [partyMenu, setPartyMenu] = useState<null | 'members' | 'more'>(null);
  // Invite (accounts only): from a normal player the first click starts a party and moves into it.
  const canInvite = !!user && !party?.guest;
  // Read from the address bar itself, not the router: the params are stripped with history.replaceState (which
  // the router never sees), so the next episode's player (a new mount in the same party) finds none.
  const [inviteOpen, setInviteOpen] = useState(() => !!party && !party.guest && new URLSearchParams(window.location.search).has('invite'));
  /** The party was started from a playing video (?play=1): send play once this stream is first ready. */
  const playOnReady = useRef(!!party && !party.guest && new URLSearchParams(window.location.search).has('play'));
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  useEffect(() => {
    // The ?invite=1 (and ?play=1) that brought us here is used up.
    const q = new URLSearchParams(window.location.search);
    if (q.has('invite') || q.has('play')) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);
  const onInvite = async () => {
    setPartyMenu(null);
    if (party) return setInviteOpen((o) => !o);
    if (inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const wasPlaying = !!video.current && !video.current.paused;
      const r = await api.post<{ id: string }>('/api/party', { kind: info.kind, id: info.id, position: currentTime() });
      // The party starts paused; ?play=1 has the party player start it once its stream is ready.
      navigate(`/party/${encodeURIComponent(r.id)}?invite=1${wasPlaying ? '&play=1' : ''}`, { replace: true });
    } catch (e) {
      setInviteError((e as Error).message);
      setInviteBusy(false);
    }
  };

  const markApplied = (type: 'play' | 'pause' | 'seek', position: number) => {
    const now = Date.now();
    applied.current = [...applied.current.filter((a) => now - a.atClient < 1000), { type, position, atClient: now }];
  };
  const isOurs = (type: 'play' | 'pause' | 'seek', position: number) => {
    const ev = { type, position, atClient: Date.now() };
    return applied.current.some((a) => isEcho(a, ev));
  };
  const applySeek = (to: number) => {
    const v = video.current;
    if (!v) return;
    const t = Math.min(Math.max(0, to), Math.max(0, duration - 0.5));
    markApplied('seek', t);
    lastAppliedSeek.current = Date.now();
    v.currentTime = t;
    setTime(t);
  };
  const applyPlay = () => {
    const v = video.current;
    if (!v) return;
    markApplied('play', v.currentTime);
    v.play().then(
      () => {
        playBlocked.current = false;
        setBlocked(false);
      },
      (e: unknown) => {
        // Only an autoplay refusal needs a click; anything else (interrupted, not loaded yet) is retried by the tick.
        const refused = (e as { name?: string } | null)?.name === 'NotAllowedError';
        playBlocked.current = refused;
        setBlocked(refused);
        setPlaying(false);
      },
    );
  };
  const applyPause = () => {
    const v = video.current;
    if (!v) return;
    markApplied('pause', v.currentTime);
    v.pause();
  };

  /** Makes the video match the party's state: play/pause, and the position when it's off by more than drift fixes. */
  const applyParty = () => {
    const p = partyRef.current;
    const v = video.current;
    if (!p?.state || !v || !streamReady.current) return;
    // A push for the next title: the party page swaps this player out.
    if (p.title && (p.title.kind !== info.kind || p.title.id !== info.id)) return;
    window.clearTimeout(playTimer.current);
    const s = p.state;
    const now = p.clock.now();
    const end = duration - 0.5;
    if (!s.playing) {
      // Position first, so the pause is recorded at the position its event will report.
      if (v.readyState >= 1 && Math.abs(v.currentTime - Math.min(s.position, end)) > PARTY_PAUSED_TOLERANCE) applySeek(s.position);
      if (!v.paused) applyPause();
      if (v.playbackRate !== 1) v.playbackRate = 1;
      if (s.position < end - 1) setCountdown(null);
      return;
    }
    const target = expectedPosition(s, now);
    // The party is past the end: let this video finish (or stay finished) rather than replay its last moment.
    if (target >= end) return;
    setCountdown(null);
    const delay = s.at - now;
    if (v.readyState >= 1) {
      const off = Math.abs(v.currentTime - target);
      // Playing: drift correction handles small gaps. Paused: line up exactly before starting (cheap while paused).
      if (off > 1 || (v.paused && off > PARTY_PAUSED_TOLERANCE)) applySeek(delay > 0 ? s.position : target);
    }
    if (!v.paused) return;
    if (playBlocked.current) return; // waits for a click (the ▶ button)
    if (delay > 0) {
      // Everyone starts on the same server instant.
      playTimer.current = window.setTimeout(() => {
        if (video.current?.paused && partyRef.current?.state === s) applyPlay();
      }, delay);
    } else {
      applyPlay();
    }
  };
  const applyPartyRef = useRef(applyParty);
  applyPartyRef.current = applyParty;

  /**
   * Sends `buffering: false` once the video can play and has enough buffered ahead: 2 s, more after repeated
   * stalls (readyAhead), or the rest of the file. The browser saying it can play through isn't enough on its own.
   */
  const checkReady = () => {
    const p = partyRef.current;
    const v = video.current;
    if (!p || !v || !needReady.current || !streamReady.current || v.seeking || v.readyState < 3) return;
    const ahead = bufferedAhead(v.buffered, v.currentTime);
    if (!enoughBuffered(ahead, v.currentTime, duration, readyAhead(stalls.current, Date.now()))) return;
    if (!p.send({ t: 'buffering', on: false })) return; // not connected: tried again on the next check
    needReady.current = false;
    bufferingSent.current = false;
    // Started a party while the video was playing: play once this new stream is ready (no position jump).
    if (playOnReady.current) {
      playOnReady.current = false;
      if (!p.state?.playing) p.send({ t: 'play' });
    }
  };
  const checkReadyRef = useRef(checkReady);
  checkReadyRef.current = checkReady;

  /** Out of data while playing for > 300 ms (and over 1 s after we moved the playhead): hold the party. */
  const onPartyWaiting = () => {
    stalled.current = true;
    window.clearTimeout(stallTimer.current);
    const wait = Math.max(300, lastAppliedSeek.current + 1000 - Date.now());
    stallTimer.current = window.setTimeout(() => {
      const p = partyRef.current;
      const v = video.current;
      if (!p || !v || !stalled.current || bufferingSent.current || v.paused) return;
      if (v.readyState >= 3) {
        stalled.current = false;
        return;
      }
      if (p.send({ t: 'buffering', on: true })) {
        bufferingSent.current = true;
        needReady.current = true;
        stalls.current = recordStall(stalls.current, Date.now());
      }
    }, wait);
  };

  /**
   * Played or paused by something other than our controls (media keys, headphones, picture-in-picture):
   * passed on to the party, unless it's our own applied change, the video ending, or a stream (re)loading.
   */
  const onPartyMedia = (type: 'play' | 'pause') => {
    const p = partyRef.current;
    const v = video.current;
    if (!p?.state || !v || !streamReady.current) return;
    if (isOurs(type, v.currentTime)) return;
    if (type === 'play') {
      if (p.state.playing) return;
      // Hold it until the party's scheduled start, so everyone starts together.
      applyPause();
      p.send({ t: 'play' });
    } else {
      // Hidden pages get paused by the browser or the phone (switching apps): not a choice to pause everyone.
      if (!p.state.playing || v.ended || v.seeking || v.readyState < 2 || document.hidden) return;
      p.send({ t: 'pause' });
    }
  };

  // Each pushed state is applied once (a new object per push; applying is idempotent anyway).
  useEffect(() => {
    if (party) applyPartyRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.state]);

  // After a reconnect the server has forgotten that we were buffering.
  useEffect(() => {
    if (!party || party.connection <= 1) return;
    if (bufferingSent.current) party.send({ t: 'buffering', on: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.connection]);

  // Drift correction every 500 ms (and the readiness check).
  const partyTick = () => {
    const p = partyRef.current;
    const v = video.current;
    if (!p?.state || !v || !streamReady.current) return;
    checkReady();
    const s = p.state;
    if (!s.playing) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    const now = p.clock.now();
    if (now < s.at) return; // a scheduled start hasn't come yet
    const expected = expectedPosition(s, now);
    if (v.ended || expected >= duration - 0.5) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    if (v.paused) {
      // The party plays but this video doesn't (its start was cut short): start it, unless it needs a click.
      if (!playBlocked.current && v.readyState >= 1) applyParty();
      return;
    }
    // Not while loading: a jump would only add to the wait.
    if (v.seeking || v.readyState < 3 || stalled.current) return;
    const c = correction(v.currentTime, expected, v.playbackRate);
    if (c.kind === 'rate') v.playbackRate = c.rate;
    else if (c.kind === 'reset-rate') v.playbackRate = 1;
    else if (c.kind === 'jump') {
      v.playbackRate = 1;
      applySeek(c.to);
    }
  };
  const partyTickRef = useRef(partyTick);
  partyTickRef.current = partyTick;
  const inParty = !!party;
  useEffect(() => {
    if (!inParty) return;
    const t = window.setInterval(() => partyTickRef.current(), 500);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(playTimer.current);
      window.clearTimeout(stallTimer.current);
    };
  }, [inParty]);

  // Start (or restart, after changing audio/quality) the stream at `startAt`.
  useEffect(() => {
    if (start === null) return;
    const p0 = partyRef.current;
    // In a party, where the party is at the moment we ask (not when the player opened or the restart was
    // chosen), plus the time a converted stream takes to start while the party plays. Direct play lines up
    // again once the file opens (loadedmetadata), so aiming ahead does it no harm.
    const startAt = p0?.state
      ? Math.min(partyPosition(p0, duration) + (p0.state.playing ? HLS_STARTUP_S : 0), Math.max(0, duration - 0.5))
      : start.at;
    const v = video.current!;
    let cancelled = false;
    setError(null);
    setWaiting(true);
    if (partyRef.current) {
      // A (re)start counts as a move we made, and the party hears once this stream is ready.
      lastAppliedSeek.current = Date.now();
      needReady.current = true;
    }
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
            // Ask for the next piece while the current one is still being added, so playback starts sooner.
            startFragPrefetch: true,
            // Copied (not converted) pieces can leave a few-frame gap at a join; play through it instead of stalling.
            maxBufferHole: 0.5,
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
          // A party has moved on while the file opened: start where it is now.
          v.addEventListener('loadedmetadata', () => (v.currentTime = partyRef.current ? partyPosition(partyRef.current, duration) : startAt), { once: true });
        }
        if (partyRef.current) {
          // The party's state decides whether this plays.
          streamReady.current = true;
          lastAppliedSeek.current = Date.now();
          applyPartyRef.current();
        } else if (start.play === false) setPlaying(false);
        else v.play().catch(() => setPlaying(false));
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
      // The subtitle renderer is big, so it's only fetched once styled subtitles are turned on.
      const [fonts, { default: Jassub }] = await Promise.all([
        info.hasFonts ? api.get<string[]>(`${base}/fonts`).catch(() => []) : Promise.resolve([] as string[]),
        import('jassub'),
      ]);
      if (cancelled) return;
      subs.current = new Jassub({
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
  const restartHere = () =>
    partyRef.current
      ? setStart({ at: partyPosition(partyRef.current, duration) }) // the party's state decides play/pause
      : setStart({ at: Math.max(0, currentTime() - 1), play: !(video.current?.paused ?? false) });

  // While paused the player stops asking for video, and the server ends a stream nobody asks for in a
  // minute. So check in every 20 s while paused (up to 30 min; after that a restart picks up where you were).
  useEffect(() => {
    let pausedSince = 0;
    const t = window.setInterval(() => {
      const v = video.current;
      const id = session.current;
      if (!v || !id || !v.paused) {
        pausedSince = 0;
        return;
      }
      if (!pausedSince) pausedSince = Date.now();
      if (Date.now() - pausedSince > 30 * 60_000) return;
      fetch(`/api/play/hls/${id}/main.m3u8`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(t);
  }, []);

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

  /**
   * The ▶ Play button shown when the browser refused to autoplay: starts this video only (never a party
   * command, so it can't pause everyone, whatever state the button and the party are in).
   */
  const startBlocked = () => {
    const v = video.current;
    const p = partyRef.current;
    playBlocked.current = false;
    setBlocked(false);
    if (!v || !p?.state?.playing || !streamReady.current || !v.paused) return;
    if (expectedPosition(p.state, p.clock.now()) >= duration - 0.5) return;
    applyParty(); // lines up and starts (or schedules the start)
    if (v.paused && p.clock.now() >= p.state.at) applyPlay();
  };

  const togglePlay = () => {
    const v = video.current!;
    if (party) {
      const s = party.state;
      // The party plays but the browser wouldn't start this video without a click: this is that click.
      // Only when it really was refused (not while waiting for a scheduled start, which a click must not jump).
      if (playBlocked.current && s?.playing && v.paused && streamReady.current && expectedPosition(s, party.clock.now()) < duration - 0.5) {
        startBlocked();
        return;
      }
      // Everyone's video changes when the party's new state comes back.
      party.send(s?.playing ? { t: 'pause' } : { t: 'play' });
      return;
    }
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  };
  const seek = (t: number, byUser = true) => {
    if (byUser) lastUserSeek.current = Date.now();
    const v = video.current!;
    const to = Math.min(Math.max(0, t), duration - 0.5);
    if (party) {
      party.send({ t: 'seek', p: to });
      setTime(to); // the bar moves right away; the video follows the party's answer
      return;
    }
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
  // In a party, Next moves everyone (the party page follows the new title); there's no Previous.
  const partyNext = () => {
    if (!party || !info.next || info.kind !== 'episode') return;
    party.send({ t: 'next', from: info.id });
    setCountdown(null);
  };
  const goNext = () => (party ? partyNext() : goTo(info.next));
  const goPrev = () => (party ? undefined : goTo(info.prev));

  // Controls: shown on any real mouse movement, hidden 3 s later while playing. They stay up while the
  // pointer is on them or a menu is open. Chrome also sends "moves" when nothing moved (e.g. when the
  // cursor hides in fullscreen); those are ignored, or the controls would flash back right after hiding.
  const overControls = useRef(false);
  const menuOpen = useRef(false);
  menuOpen.current = menu !== null || partyMenu !== null || inviteOpen;
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
  // Leaving the page: a pending hide or seek-bar drag mustn't fire afterwards (a drag would start a new stream).
  useEffect(
    () => () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(scrubTimer.current);
    },
    [],
  );
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
      else if (e.key === 'Escape' && partyMenu) setPartyMenu(null);
      else if (e.key === 'Escape' && inviteOpen) setInviteOpen(false);
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
      className={`watch${controls || !playing ? ' show-controls' : ''}`}
      onTouchStart={poke}
    >
      <video
        ref={video}
        className="watch-video"
        playsInline
        // A party video waits paused for the others, so it should keep loading meanwhile.
        preload={party ? 'auto' : undefined}
        onClick={togglePlay}
        onDoubleClick={fullscreen}
        onPlay={() => {
          setPlaying(true);
          if (party) onPartyMedia('play');
        }}
        onPause={() => {
          setPlaying(false);
          saveProgress();
          if (party) {
            stalled.current = false;
            onPartyMedia('pause');
          }
        }}
        onWaiting={() => {
          setWaiting(true);
          if (party) onPartyWaiting();
        }}
        onPlaying={() => {
          setWaiting(false);
          if (party) stalled.current = false;
        }}
        onCanPlay={() => {
          setWaiting(false);
          if (party) {
            stalled.current = false;
            checkReadyRef.current();
          }
        }}
        onProgress={party ? () => checkReadyRef.current() : undefined}
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
          {!party?.guest && (
            <button className="btn" onClick={() => navigate(-1)}>
              Back
            </button>
          )}
        </div>
      )}

      {party && party.waitingFor.length > 0 && (
        <div className="watch-party-wait" role="status">
          {waitingLabel(party.waitingFor)}
        </div>
      )}
      {party && blocked && !playing && party.state?.playing && !error && (
        <button className="btn primary watch-party-start" onClick={startBlocked}>
          ▶ Play
        </button>
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

      {debug && <DiagReadout diag={diag} controls={controls} playing={playing} shell={shell} />}
      {/* Invites reach you while you watch too (accounts only; not in a party). Inside the player, so it shows in fullscreen. */}
      {!party && !!user && <InvitePopup />}
      <div className="watch-top" {...onControls}>
        {!party?.guest && (
          <button className="watch-icon" aria-label="Back" onClick={() => navigate(-1)}>
            ←
          </button>
        )}
        <div className="watch-title">
          <strong>{info.title}</strong>
          {info.subtitle && <span>{info.subtitle}</span>}
        </div>
        {(party || canInvite) && <span className="watch-spacer" />}
        {canInvite && (
          <div className="watch-party-wrap">
            <button
              className="watch-party-count"
              aria-expanded={inviteOpen}
              aria-haspopup="dialog"
              disabled={inviteBusy}
              title={inviteError ?? undefined}
              onClick={onInvite}
            >
              {inviteBusy ? 'Starting…' : inviteError ? '👥 Invite (retry)' : '👥 Invite'}
            </button>
            {party && inviteOpen && (
              <InvitePanel partyId={party.id} mediaId={info.mediaId} guestInviteAllowed={party.guestInviteAllowed} onClose={() => setInviteOpen(false)} />
            )}
          </div>
        )}
        {party && (
          <>
            <div
              className="watch-party-wrap"
              // Hover shows the names with a mouse; a tap (the button) toggles them.
              onPointerEnter={(e) => e.pointerType === 'mouse' && partyMenu === null && setPartyMenu('members')}
              onPointerLeave={(e) => e.pointerType === 'mouse' && partyMenu === 'members' && setPartyMenu(null)}
            >
              <button
                className="watch-party-count"
                aria-expanded={partyMenu === 'members'}
                onClick={() => setPartyMenu(partyMenu === 'members' ? null : 'members')}
              >
                {party.status === 'live' ? `👥 ${party.members.filter((m) => m.connected).length} watching` : 'Reconnecting…'}
              </button>
              {partyMenu === 'members' && (
                <div className="watch-menu watch-party-pop" role="dialog" aria-label="Watching">
                  {party.members
                    .filter((m) => m.connected)
                    .map((m) => (
                      <div key={m.key} className="watch-party-member">
                        {m.name}
                        {m.buffering && <small>loading</small>}
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div className="watch-party-wrap">
              <button
                className="watch-icon"
                aria-label="Party options"
                aria-expanded={partyMenu === 'more'}
                onClick={() => setPartyMenu(partyMenu === 'more' ? null : 'more')}
              >
                ⋯
              </button>
              {partyMenu === 'more' && (
                <div className="watch-menu watch-party-pop" role="menu" aria-label="Party options">
                  <button className="watch-row" role="menuitem" onClick={() => { setPartyMenu(null); party.onLeave(); }}>
                    <span>Leave party</span>
                  </button>
                  {party.isHost && (
                    <button className="watch-row" role="menuitem" onClick={() => { setPartyMenu(null); party.onEnd(); }}>
                      <span>End party for everyone</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
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
          {info.kind === 'episode' && !party && (
            <button className="watch-icon" aria-label="Previous episode" title={info.prev ? `Previous: ${info.prev.label} (Shift+P)` : 'No previous episode'} disabled={!info.prev} onClick={goPrev}>
              ⏮
            </button>
          )}
          <button className="watch-icon" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
            {playing ? '❚❚' : '▶'}
          </button>
          {info.kind === 'episode' && !party?.guest && (
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
                {!party && (
                  <button className="watch-row" role="menuitemcheckbox" aria-checked={autoSkip} onClick={toggleAutoSkip}>
                    <span>
                      Auto-skip intro &amp; credits
                      <small className="watch-row-hint">{info.next ? 'Credits go straight to the next episode' : 'Jumps past them when they start'}</small>
                    </span>
                    <span className={`watch-switch${autoSkip ? ' on' : ''}`} aria-hidden />
                  </button>
                )}
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
