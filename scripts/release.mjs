// Publishes a new Mediarr release on GitHub, which every install then offers as "Update available".
//
//   npm run release -- patch      0.1.0 -> 0.1.1  (fixes)
//   npm run release -- minor      0.1.0 -> 0.2.0  (new features)
//   npm run release -- major      0.1.0 -> 1.0.0
//   npm run release -- patch --dry-run   shows what would happen
//
// It refuses to run with uncommitted changes or off main, builds and tests first, then bumps the
// version, commits, tags, pushes and creates the GitHub Release (notes = the commits since the last one).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kind = args.find((a) => !a.startsWith('--'));

/** The next version for a bump kind; throws on anything else. */
export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Current version "${current}" isn't x.y.z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error('Say which kind of release: patch, minor or major (e.g. "npm run release -- patch")');
}

const npmCli = process.env.npm_execpath;
function run(file, fileArgs, { capture = false } = {}) {
  const [cmd, cmdArgs] = file === 'npm' && npmCli ? [process.execPath, [npmCli, ...fileArgs]] : [file, fileArgs];
  if (!capture) console.log(`$ ${file} ${fileArgs.join(' ')}`);
  if (dryRun && !capture) return '';
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) {
    console.error(`\n"${file} ${fileArgs.join(' ')}" failed${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    process.exit(1);
  }
  return (r.stdout ?? '').trim();
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let version;
  try {
    version = nextVersion(pkg.version, kind);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const tag = `v${version}`;
  if (run('git', ['status', '--porcelain'], { capture: true })) {
    console.error('There are uncommitted changes. Commit them first, so the release contains exactly what is on GitHub.');
    process.exit(1);
  }
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (branch !== 'main') {
    console.error(`Releases are made from main (you're on "${branch}").`);
    process.exit(1);
  }
  console.log(`Releasing Mediarr ${tag} (was v${pkg.version})${dryRun ? ' — dry run, nothing will change' : ''}\n`);

  run('npm', ['run', 'build']);
  run('npm', ['test']);
  run('npm', ['version', version, '--no-git-tag-version', '--workspaces', '--include-workspace-root']);
  run('git', ['add', 'package.json', 'package-lock.json', 'server/package.json', 'web/package.json']);
  run('git', ['commit', '-m', `Release ${tag}`]);
  run('git', ['tag', '-a', tag, '-m', `Mediarr ${tag}`]);
  run('git', ['push', 'origin', 'main', tag]);
  run('gh', ['release', 'create', tag, '--title', `Mediarr ${tag}`, '--generate-notes', '--verify-tag']);
  console.log(`\nReleased ${tag}. Mediarr installs will offer it as an update.`);
}
