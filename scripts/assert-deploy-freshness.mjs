#!/usr/bin/env node
/**
 * Is production running the head of `main`? (MOTIR-3760)
 *
 * Run it from a full-depth checkout of the repository:
 *
 *   node scripts/assert-deploy-freshness.mjs
 *   node scripts/assert-deploy-freshness.mjs --url https://app.motir.co/api/health/release
 *   node scripts/assert-deploy-freshness.mjs --max-age-minutes 30
 *
 * WHAT IT ASSERTS, and why the comparison is not done inside the app: see
 * `scripts/deployFreshness.mjs`, which holds the whole derivation and is the file
 * with the tests. This runner does four things only — read the endpoint, read
 * `main`, walk the gap, print — so that the part with a decision in it is
 * callable without a network, a git repository or a `process.exit`.
 *
 * ⚠️ NO CREDENTIAL, DELIBERATELY. The endpoint is unauthenticated (the reason is
 * on the route and in `permission-inventory.md` R58) and the history comes from
 * the checkout, so this is runnable from any shell by whoever is trying to work
 * out whether a merge has shipped. A monitor that needs a token to report an
 * outage carries one more thing that can be wrong during the outage.
 *
 * ⚠️ IT NEEDS `fetch-depth: 0`. A shallow checkout cannot walk
 * `<deployed>..HEAD` and cannot answer the ancestry question; both come back
 * empty, which is byte-identical to "up to date". The runner REFUSES rather than
 * reporting freshness it did not establish.
 *
 * EXIT CODES: 0 current (or behind but inside the ceiling) · 1 stale · 2 usage ·
 * 3 the read was blind.
 */
/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_MAX_AGE_MINUTES,
  EXIT_BLIND_READ,
  EXIT_USAGE,
  assertFreshness,
  formatResult,
  parseReleaseBody,
} from './deployFreshness.mjs';

// Production's own domain, not a host's name for it: the AWS cutover moved
// app.motir.co off Fly, and a host-named default went on reading the stopped
// Fly app and timing out.
const DEFAULT_URL = 'https://app.motir.co/api/health/release';

function parseArgs(argv) {
  const args = {
    url: process.env['MOTIR_RELEASE_URL'] || DEFAULT_URL,
    maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
    ref: 'HEAD',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i] ?? '';
    else if (argv[i] === '--ref') args.ref = argv[++i] ?? '';
    else if (argv[i] === '--max-age-minutes') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return { ...args, error: `--max-age-minutes needs a positive number, got: ${raw}` };
      }
      args.maxAgeMinutes = value;
    } else return { ...args, error: `unknown argument: ${argv[i]}` };
  }
  if (!args.url) return { ...args, error: 'no url — pass --url or set MOTIR_RELEASE_URL' };
  return args;
}

const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`::error::${args.error}`);
    console.error(
      'usage: assert-deploy-freshness.mjs [--url <endpoint>] [--ref <rev>] [--max-age-minutes <n>]',
    );
    return EXIT_USAGE;
  }

  let deployed;
  try {
    const res = await fetch(args.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) {
      // A 503 here is the route's own "I do not know which build I am", which is
      // a real finding rather than a transport failure — so the body, not the
      // status, is what gets reported.
      console.error(
        `::error::${args.url} answered ${res.status}. ${firstLine(body)} — production cannot ` +
          'name its own build, so nothing downstream can tell whether it is current.',
      );
      return EXIT_BLIND_READ;
    }
    deployed = parseReleaseBody(body);
  } catch (error) {
    console.error(
      `::error::Could not read ${args.url}: ${error instanceof Error ? error.message : error}`,
    );
    return EXIT_BLIND_READ;
  }

  let head;
  try {
    head = git('rev-parse', args.ref);
  } catch (error) {
    console.error(`::error::Could not resolve ${args.ref}: ${error}`);
    return EXIT_BLIND_READ;
  }

  // ⚠️ `cat-file -e` FIRST. Without it a shallow checkout answers every question
  // below with an emptiness that reads exactly like freshness — which is the
  // failure this whole check exists to stop, reproduced inside the check itself.
  try {
    git('cat-file', '-e', `${deployed}^{commit}`);
  } catch {
    console.error(
      `::error::${deployed} is not in this checkout. Fetch the full history ` +
        '(`actions/checkout` with `fetch-depth: 0`) — a shallow clone cannot tell "up to date" ' +
        'from "cannot see".',
    );
    return EXIT_BLIND_READ;
  }

  let deployedIsAncestor = true;
  try {
    git('merge-base', '--is-ancestor', deployed, head);
  } catch {
    deployedIsAncestor = false;
  }

  const undeployed = deployedIsAncestor
    ? git('log', '--reverse', '--format=%H %cI', `${deployed}..${head}`)
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [sha, committedAt] = line.split(' ');
          return { sha, committedAt };
        })
    : [];

  const result = assertFreshness({
    deployed,
    head,
    deployedIsAncestor,
    undeployed,
    now: new Date(),
    maxAgeMinutes: args.maxAgeMinutes,
  });
  console.log(formatResult(args.url, result));
  return result.code;
}

const firstLine = (text) => (text ?? '').split('\n')[0]?.slice(0, 200) ?? '';

process.exit(await main());
