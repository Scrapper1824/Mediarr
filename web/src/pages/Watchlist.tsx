import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  serviceLabel,
  typeLabel,
  WATCH_STATUSES,
  watchId,
  watchStatusLabel,
  type MediaType,
  type SearchResult,
  type WatchItem,
  type WatchLinks,
  type WatchService,
  type WatchStatus,
} from '../api';
import AddDialog from '../components/AddDialog';
import MediaDetails from '../components/MediaDetails';
import Poster from '../components/Poster';
import WatchlistMenu from '../components/WatchlistMenu';

const asResult = (i: WatchItem): SearchResult => ({
  type: i.type,
  tmdbId: i.tmdbId,
  anilistId: i.anilistId,
  title: i.title,
  year: i.year,
  poster: i.poster,
  overview: '',
  libraryId: i.libraryId,
});

function progressText(p: WatchItem['progress']) {
  if (!p || (!p.watched && !p.total)) return null;
  return p.total ? `${p.watched ?? 0}/${p.total} eps` : `${p.watched} eps`;
}

/** The signed-in user's own Simkl / AniList lists. */
export default function Watchlist() {
  const links = useQuery({ queryKey: ['watchlist', 'links'], queryFn: () => api.get<WatchLinks>('/api/watchlist/links') });
  const list = useQuery({
    queryKey: ['watchlist', 'items'],
    queryFn: () => api.get<{ items: WatchItem[]; errors: string[] }>('/api/watchlist'),
    enabled: !!(links.data?.simkl.connected || links.data?.anilist.connected),
  });
  const [status, setStatus] = useState<WatchStatus>('watching');
  const [type, setType] = useState<MediaType | 'all'>('all');
  const [viewing, setViewing] = useState<SearchResult | null>(null);
  const [adding, setAdding] = useState<SearchResult | null>(null);

  const connected = links.data && (links.data.simkl.connected || links.data.anilist.connected);
  const items = list.data?.items ?? [];
  const ofType = items.filter((i) => type === 'all' || i.type === type);
  const shown = ofType.filter((i) => i.status === status);
  const count = (s: WatchStatus) => ofType.filter((i) => i.status === s).length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Watchlist</h1>
        {connected && (
          <div className="segmented" role="tablist" aria-label="Type">
            {(['all', 'movie', 'show', 'anime'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={type === t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
                {t === 'all' ? 'All' : typeLabel[t]}
              </button>
            ))}
          </div>
        )}
      </header>

      {links.data && !connected && (
        <div className="empty">
          <p>Connect your Simkl or AniList account to see your lists here.</p>
          <Link className="btn primary" to="/settings">
            Go to Settings → Watchlists
          </Link>
        </div>
      )}

      {connected && (
        <>
          <div className="segmented status-tabs" role="tablist" aria-label="Status">
            {WATCH_STATUSES.map((s) => (
              <button key={s} role="tab" aria-selected={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                {watchStatusLabel[s]} <span className="tab-count">{count(s)}</span>
              </button>
            ))}
          </div>
          {list.data?.errors.map((e) => (
            <div key={e} className="error-box">
              {e}
            </div>
          ))}
          {list.error && <div className="error-box">{(list.error as Error).message}</div>}
          {list.isLoading && <div className="loading">Loading your lists…</div>}
          {list.data && !shown.length && <p className="muted">Nothing here.</p>}
          <div className="grid">
            {shown.map((i) => {
              const id = watchId(i);
              const open = () => id && setViewing(asResult(i));
              return (
                <div
                  key={i.key}
                  className={`card${id ? ' clickable' : ''}`}
                  role={id ? 'button' : undefined}
                  tabIndex={id ? 0 : undefined}
                  aria-label={id ? `${i.title} details` : undefined}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (id && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      open();
                    }
                  }}
                >
                  <Poster src={i.poster} title={i.title}>
                    <span className="service-badges">
                      {(Object.keys(i.services) as WatchService[]).map((s) => (
                        <span key={s} className={`badge corner-chip service-${s}`} title={`On your ${serviceLabel[s]} list`}>
                          {serviceLabel[s]}
                        </span>
                      ))}
                    </span>
                    {i.libraryId && <span className="badge ok corner">In library</span>}
                  </Poster>
                  <div className="card-body">
                    <div className="card-title" title={i.title}>
                      {i.title}
                    </div>
                    <div className="muted small">{[i.year, typeLabel[i.type], progressText(i.progress)].filter(Boolean).join(' · ')}</div>
                    {id ? (
                      <>
                        <WatchlistMenu type={i.type} id={id} status={i.status} compact />
                        {i.libraryId ? (
                          <Link className="btn small ghost full" to={`/media/${i.libraryId}`} onClick={(e) => e.stopPropagation()}>
                            Open
                          </Link>
                        ) : (
                          <button
                            className="btn small primary full"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAdding(asResult(i));
                            }}
                          >
                            Request
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="muted small">Mediarr can’t match this title yet.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {viewing && (
        <MediaDetails
          item={viewing}
          onClose={() => setViewing(null)}
          onRequest={(r) => {
            setViewing(null);
            setAdding(r);
          }}
        />
      )}
      {adding && <AddDialog item={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}
