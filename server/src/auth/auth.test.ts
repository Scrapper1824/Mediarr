import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { initDb } from '../db.js';
import { hashPassword, verifyPassword } from './password.js';
import { resetRateLimits } from './rateLimit.js';
import { prepareSetupCode } from './routes.js';
import { base32Encode, codeAt, currentCounter, verifyCode } from './totp.js';

const PUBLIC = new Set(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/setup', 'POST /api/party/:id/guest-join']);
const CSRF = { 'x-requested-with': 'mediarr' };
const PASSWORD = 'correct horse battery staple';

let app: FastifyInstance;
let routes: { method: string; url: string }[];
let dataDir: string;
let setupCode: string;

beforeEach(async () => {
  initDb(':memory:');
  resetRateLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-auth-'));
  routes = [];
  app = await buildApp({ dataDir, webDist: null, logLevel: 'silent', routes });
  setupCode = prepareSetupCode(dataDir)!;
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cookieFrom = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

async function setup(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: CSRF,
    payload: { code: setupCode, username: 'owner', password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return cookieFrom(res);
}

describe('everything needs a login', () => {
  it('refuses every non-public API route without a session', async () => {
    const api = routes.filter((r) => r.url.startsWith('/api') && r.method !== 'HEAD');
    expect(api.length).toBeGreaterThan(25);
    for (const r of api) {
      if (PUBLIC.has(`${r.method} ${r.url}`)) continue;
      const url = r.url.replace(/:\w+/g, '1');
      const res = await app.inject({ method: r.method as 'GET', url, headers: CSRF, payload: r.method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('cannot be bypassed with encoded, doubled or odd-cased paths', async () => {
    for (const url of ['/%61pi/media', '/api%2Fmedia', '//api/media', '/api//media', '/API/media', '/api/media/', '/./api/media', '/api/./media', '/api/media?x=1', '/api/../api/media']) {
      const res = await app.inject({ method: 'GET', url });
      expect([400, 401, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('"type"');
    }
  });

  it('refuses a forged or random session cookie', async () => {
    for (const cookie of ['mediarr_session=abc', 'mediarr_session=' + 'A'.repeat(43), 'mediarr_session=']) {
      const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('first-run setup', () => {
  it('needs the setup code, then works once', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: 'AAAAA-BBBBB', username: 'owner', password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);

    const cookie = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: setupCode, username: 'evil', password: PASSWORD } });
    expect(again.statusCode).toBe(409);
    expect(fs.existsSync(path.join(dataDir, 'setup-code.txt'))).toBe(false);
  });

  it('rejects weak passwords', async () => {
    for (const password of ['short', 'ownerownerowner', 'aaaaaaaaaaaaaaa']) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: setupCode, username: 'owner', password } });
      expect(res.statusCode, password).toBe(400);
    }
  });

  it('sets a hardened session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { code: setupCode, username: 'owner', password: PASSWORD } });
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    // Secure is added when the request came over HTTPS (directly or via a trusted proxy).
    const https = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-proto': 'https' },
      payload: { username: 'owner', password: PASSWORD },
      remoteAddress: '127.0.0.1',
    });
    expect(String(https.headers['set-cookie'])).toMatch(/Secure/);
  });
});

describe('login', () => {
  it('gives the same answer for a wrong user and a wrong password', async () => {
    await setup();
    const a = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'nobody', password: PASSWORD } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: 'wrong password!!' } });
    expect(a.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
  });

  it('locks out after repeated failures, even with the right password', async () => {
    await setup();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: `wrong ${i} password` } });
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: PASSWORD } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('logout ends the session', async () => {
    const cookie = await setup();
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } });
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).statusCode).toBe(401);
  });

  it('changing the password signs out other sessions', async () => {
    const first = await setup();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: PASSWORD } });
    const second = cookieFrom(login);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...CSRF, cookie: second },
      payload: { currentPassword: PASSWORD, newPassword: 'another long passphrase' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: second } })).statusCode).toBe(200);
  });
});

describe('cross-site protection and headers', () => {
  it('blocks state changes without the app header or from another origin', async () => {
    const cookie = await setup();
    const noHeader = await app.inject({ method: 'POST', url: '/api/system/monitor', headers: { cookie } });
    expect(noHeader.statusCode).toBe(403);
    const otherSite = await app.inject({
      method: 'POST',
      url: '/api/system/monitor',
      headers: { ...CSRF, cookie, origin: 'https://evil.example', host: 'mediarr.example' },
    });
    expect(otherSite.statusCode).toBe(403);
  });

  it('sends security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    // Only YouTube's no-cookie player may be embedded (trailers).
    expect(res.headers['content-security-policy']).toContain("frame-src https://www.youtube-nocookie.com");
    expect(res.headers['content-security-policy']).not.toMatch(/frame-src[^;]*\*/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not let a forged X-Forwarded-For dodge the lockout from outside', async () => {
    await setup();
    for (let i = 0; i < 12; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': `10.0.0.${i}` },
        remoteAddress: '203.0.113.9', // not a trusted proxy
        payload: { username: `user${i}`, password: 'wrong password!!' },
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-for': '10.0.0.99' },
      remoteAddress: '203.0.113.9',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(res.statusCode).toBe(429);
  }, 30_000); // 13 deliberately slow password checks
});

describe('two-factor', () => {
  it('requires a fresh code once enabled', async () => {
    const cookie = await setup();
    const start = await app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: { ...CSRF, cookie }, payload: { password: PASSWORD } });
    const { secret, qr } = start.json() as { secret: string; qr: string };
    expect(qr).toMatch(/^data:image\/png;base64,/);
    const code = codeAt(secret, currentCounter() - 1); // previous window: still accepted
    expect((await app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: { ...CSRF, cookie }, payload: { code } })).statusCode).toBe(200);

    const noCode = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: PASSWORD } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json()).toMatchObject({ totpRequired: true });

    const replay = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: PASSWORD, code } });
    expect(replay.statusCode).toBe(401); // the code used to enable can't be reused

    const fresh = codeAt(secret, currentCounter());
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'owner', password: PASSWORD, code: fresh } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('primitives', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword('nope nope nope', h)).toBe(false);
  });

  it('matches the RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(codeAt(secret, 1)).toBe('287082'); // T=59s
    expect(verifyCode(secret, '287082', 59_000)).toBe(1);
    expect(verifyCode(secret, '000000', 59_000)).toBeNull();
  });
});

