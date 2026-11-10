import type { FastifyInstance, FastifyReply } from 'fastify';
import * as anilist from '../clients/anilist.js';
import * as simkl from '../clients/simkl.js';
import type { MediaType } from '../db.js';
import { getSettings } from '../settings.js';
import {
  disconnect,
  getLink,
  saveSimkl,
  simklApp,
  removeTitle,
  saveLink,
  SERVICES,
  servicesFor,
  setStatus,
  WATCH_STATUSES,
  watchlistFor,
  type Service,
  type WatchStatus,
} from '../core/watchlist.js';

const TYPES: MediaType[] = ['movie', 'show', 'anime'];
/** AniList shows the token on this page; register it as the AniList app's redirect URL. */
export const ANILIST_REDIRECT = 'https://anilist.co/api/v2/oauth/pin';

/** Simkl sign-ins waiting for the user to approve them, per user. The device code stays on the server. */
const pending = new Map<number, { device: simkl.SimklDevice; expires: number; interval: number; lastPoll: number }>();

function parseTitle(type: unknown, id: unknown, reply: FastifyReply): { type: MediaType; id: number } | null {
  const n = Number(id);
  if (!TYPES.includes(type as MediaType) || !Number.isInteger(n) || n <= 0) {
    reply.code(400).send({ error: 'Bad request' });
    return null;
  }
  return { type: type as MediaType, id: n };
}

/**
 * Each user's own Simkl / AniList watchlists. Every route works on the signed-in user only
 * (req.user), and access tokens never leave the server.
 */
export async function watchlistRoutes(app: FastifyInstance) {
  app.get('/api/watchlist/links', async (req) => {
    const s = getSettings();
    const userId = req.user!.id;
    const info = (service: Service, configured: boolean) => {
      const link = configured ? getLink(userId, service) : null;
      return { configured, connected: !!link, account: link?.accountName ?? null };
    };
    return {
      simkl: info('simkl', !!s.simklClientId),
      anilist: {
        ...info('anilist', !!s.anilistClientId),
        authorizeUrl: s.anilistClientId
          ? `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(s.anilistClientId)}&response_type=token`
          : null,
      },
    };
  });

  app.post('/api/watchlist/simkl/start', async (req, reply) => {
    const app = simklApp();
    if (!app.clientId) return reply.code(400).send({ error: 'Simkl isn’t set up yet. Ask your admin.' });
    const device = await simkl.deviceStart(app);
    pending.set(req.user!.id, { device, expires: Date.now() + device.expiresIn * 1000, interval: device.interval, lastPoll: Date.now() });
    return {
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
      verificationUrlComplete: device.verificationUrlComplete,
      interval: device.interval,
    };
  });

  app.post('/api/watchlist/simkl/poll', async (req, reply) => {
    const app = simklApp();
    const p = pending.get(req.user!.id);
    if (!app.clientId || !p) return reply.code(400).send({ error: 'Start connecting Simkl first.' });
    if (Date.now() > p.expires) {
      pending.delete(req.user!.id);
      return { status: 'expired' };
    }
    // Never ask Simkl faster than it allows, however often the page asks.
    if (Date.now() - p.lastPoll < p.interval * 1000) return { status: 'waiting', interval: p.interval };
    p.lastPoll = Date.now();
    const r = await simkl.devicePoll(app, p.device);
    if (r.status === 'slow_down') p.interval += 5;
    if (r.status === 'waiting' || r.status === 'slow_down') return { status: 'waiting', interval: p.interval };
    pending.delete(req.user!.id);
    if (r.status === 'expired') return { status: 'expired' };
    saveSimkl(req.user!.id, r.tokens, await simkl.accountName(app.clientId, r.tokens.access));
    return { status: 'connected' };
  });

  app.post<{ Body: { token?: string } }>('/api/watchlist/anilist', async (req, reply) => {
    if (!getSettings().anilistClientId) return reply.code(400).send({ error: 'AniList isn’t set up yet. Ask your admin.' });
    const token = String(req.body?.token ?? '').trim();
    if (!/^[\w.-]{20,4000}$/.test(token)) return reply.code(400).send({ error: 'That doesn’t look like an AniList token. Copy the whole token AniList shows you.' });
    let who: { id: number; name: string };
    try {
      who = await anilist.viewer(token);
    } catch {
      return reply.code(400).send({ error: 'AniList didn’t accept that token. Try connecting again.' });
    }
    saveLink(req.user!.id, 'anilist', token, String(who.id), who.name);
    return { status: 'connected', account: who.name };
  });

  app.delete<{ Params: { service: string } }>('/api/watchlist/links/:service', async (req, reply) => {
    const service = req.params.service as Service;
    if (!SERVICES.includes(service)) return reply.code(400).send({ error: 'Unknown service' });
    await disconnect(req.user!.id, service);
    return { ok: true };
  });

  app.get('/api/watchlist', async (req) => watchlistFor(req.user!.id));

  app.get<{ Querystring: { type?: string; id?: string } }>('/api/watchlist/item', async (req, reply) => {
    const t = parseTitle(req.query.type, req.query.id, reply);
    if (!t) return;
    const services = servicesFor(req.user!.id, t.type);
    if (!services.length) return { services, item: null };
    const { items } = await watchlistFor(req.user!.id);
    const item = items.find((i) => i.key === `${t.type}:${t.id}`) ?? null;
    return { services, item };
  });

  app.put<{ Body: { type?: string; id?: number; status?: string } }>('/api/watchlist/item', async (req, reply) => {
    const t = parseTitle(req.body?.type, req.body?.id, reply);
    if (!t) return;
    const status = req.body?.status as WatchStatus;
    if (!WATCH_STATUSES.includes(status)) return reply.code(400).send({ error: 'Unknown status' });
    return setStatus(req.user!.id, t.type, t.id, status);
  });

  app.delete<{ Querystring: { type?: string; id?: string } }>('/api/watchlist/item', async (req, reply) => {
    const t = parseTitle(req.query.type, req.query.id, reply);
    if (!t) return;
    return removeTitle(req.user!.id, t.type, t.id);
  });
}
