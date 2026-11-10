import { db, logHistory, type MediaRow } from '../db.js';
import { getSettings } from '../settings.js';
import { pollDownloads } from './downloads.js';
import { autoSearch } from './grabber.js';
import { refreshMedia } from './library.js';

const REFRESH_MS = 12 * 3600_000;

let monitorRunning = false;
let pollRunning = false;

export async function runMonitor(): Promise<{ searched: number; grabs: number }> {
  if (monitorRunning) return { searched: 0, grabs: 0 };
  monitorRunning = true;
  let searched = 0;
  let grabs = 0;
  try {
    // Series are always checked: requested episodes that failed earlier are retried even when the
    // series doesn't watch for new episodes. Movies are only re-searched while monitored (autoSearch checks).
    const items = db.prepare('SELECT * FROM media').all() as unknown as MediaRow[];
    for (const m of items) {
      try {
        if (!m.last_refresh || Date.now() - new Date(m.last_refresh).getTime() > REFRESH_MS) await refreshMedia(m.id);
        searched++;
        grabs += await autoSearch(m.id);
      } catch (err) {
        logHistory(m.id, 'failed', `Monitor failed for ${m.title}: ${(err as Error).message}`);
      }
    }
  } finally {
    monitorRunning = false;
  }
  return { searched, grabs };
}

async function safePoll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    await pollDownloads();
  } catch (err) {
    console.warn(`[poll] ${(err as Error).message}`);
  } finally {
    pollRunning = false;
  }
}

export function startScheduler() {
  setInterval(safePoll, 30_000);
  setTimeout(safePoll, 3_000);

  const scheduleMonitor = () => {
    const minutes = Math.max(5, getSettings().monitorIntervalMinutes || 30);
    setTimeout(async () => {
      try {
        await runMonitor();
      } catch (err) {
        console.warn(`[monitor] ${(err as Error).message}`);
      }
      scheduleMonitor();
    }, minutes * 60_000);
  };
  // First pass shortly after startup, then on the configured interval.
  setTimeout(() => runMonitor().catch((err) => console.warn(`[monitor] ${err.message}`)), 60_000);
  scheduleMonitor();
}
