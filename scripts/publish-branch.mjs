#!/usr/bin/env node
/**
 * Publish the built site to a static git branch.
 *
 * The build output is committed as the branch tip, so a remote host can deploy
 * with a plain `git clone`/`git fetch` — no Node.js, no build step on the server.
 *
 * Two targets share this script:
 *
 *   npm run deploy:pages   → branch `gh-pages`,  base `/satellite-watch/`  (GitHub Pages)
 *   npm run deploy:sky     → branch `deploy-sky`, base `/sky/`             (seekahead.eu/sky)
 *
 * Each target needs its own branch because Vite inlines the deployment base into
 * the asset URLs, the service-worker scope and the manifest.
 *
 * The branch is force-pushed: it is an artifact branch, not a history to merge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Branch name to force-push the build to. */
const BRANCH = process.env.PUBLISH_BRANCH ?? 'gh-pages';
/** Base URL the build assumes (Vite `base`), always with a trailing slash. */
const RAW_BASE = process.env.PAGES_BASE ?? '/satellite-watch/';
const PAGES_BASE = RAW_BASE.endsWith('/') ? RAW_BASE : `${RAW_BASE}/`;

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function gitConfig(key, fallback) {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: ROOT, encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

console.log(`⚙️  building for ${BRANCH} (base: ${PAGES_BASE})`);
run('npm', ['run', 'build'], { env: { ...process.env, PAGES_BASE } });

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('build did not produce dist/index.html');
}
// Prevent GitHub's Jekyll pipeline from touching the output if it is on Pages.
writeFileSync(join(DIST, '.nojekyll'), '');

const remote = run('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'inherit'] })
  .toString()
  .trim();
if (!remote) throw new Error('no git remote named "origin" — create the repo first');

// Provenance for the artifact branch: which commit of the source and which
// build base produced these files. Useful when debugging a deployed checkout.
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const repoUrl = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
writeFileSync(
  join(DIST, 'deploy-info.txt'),
  [
    `repo:    ${repoUrl}`,
    `branch:  ${BRANCH}`,
    `base:    ${PAGES_BASE}`,
    `source:  ${sourceCommit}`,
    `built:   ${new Date().toISOString()}`,
    '',
  ].join('\n'),
);

const author = gitConfig('user.name', 'Satellite Watch');
const authorEmail = gitConfig('user.email', 'deploy@users.noreply.github.com');

console.log(`\n🚀 publishing dist/ to the ${BRANCH} branch`);
rmSync(join(DIST, '.git'), { recursive: true, force: true });
run('git', ['-C', DIST, 'init', '-q', '-b', BRANCH]);
run('git', ['-C', DIST, 'add', '-A']);
run('git', [
  '-C', DIST,
  '-c', `user.name=${author}`,
  '-c', `user.email=${authorEmail}`,
  'commit', '-q', '-m', `deploy: ${BRANCH} @ ${PAGES_BASE} — ${new Date().toISOString()}`,
]);
run('git', ['-C', DIST, 'remote', 'add', 'origin', remote]);
run('git', ['-C', DIST, 'push', '-f', 'origin', `HEAD:${BRANCH}`]);
rmSync(join(DIST, '.git'), { recursive: true, force: true });

console.log(`\n✅ pushed ${BRANCH}`);
