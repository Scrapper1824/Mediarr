import { db } from '../db.js';

export interface PartyInvitePayload {
  partyId: string;
  from: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
}

/** Whether a party is still running. Task 3 (the party registry) supplies the real check. */
let partyActive: (id: string) => boolean = () => false;
export function setPartyActiveCheck(fn: (id: string) => boolean): void {
  partyActive = fn;
}
export const isPartyActive = (id: string): boolean => partyActive(id);

export function notify(userId: number, kind: 'party_invite', payload: PartyInvitePayload): number {
  const r = db
    .prepare('INSERT INTO notifications (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, kind, JSON.stringify(payload), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

interface Row {
  id: number;
  kind: string;
  payload: string;
  created_at: string;
  read_at: string | null;
}

export function listNotifications(userId: number, limit = 50) {
  const rows = db
    .prepare('SELECT id, kind, payload, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: JSON.parse(r.payload) as PartyInvitePayload,
    createdAt: r.created_at,
    read: r.read_at !== null,
  }));
}

export function unreadCount(userId: number): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number };
  return r.n;
}

export function markRead(userId: number, ids: number[] | 'all'): void {
  const now = new Date().toISOString();
  if (ids === 'all') {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId);
    return;
  }
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
  for (const id of ids) stmt.run(now, userId, id);
}

/** Removes one of the user's own notifications; returns whether it existed. */
export function dismiss(userId: number, id: number): boolean {
  return Number(db.prepare('DELETE FROM notifications WHERE user_id = ? AND id = ?').run(userId, id).changes) > 0;
}
