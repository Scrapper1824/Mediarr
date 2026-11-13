import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, watchId, type MediaType, type SearchResult, type WatchItem, type WatchLinks, type WatchStatus } from '../api';
import { cardStill, shortEp, type ContinueItem, type HomeData, type HomeTitle, type PlayableTitle } from '../home';
import HomeHero from '../components/HomeHero';
import MediaDetails from '../components/MediaDetails';
import Rail, { RailSkeleton } from '../components/Rail';
import WatchlistMenu from '../components/WatchlistMenu';

const NEW_MS = 3 * 24 * 3600_000;
const infoFor = (t: HomeTitle): SearchResult => ({
  type: t.type,
  tmdbId: t.tmdbId,
  anilistId: t.anilistId,
  title: t.title,
  year: t.year,
  poster: t.poster,
  overview: t.overview,
  libraryId: t.mediaId,
});

function ContinueCard({ item, onInfo }: { item: ContinueItem; onInfo: () => void }) {
  // The episode's own still first, then the show's backdrop, then its poster (blurred).
  const wide = item.still ? cardStill(item.still) : item.backdrop;
  const art = wide ?? item.poster;
  const sub = item.upNext
    ? `Up next · ${shortEp(item.label ?? '')}`
    : [item.label ? shortEp(item.label) : null, item.minutesLeft ? `${item.minutesLeft} min left` : null].filter(Boolean).join(' · ');
  return (
    <div className="home-card">
      <Link className="home-thumb-link" to={`/watch/${item.kind}/${item.id}`} aria-label={`${item.upNext ? 'Play' : 'Resume'} ${item.title}${item.label ? ` ${shortEp(item.label)}` : ''}`}>
        <div className={`home-thumb${wide ? '' : ' from-poster'}`}>
          {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : <div className="home-thumb-fallback">{item.title.slice(0, 1)}</div>}
          {!wide && <span className="home-thumb-title">{item.title}</span>}
          <span className="home-play-badge" aria-hidden>
            ▶
          </span>
          {!item.upNext && item.duration > 0 && (
            <span className="home-progress">
              <span style={{ width: `${Math.min(100, (item.position / item.duration) * 100)}%` }} />
            </span>
          )}
        </div>
      </Link>
      <div className="home-card-text">
        <div className="home-card-lines">
          <Link className="home-card-title" to={`/media/${item.mediaId}`} title={`Open ${item.title}`}>
            {item.title}
          </Link>
          <span className="home-card-sub">{sub || (item.kind === 'movie' ? 'Movie' : '')}</span>
        </div>
        <button type="button" className="home-info" aria-label={`${item.title} details`} title="Details" onClick={onInfo}>
          i
        </button>
      </div>
    </div>
  );
}

/** A title's place on your watchlists; `undefined` when no connected list takes this kind of title. */
type WatchTag = { status: WatchStatus | null } | undefined;

/** Your watchlist status for each title, for the tags on the posters. */
function useWatchTags() {
  const links = useQuery({ queryKey: ['watchlist', 'links'], queryFn: () => api.get<WatchLinks>('/api/watchlist/links'), staleTime: 5 * 60_000 });
  const simkl = !!links.data?.simkl.connected;
  const anilist = !!links.data?.anilist.connected;
  const list = useQuery({
    queryKey: ['watchlist', 'items'],
    queryFn: () => api.get<{ items: WatchItem[]; errors: string[] }>('/api/watchlist'),
    enabled: simkl || anilist,
    staleTime: 60_000,
  });
  const items = list.data?.items ?? [];
  return (t: HomeTitle): WatchTag => {
    const takes = (type: MediaType) => (type === 'anime' ? simkl || anilist : simkl);
    if (!takes(t.type) || !list.data) return undefined;
    const id = watchId(t);
    const hit = items.find((i) => i.libraryId === t.mediaId) ?? (id ? items.find((i) => i.key === `${t.type}:${id}`) : undefined);
    return { status: hit?.status ?? null };
  };
}

