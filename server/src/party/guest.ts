// Guest principal helpers: the guest cookie and the hashes kept for it. No state here.
import crypto from 'node:crypto';

export const GUEST_COOKIE = 'mediarr_guest';
export const GUEST_NAME_MAX = 24;

/** 32 random bytes, base64url (43 characters). Used for each guest's cookie secret. */
export const newSecret = () => crypto.randomBytes(32).toString('base64url');
/** 24 random bytes (192 bits), base64url: a party's guest invite code. */
export const newInviteCode = () => crypto.randomBytes(24).toString('base64url');

export const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Compares `secret`'s hash with a stored hash without leaking how much matched. */
export function matchesHash(secret: string, storedHex: string | null | undefined): boolean {
  if (!storedHex) return false;
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const COOKIE_RE = /^([0-9a-f]{32})\.([1-9]\d{0,8})\.([A-Za-z0-9_-]{43})$/;

/** `<partyId>.<guestId>.<secret>`, or null when it isn't one. */
export function parseGuestCookie(value: string | undefined): { partyId: string; guestId: number; secret: string } | null {
  const m = value ? COOKIE_RE.exec(value) : null;
  return m ? { partyId: m[1], guestId: Number(m[2]), secret: m[3] } : null;
}

export function guestCookie(value: string, secure: boolean): string {
  return [`${GUEST_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearGuestCookie(secure: boolean): string {
  return [`${GUEST_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

/** Display name: control/format characters removed, trimmed, at most 24 characters; empty → `fallback`. */
export function cleanGuestName(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim() : '';
  const name = Array.from(text).slice(0, GUEST_NAME_MAX).join('').trim();
  return name || fallback;
}
