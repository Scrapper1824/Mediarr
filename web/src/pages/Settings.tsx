import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Settings } from '../api';
import SecurityPanel from '../components/SecurityPanel';
import WatchlistLinksPanel from '../components/WatchlistLinksPanel';
import UsersPanel from '../components/UsersPanel';
import SystemPanel from '../components/SystemPanel';
import FolderList, { type FolderSpace } from '../components/FolderList';
import LibraryScanPanel from '../components/LibraryScanPanel';
import { useIsAdmin } from '../components/AuthGate';
import UpdateDialog, { useUpdateInfo, type UpdateInfo } from '../components/UpdateDialog';

type Key = keyof Settings;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function TestButton({ service, form }: { service: string; form: Settings }) {
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>(`/api/settings/test/${service}`, form),
  });
  return (
    <div className="row">
      <button type="button" className="btn small" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? 'Testing…' : 'Test'}
      </button>
      {test.data && <span className={test.data.ok ? 'ok-text' : 'error-text'}>{test.data.ok ? `✓ ${test.data.message}` : test.data.message}</span>}
      {test.error && <span className="error-text">{(test.error as Error).message}</span>}
    </div>
  );
}

/** Admins see everything; regular users only manage their own sign-in. */
export default function SettingsPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Account</h1>
        </header>
        <WatchlistLinksPanel />
        <SecurityPanel />
      </div>
    );
  }
  return <AdminSettings />;
}

type SectionId = 'overview' | 'library' | 'connections' | 'downloading' | 'playback' | 'watchlists' | 'users' | 'system' | 'account';

const SECTIONS: { id: SectionId; label: string; icon: string; blurb: string }[] = [
  { id: 'overview', label: 'Overview', icon: '◎', blurb: 'What’s set up, and what still needs attention.' },
  { id: 'library', label: 'Library', icon: '▣', blurb: 'Where movies, shows and anime are kept.' },
  { id: 'connections', label: 'Connections', icon: '⇄', blurb: 'The services Mediarr talks to: metadata, indexers and your download client.' },
  { id: 'downloading', label: 'Downloading', icon: '↓', blurb: 'Which releases to pick, and how often to look for new episodes.' },
  { id: 'playback', label: 'Playback', icon: '▶', blurb: 'Watching in Mediarr: converting videos and streaming away from home.' },
  { id: 'watchlists', label: 'Watchlists', icon: '☆', blurb: 'Simkl and AniList lists.' },
  { id: 'users', label: 'Users', icon: '☺', blurb: 'Who can sign in, and what they can do.' },
  { id: 'system', label: 'System', icon: '⚙', blurb: 'How Mediarr runs on this PC.' },
  { id: 'account', label: 'My account', icon: '⚿', blurb: 'Your password, two-factor sign-in and sessions.' },
];

/** Sections whose fields are part of the settings form (they get the Save bar). */
const FORM_SECTIONS = new Set<SectionId>(['library', 'connections', 'downloading', 'playback', 'watchlists', 'system']);

type Check = { ok: boolean; message: string };

