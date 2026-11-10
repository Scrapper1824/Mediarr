import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatSize, type Release } from '../api';
import Modal from './Modal';

export interface ReleaseScope {
  mediaId: number;
  label: string;
  season?: number;
  episodeId?: number;
}

export default function ReleasesDialog({ scope, onClose }: { scope: ReleaseScope; onClose: () => void }) {
  const qc = useQueryClient();
  const [showRejected, setShowRejected] = useState(false);
  const params = new URLSearchParams();
  if (scope.season !== undefined) params.set('season', String(scope.season));
  if (scope.episodeId !== undefined) params.set('episodeId', String(scope.episodeId));

  const releases = useQuery({
    queryKey: ['releases', scope.mediaId, scope.season, scope.episodeId],
    queryFn: () => api.get<Release[]>(`/api/media/${scope.mediaId}/releases?${params}`),
    staleTime: 60_000,
  });

  const [grabbed, setGrabbed] = useState<Set<string>>(new Set());
  const grab = useMutation({
    mutationFn: (r: Release & { onlySeason?: number }) =>
      api.post(`/api/media/${scope.mediaId}/grab`, {
        onlySeason: r.onlySeason,
        title: r.title,
        indexer: r.indexer,
        size: r.size,
        magnetUrl: r.magnetUrl,
        downloadUrl: r.downloadUrl,
        episodeId: scope.episodeId,
      }),
    onSuccess: (_d, r) => {
      setGrabbed((g) => new Set(g).add(r.guid));
      qc.invalidateQueries({ queryKey: ['media'] });
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });

  const list = releases.data ?? [];
  const visible = showRejected ? list : list.filter((r) => !r.rejections.length);
  const rejectedCount = list.length - list.filter((r) => !r.rejections.length).length;

  return (
    <Modal title={`Interactive search · ${scope.label}`} onClose={onClose} wide>
      {releases.isLoading && <div className="loading">Searching indexers through Prowlarr…</div>}
      {releases.error && <div className="error-box">{(releases.error as Error).message}</div>}
      {releases.data && (
        <>
          <div className="row between">
            <span className="muted">
              {list.length} results · {list.length - rejectedCount} acceptable
            </span>
            <label className="check">
              <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
              <span>Show rejected ({rejectedCount})</span>
            </label>
          </div>
          {grab.error && <div className="error-box">{(grab.error as Error).message}</div>}
          <div className="table-wrap">
            <table className="table releases">
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Indexer</th>
                  <th className="num">Size</th>
                  <th className="num">Seeds</th>
                  <th className="num">Score</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.guid} className={r.rejections.length ? 'rejected' : ''}>
                    <td>
                      <div className="release-title">{r.title}</div>
                      <div className="chips">
                        {r.coverage === 'bundle' && (
                          <span className="chip bundle" title="Includes other seasons too">
                            Bundle {r.covers.length > 1 ? `S${r.covers[0]}–S${r.covers[r.covers.length - 1]}` : ''}
                          </span>
                        )}
                        {r.parsed.resolution && <span className="chip">{r.parsed.resolution}</span>}
                        {r.parsed.source && <span className="chip">{r.parsed.source}</span>}
                        <span className={`chip audio-${r.parsed.audio}`}>{r.parsed.audio}</span>
                        {r.rejections.map((x) => (
                          <span key={x} className="chip danger">
                            {x}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="muted">{r.indexer}</td>
                    <td className="num">{formatSize(r.size)}</td>
                    <td className="num">{r.seeders ?? 0}</td>
                    <td className="num">{r.score}</td>
                    <td>
                      {r.coverage === 'bundle' && scope.season !== undefined && !grabbed.has(r.guid) ? (
                        <div className="grab-choice">
                          <button
                            className="btn small primary"
                            title={`Only download Season ${scope.season} from this bundle`}
                            disabled={grab.isPending && grab.variables?.guid === r.guid}
                            onClick={() => grab.mutate({ ...r, onlySeason: scope.season })}
                          >
                            S{scope.season} only
                          </button>
                          <button
                            className="btn small ghost"
                            title="Download the whole bundle"
                            disabled={grab.isPending && grab.variables?.guid === r.guid}
                            onClick={() => grab.mutate(r)}
                          >
                            All
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn small"
                          disabled={grabbed.has(r.guid) || (grab.isPending && grab.variables?.guid === r.guid)}
                          // Season packs: skip the extras (OVAs, NCOP…) inside them.
                          onClick={() => grab.mutate(scope.season !== undefined ? { ...r, onlySeason: scope.season } : r)}
                        >
                          {grabbed.has(r.guid) ? 'Sent ✓' : 'Grab'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No acceptable releases. Try “Show rejected” to see why.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
