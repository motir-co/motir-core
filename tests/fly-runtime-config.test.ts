import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONITOR_REFRESH_LEASE_MS } from '@/lib/services/monitorCredentialService';

/**
 * Guards for MOTIR-2387 — the Fly runtime: `output: 'standalone'`, the
 * multi-stage `Dockerfile`, `fly.toml`, and the release lane that applies
 * migrations.
 *
 * These assertions exist because NOTHING else would catch a regression in them.
 * A Dockerfile and a `fly.toml` are not type-checked, not linted, and not
 * executed by any suite; the first thing that reads them is a production deploy,
 * and every failure mode below is one that presents there as something else:
 *
 *   * A missing `HOSTNAME=0.0.0.0` produces a server that logs "✓ Ready" and
 *     answers nothing — on a first deploy it looks like a networking problem.
 *   * A release command that cannot resolve the Prisma CLI, or a
 *     `prisma.config.ts` separated from the `node_modules` that satisfies its
 *     imports, dies in the release step and rolls the whole deploy back.
 *   * `fly.toml` asserting a machine COUNT is the exact belief MOTIR-2102
 *     disproved: the file cannot create a machine, and stating otherwise cost
 *     this project three days on its other service.
 *
 * Same mould as `tests/ci-acceptance-lane.test.ts` — read the file, assert the
 * load-bearing lines, and say in a comment why each one is load-bearing.
 */

const root = process.cwd();
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const flyToml = readFileSync(join(root, 'fly.toml'), 'utf8');
const nextConfig = readFileSync(join(root, 'next.config.ts'), 'utf8');

/** The runner stage — everything after the last `FROM … AS runner`. */
const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));

/** The builder stage — from `AS builder` up to the runner. */
const builderStage = dockerfile.slice(
  dockerfile.indexOf('AS builder'),
  dockerfile.indexOf('AS runner'),
);

/**
 * Where the app is compiled.
 *
 * ⚠️ IT IS NO LONGER A BARE `RUN pnpm exec next build`, and that is why this is
 * a constant rather than a string literal repeated at three call sites.
 * MOTIR-1162 mounts the Sentry source-map auth token as a BuildKit secret, and
 * a `--mount=type=secret` must be declared on the very RUN that consumes it —
 * so the command moved onto a continuation line of a longer instruction.
 *
 * Every property the assertions below are about is unchanged: it is `next
 * build` and not the migrating `build` script, and it still runs after the
 * placeholder ENV block and before the standalone check. What moved is the
 * ANCHOR. Matching on the command itself rather than on the whole instruction
 * is also what keeps them from going vacuously green next time it grows a flag
 * — an `indexOf` that stops finding its needle returns `-1`, which is less than
 * everything.
 */
/**
 * ⚠️ THE ANCHOR TOLERATES A LEADING ENV ASSIGNMENT, and the comment above
 * predicted why: it matches the COMMAND rather than the instruction precisely so
 * it does not go vacuous "next time it grows a flag". MOTIR-1789 gave the command
 * `NODE_OPTIONS=--max-old-space-size=…`, because `next build` compiles and then
 * type-checks and node's ~4.1GB default does not hold both.
 *
 * Every property these assertions are about survives that prefix: it is still
 * `next build` and not the migrating `build` script, still after the placeholder
 * ENV block, still before the standalone check. So the prefix is ADMITTED rather
 * than the anchor loosened — the line must still END with the command, so
 * `RUN pnpm build` cannot satisfy it, and a needle that stops being found still
 * returns -1.
 */
const NEXT_BUILD_COMMAND = /^\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*pnpm exec next build\s*$/m;

/** The offset of {@link NEXT_BUILD_COMMAND} in `text`, asserted to be present. */
function nextBuildIndex(text: string): number {
  const at = text.search(NEXT_BUILD_COMMAND);
  expect(at, 'the Dockerfile no longer runs `pnpm exec next build`').toBeGreaterThan(-1);
  return at;
}

/**
 * The prune step's shell body, lifted verbatim out of the Dockerfile so the
 * tests below can RUN it rather than pattern-match it. Takes the `RUN set -eu;`
 * line and every continued line after it, and strips the `RUN ` prefix and the
 * trailing backslashes that make it one Docker instruction.
 */
