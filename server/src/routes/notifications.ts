import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { dismiss, isPartyActive, listNotifications, markRead, unreadCount } from '../core/notifications.js';

/** The signed-in user's own notifications, plus the list of accounts a title can be shared with. */
export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    const userId = req.user!.id;
    const items = listNotifications(userId).map((n) => ({
      ...n,
      ...(n.kind === 'party_invite' ? { active: isPartyActive(n.payload.partyId) } : {}),
    }));
    return { unread: unreadCount(userId), items };
  });

  app.post<{ Body: { ids?: unknown } }>('/api/notifications/read', async (req, reply) => {
    const ids = req.body?.ids;
    const valid = ids === 'all' || (Array.isArray(ids) && ids.length <= 500 && ids.every((n) => Number.isInteger(n)));
    if (!valid) return reply.code(400).send({ error: 'Bad request' });
    markRead(req.user!.id, ids as number[] | 'all');
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !dismiss(req.user!.id, id)) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });

  app.get<{ Querystring: { mediaId?: string } }>('/api/party/invitees', async (req, reply) => {
    const mediaId = Number(req.query.mediaId);
    const media = Number.isInteger(mediaId)
      ? (db.prepare('SELECT adult FROM media WHERE id = ?').get(mediaId) as { adult: number } | undefined)
      : undefined;
    // An 18+ title you may not see doesn't exist as far as you're concerned.
    if (!media || (media.adult && !req.user!.allow_adult)) return reply.code(404).send({ error: 'Not found' });
    const rows = db
      .prepare('SELECT id, username FROM users WHERE id != ? AND (? = 0 OR allow_adult = 1) ORDER BY username COLLATE NOCASE')
      .all(req.user!.id, media.adult ? 1 : 0);
    return rows;
  });
}
