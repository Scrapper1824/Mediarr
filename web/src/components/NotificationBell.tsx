import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { inviteTitle, useNotifications } from '../notifications';

/** 🔔 with an unread badge; the menu lists invites with Join (while the party is live) or Ended. */
export default function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const unread = data?.unread ?? 0;
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({
    mutationFn: (ids: number[] | 'all') => api.post('/api/notifications/read', { ids }),
    onSettled: refresh,
  });
  const dismiss = useMutation({ mutationFn: (id: number) => api.del(`/api/notifications/${id}`), onSettled: refresh });

  // Opening the menu reads everything.
  useEffect(() => {
    if (open && unread > 0 && !markRead.isPending) markRead.mutate('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unread]);

  // Drawn over the page, above the button (it sits at the bottom of the sidebar).
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const position = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(320, window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      setPlace({ bottom: window.innerHeight - r.top + 8, left, width });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!trigger.current?.contains(n) && !pop.current?.contains(n)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const items = data?.items ?? [];
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-btn bell"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="bell-menu" role="menu" aria-label="Notifications" style={place ?? { visibility: 'hidden', top: 0, left: 0 }}>
            {items.length === 0 && <div className="bell-empty">No notifications</div>}
            {items.map((n) => (
              <div key={n.id} className="bell-item" role="none">
                <div className="bell-text">
                  <strong>{n.payload.from}</strong> invited you to watch <strong>{inviteTitle(n.payload)}</strong>
                </div>
                {n.active ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn small primary"
                    onClick={() => {
                      setOpen(false);
                      markRead.mutate([n.id]);
                      navigate(`/party/${encodeURIComponent(n.payload.partyId)}`);
                    }}
                  >
                    Join
                  </button>
                ) : (
                  <span className="bell-ended">Ended</span>
                )}
                <button type="button" className="icon-btn bell-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss.mutate(n.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
