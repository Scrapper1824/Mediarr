import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../api';
import { useAuth } from './AuthGate';
import Spinner from './Spinner';

interface UserSummary {
  id: number;
  username: string;
  role: 'admin' | 'user';
  needsApproval: boolean;
  allowAdult: boolean;
  totpEnabled: boolean;
  sessions: number;
  createdAt: string;
}

function Switch({ checked, disabled, onChange, label, title }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string; title: string }) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      <span className="small">{label}</span>
    </label>
  );
}

function AddUser() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [approval, setApproval] = useState(false);
  const [adult, setAdult] = useState(false);
  const add = useMutation({
    mutationFn: () => api.post('/api/users', { username, password, role, needsApproval: role === 'user' && approval, allowAdult: adult }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      setRole('user');
      setApproval(false);
      setAdult(false);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <form
      className="add-user"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <input className="input" placeholder="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} />
      <input className="input" type="password" placeholder="Password (12+ characters)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
      <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')} aria-label="Role">
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
      <button className="btn primary" disabled={add.isPending}>
        {add.isPending && <Spinner />} Add user
      </button>
      <div className="full-row add-user-options">
        {role === 'user' && (
          <label className="check">
            <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
            <span>Their requests need an admin’s approval</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <span>Allow 18+ content</span>
        </label>
      </div>
      {add.error && <div className="error-box full-row">{(add.error as Error).message}</div>}
      {add.isSuccess && <span className="ok-text small full-row">User added. Share the password with them; they can change it under Account.</span>}
    </form>
  );
}

function UserRow({ u, isMe }: { u: UserSummary; isMe: boolean }) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    // Your own 18+ switch changes what Discover and the library show you.
    if (isMe) {
      qc.invalidateQueries({ queryKey: ['auth'] });
      qc.invalidateQueries({ queryKey: ['discover'] });
      qc.invalidateQueries({ queryKey: ['media'] });
      qc.invalidateQueries({ queryKey: ['home'] });
    }
  };
  const update = useMutation({
    mutationFn: (body: { role?: string; password?: string; needsApproval?: boolean; allowAdult?: boolean }) => api.patch(`/api/users/${u.id}`, body),
    onSuccess: () => {
      setResetting(false);
      setPassword('');
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/users/${u.id}`), onSuccess: refresh });
  const error = (update.error || remove.error) as Error | null;

  return (
    <li className="user-row">
      <div className="user-who">
        <div>
          <strong>{u.username}</strong> {isMe && <span className="muted small">(you)</span>}
        </div>
        <div className="muted small user-meta">
          {u.totpEnabled ? <span className="badge ok">2FA on</span> : <span className="badge muted">2FA off</span>}
          <span>
            {u.sessions} session{u.sessions === 1 ? '' : 's'} · Added {formatDate(u.createdAt)}
          </span>
        </div>
      </div>
      <select
        className="input small-input user-role"
        value={u.role}
        disabled={isMe || update.isPending}
        title={isMe ? 'You can’t change your own role' : 'Role'}
        aria-label={`Role of ${u.username}`}
        onChange={(e) => update.mutate({ role: e.target.value })}
      >
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
      <div className="user-switches">
        {u.role === 'user' && (
          <Switch
            checked={u.needsApproval}
            disabled={update.isPending}
            onChange={(v) => update.mutate({ needsApproval: v })}
            label="Needs approval"
            title="When on, what they request waits for an admin to approve it"
          />
        )}
        <Switch
          checked={u.allowAdult}
          disabled={update.isPending}
          onChange={(v) => update.mutate({ allowAdult: v })}
          label="18+ content"
          title="When on, they see 18+ titles, genres and tags in Discover and in the library"
        />
      </div>
      <div className="user-actions">
        {!isMe && (
          <>
            <button className="btn small ghost" onClick={() => setResetting((r) => !r)}>
              Reset password
            </button>
            <button
              className="btn small ghost danger"
              disabled={remove.isPending}
              onClick={() => confirm(`Remove ${u.username}? They’ll be signed out immediately.`) && remove.mutate()}
            >
              Remove
            </button>
          </>
        )}
      </div>
      {(resetting || error) && (
        <div className="user-sub">
          {resetting && (
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate({ password });
              }}
            >
              <input
                className="input grow"
                type="password"
                autoComplete="new-password"
                placeholder={`New password for ${u.username} (12+ characters)`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoFocus
              />
              <button className="btn small primary" disabled={update.isPending}>
                Set password
              </button>
              <span className="muted small">They’ll be signed out everywhere.</span>
            </form>
          )}
          {error && <div className="error-box">{error.message}</div>}
        </div>
      )}
    </li>
  );
}

export default function UsersPanel() {
  const auth = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserSummary[]>('/api/users') });
  return (
    <section className="panel users-panel">
      <h2>Users</h2>
      <p className="muted small">
        <strong>Admins</strong> can do everything. <strong>Users</strong> can browse, request and search, but can’t change settings,
        manage users, remove items from the library or cancel downloads. Turn on <strong>Needs approval</strong> for a user and
        what they request waits on the Requests page until an admin approves it. <strong>18+ content</strong> (off for everyone
        until you turn it on) shows them adult titles, genres and tags in Discover and in the library.
      </p>
      {users.isLoading && <div className="loading">Loading…</div>}
      {users.data && (
        <ul className="user-list">
          {users.data.map((u) => (
            <UserRow key={u.id} u={u} isMe={u.id === auth.data?.user?.id} />
          ))}
        </ul>
      )}
      <h3>Add a user</h3>
      <AddUser />
    </section>
  );
}