/** The poster plays (resume, the next episode, or from the start); the name opens the title's page. */
function PosterCard({ item, watch }: { item: PlayableTitle; watch?: WatchTag }) {
  const wid = watchId(item);
  const isNew = Date.now() - new Date(item.addedAt).getTime() < NEW_MS;
  const sub = [item.year, item.type !== 'movie' && item.episodeFiles ? `${item.episodeFiles} ep${item.episodeFiles === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  const p = item.play;
  const playText = p ? `${p.resume ? 'Resume' : 'Play'} ${item.title}${p.label ? ` ${shortEp(p.label)}` : ''}` : item.title;
  return (
    <div className="home-poster-card">
      <div className="home-poster-wrap">
      <Link className="home-poster-link" to={p ? `/watch/${p.kind}/${p.id}` : `/media/${item.mediaId}`} aria-label={playText} title={playText}>
        <div className="home-poster">
          {item.poster ? <img src={item.poster} alt="" loading="lazy" decoding="async" /> : <div className="home-thumb-fallback">{item.title.slice(0, 1)}</div>}
          {isNew && <span className="home-new">New</span>}
          {p && (
            <span className="home-play-badge" aria-hidden>
              ▶
            </span>
          )}
          {p?.resume && p.duration > 0 && (
            <span className="home-progress">
              <span style={{ width: `${Math.min(100, (p.position / p.duration) * 100)}%` }} />
            </span>
          )}
        </div>
      </Link>
      {watch && wid && (
        <WatchlistMenu
          variant="tag"
          className={watch.status ? 'on' : 'off'}
          type={item.type}
          id={wid}
          status={watch.status}
          info={{ title: item.title, year: item.year, poster: item.poster }}
        />
      )}
      </div>
      <Link className="home-card-title" to={`/media/${item.mediaId}`} title={`Open ${item.title}`}>
        {item.title}
      </Link>
      {sub && <span className="home-card-sub">{sub}</span>}
    </div>
  );
}

/** Home: everything you can watch, Jellyfin-style. */
export default function Home() {
  const q = useQuery({ queryKey: ['home'], queryFn: () => api.get<HomeData>('/api/home'), refetchInterval: 60_000, staleTime: 0 });
  const [info, setInfo] = useState<SearchResult | null>(null);
  const watchTag = useWatchTags();
  const d = q.data;

  return (
    <div className="page page-wide home">
      <HomeHero items={d?.featured ?? []} loading={q.isLoading} />
      {q.error && <div className="error-box">Couldn’t load your library: {(q.error as Error).message}</div>}

      {q.isLoading && (
        <>
          <RailSkeleton wide />
          <RailSkeleton />
        </>
      )}

      {d && d.continue.length > 0 && (
        <Rail title="Continue watching" wide>
          {d.continue.map((c) => (
            <ContinueCard key={`${c.kind}-${c.id}`} item={c} onInfo={() => setInfo(infoFor(c))} />
          ))}
        </Rail>
      )}
      {d && d.recent.length > 0 && (
        <Rail title="Recently added">
          {d.recent.map((t) => (
            <PosterCard key={t.mediaId} item={t} watch={watchTag(t)} />
          ))}
        </Rail>
      )}
      {d &&
        (
          [
            ['movie', 'Movies', '/movies'],
            ['show', 'Shows', '/shows'],
            ['anime', 'Anime', '/anime'],
          ] as const
        ).map(([type, title, to]) =>
          d.libraries[type].length ? (
            <Rail key={type} title={title} seeAll={to}>
              {d.libraries[type].map((t) => (
                <PosterCard key={t.mediaId} item={t} watch={watchTag(t)} />
              ))}
            </Rail>
          ) : null,
        )}

      {info && <MediaDetails item={info} onClose={() => setInfo(null)} onRequest={() => setInfo(null)} />}
    </div>
  );
}
