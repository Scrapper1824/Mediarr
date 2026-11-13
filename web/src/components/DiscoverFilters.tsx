import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MediaType } from '../api';

/** What can be filtered on Discover. Strings so they can sit in selects and the URL as they are. */
export interface Filters {
  sort: string;
  status: string;
  minRating: string;
  yearFrom: string;
  yearTo: string;
  genres: string[];
  language: string;
  audio: string;
  formats: string[];
  season: string;
}

export const emptyFilters = (): Filters => ({
  sort: 'popular',
  status: '',
  minRating: '',
  yearFrom: '',
  yearTo: '',
  genres: [],
  language: '',
  audio: '',
  formats: [],
  season: '',
});

/** How many filters are set (a sort other than "Popular" counts). */
export function activeCount(f: Filters): number {
  return (
    (f.sort !== 'popular' ? 1 : 0) +
    (f.status ? 1 : 0) +
    (f.minRating ? 1 : 0) +
    (f.yearFrom || f.yearTo ? 1 : 0) +
    f.genres.length +
    (f.language ? 1 : 0) +
    (f.audio ? 1 : 0) +
    f.formats.length +
    (f.season ? 1 : 0)
  );
}

/** The query string for /api/discover/filter. */
export function filterQuery(type: MediaType, f: Filters, q: string): string {
  const p = new URLSearchParams({ type, sort: f.sort });
  const add = (k: string, v: string) => v && p.set(k, v);
  add('status', f.status);
  add('minRating', f.minRating);
  add('yearFrom', f.yearFrom);
  add('yearTo', f.yearTo);
  add('genres', f.genres.join(','));
  if (type === 'anime') {
    add('audio', f.audio);
    add('formats', f.formats.join(','));
    add('season', f.season);
    add('q', q);
  } else {
    add('language', f.language);
  }
  return p.toString();
}

