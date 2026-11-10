import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from './AuthGate';
import Spinner from './Spinner';

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch) change.mutate();
      }}
    >
      <h3>Change password</h3>
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password (12+ characters)" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      {mismatch && <span className="error-text small">Passwords don’t match.</span>}
      {change.error && <div className="error-box">{(change.error as Error).message}</div>}
      {change.isSuccess && <span className="ok-text small">Password changed. Other devices were signed out.</span>}
      <div>
        <button className="btn small" disabled={change.isPending || mismatch}>
          {change.isPending && <Spinner />} Change password
        </button>
      </div>
    </form>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<{ secret: string; qr: string } | null>(null);
  const done = () => {
    setPassword('');
    setCode('');
    setPending(null);
    qc.invalidateQueries({ queryKey: ['auth'] });
  };
  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; qr: string }>('/api/auth/totp/setup', { password }),
    onSuccess: (r) => {
      setPending(r);
      setPassword('');
    },
  });
  const enable = useMutation({ mutationFn: () => api.post('/api/auth/totp/enable', { code }), onSuccess: done });
  const disable = useMutation({ mutationFn: () => api.post('/api/auth/totp/disable', { password, code }), onSuccess: done });
  const error = (start.error || enable.error || disable.error) as Error | null;

  if (enabled) {
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          disable.mutate();
        }}
      >
        <h3>
          Two-factor sign-in <span className="badge ok">On</span>
        </h3>
        <p className="muted small">To turn it off, confirm with your password and a current code.</p>
        <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required />
        {error && <div className="error-box">{error.message}</div>}
        <div>
          <button className="btn small danger" disabled={disable.isPending}>
            Turn off two-factor
          </button>
        </div>
      </form>
    );
  }

  if (pending) {
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          enable.mutate();
        }}
      >
        <h3>Set up two-factor sign-in</h3>
        <p className="muted small">
          Scan this with an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden…), then enter the 6-digit code it shows.
        </p>
        <img className="totp-qr" src={pending.qr} alt="Two-factor QR code" width={180} height={180} />
        <div className="small">
          Can’t scan? Enter this key: <code className="code-input">{pending.secret.match(/.{1,4}/g)!.join(' ')}</code>
        </div>
        <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required />
        {error && <div className="error-box">{error.message}</div>}
        <div className="row">
          <button className="btn small primary" disabled={enable.isPending}>
            Turn on
          </button>
          <button type="button" className="btn small ghost" onClick={done}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <h3>
        Two-factor sign-in <span className="badge muted">Off</span>
      </h3>
      <p className="muted small">Strongly recommended before making Mediarr reachable from the internet.</p>
      <input className="input" type="password" autoComplete="current-password" placeholder="Confirm your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <div className="error-box">{error.message}</div>}
      <div>
        <button className="btn small" disabled={start.isPending}>
          {start.isPending && <Spinner />} Set up two-factor
        </button>
      </div>
    </form>
  );
}

export default function SecurityPanel() {
  const qc = useQueryClient();
  const auth = useAuth();
  const user = auth.data?.user;
  const others = useMutation({
    mutationFn: () => api.post('/api/auth/logout-others'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth'] }),
  });
  if (!user) return null;
  return (
    <section className="panel security-panel">
      <h2>Security</h2>
      <p className="muted small">
        Signed in as <strong>{user.username}</strong>. Active sessions: {user.sessions}.
      </p>
      <div className="security-grid">
        <ChangePassword />
        <TwoFactor enabled={user.totpEnabled} />
      </div>
      <div className="row">
        <button className="btn small ghost" disabled={others.isPending || user.sessions <= 1} onClick={() => others.mutate()}>
          Sign out all other devices
        </button>
        {others.isSuccess && <span className="ok-text small">Done.</span>}
      </div>
      <p className="hint">Locked out? On the Mediarr computer run <code>npm run reset-password</code>.</p>
    </section>
  );
}
