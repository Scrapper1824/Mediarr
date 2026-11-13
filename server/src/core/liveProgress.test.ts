import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db.js';
import { saveSettings } from '../settings.js';
import { withLiveProgress } from './downloads.js';

beforeEach(() => {
  initDb(':memory:');
  saveSettings({ qbitUrl: 'http://qbit.test:8080', qbitUsername: 'admin', qbitPassword: 'pw' });
});
afterEach(() => vi.unstubAllGlobals());

const row = (tag: string, state: 'downloading' | 'imported' | 'queued', progress: number) => ({ id: 1, tag, state, progress });

describe('download progress on the Downloads page', () => {
  it('comes live from qBittorrent, with speed and time left', async () => {
    let torrentCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/auth/login')) return new Response('Ok.');
      torrentCalls++;
      return Response.json([
        { hash: 'a', name: 'A', progress: 0.91, state: 'downloading', save_path: 'D:/x', tags: 'mediarr-1', category: 'mediarr', size: 1, dlspeed: 5_000_000, eta: 120 },
        { hash: 'b', name: 'B', progress: 0.2, state: 'stalledDL', save_path: 'D:/x', tags: 'mediarr-2,other', category: 'mediarr', size: 1, dlspeed: 0, eta: 8640000 },
      ]);
    });
    const rows = await withLiveProgress([row('mediarr-1', 'downloading', 0.77), row('mediarr-2', 'queued', 0), row('mediarr-3', 'imported', 1)]);
    expect(rows[0]).toMatchObject({ progress: 0.91, speed: 5_000_000, eta: 120 });
    // Unknown ETA (qBittorrent's "100 days") is shown as no ETA.
    expect(rows[1]).toMatchObject({ progress: 0.2, speed: 0, eta: null });
    expect(rows[2]).toEqual(row('mediarr-3', 'imported', 1));
    // Asked again right away (another open tab): qBittorrent isn't asked twice.
    await withLiveProgress([row('mediarr-1', 'downloading', 0.77)]);
    expect(torrentCalls).toBe(1);
  });

  it('shows what was last stored when qBittorrent can\'t be reached, and skips it when nothing is downloading', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      throw new Error('connection refused');
    });
    expect(await withLiveProgress([row('mediarr-9', 'imported', 1)])).toEqual([row('mediarr-9', 'imported', 1)]);
    expect(called).toBe(false);
    await new Promise((r) => setTimeout(r, 2100)); // past the 2 s reuse window from the test above
    expect(await withLiveProgress([row('mediarr-9', 'downloading', 0.5)])).toEqual([row('mediarr-9', 'downloading', 0.5)]);
  });
});
