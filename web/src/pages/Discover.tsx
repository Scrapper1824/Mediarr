import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, typeLabel, type MediaType, type SearchResult } from '../api';
import AddDialog from '../components/AddDialog';
import Chevron from '../components/Chevron';
import Hero, { type FeaturedItem } from '../components/Hero';
import MediaDetails from '../components/MediaDetails';
import ContinueRow from '../components/ContinueRow';
import Poster from '../components/Poster';

interface BrowseRowData {
  id: string;
  title: string;
  items: SearchResult[];
}

function ResultCard({
  r,
  onRequest,
  onOpen,
}: {
  r: SearchResult;
  onRequest: (r: SearchResult) => void;
  onOpen: (r: SearchResult) => void;
}) {
  return (
    <div
      className="card clickable"
      role="button"
      tabIndex={0}
      aria-label={`${r.title} details`}
      onClick={() => onOpen(r)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(r);
        }
      }}
    >
      <Poster src={r.poster} title={r.title}>
        {r.libraryId && <span className="badge ok corner">In library</span>}
      </Poster>
      <div className="card-body">
        <div className="card-title" title={r.title}>
          {r.title}
        </div>
        <div className="muted small">{[r.year, r.extra].filter(Boolean).join(' · ') || '—'}</div>
        {r.libraryId ? (
          <Link className="btn small ghost full" to={`/media/${r.libraryId}`} onClick={(e) => e.stopPropagation()}>
            Open
          </Link>
        ) : (
          <button
            className="btn small primary full"
            onClick={(e) => {
              e.stopPropagation(); // the button requests; the rest of the card shows details
              onRequest(r);
            }}
          >
            Request
          </button>
        )}
      </div>
    </div>
  );
}

/** One horizontally scrolling row ("Trending this week", ...). */
function BrowseRow({
  row,
  onRequest,
  onOpen,
}: {
  row: BrowseRowData;
  onRequest: (r: SearchResult) => void;
  onOpen: (r: SearchResult) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };
  if (!row.items.length) return null;
  return (
    <section className="browse-row">
      <header className="browse-row-header">
        <h2>{row.title}</h2>
        <div className="row browse-arrows">
          <button className="icon-btn row-arrow" aria-label={`Scroll ${row.title} left`} onClick={() => scrollBy(-1)}>
            <Chevron dir="left" size={16} />
          </button>
          <button className="icon-btn row-arrow" aria-label={`Scroll ${row.title} right`} onClick={() => scrollBy(1)}>
            <Chevron dir="right" size={16} />
          </button>
        </div>
      </header>
      <div className="browse-scroller" ref={scroller}>
        {row.items.map((r) => (
          <ResultCard key={`${r.type}-${r.tmdbId ?? r.anilistId}`} r={r} onRequest={onRequest} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function BrowseSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <section key={i} className="browse-row" aria-hidden>
          <header className="browse-row-header">
            <div className="skeleton skeleton-title" />
          </header>
          <div className="browse-scroller">
            {Array.from({ length: 8 }, (_, j) => (
              <div key={j} className="card skeleton-card">
                <div className="poster skeleton" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export default function Discover() {
  const [type, setType] = useState<MediaType>('movie');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<SearchResult | null>(null);
  const [viewing, setViewing] = useState<SearchResult | null>(null);

  const results = useQuery({
    queryKey: ['discover', type, query],
    queryFn: () => api.get<SearchResult[]>(`/api/discover/search?type=${type}&q=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  });
  const qc = useQueryClient();
  const browseQuery = (t: MediaType) => ({
    queryKey: ['discover', 'browse', t],
    queryFn: () => api.get<{ featured: FeaturedItem[]; rows: BrowseRowData[] }>(`/api/discover/browse?type=${t}`),
    staleTime: 5 * 60_000,
  });
  const browse = useQuery({ ...browseQuery(type), enabled: query.length === 0 });

  // Once the first tab is showing, quietly load the other two so switching tabs is instant.
  useEffect(() => {
    if (!browse.isSuccess) return;
    for (const t of ['movie', 'show', 'anime'] as const) if (t !== type) qc.prefetchQuery(browseQuery(t));
  }, [browse.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Anime found through TMDB in the Movies/Shows tabs belongs in the Anime tab.
  const shown = (results.data ?? []).filter((r) => !(type !== 'anime' && r.isAnime));
  const hiddenAnime = (results.data?.length ?? 0) - shown.length;

  const clearSearch = () => {
    setInput('');
    setQuery('');
  };

  const featured = !query ? (browse.data?.featured ?? []) : [];
  // Keep the banner layout while a tab's titles load, so switching tabs doesn't jump between layouts.
  const showHero = !query && (browse.isLoading || featured.length > 0);

  const searchForm = (
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
      >
        <div className="segmented">
          {(['movie', 'show', 'anime'] as const).map((t) => (
            <button type="button" key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
              {typeLabel[t]}
            </button>
          ))}
        </div>
        <div className="search-input grow">
          <input
            autoFocus
            className="input"
            placeholder={`Search ${typeLabel[type].toLowerCase()}…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (!e.target.value) setQuery('');
            }}
          />
          {input && (
            <button type="button" className="icon-btn clear-search" aria-label="Clear search" onClick={clearSearch}>
              ✕
            </button>
          )}
        </div>
        <button className="btn primary" type="submit">
          Search
        </button>
      </form>
  );

  return (
    <div className="page page-wide">
      {showHero ? (
        // Keyed by tab: each tab's banner starts fresh at its first slide.
        <Hero key={type} items={featured} loading={browse.isLoading} onRequest={setAdding} onInfo={setViewing} top={searchForm} />
      ) : (
        <>
          <header className="page-header">
            <h1>Discover</h1>
            <p className="muted">Find something to request. Movies and shows come from TMDB, anime from AniList.</p>
          </header>
          {searchForm}
        </>
      )}

      {query ? (
        <>
          <div className="row between search-heading">
            <h2>
              Results for “{query}” <span className="muted">in {typeLabel[type]}</span>
            </h2>
            <button className="btn small ghost" onClick={clearSearch}>
              ← Back to browsing
            </button>
          </div>
          {results.isFetching && <div className="loading">Searching…</div>}
          {results.error && <div className="error-box">{(results.error as Error).message}</div>}
          {hiddenAnime > 0 && (
            <div className="notice row between wrap anime-hint">
              <span>
                {hiddenAnime} anime result{hiddenAnime === 1 ? '' : 's'} hidden. Anime has its own tab, with sub/dub and season handling.
              </span>
              <button className="btn small" onClick={() => setType('anime')}>
                Search “{query}” in Anime
              </button>
            </div>
          )}
          {results.data && !shown.length && !hiddenAnime && <div className="empty">Nothing found for “{query}”.</div>}
          <div className="grid">
            {shown.map((r) => (
              <ResultCard key={`${r.type}-${r.tmdbId ?? r.anilistId}`} r={r} onRequest={setAdding} onOpen={setViewing} />
            ))}
          </div>
        </>
      ) : (
        <>
          {browse.isLoading && <BrowseSkeleton />}
          {browse.error && (
            <div className="error-box">
              Couldn’t load {typeLabel[type].toLowerCase()} to browse: {(browse.error as Error).message}
            </div>
          )}
          <ContinueRow type={type} onOpen={setViewing} />
          {browse.data?.rows.map((row) => <BrowseRow key={row.id} row={row} onRequest={setAdding} onOpen={setViewing} />)}
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
