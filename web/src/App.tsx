import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Download } from './api';
import Discover from './pages/Discover';
import Home from './pages/Home';
import Library from './pages/Library';
import Detail from './pages/Detail';
import Queue from './pages/Queue';
import History from './pages/History';
import Watchlist from './pages/Watchlist';
import SettingsPage from './pages/Settings';
import SearchAlerts from './components/SearchAlerts';
import { useAuth, useIsAdmin } from './components/AuthGate';
import UpdateDialog, { useUpdateInfo } from './components/UpdateDialog';
import Icon, { type IconName } from './components/Icon';

// The player (hls.js + subtitle renderer) only loads when something is played.
const Watch = lazy(() => import('./pages/Watch'));

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}
/** What you watch first; finding and fetching more second. */
const NAV: { heading: string | null; items: NavItem[] }[] = [
  {
    heading: null,
    items: [
      { to: '/', label: 'Home', icon: 'home' },
      { to: '/movies', label: 'Movies', icon: 'movie' },
      { to: '/shows', label: 'Shows', icon: 'show' },
      { to: '/anime', label: 'Anime', icon: 'anime' },
      { to: '/watchlist', label: 'Watchlist', icon: 'watchlist' },
    ],
  },
  {
    heading: 'Get more',
    items: [
      { to: '/discover', label: 'Discover', icon: 'discover' },
      { to: '/queue', label: 'Downloads', icon: 'queue' },
      { to: '/history', label: 'History', icon: 'history' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export default function App() {
  const location = useLocation();
  if (location.pathname.startsWith('/watch/')) {
    return (
      <Routes>
        <Route path="/watch/:kind/:id" element={<Suspense fallback={<div className="watch watch-message">Loading…</div>}><Watch /></Suspense>} />
      </Routes>
    );
  }
  return <Shell />;
}

function Shell() {
  const queue = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Download[]>('/api/queue'),
    refetchInterval: 5000,
  });
  const activeCount = queue.data?.filter((d) => d.state !== 'failed').length ?? 0;
  const qc = useQueryClient();
  const auth = useAuth();
  const isAdmin = useIsAdmin();
  const logout = useMutation({ mutationFn: () => api.post('/api/auth/logout'), onSettled: () => qc.resetQueries() });
  // Admins: a new release on GitHub shows as "Update available".
  const update = useUpdateInfo(isAdmin);
  const [updating, setUpdating] = useState(false);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>Mediarr</span>
        </div>
        <nav>
          {NAV.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.heading && <div className="nav-heading">{group.heading}</div>}
              {group.items.map((n) => {
                const account = n.to === '/settings' && !isAdmin;
                return (
                  <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <span className="nav-icon">
                      <Icon name={account ? 'account' : n.icon} />
                    </span>
                    <span className="nav-label">{account ? 'Account' : n.label}</span>
                    {n.to === '/queue' && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        {isAdmin && update.data?.available && update.data.latest && (
          <button className="update-pill" onClick={() => setUpdating(true)} title={`Mediarr v${update.data.latest.version} is available`}>
            <span className="update-pill-dot" aria-hidden />
            <span>
              Update available
              <small>v{update.data.latest.version}</small>
            </span>
          </button>
        )}
        <div className="sidebar-user">
          <span className="avatar" aria-hidden>
            {(auth.data?.user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="sidebar-who" title="Signed in">
            <strong>{auth.data?.user?.username}</strong>
            <span>{isAdmin ? 'Admin' : 'Viewer'}</span>
          </span>
          <button className="icon-btn" onClick={() => logout.mutate()} disabled={logout.isPending} title="Sign out" aria-label="Sign out">
            <Icon name="signout" size={18} />
          </button>
        </div>
      </aside>
      {updating && <UpdateDialog onClose={() => setUpdating(false)} />}
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/movies" element={<Library type="movie" />} />
          <Route path="/shows" element={<Library type="show" />} />
          <Route path="/anime" element={<Library type="anime" />} />
          <Route path="/media/:id" element={<Detail />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <SearchAlerts />
    </div>
  );
}
