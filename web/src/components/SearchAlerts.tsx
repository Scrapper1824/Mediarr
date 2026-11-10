import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type SearchEvent } from '../api';
import Modal from './Modal';

/** Plain-language explanations (and what to do) for the usual rejection reasons. */
const EXPLAIN: Record<string, string> = {
  'Not dubbed': 'Not dubbed. Switch this show to Sub, or wait for a dub.',
  'Dub only': 'Dub only. Switch this show to Dub if that’s fine.',
  'Too big': 'Bigger than your size limit (Settings → Quality).',
  'Not enough seeders': 'Too few seeders (Settings → Quality → minimum seeders).',
  '4K not allowed': '4K, which is turned off (Settings → Quality).',
  'Wrong season': 'A different season.',
  'Wrong episode': 'A different episode.',
  'Title mismatch': 'A different show or movie with a similar name.',
  'Not a season pack': 'Single episodes, not a full-season pack.',
  'Not a full batch': 'Only part of the season.',
  'Batch, not a single episode': 'Whole-season batches, not the single episode.',
  'Movie, not a series release': 'A movie from the same franchise.',
  'OVA/special, not a series release': 'An OVA/special, not the series.',
  'CAM/TS quality': 'Cam/telesync recordings (low quality).',
  'Looks like a TV release': 'TV episodes, not the movie.',
  'Wrong year': 'A different year’s movie.',
};

const TITLE: Record<SearchEvent['kind'], string> = {
  none: 'Couldn’t find',
  idle: 'Nothing to search for',
  error: 'Search failed for',
};

/** Pops up when a search you started finds nothing, wherever you are in the app. */
export default function SearchAlerts() {
  const navigate = useNavigate();
  const [lastId, setLastId] = useState<number | null>(null);
  const [queue, setQueue] = useState<SearchEvent[]>([]);

  const events = useQuery({
    queryKey: ['search-events', lastId],
    queryFn: () => api.get<{ latestId: number; events: SearchEvent[] }>(`/api/search-events?after=${lastId ?? -1}`),
    refetchInterval: 3000,
  });

  useEffect(() => {
    const data = events.data;
    if (!data) return;
    // First load only learns where we are, so old results don't pop up when the page opens.
    if (lastId !== null && data.events.length) setQueue((q) => [...q, ...data.events]);
    if (data.latestId !== lastId) setLastId(data.latestId);
  }, [events.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[0];
  if (!current) return null;
  const close = () => setQueue((q) => q.slice(1));
  const searchManually = () => {
    close();
    const season = current.type !== 'movie' && current.season !== null ? `&season=${current.season}` : '';
    navigate(`/media/${current.mediaId}?manual=1${season}`);
  };

  return (
    <Modal title={`${TITLE[current.kind]} ${current.title}`} onClose={close}>
      <div className="stack alert-body">
        <p className="alert-message">{current.message}</p>

        {current.kind === 'none' && current.results > 0 && (
          <div className="field">
            <span className="field-label">
              Your indexers returned {current.results} release{current.results === 1 ? '' : 's'}, but none fit:
            </span>
            <ul className="reason-list">
              {current.reasons.map((r) => (
                <li key={r.reason}>
                  <span className="reason-count">{r.count}</span>
                  <span>{EXPLAIN[r.reason] ?? r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {current.kind === 'none' && current.results === 0 && (
          <p className="muted">
            Your indexers returned no results at all. It may not be released yet, or your indexers may not carry it.
          </p>
        )}
        {current.kind === 'none' && <p className="hint">Mediarr keeps checking automatically and will grab it once something fits.</p>}
        {current.kind === 'error' && <p className="hint">Check that Prowlarr is running (Settings → Prowlarr → Test).</p>}

        <div className="row end wrap">
          {queue.length > 1 && <span className="muted small grow">{queue.length - 1} more</span>}
          <button className="btn ghost" onClick={close}>
            OK
          </button>
          {current.kind !== 'idle' && (
            <button className="btn primary" onClick={searchManually}>
              Search manually
            </button>
          )}
          {current.kind === 'idle' && (
            <button
              className="btn primary"
              onClick={() => {
                close();
                navigate(`/media/${current.mediaId}`);
              }}
            >
              Open {current.type === 'movie' ? 'movie' : 'show'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
