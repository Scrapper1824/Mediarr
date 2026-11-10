import { describe, expect, it } from 'vitest';
import { getAutostart, setAutostart, startupCommand, TRAY_LAUNCHER } from './autostart.js';

/** In-memory stand-in for reg.exe, so tests never touch the real registry. */
function fakeReg() {
  const values = new Map<string, string>();
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const [op, , , name] = args;
    if (op === 'query') {
      if (!values.has(name)) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      return { stdout: `\r\n    ${name}    REG_SZ    ${values.get(name)}\r\n` };
    }
    if (op === 'add') {
      values.set(name, args[args.indexOf('/d') + 1]);
      return { stdout: 'The operation completed successfully.' };
    }
    if (op === 'delete') {
      if (!values.delete(name)) throw new Error('not found');
      return { stdout: '' };
    }
    throw new Error('unexpected ' + op);
  };
  return { runner, values, calls };
}

describe('start with Windows', () => {
  it('launches the hidden tray launcher of this install', () => {
    expect(TRAY_LAUNCHER).toMatch(/[\\/]tray[\\/]Mediarr\.vbs$/);
    expect(startupCommand()).toBe(`wscript.exe "${TRAY_LAUNCHER}"`);
  });

  it('turns on and off through the per-user Run key', async () => {
    const reg = fakeReg();
    expect(await getAutostart(reg.runner)).toBe(false);
    expect(await setAutostart(true, reg.runner)).toBe(true);
    expect(reg.values.get('Mediarr')).toBe(startupCommand());
    // Per-user key only: no admin rights, other accounts unaffected.
    expect(reg.calls.find((c) => c[0] === 'add')?.[1]).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(await setAutostart(false, reg.runner)).toBe(false);
    expect(await setAutostart(false, reg.runner)).toBe(false); // turning off twice is fine
  });

  it('does not count an entry pointing at another copy of Mediarr', async () => {
    const reg = fakeReg();
    reg.values.set('Mediarr', 'wscript.exe "D:\\Old\\Mediarr\\tray\\Mediarr.vbs"');
    expect(await getAutostart(reg.runner)).toBe(false);
  });
});
