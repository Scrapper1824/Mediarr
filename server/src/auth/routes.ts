import crypto from 'node:crypto';
import { endUserSessions } from '../playback/sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { db, now } from '../db.js';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from './password.js';
import { lockedFor, recordFailure, recordSuccess } from './rateLimit.js';
import { clearSessionCookie, setSessionCookie } from './security.js';
import { countSessions, createSession, deleteSession, deleteUserSessions, userCount, type UserRow } from './sessions.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';

export const USERNAME = /^[A-Za-z0-9._-]{3,32}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- First-run setup code ----
// Until an account exists, creating one needs a code that's only shown on this computer, so nobody who
// finds the site first (e.g. once it's public) can claim it.
let setupCode: string | null = null;

export function setupCodePath(dataDir: string) {
  return path.join(dataDir, 'setup-code.txt');
}

export function prepareSetupCode(dataDir: string): string | null {
  if (userCount() > 0) {
    fs.rmSync(setupCodePath(dataDir), { force: true });
    setupCode = null;
    return null;
  }
  const raw = crypto.randomBytes(10).toString('hex').toUpperCase(); // 80 bits
  setupCode = raw.match(/.{1,5}/g)!.join('-');
  fs.writeFileSync(setupCodePath(dataDir), `${setupCode}\n`, { mode: 0o600 });
  return setupCode;
}

function setupCodeMatches(code: unknown): boolean {
  if (!setupCode || typeof code !== 'string') return false;
  const a = Buffer.from(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const b = Buffer.from(setupCode.replace(/-/g, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, needsApproval: u.role !== 'admin' && !!u.needs_approval, totpEnabled: !!u.totp_enabled, sessions: countSessions(u.id) };
}

function signIn(req: FastifyRequest, reply: FastifyReply, user: UserRow) {
  const token = createSession(user.id, req.ip, req.headers['user-agent']);
  setSessionCookie(req, reply, token);
}

const tooMany = (reply: FastifyReply, seconds: number) =>
  reply
    .code(429)
    .header('Retry-After', String(seconds))
    .send({ error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).` });

export async function authRoutes(app: FastifyInstance, opts: { dataDir: string }) {
  app.get('/api/auth/status', async (req) => ({
    setupRequired: userCount() === 0,
    authenticated: !!req.user,
    user: req.user ? publicUser(req.user) : null,
  }));

  app.post<{ Body: { code?: string; username?: string; password?: string } }>('/api/auth/setup', async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup is already done.' });
    const wait = lockedFor(req.ip, '__setup__');
    if (wait) return tooMany(reply, wait);
    if (!setupCodeMatches(req.body?.code)) {
      recordFailure(req.ip, '__setup__');
      await sleep(400);
      return reply.code(401).send({ error: 'Wrong setup code.' });
    }
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME.test(username)) return reply.code(400).send({ error: 'Username must be 3–32 letters, numbers, dots, dashes or underscores.' });
    const problem = passwordProblem(req.body?.password, username);
    if (problem) return reply.code(400).send({ error: problem });

    const hash = await hashPassword(req.body!.password!);
    const r = db
      .prepare("INSERT INTO users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, 'admin', ?, ?)")
      .run(username, hash, now(), now());
    setupCode = null;
    fs.rmSync(setupCodePath(opts.dataDir), { force: true });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as UserRow;
    signIn(req, reply, user);
    return { ok: true };
  });

  app.post<{ Body: { username?: string; password?: string; code?: string } }>('/api/auth/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim().slice(0, 64);
    const password = String(req.body?.password ?? '');
    const wait = lockedFor(req.ip, username);
    if (wait) return tooMany(reply, wait);

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    // Same work and same answer whether or not the user exists.
    const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
    if (!user || !ok) {
      recordFailure(req.ip, username);
      await sleep(400);
      return reply.code(401).send({ error: 'Wrong username or password.' });
    }

    if (user.totp_enabled && user.totp_secret) {
      if (!req.body?.code) return reply.code(401).send({ error: 'Enter the code from your authenticator app.', totpRequired: true });
      const counter = verifyCode(user.totp_secret, req.body.code);
      if (counter === null || counter <= user.totp_last_counter) {
        recordFailure(req.ip, username);
        await sleep(400);
        return reply.code(401).send({ error: 'Wrong or already used code.', totpRequired: true });
      }
      db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, user.id);
    }

    recordSuccess(req.ip, username);
    signIn(req, reply, user);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    deleteSession(req.sessionToken);
    if (req.user) endUserSessions(req.user.id);
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout-others', async (req) => {
    deleteUserSessions(req.user!.id, req.sessionToken);
    return { ok: true };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>('/api/auth/password', async (req, reply) => {
    const user = req.user!;
    const wait = lockedFor(req.ip, user.username);
    if (wait) return tooMany(reply, wait);
    if (!(await verifyPassword(String(req.body?.currentPassword ?? ''), user.password_hash))) {
      recordFailure(req.ip, user.username);
      return reply.code(400).send({ error: 'Current password is wrong.' });
    }
    const problem = passwordProblem(req.body?.newPassword, user.username);
    if (problem) return reply.code(400).send({ error: problem });
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(
      await hashPassword(req.body!.newPassword!),
      now(),
      user.id,
    );
    // Everyone else signed in with the old password is signed out.
    deleteUserSessions(user.id, req.sessionToken);
    return { ok: true };
  });

  // ---- Two-factor (authenticator app) ----
  app.post<{ Body: { password?: string } }>('/api/auth/totp/setup', async (req, reply) => {
    const user = req.user!;
    if (user.totp_enabled) return reply.code(409).send({ error: 'Two-factor is already on.' });
    if (!(await verifyPassword(String(req.body?.password ?? ''), user.password_hash))) {
      recordFailure(req.ip, user.username);
      return reply.code(400).send({ error: 'Password is wrong.' });
    }
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, user.id);
    const uri = otpauthUri(secret, user.username);
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post<{ Body: { code?: string } }>('/api/auth/totp/enable', async (req, reply) => {
    const user = req.user!;
    if (!user.totp_secret || user.totp_enabled) return reply.code(409).send({ error: 'Start two-factor setup first.' });
    const counter = verifyCode(user.totp_secret, req.body?.code);
    if (counter === null) return reply.code(400).send({ error: 'That code didn’t match. Check the time on your phone and try again.' });
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_counter = ? WHERE id = ?').run(counter, user.id);
    deleteUserSessions(user.id, req.sessionToken);
    return { ok: true };
  });

  app.post<{ Body: { password?: string; code?: string } }>('/api/auth/totp/disable', async (req, reply) => {
    const user = req.user!;
    if (!user.totp_enabled || !user.totp_secret) return reply.code(409).send({ error: 'Two-factor is off.' });
    const passwordOk = await verifyPassword(String(req.body?.password ?? ''), user.password_hash);
    const counter = verifyCode(user.totp_secret, req.body?.code);
    if (!passwordOk || counter === null || counter <= user.totp_last_counter) {
      recordFailure(req.ip, user.username);
      return reply.code(400).send({ error: 'Password or code is wrong.' });
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_counter = 0 WHERE id = ?').run(user.id);
    return { ok: true };
  });
}
