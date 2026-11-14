import { NavLink, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
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
import Requests, { usePendingRequests } from './pages/Requests';
import SearchAlerts from './components/SearchAlerts';
import { useAuth, useIsAdmin } from './components/AuthGate';
import UpdateDialog, { useUpdateInfo } from './components/UpdateDialog';
import Icon, { type IconName } from './components/Icon';
import Logo from './components/Logo';
import StorageBars from './components/StorageBars';

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
      { to: '/requests', label: 'Requests', icon: 'inbox' },
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

/** Opening a page starts at its top; Back/Forward keep the browser's own scroll position. */
function ScrollToTop() {
  const { pathname } = useLocation();
  const how = useNavigationType();
  useEffect(() => {
    if (how !== 'POP') window.scrollTo(0, 0);
  }, [pathname, how]);
  return null;
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
  // Requests: admins (with a count of what's waiting) and users whose requests need approval.
  const pendingRequests = usePendingRequests(isAdmin).data?.pending ?? 0;
  const showRequests = isAdmin || !!auth.data?.user?.needsApproval;
  const [updating, setUpdating] = useState(false);
  // Phones: the pages are in a ☰ menu (the sidebar is a header there). It closes on any page change.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [menuOpen]);
  const badges = activeCount + pendingRequests;

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' menu-open' : ''}`}>
        <div className="brand">
          <Logo />
          <span>Mediarr</span>
          <button
            type="button"
            className="menu-toggle"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="main-menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} size={22} />
            {!menuOpen && badges > 0 && <span className="menu-toggle-dot" aria-hidden />}
          </button>
        </div>
        <div className="sidebar-menu" id="main-menu">
        <nav>
          {NAV.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.heading && <div className="nav-heading">{group.heading}</div>}
              {group.items.filter((n) => n.to !== '/requests' || showRequests).map((n) => {
                const account = n.to === '/settings' && !isAdmin;
                return (
                  <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <span className="nav-icon">
                      <Icon name={account ? 'account' : n.icon} />
                    </span>
                    <span className="nav-label">{account ? 'Account' : n.label}</span>
                    {n.to === '/queue' && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
                    {n.to === '/requests' && pendingRequests > 0 && <span className="nav-badge">{pendingRequests}</span>}
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
        <div className="sidebar-bottom">
          {isAdmin && <StorageBars />}
        </div>
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
        </div>
      </aside>
      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden />}
      {updating && <UpdateDialog onClose={() => setUpdating(false)} />}
      <ScrollToTop />
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/movies" element={<Library type="movie" />} />
          <Route path="/shows" element={<Library type="show" />} />
          <Route path="/anime" element={<Library type="anime" />} />
          <Route path="/media/:id" element={<Detail />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <SearchAlerts />
    </div>
  );
}
