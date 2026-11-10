import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatSize, timeAgo, type Download } from '../api';
import { useIsAdmin } from '../components/AuthGate';

export default function Queue() {
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const queue = useQuery({ queryKey: ['queue'], queryFn: () => api.get<Download[]>('/api/queue'), refetchInterval: 5000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['queue'] });

  const remove = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) => api.del(`/api/queue/${id}?deleteFiles=${deleteFiles}`),
    onSuccess: invalidate,
  });
  const retry = useMutation({ mutationFn: (id: number) => api.post(`/api/queue/${id}/retry-import`), onSuccess: invalidate });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Queue</h1>
        <p className="muted">Synced with qBittorrent every 30 seconds. Finished downloads are renamed and removed from qBittorrent.</p>
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
                      <div className="progress" title={d.state}>
                        <div className="progress-bar" style={{ width: `${Math.round(d.progress * 100)}%` }} />
                        <span>{d.state === 'downloading' ? `${Math.round(d.progress * 100)}%` : d.state}</span>
                      </div>
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
