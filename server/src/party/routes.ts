import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lockedFor, recordFailure } from '../auth/rateLimit.js';
import type { UserRow } from '../auth/sessions.js';
import { isHttps } from '../auth/security.js';
import { notify } from '../core/notifications.js';
import { db, getMedia, type EpisodeRow, type MediaRow } from '../db.js';
import { clearGuestCookie, cleanGuestName, guestCookie } from './guest.js';
import type { Party, Title } from './state.js';
import {
  addGuest, createParty, endParty, findParty, getParty, guestCount, guestInviteCode, inviteCodeMatches,
  leaveParty, markInvited, MAX_GUESTS,
} from './store.js';

interface Resolved {
  media: MediaRow;
  episode: EpisodeRow | null;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found' });

/** The library title behind a party title, or null. */
function resolve(t: Title): Resolved | null {
  if (t.kind === 'movie') {
    const media = getMedia(t.id);
    return media && media.type === 'movie' ? { media, episode: null } : null;
  }
  const episode = (db.prepare('SELECT * FROM episodes WHERE id = ?').get(t.id) as EpisodeRow | undefined) ?? null;
  const media = episode ? getMedia(episode.media_id) : undefined;
  return media && episode ? { media, episode } : null;
}

const mayWatch = (user: UserRow, media: MediaRow) => !media.adult || !!user.allow_adult;

const subtitleOf = (e: EpisodeRow | null) =>
  e ? `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}` : null;

/** A party the signed-in user may see (it exists and they may watch its title). */
function partyForUser(req: FastifyRequest, id: string, includeEnded = false): { party: Party; r: Resolved } | null {
  const party = includeEnded ? findParty(id) : getParty(id);
  const r = party ? resolve(party.title) : null;
  if (!party || !r || !req.user || !mayWatch(req.user, r.media)) return null;
  return { party, r };
}

export async function partyRoutes(app: FastifyInstance) {
  app.post<{ Body: { kind?: unknown; id?: unknown; position?: unknown } }>('/api/party', async (req, reply) => {
    const { kind, id } = req.body ?? {};
    if ((kind !== 'movie' && kind !== 'episode') || !Number.isInteger(id) || (id as number) <= 0) return reply.code(400).send({ error: 'Bad request' });
    const title: Title = { kind, id: id as number };
    const r = resolve(title);
    if (!r || !mayWatch(req.user!, r.media)) return notFound(reply);
    const raw = Number(req.body?.position);
    const position = Number.isFinite(raw) ? Math.min(Math.max(0, raw), 1e6) : 0;
    const p = createParty({ type: 'user', userId: req.user!.id, name: req.user!.username }, r.media.id, title, position);
    return { id: p.id, url: `/party/${p.id}` };
  });

  app.get<{ Params: { id: string } }>('/api/party/:id', async (req, reply) => {
    let found: { party: Party; r: Resolved } | null;
    if (req.guest) {
      // A guest only ever sees their own (running) party.
      const party = req.guest.partyId === req.params.id ? getParty(req.params.id) : null;
      const r = party ? resolve(party.title) : null;
      found = party && r ? { party, r } : null;
    } else {
      found = partyForUser(req, req.params.id, true);
    }
    if (!found) return notFound(reply);
    const { party, r } = found;
    return {
      id: party.id,
      title: party.title,
      mediaId: party.mediaId,
      titleLabel: r.media.title,
      subtitle: subtitleOf(r.episode),
      poster: r.media.poster,
      hostUserId: party.hostUserId,
      isHost: req.user?.id === party.hostUserId,
      guestInviteAllowed: !!req.user && !r.media.adult,
      members: [...party.members.entries()].map(([key, m]) => ({
        key,
        name: m.principal.name,
        connected: m.connected > 0,
        buffering: m.buffering !== null,
      })),
      state: party.state,
      ended: party.ended,
    };
  });

  app.post<{ Params: { id: string }; Body: { userIds?: unknown } }>('/api/party/:id/invite', async (req, reply) => {
    const ids = req.body?.userIds;
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((n) => Number.isInteger(n))) return reply.code(400).send({ error: 'Bad request' });
    const found = partyForUser(req, req.params.id);
    if (!found) return notFound(reply);
    const { party, r } = found;
    const wanted = [...new Set(ids as number[])].filter((uid) => uid !== req.user!.id);
    const allowed = wanted.filter((uid) => {
      const u = db.prepare('SELECT allow_adult FROM users WHERE id = ?').get(uid) as { allow_adult: number } | undefined;
      return !!u && (!r.media.adult || !!u.allow_adult);
    });
    const payload = { partyId: party.id, from: req.user!.username, title: r.media.title, subtitle: subtitleOf(r.episode), poster: r.media.poster };
    for (const uid of markInvited(party, allowed)) notify(uid, 'party_invite', payload);
    return { invited: allowed };
  });

