import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface Invitee {
  id: number;
  username: string;
}

/** Copies text; falls back to selecting the box when the clipboard API is missing (plain-HTTP LAN access). */
async function copy(text: string, box: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  if (box) {
    box.hidden = false;
    box.value = text;
    box.focus();
    box.select();
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      // the text stays selected for a manual copy
    }
  }
  return false;
}

/** "Invite to watch": pick accounts to notify, or copy a guest link. Closes on Escape. */
export default function InvitePanel({
  partyId,
  mediaId,
  guestInviteAllowed,
  onClose,
}: {
  partyId: string;
  mediaId: number;
  guestInviteAllowed: boolean;
  onClose: () => void;
}) {
  const people = useQuery({
    queryKey: ['party-invitees', mediaId],
    queryFn: () => api.get<Invitee[]>(`/api/party/invitees?mediaId=${mediaId}`),
    staleTime: 0,
    gcTime: 0,
  });
  const [search, setSearch] = useState('');
  const [invited, setInvited] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (people.data ?? []).filter((u) => !q || u.username.toLowerCase().includes(q));
  }, [people.data, search]);

  const invite = async (u: Invitee) => {
    setBusy(u.id);
    setError(null);
    try {
      await api.post(`/api/party/${encodeURIComponent(partyId)}/invite`, { userIds: [u.id] });
      setInvited((s) => new Set(s).add(u.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    setLinkBusy(true);
    setError(null);
    try {
      let url = link;
      if (!url) {
        const r = await api.post<{ url: string }>(`/api/party/${encodeURIComponent(partyId)}/guest-link`);
        url = window.location.origin + r.url;
        setLink(url);
      }
      const ok = await copy(url, box.current);
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <div className="watch-menu watch-party-pop invite-panel" role="dialog" aria-label="Invite to watch">
      <div className="invite-title">Invite to watch</div>
      <input
        className="invite-search"
        type="search"
        placeholder="Search users…"
        aria-label="Search users"
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="invite-list">
        {people.isLoading && <div className="invite-note">Loading…</div>}
        {people.error && <div className="invite-note">{(people.error as Error).message}</div>}
        {people.data && shown.length === 0 && <div className="invite-note">{search ? 'No one matches' : 'No one to invite'}</div>}
        {shown.map((u) => (
          <div key={u.id} className="invite-row">
            <span className="invite-name">{u.username}</span>
            <button type="button" className="invite-btn" disabled={invited.has(u.id) || busy === u.id} onClick={() => invite(u)}>
              {invited.has(u.id) ? '✓ Invited' : 'Invite'}
            </button>
          </div>
        ))}
      </div>
      {guestInviteAllowed && (
        <div className="invite-guest">
          <div className="invite-row">
            <span className="invite-name">🔗 Guest invite</span>
            <button type="button" className="invite-btn" disabled={linkBusy} onClick={copyLink}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {/* Only revealed (and selected) when the clipboard isn't available. */}
          <input ref={box} className="invite-link" readOnly hidden aria-label="Guest link" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {error && <div className="invite-note invite-error">{error}</div>}
    </div>
  );
}
