import { describe, expect, it } from 'vitest';
import { invitesToPop, type NotificationItem } from './notifications';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const item = (id: number, over: Partial<NotificationItem> = {}, ageMs = 1000): NotificationItem => ({
  id,
  kind: 'party_invite',
  payload: { partyId: 'p', from: 'jacob', title: 'T', subtitle: null, poster: null },
  createdAt: new Date(NOW - ageMs).toISOString(),
  read: false,
  active: true,
  ...over,
});

describe('invitesToPop', () => {
  it('first load: only fresh unread active invites', () => {
    const r = invitesToPop([item(1), item(2, {}, 5 * 60_000), item(3, { read: true }), item(4, { active: false })], new Set(), true, NOW);
    expect(r.map((n) => n.id)).toEqual([1]);
  });
  it('later loads: any new unread active invite, however old', () => {
    const r = invitesToPop([item(1, {}, 10 * 60_000), item(2)], new Set(), false, NOW);
    expect(r.map((n) => n.id)).toEqual([1, 2]);
  });
  it('never pops one already seen', () => {
    expect(invitesToPop([item(1), item(2)], new Set([1]), false, NOW).map((n) => n.id)).toEqual([2]);
  });
  it('an unparseable date is not fresh', () => {
    expect(invitesToPop([item(1, { createdAt: 'nope' })], new Set(), true, NOW)).toEqual([]);
  });
});
