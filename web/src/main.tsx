import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import AuthGate from './components/AuthGate';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import './styles.css';

// A watch-party guest link: no account, so it skips sign-in (and the rest of the app) entirely.
const GuestParty = lazy(() => import('./pages/Party').then((m) => ({ default: m.GuestPartyPage })));
const GUEST_PATH = /^\/party\/[^/]+\/guest\/?$/;

function Root() {
  const { pathname } = useLocation();
  if (GUEST_PATH.test(pathname)) {
    return (
      <Suspense fallback={<div className="watch watch-message">Loading…</div>}>
        <Routes>
          <Route path="/party/:id/guest" element={<GuestParty />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <AuthGate>
      <App />
    </AuthGate>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