function extractPruneScript(): string {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => l.startsWith('RUN set -eu;'));
  if (start === -1) throw new Error('the standalone prune step is gone from the Dockerfile');
  const body = [lines[start]!.replace(/^RUN /, '')];
  for (let i = start; lines[i]!.trimEnd().endsWith('\\'); i++) body.push(lines[i + 1]!);
  return body.map((l) => l.replace(/\\$/, '')).join('\n');
}

describe('next.config.ts — the standalone artifact', () => {
  it("sets output: 'standalone'", () => {
    // The load-bearing half of the whole move (ADR Q1). Without it `next build`
    // emits a per-route artifact and the Dockerfile's runner stage copies a
    // directory that does not exist.
    expect(nextConfig).toMatch(/output:\s*'standalone'/);
  });

  it('carries NO outputFileTracingExcludes, and says why (MOTIR-2403)', () => {
    // The key is read in exactly one module, `collect-build-traces.js`, which
    // `next/dist/build/index.js` calls behind
    // `if (bundler !== Bundler.Turbopack && …)`. Next 16 builds with Turbopack,
    // so the module never runs. The version that shipped here excluded
    // `./design/**` + three more directories and removed none of them, while
    // reading — with a measured byte figure attached — as a solved problem. That
    // second half is the defect: MOTIR-2102 is the same shape one file over, a
    // config asserting a behaviour the tool does not perform.
    expect(nextConfig).not.toMatch(/^\s*outputFileTracingExcludes:/m);
    // Absence alone would leave the next reader to rediscover why, and re-adding
    // the key is the obvious-looking fix. The comment is the deliverable.
    expect(nextConfig).toMatch(/outputFileTracingExcludes/); // named in prose
    expect(nextConfig).toMatch(/Turbopack/);
    expect(nextConfig).toMatch(/collect-build-traces/);
    expect(nextConfig).toMatch(/MOTIR-2403/);
  });

  it('marks outputFileTracingIncludes as inert under this build, not as working', () => {
    // Same mechanism, same skipped module — so the OG-font entry does not take
    // effect either. It is KEPT (it is the only record of why those bytes must
    // ship, and it is the webpack-path net), but it must not read as the thing
    // delivering them: Turbopack's own tracer is, verified in the built
    // `route.js.nft.json`. A reader who believes this key works will debug a
    // missing font in the wrong place.
    expect(nextConfig).toMatch(/outputFileTracingIncludes:/);
    expect(nextConfig).toMatch(/does NOT currently do anything/);
  });
});

