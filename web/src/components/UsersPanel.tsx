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
  totpEnabled: boolean;
  sessions: number;
  createdAt: string;
}

function AddUser() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [approval, setApproval] = useState(false);
  const add = useMutation({
    mutationFn: () => api.post('/api/users', { username, password, role, needsApproval: role === 'user' && approval }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      setRole('user');
      setApproval(false);
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
      {role === 'user' && (
        <label className="check full-row">
          <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
          <span>Their requests need an admin’s approval</span>
        </label>
      )}
      {add.error && <div className="error-box full-row">{(add.error as Error).message}</div>}
      {add.isSuccess && <span className="ok-text small full-row">User added. Share the password with them; they can change it under Account.</span>}
    </form>
  );
}

function UserRow({ u, isMe }: { u: UserSummary; isMe: boolean }) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const update = useMutation({
    mutationFn: (body: { role?: string; password?: string; needsApproval?: boolean }) => api.patch(`/api/users/${u.id}`, body),
    onSuccess: () => {
      setResetting(false);
      setPassword('');
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/users/${u.id}`), onSuccess: refresh });
  const error = (update.error || remove.error) as Error | null;

  return (
    <>
      <tr>
        <td>
          <strong>{u.username}</strong> {isMe && <span className="muted small">(you)</span>}
        </td>
        <td>
          <select
            className="input small-input"
            value={u.role}
            disabled={isMe || update.isPending}
            title={isMe ? 'You can’t change your own role' : 'Role'}
            onChange={(e) => update.mutate({ role: e.target.value })}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </td>
        <td>
          {u.role === 'user' ? (
            <label className="switch" title="When on, what they request waits for an admin to approve it">
              <input type="checkbox" role="switch" checked={u.needsApproval} disabled={update.isPending} onChange={(e) => update.mutate({ needsApproval: e.target.checked })} />
              <span className="switch-track" aria-hidden />
              <span className="small">Needs approval</span>
            </label>
          ) : null}
        </td>
        <td>{u.totpEnabled ? <span className="badge ok">2FA on</span> : <span className="badge muted">2FA off</span>}</td>
        <td className="muted small nowrap">{u.sessions} session(s)</td>
        <td className="muted small nowrap">Added {formatDate(u.createdAt)}</td>
        <td className="nowrap actions">
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
        </td>
      </tr>
      {(resetting || error) && (
        <tr className="sub-row">
          <td colSpan={7}>
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
          </td>
        </tr>
      )}
    </>
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
        what they request waits on the Requests page until an admin approves it.
      </p>
      {users.isLoading && <div className="loading">Loading…</div>}
      {users.data && (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {users.data.map((u) => (
                <UserRow key={u.id} u={u} isMe={u.id === auth.data?.user?.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Add a user</h3>
      <AddUser />
    </section>
  );
}