/** Live status of a connection on the Overview page (runs the same test as its Test button). */
function useCheck(service: string, form: Settings, enabled: boolean) {
  return useQuery({
    queryKey: ['settings-check', service],
    queryFn: () => api.post<Check>(`/api/settings/test/${service}`, form),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function StatusLine({
  label,
  detail,
  state,
  onFix,
}: {
  label: string;
  detail: string;
  state: 'ok' | 'warn' | 'off' | 'loading';
  onFix?: () => void;
}) {
  const icon = state === 'ok' ? '✓' : state === 'loading' ? '…' : state === 'warn' ? '!' : '○';
  return (
    <div className={`status-line ${state}`}>
      <span className="status-icon" aria-hidden>
        {icon}
      </span>
      <div className="status-text">
        <strong>{label}</strong>
        <span className="muted small">{detail}</span>
      </div>
      {onFix && state !== 'ok' && state !== 'loading' && (
        <button type="button" className="btn small" onClick={onFix}>
          Set up ›
        </button>
      )}
    </div>
  );
}

function AdminSettings() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const section = (SECTIONS.some((s) => s.id === params.get('section')) ? params.get('section') : 'overview') as SectionId;
  const go = (id: SectionId) => {
    setParams(id === 'overview' ? {} : { section: id });
    window.scrollTo({ top: 0 });
  };

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const space = useQuery({
    queryKey: ['folder-space'],
    queryFn: () => api.get<Record<'moviesRoots' | 'showsRoots' | 'animeRoots', FolderSpace[]>>('/api/system/folders'),
  });
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(settings.data);

  // Don't lose edits by closing the tab.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (s: Settings) => api.put<Settings>('/api/settings', s),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['folder-space'] });
      qc.invalidateQueries({ queryKey: ['settings-check'] });
      // New TMDB/OMDb keys should show on Discover straight away.
      qc.invalidateQueries({ queryKey: ['discover'] });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
  const monitor = useMutation({ mutationFn: () => api.post<{ searched: number; grabs: number }>('/api/system/monitor') });

  const saved = settings.data;
  const checks = {
    tmdb: useCheck('tmdb', saved!, !!saved?.tmdbApiKey),
    prowlarr: useCheck('prowlarr', saved!, !!saved?.prowlarrApiKey),
    qbittorrent: useCheck('qbittorrent', saved!, !!saved?.qbitUrl),
    ffmpeg: useCheck('ffmpeg', saved!, !!saved),
  };

  if (!form || !saved) return <div className="page loading">Loading…</div>;

  const text = (k: Key, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input className="input" value={String(form[k] ?? '')} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...props} />
  );
  const num = (k: Key, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input className="input" type="number" value={Number(form[k])} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} {...props} />
  );

  const checkState = (c: { data?: Check; isFetching: boolean }, configured: boolean): 'ok' | 'warn' | 'off' | 'loading' =>
    !configured ? 'off' : c.isFetching && !c.data ? 'loading' : c.data?.ok ? 'ok' : 'warn';
  const checkDetail = (c: { data?: Check; error: unknown }, fallback: string) =>
    c.data ? c.data.message : c.error ? (c.error as Error).message : fallback;

  const folderTypes = (['moviesRoots', 'showsRoots', 'animeRoots'] as const).filter((k) => saved[k].length);
  const meta = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`settings-nav-item${s.id === section ? ' on' : ''}`} aria-current={s.id === section ? 'page' : undefined} onClick={() => go(s.id)}>
              <span className="settings-nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
        {/* Only settings fields are in this form; panels with their own forms (users, password…) come after it. */}
        <form
          className="settings-content"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          <div className="settings-head">
            <h2>{meta.label}</h2>
            <p className="muted">{meta.blurb}</p>
          </div>

          {section === 'overview' && (
            <section className="panel">
              <h3>Setup checklist</h3>
              <StatusLine
                label="Library folders"
                state={folderTypes.length === 3 ? 'ok' : folderTypes.length ? 'warn' : 'off'}
                detail={
                  folderTypes.length === 3
                    ? 'Movies, shows and anime each have a folder.'
                    : `Missing a folder for: ${(['moviesRoots', 'showsRoots', 'animeRoots'] as const)
                        .filter((k) => !saved[k].length)
                        .map((k) => ({ moviesRoots: 'movies', showsRoots: 'shows', animeRoots: 'anime' })[k])
                        .join(', ')}.`
                }
                onFix={() => go('library')}
              />
              <StatusLine label="TMDB (movie & show info)" state={checkState(checks.tmdb, !!saved.tmdbApiKey)} detail={checkDetail(checks.tmdb, 'Needs a free API key.')} onFix={() => go('connections')} />
              <StatusLine label="Prowlarr (search)" state={checkState(checks.prowlarr, !!saved.prowlarrApiKey)} detail={checkDetail(checks.prowlarr, 'Needs its URL and API key.')} onFix={() => go('connections')} />
              <StatusLine label="qBittorrent (downloads)" state={checkState(checks.qbittorrent, !!saved.qbitUrl)} detail={checkDetail(checks.qbittorrent, 'Needs its Web UI address.')} onFix={() => go('connections')} />
              <StatusLine label="FFmpeg (watching)" state={checkState(checks.ffmpeg, true)} detail={checkDetail(checks.ffmpeg, 'Checking…')} onFix={() => go('playback')} />
              <StatusLine
                label="Watchlists (optional)"
                state={saved.simklClientId || saved.anilistClientId ? 'ok' : 'off'}
                detail={
                  saved.simklClientId || saved.anilistClientId
                    ? [saved.simklClientId && 'Simkl', saved.anilistClientId && 'AniList'].filter(Boolean).join(' and ') + ' can be connected.'
                    : 'Let people connect their Simkl or AniList lists.'
                }
                onFix={() => go('watchlists')}
              />
              <div className="row">
                <button type="button" className="btn small ghost" onClick={() => qc.invalidateQueries({ queryKey: ['settings-check'] })}>
                  Check again
                </button>
              </div>
            </section>
          )}

          {section === 'library' && (
            <>
            <section className="panel">
              <p className="muted small">
                qBittorrent downloads straight into these folders, then Mediarr renames the result. Use paths as qBittorrent sees them. With more than
                one folder (say, one per drive), each new title goes to the first folder whose drive still has room; a title’s later episodes stay
                with it, and it moves to another folder if a download won’t fit.
              </p>
              {(
                [
                  ['moviesRoots', 'Movies', 'D:\\Media\\Movies'],
                  ['showsRoots', 'Shows', 'D:\\Media\\Shows'],
                  ['animeRoots', 'Anime', 'D:\\Media\\Anime'],
                ] as const
              ).map(([key, label, placeholder]) => (
                <FolderList
                  key={key}
                  label={label}
                  placeholder={placeholder}
                  folders={form[key]}
                  space={space.data?.[key]}
                  minFreeGb={form.minFreeSpaceGb}
                  onChange={(folders) => setForm({ ...form, [key]: folders })}
                />
              ))}
              <Field label="Keep free on each drive (GB)" hint="When a drive has less free space than this, new titles go to the next folder.">
                {num('minFreeSpaceGb', { min: 0 })}
              </Field>
            </section>
            <LibraryScanPanel hours={form.libraryScanHours} setHours={(h) => setForm({ ...form, libraryScanHours: h })} />
            </>
          )}

          {section === 'connections' && (
            <>
              <section className="panel">
                <h3>Movie & show info</h3>
                <Field label="TMDB API key" hint="Free at themoviedb.org → Settings → API. v3 key or v4 read token. Anime uses AniList (no key needed).">
                  {text('tmdbApiKey', { type: 'password', autoComplete: 'off' })}
                </Field>
                <TestButton service="tmdb" form={form} />
                <Field label="OMDb API key (optional)" hint="Adds IMDb and Rotten Tomatoes ratings to the details screen. Free at omdbapi.com (1,000 lookups a day).">
                  {text('omdbApiKey', { type: 'password', autoComplete: 'off' })}
                </Field>
                <TestButton service="omdb" form={form} />
              </section>
              <section className="panel">
                <h3>Prowlarr · finds releases</h3>
                <Field label="URL">{text('prowlarrUrl', { placeholder: 'http://localhost:9696' })}</Field>
                <Field label="API key" hint="Prowlarr → Settings → General → API Key">
                  {text('prowlarrApiKey', { type: 'password', autoComplete: 'off' })}
                </Field>
                <TestButton service="prowlarr" form={form} />
              </section>
              <section className="panel">
                <h3>qBittorrent · downloads them</h3>
                <Field label="Web UI URL" hint="qBittorrent → Tools → Options → Web UI must be turned on.">
                  {text('qbitUrl', { placeholder: 'http://localhost:8080' })}
                </Field>
                <div className="two">
                  <Field label="Username">{text('qbitUsername', { autoComplete: 'off' })}</Field>
                  <Field label="Password">{text('qbitPassword', { type: 'password', autoComplete: 'off' })}</Field>
                </div>
                <Field label="Category" hint="Mediarr only tracks torrents in this category.">
                  {text('qbitCategory')}
                </Field>
                <TestButton service="qbittorrent" form={form} />
              </section>
            </>
          )}

          {section === 'downloading' && (
            <>
              <section className="panel">
                <h3>Release rules</h3>
                <div className="two">
                  <Field label="Preferred resolution">
                    <select className="input" value={form.preferredResolution} onChange={(e) => setForm({ ...form, preferredResolution: e.target.value as Settings['preferredResolution'] })}>
                      {['2160p', '1080p', '720p', '480p'].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Minimum seeders" hint="Releases with fewer are skipped.">
                    {num('minSeeders', { min: 0 })}
                  </Field>
                  <Field label="Max movie size (GB)">{num('maxMovieSizeGb', { min: 0, step: 0.5 })}</Field>
                  <Field label="Max size per episode (GB)">{num('maxEpisodeSizeGb', { min: 0, step: 0.5 })}</Field>
                </div>
                <label className="check">
                  <input type="checkbox" checked={form.allow4k} onChange={(e) => setForm({ ...form, allow4k: e.target.checked })} />
                  <span>Allow 4K releases</span>
                </label>
                <Field label="Default anime audio" hint="Pre-selected when requesting anime; can be changed per title.">
                  <div className="segmented">
                    {(['sub', 'dub'] as const).map((a) => (
                      <button type="button" key={a} className={form.defaultAnimeAudio === a ? 'on' : ''} onClick={() => setForm({ ...form, defaultAnimeAudio: a })}>
                        {a === 'sub' ? 'Sub' : 'Dub'}
                      </button>
                    ))}
                  </div>
                </Field>
              </section>
              <section className="panel">
                <h3>Checking for new episodes</h3>
                <div className="two">
                  <Field label="Check every (minutes)" hint="How often monitored titles are checked.">
                    {num('monitorIntervalMinutes', { min: 5 })}
                  </Field>
                  <Field label="Retry missing after (hours)" hint="Newly aired episodes are always searched right away.">
                    {num('researchIntervalHours', { min: 1 })}
                  </Field>
                </div>
                <div className="row">
                  <button type="button" className="btn small" disabled={monitor.isPending} onClick={() => monitor.mutate()}>
                    {monitor.isPending ? 'Checking…' : 'Check now'}
                  </button>
                  {monitor.data && (
                    <span className="muted small">
                      Checked {monitor.data.searched} title(s), sent {monitor.data.grabs} download(s).
                    </span>
                  )}
                  {monitor.error && <span className="error-text">{(monitor.error as Error).message}</span>}
                </div>
              </section>
            </>
          )}

          {section === 'playback' && (
            <>
              <section className="panel">
                <h3>FFmpeg</h3>
                <p className="muted small">
                  Converts videos the browser can’t play directly. Install it once with <code>winget install Gyan.FFmpeg</code>.
                </p>
                <Field label="FFmpeg folder (optional)" hint="Leave empty to find it automatically.">
                  {text('ffmpegPath', { placeholder: 'C:\\ffmpeg\\bin', spellCheck: false })}
                </Field>
                <TestButton service="ffmpeg" form={form} />
                <Field label="Convert with" hint="A graphics card is much faster than the CPU.">
                  <select className="input" value={form.hwAccel} onChange={(e) => setForm({ ...form, hwAccel: e.target.value as Settings['hwAccel'] })}>
                    <option value="auto">Automatic (best available)</option>
                    <option value="amf">AMD graphics (AMF)</option>
                    <option value="nvenc">NVIDIA graphics (NVENC)</option>
                    <option value="qsv">Intel graphics (Quick Sync)</option>
                    <option value="none">CPU only</option>
                  </select>
                </Field>
              </section>
              <section className="panel">
                <h3>Streaming</h3>
                <div className="two">
                  <Field label="Away-from-home limit (Mbps)" hint="Quality “Auto” stays under this when watching remotely. Keep it below your upload speed.">
                    {num('remoteMaxBitrateMbps', { min: 1, max: 100 })}
                  </Field>
                  <Field label="Videos converting at once" hint="More viewers than this see “server busy”.">
                    {num('maxTranscodes', { min: 1, max: 10 })}
                  </Field>
                </div>
              </section>
              <section className="panel">
                <h3>Player extras</h3>
                <p className="muted small">Worked out in the background after a download is imported, and right away when something is played.</p>
                <label className="check">
                  <input type="checkbox" checked={form.introDetection} onChange={(e) => setForm({ ...form, introDetection: e.target.checked })} />
                  <span>
                    <strong>Skip intro &amp; credits</strong>
                    <span className="muted small"> · finds openings and endings from chapter names, or by matching the audio across a season’s episodes</span>
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.trickplay} onChange={(e) => setForm({ ...form, trickplay: e.target.checked })} />
                  <span>
                    <strong>Seek-bar previews</strong>
                    <span className="muted small"> · a thumbnail every 10 seconds (about 1.5 MB per movie, made in under a minute)</span>
                  </span>
                </label>
              </section>
            </>
          )}

          {section === 'watchlists' && (
            <>
              <section className="panel">
                <h3>Watchlist apps</h3>
                <p className="muted small">Set up once so everyone can connect their own lists below. Leave a field empty to turn that service off.</p>
                <Field label="Simkl client ID" hint="simkl.com/settings/developer → New app. Choose “TV, devices & command line” (no secret needed).">
                  {text('simklClientId', { autoComplete: 'off', spellCheck: false })}
                </Field>
                <Field label="Simkl client secret (optional)" hint="Only if the Simkl app was registered as “Server apps & services”.">
                  {text('simklClientSecret', { type: 'password', autoComplete: 'off' })}
                </Field>
                <Field label="AniList client ID" hint="anilist.co/settings/developer → Create new client, with redirect URL exactly https://anilist.co/api/v2/oauth/pin.">
                  {text('anilistClientId', { autoComplete: 'off', spellCheck: false, inputMode: 'numeric' })}
                </Field>
              </section>
            </>
          )}

          {section === 'system' && <UpdatesPanel form={form} setForm={setForm} />}

          {(dirty || save.isPending || (save.isSuccess && FORM_SECTIONS.has(section))) && (
            <div className="save-bar">
              {save.error && <span className="error-text">{(save.error as Error).message}</span>}
              {dirty ? (
                <>
                  <span className="muted small">You have unsaved changes.</span>
                  <button type="button" className="btn ghost" onClick={() => setForm(saved)} disabled={save.isPending}>
                    Discard
                  </button>
                  <button className="btn primary" type="submit" disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              ) : (
                <span className="ok-text">Saved ✓</span>
              )}
            </div>
          )}
        </form>

        {section === 'watchlists' &&
          (dirty ? <p className="muted small">Save your changes to connect your own accounts.</p> : <WatchlistLinksPanel />)}
        {section === 'users' && <UsersPanel />}
        {section === 'system' && <SystemPanel />}
        {section === 'account' && <SecurityPanel />}
        </div>
      </div>
    </div>
  );
}

