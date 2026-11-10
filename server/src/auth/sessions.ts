import crypto from 'node:crypto';
import { db, now } from '../db.js';

export const SESSION_COOKIE = 'mediarr_session';
/** Signed out after this long without activity. */
export const IDLE_MS = 7 * 24 * 3600_000;
/** Signed out after this long no matter what. */
export const ABSOLUTE_MS = 30 * 24 * 3600_000;

export type Role = 'admin' | 'user';

export interface UserRow {
  id: number;
  username: string;
  role: Role;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_counter: number;
  created_at: string;
  password_changed_at: string;
}

interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: string;
  last_seen: string;
  expires_at: string;
}

// Only a hash of the token is stored, so a leaked database can't be used to log in.
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(userId: number, ip: string, userAgent: string | undefined): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, now(), now(), new Date(t + ABSOLUTE_MS).toISOString(), ip, (userAgent ?? '').slice(0, 300));
  return token;
}

/** The signed-in user for a session token, or null. Expired/idle sessions are removed. */
export function userForSession(token: string | undefined): UserRow | null {
  if (!token || token.length > 100) return null;
  const hash = hashToken(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash) as SessionRow | undefined;
  if (!s) return null;
  const t = Date.now();
  if (t > new Date(s.expires_at).getTime() || t - new Date(s.last_seen).getTime() > IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Refresh "last seen" at most once a minute to keep writes low.
  if (t - new Date(s.last_seen).getTime() > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), hash);
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined) ?? null;
}

export function deleteSession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Signs out every session of a user, optionally keeping the current one. */
export function deleteUserSessions(userId: number, keepToken?: string) {
  if (keepToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function countSessions(userId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number }).n;
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now(), new Date(Date.now() - IDLE_MS).toISOString());
}

export function adminCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
}

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}
