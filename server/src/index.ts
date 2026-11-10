import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { prepareSetupCode, setupCodePath } from './auth/routes.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { defaultDbPath, initDb } from './db.js';
import { startScheduler } from './core/monitor.js';
import { queueLibraryWork } from './playback/jobs.js';
import { startUpdateChecks } from './system/updater.js';

// Started hidden from the tray there's no console: send console output to the log file as well.
if (process.env.MEDIARR_LOG_FILE) {
  const logFile = process.env.MEDIARR_LOG_FILE;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const line = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line}\n`);
      } catch {
        // never let logging take the server down
      }
    };
  }
}

const PORT = Number(process.env.PORT ?? 7979);
const HOST = process.env.HOST ?? '0.0.0.0';

const dbPath = defaultDbPath();
const dataDir = path.dirname(dbPath);
initDb(dbPath);

const app = await buildApp({ dataDir });

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 3600_000).unref();
startScheduler();
// Once Mediarr has settled, make previews / find intros for anything in the library that hasn't had them.
setTimeout(() => queueLibraryWork(), 60_000).unref();
// New releases on GitHub show up as "Update available" for admins.
startUpdateChecks(path.join(dataDir, 'update.log'));
await app.listen({ port: PORT, host: HOST });
console.log(`Mediarr running at http://localhost:${PORT}`);

const code = prepareSetupCode(dataDir);
if (code) {
  console.log('');
  console.log('  No account yet. Open Mediarr in your browser to create one.');
  console.log(`  Setup code: ${code}`);
  console.log(`  (also saved in ${setupCodePath(dataDir)})`);
  console.log('');
}
