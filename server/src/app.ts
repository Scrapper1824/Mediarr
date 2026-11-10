import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { authRoutes } from './auth/routes.js';
import { registerSecurity } from './auth/security.js';
import { userRoutes } from './auth/users.js';
import { apiRoutes } from './routes/api.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { playRoutes } from './routes/play.js';
import { usePlaybackDataDir } from './playback/ffmpeg.js';
import { startPlayback, stopPlayback } from './playback/sessions.js';
import { useSecretDir } from './auth/secretBox.js';

/**
 * Which proxies may tell us the real client IP / https (X-Forwarded-*). Defaults to this machine only,
 * which covers Nginx Proxy Manager or cloudflared running on the same PC. Set TRUST_PROXY to the proxy's
 * IP (or a CIDR like 172.16.0.0/12 for Docker) if it runs elsewhere. Never trust everyone: the headers
 * could then be forged to dodge the login lockout.
 */
function trustProxy(): boolean | string {
  const v = process.env.TRUST_PROXY?.trim();
  if (!v) return 'loopback';
  if (v === 'false') return false;
  return v;
}

export async function buildApp(opts: {
  dataDir: string;
  webDist?: string | null;
  logLevel?: string;
  /** Tests pass an array to get every registered route (to check none is reachable without login). */
  routes?: { method: string; url: string }[];
}) {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? 'warn',
      // Running hidden from the tray there's no console, so the tray points this at data\mediarr.log.
      ...(process.env.MEDIARR_LOG_FILE ? { file: process.env.MEDIARR_LOG_FILE } : {}),
    },
    trustProxy: trustProxy(),
    bodyLimit: 1024 * 1024,
  });
  if (opts.routes) {
    app.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) opts.routes!.push({ method, url: r.url });
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.message });
  });

  useSecretDir(opts.dataDir);
  usePlaybackDataDir(opts.dataDir);
  startPlayback();
  app.addHook('onClose', async () => stopPlayback());

  // Must come first: it guards every route registered below.
  registerSecurity(app);
  await app.register(authRoutes, { dataDir: opts.dataDir });
  await app.register(userRoutes);
  await app.register(apiRoutes);
  await app.register(watchlistRoutes);
  await app.register(playRoutes);

  const webDist = opts.webDist === undefined ? path.resolve(import.meta.dirname, '../../web/dist') : opts.webDist;
  if (webDist && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }
  // Client-side routing: unknown non-API paths get the web app (which then shows the login screen).
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || !webDist || !fs.existsSync(webDist)) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
  return app;
}
