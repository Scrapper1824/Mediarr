import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, typeLabel, type MediaType, type SearchResult } from '../api';
import Modal from './Modal';

interface Unmatched {
  type: MediaType;
  root: string;
  folder: string;
  guess: { title: string; year: number | null };
  reason: string;
}
interface ScanStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  current: string | null;
  added: { id: number; type: MediaType; title: string }[];
  linked: number;
  missing: number;
  unmatched: Unmatched[];
  error: string | null;
}

/** Settings → Library: find titles already in the library folders, like Jellyfin. */
export default function LibraryScanPanel({ hours, setHours }: { hours: number; setHours: (h: number) => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['library-scan'],
    queryFn: () => api.get<ScanStatus>('/api/library/scan'),
    refetchInterval: (q) => (q.state.data?.running ? 1000 : false),
  });
  const scan = useMutation({
    mutationFn: () => api.post<ScanStatus>('/api/library/scan'),
    onSuccess: (s) => qc.setQueryData(['library-scan'], s),
  });
  const [identifying, setIdentifying] = useState<Unmatched | null>(null);
  const s = status.data;
  const finished = s?.finishedAt && !s.running;

  // When a scan finishes, the library lists change.
  const running = !!s?.running;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) qc.invalidateQueries({ queryKey: ['media'] });
    wasRunning.current = running;
  }, [running, qc]);

  return (
    <section className="panel">
      <h3>Find what’s already there</h3>
      <p className="muted small">
        Adds titles that are already in your library folders, Jellyfin-style: each folder is matched to TMDB or AniList by its name (e.g.
        <code> Dune (2021)</code>, <code>Frieren</code>, or with a <code>[tmdbid-438631]</code> / <code>[anilist-154587]</code> tag) and its
        video files are linked to their episodes. Nothing is renamed, moved or downloaded. Each title needs its own folder.
      </p>
      <div className="row wrap">
        <button type="button" className="btn" disabled={s?.running || scan.isPending} onClick={() => scan.mutate()}>
          {s?.running ? 'Scanning…' : 'Scan library folders now'}
        </button>
        <label className="row small muted">
          Also scan every
          <input className="input scan-hours" type="number" min={0} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          hours (0 = only by hand)
        </label>
      </div>
      {s?.running && <div className="muted small">{s.current ? `Looking at ${s.current}…` : 'Starting…'}</div>}
      {s?.error && <div className="error-box">{s.error}</div>}
      {finished && (
        <div className="scan-summary">
          <span>
            Last scan {new Date(s.finishedAt!).toLocaleString()}: <strong>{s.added.length}</strong> title{s.added.length === 1 ? '' : 's'} added,{' '}
            <strong>{s.linked}</strong> file{s.linked === 1 ? '' : 's'} found
            {s.missing ? (
              <>
                , <strong>{s.missing}</strong> missing file{s.missing === 1 ? '' : 's'} removed
              </>
            ) : null}
            .
          </span>
          {s.added.length > 0 && (
            <ul className="scan-list">
              {s.added.map((a) => (
                <li key={a.id}>
                  <span className="badge muted">{typeLabel[a.type]}</span> <Link to={`/media/${a.id}`}>{a.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {s && s.unmatched.length > 0 && (
        <div className="scan-unmatched">
          <strong>Needs identifying ({s.unmatched.length})</strong>
          <ul className="scan-list">
            {s.unmatched.map((u) => (
              <li key={`${u.type}-${u.root}-${u.folder}`}>
                <div className="scan-folder">
                  <span className="badge muted">{typeLabel[u.type]}</span> <span title={`${u.root}\\${u.folder}`}>{u.folder}</span>
                  <div className="muted small">{u.reason}</div>
                </div>
                <button type="button" className="btn small" onClick={() => setIdentifying(u)}>
                  Identify…
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {identifying && <IdentifyDialog item={identifying} onClose={() => setIdentifying(null)} />}
    </section>
  );
}

/** Pick the right TMDB/AniList title for a folder by hand. */
function IdentifyDialog({ item, onClose }: { item: Unmatched; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(item.guess.title);
  const [query, setQuery] = useState(item.guess.title);
  const results = useQuery({
    queryKey: ['identify', item.type, query],
    queryFn: () => api.get<SearchResult[]>(`/api/discover/search?type=${item.type}&q=${encodeURIComponent(query)}`),
    enabled: !!query.trim(),
  });
  const pick = useMutation({
    mutationFn: (r: SearchResult) =>
      api.post<{ id: number; status: ScanStatus }>('/api/library/identify', {
        type: item.type,
        root: item.root,
        folder: item.folder,
        tmdbId: r.tmdbId,
        anilistId: r.anilistId,
      }),
    onSuccess: (r) => {
      qc.setQueryData(['library-scan'], r.status);
      qc.invalidateQueries({ queryKey: ['media'] });
      onClose();
    },
  });

  return (
    <Modal title={`Which ${item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : 'anime'} is “${item.folder}”?`} onClose={onClose} wide>
      <div className="row">
        <input
          className="input grow"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setQuery(q);
            }
          }}
          autoFocus
          placeholder="Search by title"
        />
        <button type="button" className="btn" onClick={() => setQuery(q)}>
          Search
        </button>
      </div>
      {results.isLoading && <div className="muted">Searching…</div>}
      {results.error && <div className="error-box">{(results.error as Error).message}</div>}
      {results.data && !results.data.length && <div className="muted">No results. Try another spelling.</div>}
      <ul className="identify-results">
        {results.data?.map((r) => (
          <li key={`${r.tmdbId ?? r.anilistId}`}>
            {r.poster ? <img src={r.poster} alt="" loading="lazy" /> : <div className="identify-noposter" />}
            <div className="identify-text">
              <strong>{r.title}</strong>
              <span className="muted small">{[r.year, r.extra].filter(Boolean).join(' · ')}</span>
              {r.libraryId ? <span className="muted small">Already in your library</span> : null}
            </div>
            <button type="button" className="btn small primary" disabled={pick.isPending || !!r.libraryId} onClick={() => pick.mutate(r)}>
              This one
            </button>
          </li>
        ))}
      </ul>
      {pick.error && <div className="error-box">{(pick.error as Error).message}</div>}
    </Modal>
  );
}
