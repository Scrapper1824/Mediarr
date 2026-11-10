import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatDate, type SearchResult } from '../api';
import Spinner from './Spinner';
import TomatoIcon from './TomatoIcon';
import TrailerPlayer from './TrailerPlayer';
import WatchlistMenu from './WatchlistMenu';
import type { MediaType, WatchItem } from '../api';

/** The title's watchlist status, when the user has a service connected that takes this kind of title. */
function WatchlistButton({ type, id, info }: { type: MediaType; id: number; info: { title: string; year: number | null; poster: string | null } }) {
  const q = useQuery({
    queryKey: ['watchlist', 'item', type, id],
    queryFn: () => api.get<{ services: string[]; item: WatchItem | null }>(`/api/watchlist/item?type=${type}&id=${id}`),
    staleTime: 60_000,
  });
  if (!q.data?.services?.length) return null;
  return <WatchlistMenu type={type} id={id} status={q.data.item?.status ?? null} info={info} />;
}

interface Rating {
  source: 'tmdb' | 'imdb' | 'rt' | 'anilist' | 'mal' | 'kitsu';
  label: string;
  value: string;
  percent: number;
  url?: string;
  /** Known to the site but no score yet (new release). */
  pending?: boolean;
}

interface MediaInfo extends SearchResult {
  originalTitle: string | null;
  tagline: string | null;
  backdrop: string | null;
  certification: string | null;
  runtime: string | null;
  length: string[];
  status: string | null;
  released: string | null;
  originalLanguage: string | null;
  genres: string[];
  studios: string[];
  studioLabel: string;
  ratings: Rating[];
  links: { label: string; url: string }[];
  trailer: { youtubeId: string; title: string } | null;
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null;
  }
})();
const languageName = (code: string | null) => (code ? (languageNames?.of(code) ?? code.toUpperCase()) : null);

/** Site-styled rating badge: TMDB, IMDb, Rotten Tomatoes, AniList, MyAnimeList, Kitsu. */
function RatingBadge({ r }: { r: Rating }) {
  const logo =
    r.source === 'rt' ? (
      <TomatoIcon />
    ) : (
      <span className={`rating-logo logo-${r.source}`}>
        {{ tmdb: 'TMDB', imdb: 'IMDb', anilist: 'AL', mal: 'MAL', kitsu: 'K' }[r.source]}
      </span>
    );
  const body = (
    <>
      {logo}
      <span className="rating-value">{r.value}</span>
    </>
  );
  const title = r.pending ? `Not rated on ${r.label} yet (too few votes)` : `${r.label} rating`;
  const cls = `rating${r.pending ? ' pending' : ''}`;
  return r.url ? (
    <a className={cls} href={r.url} target="_blank" rel="noreferrer noopener" title={title}>
      {body}
    </a>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}

function InfoItem({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="info-item">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

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
                {d.ratings.length > 0 && (
                  <div className="details-ratings">
                    {d.ratings.map((r) => (
                      <RatingBadge key={r.source} r={r} />
                    ))}
                  </div>
                )}

                <div className="details-info">
                  <InfoItem label="Status" value={libraryId ? 'In your library' : d.status} />
                  <InfoItem label="Length" value={[...d.length, d.type === 'movie' ? null : d.runtime].filter(Boolean).join(' · ') || d.runtime} />
                  <InfoItem label="Released" value={d.released ? formatDate(d.released) : null} />
                  <InfoItem label="Original language" value={languageName(d.originalLanguage)} />
                  <InfoItem label={d.studioLabel} value={d.studios.join(', ')} />
                  <InfoItem label="Genres" value={d.genres.join(', ')} />
                </div>

                {d.overview && <p className="details-overview">{d.overview}</p>}
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
