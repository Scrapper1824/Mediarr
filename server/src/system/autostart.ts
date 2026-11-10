import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * "Start when I log in to Windows": a per-user entry under HKCU\...\Run (no admin rights needed)
 * that launches the tray, which starts Mediarr hidden. The system tray menu toggles the same entry.
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'Mediarr';

/** Project root (this file is server/src/system or server/dist/system). */
const ROOT = path.resolve(import.meta.dirname, '../../..');
export const TRAY_LAUNCHER = path.join(ROOT, 'tray', 'Mediarr.vbs');

/** The exact command stored in the Run key. */
export function startupCommand(launcher = TRAY_LAUNCHER): string {
  return `wscript.exe "${launcher}"`;
}

export const autostartSupported = () => process.platform === 'win32';

/** Runs reg.exe with fixed arguments (no shell, nothing from the request goes into the command). */
type RegRunner = (args: string[]) => Promise<{ stdout: string }>;
const reg: RegRunner = (args) => run('reg.exe', args, { windowsHide: true });

export async function getAutostart(runner: RegRunner = reg): Promise<boolean> {
  if (!autostartSupported() && runner === reg) return false;
  try {
    const { stdout } = await runner(['query', RUN_KEY, '/v', VALUE_NAME]);
    // Only counts if it points at this install's launcher (an old copy elsewhere isn't "on").
    return stdout.toLowerCase().includes(TRAY_LAUNCHER.toLowerCase());
  } catch {
    return false; // reg.exe exits non-zero when the value doesn't exist
  }
}

export async function setAutostart(enabled: boolean, runner: RegRunner = reg): Promise<boolean> {
  if (!autostartSupported() && runner === reg) throw new Error('Starting with the computer is only supported on Windows.');
  if (enabled) {
    await runner(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', startupCommand(), '/f']);
  } else {
    try {
      await runner(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
    } catch {
      // already off
    }
  }
  return getAutostart(runner);
}
