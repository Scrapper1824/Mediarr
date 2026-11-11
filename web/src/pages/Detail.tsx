import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate, type Episode, type MediaDetail } from '../api';
import Poster from '../components/Poster';
import ReleasesDialog, { type ReleaseScope } from '../components/ReleasesDialog';
import Spinner from '../components/Spinner';
import { useIsAdmin } from '../components/AuthGate';
import SuggestionsPanel from '../components/SuggestionsPanel';
import Icon from '../components/Icon';
import { useAmbient } from '../ambient';
import { sharp } from '../home';
import Availability from '../components/Availability';
import TrailerPlayer from '../components/TrailerPlayer';
import { InfoItem, languageName, Ratings, WatchlistButton, type MediaInfo } from '../components/TitleInfo';

/** Live status of the background search: a spinner while it runs, then what it found. */
function SearchBanner({ m }: { m: MediaDetail }) {
  const [hiddenAt, setHiddenAt] = useState<string | null>(null);
  const { running, message, finishedAt } = m.search;
  if (running) {
    return (
      <div className="search-banner running">
        <Spinner size={16} />
        <div>
          <strong>Searching for releases…</strong>
          <div className="muted small">{m.search.step ?? 'Asking your indexers through Prowlarr.'} This can take a few minutes.</div>
        </div>
      </div>
    );
  }
  const recent = finishedAt && Date.now() - new Date(finishedAt).getTime() < 30 * 60_000;
  if (!message || !recent || hiddenAt === finishedAt) return null;
  return (
    <div className="search-banner">
      <span>{message}</span>
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setHiddenAt(finishedAt)}>
        ✕
      </button>
    </div>
  );
}

function EpisodeStatus({ e }: { e: Episode }) {
  if (e.has_file) return <span className="badge ok">Downloaded</span>;
  if (e.downloading) return <span className="badge info">Downloading</span>;
  if (!e.aired) return <span className="badge muted">Unaired</span>;
  return <span className={`badge ${e.monitored ? 'warn' : 'muted'}`}>Missing</span>;
}

