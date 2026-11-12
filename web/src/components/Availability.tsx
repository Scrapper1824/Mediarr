import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/** Server: core/availability.ts */
interface AvailabilityData {
  total: number | null;
  single: boolean;
  sub: { out: number; complete: boolean; startsAt: string | null; next: { episode: number; at: string } | null; allOutBy: string | null };
  dub: {
    exists: boolean;
    out: number | null;
    complete: boolean;
    startsAt: string | null;
    allOutBy: string | null;
    paused: { until: string | null } | null;
    estimated: boolean;
    source: { name: string; url: string };
  } | null;
}

/** "13 Nov", or "3 Jan 2027" when it's not this year. */
function when(iso: string) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function subLine(a: AvailabilityData): string {
  const { sub, total } = a;
  if (sub.complete) return total ? `All ${total} episodes out` : 'All episodes out';
  if (sub.out === 0) return sub.startsAt ? `Starts ${when(sub.startsAt)}` : 'Not out yet';
  const parts = [total ? `${sub.out} of ${total} out` : `${sub.out} out so far`];
  if (sub.next) parts.push(`episode ${sub.next.episode} on ${when(sub.next.at)}`);
  if (sub.allOutBy) parts.push(`last one ${when(sub.allOutBy)}`);
  return parts.join(', ');
}

function dubLine(a: AvailabilityData): string {
  const d = a.dub!;
  if (!d.exists) return 'No English dub announced';
  if (a.single) return 'Available';
  if (d.complete) return a.total ? `All ${a.total} episodes out` : 'All episodes out';
  if (d.paused) return d.paused.until ? `On a break until ${when(d.paused.until)}` : 'On a break, no return date yet';
  if (d.startsAt) return `Starts ${when(d.startsAt)}${d.allOutBy ? `, all out around ${when(d.allOutBy)}` : ''}`;
  if (d.out === null) return 'Available, episode count unknown';
  const about = d.estimated ? 'About ' : '';
  if (!a.total) return `${about}${d.out} out so far`;
  return `${about}${d.out} of ${a.total} out${d.allOutBy ? `, all out around ${when(d.allOutBy)}` : ''}`;
}

const useAvailability = (anilistId: number | undefined) =>
  useQuery({
    queryKey: ['availability', anilistId],
    queryFn: () => api.get<AvailabilityData>(`/api/discover/availability?anilistId=${anilistId}`),
    enabled: !!anilistId,
    staleTime: 30 * 60_000,
    retry: false,
  });

/**
 * Anime: what's out with subtitles and with an English dub, and when the rest is expected.
 * `previous`: the season before. When the newest one hasn't started yet, that one is shown instead,
 * with a line saying when the new season starts.
 */
export default function Availability({ anilistId, label, previous }: { anilistId: number; label?: string; previous?: { anilistId: number; label: string } }) {
  const newest = useAvailability(anilistId);
  const notStarted = !!newest.data && newest.data.sub.out === 0 && !newest.data.sub.complete;
  const older = useAvailability(notStarted ? previous?.anilistId : undefined);
  const showOlder = notStarted && !!older.data;
  const a = showOlder ? older.data! : newest.data;
  if (!a) return null;
  const upcoming = showOlder && newest.data!.sub.startsAt ? `${label ?? 'Next season'} starts ${when(newest.data!.sub.startsAt)}` : null;
  const shownLabel = showOlder ? previous!.label : label;
  const dubKnown = a.dub !== null;
  return (
    <section className="availability" aria-label="Sub and dub availability">
      {shownLabel && <div className="availability-label">{shownLabel}</div>}
      <dl>
        {!a.single && (
          <div className="availability-row">
            <dt>Subtitled</dt>
            <dd>{subLine(a)}</dd>
          </div>
        )}
        <div className={`availability-row${dubKnown && a.dub!.exists ? '' : ' none'}`}>
          <dt>English dub</dt>
          <dd>{dubKnown ? dubLine(a) : 'No information yet'}</dd>
        </div>
      </dl>
      {upcoming && <div className="availability-next">{upcoming}</div>}
      {dubKnown && (
        <a className="availability-credit" href={a.dub!.source.url} target="_blank" rel="noreferrer noopener">
          Dub dates{a.dub!.estimated ? ' estimated' : ''} from {a.dub!.source.name}
        </a>
      )}
    </section>
  );
}