describe('Dockerfile — the runner image', () => {
  it('sets HOSTNAME=0.0.0.0 and says why omitting it is silent', () => {
    expect(runnerStage).toMatch(/^ENV HOSTNAME=0\.0\.0\.0$/m);
    // The value alone is not the deliverable; the reason beside it is. This is
    // the finding the spike paid for, and a comment is the only form of it that
    // survives into the next person's edit.
    expect(runnerStage).toMatch(/SILENTLY|silently/);
  });

  it('copies the standalone output, the static assets and public/', () => {
    // `.next/static` and `public` are NOT part of the standalone bundle; Next
    // requires them to be copied alongside it, and a missing copy serves an
    // unstyled page rather than an error.
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/\.next\/standalone \.\//);
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/app\/\.next\/static \.\/\.next\/static/,
    );
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/public \.\/public/);
  });

  it("does NOT copy the builder's dependency tree into the runner", () => {
    // The entire point of the multi-stage split. The builder carries the full
    // dev dependency set (next build needs it); the runner must carry only the
    // traced standalone bundle plus the migration toolchain.
    expect(runnerStage).not.toMatch(/COPY --from=builder[^\n]*\/app\/node_modules(\s|$)/);
  });

  it('checks the standalone output in the BUILDER, before the runner copies it', () => {
    // Docker layers are additive: `COPY --from=builder … .next/standalone` in the
    // runner commits every byte it copies, and a later `RUN rm -rf` only writes a
    // whiteout over them. The image would not shrink at all. Pruning before the
    // COPY is the whole reason this step sits where it does, so its POSITION is
    // the assertion — MOTIR-2403.
    expect(builderStage).toMatch(/^RUN set -eu;/m);
    // Not "no `rm -rf` in the runner" — the apt-cache cleanup is a legitimate
    // one, and it shrinks the image precisely because it shares a layer with the
    // `apt-get install` that created those files. What must not appear is a
    // prune of the standalone payload, which would land in a layer of its own.
    for (const d of ['design', 'tests', 'docs', 'scripts']) {
      expect(runnerStage, d).not.toMatch(new RegExp(String.raw`rm -rf[^\n]*\b${d}\b`));
    }
    // …and after `next build`, which is what produces the directory it reads.
    expect(nextBuildIndex(builderStage)).toBeLessThan(builderStage.indexOf('RUN set -eu;'));
  });

  it('builds with `next build`, never the `build` script that migrates', () => {
    // package.json's `build` is `prisma generate && node scripts/migrate-deploy.mjs
    // && next build`. Migrations belong to fly.toml's release_command; running
    // them during an image build would migrate whatever database the builder can
    // reach — and the builder's DATABASE_URL is a placeholder pointing at
    // localhost (see the placeholder describe below), so `migrate deploy` here
    // would fail the build outright rather than do anything useful.
    expect(dockerfile).toMatch(NEXT_BUILD_COMMAND);
    expect(dockerfile).not.toMatch(/^RUN pnpm build$/m);
    // The token reaches that command as a MOUNTED SECRET, never as an ARG or an
    // ENV: a build argument is recorded in the build's own metadata, and this is
    // a credential (MOTIR-1162). The mount must sit on the same instruction.
    expect(builderStage).toContain('--mount=type=secret,id=SENTRY_AUTH_TOKEN');
    expect(builderStage).not.toMatch(/^ARG SENTRY_AUTH_TOKEN/m);
  });
});

/**
 * MOTIR-2490 — the first deploy never produced a machine, because `next build`
 * died collecting page data with no `DATABASE_URL`.
 *
 * Next EVALUATES each route's module graph during collection, so a route that
 * imports `@/lib/auth` or a service reaches `lib/db.ts`, whose module-scope
 * `export const db = … ?? createClient()` throws without the variable. It never
 * surfaced on Vercel, where builds carried the project's real environment.
 *
 * These are structural assertions because NOTHING in PR CI builds the image —
 * the `build` job compiles the app with a real `DATABASE_URL` against an
 * ephemeral Postgres, which is exactly the configuration that hides this. Until
 * that gap is closed, this file is the only gate standing between a deleted ENV
 * line and a failed production deploy.
 */
describe('Dockerfile — the build-time placeholders (MOTIR-2490)', () => {
  /** Every name whose `requiredEnv` check runs at MODULE LOAD, so collection hits it. */
  const MODULE_LOAD_ENV = [
    'DATABASE_URL', // lib/db.ts — `export const db = … ?? createClient()`
    'DATABASE_URL_UNPOOLED', // prisma.config.ts, read by the release lane
    'BETTER_AUTH_SECRET', // lib/auth/index.ts — `betterAuth({ secret: … })`
    'GOOGLE_CLIENT_ID', // lib/auth/index.ts — the Google provider block
    'GOOGLE_CLIENT_SECRET',
  ] as const;

  /**
   * Matches a name whether it opens the instruction (`ENV DATABASE_URL=…`) or
   * continues it (`    GOOGLE_CLIENT_ID=…` after a trailing backslash), so
   * re-ordering the block cannot turn a real assertion into a vacuous one.
   */
  const assignment = (name: string) => new RegExp(`^(?:ENV\\s+)?\\s*${name}=`, 'm');

  it.each(MODULE_LOAD_ENV)('the BUILDER sets a placeholder for %s', (name) => {
    expect(builderStage).toMatch(assignment(name));
  });

  it('sets them BEFORE `next build`, or they do not apply', () => {
    const firstPlaceholder = builderStage.indexOf('DATABASE_URL=');
    const build = nextBuildIndex(builderStage);
    expect(firstPlaceholder).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(firstPlaceholder);
  });

  it('NEVER lets a placeholder reach the runner — it is a separate FROM', () => {
    // The whole safety argument for hardcoding credentials-shaped strings in a
    // Dockerfile is that they die with the builder stage. If one ever appears
    // below `AS runner`, the running image ships a fake secret and the real Fly
    // secret may not override it.
    for (const name of MODULE_LOAD_ENV) {
      expect(runnerStage).not.toMatch(assignment(name));
    }
    expect(runnerStage).not.toMatch(/build-time-placeholder/);
  });

  it('points the placeholder database at localhost, so nothing real can be reached', () => {
    // Inert by construction: even if a collected route did open a connection,
    // 127.0.0.1 inside the build container is nothing. A placeholder naming a
    // real host would be a live credential in the image history.
    const url = builderStage.match(/DATABASE_URL="([^"]+)"/)?.[1] ?? '';
    expect(url).toMatch(/@127\.0\.0\.1:/);
  });

  it('records WHY the placeholders exist, not just that they do', () => {
    // The comment this replaced said "DATABASE_URL is read at RUNTIME" — true on
    // Vercel, false here, and believed for long enough to cost the first deploy.
    expect(builderStage).toMatch(/MOTIR-2490/);
    expect(builderStage).toMatch(/page-data collection|collecting page data/i);
  });
});

