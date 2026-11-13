import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, typeLabel, watchId, type MediaType, type SearchResult } from '../api';
import AddDialog from '../components/AddDialog';
import Hero, { type FeaturedItem } from '../components/Hero';
import MediaDetails from '../components/MediaDetails';
import Rail, { RailSkeleton } from '../components/Rail';
import { activeCount, emptyFilters, FilterPanel, filterQuery, type Filters } from '../components/DiscoverFilters';
import WatchlistMenu from '../components/WatchlistMenu';
import { useWatchTags } from '../watchTags';

interface BrowseRowData {
  id: string;
  title: string;
  items: SearchResult[];
}

/** A Discover card, like Home's: the art (and the name) opens the details; + requests it straight away. */
function ResultCard({
  r,
  onRequest,
  onOpen,
}: {
  r: SearchResult;
  onRequest: (r: SearchResult) => void;
  onOpen: (r: SearchResult) => void;
}) {
  const sub = [r.year, r.extra, r.dubbed ? 'Dub' : null].filter(Boolean).join(' · ');
  // Your watchlist status (every card shares one fetch of your lists).
  const watch = useWatchTags()(r);
  const wid = watchId(r);
  return (
    <div className="home-poster-card discover-card">
      <div className="discover-art">
        <button type="button" className="home-poster-link" onClick={() => onOpen(r)} aria-label={`${r.title} details`}>
          <div className="home-poster">
            {r.poster ? <img src={r.poster} alt="" loading="lazy" decoding="async" /> : <div className="home-thumb-fallback">{r.title.slice(0, 1)}</div>}
            {r.libraryId ? <span className="discover-owned">In library</span> : r.requested ? <span className="discover-owned discover-requested">Requested</span> : null}
          </div>
        </button>
        {watch && wid && (
          <WatchlistMenu
            variant="tag"
            className={`discover-tag ${watch.status ? 'on' : 'off'}`}
            type={r.type}
            id={wid}
            status={watch.status}
            info={{ title: r.title, year: r.year, poster: r.poster }}
          />
        )}
        {!r.libraryId && !r.requested && (
          <button type="button" className="discover-add" onClick={() => onRequest(r)} aria-label={`Request ${r.title}`} title="Request">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      <button type="button" className="home-card-title discover-name" onClick={() => onOpen(r)} title={r.title}>
        {r.title}
      </button>
      {sub && <span className="home-card-sub">{sub}</span>}
    </div>
  );
}

/** One row ("Trending this week", ...): the same scrolling row as Home. */
function BrowseRow({
  row,
  onRequest,
  onOpen,
}: {
  row: BrowseRowData;
  onRequest: (r: SearchResult) => void;
  onOpen: (r: SearchResult) => void;
}) {
  if (!row.items.length) return null;
  return (
    <Rail title={row.title}>
      {row.items.map((r) => (
        <ResultCard key={`${r.type}-${r.tmdbId ?? r.anilistId}`} r={r} onRequest={onRequest} onOpen={onOpen} />
      ))}
    </Rail>
  );
}

function BrowseSkeleton() {
  return (
    <>
      <RailSkeleton />
      <RailSkeleton />
    </>
  );
}

/** Titles matching the filters, a page at a time (the next page loads as you reach the bottom). */
function FilteredResults({
  type,
  filters,
  q,
  onRequest,
  onOpen,
}: {
  type: MediaType;
  filters: Filters;
  q: string;
  onRequest: (r: SearchResult) => void;
  onOpen: (r: SearchResult) => void;
}) {
  const qs = filterQuery(type, filters, q);
  const list = useInfiniteQuery({
    queryKey: ['discover', 'filter', qs],
    queryFn: ({ pageParam }) => api.get<{ items: SearchResult[]; nextPage: number | null }>(`/api/discover/filter?${qs}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    staleTime: 10 * 60_000,
  });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // The same title can come back on two pages when the list shifts while you scroll.
  const seen = new Set<string>();
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []).filter((r) => {
    const k = `${r.type}-${r.tmdbId ?? r.anilistId}`;
    return !seen.has(k) && !!seen.add(k);
  });

  // A narrow filter (e.g. sub-only among popular action anime, which are nearly all dubbed) can leave
  // the first pages almost empty: keep looking for a few pages before leaving it to "Load more".
  const pages = list.data?.pages.length ?? 0;
  const AUTO_PAGES = 4;
  const lookingFurther = list.isSuccess && items.length < 12 && !!list.hasNextPage && pages < AUTO_PAGES;
  useEffect(() => {
    if (lookingFurther && !list.isFetchingNextPage && !list.isError) list.fetchNextPage();
  }, [lookingFurther, list.isFetchingNextPage, list.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="filtered-results" aria-busy={list.isFetching}>
      {list.isLoading && <div className="loading">Finding {typeLabel[type].toLowerCase()}…</div>}
      {list.error && <div className="error-box">{(list.error as Error).message}</div>}
      {lookingFurther && !items.length && <div className="loading">Still looking… few titles match these filters.</div>}
      {list.isSuccess && !items.length && !list.hasNextPage && <div className="empty">Nothing matches these filters. Try loosening one.</div>}
      {list.isSuccess && !items.length && !!list.hasNextPage && !lookingFurther && (
        <div className="empty">Nothing matched among the titles checked so far. Load more to keep looking, or loosen a filter.</div>
      )}
      <div className="grid">
        {items.map((r) => (
          <ResultCard key={`${r.type}-${r.tmdbId ?? r.anilistId}`} r={r} onRequest={onRequest} onOpen={onOpen} />
        ))}
      </div>
      <div ref={end} />
      {list.hasNextPage && (
        <div className="row center filtered-more">
          <button className="btn" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}

/** Every visit to Discover starts without filters (each tab keeps its own while you're on the page). */
function noFilters(): Record<MediaType, Filters> {
  // Filters saved by older versions aren't used any more.
  try {
    sessionStorage.removeItem('mediarr.discoverFilters');
  } catch {
    // storage blocked: nothing to clear
  }
  return { movie: emptyFilters(), show: emptyFilters(), anime: emptyFilters() };
}

export default function Discover() {
  const [type, setType] = useState<MediaType>('movie');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState<SearchResult | null>(null);
  const [viewing, setViewing] = useState<SearchResult | null>(null);
  const [allFilters, setAllFilters] = useState(noFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filters = allFilters[type];
  const nFilters = activeCount(filters);
  const setFilters = (next: Filters) => setAllFilters({ ...allFilters, [type]: next });
  // Filtering (panel open or something set) shows a results grid instead of the curated rows.
  const filtering = filtersOpen || nFilters > 0;
  // Anime searches can be combined with filters (AniList); TMDB's text search can't.
  const filteredSearch = filtering && (!query || type === 'anime');

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
  const showHero = !query && !filtering && (browse.isLoading || featured.length > 0);

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
        <button
          type="button"
          className={`btn filter-toggle${filtersOpen || nFilters ? ' on' : ''}`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
          </svg>
          Filters
          {nFilters > 0 && <span className="filter-count">{nFilters}</span>}
        </button>
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
          {filtersOpen && <FilterPanel type={type} value={filters} onChange={setFilters} searching={!!query && type !== 'anime'} />}
        </>
      )}

      {filteredSearch ? (
        <>
          {query && (
            <div className="row between search-heading">
              <h2>
                Results for “{query}” <span className="muted">in {typeLabel[type]}, filtered</span>
              </h2>
              <button className="btn small ghost" onClick={clearSearch}>
                ← Clear search
              </button>
            </div>
          )}
          <FilteredResults type={type} filters={filters} q={query} onRequest={setAdding} onOpen={setViewing} />
        </>
      ) : query ? (
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
