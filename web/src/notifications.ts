// Notifications (watch-party invites): the shared poll and the rule for which invites pop up.
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface PartyInvitePayload {
  partyId: string;
  from: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
}
export interface NotificationItem {
  id: number;
  kind: 'party_invite';
  payload: PartyInvitePayload;
  createdAt: string;
  read: boolean;
  active: boolean;
}
export interface Notifications {
  unread: number;
  items: NotificationItem[];
}

/** Invites seen at the very first load only pop up when they are this fresh (ms). */
export const FRESH_MS = 2 * 60_000;

/** Polled every 5 s; React Query pauses it while the tab is in the background. */
export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<Notifications>('/api/notifications'),
    refetchInterval: 5000,
  });
}

/** "Intro Test · S01E01" */
export const inviteTitle = (p: PartyInvitePayload) => (p.subtitle ? `${p.title} · ${p.subtitle}` : p.title);

/**
 * Which invites should pop up now: unread, still joinable, never shown before (`seen`), and, on the
 * first load (`first`), only fresh ones, so an old unread invite doesn't pop up every time the app opens.
 */
export function invitesToPop(items: NotificationItem[], seen: ReadonlySet<number>, first: boolean, now: number): NotificationItem[] {
  return items.filter((n) => {
    if (n.kind !== 'party_invite' || n.read || !n.active || seen.has(n.id)) return false;
    if (!first) return true;
    const at = Date.parse(n.createdAt);
    return Number.isFinite(at) && now - at <= FRESH_MS;
  });
}
