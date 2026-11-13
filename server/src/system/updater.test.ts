import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import { beginInstall, checkForUpdate, compareVersions, parseVersion, REPO, resetUpdater, updateInfo, useUpdaterDeps, type Runner } from './updater.js';

let root: string;
let calls: { file: string; args: string[]; input?: string }[];
let restarted: number;
let release: Record<string, unknown> | null;
let lastAuth: string | null;
let lastUrl: string | null;
/** Per-command overrides: "git merge" → failure, "npm build" → failure, "git status" → output. */
let behaviour: Record<string, { code?: number; stdout?: string; stderr?: string }>;

const key = (file: string, args: string[]) => {
  const tool = path.basename(file).startsWith('node') ? 'npm' : file;
  const sub = tool === 'npm' ? args.find((a) => ['ci', 'build'].includes(a)) : args[0];
  return `${tool} ${sub}`;
};

const fakeRun: Runner = async (file, args, opts) => {
  calls.push({ file, args, input: opts?.input });
  const k = key(file, args);
  const defaults: Record<string, { stdout: string }> = {
    'git status': { stdout: '' },
    'git rev-parse': { stdout: 'abc1234\n' },
  };
  const b = behaviour[k] ?? {};
  if (k === 'npm build' && !b.code) {
    // A real build replaces dist; make that visible.
    fs.writeFileSync(path.join(root, 'server', 'dist', 'index.js'), 'new build');
  }
  return { code: b.code ?? 0, stdout: b.stdout ?? defaults[k]?.stdout ?? '', stderr: b.stderr ?? '' };
};

beforeEach(() => {
  initDb(':memory:');
  resetUpdater();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-update-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mediarr', version: '0.1.0' }));
  for (const d of ['server/dist', 'web/dist']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, d, 'index.js'), 'old build');
  }
  calls = [];
  restarted = 0;
  behaviour = {};
  lastAuth = null;
  lastUrl = null;
  release = { tag_name: 'v0.2.0', name: 'Mediarr v0.2.0', body: '* Skip intro\n* Seek previews', html_url: 'https://github.com/x/y/releases/v0.2.0', published_at: '2026-11-10T00:00:00Z', draft: false, prerelease: false };
  useUpdaterDeps({
    root,
    run: fakeRun,
    restart: () => restarted++,
    logFile: null,
    fetch: (async (url: string, init?: RequestInit) => {
      lastUrl = url;
      lastAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
      return release ? new Response(JSON.stringify(release), { status: 200 }) : new Response('{}', { status: 404 });
    }) as typeof fetch,
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ranBefore = (a: string, b: string) => calls.findIndex((c) => key(c.file, c.args) === a) < calls.findIndex((c) => key(c.file, c.args) === b);
const settle = async () => {
  for (let i = 0; i < 100 && !['failed', 'restarting', 'done', 'idle'].includes(updateInfo().job.state); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('versions', () => {
  it('compares release versions properly', () => {
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(parseVersion('v2.0.0-beta.1')).toBeNull();
  });
});

describe('checking for updates', () => {
  it('offers a newer release from the public repository, without any sign-in', async () => {
    const info = await checkForUpdate();
    expect(info).toMatchObject({ current: '0.1.0', repo: 'Scrapper1824/Mediarr', available: true, error: null, latest: { version: '0.2.0' } });
    expect(lastUrl).toBe('https://api.github.com/repos/Scrapper1824/Mediarr/releases/latest');
    // Your GitHub sign-in is never read or sent.
    expect(lastAuth).toBeNull();
    expect(calls.some((c) => c.args[0] === 'credential' || c.args[0] === 'remote')).toBe(false);
  });

  it('is up to date when the release is not newer, and ignores drafts and pre-releases', async () => {
    release!.tag_name = 'v0.1.0';
    expect((await checkForUpdate()).available).toBe(false);
    release = { ...release!, tag_name: 'v0.3.0', prerelease: true };
    expect((await checkForUpdate()).available).toBe(false);
  });

  it('explains when there are no releases', async () => {
    release = null;
    expect((await checkForUpdate()).error).toMatch(/No releases/);
    expect(REPO).toBe('Scrapper1824/Mediarr');
  });
});

describe('installing an update', () => {
  it('fast-forwards to the release tag, reinstalls, rebuilds, then restarts', async () => {
    await checkForUpdate();
    beginInstall();
    await settle();
    expect(updateInfo().job.state).toBe('restarting');
    expect(calls.find((c) => c.args[0] === 'merge')!.args).toEqual(['merge', '--ff-only', 'v0.2.0']);
    // Downloaded from the public repository itself, whatever this copy's own remote is.
    expect(calls.find((c) => c.args[0] === 'fetch')!.args).toContain('https://github.com/Scrapper1824/Mediarr.git');
    expect(ranBefore('git fetch', 'git merge')).toBe(true);
    expect(ranBefore('git merge', 'npm ci')).toBe(true);
    expect(ranBefore('npm ci', 'npm build')).toBe(true);
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarted).toBe(1);
    expect(fs.existsSync(path.join(root, '.update-backup'))).toBe(false);
  });

  it('refuses to overwrite local changes', async () => {
    await checkForUpdate();
    behaviour['git status'] = { stdout: ' M server/src/app.ts\n' };
    beginInstall();
    await settle();
    expect(updateInfo().job).toMatchObject({ state: 'failed', error: expect.stringMatching(/local changes/) });
    expect(calls.some((c) => c.args[0] === 'merge')).toBe(false);
  });

  it('stops when this copy has diverged from the release', async () => {
    await checkForUpdate();
    behaviour['git merge'] = { code: 128, stderr: 'fatal: Not possible to fast-forward, aborting.' };
    beginInstall();
    await settle();
    expect(updateInfo().job.error).toMatch(/its own changes/);
    expect(restarted).toBe(0);
  });

  it('puts the previous version back when the build fails', async () => {
    await checkForUpdate();
    behaviour['npm build'] = {
      code: 1,
      stdout: '> tsc -p tsconfig.json\nsrc/index.ts(52,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n',
      stderr: 'npm error Lifecycle script `build` failed with error:\nnpm error code 2\nnpm error command failed\nnpm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c tsc -p tsconfig.json\n',
    };
    beginInstall();
    await settle();
    // The real reason, not npm's "command failed" footer.
    expect(updateInfo().job).toMatchObject({ state: 'failed', error: expect.stringMatching(/Building failed: .*error TS2322/) });
    expect(calls.find((c) => c.args[0] === 'reset')!.args).toEqual(['reset', '--hard', 'abc1234']);
    expect(calls.filter((c) => key(c.file, c.args) === 'npm ci')).toHaveLength(2); // reinstalled for the old version
    expect(fs.readFileSync(path.join(root, 'server', 'dist', 'index.js'), 'utf8')).toBe('old build');
    expect(restarted).toBe(0);
  });

  it('won’t start without a newer release, or twice at once', async () => {
    release!.tag_name = 'v0.1.0';
    await checkForUpdate();
    expect(() => beginInstall()).toThrow(/no newer release/);
    release!.tag_name = 'v0.2.0';
    await checkForUpdate();
    behaviour['npm build'] = { code: 0 };
    beginInstall();
    expect(() => beginInstall()).toThrow(/already being installed/);
    await settle();
  });
});

describe('release script', () => {
  it('works out the next version', async () => {
    const { nextVersion } = await import('../../../scripts/release.mjs');
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.4.2', 'major')).toBe('1.0.0');
    expect(() => nextVersion('0.1.0', 'banana')).toThrow(/patch, minor or major/);
  });
});
