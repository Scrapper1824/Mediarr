import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, formatSize, type Download } from '../api';
import Modal from './Modal';
import Spinner from './Spinner';

/** Stopping a download in qBittorrent, optionally deleting what it has downloaded so far (same look as removing a title). */
export default function CancelDownloadDialog({ d, onClose, onDone }: { d: Download; onClose: () => void; onDone: () => void }) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.del(`/api/queue/${d.id}?deleteFiles=${deleteFiles}`),
    onSuccess: onDone,
  });
  // Importing: the files are being moved into the library, so they're never offered for deletion here.
  const canDelete = d.state === 'queued' || d.state === 'downloading';
  const got = d.size ? d.size * d.progress : null;

  return (
    <Modal title="Cancel this download?" onClose={onClose}>
      <div className="stack remove-dialog">
        <div>
          <div className="release-title">{d.release_title}</div>
          {d.media_title && <div className="muted small">for {d.media_title}</div>}
        </div>
        <p className="muted">
          It’s removed from qBittorrent. If its episodes are still wanted, Mediarr looks for another release later (you can also search
          for one yourself on the title’s page).
        </p>
        {canDelete && (
          <label className={`check remove-files${deleteFiles ? ' on' : ''}`}>
            <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
            <span>
              Also delete what it has downloaded so far
              <span className="muted small block">
                {Math.round(d.progress * 100)}% done{got !== null && d.size ? ` · ${formatSize(got)} of ${formatSize(d.size)}` : ''}
              </span>
              <span className="muted small block remove-folders">{d.save_path}</span>
            </span>
          </label>
        )}
        {deleteFiles && <div className="error-box">The downloaded data is deleted permanently (not to the Recycle Bin).</div>}
        {cancel.error && <div className="error-box">{(cancel.error as Error).message}</div>}
        <div className="row end">
          <button className="btn ghost" onClick={onClose} disabled={cancel.isPending}>
            Keep downloading
          </button>
          <button className="btn danger-solid" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending && <Spinner />}
            {deleteFiles ? 'Cancel and delete data' : 'Cancel download'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
