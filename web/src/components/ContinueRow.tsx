import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type MediaType, type SearchResult } from '../api';
import Poster from './Poster';

interface ContinueItem {
  mediaId: number;
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  tmdbId?: number;
  anilistId?: number;
  kind: 'movie' | 'episode';
  id: number;
  label: string | null;
  position: number;
  duration: number;
  upNext: boolean;
}

/**
 * "Continue watching": things you started, and the next episode of shows you're following.
 * The poster plays; the title opens the info popup.
 */
export default function ContinueRow({ type, onOpen }: { type: MediaType; onOpen: (r: SearchResult) => void }) {
  const q = useQuery({ queryKey: ['continue'], queryFn: () => api.get<ContinueItem[]>('/api/continue'), staleTime: 30_000 });
  const items = (q.data ?? []).filter((i) => i.type === type);
  if (!items.length) return null;
  const info = (i: ContinueItem): SearchResult => ({
    type: i.type,
    tmdbId: i.tmdbId,
    anilistId: i.anilistId,
    title: i.title,
    year: i.year,
    poster: i.poster,
    overview: '',
    libraryId: i.mediaId,
  });
  return (
    <section className="browse-row">
      <header className="browse-row-header">
        <h2>Continue watching</h2>
      </header>
      <div className="browse-scroller">
        {items.map((i) => {
          const canOpen = !!(i.type === 'anime' ? i.anilistId : i.tmdbId);
          const subtitle = [i.upNext ? 'Up next' : null, i.label].filter(Boolean).join(' · ') || (i.kind === 'movie' ? 'Movie' : '');
          return (
            <div key={`${i.kind}-${i.id}`} className="card continue-card">
              <Link className="continue-poster" to={`/watch/${i.kind}/${i.id}`} aria-label={`Play ${i.title}${i.label ? ` ${i.label}` : ''}`}>
                <Poster src={i.poster} title={i.title}>
                  <span className="continue-play" aria-hidden>
                    ▶
                  </span>
                  {!i.upNext && i.duration > 0 && (
                    <span className="continue-progress">
                      <span style={{ width: `${Math.min(100, (i.position / i.duration) * 100)}%` }} />
                    </span>
                  )}
                </Poster>
              </Link>
              <button
                type="button"
                className="card-body continue-info"
                disabled={!canOpen}
                onClick={() => onOpen(info(i))}
                aria-label={`${i.title} details`}
              >
                <span className="card-title" title={i.title}>
                  {i.title}
                </span>
                <span className="muted small">{subtitle}</span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
