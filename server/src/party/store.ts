// In-memory registry of watch parties (they don't survive a restart) and its housekeeping.
import crypto from 'node:crypto';
import { endUserSessions } from '../playback/sessions.js';
import { matchesHash, newInviteCode, newSecret, parseGuestCookie, sha256 } from './guest.js';
import { addMember, newParty, principalKey, removeMember, shouldEnd, viewerId, type Party, type Principal, type Title } from './state.js';

/** Ended parties stay readable (as ended) for members for a while, then are forgotten. */
const KEEP_ENDED_MS = 60 * 60_000;
const SWEEP_MS = 30_000;
/** Guests per party; a guest link can't be used to fill the server's memory. */
export const MAX_GUESTS = 50;

const parties = new Map<string, Party>();
const endedAt = new Map<string, number>();
/** Plain guest invite codes (only their hash is on the party), so "Guest invite" returns the same link. */
const inviteCodes = new Map<string, string>();
/** Accounts already invited to each party (an invite isn't sent twice). */
const invitedUsers = new Map<string, Set<number>>();
const endedListeners: ((p: Party) => void)[] = [];
/** Guest ids are unique across parties: they're playback session owners (-guestId). */
let guestSeq = 0;

const titleKey = (t: Title) => `${t.kind}:${t.id}`;

export function createParty(host: Principal & { type: 'user' }, mediaId: number, title: Title, position: number): Party {
  const id = crypto.randomBytes(16).toString('hex');
  const p = newParty(id, host, mediaId, title, position, Date.now());
  addMember(p, host);
  parties.set(id, p);
  return p;
}

/** A running party, or null (unknown or ended). */
export function getParty(id: string): Party | null {
  const p = parties.get(id);
  return p && !p.ended ? p : null;
}

/** Running or recently ended. */
export function findParty(id: string): Party | null {
  return parties.get(id) ?? null;
}

export const isPartyActive = (id: string): boolean => getParty(id) !== null;

/** Called with each party that ends (sockets close on it). */
export function onPartyEnded(cb: (p: Party) => void): () => void {
  endedListeners.push(cb);
  return () => {
    const i = endedListeners.indexOf(cb);
    if (i >= 0) endedListeners.splice(i, 1);
  };
}

/** Ends a party for everyone: its streams stop and every guest cookie for it stops working. */
export function endParty(id: string): void {
  const p = getParty(id);
  if (!p) return;
  p.ended = true;
  p.guestTokenHash = null;
  endedAt.set(id, Date.now());
  inviteCodes.delete(id);
  invitedUsers.delete(id);
  for (const m of p.members.values()) {
    // A guest's every stream belongs to this party; an account's only its stream of the party's title.
    if (m.principal.type === 'guest') endUserSessions(viewerId(m.principal));
    else endUserSessions(viewerId(m.principal), titleKey(p.title));
  }
  for (const cb of [...endedListeners]) {
    try {
      cb(p);
    } catch (err) {
      console.warn('[party] ended listener failed', err);
    }
  }
}

/** Takes someone out of a party and stops their stream of it. */
export function leaveParty(p: Party, principal: Principal): void {
  removeMember(p, principalKey(principal), Date.now());
  if (principal.type === 'guest') endUserSessions(viewerId(principal));
  else endUserSessions(viewerId(principal), titleKey(p.title));
}

/** The party's guest invite code, made on first use. */
export function guestInviteCode(p: Party): string {
  let code = inviteCodes.get(p.id);
  if (!code || !p.guestTokenHash) {
    code = newInviteCode();
    inviteCodes.set(p.id, code);
    p.guestTokenHash = sha256(code);
  }
  return code;
}

export const inviteCodeMatches = (p: Party, code: string) => matchesHash(code, p.guestTokenHash);

export function guestCount(p: Party): number {
  let n = 0;
  for (const m of p.members.values()) if (m.principal.type === 'guest') n++;
  return n;
}

/** Adds a guest member; returns the cookie value `<partyId>.<guestId>.<secret>`. */
export function addGuest(p: Party, name: string): { guestId: number; cookie: string } {
  const guestId = ++guestSeq;
  const secret = newSecret();
  addMember(p, { type: 'guest', guestId, name }, sha256(secret));
  return { guestId, cookie: `${p.id}.${guestId}.${secret}` };
}

/** The guest a cookie belongs to, only while the party runs and they're still in it. */
export function partyForGuestToken(token: string | undefined): { party: Party; guestId: number; name: string } | null {
  const c = parseGuestCookie(token);
  if (!c) return null;
  const party = getParty(c.partyId);
  const m = party?.members.get(`g:${c.guestId}`);
  if (!party || !m || m.principal.type !== 'guest' || !matchesHash(c.secret, m.tokenHash)) return null;
  return { party, guestId: c.guestId, name: m.principal.name };
}

/** Whether this viewer (user id, or -guestId) is in a running party currently on `title`: their stream skips the conversion limit. */
export function isPartyMember(viewer: number, title: Title): boolean {
  const key = viewer > 0 ? `u:${viewer}` : `g:${-viewer}`;
  for (const p of parties.values()) {
    if (!p.ended && p.title.kind === title.kind && p.title.id === title.id && p.members.has(key)) return true;
  }
  return false;
}

/** Records invites; returns which of `userIds` weren't invited to this party before. */
export function markInvited(p: Party, userIds: number[]): number[] {
  let set = invitedUsers.get(p.id);
  if (!set) invitedUsers.set(p.id, (set = new Set()));
  const fresh = userIds.filter((id) => !set.has(id));
  for (const id of fresh) set.add(id);
  return fresh;
}

/** Ends parties nobody has been in for a while; forgets long-ended ones. */
export function sweepParties(now = Date.now()): void {
  for (const p of [...parties.values()]) {
    if (!p.ended && shouldEnd(p, now)) endParty(p.id);
  }
  for (const [id, at] of [...endedAt]) {
    if (now - at > KEEP_ENDED_MS) {
      endedAt.delete(id);
      parties.delete(id);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startParties(): void {
  if (!timer) timer = setInterval(() => sweepParties(), SWEEP_MS).unref();
}

export function stopParties(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests. */
export function resetParties(): void {
  parties.clear();
  endedAt.clear();
  inviteCodes.clear();
  invitedUsers.clear();
}