const SORTS: Record<MediaType, [string, string][]> = {
  movie: [['popular', 'Popular'], ['top', 'Top rated'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['title', 'A–Z']],
  show: [['popular', 'Popular'], ['top', 'Top rated'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['title', 'A–Z']],
  anime: [['popular', 'Popular'], ['trending', 'Trending'], ['top', 'Top rated'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['title', 'A–Z']],
};
const STATUSES: Record<MediaType, [string, string][]> = {
  movie: [['', 'Any'], ['released', 'Released'], ['upcoming', 'Coming soon']],
  show: [['', 'Any'], ['airing', 'Airing'], ['ended', 'Ended'], ['upcoming', 'Coming soon']],
  anime: [['', 'Any'], ['airing', 'Airing'], ['finished', 'Completed'], ['upcoming', 'Coming soon']],
};
const RATINGS: [string, string][] = [['', 'Any'], ['6', '6+'], ['7', '7+'], ['8', '8+']];
const AUDIO: [string, string][] = [['', 'Any'], ['dub', 'English dub'], ['sub', 'Sub only']];
const FORMATS: [string, string][] = [['TV', 'TV'], ['MOVIE', 'Movie'], ['OVA', 'OVA'], ['ONA', 'ONA'], ['SPECIAL', 'Special']];
const SEASONS: [string, string][] = [['', 'Any season'], ['WINTER', 'Winter'], ['SPRING', 'Spring'], ['SUMMER', 'Summer'], ['FALL', 'Fall']];
const LANGUAGES: [string, string][] = [
  ['', 'Any language'],
  ['en', 'English'],
  ['ko', 'Korean'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
  ['hi', 'Hindi'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['tr', 'Turkish'],
  ['th', 'Thai'],
  ['ru', 'Russian'],
];
const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: thisYear + 2 - 1950 + 1 }, (_, i) => String(thisYear + 2 - i));

export function useGenres(type: MediaType) {
  return useQuery({
    queryKey: ['discover', 'genres', type],
    queryFn: () => api.get<{ id: string; name: string; group?: 'genre' | 'theme'; popular?: boolean }[]>(`/api/discover/genres?type=${type}`),
    staleTime: 24 * 3600_000,
  });
}

function Pills({ options, value, onChange, label }: { options: [string, string][]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="segmented small filter-pills" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={v || 'any'} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`filter-field${wide ? ' wide' : ''}`}>
      <span className="filter-label">{label}</span>
      {children}
    </div>
  );
}

/** The filter panel under the search bar. */
export function FilterPanel({
  type,
  value,
  onChange,
  searching,
}: {
  type: MediaType;
  value: Filters;
  onChange: (f: Filters) => void;
  /** Movies/shows: a text search is showing (TMDB can't combine it with filters). */
  searching: boolean;
}) {
  const genres = useGenres(type);
  const [themeSearch, setThemeSearch] = useState('');
  const allGenres = genres.data ?? [];
  const plainGenres = allGenres.filter((g) => g.group !== 'theme');
  const themes = allGenres.filter((g) => g.group === 'theme');
  const term = themeSearch.trim().toLowerCase();
  // Popular themes, any picked ones, and whatever matches what's typed.
  const shownThemes = term
    ? themes.filter((t) => t.name.toLowerCase().includes(term) || value.genres.includes(t.id))
    : themes.filter((t) => t.popular || value.genres.includes(t.id));
  // The search box covers genres too; picked ones always stay visible.
  const shownGenres = term ? plainGenres.filter((g) => g.name.toLowerCase().includes(term) || value.genres.includes(g.id)) : plainGenres;
  const chip = (g: { id: string; name: string }) => (
    <button type="button" key={g.id} aria-pressed={value.genres.includes(g.id)} className={`filter-chip${value.genres.includes(g.id) ? ' on' : ''}`} onClick={() => toggle('genres', g.id)}>
      {g.name}
    </button>
  );
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  const toggle = (k: 'genres' | 'formats', v: string) => set(k, value[k].includes(v) ? value[k].filter((x) => x !== v) : [...value[k], v]);
  const n = activeCount(value);

  return (
    <section className="filter-panel" aria-label="Filters">
      {searching && <p className="hint filter-note">Filters apply when browsing. Clear the search to use them.</p>}
      <div className="filter-grid">
        <Field label="Sort by">
          <select className="input filter-select" value={value.sort} onChange={(e) => set('sort', e.target.value)}>
            {SORTS[type].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <Pills label="Status" options={STATUSES[type]} value={value.status} onChange={(v) => set('status', v)} />
        </Field>
        {type === 'anime' && (
          <Field label="Audio">
            <Pills label="Audio" options={AUDIO} value={value.audio} onChange={(v) => set('audio', v)} />
          </Field>
        )}
        <Field label="Rating">
          <Pills label="Rating" options={RATINGS} value={value.minRating} onChange={(v) => set('minRating', v)} />
        </Field>
        <Field label="Year">
          <div className="filter-years">
            <select className="input filter-select" aria-label="From year" value={value.yearFrom} onChange={(e) => set('yearFrom', e.target.value)}>
              <option value="">From</option>
              {YEARS.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
            <span className="muted">–</span>
            <select className="input filter-select" aria-label="To year" value={value.yearTo} onChange={(e) => set('yearTo', e.target.value)}>
              <option value="">To</option>
              {YEARS.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </div>
        </Field>
        {type === 'anime' ? (
          <Field label="Season">
            <select className="input filter-select" value={value.season} onChange={(e) => set('season', e.target.value)}>
              {SEASONS.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Original language">
            <select className="input filter-select" value={value.language} onChange={(e) => set('language', e.target.value)}>
              {LANGUAGES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'anime' && (
          <Field label="Format" wide>
            <div className="filter-chips">
              {FORMATS.map(([v, t]) => (
                <button type="button" key={v} aria-pressed={value.formats.includes(v)} className={`filter-chip${value.formats.includes(v) ? ' on' : ''}`} onClick={() => toggle('formats', v)}>
                  {t}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label={value.genres.length > 1 ? 'Genres (has all of them)' : 'Genres'} wide>
          {themes.length > 0 && (
            <input
              className="input filter-theme-search"
              type="search"
              placeholder={`Search all ${plainGenres.length + themes.length} genres and themes (isekai, sports, vampires…)`}
              value={themeSearch}
              onChange={(e) => setThemeSearch(e.target.value)}
              aria-label="Search genres and themes"
            />
          )}
          <div className="filter-chips">
            {genres.isLoading && <span className="muted small">Loading genres…</span>}
            {genres.error && <span className="error-text small">{(genres.error as Error).message}</span>}
            {shownGenres.map(chip)}
          </div>
          {shownThemes.length > 0 && (
            <>
              <span className="filter-sublabel">{term ? 'Themes' : 'Most used themes'}</span>
              <div className="filter-chips">{shownThemes.map(chip)}</div>
            </>
          )}
          {term && !shownGenres.length && !shownThemes.length && <span className="muted small">Nothing called “{themeSearch.trim()}”.</span>}
        </Field>
      </div>
      {type === 'anime' && value.audio && <p className="hint filter-note">Dub information comes from AnimeSchedule.</p>}
      {n > 0 && (
        <div className="row end">
          <button type="button" className="btn small ghost" onClick={() => onChange(emptyFilters())}>
            Clear {n} filter{n === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </section>
  );
}