describe('Dockerfile — the migration toolchain', () => {
  it('pins the Prisma CLI by READING the installed version, not by literal', () => {
    // A hardcoded version drifts silently behind package.json's `^` range: the
    // image would migrate with a different CLI than the repo develops against,
    // and nothing would say so. Reading it out of the resolved tree makes drift
    // impossible rather than detectable.
    expect(dockerfile).toMatch(/require\('prisma\/package\.json'\)\.version/);
    expect(dockerfile).toMatch(/npm install --prefix \/migrate/);
    expect(dockerfile).not.toMatch(/prisma@\d+\.\d+\.\d+/);
  });

  it('keeps prisma.config.ts beside the toolchain, not at the app root', () => {
    // `prisma.config.ts` is a MODULE: it imports `dotenv` and `prisma/config`,
    // which Node resolves from the config FILE's own directory. At /app those
    // resolve against the standalone server's minimal node_modules, which has
    // neither, and the release command dies with `Cannot find module 'dotenv'`.
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/app\/prisma\.config\.ts \.\/migrate\/prisma\.config\.ts/,
    );
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/prisma \.\/migrate\/prisma/);
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/migrate\/node_modules \.\/migrate\/node_modules/,
    );
  });

  it('does not merge the toolchain into the standalone server node_modules', () => {
    // The two trees both contain `@prisma`, `react` and `react-dom`. Merging
    // them lets the CLI's copies shadow the ones the server was traced against.
    expect(runnerStage).not.toMatch(/\/migrate\/node_modules \.\/node_modules/);
  });
});

