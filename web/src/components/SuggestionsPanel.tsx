import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatSize, type Suggestion } from '../api';

/** Asks whether to download a bigger bundle when the requested season had no pack of its own. */
export default function SuggestionsPanel({ suggestions }: { suggestions: Suggestion[] }) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['media'] });
    qc.invalidateQueries({ queryKey: ['queue'] });
  };
  const accept = useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'wanted' | 'all' }) => api.post(`/api/suggestions/${id}/accept`, { mode }),
    onSuccess: refresh,
  });
  const dismiss = useMutation({ mutationFn: (id: number) => api.post(`/api/suggestions/${id}/dismiss`), onSuccess: refresh });

  if (!suggestions.length) return null;
  const bySeason = new Map<number, Suggestion[]>();
  for (const s of suggestions) bySeason.set(s.season, [...(bySeason.get(s.season) ?? []), s]);

  return (
    <section className="suggestions">
      {[...bySeason].map(([season, list]) => (
        <div key={season} className="suggestion-group">
          <div className="suggestion-head">
            <strong>No pack found for just Season {season}.</strong>
            <span className="muted">
              {list.length === 1 ? 'This bundle includes it.' : `These ${list.length} bundles include it.`} Mediarr can grab
              just Season {season} from it and skip the rest.
            </span>
          </div>
          {list.map((s) => (
            <div key={s.id} className="suggestion">
              <div className="suggestion-info">
                <div className="release-title">{s.title}</div>
                <div className="chips">
                  <span className="chip bundle">{s.label}</span>
                  {s.release.resolution && <span className="chip">{s.release.resolution}</span>}
                  <span className={`chip audio-${s.release.audio}`}>{s.release.audio}</span>
                  <span className="chip">{formatSize(s.release.size)}</span>
                  <span className="chip">{s.release.seeders ?? 0} seeds</span>
                  <span className="chip">{s.release.indexer}</span>
                </div>
              </div>
              <div className="row">
                <button
                  className="btn small primary"
                  disabled={accept.isPending}
                  title={`Only the Season ${s.season} episodes (plus any other seasons you ticked) are downloaded`}
                  onClick={() => accept.mutate({ id: s.id, mode: 'wanted' })}
                >
                  {accept.isPending && accept.variables?.id === s.id && accept.variables.mode === 'wanted'
                    ? 'Sending…'
                    : `Just Season ${s.season}`}
                </button>
                <button
                  className="btn small"
                  disabled={accept.isPending}
                  title="Download everything in the bundle"
                  onClick={() => accept.mutate({ id: s.id, mode: 'all' })}
                >
                  {accept.isPending && accept.variables?.id === s.id && accept.variables.mode === 'all' ? 'Sending…' : 'Whole bundle'}
                </button>
                <button className="btn small ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)}>
                  No thanks
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {(accept.error || dismiss.error) && <div className="error-box">{((accept.error || dismiss.error) as Error).message}</div>}
      <p className="hint">
        "Just Season {[...bySeason.keys()].join(', ')}" tells qBittorrent to skip the other episodes and extras in the bundle.
        "Whole bundle" downloads everything and adds the extra seasons too. Episodes you already have are always kept.
      </p>
    </section>
  );
}
