import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, UNAUTHORIZED_EVENT, type AuthStatus } from '../api';
import Spinner from './Spinner';

export function useIsAdmin(): boolean {
  return useAuth().data?.user?.role === 'admin';
}

export function useAuth() {
  return useQuery({ queryKey: ['auth'], queryFn: () => api.get<AuthStatus>('/api/auth/status'), staleTime: 60_000 });
}

function Brand() {
  return (
    <div className="auth-brand">
      <span className="brand-mark">M</span>
      <span>Mediarr</span>
    </div>
  );
}

function LoginScreen() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const login = useMutation({
    mutationFn: () => api.post('/api/auth/login', { username, password, code: needCode ? code : undefined }),
    onSuccess: () => qc.resetQueries(),
    onError: (e) => {
      if (e instanceof ApiError && e.data.totpRequired) setNeedCode(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  // The "enter your code" prompt itself isn't an error worth showing in red.
  const error = login.error instanceof ApiError && login.error.data.totpRequired && !code ? null : (login.error as Error | null);

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        <h1>Sign in</h1>
        <label className="field">
          <span className="field-label">Username</span>
          <input className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} disabled={needCode} required />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={needCode} required />
        </label>
        {needCode && (
          <label className="field">
            <span className="field-label">Authenticator code</span>
            <input
              className="input code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123 456"
              required
            />
            <span className="hint">From your authenticator app.</span>
          </label>
        )}
        {error && <div className="error-box">{error.message}</div>}
        <button className="btn primary full" disabled={login.isPending}>
          {login.isPending && <Spinner />}
          {login.isPending ? 'Signing in…' : needCode ? 'Verify' : 'Sign in'}
        </button>
        {needCode && (
          <button
            type="button"
            className="btn ghost full"
            onClick={() => {
              setNeedCode(false);
              setCode('');
              login.reset();
            }}
          >
            Back
          </button>
        )}
      </form>
    </div>
  );
}

function SetupScreen() {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;
  const setup = useMutation({
    mutationFn: () => api.post('/api/auth/setup', { code, username, password }),
    onSuccess: () => qc.resetQueries(),
  });

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) setup.mutate();
        }}
      >
        <Brand />
        <h1>Create your account</h1>
        <p className="muted small">
          Mediarr needs an account before anything can be used. Enter the setup code shown in the Mediarr window (also saved in{' '}
          <code>data\setup-code.txt</code>). This keeps anyone else from claiming your server.
        </p>
        <label className="field">
          <span className="field-label">Setup code</span>
          <input className="input code-input" autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required />
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
          <span className="hint">At least 12 characters. A few random words make a strong, memorable password.</span>
        </label>
        <label className="field">
          <span className="field-label">Confirm password</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          {mismatch && <span className="error-text small">Passwords don’t match.</span>}
        </label>
        {setup.error && <div className="error-box">{(setup.error as Error).message}</div>}
        <button className="btn primary full" disabled={setup.isPending || mismatch}>
          {setup.isPending && <Spinner />}
          {setup.isPending ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

/** Shows setup or login until signed in; nothing else in the app renders (or fetches) before that. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const auth = useAuth();

  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  if (auth.isLoading) {
    return (
      <div className="auth-page">
        <Spinner size={22} />
      </div>
    );
  }
  if (auth.error || !auth.data) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <Brand />
          <div className="error-box">Can’t reach the Mediarr server.</div>
          <button className="btn full" onClick={() => auth.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (auth.data.setupRequired) return <SetupScreen />;
  if (!auth.data.authenticated) return <LoginScreen />;
  return <>{children}</>;
}