describe('Dockerfile — the standalone SCOPE ASSERTION, RUN rather than read (MOTIR-2403 → MOTIR-3219)', () => {
  /** Directories nothing serving a request reads. None may reach the output. */
  const NEVER_SERVED = ['design', 'tests', 'docs', 'scripts'];
  /** Directories the running server needs — the step must not care about them. */
  const KEEP = ['packages/brand/fonts', 'node_modules', 'prisma'];

  /**
   * Build a fake `.next/standalone` holding `present` (plus the KEEP set), run
   * the real step's shell over it, and hand the result + the tree to `assert`
   * before the temp directory goes away.
   */
  function withScopeCheck(
    present: string[],
    assert: (res: { status: number; stdout: string; stderr: string }, standalone: string) => void,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), 'standalone-scope-'));
    try {
      const standalone = join(dir, '.next/standalone');
      for (const d of [...present, ...KEEP]) {
        mkdirSync(join(standalone, d), { recursive: true });
        writeFileSync(join(standalone, d, 'payload.bin'), 'x'.repeat(1024));
      }
      const res = spawnSync('sh', ['-c', extractPruneScript()], { cwd: dir, encoding: 'utf8' });
      assert(
        { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' },
        standalone,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('PASSES on the output the fixed build produces, and touches nothing', () => {
    // MOTIR-3219 removed the sweep that made a prune necessary: the E2E boundary
    // mocks' unresolvable fixture reads were what made Turbopack trace the whole
    // project, and with those marked `turbopackIgnore` none of NEVER_SERVED is
    // traced in at all. Measured on this Dockerfile's own `next build`:
    // `instrumentation.js.nft.json` 4510 → 168 files, `.next/standalone`
    // 464 → 124 MB.
    //
    // The KEEP set is asserted for the same reason it always was — the OG cards
    // read the three Inter faces off disk at request time (MOTIR-3848 moved them
    // out of `app/_brand/fonts/` and into `@motir/brand`, which in this
    // workspace IS `packages/brand/fonts/`) — but now against a
    // step that must not DELETE anything, which is the stronger property: there
    // is no `rm` left in it to reach the wrong path.
    withScopeCheck([], (res, standalone) => {
      expect(res.status, res.stderr).toBe(0);
      for (const d of KEEP) expect(existsSync(join(standalone, d)), d).toBe(true);
    });
    expect(extractPruneScript()).not.toMatch(/\brm -rf\b/);
  });

  it.each(NEVER_SERVED)('FAILS when %s is back in the standalone output', (returned) => {
    // The regression this replaces the prune with. A widened trace used to be
    // invisible — the prune deleted the evidence and the image was merely
    // rebuilt from a sweep nobody saw. Now it stops the build, on the one path
    // that ships the bytes, and `flyctl deploy` runs only AFTER a merge.
    withScopeCheck([returned], (res) => {
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(`'${returned}/' is in the standalone output`);
      // The message must route the reader to the check that names the CAUSE,
      // rather than to a prune that would hide it again.
      expect(res.stderr).toContain('pnpm assert:nft-trace');
      expect(res.stderr).toContain('do not re-add a prune here');
    });
  });

  it('reports the size, so the log carries the evidence', () => {
    // A number in the build log is what lets the next person confirm the output
    // is still small, without reproducing a build to find out.
    withScopeCheck([], (res) => {
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/standalone: \d+ MB/);
    });
  });
});