  app.post<{ Params: { id: string } }>('/api/party/:id/guest-link', async (req, reply) => {
    const found = partyForUser(req, req.params.id);
    if (!found) return notFound(reply);
    if (found.r.media.adult) return reply.code(403).send({ error: 'Guest links can’t be made for 18+ titles.' });
    // The code goes after "#", so it never reaches a server's logs.
    return { url: `/party/${found.party.id}/guest#${guestInviteCode(found.party)}` };
  });

  app.post<{ Params: { id: string }; Body: { code?: unknown; name?: unknown } }>('/api/party/:id/guest-join', async (req, reply) => {
    if (req.user) return reply.code(403).send({ error: 'You’re signed in: open the party link instead.' });
    const code = req.body?.code;
    if (typeof code !== 'string' || code.length > 200) return reply.code(400).send({ error: 'Bad request' });
    // Party ids are 32 hex characters; anything else shares one bucket (so junk ids can't grow the map).
    const limitKey = /^[0-9a-f]{32}$/.test(req.params.id) ? `party:${req.params.id}` : 'party:?';
    const wait = lockedFor(req.ip, limitKey);
    if (wait > 0) return reply.code(429).send({ error: `Too many tries. Try again in ${Math.ceil(wait / 60)} min.` });
    const party = getParty(req.params.id);
    if (!party) {
      recordFailure(req.ip, limitKey);
      return reply.code(404).send({ error: 'This watch party has ended.' });
    }
    const r = resolve(party.title);
    if (!inviteCodeMatches(party, code) || !r || r.media.adult) {
      recordFailure(req.ip, limitKey);
      return reply.code(403).send({ error: 'This guest link isn’t valid.' });
    }
    // Already in this party in this browser: nothing to do.
    if (req.guest?.partyId === party.id) return { ok: true };
    if (guestCount(party) >= MAX_GUESTS) return reply.code(403).send({ error: 'This watch party is full.' });
    party.nextGuestNumber += 1; // the host is 1, so the first guest is "Guest 2"
    const name = cleanGuestName(req.body?.name, `Guest ${party.nextGuestNumber}`);
    const { cookie } = addGuest(party, name);
    reply.header('set-cookie', guestCookie(cookie, isHttps(req)));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/party/:id/end', async (req, reply) => {
    const found = partyForUser(req, req.params.id);
    if (!found) return notFound(reply);
    if (found.party.hostUserId !== req.user!.id) return reply.code(403).send({ error: 'Only the host can end the party.' });
    endParty(found.party.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/party/:id/leave', async (req, reply) => {
    if (req.guest) {
      const party = req.guest.partyId === req.params.id ? getParty(req.params.id) : null;
      if (!party) return notFound(reply);
      leaveParty(party, { type: 'guest', guestId: req.guest.guestId, name: req.guest.name });
      reply.header('set-cookie', clearGuestCookie(isHttps(req)));
      return { ok: true };
    }
    const found = partyForUser(req, req.params.id);
    if (!found) return notFound(reply);
    leaveParty(found.party, { type: 'user', userId: req.user!.id, name: req.user!.username });
    return { ok: true };
  });
}