/** Settings → System → Updates: the installed version, the latest release on GitHub, and Check now. */
function UpdatesPanel({ form, setForm }: { form: Settings; setForm: (s: Settings) => void }) {
  const qc = useQueryClient();
  const info = useUpdateInfo();
  const [open, setOpen] = useState(false);
  const check = useMutation({
    mutationFn: () => api.post<UpdateInfo>('/api/system/update/check'),
    onSuccess: (d) => qc.setQueryData(['update'], d),
  });
  const d = check.data ?? info.data;
  return (
    <section className="panel">
      <h3>Updates</h3>
      {d && (
        <div className="status-line">
          <span className={`status-icon${d.available ? '' : d.error ? '' : ' ok'}`} aria-hidden>
            {d.available ? '↑' : d.error ? '!' : '✓'}
          </span>
          <div className="status-text">
            <strong>
              {d.available && d.latest ? `v${d.latest.version} is available` : d.error ? 'Couldn’t check for updates' : `Up to date (v${d.current})`}
            </strong>
            <span className="muted small">
              {d.error
                ? d.error
                : `Installed: v${d.current}${d.latest ? ` · Latest release: v${d.latest.version}` : ''}${d.checkedAt ? ` · Checked ${new Date(d.checkedAt).toLocaleString()}` : ' · Not checked yet'}`}
            </span>
          </div>
          {d.available ? (
            <button type="button" className="btn small primary" onClick={() => setOpen(true)}>
              Update…
            </button>
          ) : (
            <button type="button" className="btn small" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={form.autoCheckUpdates} onChange={(e) => setForm({ ...form, autoCheckUpdates: e.target.checked })} />
        <span>Check for new releases automatically (every 6 hours)</span>
      </label>
      <Field label="GitHub repository (optional)" hint={`Leave empty to use the one this folder was cloned from${d?.repo ? ` (${d.repo})` : ''}. Only published releases count as updates.`}>
        <input className="input" value={form.updateRepo} placeholder="owner/repo" spellCheck={false} onChange={(e) => setForm({ ...form, updateRepo: e.target.value })} />
      </Field>
      {open && <UpdateDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