describe('fly.toml — the deployment configuration', () => {
  it('pins the region and the VM the ADR decided', () => {
    expect(flyToml).toMatch(/^primary_region\s*=\s*"iad"/m);
    expect(flyToml).toMatch(/size\s*=\s*"performance-1x"/);
  });

  it('runs EVERY process group on a dedicated CPU, never a quota-throttled shared one (MOTIR-10119)', () => {
    // A shared CPU is throttled once its burst balance drains, and Fly reports the
    // throttle as `steal`. It froze the app on 2026-10-15 and the worker in every CI
    // burst of 2026-10-29/30 (P2028 on `system.ci-runner-boot`). Read per group,
    // because the old test only asked whether `performance-1x` appeared ANYWHERE,
    // and it passed while the worker stayed shared.
    const vms = [...flyToml.matchAll(/^\s*\[\[vm\]\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)].map(
      (m) => m[1] ?? '',
    );
    const sizeOf = (group: string) =>
      vms
        .filter((body) =>
          new RegExp(`^\\s*processes\\s*=\\s*\\[\\s*"${group}"\\s*\\]`, 'm').test(body),
        )
        .map((body) => /^\s*size\s*=\s*"([^"]*)"/m.exec(body)?.[1]);
    expect(sizeOf('app')).toEqual(['performance-1x']);
    expect(sizeOf('worker')).toEqual(['performance-1x']);
    for (const body of vms) {
      expect(/^\s*size\s*=\s*"shared-cpu-/m.test(body), body).toBe(false);
    }
  });

  it('deploys bluegreen, so one running machine is not an outage on every deploy', () => {
    // The default `rolling` strategy replaces a machine in place; with a single
    // running `app` machine that is a gap. Unverified against the worker group and
    // the suspended spare — see the comment above `strategy` in fly.toml.
    expect(flyToml).toMatch(/^\s*strategy\s*=\s*"bluegreen"$/m);
  });

  it('runs migrations from the release command, through the staged lane', () => {
    // Not `pnpm prisma migrate deploy`: the standalone image has no pnpm and no
    // CLI on PATH. The entrypoint is what makes the staged directory runnable.
    expect(flyToml).toMatch(/release_command\s*=\s*"node \/app\/migrate\/release-migrate\.mjs"/);
    expect(flyToml).not.toMatch(/release_command[^\n]*pnpm/);
  });

  it('declares the machine POLICY — one running, the spare suspended and woken on load', () => {
    // ⚠️ `min_machines_running` WAS 1, AND 2 IS A DECISION (MOTIR-2785,
    // executing `docs/decisions/application-hosting.md` Amendment 7 §14). This
    // assertion went red on that change, which is the guard working.
    //
    // The distinction the old value blurred: the POOL is a ceiling an operator
    // creates, and this is a FLOOR on how many of it the proxy will not stop.
    // A pool of two with a floor of one is a single point of failure — the spare
    // wakes on load, never on its sibling dying — and `min_machines_running` is
    // not a failover guarantee even at 2, because a dead machine is RESTARTED by
    // flyd rather than replaced. Two machines RUNNING is the only configuration
    // that survives losing one without a user-visible gap, and this app serves
    // interactive page loads.
    //
    // Measured 2026-08-20 rather than argued: the spare DID start on a deploy at
    // 12:29:18Z and the PROXY stopped it 5m40s later, so this app served its
    // whole load from one machine from 12:35Z onward.
    expect(flyToml).toMatch(/^\s*min_machines_running\s*=\s*1$/m);
    expect(flyToml).toMatch(/^\s*auto_stop_machines\s*=\s*"suspend"$/m);
    expect(flyToml).toMatch(/^\s*auto_start_machines\s*=\s*true$/m);
  });

  it('still separates the FLOOR from the POOL in prose, now that they differ from 1', () => {
    // The floor and the pool are both 2 today, which is exactly when a reader
    // starts believing this file sets the count. It does not, and MOTIR-2102 is
    // what that belief cost. The paragraph that says so is asserted below in
    // 'records the intended count as an INTENT'; this pins the distinction being
    // drawn explicitly rather than left to be inferred from two equal numbers.
    expect(flyToml).toMatch(/AVAILABILITY DECISION/);
    expect(flyToml).toMatch(/floor on how many of an existing pool/);
  });

  it('records the intended count as an INTENT, and never asserts one', () => {
    // ADR Q6. The file states that two machines are intended, that `flyctl
    // deploy` adds none, and that `fly scale count 2` on MOTIR-2386 is what
    // creates them. What it must NOT do is carry a key that reads as a count —
    // that is MOTIR-2102's mistake, where a config comment asserting a platform
    // behaviour stood in for a command nobody ran.
    expect(flyToml).toMatch(/fly scale count 2/);
    expect(flyToml).toMatch(/MOTIR-2386/);
    expect(flyToml).toMatch(/MOTIR-2102/);
    expect(flyToml).toMatch(/flyctl deploy/);
    expect(flyToml).toMatch(/without adding any/);
    // No key assigns a machine count. `min_machines_running` is a floor on an
    // existing pool and is asserted above; anything else is a claim.
    const assignments = flyToml
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => /^\s*(machine_count|count|machines)\s*=/.test(line));
    expect(assignments).toEqual([]);
  });

  it('gives a stopping machine long enough to store a credential refresh in flight', () => {
    // MOTIR-8184. Fly SIGKILLs a machine `kill_timeout` after SIGTERM (5 s by
    // default). The worker's drain waits for an in-flight monitor token refresh
    // to commit the pair the provider has already rotated — up to the refresh
    // LEASE. A kill_timeout shorter than that lease lets a deploy land between
    // Sentry's answer and our write, which is the connection-killing window this
    // card closed. Fly caps the value at 300 s.
    const line = flyToml.split('\n').find((l) => /^kill_timeout\s*=/.test(l));
    expect(line, 'fly.toml must set a top-level kill_timeout').toBeDefined();
    const match = /"(\d+)s"/.exec(line ?? '');
    expect(match).not.toBeNull();
    const seconds = Number(match![1]);
    expect(seconds * 1000).toBeGreaterThan(MONITOR_REFRESH_LEASE_MS);
    expect(seconds).toBeLessThanOrEqual(300);
  });

  it('holds traffic off a new app machine until its readiness check passes', () => {
    // MOTIR-8231. With no check, Fly's proxy sent a freshly deployed machine
    // requests the moment its port opened — before any route module had loaded
    // or any pool connection existed — and its first webhook failed with a P2028
    // `maxWait` at uptime 15 s. A service check is what the proxy routes on.
    const block = /^\s*\[\[http_service\.checks\]\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(
      flyToml,
    );
    expect(block, 'fly.toml must declare an [[http_service.checks]] entry').not.toBeNull();
    const keys = new Map(
      (block?.[1] ?? '')
        .split('\n')
        .map((l) => /^\s*([a-z_]+)\s*=\s*"([^"]*)"/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1], m[2]] as const),
    );
    expect(keys.get('path')).toBe('/api/health/ready');
    expect(keys.get('method')?.toLowerCase()).toBe('get');
    for (const key of ['grace_period', 'interval', 'timeout']) {
      expect(keys.get(key), `${key} is set`).toMatch(/^\d+s$/);
    }
    // The check must answer inside its own interval, or two overlap.
    expect(Number.parseInt(keys.get('timeout')!, 10)).toBeLessThan(
      Number.parseInt(keys.get('interval')!, 10),
    );
    // And the route it names must exist — a check against a 404 keeps every
    // machine out of rotation for ever.
    expect(existsSync(join(root, 'app/api/health/ready/route.ts'))).toBe(true);
  });

  it('declares a private metrics scrape for the app group, off the public port (MOTIR-8553)', () => {
    const block = /^\s*\[\[metrics\]\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(flyToml);
    expect(block, 'fly.toml must declare a [[metrics]] entry').not.toBeNull();
    const body = block?.[1] ?? '';
    const port = /^\s*port\s*=\s*(\d+)/m.exec(body)?.[1];
    expect(port).toBeDefined();
    expect(/^\s*path\s*=\s*"([^"]*)"/m.exec(body)?.[1]).toBe('/metrics');
    expect(/^\s*processes\s*=\s*\[\s*"app"\s*\]/m.test(body)).toBe(true);

    const internalPort = /^\s*internal_port\s*=\s*(\d+)/m.exec(flyToml)?.[1];
    expect(internalPort).toBeDefined();
    expect(port).not.toBe(internalPort);
    // The app opens the port only when told which one — the same number.
    expect(flyToml).toMatch(new RegExp(`^\\s*MONITORING_METRICS_PORT\\s*=\\s*"${port}"`, 'm'));
  });
});

