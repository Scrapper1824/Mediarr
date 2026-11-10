// `npm start`: on Windows, start Mediarr in the background with its system tray icon
// (no console window; right-click the tray icon to open, stop, restart or quit).
// Elsewhere there's no tray, so the server runs in this terminal like `npm run console`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const server = path.join(root, 'server', 'dist', 'index.js');

if (!fs.existsSync(server)) {
  console.error("Mediarr isn't built yet. Run `npm run build` first, then `npm start`.");
  process.exit(1);
}

if (process.platform === 'win32') {
  const launcher = path.join(root, 'tray', 'Mediarr.vbs');
  // Detached so the tray keeps running after this command (and its terminal) exits.
  // The tray itself makes sure only one copy runs per port.
  spawn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const port = process.env.PORT ?? '7979';
  console.log(`Mediarr is starting in the background: http://localhost:${port}`);
  console.log('Look for the orange M in the system tray (by the clock) to open, stop, restart or quit it.');
  console.log('To see live output in this window instead, use: npm run console');
} else {
  const child = spawn(process.execPath, [server], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
}
