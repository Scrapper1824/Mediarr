import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import Modal from './Modal';

export interface UpdateInfo {
  current: string;
  repo: string | null;
  latest: { version: string; name: string; notes: string; url: string; publishedAt: string } | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  job: { state: 'idle' | 'downloading' | 'installing' | 'building' | 'restarting' | 'failed' | 'done'; error: string | null; log: string[]; target: string | null };
}

export const useUpdateInfo = (enabled = true) =>
  useQuery({
    queryKey: ['update'],
    queryFn: () => api.get<UpdateInfo>('/api/system/update'),
    enabled,
    refetchInterval: 30 * 60_000,
    staleTime: 60_000,
  });

const STEPS = [
  ['downloading', 'Downloading the update'],
  ['installing', 'Installing packages'],
  ['building', 'Building'],
  ['restarting', 'Restarting Mediarr'],
] as const;

/** Waits for Mediarr to go away and come back after the restart, then reloads the page. */
async function waitForRestart(onTick: (s: string) => void) {
  const deadline = Date.now() + 5 * 60_000;
  let wentDown = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const up = await fetch('/api/auth/status', { cache: 'no-store' })
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) {
      wentDown = true;
      onTick('Waiting for Mediarr to start again…');
    } else if (wentDown) {
      window.location.reload();
      return;
    }
  }
  onTick('Mediarr is taking a while to come back. Refresh the page in a minute.');
}

/** "Update available": release notes, then download, install, rebuild and restart. */
export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ['update'],
    queryFn: () => api.get<UpdateInfo>('/api/system/update'),
    refetchInterval: started ? 1000 : false,
  });
  const install = useMutation({
    mutationFn: () => api.post<UpdateInfo>('/api/system/update/install'),
    onSuccess: (d) => {
      qc.setQueryData(['update'], d);
      setStarted(true);
    },
  });

  const d = info.data;
  const job = d?.job;
  const busy = started && job && !['failed', 'idle', 'done'].includes(job.state);

  useEffect(() => {
    if (job?.state === 'restarting' && !waiting) {
      setWaiting('Restarting…');
      void waitForRestart(setWaiting);
    }
  }, [job?.state, waiting]);

  if (!d) return null;
  const latest = d.latest;
  const failed = started && job?.state === 'failed';
  const stepIndex = STEPS.findIndex(([s]) => s === job?.state);

  return (
    <Modal title={busy ? 'Updating Mediarr' : 'Update available'} onClose={busy ? () => {} : onClose}>
      {latest && !started && (
        <>
          <p>
            Mediarr <strong>v{latest.version}</strong> is available. You have v{d.current}.
          </p>
          {latest.notes.trim() && (
            <div className="update-notes" aria-label="What's new">
              {latest.notes}
            </div>
          )}
          <p className="muted small">
            Updating downloads the new version, rebuilds Mediarr and restarts it (anyone watching is interrupted for about a minute).{' '}
            <a href={latest.url} target="_blank" rel="noreferrer noopener">
              View on GitHub
            </a>
          </p>
          <div className="row update-actions">
            <button className="btn ghost" onClick={onClose}>
              Not now
            </button>
            <button className="btn primary" disabled={install.isPending} onClick={() => install.mutate()}>
              {install.isPending ? 'Starting…' : 'Update & restart'}
            </button>
          </div>
          {install.error && <div className="error-box">{(install.error as Error).message}</div>}
        </>
      )}

      {started && !failed && (
        <ol className="update-steps">
          {STEPS.map(([s, label], i) => (
            <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}>
              <span className="update-dot" aria-hidden>
                {i < stepIndex ? '✓' : i === stepIndex ? '•' : ''}
              </span>
              {label}
            </li>
          ))}
          {waiting && <li className="muted small update-wait">{waiting}</li>}
        </ol>
      )}

      {failed && (
        <>
          <div className="error-box">{job?.error}</div>
          <p className="muted small">Mediarr is still running the previous version; nothing was changed.</p>
          {job && job.log.length > 0 && <pre className="update-log">{job.log.slice(-12).join('\n')}</pre>}
          <div className="row update-actions">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
