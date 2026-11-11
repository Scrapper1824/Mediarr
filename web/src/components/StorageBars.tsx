import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/** Server: core/storage.ts */
interface DriveUsage {
  label: string;
  totalBytes: number;
  freeBytes: number;
  mediaBytes: number;
  libraries: string[];
}

/** "812 GB", "3.6 TB". */
export function size(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

/** Sidebar, admins only: one bar per library drive (gold = your media, grey = everything else, empty = free). */
export default function StorageBars() {
  const q = useQuery({ queryKey: ['storage'], queryFn: () => api.get<DriveUsage[]>('/api/system/storage'), refetchInterval: 10 * 60_000, staleTime: 5 * 60_000 });
  const drives = q.data ?? [];
  if (!drives.length) return null;
  return (
    <section className="sidebar-storage" aria-label="Storage">
      {drives.map((d) => {
        const used = Math.max(0, d.totalBytes - d.freeBytes);
        const other = Math.max(0, used - d.mediaBytes);
        const low = d.freeBytes / d.totalBytes < 0.1;
        return (
          <div
            key={d.label}
            className={`storage-drive${low ? ' low' : ''}`}
            title={`${d.label} (${d.libraries.join(', ')}): media ${size(d.mediaBytes)}, other files ${size(other)}, ${size(d.freeBytes)} free of ${size(d.totalBytes)}`}
          >
            <div className="storage-head">
              <span className="storage-name">{d.label}</span>
              <span className="storage-free">
                {size(d.freeBytes)} free of {size(d.totalBytes)}
              </span>
            </div>
            <div
              className="storage-bar"
              role="meter"
              aria-label={`${d.label} space used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct(used, d.totalBytes))}
              aria-valuetext={`Media ${size(d.mediaBytes)}, other ${size(other)}, ${size(d.freeBytes)} free`}
            >
              <span className="storage-media" style={{ width: `${pct(d.mediaBytes, d.totalBytes)}%` }} />
              <span className="storage-other" style={{ width: `${pct(other, d.totalBytes)}%` }} />
            </div>
            <div className="storage-legend">
              <span>
                <i className="dot media" aria-hidden />
                Media {size(d.mediaBytes)}
              </span>
              <span>
                <i className="dot other" aria-hidden />
                Other {size(other)}
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