describe('multiple users and roles', () => {
  async function addUser(adminCookie: string, username: string, role: 'admin' | 'user') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { ...CSRF, cookie: adminCookie },
      payload: { username, password: `${PASSWORD} ${username}`.replace(username, 'x'), role },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { id: number };
  }
  async function loginAs(username: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { username, password: `${PASSWORD} ${username}`.replace(username, 'x') },
    });
    expect(res.statusCode, res.body).toBe(200);
    return cookieFrom(res);
  }

  it('the first account is an admin', async () => {
    const cookie = await setup();
    const status = (await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })).json();
    expect(status.user.role).toBe('admin');
  });

  it('a regular user is refused every admin-only route, and allowed the rest', async () => {
    const { USER_ALLOWED } = await import('./security.js');
    const admin = await setup();
    await addUser(admin, 'viewer', 'user');
    const user = await loginAs('viewer');
    // Logout would end this test's own session mid-loop; it has its own test.
    const api = routes.filter(
      (r) => r.url.startsWith('/api') && r.method !== 'HEAD' && !PUBLIC.has(`${r.method} ${r.url}`) && r.url !== '/api/auth/logout',
    );
    let refused = 0;
    for (const r of api) {
      const res = await app.inject({
        method: r.method as 'GET',
        url: r.url.replace(/:\w+/g, '999'),
        headers: { ...CSRF, cookie: user },
        payload: r.method === 'GET' ? undefined : {},
      });
      if (USER_ALLOWED.has(`${r.method} ${r.url}`)) {
        expect([401, 403], `${r.method} ${r.url} should be allowed`).not.toContain(res.statusCode);
      } else {
        expect(res.statusCode, `${r.method} ${r.url} should be admin-only`).toBe(403);
        refused++;
      }
    }
    // Settings changes, connection tests, user management, deleting media/downloads...
    expect(refused).toBeGreaterThanOrEqual(10);
  });

  it('regular users never see keys, URLs or folders', async () => {
    const admin = await setup();
    await app.inject({ method: 'PUT', url: '/api/settings', headers: { ...CSRF, cookie: admin }, payload: { prowlarrApiKey: 'secret-key', prowlarrUrl: 'http://10.0.0.5:9696' } });
    await addUser(admin, 'viewer', 'user');
    const user = await loginAs('viewer');
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: user } });
    expect(Object.keys(res.json())).toEqual(['defaultAnimeAudio']);
  });

  it('keeps at least one admin and never deletes yourself', async () => {
    const admin = await setup();
    const me = (await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: admin } })).json().user.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${me}`, headers: { ...CSRF, cookie: admin } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me}`, headers: { ...CSRF, cookie: admin }, payload: { role: 'user' } })).statusCode).toBe(400);

    const second = await addUser(admin, 'second', 'admin');
    const secondCookie = await loginAs('second');
    // The other admin can demote/delete the first now that there are two...
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me}`, headers: { ...CSRF, cookie: secondCookie }, payload: { role: 'user' } })).statusCode).toBe(200);
    // ...but not leave zero admins.
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${second.id}`, headers: { ...CSRF, cookie: secondCookie } })).statusCode).toBe(400);
  });

  it('an admin password reset signs that user out everywhere', async () => {
    const admin = await setup();
    const viewer = await addUser(admin, 'viewer', 'user');
    const userCookie = await loginAs('viewer');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${viewer.id}`,
      headers: { ...CSRF, cookie: admin },
      payload: { password: 'a brand new passphrase' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/media', headers: { cookie: userCookie } })).statusCode).toBe(401);
  });

  it('deleting a user ends their sessions', async () => {
    const admin = await setup();
    const viewer = await addUser(admin, 'viewer', 'user');
    const userCookie = await loginAs('viewer');
    await app.inject({ method: 'DELETE', url: `/api/users/${viewer.id}`, headers: { ...CSRF, cookie: admin } });
    expect((await app.inject({ method: 'GET', url: '/api/media', headers: { cookie: userCookie } })).statusCode).toBe(401);
  });
});
