import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, timeAgo, type MediaType } from '../api';
import { useIsAdmin } from '../components/AuthGate';
import Spinner from '../components/Spinner';

export interface MediaRequest {
  id: number;
  username: string;
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  seasons: number[] | null;
  status: 'pending' | 'approved' | 'denied';
  mediaId: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<MediaType, string> = { movie: 'Movie', show: 'Show', anime: 'Anime' };
const STATUS: Record<MediaRequest['status'], { label: string; cls: string }> = {
  pending: { label: 'Waiting for approval', cls: 'warn' },
  approved: { label: 'Approved', cls: 'ok' },
  denied: { label: 'Declined', cls: 'danger' },
};

/** Admins: how many requests are waiting (the sidebar badge). */
export { usePendingRequests } from '../pendingRequests';

function seasonText(r: MediaRequest) {
  if (r.type === 'movie' || !r.seasons) return null;
  if (!r.seasons.length) return 'No seasons picked';
  const named = [...r.seasons].sort((a, b) => a - b).map((s) => (s === 0 ? 'Specials' : `S${s}`));
  return named.length > 6 ? `${named.length} seasons` : named.join(', ');
}

function RequestCard({ r, isAdmin }: { r: MediaRequest; isAdmin: boolean }) {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['media'] });
    qc.invalidateQueries({ queryKey: ['discover'] });
  };
  const approve = useMutation({ mutationFn: () => api.post<{ mediaId: number }>(`/api/requests/${r.id}/approve`), onSuccess: done });
  const deny = useMutation({ mutationFn: () => api.post(`/api/requests/${r.id}/deny`), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api.del(`/api/requests/${r.id}`), onSuccess: done });
  const busy = approve.isPending || deny.isPending || cancel.isPending;
  const error = (approve.error || deny.error || cancel.error) as Error | null;
  const status = STATUS[r.status];
  const seasons = seasonText(r);

  return (
    <li className="request-card">
      {r.poster ? <img className="request-poster" src={r.poster} alt="" loading="lazy" /> : <div className="request-poster request-poster-empty">{r.title.slice(0, 1)}</div>}
      <div className="request-body">
        <div className="request-title">
          {r.mediaId ? <Link to={`/media/${r.mediaId}`}>{r.title}</Link> : <strong>{r.title}</strong>}
          {r.year && <span className="muted"> ({r.year})</span>}
        </div>
        <div className="muted small">
          {TYPE_LABEL[r.type]}
          {seasons && <> · {seasons}</>}
          {isAdmin && <> · requested by <strong>{r.username}</strong></>} · {timeAgo(r.createdAt)}
        </div>
        <div className="row wrap request-status">
          <span className={`badge ${status.cls}`}>{status.label}</span>
          {r.decidedBy && r.status !== 'pending' && <span className="muted small">by {r.decidedBy}</span>}
        </div>
        {error && <div className="error-box">{error.message}</div>}
      </div>
      {r.status === 'pending' && (
        <div className="request-actions">
          {isAdmin ? (
            <>
              <button className="btn small primary" disabled={busy} onClick={() => approve.mutate()}>
                {approve.isPending && <Spinner />} Approve
              </button>
              <button className="btn small ghost danger" disabled={busy} onClick={() => deny.mutate()}>
                Decline
              </button>
            </>
          ) : (
            <button className="btn small ghost" disabled={busy} onClick={() => cancel.mutate()}>
              Withdraw
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export default function Requests() {
  const isAdmin = useIsAdmin();
  const list = useQuery({ queryKey: ['requests', 'list'], queryFn: () => api.get<MediaRequest[]>('/api/requests'), refetchInterval: 30_000 });
  const pending = list.data?.filter((r) => r.status === 'pending') ?? [];
  const decided = list.data?.filter((r) => r.status !== 'pending') ?? [];
  return (
    <div className="page">
      <header className="page-header">
        <h1>Requests</h1>
      </header>
      <p className="muted">
        {isAdmin
          ? 'Titles asked for by users whose requests need your approval. Approving adds the title and starts searching.'
          : 'What you’ve asked for. An admin approves each request before it downloads.'}
      </p>
      {list.isLoading && <div className="loading">Loading…</div>}
      {list.data && !list.data.length && <div className="empty">{isAdmin ? 'No requests waiting.' : 'You haven’t requested anything yet. Find something on Discover.'}</div>}
      {pending.length > 0 && (
        <>
          <h2 className="request-heading">Waiting ({pending.length})</h2>
          <ul className="request-list">
            {pending.map((r) => (
              <RequestCard key={r.id} r={r} isAdmin={isAdmin} />
            ))}
          </ul>
        </>
      )}
      {decided.length > 0 && (
        <>
          <h2 className="request-heading">Recently decided</h2>
          <ul className="request-list">
            {decided.map((r) => (
              <RequestCard key={r.id} r={r} isAdmin={isAdmin} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
