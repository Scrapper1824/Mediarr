import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatSize, timeAgo, type Download } from '../api';
import { useIsAdmin } from '../components/AuthGate';

/** "45 s", "12 min", "2 h 5 min", "3 days". */
function timeLeft(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

export default function Queue() {
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  // Every 2 s while something is downloading (the server asks qBittorrent live), slower otherwise.
  const queue = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Download[]>('/api/queue'),
    refetchInterval: (q) => (q.state.data?.some((d) => d.state === 'queued' || d.state === 'downloading') ? 2000 : 10000),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['queue'] });

  const remove = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => api.del(`/api/queue/${id}?deleteFiles=${deleteFiles}`),
    onSuccess: invalidate,
  });
  const retry = useMutation({ mutationFn: (id: number) => api.post(`/api/queue/${id}/retry-import`), onSuccess: invalidate });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Downloads</h1>
        <p className="muted">Progress comes live from qBittorrent. Finished downloads are renamed, moved into the library and removed from qBittorrent.</p>
      </header>
      {queue.isLoading && <div className="loading">Loading…</div>}
      {queue.data && !queue.data.length && <div className="empty">Nothing downloading.</div>}
      {queue.data && queue.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Release</th>
                <th className="num">Size</th>
                <th style={{ width: 180 }}>Progress</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.data.map((d) => (
                <tr key={d.id}>
                  <td className="nowrap">
                    <Link to={`/media/${d.media_id}`}>{d.media_title}</Link>
                  </td>
                  <td>
                    <div className="release-title">{d.release_title}</div>
                    {!!d.select_files && <span className="chip bundle">Wanted files only</span>}
                    {d.error && <div className="error-text small">{d.error}</div>}
                  </td>
                  <td className="num">{formatSize(d.size)}</td>
                  <td>
                    {d.state === 'failed' ? (
                      <span className="badge state-failed">failed</span>
                    ) : (
                      <>
                        <div className="progress" title={d.state}>
                          <div className="progress-bar" style={{ width: `${Math.round(d.progress * 100)}%` }} />
                          <span>{d.state === 'downloading' ? `${Math.round(d.progress * 100)}%` : d.state}</span>
                        </div>
                        {d.state === 'downloading' && d.speed !== undefined && (
                          <div className="muted small download-rate">
                            {d.speed ? `${formatSize(d.speed)}/s` : 'Stalled'}
                            {d.eta ? ` · ${timeLeft(d.eta)} left` : ''}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="muted small nowrap">{timeAgo(d.created_at)}</td>
                  <td className="nowrap actions">
                    {isAdmin && d.state === 'failed' && d.error?.startsWith('Import failed') && (
                      <button className="btn small" onClick={() => retry.mutate(d.id)}>
                        Retry import
                      </button>
                    )}
                    {isAdmin && (
                    <button
                      className="icon-btn"
                      title="Remove"
                      onClick={() => {
                        if (d.state === 'failed') return remove.mutate({ id: d.id, deleteFiles: false });
                        if (confirm('Remove this download from qBittorrent?'))
                          remove.mutate({ id: d.id, deleteFiles: confirm('Also delete the downloaded data?') });
                      }}
                    >
                      ✕
                    </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
