import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ABSOLUTE_MS, SESSION_COOKIE, userForSession, type UserRow } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionToken: string | undefined;
  }
}

/** The only API routes reachable without signing in. Everything else under /api needs a session. */
export const PUBLIC_API = new Set(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/setup']);

/**
 * What regular (non-admin) users may do: browse, request, search, choose bundles, see the queue/history,
 * and manage their own sign-in. Everything not listed is admin-only, so routes added later stay locked
 * to admins until they're deliberately opened up here.
 */
export const USER_ALLOWED = new Set([
  'GET /api/auth/status',
  'POST /api/auth/logout',
  'POST /api/auth/logout-others',
  'POST /api/auth/password',
  'POST /api/auth/totp/setup',
  'POST /api/auth/totp/enable',
  'POST /api/auth/totp/disable',
  'GET /api/status',
  'GET /api/settings', // non-admins only get the request defaults, never keys/URLs/folders
  'GET /api/discover/search',
  'GET /api/discover/browse',
  'GET /api/discover/info',
  'GET /api/discover/details',
  'GET /api/discover/availability',
  'GET /api/discover/filter',
  'GET /api/discover/genres',
  'GET /api/media',
  'GET /api/media/:id',
  'POST /api/media',
  'PATCH /api/media/:id',
  'POST /api/media/:id/refresh',
  'PATCH /api/media/:id/seasons/:season',
  'PATCH /api/episodes/:id',
  'POST /api/media/:id/search',
  'GET /api/media/:id/releases',
  'POST /api/media/:id/grab',
  'POST /api/suggestions/:id/accept',
  'POST /api/suggestions/:id/dismiss',
  // Requests that wait for an admin: users see (and can withdraw) their own.
  'GET /api/requests',
  'DELETE /api/requests/:id',
  'GET /api/queue',
  'GET /api/history',
  'GET /api/search-events',
  // Watchlists: each user manages only their own (the routes use req.user, never an id from the client).
  'GET /api/watchlist/links',
  'POST /api/watchlist/simkl/start',
  'POST /api/watchlist/simkl/poll',
  'POST /api/watchlist/anilist',
  'DELETE /api/watchlist/links/:service',
  'GET /api/watchlist',
  'GET /api/watchlist/item',
  'PUT /api/watchlist/item',
  'DELETE /api/watchlist/item',
  // Watching: anyone signed in can play what's in the library (files are looked up by id, never by path).
  'GET /api/play/:kind/:id/info',
  'POST /api/play/:kind/:id/start',
  'GET /api/play/direct/:kind/:id',
  'GET /api/play/hls/:session/:file',
  'DELETE /api/play/hls/:session',
  'GET /api/play/:kind/:id/subtitle/:track',
  'GET /api/play/:kind/:id/fonts',
  'GET /api/play/:kind/:id/extras',
  'GET /api/play/:kind/:id/trickplay/:sheet',
  'GET /api/play/:kind/:id/fonts/:name',
  'PUT /api/play/:kind/:id/progress',
  'GET /api/play/progress/:mediaId',
  'PUT /api/media/:id/watched',
  'GET /api/continue',
  'GET /api/home',
]);

/**
 * Things that start (or will start) downloads. A user whose requests need approval can't do them;
 * adding a title (POST /api/media) still works for them, but becomes a request for an admin.
 */
export const NEEDS_ADMIN_OK = new Set([
  'PATCH /api/media/:id',
  'PATCH /api/media/:id/seasons/:season',
  'PATCH /api/episodes/:id',
  'POST /api/media/:id/search',
  'POST /api/media/:id/grab',
  'POST /api/suggestions/:id/accept',
]);

/** True when this user's requests wait for an admin. */
export const needsApproval = (u: { role: string; needs_approval?: number } | null | undefined) => !!u && u.role !== 'admin' && !!u.needs_approval;

/** Header the web app sends on every request that changes something; other sites can't set it (no CORS). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'mediarr';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req: FastifyRequest) => process.env.COOKIE_SECURE === 'true' || req.protocol === 'https';

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`];
  if (isHttps(req)) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

/** Origin of a URL, or null when it's missing/unparseable. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the subtitle renderer (libass compiled to WebAssembly) run; inline scripts stay blocked.
  "script-src 'self' 'wasm-unsafe-eval'",
  // Inline style attributes are used for progress bars; no inline scripts are allowed.
  "style-src 'self' 'unsafe-inline'",
  // Posters come from TMDB/AniList over HTTPS; the favicon is a data: SVG.
  "img-src 'self' data: https:",
  "connect-src 'self'",
  // The player streams through blob: URLs (Media Source) and runs the subtitle renderer in a worker.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Trailers play in YouTube's privacy-enhanced (no-cookie) player; no other site may be framed.
  'frame-src https://www.youtube-nocookie.com',
].join('; ');

export function registerSecurity(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', undefined);

  app.addHook('onRequest', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.sessionToken = token;
    req.user = userForSession(token);

    // Decide by the route that actually matched (the router decodes URLs, so "/%61pi/media" reaches
    // /api/media), and also by the decoded path for unmatched requests. Anything API-like needs a session.
    const route = req.routeOptions.url;
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.url.split('?')[0]).toLowerCase();
    } catch {
      return reply.code(400).send({ error: 'Bad request' });
    }
    const isApi = route?.startsWith('/api') || decoded.replace(/\/+/g, '/').startsWith('/api');
    if (!isApi) return; // the web app's files (no data in them)
    const path = route ?? decoded;

    // Cross-site request protection for anything that changes state.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return reply.code(403).send({ error: 'Missing request header' });
      const origin = hostOf(req.headers.origin as string | undefined) ?? hostOf(req.headers.referer);
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
      if (origin && host && origin !== host) return reply.code(403).send({ error: 'Cross-site request blocked' });
    }

    const key = `${req.method} ${path}`;
    if (!req.user) {
      if (!PUBLIC_API.has(key)) return reply.code(401).send({ error: 'Not signed in' });
      return;
    }
    if (req.user.role !== 'admin' && !USER_ALLOWED.has(key)) {
      return reply.code(403).send({ error: 'Only an admin can do that.' });
    }
    if (needsApproval(req.user) && NEEDS_ADMIN_OK.has(key)) {
      return reply.code(403).send({ error: 'Your requests need an admin’s approval, so you can’t start downloads yourself. Ask an admin.' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    if (isHttps(req)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Never cache API responses (they may hold private data) in the browser or a proxy.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}
