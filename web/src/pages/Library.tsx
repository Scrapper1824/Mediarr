import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, typeLabel, watchId, type Media, type MediaType } from '../api';
import WatchlistMenu from '../components/WatchlistMenu';
import { useWatchTags } from '../watchTags';
import Poster from '../components/Poster';
import Spinner from '../components/Spinner';
import Icon from '../components/Icon';

/** The one thing worth flagging on a poster, if anything (downloaded titles need no badge). */
function PosterFlag({ m }: { m: Media }) {
  if (m.search?.running)
    return (
      <span className="badge info row-inline">
        <Spinner size={10} /> Searching
      </span>
    );
  if (m.pendingSuggestions) return <span className="badge bundle">Choose a bundle</span>;
  if (m.downloading) return <span className="badge info">Downloading</span>;
  if (m.type === 'movie' ? !m.has_file : m.episodeFileCount === 0) return <span className="badge muted">{m.monitored ? 'Wanted' : 'Not downloaded'}</span>;
  return null;
}

/** "2016", "2023 · 3 of 38 episodes", "2023 · All 12 episodes". */
function caption(m: Media) {
  const parts: string[] = [];
  if (m.year) parts.push(String(m.year));
  if (m.type !== 'movie' && m.episodeCount > 0) {
    parts.push(m.episodeFileCount >= m.episodeCount ? `All ${m.episodeCount} episodes` : `${m.episodeFileCount} of ${m.episodeCount} episodes`);
  }
  return parts.join(' · ');
}

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
  const watchTag = useWatchTags();
  const [filter, setFilter] = useState('');
  const media = useQuery({
    queryKey: ['media', type],
    queryFn: () => api.get<Media[]>(`/api/media?type=${type}`),
    refetchInterval: 15000,
  });
  const list = (media.data ?? []).filter((m) => m.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <header className="page-header library-header">
        <div>
          <h1>{typeLabel[type]}</h1>
          <p className="muted">{media.data ? `${media.data.length} ${media.data.length === 1 ? 'title' : 'titles'}` : ' '}</p>
        </div>
        <div className="row library-tools">
          <label className="search-field">
            <Icon name="search" size={17} />
            <input className="input" placeholder={`Find in ${typeLabel[type].toLowerCase()}`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={`Find in ${typeLabel[type].toLowerCase()}`} />
          </label>
          <Link to="/discover" className="btn primary">
            Request
          </Link>
        </div>
      </header>

      {media.isLoading && <div className="loading">Loading…</div>}
      {media.data && !media.data.length && (
        <div className="empty-state">
          <h2>No {typeLabel[type].toLowerCase()} yet</h2>
          <p className="muted">Request one from Discover and it shows up here once it's downloaded.</p>
          <Link to="/discover" className="btn primary">
            Go to Discover
          </Link>
        </div>
      )}
      {media.data && media.data.length > 0 && !list.length && <div className="empty">Nothing matches “{filter}”.</div>}

      <div className="grid">
        {list.map((m) => {
          const partial = m.type !== 'movie' && m.episodeCount > 0 && m.episodeFileCount > 0 && m.episodeFileCount < m.episodeCount;
          const ids = { type: m.type, tmdbId: m.tmdb_id ?? undefined, anilistId: m.anilist_id ?? undefined, libraryId: m.id };
          const watch = watchTag(ids);
          const wid = watchId(ids);
          return (
            // The watchlist tag sits beside the link (over the poster), so clicking it never opens the title.
            <div key={m.id} className="lib-card">
              <Link to={`/media/${m.id}`} className="card link-card">
                <Poster src={m.poster} title={m.title}>
                  <span className={`corner-bottom${partial ? ' above-progress' : ''}`}>
                    <PosterFlag m={m} />
                  </span>
                  {m.type === 'anime' && m.anime_audio && <span className={`corner-left audio-pill audio-${m.anime_audio}`}>{m.anime_audio === 'dub' ? 'Dub' : 'Sub'}</span>}
                  {partial && (
                    <span className="poster-progress" aria-hidden>
                      <span style={{ width: `${(m.episodeFileCount / m.episodeCount) * 100}%` }} />
                    </span>
                  )}
                </Poster>
                <div className="card-body">
                  <div className="card-title" title={m.title}>
                    {m.title}
                  </div>
                  <div className="muted small">{caption(m) || ' '}</div>
                </div>
              </Link>
              {watch && wid && (
                <WatchlistMenu
                  variant="tag"
                  className={`lib-tag ${watch.status ? 'on' : 'off'}`}
                  type={m.type}
                  id={wid}
                  status={watch.status}
                  info={{ title: m.title, year: m.year, poster: m.poster }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
