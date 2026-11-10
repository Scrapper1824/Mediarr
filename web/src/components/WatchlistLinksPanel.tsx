import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WatchLinks } from '../api';

interface Pin {
  userCode: string;
  verificationUrl: string;
  /** Simkl with the code already filled in. */
  verificationUrlComplete: string | null;
  interval: number;
}

/** Connect your own Simkl / AniList account (every user, admin or not). */
export default function WatchlistLinksPanel() {
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ['watchlist', 'links'], queryFn: () => api.get<WatchLinks>('/api/watchlist/links') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['watchlist'] });
  const disconnect = useMutation({ mutationFn: (s: string) => api.del(`/api/watchlist/links/${s}`), onSuccess: refresh });

  const l = links.data;
  return (
    <section className="panel">
      <h2>Your watchlist accounts</h2>
      <p className="muted small">
        Connect your own Simkl and/or AniList account to see and edit your lists in Mediarr (Watchlist page, and the ＋ Watchlist button on
        any title). Only you can see your lists.
      </p>
      {l && (
        <>
          <ServiceRow
            name="Simkl"
            what="Movies, shows and anime"
            state={l.simkl}
            onDisconnect={() => disconnect.mutate('simkl')}
            connect={<SimklConnect onDone={refresh} />}
          />
          <ServiceRow
            name="AniList"
            what="Anime"
            state={l.anilist}
            onDisconnect={() => disconnect.mutate('anilist')}
            connect={l.anilist.authorizeUrl && <AniListConnect authorizeUrl={l.anilist.authorizeUrl} onDone={refresh} />}
          />
        </>
      )}
      {disconnect.error && <div className="error-box">{(disconnect.error as Error).message}</div>}
    </section>
  );
}

function ServiceRow({
  name,
  what,
  state,
  connect,
  onDisconnect,
}: {
  name: string;
  what: string;
  state: { configured: boolean; connected: boolean; account: string | null };
  connect: React.ReactNode;
  onDisconnect: () => void;
}) {
  return (
    <div className="link-row">
      <div className="link-head">
        <div>
          <strong>{name}</strong> <span className="muted small">· {what}</span>
          {state.connected && <div className="ok-text small">✓ Connected{state.account ? ` as ${state.account}` : ''}</div>}
          {!state.configured && <div className="muted small">Not set up yet: an admin needs to add Mediarr’s {name} app ID in Settings.</div>}
        </div>
        {state.connected && (
          <button type="button" className="btn small ghost" onClick={onDisconnect}>
            Disconnect
          </button>
        )}
      </div>
      {state.configured && !state.connected && connect}
    </div>
  );
}

function SimklConnect({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState<Pin | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const start = useMutation({
    mutationFn: () => api.post<Pin>('/api/watchlist/simkl/start'),
    onSuccess: (p) => {
      setPin(p);
      setNote(null);
    },
  });

  // While the code is showing, ask the server every few seconds whether it has been entered.
  useEffect(() => {
    if (!pin) return;
    let stop = false;
    const timer = setInterval(async () => {
      try {
        const r = await api.post<{ status: 'waiting' | 'connected' | 'expired' }>('/api/watchlist/simkl/poll');
        if (stop) return;
        if (r.status === 'connected') {
          setPin(null);
          done.current();
        } else if (r.status === 'expired') {
          setPin(null);
          setNote('The code expired. Try again.');
        }
      } catch (err) {
        setPin(null);
        setNote((err as Error).message);
      }
    }, pin.interval * 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [pin]);

  if (pin) {
    return (
      <div className="link-steps">
        <a className="btn small primary" href={pin.verificationUrlComplete ?? pin.verificationUrl} target="_blank" rel="noreferrer noopener">
          Open Simkl to approve
        </a>
        <span className="muted small">or go to {pin.verificationUrl.replace(/^https?:\/\//, '')} and enter</span>
        <code className="pin-code">{pin.userCode}</code>
        <span className="muted small">Waiting for you to approve on Simkl… this finishes by itself.</span>
        <button type="button" className="btn small ghost" onClick={() => setPin(null)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="link-steps">
      <button type="button" className="btn small" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? 'Starting…' : 'Connect Simkl'}
      </button>
      {(note || start.error) && <span className="error-text small">{note ?? (start.error as Error).message}</span>}
    </div>
  );
}

function AniListConnect({ authorizeUrl, onDone }: { authorizeUrl: string; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [opened, setOpened] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post('/api/watchlist/anilist', { token }),
    onSuccess: () => {
      setToken('');
      onDone();
    },
  });
  return (
    <div className="link-steps">
      <a className="btn small" href={authorizeUrl} target="_blank" rel="noreferrer noopener" onClick={() => setOpened(true)}>
        {opened ? 'Open AniList again' : 'Connect AniList'}
      </a>
      {opened && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder="Paste the token AniList shows you"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn small primary" disabled={!token.trim() || save.isPending}>
            {save.isPending ? 'Checking…' : 'Save'}
          </button>
        </form>
      )}
      {save.error && <span className="error-text small">{(save.error as Error).message}</span>}
    </div>
  );
}
