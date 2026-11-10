export interface FolderSpace {
  path: string;
  exists: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
}

const gb = (bytes: number) => {
  const g = bytes / 1024 ** 3;
  return g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${Math.round(g)} GB`;
};

/** One media type's library folders: new titles go to the first one with room. */
export default function FolderList({
  label,
  placeholder,
  folders,
  space,
  minFreeGb,
  onChange,
}: {
  label: string;
  placeholder: string;
  folders: string[];
  /** Free space of the saved folders (unsaved edits have none yet). */
  space: FolderSpace[] | undefined;
  minFreeGb: number;
  onChange: (folders: string[]) => void;
}) {
  const rows = folders.length ? folders : [''];
  const set = (i: number, value: string) => onChange(rows.map((f, j) => (j === i ? value : f)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {rows.map((folder, i) => {
        const info = space?.find((s) => s.path === folder.trim());
        const low = info?.freeBytes != null && info.freeBytes < minFreeGb * 1024 ** 3;
        return (
          <div key={i} className="folder-row">
            <div className="row">
              <input
                className="input folder-input"
                value={folder}
                placeholder={i === 0 ? placeholder : 'Another folder, e.g. on a second drive'}
                onChange={(e) => set(i, e.target.value)}
              />
              {rows.length > 1 && (
                <button type="button" className="icon-btn" title="Remove this folder" aria-label="Remove this folder" onClick={() => remove(i)}>
                  ✕
                </button>
              )}
            </div>
            {info && !info.exists && <span className="hint error-text">Folder not found</span>}
            {info?.freeBytes != null && info.totalBytes != null && (
              <span className={`hint${low ? ' warn-text' : ''}`}>
                {gb(info.freeBytes)} free of {gb(info.totalBytes)}
                {low && (rows.length > 1 ? ' · nearly full, new titles go to the next folder' : ' · nearly full')}
              </span>
            )}
          </div>
        );
      })}
      <button type="button" className="btn small ghost add-folder" onClick={() => onChange([...rows, ''])}>
        + Add folder
      </button>
    </div>
  );
}
