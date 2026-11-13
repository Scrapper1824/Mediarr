import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, formatSize } from '../api';
import Modal from './Modal';
import Spinner from './Spinner';

/** Removing a title, optionally deleting its files from disk too. */
export default function RemoveDialog({ id, title, onClose, onRemoved }: { id: number; title: string; onClose: () => void; onRemoved: () => void }) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const files = useQuery({ queryKey: ['media', id, 'files'], queryFn: () => api.get<{ count: number; bytes: number; folders: string[] }>(`/api/media/${id}/files`) });
  const remove = useMutation({
    mutationFn: () => api.del<{ errors: string[] }>(`/api/media/${id}?deleteFiles=${deleteFiles}`),
    onSuccess: (r) => {
      if (r.errors?.length) alert(`${title} was removed, but some files couldn't be deleted:\n\n${r.errors.join('\n')}`);
      onRemoved();
    },
  });
  const f = files.data;
  const nothingOnDisk = !!f && f.count === 0;

  return (
    <Modal title={`Remove ${title}?`} onClose={onClose}>
      <div className="stack remove-dialog">
        <p className="muted">It disappears from Mediarr: no more searching or downloading for it, and its watch progress is forgotten.</p>
        <label className={`check remove-files${deleteFiles ? ' on' : ''}`}>
          <input type="checkbox" checked={deleteFiles} disabled={nothingOnDisk} onChange={(e) => setDeleteFiles(e.target.checked)} />
          <span>
            Also delete its files from disk
            <span className="muted small block">
              {files.isLoading && 'Counting files…'}
              {files.error && 'Couldn’t check its files.'}
              {f && (nothingOnDisk ? 'There are no files for it in your library folders.' : `${f.count} file${f.count === 1 ? '' : 's'}, ${formatSize(f.bytes)}`)}
            </span>
            {f && !nothingOnDisk && (
              <span className="muted small block remove-folders">
                {f.folders.map((d) => (
                  <span key={d} className="block">{d}</span>
                ))}
              </span>
            )}
          </span>
        </label>
        {deleteFiles && <div className="error-box">The files are deleted permanently (not to the Recycle Bin). Anything still downloading for it is cancelled.</div>}
        {remove.error && <div className="error-box">{(remove.error as Error).message}</div>}
        <div className="row end">
          <button className="btn ghost" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </button>
          <button className="btn danger-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending && <Spinner />}
            {deleteFiles ? 'Remove and delete files' : 'Remove'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
