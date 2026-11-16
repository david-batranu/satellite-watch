#!/usr/bin/env node
/**
 * Publish the app to GitHub Pages without GitHub Actions.
 *
 * Why not Actions? The gh token available here has `repo` scope but not
 * `workflow`, so pushing a workflow file is rejected. A `gh-pages` branch
 * deployment needs no extra scopes and keeps the same result.
 *
 *   npm run deploy:pages            # builds with PAGES_BASE=/satellite-watch/
 *   PAGES_BASE=/ npm run deploy:pages   # for a user site (david-batranu.github.io)
 *
 * It builds into dist/, adds .nojekyll, then force-pushes dist/ as the
 * `gh-pages` branch. The repository's Pages source must point at that branch
 * (see README).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PAGES_BASE = process.env.PAGES_BASE ?? '/satellite-watch/';

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  console.log(`\n$ ${printable}`);
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function gitConfig(key, fallback) {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: ROOT, encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

console.log(`⚙️  building for GitHub Pages (base: ${PAGES_BASE})`);
run('npm', ['run', 'build'], { env: { ...process.env, PAGES_BASE } });

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('build did not produce dist/index.html');
}
// Prevent GitHub's Jekyll pipeline from touching the output.
writeFileSync(join(DIST, '.nojekyll'), '');

const remote = run('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'inherit'] })
  .toString()
  .trim();
if (!remote) throw new Error('no git remote named "origin" — create the repo first');

const author = gitConfig('user.name', 'Satellite Watch');
const authorEmail = gitConfig('user.email', 'deploy@users.noreply.github.com');

console.log('\n🚀 publishing dist/ to the gh-pages branch');
rmSync(join(DIST, '.git'), { recursive: true, force: true });
run('git', ['-C', DIST, 'init', '-q', '-b', 'gh-pages']);
run('git', ['-C', DIST, 'add', '-A']);
run('git', [
  '-C', DIST,
  '-c', `user.name=${author}`,
  '-c', `user.email=${authorEmail}`,
  'commit', '-q', '-m', `deploy: ${new Date().toISOString()}`,
]);
run('git', ['-C', DIST, 'remote', 'add', 'origin', remote]);
run('git', ['-C', DIST, 'push', '-f', 'origin', 'HEAD:gh-pages']);
rmSync(join(DIST, '.git'), { recursive: true, force: true });

console.log('\n✅ pushed gh-pages. Enable/verify Pages:');
console.log('   gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=gh-pages" -f "source[path]=/"');
