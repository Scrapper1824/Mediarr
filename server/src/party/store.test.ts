import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import type { Decision } from '../playback/decide.js';
import { usePlaybackDataDir } from '../playback/ffmpeg.js';
import type { MediaProbe } from '../playback/probe.js';
import { activeSessions, createSession, startPlayback, stopPlayback, useLauncher } from '../playback/sessions.js';
import {
  addGuest, createParty, endParty, getParty, isPartyMember, leaveParty, onPartyEnded, partyForGuestToken, resetParties, sweepParties,
} from './store.js';
import { EMPTY_END_MS } from './state.js';

const probe: MediaProbe = {
  container: 'matroska,webm',
  duration: 100,
  bitrate: 0,
  video: { index: 0, codec: 'hevc', profile: null, pixFmt: 'yuv420p', bitDepth: 8, width: 1920, height: 1080 },
  audio: [],
  subtitles: [],
  fonts: [],
};
const decision: Decision = { mode: 'transcode', reason: '', audio: null, burnSubtitle: null, height: null, videoBitrate: 8e6 };
const stream = (userId: number, title: string) =>
  createSession({ userId, title, file: 'C:\\lib\\x.mkv', ffmpeg: 'ffmpeg', probe, decision, encoder: 'libx264', startAt: 0, exempt: true });
const host = { type: 'user', userId: 1, name: 'host' } as const;
let tmp: string;

beforeEach(() => {
  initDb(':memory:');
  resetParties();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-partystore-'));
  usePlaybackDataDir(tmp);
  saveSettings({ maxTranscodes: 4 });
  startPlayback();
  // An encoder stand-in that just idles until killed.
  useLauncher(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }));
});
afterEach(() => {
  stopPlayback();
  resetParties();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('party store', () => {
  it('ending a party stops its members’ streams of it and tells listeners', () => {
    const p = createParty(host, 10, { kind: 'episode', id: 5 }, 0);
    const { guestId } = addGuest(p, 'Guest 2');
    stream(1, 'episode:5');
    stream(-guestId, 'episode:5');
    stream(2, 'episode:5'); // not in the party
    const ended: string[] = [];
    const off = onPartyEnded((x) => ended.push(x.id));
    expect(isPartyMember(1, { kind: 'episode', id: 5 })).toBe(true);
    expect(isPartyMember(-guestId, { kind: 'episode', id: 5 })).toBe(true);
    expect(isPartyMember(2, { kind: 'episode', id: 5 })).toBe(false);
    expect(isPartyMember(1, { kind: 'episode', id: 6 })).toBe(false);
    endParty(p.id);
    off();
    expect(ended).toEqual([p.id]);
    expect(activeSessions().map((s) => s.userId)).toEqual([2]);
    expect(getParty(p.id)).toBeNull();
    expect(isPartyMember(1, { kind: 'episode', id: 5 })).toBe(false);
  });

  it('an account’s other stream survives the party ending', () => {
    const p = createParty(host, 10, { kind: 'episode', id: 5 }, 0);
    stream(1, 'movie:99');
    endParty(p.id);
    expect(activeSessions().map((s) => s.title)).toEqual(['movie:99']);
  });

  it('guest ids are unique across parties, and a guest token is only good for its own party while they are in it', () => {
    const a = createParty(host, 10, { kind: 'movie', id: 10 }, 0);
    const b = createParty(host, 11, { kind: 'movie', id: 11 }, 0);
    const ga = addGuest(a, 'A');
    const gb = addGuest(b, 'B');
    expect(ga.guestId).not.toBe(gb.guestId);
    expect(partyForGuestToken(ga.cookie)).toMatchObject({ party: a, guestId: ga.guestId, name: 'A' });
    const [, gid, secret] = ga.cookie.split('.');
    expect(partyForGuestToken(`${b.id}.${gid}.${secret}`)).toBeNull();
    stream(-ga.guestId, 'movie:10');
    leaveParty(a, { type: 'guest', guestId: ga.guestId, name: 'A' });
    expect(partyForGuestToken(ga.cookie)).toBeNull();
    expect(activeSessions()).toEqual([]);
  });

  it('the sweeper ends parties nobody has been in for 10 minutes', () => {
    const p = createParty(host, 10, { kind: 'movie', id: 10 }, 0);
    sweepParties(Date.now() + 1000);
    expect(getParty(p.id)).not.toBeNull();
    sweepParties(Date.now() + EMPTY_END_MS + 1000);
    expect(getParty(p.id)).toBeNull();
  });
});