describe('scripts/release-migrate.mjs — the release entrypoint', () => {
  it('runs from its own directory with its own toolchain on PATH', () => {
    // Behavioural, not textual: the two invariants the release lane rests on are
    // that it chdirs beside prisma.config.ts and that `prisma` resolves from the
    // staged toolchain — regardless of the working directory Fly happens to give
    // it. Stubbing `migrate-deploy.mjs` (which the entrypoint imports by
    // relative path) lets both be observed without a database.
    const dir = mkdtempSync(join(tmpdir(), 'release-migrate-'));
    try {
      copyFileSync(join(root, 'scripts/release-migrate.mjs'), join(dir, 'release-migrate.mjs'));
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      writeFileSync(
        join(dir, 'migrate-deploy.mjs'),
        'console.log(JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));\n',
      );

      const out = execFileSync(process.execPath, [join(dir, 'release-migrate.mjs')], {
        cwd: root, // deliberately NOT the script's directory
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
      const observed = JSON.parse(out.trim()) as { cwd: string; path: string };

      // macOS resolves the temp dir through a /private symlink, so compare the
      // basename rather than the absolute path.
      expect(observed.cwd.endsWith(dir.split('/').pop() as string)).toBe(true);
      expect(observed.path.startsWith(join(observed.cwd, 'node_modules', '.bin') + ':')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
