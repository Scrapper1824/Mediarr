import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, typeLabel, type Media, type MediaType } from '../api';
import Poster from '../components/Poster';
import Spinner from '../components/Spinner';

export function StatusBadge({ m }: { m: Media }) {
  if (m.search?.running)
    return (
      <span className="badge info row-inline">
        <Spinner size={10} /> Searching
      </span>
    );
  if (m.pendingSuggestions) return <span className="badge bundle">Choose bundle</span>;
  if (m.downloading) return <span className="badge info">Downloading</span>;
  if (m.type === 'movie') {
    if (m.has_file) return <span className="badge ok">Downloaded</span>;
    return <span className={`badge ${m.monitored ? 'warn' : 'muted'}`}>{m.monitored ? 'Missing' : 'Unmonitored'}</span>;
  }
  const complete = m.episodeCount > 0 && m.episodeFileCount >= m.episodeCount;
  return (
    <span className={`badge ${complete ? 'ok' : m.episodeFileCount ? 'info' : m.monitored ? 'warn' : 'muted'}`}>
      {m.episodeFileCount}/{m.episodeCount} eps
    </span>
  );
}

export default function Library({ type }: { type: MediaType }) {
  const [filter, setFilter] = useState('');
  const media = useQuery({
    queryKey: ['media', type],
    queryFn: () => api.get<Media[]>(`/api/media?type=${type}`),
    refetchInterval: 15000,
  });
  const list = (media.data ?? []).filter((m) => m.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <header className="page-header row between">
        <div>
          <h1>{typeLabel[type]}</h1>
          <p className="muted">{media.data?.length ?? 0} in library</p>
        </div>
        <div className="row">
          <input className="input" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Link to="/discover" className="btn primary">
            + Request
          </Link>
        </div>
      </header>

      {media.isLoading && <div className="loading">Loading…</div>}
      {media.data && !media.data.length && (
        <div className="empty">
          Nothing here yet. <Link to="/discover">Request something</Link>.
        </div>
      )}

      <div className="grid">
        {list.map((m) => (
          <Link key={m.id} to={`/media/${m.id}`} className="card link-card">
            <Poster src={m.poster} title={m.title}>
              <span className="corner">
                <StatusBadge m={m} />
              </span>
              {m.type === 'anime' && m.anime_audio && <span className={`corner-left chip audio-${m.anime_audio}`}>{m.anime_audio}</span>}
            </Poster>
            <div className="card-body">
              <div className="card-title" title={m.title}>
                {m.title}
              </div>
              <div className="muted small">
                {m.year ?? '—'} {m.monitored ? '· Monitored' : '· Unmonitored'}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
