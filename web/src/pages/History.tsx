import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, timeAgo, type HistoryItem } from '../api';

const EVENT_CLASS: Record<string, string> = {
  grabbed: 'info',
  imported: 'ok',
  moved: 'info',
  failed: 'danger',
  added: 'muted',
  removed: 'muted',
  refreshed: 'muted',
  search: 'warn',
};

export default function History() {
  const history = useQuery({
    queryKey: ['history'],
    queryFn: () => api.get<HistoryItem[]>('/api/history'),
    refetchInterval: 10000,
  });
  return (
    <div className="page">
      <header className="page-header">
        <h1>History</h1>
      </header>
      {history.data && !history.data.length && <div className="empty">No activity yet.</div>}
      <ul className="timeline">
        {history.data?.map((h) => (
          <li key={h.id}>
            <span className={`badge ${EVENT_CLASS[h.event] ?? 'muted'}`}>{h.event}</span>
            <div className="timeline-body">
              {h.media_id && h.media_title && (
                <Link to={`/media/${h.media_id}`} className="strong">
                  {h.media_title}
                </Link>
              )}
              <span>{h.message}</span>
            </div>
            <span className="muted small nowrap" title={new Date(h.created_at).toLocaleString()}>
              {timeAgo(h.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
