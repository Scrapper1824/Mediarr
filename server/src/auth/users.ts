import type { FastifyInstance } from 'fastify';
import { db, logHistory, now } from '../db.js';
import { hashPassword, passwordProblem } from './password.js';
import { USERNAME } from './routes.js';
import { adminCount, countSessions, deleteUserSessions, type Role, type UserRow } from './sessions.js';

const ROLES: Role[] = ['admin', 'user'];

const getUser = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

function summary(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    totpEnabled: !!u.totp_enabled,
    sessions: countSessions(u.id),
    createdAt: u.created_at,
  };
}

/** Admin-only (enforced in security.ts): add, change and remove accounts. */
export async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', async () =>
    (db.prepare('SELECT * FROM users ORDER BY role, username COLLATE NOCASE').all() as unknown as UserRow[]).map(summary),
  );

  app.post<{ Body: { username?: string; password?: string; role?: Role } }>('/api/users', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim();
    const role = req.body?.role ?? 'user';
    if (!USERNAME.test(username)) return reply.code(400).send({ error: 'Username must be 3–32 letters, numbers, dots, dashes or underscores.' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'Unknown role.' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return reply.code(409).send({ error: 'That username is taken.' });
    const problem = passwordProblem(req.body?.password, username);
    if (problem) return reply.code(400).send({ error: problem });
    const r = db
      .prepare('INSERT INTO users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, await hashPassword(req.body!.password!), role, now(), now());
    logHistory(null, 'users', `${req.user!.username} added ${role === 'admin' ? 'admin' : 'user'} "${username}"`);
    return summary(getUser(Number(r.lastInsertRowid))!);
  });

  app.patch<{ Params: { id: string }; Body: { role?: Role; password?: string } }>('/api/users/:id', async (req, reply) => {
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'User not found.' });

    if (req.body?.role !== undefined && req.body.role !== target.role) {
      if (!ROLES.includes(req.body.role)) return reply.code(400).send({ error: 'Unknown role.' });
      if (target.id === req.user!.id) return reply.code(400).send({ error: 'You can’t change your own role.' });
      if (target.role === 'admin' && adminCount() <= 1) return reply.code(400).send({ error: 'There must always be at least one admin.' });
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, target.id);
      logHistory(null, 'users', `${req.user!.username} made "${target.username}" ${req.body.role === 'admin' ? 'an admin' : 'a regular user'}`);
    }

    if (req.body?.password !== undefined) {
      if (target.id === req.user!.id) return reply.code(400).send({ error: 'Change your own password under Security.' });
      const problem = passwordProblem(req.body.password, target.username);
      if (problem) return reply.code(400).send({ error: problem });
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(
        await hashPassword(req.body.password),
        now(),
        target.id,
      );
      // Their existing sessions end so the new password takes effect everywhere.
      deleteUserSessions(target.id);
      logHistory(null, 'users', `${req.user!.username} reset the password of "${target.username}"`);
    }
    return summary(getUser(target.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'User not found.' });
    if (target.id === req.user!.id) return reply.code(400).send({ error: 'You can’t delete your own account.' });
    if (target.role === 'admin' && adminCount() <= 1) return reply.code(400).send({ error: 'There must always be at least one admin.' });
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id); // sessions go with it (ON DELETE CASCADE)
    logHistory(null, 'users', `${req.user!.username} removed "${target.username}"`);
    return { ok: true };
  });
}
