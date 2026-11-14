import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { inviteTitle, invitesToPop, useNotifications, type NotificationItem } from '../notifications';

const SHOW_MS = 30_000;

/**
 * A card when someone invites you; gone after 30 s. Mounted in the app shell and in the normal (non-party)
 * player, inside its fullscreen element so it shows in fullscreen too.
 */
export default function InvitePopup() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const seen = useRef(new Set<number>());
  const first = useRef(true);
  const [queue, setQueue] = useState<NotificationItem[]>([]);

  useEffect(() => {
    if (!data) return;
    const fresh = invitesToPop(data.items, seen.current, first.current, Date.now());
    first.current = false;
    for (const n of data.items) seen.current.add(n.id);
    if (fresh.length) setQueue((q) => [...q, ...[...fresh].reverse()]); // oldest first
  }, [data]);

  // Anything read or ended elsewhere (the 🔔 menu, another tab) is not shown any more.
  const live = queue.filter((q) => data?.items.some((n) => n.id === q.id && !n.read && n.active));
  const current = live[0];

  const read = useMutation({
    mutationFn: (id: number) => api.post('/api/notifications/read', { ids: [id] }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const drop = (id: number) => setQueue((q) => q.filter((n) => n.id !== id));

  const id = current?.id;
  useEffect(() => {
    if (id === undefined) return;
    const t = window.setTimeout(() => setQueue((q) => q.filter((n) => n.id !== id)), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [id]);

  if (!current) return null;
  const p = current.payload;
  return (
    <div className="invite-popup" role="alert">
      <div className="invite-popup-head">🎬 {p.from} invited you to watch</div>
      <div className="invite-popup-title">{inviteTitle(p)}</div>
      <div className="invite-popup-actions">
        <button
          type="button"
          className="btn small ghost"
          onClick={() => {
            drop(current.id);
            read.mutate(current.id);
          }}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            drop(current.id);
            read.mutate(current.id);
            navigate(`/party/${encodeURIComponent(p.partyId)}`);
          }}
        >
          Join
        </button>
      </div>
    </div>
  );
}
