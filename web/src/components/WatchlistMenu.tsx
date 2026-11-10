import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, WATCH_STATUSES, watchStatusLabel, type MediaType, type WatchStatus } from '../api';

/**
 * Status picker for one title on the user's watchlists: pick a status to add/move it, or remove it.
 * Writes to every connected service that supports the title (AniList only takes anime).
 */
export default function WatchlistMenu({
  type,
  id,
  status,
  className,
  compact,
}: {
  type: MediaType;
  id: number;
  status: WatchStatus | null;
  className?: string;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // The list is drawn over the whole page (poster cards and the details sheet clip anything inside them),
  // next to the button: below it when there's room, otherwise above.
  const [place, setPlace] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const position = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const height = pop.current?.offsetHeight ?? 260;
      const width = Math.max(190, r.width);
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom - 8 >= height || r.top < height + 8;
      setPlace(below ? { top: r.bottom + 6, left, minWidth: width } : { bottom: window.innerHeight - r.top + 6, left, minWidth: width });
    };
    position();
    // Measured again once the list exists (its real height decides above/below).
    const frame = requestAnimationFrame(position);
    window.addEventListener('resize', position);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', position);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (n: Node) => box.current?.contains(n) || pop.current?.contains(n);
    const close = (e: MouseEvent) => !inside(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false));
    // Scrolling the page would leave the list behind: close it instead.
    const scrolled = (e: Event) => !inside(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [open]);

  const done = (r: { warnings?: string[] }) => {
    setWarning(r.warnings?.length ? r.warnings.join(' ') : null);
    qc.invalidateQueries({ queryKey: ['watchlist'] });
  };
  const set = useMutation({
    mutationFn: (s: WatchStatus) =>
      api.put<{ warnings: string[] }>('/api/watchlist/item', {
        type,
        id,
        status: s,
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.del<{ warnings: string[] }>(`/api/watchlist/item?type=${type}&id=${id}`),
    onSuccess: done,
  });
  const busy = set.isPending || remove.isPending;
  const error = (set.error ?? remove.error) as Error | null;

  return (
    <div className={`wl-menu${className ? ` ${className}` : ''}`} ref={box} onClick={(e) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className={compact ? `btn small full${status ? '' : ' ghost'}` : 'hero-secondary'}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? 'Saving…' : status ? `✓ ${watchStatusLabel[status]}` : '＋ Watchlist'}
        <span aria-hidden className="wl-caret">
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className="wl-popover"
            role="menu"
            style={place ?? { visibility: 'hidden', top: 0, left: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {WATCH_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={s === status}
                className={s === status ? 'active' : ''}
                onClick={() => {
                  setOpen(false);
                  if (s !== status) set.mutate(s);
                }}
              >
                {watchStatusLabel[s]}
              </button>
            ))}
            {status && (
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setOpen(false);
                  remove.mutate();
                }}
              >
                Remove from watchlist
              </button>
            )}
          </div>,
          document.body,
        )}
      {error && <div className="error-text small wl-note">{error.message}</div>}
      {!error && warning && <div className="muted small wl-note">{warning}</div>}
    </div>
  );
}
