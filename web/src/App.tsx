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

// The player (hls.js + subtitle renderer) only loads when something is played.
const Watch = lazy(() => import('./pages/Watch'));

const NAV = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/discover', label: 'Discover', icon: '⌕' },
  { to: '/movies', label: 'Movies', icon: '◐' },
  { to: '/shows', label: 'Shows', icon: '▤' },
  { to: '/anime', label: 'Anime', icon: '✦' },
  { to: '/watchlist', label: 'Watchlist', icon: '☆' },
  { to: '/queue', label: 'Queue', icon: '↓' },
  { to: '/history', label: 'History', icon: '◷' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
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
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span className="nav-icon">{n.icon}</span>
              <span className="nav-label">{n.to === '/settings' && !isAdmin ? 'Account' : n.label}</span>
              {n.to === '/queue' && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
            </NavLink>
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
          <span className="muted small" title="Signed in">
            {auth.data?.user?.username}
            {isAdmin && <span className="badge muted role-badge">admin</span>}
          </span>
          <button className="btn small ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
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
