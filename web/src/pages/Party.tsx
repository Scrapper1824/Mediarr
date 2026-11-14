// Watch Together pages: /party/:id (signed-in members) and /party/:id/guest (guest link: join, then the bare player).
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type PartyInfo } from '../api';
import { useAuth } from '../components/AuthGate';
import { useParty, type PartyBinding } from '../party/useParty';
import Spinner from '../components/Spinner';
import { Player, type PlayInfo } from './Watch';

/** A full-screen line of text on the player's black background (guests: nothing else on the page). */
function Message({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="watch watch-message">
      <p>{children}</p>
      {actions}
    </div>
  );
}

/** The party itself: connection, the current title's info, and the player in party mode. */
function PartyRoom({ id, guest, onLeft }: { id: string; guest: boolean; onLeft?: () => void }) {
  const p = useParty(id);
  const navigate = useNavigate();
  const t = p.title;
  const over = p.status === 'ended' || p.status === 'replaced' || p.status === 'error';
  const info = useQuery({
    queryKey: ['party-play', t?.kind, t?.id],
    queryFn: () => api.get<PlayInfo>(`/api/play/${t!.kind}/${t!.id}/info`),
    enabled: !!t && !over,
    staleTime: 0,
    gcTime: 0,
  });

  const home = guest ? undefined : (
    <Link className="btn" to="/">
      Home
    </Link>
  );
  if (p.status === 'ended') return <Message actions={home}>This watch party has ended.</Message>;
  if (p.status === 'replaced') return <Message actions={home}>This party is open in another tab</Message>;
  if (p.status === 'error') return <Message actions={home}>{p.error}</Message>;
  if (info.error) return <Message actions={home}>{(info.error as Error).message}</Message>;

  const d = info.data;
  // The player starts once it knows the title, the party's state and the server's clock.
  if (!t || !d || d.kind !== t.kind || d.id !== t.id || !p.state || !p.synced) {
    return <Message>{p.status === 'connecting' && d ? 'Connecting…' : 'Loading…'}</Message>;
  }

  const binding: PartyBinding = {
    send: p.send,
    state: p.state,
    title: t,
    members: p.members,
    waitingFor: p.waitingFor,
    clock: p.clock,
    guest,
    isHost: !!p.party?.isHost,
    status: p.status,
    connection: p.connection,
    onLeave: () => {
      const mediaId = p.party?.mediaId;
      api
        .post(`/api/party/${encodeURIComponent(id)}/leave`)
        .catch(() => undefined)
        .finally(() => {
          if (guest) onLeft?.();
          else navigate(mediaId ? `/media/${mediaId}` : '/', { replace: true });
        });
    },
    onEnd: () => {
      if (!window.confirm('End the party for everyone?')) return;
      // Everyone (this page too) hears "ended" over the socket.
      api.post(`/api/party/${encodeURIComponent(id)}/end`).catch((e: Error) => window.alert(e.message));
    },
  };
  // A new title (the party moved to the next episode) is a new player.
  return <Player key={`${d.kind}-${d.id}`} info={d} party={binding} />;
}

/** /party/:id for signed-in accounts. */
export default function PartyPage() {
  const { id = '' } = useParams<{ id: string }>();
  return <PartyRoom key={id} id={id} guest={false} />;
}

/** Drops the invite code from the address bar (it stays out of history and screenshots). */
function clearHash() {
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

/** /party/:id/guest#<code>: outside sign-in. A name, Join, then only the player. */
export function GuestPartyPage() {
  const { id = '' } = useParams<{ id: string }>();
  const auth = useAuth();
  const [code] = useState(() => window.location.hash.slice(1));
  const [phase, setPhase] = useState<'check' | 'join' | 'in' | 'ended' | 'left'>('check');
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const signedIn = auth.data?.authenticated;

  // Already a guest of this party in this browser (a reload): straight to the player.
  useEffect(() => {
    if (signedIn !== false) return;
    let cancelled = false;
    api.get<PartyInfo>(`/api/party/${encodeURIComponent(id)}`).then(
      () => {
        if (cancelled) return;
        clearHash();
        setPhase('in');
      },
      () => !cancelled && setPhase(code ? 'join' : 'ended'),
    );
    return () => {
      cancelled = true;
    };
  }, [signedIn, id, code]);

  // Accounts use the members' page (the server turns account guest-joins away).
  if (signedIn) return <Navigate to={`/party/${encodeURIComponent(id)}`} replace />;
  if (auth.error) return <Message>Can’t reach the server.</Message>;
  if (phase === 'ended') return <Message>This watch party has ended.</Message>;
  if (phase === 'left') return <Message>You left the watch party.</Message>;
  if (phase === 'in') return <PartyRoom id={id} guest onLeft={() => setPhase('left')} />;
  if (phase === 'check') return <Message>Loading…</Message>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (joining) return;
    setJoining(true);
    setJoinError(null);
    api
      .post(`/api/party/${encodeURIComponent(id)}/guest-join`, { code, name: name.trim() || undefined })
      .then(() => {
        clearHash();
        setPhase('in');
      })
      .catch((err: Error) => {
        if (err instanceof ApiError && err.status === 404) setPhase('ended');
        else setJoinError(err.message);
      })
      .finally(() => setJoining(false));
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Join the watch party</h1>
        <input
          className="input"
          autoFocus
          maxLength={24}
          autoComplete="nickname"
          placeholder="Your name"
          aria-label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {joinError && <div className="error-box">{joinError}</div>}
        <button className="btn primary full" disabled={joining}>
          {joining && <Spinner />}
          Join
        </button>
      </form>
    </div>
  );
}