/** The description, four lines at most until you ask for the rest. */
function Overview({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 320;
  return (
    <div className={`title-overview${all || !long ? '' : ' clamped'}`}>
      <p>{text}</p>
      {long && (
        <button type="button" className="more-btn" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

/** "NOT_YET_RELEASED" → "Not yet released"; TMDB's own wording ("Returning Series") stays. */
const humanStatus = (s: string) => (/^[A-Z_]+$/.test(s) ? (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, ' ') : s);

/** "S01E05" → "E5", or "S2 E5" when the series has more than one season. */
const episodeButtonLabel = (label: string, manySeasons: boolean) => {
  const m = /^S0?(\d+)E0?(\d+)$/.exec(label);
  if (!m) return label;
  return manySeasons || m[1] !== '1' ? `S${m[1]} E${m[2]}` : `E${m[2]}`;
};

export default function Detail() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [releases, setReleases] = useState<ReleaseScope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [params, setParams] = useSearchParams();
  const isAdmin = useIsAdmin();

  const q = useQuery({
    queryKey: ['media', 'detail', id],
    queryFn: () => api.get<MediaDetail>(`/api/media/${id}`),
    // Poll faster while a search is running so the result shows up promptly.
    refetchInterval: (query) => (query.state.data?.search.running ? 1500 : 5000),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['media'] });
  // Your own watched state per episode (key 0 = the movie).
  const watched = useQuery({
    queryKey: ['play', 'progress', id],
    queryFn: () => api.get<Record<string, { position: number; duration: number; watched: boolean }>>(`/api/play/progress/${id}`),
  });

  // "Search manually" from the nothing-found popup lands here and opens interactive search.
  useEffect(() => {
    const m = q.data;
    if (!m || params.get('manual') !== '1') return;
    const season = params.get('season');
    setParams({}, { replace: true });
    setReleases(
      m.type === 'movie' || season === null
        ? { mediaId: m.id, label: m.title }
        : { mediaId: m.id, season: Number(season), label: `${m.title} season ${season}` },
    );
  }, [q.data, params, setParams]);

  const patch = useMutation({ mutationFn: (body: object) => api.patch(`/api/media/${id}`, body), onSuccess: refresh });
  const patchEpisode = useMutation({
    mutationFn: ({ epId, monitored }: { epId: number; monitored: boolean }) => api.patch(`/api/episodes/${epId}`, { monitored }),
    onSuccess: refresh,
  });
  const patchSeason = useMutation({
    mutationFn: ({ season, monitored }: { season: number; monitored: boolean }) =>
      api.patch(`/api/media/${id}/seasons/${season}`, { monitored }),
    onSuccess: refresh,
  });
  const search = useMutation({
    mutationFn: (body: { episodeIds?: number[]; season?: number }) => api.post<{ grabs: number }>(`/api/media/${id}/search`, body),
    // The search banner reports progress and results from the server.
    onMutate: () => {
      setNotice(null);
      // Show the spinner immediately instead of waiting for the next poll.
      qc.setQueryData<MediaDetail>(['media', 'detail', id], (old) =>
        old ? { ...old, search: { ...old.search, running: true } } : old,
      );
    },
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e) => setNotice((e as Error).message),
  });
  const metaRefresh = useMutation({
    mutationFn: () => api.post(`/api/media/${id}/refresh`),
    onSuccess: () => {
      setNotice('Metadata refreshed.');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/media/${id}`),
    onSuccess: () => {
      refresh();
      navigate(-1);
    },
  });

  useAmbient(q.data?.poster);
  const sourceId = q.data ? (q.data.type === 'anime' ? q.data.anilist_id : q.data.tmdb_id) : null;
  const info = useQuery({
    queryKey: ['discover', 'info', q.data?.type, sourceId],
    queryFn: () => api.get<MediaInfo>(`/api/discover/info?type=${q.data!.type}&id=${sourceId}`),
    enabled: !!sourceId,
    staleTime: 30 * 60_000,
  });
  const [trailer, setTrailer] = useState(false);

  if (q.isLoading) return <div className="page loading">Loading…</div>;
  if (q.error || !q.data) return <div className="page error-box">{(q.error as Error)?.message ?? 'Not found'}</div>;
  const m = q.data;
  const searching = search.isPending || m.search.running;

  // Sub/dub news matters most for the newest season.
  const latestSeason = m.anime_seasons?.length ? m.anime_seasons[m.anime_seasons.length - 1] : null;
  const priorSeason = m.anime_seasons?.length > 1 ? m.anime_seasons[m.anime_seasons.length - 2] : null;
  const seasonLabel = (s: { season: number; year: number | null }) => `Season ${s.season}${s.year ? ` (${s.year})` : ''}`;
  const seasonInfo = (n: number) => m.anime_seasons?.find((x) => x.season === n);
  const seasons = [...new Set(m.episodes.map((e) => e.season))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const isOpen = (s: number) => open.has(s) || (seasons.length === 1 && !open.has(-s - 1));
  const toggleOpen = (s: number) => {
    const next = new Set(open);
    if (seasons.length === 1) {
      // Single-season series start expanded; track explicit collapse with a sentinel.
      const key = -s - 1;
      if (next.has(key)) next.delete(key);
      else next.add(key);
    } else if (next.has(s)) next.delete(s);
    else next.add(s);
    setOpen(next);
  };

  return (
    <div className="page page-wide title-page">
      <section className={`title-hero${m.backdrop ? '' : ' no-backdrop'}`}>
        <div className="title-hero-art" aria-hidden>
          {m.backdrop ? <img src={sharp(m.backdrop)} alt="" /> : m.poster ? <img className="soft" src={m.poster} alt="" /> : null}
        </div>
        <div className="title-hero-inner">
          <Poster src={m.poster} title={m.title} />
          <div className="title-hero-info">
            <h1 className="title-name">{m.title}</h1>
            <div className="title-meta">
              {info.data?.certification && <span className="details-cert">{info.data.certification}</span>}
              {[
                m.year ? String(m.year) : null,
                m.type === 'movie' ? 'Movie' : m.type === 'show' ? 'TV show' : 'Anime',
                m.type !== 'movie' && m.episodeCount > 0
                  ? m.episodeFileCount >= m.episodeCount
                    ? `All ${m.episodeCount} episodes`
                    : `${m.episodeFileCount} of ${m.episodeCount} episodes`
                  : null,
                m.type === 'movie' && m.release_date ? `Released ${formatDate(m.release_date)}` : null,
                info.data?.runtime ?? null,
                m.status ? humanStatus(m.status) : null,
              ]
                .filter(Boolean)
                .map((t, i) => (
                  <span key={i}>{t}</span>
                ))}
              {m.downloading && <span className="badge info">Downloading</span>}
              {info.data?.links.map((l) => (
                <a key={l.label} className="details-link" href={l.url} target="_blank" rel="noreferrer noopener">
                  {l.label} ↗
                </a>
              ))}
            </div>
            {info.data && <Ratings ratings={info.data.ratings} />}
            <div className="title-actions">
              {m.play ? (
                <Link className="hero-play" to={`/watch/${m.play.kind}/${m.play.id}`} title={m.play.episodeTitle ?? undefined}>
                  <Icon name="play" size={18} filled /> {m.play.resume ? 'Resume' : 'Play'}
                  {m.play.kind === 'episode' && m.play.label ? ` ${episodeButtonLabel(m.play.label, m.episodes.some((e) => e.season > 1))}` : ''}
                  {m.play.resume && m.play.minutesLeft ? <span className="hero-play-left">· {m.play.minutesLeft} min left</span> : null}
                </Link>
              ) : (
                <button className="hero-play" disabled={searching} onClick={() => search.mutate({})}>
                  {searching ? <Spinner /> : <Icon name="search" size={18} />} {searching ? 'Searching…' : m.type === 'movie' ? 'Find a download' : 'Find episodes'}
                </button>
              )}
              {info.data?.trailer && (
                <button className="hero-secondary" onClick={() => setTrailer(true)}>
                  <Icon name="play" size={16} filled /> Trailer
                </button>
              )}
              {sourceId && <WatchlistButton type={m.type} id={sourceId} info={{ title: m.title, year: m.year, poster: m.poster }} />}
            </div>
            {m.overview && <Overview text={m.overview} />}
            {info.data && (
              <div className="details-info title-info">
                <InfoItem label="Length" value={[...info.data.length, m.type === 'movie' ? null : info.data.runtime].filter(Boolean).join(' · ') || info.data.runtime} />
                <InfoItem label="Released" value={info.data.released ? formatDate(info.data.released) : null} />
                <InfoItem label="Original language" value={languageName(info.data.originalLanguage)} />
                <InfoItem label={info.data.studioLabel} value={info.data.studios.join(', ')} />
                <InfoItem label="Genres" value={info.data.genres.join(', ')} />
              </div>
            )}
            {m.type === 'anime' && latestSeason?.anilistId ? (
              <Availability
                anilistId={latestSeason.anilistId}
                label={m.anime_seasons.length > 1 ? seasonLabel(latestSeason) : undefined}
                previous={priorSeason?.anilistId ? { anilistId: priorSeason.anilistId, label: seasonLabel(priorSeason) } : undefined}
              />
            ) : null}
          </div>
        </div>
      </section>

      <div className="title-body">
        <section className="manage-bar" aria-label="Downloading">
          <label
            className="switch"
            title={m.type === 'movie' ? 'Keep searching until the movie is downloaded' : 'Automatically download new episodes and new seasons as they air'}
          >
            <input type="checkbox" checked={m.monitored} onChange={(e) => patch.mutate({ monitored: e.target.checked })} />
            <span className="slider" />
            <span>{m.type === 'movie' ? 'Keep looking for it' : 'Get new episodes'}</span>
          </label>
          {m.type === 'anime' && (
            <div className="segmented small" role="group" aria-label="Audio">
              {(['sub', 'dub'] as const).map((a) => (
                <button key={a} className={m.anime_audio === a ? 'on' : ''} onClick={() => patch.mutate({ animeAudio: a })}>
                  {a === 'sub' ? 'Sub' : 'Dub'}
                </button>
              ))}
            </div>
          )}
          <span className="manage-spacer" />
          {m.play && (
            <button className="btn small" disabled={searching} onClick={() => search.mutate({})}>
              {searching ? <Spinner /> : <Icon name="search" size={15} />} {searching ? 'Searching…' : m.type === 'movie' ? 'Search again' : 'Search missing'}
            </button>
          )}
          {m.type === 'movie' && (
            <button className="btn small" onClick={() => setReleases({ mediaId: m.id, label: m.title })}>
              Choose a release
            </button>
          )}
          <button className="btn small ghost" disabled={metaRefresh.isPending} onClick={() => metaRefresh.mutate()}>
            <Icon name="refresh" size={15} /> Refresh info
          </button>
          {isAdmin && (
            <button className="btn small ghost danger" onClick={() => confirm(`Remove ${m.title} from Mediarr? Files on disk are kept.`) && remove.mutate()}>
              <Icon name="trash" size={15} /> Remove
            </button>
          )}
        </section>
        {isAdmin && (
          <div className="title-path muted small" title="Library folder">
            <Icon name="folder" size={14} /> {m.type === 'movie' && m.file_path ? m.file_path : `${m.root_folder}\\${m.folder_name}`}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}

      <SearchBanner m={m} />
      <SuggestionsPanel suggestions={m.suggestions ?? []} />

      {m.type !== 'movie' &&
        seasons.map((s) => {
          const eps = m.episodes.filter((e) => e.season === s);
          const have = eps.filter((e) => e.has_file).length;
          const aired = eps.filter((e) => e.aired).length;
          const allMonitored = eps.every((e) => e.monitored);
          return (
            <section key={s} className="season">
              <header className="season-header">
                <button className="season-toggle" onClick={() => toggleOpen(s)}>
                  <span className="caret">{isOpen(s) ? '▾' : '▸'}</span>
                  <span className="season-name">
                    <span className="row">
                      <h3>{s === 0 ? 'Specials' : `Season ${s}`}</h3>
                      <span className={`badge ${have >= aired && aired > 0 ? 'ok' : 'muted'}`}>
                        {have}/{aired}
                      </span>
                    </span>
                    {m.type === 'anime' && seasonInfo(s) && (
                      <span className="muted small">
                        {seasonInfo(s)!.title}
                        {seasonInfo(s)!.year ? ` · ${seasonInfo(s)!.year}` : ''}
                      </span>
                    )}
                  </span>
                </button>
                <div className="row">
                  <label className="switch small" title="Download this season">
                    <input
                      type="checkbox"
                      checked={allMonitored}
                      onChange={(e) => patchSeason.mutate({ season: s, monitored: e.target.checked })}
                    />
                    <span className="slider" />
                  </label>
                  <button className="btn small" disabled={searching} onClick={() => search.mutate({ season: s })}>
                    Search
                  </button>
                  <button
                    className="btn small ghost"
                    onClick={() =>
                      setReleases({ mediaId: m.id, season: s, label: `${m.title} season ${s}` })
                    }
                  >
                    {m.type === 'anime' ? 'Find batch' : 'Find pack'}
                  </button>
                </div>
              </header>
              {isOpen(s) && (
                <table className="table episodes">
                  <tbody>
                    {eps.map((e) => (
                      <tr key={e.id} className={e.aired ? '' : 'dim'}>
                        <td className="ep-mon">
                          <input
                            type="checkbox"
                            checked={e.monitored}
                            title="Wanted (download this episode)"
                            onChange={(ev) => patchEpisode.mutate({ epId: e.id, monitored: ev.target.checked })}
                          />
                        </td>
                        <td className="ep-play">
                          {e.has_file ? (
                            <Link className="icon-btn play-icon" to={`/watch/episode/${e.id}`} title="Play" aria-label={`Play episode ${e.episode}`}>
                              ▶
                            </Link>
                          ) : null}
                        </td>
                        <td className="ep-num">
                          {e.episode}
                          {watched.data?.[String(e.id)]?.watched && <span className="watched-tick" title="Watched"> ✓</span>}
                        </td>
                        <td className="ep-title" title={e.file_path ?? undefined}>
                          {e.title || `Episode ${e.episode}`}
                        </td>
                        <td className="muted small nowrap">{formatDate(e.air_date)}</td>
                        <td>
                          <EpisodeStatus e={e} />
                        </td>
                        <td className="nowrap actions">
                          <button
                            className="icon-btn"
                            title="Automatic search"
                            disabled={!e.aired || search.isPending}
                            onClick={() => search.mutate({ episodeIds: [e.id] })}
                          >
                            ⌕
                          </button>
                          <button
                            className="icon-btn"
                            title="Interactive search"
                            onClick={() =>
                              setReleases({
                                mediaId: m.id,
                                episodeId: e.id,
                                label: `${m.title} S${s}E${e.episode}`,
                              })
                            }
                          >
                            ☰
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}

      {m.downloads.length > 0 && (
        <section className="season">
          <header className="season-header">
            <h3>Recent downloads</h3>
          </header>
          <table className="table">
            <tbody>
              {m.downloads.map((d) => (
                <tr key={d.id}>
                  <td className="release-title">{d.release_title}</td>
                  <td>
                    <span className={`badge state-${d.state}`}>{d.state}</span>
                  </td>
                  <td className="muted small">{d.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {releases && <ReleasesDialog scope={releases} onClose={() => setReleases(null)} />}
      {trailer && info.data?.trailer && (
        <TrailerPlayer youtubeId={info.data.trailer.youtubeId} title={`${m.title} – ${info.data.trailer.title}`} onClose={() => setTrailer(false)} />
      )}
      </div>
    </div>
  );
}
