import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type SearchResult, type Settings } from '../api';
import { useAuth } from './AuthGate';
import Modal from './Modal';
import Spinner from './Spinner';

interface ShowDetails {
  seasons: { season: number; name: string; episodeCount: number; airDate: string | null }[];
}

export default function AddDialog({ item, onClose }: { item: SearchResult; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // This user's requests wait for an admin.
  const asking = !!useAuth().data?.user?.needsApproval;
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const details = useQuery({
    queryKey: ['details', item.type, item.tmdbId ?? item.anilistId],
    queryFn: () => api.get<ShowDetails>(`/api/discover/details?type=${item.type}&id=${item.tmdbId ?? item.anilistId}`),
    enabled: item.type !== 'movie',
  });

  const [monitored, setMonitored] = useState(true);
  const [searchNow, setSearchNow] = useState(true);
  const [audio, setAudio] = useState<'sub' | 'dub' | null>(null);
  const [seasons, setSeasons] = useState<Set<number> | null>(null);

  const allSeasons = details.data?.seasons ?? [];
  const selected = seasons ?? new Set(allSeasons.filter((s) => s.season > 0).map((s) => s.season));
  const effectiveAudio = audio ?? settings.data?.defaultAnimeAudio ?? 'sub';
  const isSeries = item.type !== 'movie';
  const noSeasons = isSeries && details.isSuccess && allSeasons.length > 0 && selected.size === 0;

  const add = useMutation({
    mutationFn: () =>
      api.post<{ id?: number; pending?: boolean }>('/api/media', {
        type: item.type,
        tmdbId: item.tmdbId,
        anilistId: item.anilistId,
        monitored,
        searchNow,
        seasons: item.type !== 'movie' && details.data ? [...selected] : undefined,
        animeAudio: item.type === 'anime' ? effectiveAudio : undefined,
      }),
    onSuccess: ({ id, pending }) => {
      qc.invalidateQueries({ queryKey: ['media'] });
      qc.invalidateQueries({ queryKey: ['discover'] });
      qc.invalidateQueries({ queryKey: ['requests'] });
      if (!pending && id) navigate(`/media/${id}`);
    },
  });

  const toggleSeason = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setSeasons(next);
  };

  return (
    <Modal title={`Add ${item.title}${item.year ? ` (${item.year})` : ''}`} onClose={onClose}>
      <div className="add-layout">
        {item.poster && <img className="add-poster" src={item.poster} alt="" />}
        <div className="stack">
          <p className="muted clamp-4">{item.overview || 'No overview available.'}</p>

          {item.type === 'anime' && (
            <div className="field">
              <span className="field-label">Audio</span>
              <div className="segmented">
                {(['sub', 'dub'] as const).map((a) => (
                  <button key={a} className={effectiveAudio === a ? 'on' : ''} onClick={() => setAudio(a)}>
                    {a === 'sub' ? 'Subbed (Japanese audio)' : 'Dubbed (English audio)'}
                  </button>
                ))}
              </div>
              <span className="hint">
                {effectiveAudio === 'dub'
                  ? 'Only releases marked Dub / Dual Audio will be downloaded.'
                  : 'Dub-only releases are skipped; plain subbed releases are preferred.'}
              </span>
            </div>
          )}

          {item.type !== 'movie' && (
            <div className="field">
              <span className="field-label">Seasons to download</span>
              {details.isLoading ? (
                <span className="muted row">
                  <Spinner /> Loading seasons…
                </span>
              ) : (
                <div className="season-picks">
                  {allSeasons.map((s) => (
                    <label key={s.season} className="check">
                      <input type="checkbox" checked={selected.has(s.season)} onChange={() => toggleSeason(s.season)} />
                      <span>
                        {s.season === 0 ? 'Specials' : `Season ${s.season}`}{' '}
                        <span className="muted">({s.episodeCount})</span>
                        {item.type === 'anime' && <span className="muted small block">{s.name}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="check">
            <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
            <span>
              {isSeries ? 'Also get new episodes & seasons as they air' : 'Keep looking until it’s downloaded'}
              {isSeries && <span className="muted small block">The seasons ticked above are downloaded either way.</span>}
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={searchNow} onChange={(e) => setSearchNow(e.target.checked)} />
            <span>Start searching now</span>
          </label>

          {asking && !add.data?.pending && (
            <div className="hint">An admin approves your requests before anything downloads.</div>
          )}
          {add.data?.pending && (
            <div className="ok-box">
              Request sent. It’s waiting for an admin to approve it; you can follow it on the <Link to="/requests" onClick={onClose}>Requests</Link> page.
            </div>
          )}
          {add.isPending && (
            <div className="progress-note">
              <Spinner />
              <span>
                Adding {item.title}…{' '}
                <span className="muted">{asking ? 'sending your request to an admin.' : `${isSeries ? 'getting the episode list' : 'getting movie details'}, then searching starts.`}</span>
              </span>
            </div>
          )}
          {noSeasons && <div className="hint">Tick at least one season to request.</div>}
          {add.error && <div className="error-box">{(add.error as Error).message}</div>}
          <div className="row end">
            <button className="btn ghost" onClick={onClose} disabled={add.isPending}>
              {add.data?.pending ? 'Close' : 'Cancel'}
            </button>
            {!add.data?.pending && (
              <button
                className="btn primary"
                disabled={add.isPending || (isSeries && details.isLoading) || noSeasons}
                onClick={() => add.mutate()}
              >
                {add.isPending && <Spinner />}
                {asking ? (add.isPending ? 'Sending…' : 'Send request') : add.isPending ? 'Adding…' : 'Add & request'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
