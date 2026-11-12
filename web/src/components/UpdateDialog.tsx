import { useEffect, useRef, useState } from 'react';
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

/**
 * Waits for the restarted Mediarr, then reloads the page. "Back" means it answers again after being
 * unreachable, or it already answers with the new version (a quick restart can fall between two checks).
 */
async function waitForRestart(fromVersion: string | null, onTick: (s: string) => void) {
  const deadline = Date.now() + 5 * 60_000;
  let wentDown = false;
  while (Date.now() < deadline) {
    const r = await fetch('/api/system/update', { cache: 'no-store', headers: { 'x-requested-with': 'mediarr' } }).catch(() => null);
    const info = r?.ok ? ((await r.json().catch(() => null)) as UpdateInfo | null) : null;
    const version = info?.current;
    // Still mid-update (a network blip, not the restart): keep waiting.
    if (info && ['downloading', 'installing', 'building'].includes(info.job.state)) {
      await new Promise((res) => setTimeout(res, 1500));
      continue;
    }
    if (!version) {
      wentDown = true;
      onTick('Waiting for Mediarr to start again…');
    } else if (wentDown || (fromVersion && version !== fromVersion)) {
      onTick('Mediarr is back. Reloading…');
      window.location.reload();
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  onTick('Mediarr is taking a while to come back. Refresh the page in a minute.');
}

/** "Update available": release notes, then download, install, rebuild and restart. */
export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  /** The version running when the update started, and whether its steps were seen. */
  const fromVersion = useRef<string | null>(null);
  const sawSteps = useRef(false);
  const info = useQuery({
    queryKey: ['update'],
    queryFn: () => api.get<UpdateInfo>('/api/system/update'),
    refetchInterval: started ? 1000 : false,
  });
  const install = useMutation({
    mutationFn: () => api.post<UpdateInfo>('/api/system/update/install'),
    onSuccess: (d) => {
      fromVersion.current = d.current;
      qc.setQueryData(['update'], d);
      setStarted(true);
    },
  });

  const d = info.data;
  const job = d?.job;
  const busy = (started && job && !['failed', 'idle', 'done'].includes(job.state)) || !!waiting;

  if (job && STEPS.some(([st]) => st === job.state)) sawSteps.current = true;
  // The restart shows up as any of: the "restarting" step; Mediarr not answering; a new version; or the
  // steps gone again (the restarted process knows nothing of the update it came from).
  const restarted =
    started &&
    !waiting &&
    job?.state !== 'failed' &&
    (job?.state === 'restarting' ||
      info.isError ||
      (!!d && !!fromVersion.current && d.current !== fromVersion.current) ||
      (sawSteps.current && (job?.state === 'idle' || job?.state === 'done')));
  useEffect(() => {
    if (!restarted) return;
    setWaiting('Restarting…');
    void waitForRestart(fromVersion.current, setWaiting);
  }, [restarted]);

  if (!d) return null;
  const latest = d.latest;
  const failed = started && job?.state === 'failed';
  // Waiting for the restart: everything before it is done.
  const stepIndex = waiting ? STEPS.length - 1 : STEPS.findIndex(([s]) => s === job?.state);

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
            <button type="button" className="btn ghost" onClick={onClose}>
              Not now
            </button>
            <button type="button" className="btn primary" disabled={install.isPending} onClick={() => install.mutate()}>
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
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
