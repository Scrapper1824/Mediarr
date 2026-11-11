import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatDate, type SearchResult } from '../api';
import Spinner from './Spinner';
import TrailerPlayer from './TrailerPlayer';
import { InfoItem, languageName, Ratings, WatchlistButton, type MediaInfo } from './TitleInfo';
import Availability from './Availability';

/** Radarr-style details sheet for a Discover title (opens when you click a card). */
export default function MediaDetails({
  item,
  onRequest,
  onClose,
}: {
  item: SearchResult;
  onRequest: (item: SearchResult) => void;
  onClose: () => void;
}) {
  const id = item.type === 'anime' ? item.anilistId : item.tmdbId;
  const info = useQuery({
    queryKey: ['discover', 'info', item.type, id],
    queryFn: () => api.get<MediaInfo>(`/api/discover/info?type=${item.type}&id=${id}`),
    staleTime: 30 * 60_000,
  });

  const [playing, setPlaying] = useState(false);
  // Esc closes the trailer first, then the details sheet.
  const playingRef = useRef(false);
  playingRef.current = playing;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (playingRef.current) setPlaying(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    // Keep the page behind from scrolling while the sheet is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const d = info.data;
  const libraryId = d?.libraryId ?? item.libraryId;
  const title = d?.title ?? item.title;
  const poster = d?.poster ?? item.poster;
  const facts = [d?.year ?? item.year, d?.runtime].filter(Boolean) as (string | number)[];

  return (
    <div className="modal-backdrop details-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`details-sheet${item.type === 'anime' ? ' soft' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {d?.backdrop && <img className="details-art" src={d.backdrop} alt="" />}
        <div className="details-shade" />
        <button className="hero-round details-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>

        <div className="details-body">
          {poster ? <img className="details-poster" src={poster} alt="" /> : <div className="details-poster placeholder" />}

          <div className="details-main">
            <h2 className="details-title">
              {title}
              {d?.originalTitle && d.originalTitle !== title && <span className="details-original">{d.originalTitle}</span>}
            </h2>
            {d?.tagline && <p className="details-tagline">{d.tagline}</p>}

            <div className="details-facts">
              {d?.certification && <span className="details-cert">{d.certification}</span>}
              {facts.map((f) => (
                <span key={String(f)}>{f}</span>
              ))}
              {d?.links.map((l) => (
                <a key={l.label} className="details-link" href={l.url} target="_blank" rel="noreferrer noopener">
                  {l.label} ↗
                </a>
              ))}
            </div>

            {info.isLoading && (
              <div className="row muted">
                <Spinner /> Loading ratings and details…
              </div>
            )}
            {info.error && <div className="error-box">{(info.error as Error).message}</div>}

            {d && (
              <>
                <Ratings ratings={d.ratings} />

                <div className="details-info">
                  <InfoItem label="Status" value={libraryId ? 'In your library' : d.status} />
                  <InfoItem label="Length" value={[...d.length, d.type === 'movie' ? null : d.runtime].filter(Boolean).join(' · ') || d.runtime} />
                  <InfoItem label="Released" value={d.released ? formatDate(d.released) : null} />
                  <InfoItem label="Original language" value={languageName(d.originalLanguage)} />
                  <InfoItem label={d.studioLabel} value={d.studios.join(', ')} />
                  <InfoItem label="Genres" value={d.genres.join(', ')} />
                </div>

                {d.overview && <p className="details-overview">{d.overview}</p>}
                {item.type === 'anime' && d.anilistId ? <Availability anilistId={d.anilistId} /> : null}
              </>
            )}

            <div className="details-actions">
              {libraryId ? (
                <Link className="hero-play" to={`/media/${libraryId}`} onClick={onClose}>
                  <span aria-hidden>▶</span> Open in library
                </Link>
              ) : (
                <button className="hero-play" onClick={() => onRequest(item)}>
                  <span aria-hidden>＋</span> Request
                </button>
              )}
              {d?.trailer && (
                <button className="hero-secondary" onClick={() => setPlaying(true)}>
                  <span aria-hidden>▶</span> Trailer
                </button>
              )}
              {id && <WatchlistButton type={item.type} id={id} info={{ title: item.title, year: item.year, poster: item.poster }} />}
            </div>
          </div>
        </div>
      </div>
      {playing && d?.trailer && (
        <TrailerPlayer youtubeId={d.trailer.youtubeId} title={`${title} – ${d.trailer.title}`} onClose={() => setPlaying(false)} />
      )}
    </div>
  );
}
