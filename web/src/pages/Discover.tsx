import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, typeLabel, type MediaType, type SearchResult } from '../api';
import AddDialog from '../components/AddDialog';
import Hero, { type FeaturedItem } from '../components/Hero';
import MediaDetails from '../components/MediaDetails';
import Rail, { RailSkeleton } from '../components/Rail';

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
  const sub = [r.year, r.extra].filter(Boolean).join(' · ');
  return (
    <div className="home-poster-card discover-card">
      <div className="discover-art">
        <button type="button" className="home-poster-link" onClick={() => onOpen(r)} aria-label={`${r.title} details`}>
          <div className="home-poster">
            {r.poster ? <img src={r.poster} alt="" loading="lazy" decoding="async" /> : <div className="home-thumb-fallback">{r.title.slice(0, 1)}</div>}
            {r.libraryId ? <span className="discover-owned">In library</span> : null}
          </div>
        </button>
        {!r.libraryId && (
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
