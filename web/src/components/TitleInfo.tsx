import { useQuery } from '@tanstack/react-query';
import { api, type MediaType, type SearchResult, type WatchItem } from '../api';
import TomatoIcon from './TomatoIcon';
import WatchlistMenu from './WatchlistMenu';

/** Pieces shared by the info popup (MediaDetails) and the title page: ratings, facts, watchlist. */

/** The title's watchlist status, when the user has a service connected that takes this kind of title. */
export function WatchlistButton({ type, id, info }: { type: MediaType; id: number; info: { title: string; year: number | null; poster: string | null } }) {
  const q = useQuery({
    queryKey: ['watchlist', 'item', type, id],
    queryFn: () => api.get<{ services: string[]; item: WatchItem | null }>(`/api/watchlist/item?type=${type}&id=${id}`),
    staleTime: 60_000,
  });
  if (!q.data?.services?.length) return null;
  return <WatchlistMenu type={type} id={id} status={q.data.item?.status ?? null} info={info} />;
}

export interface Rating {
  source: 'tmdb' | 'imdb' | 'rt' | 'anilist' | 'mal' | 'kitsu';
  label: string;
  value: string;
  percent: number;
  url?: string;
  /** Known to the site but no score yet (new release). */
  pending?: boolean;
}

export interface MediaInfo extends SearchResult {
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
export const languageName = (code: string | null) => (code ? (languageNames?.of(code) ?? code.toUpperCase()) : null);

/** Site-styled rating badge: TMDB, IMDb, Rotten Tomatoes, AniList, MyAnimeList, Kitsu. */
export function RatingBadge({ r }: { r: Rating }) {
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

export function InfoItem({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="info-item">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

/** Rating badges in a row (nothing when there are none). */
export function Ratings({ ratings }: { ratings: Rating[] }) {
  if (!ratings.length) return null;
  return (
    <div className="details-ratings">
      {ratings.map((r) => (
        <RatingBadge key={r.source} r={r} />
      ))}
    </div>
  );
}
