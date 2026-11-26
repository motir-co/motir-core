// THE LIVE LANE'S SCRATCH REPOSITORY (MOTIR-12260 · story MOTIR-12250).
//
// One JSON file on disk is the repository GitHub would hold: its commits (each a
// parent list and a whole file tree), its branches and its pull requests. Three
// processes read it, each on every request, so a commit the suite writes is what
// the next request sees:
//
//   * the GitHub preload in motir-core's job worker (`githubFake.preload.mjs`) —
//     the installation token, a ref's head, a pull request, a three-dot compare and
//     the tarball redirect;
//   * the archive host (`archiveHost.mjs`) — the gzip tar motir-codegraph's worker
//     fetches for a commit;
//   * the suite, which writes it.
//
// Plain ESM with no dependencies, so the worker bundle's `--import` and the archive
// host load it as it is, and the Playwright suite imports it too.

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** @typedef {{ parents: string[], files: Record<string, string> }} Commit */
/** @typedef {{ number: number, state: 'open' | 'closed', merged: boolean, headRef: string, baseRef: string, headRepoId: number | null }} PullRequest */
/** @typedef {{ owner: string, name: string, id: number, defaultBranch: string, commits: Record<string, Commit>, refs: Record<string, string>, pulls: Record<string, PullRequest>, archiveOrigin: string }} Scenario */

/** @returns {Scenario} */
export function readScenario(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export function writeScenario(path, scenario) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(scenario, null, 2));
  renameSync(tmp, path);
}

/** A commit's sha: content-addressed over its parents and tree, 40 lowercase hex. */
export function commitSha(parents, files) {
  return createHash('sha1')
    .update(JSON.stringify({ parents, files: Object.entries(files).sort() }))
    .digest('hex');
}

/** Add a commit on top of `parent` with `changes` applied (`null` deletes a path). */
export function addCommit(scenario, parent, changes) {
  const files = { ...(parent ? scenario.commits[parent].files : {}) };
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  const parents = parent ? [parent] : [];
  const sha = commitSha(parents, files);
  scenario.commits[sha] = { parents, files };
  return sha;
}

/** Every ancestor of `sha`, itself included, nearest first. */
function ancestors(scenario, sha) {
  const seen = [];
  const queue = [sha];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.includes(next)) continue;
    seen.push(next);
    queue.push(...(scenario.commits[next]?.parents ?? []));
  }
  return seen;
}

/** The nearest common ancestor of two commits, or null when they share none. */
export function mergeBase(scenario, a, b) {
  const ofB = new Set(ancestors(scenario, b));
  return ancestors(scenario, a).find((sha) => ofB.has(sha)) ?? null;
}

/**
 * GitHub's `compare/{base}...{head}`: THREE-DOT — what `head` changed since it left
 * `base`, measured from their merge base, not everything `base` moved on since.
 */
export function compareThreeDot(scenario, base, head) {
  const from = mergeBase(scenario, base, head);
  if (!from || !scenario.commits[head]) return null;
  const before = scenario.commits[from].files;
  const after = scenario.commits[head].files;
  const files = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(path in after)) files.push({ filename: path, status: 'removed' });
    else if (!(path in before)) files.push({ filename: path, status: 'added' });
    else if (before[path] !== after[path]) files.push({ filename: path, status: 'modified' });
  }
  const commits = ancestors(scenario, head)
    .filter((sha) => !ancestors(scenario, from).includes(sha))
    .reverse()
    .map((sha) => ({ sha }));
  return {
    base_commit: { sha: base },
    merge_base_commit: { sha: from },
    commits,
    files,
  };
}

/** One ustar header block for a regular file or a directory. */
function tarHeader(name, size, type) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write(
    `${Math.floor(Date.UTC(2026, 0, 1) / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii',
  );
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** The commit's tree as GitHub's archive serves it: one top-level directory, gzipped. */
export function tarballOf(scenario, sha) {
  const commit = scenario.commits[sha];
  if (!commit) return null;
  const top = `${scenario.owner}-${scenario.name}-${sha.slice(0, 7)}/`;
  const parts = [tarHeader(top, 0, '5')];
  const dirs = new Set();
  for (const path of Object.keys(commit.files).sort()) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const dir = `${top}${segments.slice(0, i).join('/')}/`;
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(tarHeader(dir, 0, '5'));
      }
    }
    const body = Buffer.from(commit.files[path], 'utf8');
    parts.push(tarHeader(`${top}${path}`, body.length, '0'), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}
