import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from '../settings.js';

/** The Mediarr folder (a Git working copy of the GitHub repo). */
export const ROOT = path.resolve(import.meta.dirname, '../../..');
/** The tray restarts Mediarr straight away when it exits with this code. */
export const RESTART_EXIT_CODE = 75;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (file: string, args: string[], opts?: { input?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<CommandResult>;

/** Runs a program with an argument list (never through a shell), in the Mediarr folder. */
export const runCommand: Runner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });

/** npm, run as `node npm-cli.js` (Windows won't start npm.cmd without a shell). */
export function npmCommand(): [string, string[]] {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((p): p is string => !!p && p.endsWith('.js'));
  const cli = candidates.find((p) => fs.existsSync(p));
  if (!cli) throw new Error('Couldn’t find npm next to Node');
  return [process.execPath, [cli]];
}

// ---- Versions ----

/** [major, minor, patch], or null for anything that isn't a plain release version. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function currentVersion(root = ROOT): string {
  return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

/** "owner/repo" from a GitHub URL (https or ssh), or null. */
export function repoFromUrl(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---- State ----

export type Step = 'downloading' | 'installing' | 'building' | 'restarting';
export interface UpdateInfo {
  current: string;
  repo: string | null;
  latest: { version: string; name: string; notes: string; url: string; publishedAt: string } | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  job: { state: 'idle' | Step | 'failed' | 'done'; error: string | null; log: string[]; target: string | null };
}

const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export interface UpdaterDeps {
  root: string;
  run: Runner;
  fetch: typeof fetch;
  /** Ends this process so the new version can start. */
  restart: () => void;
  logFile: string | null;
}

let deps: UpdaterDeps = {
  root: ROOT,
  run: runCommand,
  fetch: (...a) => fetch(...a),
  restart: () => restartProcess(),
  logFile: null,
};
export function useUpdaterDeps(d: Partial<UpdaterDeps>) {
  deps = { ...deps, ...d };
}

let info: UpdateInfo = {
  current: '0.0.0',
  repo: null,
  latest: null,
  available: false,
  checkedAt: null,
  error: null,
  job: { state: 'idle', error: null, log: [], target: null },
};

/** Back to "never checked" (tests). */
export function resetUpdater() {
  info = { current: '0.0.0', repo: null, latest: null, available: false, checkedAt: null, error: null, job: { state: 'idle', error: null, log: [], target: null } };
}

export function updateInfo(): UpdateInfo {
  info.current = currentVersion(deps.root);
  info.available = !!info.latest && compareVersions(info.latest.version, info.current) > 0;
  return info;
}

const git = (args: string[], input?: string) => deps.run('git', args, { env: NON_INTERACTIVE, input, timeoutMs: 120_000 });

async function repoSlug(): Promise<string | null> {
  const configured = getSettings().updateRepo.trim();
  if (configured) return repoFromUrl(configured) ?? (/^[\w.-]+\/[\w.-]+$/.test(configured) ? configured : null);
  const r = await git(['remote', 'get-url', 'origin']);
  return r.code === 0 ? repoFromUrl(r.stdout) : null;
}

/** The GitHub token Git already uses (from the GitHub CLI or Git Credential Manager); never stored by Mediarr. */
async function githubToken(): Promise<string | null> {
  const r = await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
  if (r.code !== 0) return null;
  return /^password=(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? null;
}

/** Asks GitHub for the latest published release (drafts and pre-releases never count). */
export async function checkForUpdate(): Promise<UpdateInfo> {
  info.checkedAt = new Date().toISOString();
  info.error = null;
  try {
    const repo = await repoSlug();
    info.repo = repo;
    if (!repo) throw new Error('This copy of Mediarr isn’t linked to a GitHub repository (set one in Settings → System → Updates).');
    const token = await githubToken();
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'mediarr-updater',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) {
      info.latest = null;
      throw new Error(token ? 'No releases published yet.' : 'GitHub couldn’t be reached as you: sign in with “gh auth login” and “gh auth setup-git”.');
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = (await res.json()) as { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string; draft: boolean; prerelease: boolean };
    if (r.draft || r.prerelease || !parseVersion(r.tag_name)) {
      info.latest = null;
    } else {
      info.latest = { version: r.tag_name.replace(/^v/, ''), name: r.name || r.tag_name, notes: (r.body ?? '').slice(0, 20_000), url: r.html_url, publishedAt: r.published_at };
    }
  } catch (err) {
    info.error = (err as Error).message;
  }
  return updateInfo();
}

// ---- Installing ----

function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}`;
  info.job.log = [...info.job.log, line].slice(-200);
  if (deps.logFile) fs.appendFile(deps.logFile, stamped + '\n', () => {});
}

async function step(label: string, file: string, args: string[], timeoutMs = 15 * 60_000) {
  log(`$ ${path.basename(file)} ${args.join(' ')}`);
  const r = await deps.run(file, args, { env: NON_INTERACTIVE, timeoutMs });
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-8);
  for (const l of tail) if (l.trim()) log(l.trimEnd());
  if (r.code !== 0) throw new Error(`${label} failed${tail.length ? `: ${tail[tail.length - 1]}` : ''}`);
  return r;
}

const DIST = ['server/dist', 'web/dist'];

/**
 * Installs the latest release: fast-forward to its tag, reinstall packages, rebuild, restart.
 * Anything going wrong puts the previous version back (code, packages and build) and keeps it running.
 */
export function beginInstall(): { started: Promise<void> } {
  const state = updateInfo();
  if (!['idle', 'failed', 'done'].includes(state.job.state)) throw Object.assign(new Error('An update is already being installed.'), { statusCode: 409 });
  if (!state.latest || !state.available) throw Object.assign(new Error('There’s no newer release to install.'), { statusCode: 400 });
  const target = `v${state.latest.version}`;
  info.job = { state: 'downloading', error: null, log: [], target };
  return { started: installUpdate(target) };
}

async function installUpdate(target: string): Promise<void> {
  const root = deps.root;
  const backup = path.join(root, '.update-backup');
  const [npm, npmArgs] = npmCommand();
  let previous: string | null = null;

  try {
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code !== 0) throw new Error('This folder isn’t a Git copy of the repository, so it can’t be updated in place.');
    if (dirty.stdout.trim()) throw new Error('This copy has local changes to Mediarr’s files, so it won’t be overwritten. Commit or discard them first.');
    previous = (await step('Reading the current version', 'git', ['rev-parse', 'HEAD'])).stdout.trim();

    await step('Downloading', 'git', ['fetch', '--tags', '--force', 'origin']);
    await step('Updating the files', 'git', ['merge', '--ff-only', target]).catch((err: Error) => {
      throw new Error(/not possible to fast-forward|diverg/i.test(err.message) ? 'This copy has its own changes that aren’t in the release, so it can’t be updated automatically.' : err.message);
    });

    info.job.state = 'installing';
    await step('Installing packages', npm, [...npmArgs, 'ci', '--no-audit', '--no-fund']);

    info.job.state = 'building';
    fs.rmSync(backup, { recursive: true, force: true });
    for (const d of DIST) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(backup, d), { recursive: true });
    await step('Building', npm, [...npmArgs, 'run', 'build']);

    info.job.state = 'restarting';
    log(`Updated to ${target}. Restarting…`);
    fs.rmSync(backup, { recursive: true, force: true });
    // Let the browser hear "restarting" before this process ends.
    setTimeout(() => deps.restart(), 1500);
  } catch (err) {
    const message = (err as Error).message;
    log(`Update failed: ${message}`);
    if (previous) {
      log('Putting the previous version back…');
      await git(['reset', '--hard', previous]);
      for (const d of DIST) {
        if (fs.existsSync(path.join(backup, d))) {
          fs.rmSync(path.join(root, d), { recursive: true, force: true });
          fs.cpSync(path.join(backup, d), path.join(root, d), { recursive: true });
        }
      }
      await deps.run(npm, [...npmArgs, 'ci', '--no-audit', '--no-fund'], { timeoutMs: 15 * 60_000 });
      fs.rmSync(backup, { recursive: true, force: true });
    }
    info.job = { ...info.job, state: 'failed', error: message };
  }
}

/** Ends this process; the tray (or a small helper) starts the updated Mediarr. */
export function restartProcess() {
  if (process.env.MEDIARR_TRAY === '1') process.exit(RESTART_EXIT_CODE);
  // Started by hand: a detached helper waits for this process to let go of the port, then starts the new one.
  const server = path.join(ROOT, 'server', 'dist', 'index.js');
  const helper = `setTimeout(()=>{require('child_process').spawn(process.execPath,[${JSON.stringify(server)}],{detached:true,stdio:'ignore',windowsHide:true,cwd:${JSON.stringify(ROOT)}}).unref()},2500)`;
  spawn(process.execPath, ['-e', helper], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  process.exit(0);
}

let timer: NodeJS.Timeout | null = null;

/** Checks a minute after start and then every 6 hours (when turned on in Settings). */
export function startUpdateChecks(logFile: string) {
  deps.logFile = logFile;
  const tick = () => {
    if (getSettings().autoCheckUpdates) void checkForUpdate();
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 6 * 3600_000);
  timer.unref();
}
