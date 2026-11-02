import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import type { ContainerOrchestrator } from '@motir/orchestrator';

// THE RUNNER IMAGE's sources, guarded against drift (MOTIR-1978).
//
// The image itself is built, asserted and proven by `.github/workflows/
// runner-image.yml` — the claims that need a BUILT artifact live there, the same
// division `sandboxCi.test.ts` / `sandbox-images.yml` uses for the sandbox. What
// this file guards is everything checkable without Docker, plus the one thing
// neither side can check alone: that the env key the ORCHESTRATOR emits is the
// env key the ENTRYPOINT reads.
//
// That last one is the reason this file is in `tests/ciFleet/` rather than
// beside the Dockerfile. `buildSpec()` and `entrypoint.sh` are a contract with
// two authors and no shared type; renaming the variable on either side is a
// silent, total boot failure that every existing test would still pass —
// `ciRunnerBootService.test.ts` asserts the spec's key, and a shell script
// asserts nothing at all. Only a test that reads BOTH catches it.

const ROOT = process.cwd();
const IMAGE_DIR = join(ROOT, 'infra/ci-runner');
const dockerfile = readFileSync(join(IMAGE_DIR, 'Dockerfile'), 'utf8');
const entrypoint = readFileSync(join(IMAGE_DIR, 'entrypoint.sh'), 'utf8');
const startDockerd = readFileSync(join(IMAGE_DIR, 'start-dockerd.sh'), 'utf8');
const proveBoot = readFileSync(join(IMAGE_DIR, 'smoke/prove-boot.sh'), 'utf8');
const ciYml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const imageYml = readFileSync(join(ROOT, '.github/workflows/runner-image.yml'), 'utf8');
const releaseYml = readFileSync(join(ROOT, '.github/workflows/release-runner-image.yml'), 'utf8');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');

/** Executable lines only — comments explain the security property and must be
 *  free to name the thing they explain (see `smoke/assert-image.sh`'s header). */
function code(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/\s*#.*$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

describe('§7.2 — the image is digest-pinned and nothing in it floats', () => {
  it('builds FROM a digest, not a tag', () => {
    // The digest reaches FROM through an ARG so it is bumpable in one place and
    // overridable at build time; the ARG's own value is asserted to be 64 hex
    // below, so the indirection loses nothing. What is forbidden is the TAG
    // form — `FROM ubuntu:24.04`.
    const from = dockerfile.split('\n').find((l) => l.startsWith('FROM '))!;
    expect(from).toMatch(/@(sha256:[0-9a-f]{64}|\$\{[A-Z0-9_]+\})\s*$/);
  });

  it('carries no floating tag', () => {
    expect(code(dockerfile)).not.toMatch(/:latest|:stable|:edge|:main/);
  });

  it('pins every version exactly and every digest to 64 hex', () => {
    // `[A-Z0-9_]+`, with the digits: `RUNNER_SHA256` has one, and a name
    // pattern without it matched only 5 of the 8 ARGs — silently leaving every
    // checksum unverified while the test stayed green. Which is what the
    // count assertion below is for.
    const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)=(\S+)$/gm)].map(
      (m) => [m[1]!, m[2]!] as const,
    );
    expect(args.length).toBeGreaterThanOrEqual(8);
    expect(args.filter(([n]) => /_SHA256$/.test(n)).length).toBeGreaterThanOrEqual(3);
    for (const [name, value] of args) {
      if (/_SHA256$|^UBUNTU_DIGEST$/.test(name)) {
        expect(`${name}=${value}`).toMatch(/=(sha256:)?[0-9a-f]{64}$/);
      } else if (/_VERSION$/.test(name)) {
        expect(`${name}=${value}`).toMatch(/=\d+(\.\d+)+$/);
      }
    }
  });

  it('checksum-verifies every download', () => {
    const body = code(dockerfile);
    const downloads = body.match(/curl -fsSLo/g)?.length ?? 0;
    const checks = body.match(/sha256sum -c -/g)?.length ?? 0;
    expect(downloads).toBeGreaterThan(0);
    // An unverified download is an unpinned artifact wearing a pinned file's
    // clothes — the digest pin buys nothing if the layers it names were fetched
    // from a mutable URL with no integrity check.
    expect(checks).toBe(downloads);
  });
});

describe('§7.4 — the container holds NO registration capability', () => {
  it('deletes config.sh rather than merely not using it', () => {
    expect(dockerfile).toMatch(/rm -f config\.sh config\.cmd/);
  });

  it('never mentions config.sh in executable Dockerfile code except to remove it', () => {
    // Two permitted shapes, and only two: the `rm` that deletes it, and the
    // build-time `test ! -e` that fails the BUILD if the rm ever stops applying
    // (a runner tarball that relocated the script would otherwise ship one).
    const offenders = code(dockerfile)
      .split('\n')
      .filter((l) => l.includes('config.sh') && !/rm -f|test ! -e/.test(l));
    expect(offenders).toEqual([]);
  });

  it('never mentions a registration token anywhere in executable code', () => {
    expect(code(dockerfile).toLowerCase()).not.toContain('registration');
    expect(code(entrypoint).toLowerCase()).not.toContain('registration');
  });

  it('never sets RUNNER_ALLOW_RUNASROOT — the runner drops to an unprivileged user', () => {
    expect(code(dockerfile)).not.toContain('RUNNER_ALLOW_RUNASROOT');
    expect(code(entrypoint)).not.toContain('RUNNER_ALLOW_RUNASROOT');
    // ubuntu-latest parity: an unprivileged `runner` with passwordless sudo and
    // docker-group membership, which is what customer workflows are written for.
    expect(dockerfile).toMatch(/useradd .*--uid 1001 .*runner/);
    expect(dockerfile).toMatch(/usermod -aG docker runner/);
    expect(dockerfile).toMatch(/runner ALL=\(ALL\) NOPASSWD:ALL/);
  });
});

describe('the boot contract — the orchestrator and the entrypoint agree', () => {
  // The spec the orchestrator actually builds, not a restated copy of it.
  const spec = ciRunnerBootService.buildSpec({
    intent: {
      id: 'intent-1',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      repoOwner: 'motir-projects',
      repoName: 'demo',
      // The rest of the row is irrelevant to the env block under test.
    } as Parameters<typeof ciRunnerBootService.buildSpec>[0]['intent'],
    workflowJobId: 42,
    projectId: 'proj-1',
    encodedJitConfig: 'ZW5jb2RlZC1qaXQ=',
    timeoutSeconds: 60,
    orchestrator: {} as ContainerOrchestrator,
  });

  it('the entrypoint reads the exact JIT env key buildSpec emits', () => {
    // Both halves asserted from their real source. A rename on either side —
    // the one failure that silently bricks every boot — fails HERE.
    expect(Object.keys(spec.env)).toContain('ACTIONS_RUNNER_INPUT_JITCONFIG');
    expect(code(entrypoint)).toContain('ACTIONS_RUNNER_INPUT_JITCONFIG');
  });

  it('the entrypoint requires the JIT config rather than booting without one', () => {
    // `: "${VAR:?message}"` — a Machine booted without the credential fails
    // immediately instead of starting dockerd and timing out expensively.
    expect(entrypoint).toMatch(/:\s*"\$\{ACTIONS_RUNNER_INPUT_JITCONFIG:\?/);
  });

  it('execs run.sh with --jitconfig, and execs it (so the runner is PID 1s child)', () => {
    // `exec`, not a background process: `run.sh` exiting must be the CONTAINER
    // exiting, which is what Fly's `auto_destroy: true` turns into a destroyed
    // Machine (§7.1). A supervising parent would keep the container resident.
    expect(code(entrypoint)).toMatch(/exec setpriv[\s\S]*?run\.sh --jitconfig "\$\{JITCONFIG\}"/);
  });

  it('strips the credential from the environment the job steps inherit', () => {
    expect(code(entrypoint)).toContain('env -u ACTIONS_RUNNER_INPUT_JITCONFIG');
  });

  it('does not forward ACTIONS_RUNNER_CONFIG_ARGS to the JIT path', () => {
    // It is a `config.sh` flag and this image has no `config.sh`. The guarantee
    // it restates — no default labels — is already made at mint time by the JIT
    // config's own `labels` array, which is why dropping it is correct rather
    // than a lost requirement. buildSpec still sets it; the entrypoint logs it.
    expect(spec.env['ACTIONS_RUNNER_CONFIG_ARGS']).toBe('--no-default-labels');
    expect(code(entrypoint)).not.toMatch(/run\.sh.*ACTIONS_RUNNER_CONFIG_ARGS/);
  });
});

describe('dockerd must be able to unpack a layer, not merely answer (MOTIR-8821)', () => {
  it('the entrypoint starts dockerd through the script that proves a whiteout unpack', () => {
    expect(code(entrypoint)).toContain('motir-ci-runner-dockerd');
    expect(code(entrypoint)).not.toMatch(/^\s*dockerd /m);
    expect(code(dockerfile)).toContain('start-dockerd.sh /usr/local/bin/motir-ci-runner-dockerd');
  });

  it('probes with a layer that deletes a file, and falls back through the storage candidates', () => {
    const body = code(startDockerd);
    expect(body).toContain('.wh.gone');
    expect(body).toContain('docker create');
    for (const candidate of ['default', 'overlay2', 'vfs']) {
      expect(body).toMatch(new RegExp(`${candidate}\\)`));
    }
    // A boot that finds no working candidate fails rather than serving jobs.
    expect(body).toMatch(/die "no dockerd storage candidate/);
  });

  it('prints the storage outcome into the job log through the runner hook', () => {
    expect(code(entrypoint)).toContain(
      'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/motir-ci-runner-job-started.sh',
    );
    expect(code(dockerfile)).toContain(
      'job-started.sh /usr/local/bin/motir-ci-runner-job-started.sh',
    );
    expect(code(startDockerd)).toContain('/run/motir-ci-runner-docker-storage');
  });

  it('the boot smoke pulls a whiteout-bearing image through the production script', () => {
    expect(code(proveBoot)).toContain('motir-ci-runner-dockerd');
    expect(code(proveBoot)).toContain('docker pull pgvector/pgvector:pg18');
    expect(code(proveBoot)).not.toContain('MOTIR_RUNNER_SKIP_DOCKER');
  });
});

describe('containers dockerd starts can resolve names (MOTIR-8899)', () => {
  it('passes explicit resolvers to dockerd, since the Machine resolver is unreachable from the bridge', () => {
    const body = code(startDockerd);
    expect(body).toContain('DOCKER_DNS="${MOTIR_RUNNER_DOCKER_DNS-1.1.1.1 8.8.8.8}"');
    expect(body).toMatch(/dockerd --host=unix:\/\/\$\{SOCK\} \$\(dns_args\)/);
    expect(body).toContain('--dns=');
  });

  it('reports the resolvers in the storage line the job log prints', () => {
    expect(code(startDockerd)).toContain('container dns:');
  });
});

describe('the derived toolchain — every entry traces to a starter workflow', () => {
  // The card's rule: the toolchain is the UNION of what the two starters'
  // workflows actually install, and "a toolchain entry with no evidence line is
  // not in the image." These assert the union is still THERE — a layer deleted
  // to shrink the image silently reopens the parity gap §8 is about, because
  // every job would then install it again on the customer's metered clock.
  it.each([
    ['node 22 (setup-node@v4, node-version: 22)', /NODE_VERSION=22\./],
    ['the node tool cache (a setup-node cache hit, not a download)', /hostedtoolcache\/node/],
    ['docker (services: postgres:16-alpine)', /DOCKER_VERSION=/],
    ['git (checkout fetch-depth: 0 + git diff)', /\bgit \\/],
    ['jq + curl (cleanup-preview-deployments.yml)', /\bjq \\/],
    ['playwright chromium system libraries', /install-deps chromium/],
    ['the actions runner itself', /RUNNER_VERSION=/],
  ])('installs %s', (_label, pattern) => {
    expect(dockerfile).toMatch(pattern);
  });

  it('records the file:line evidence for the derivation in the Dockerfile itself', () => {
    // The evidence table is the card's deliverable as much as the layers are: a
    // future reader must be able to check an entry against the workflow that
    // justified it without re-deriving the whole set.
    expect(dockerfile).toContain('ci.yml:');
    expect(dockerfile).toContain('nextjs-prisma-vercel-starter');
  });

  it('bakes pipx with venv support and puts its install dir on PATH (MOTIR-8884)', () => {
    // motir-ai's Vitest shards run `pipx install lizard` with no setup step; the
    // fleet died there with `pipx: command not found`.
    const run = code(dockerfile);
    expect(run).toMatch(/^\s+pipx \\$/m);
    expect(run).toMatch(/^\s+python3-venv \\$/m);
    expect(run).toContain('ENV PATH="/home/runner/.local/bin:${PATH}"');
    expect(readFileSync(join(IMAGE_DIR, 'smoke/assert-image.sh'), 'utf8')).toContain(
      "'pipx --version'",
    );
  });

  it('does NOT bake a chromium binary — it is version-coupled to the repo', () => {
    expect(code(dockerfile)).not.toMatch(/playwright.*install chromium|PLAYWRIGHT_BROWSERS_PATH/);
  });
});

describe('the CI lanes', () => {
  it('the pull-request lane builds the image and cannot publish', () => {
    expect(ciYml).toContain('uses: ./.github/workflows/runner-image.yml');
    // Comments stripped, and the window ends at the job's own `publish: false`.
    // Both matter: a comment is not a permission grant, and slicing to EOF from
    // a job that happens to be last is a trap that only springs when someone
    // appends the NEXT job — which is precisely how this PR broke
    // `sandboxCi.test.ts`'s equivalent assertion.
    const job = ciYml
      .slice(ciYml.indexOf('  runner-image:'))
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(job).toMatch(/publish: false/);
    expect(job.slice(0, job.indexOf('publish: false'))).not.toContain('packages: write');
  });

  it('the release lane runs the SAME workflow with the push switched on', () => {
    expect(releaseYml).toContain('uses: ./.github/workflows/runner-image.yml');
    expect(releaseYml).toContain('packages: write');
    expect(releaseYml).toMatch(/tags:\s*\n\s*- 'runner-v\*'/);
  });

  it('asserts and proves the image BEFORE any push step', () => {
    const assertAt = imageYml.indexOf('assert-image.sh --image');
    const proveAt = imageYml.indexOf('prove-boot.sh');
    const pushAt = imageYml.indexOf('id: push');
    expect(assertAt).toBeGreaterThan(-1);
    expect(proveAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(-1);
    // The ordering IS the publish gate — the same property `sandbox-images.yml`
    // relies on. A push that ran before the proof would ship an unproven image.
    expect(assertAt).toBeLessThan(pushAt);
    expect(proveAt).toBeLessThan(pushAt);
  });

  it('emits the DIGEST and re-verifies the published image by it', () => {
    expect(imageYml).toContain('steps.push.outputs.digest');
    expect(imageYml).toContain('Verify the published image BY DIGEST');
    expect(imageYml).toContain('MOTIR_RUNNER_IMAGE');
  });

  it('records the compressed size §6 attributes boot latency to', () => {
    expect(imageYml).toContain('Measure the compressed size');
    expect(imageYml).toContain('Compressed (pulled over the network)');
  });

  it('the smoke scripts are executable', () => {
    for (const script of ['smoke/assert-image.sh', 'smoke/prove-boot.sh']) {
      // Committed without the bit, the workflow step fails with a bare
      // "Permission denied" that reads like a runner problem.
      expect(statSync(join(IMAGE_DIR, script)).mode & 0o111).toBeGreaterThan(0);
    }
  });
});

describe('MOTIR_RUNNER_IMAGE is documented', () => {
  it('.env.example explains that it takes a digest and who sets it', () => {
    expect(envExample).toContain('MOTIR_RUNNER_IMAGE');
    expect(envExample).toContain('sha256:');
    // The card that wires the value into the deployment — without the pointer,
    // a reader finds the variable and no path to a real value.
    expect(envExample).toContain('MOTIR-1979');
  });

  it('.env.example documents the sibling variables the adapter also demands', () => {
    // `flyFleetConfig()` pushes all three onto its `missing` list; documenting
    // one of three still leaves the fleet unbootable for the next reader.
    for (const key of ['FLY_FLEET_API_TOKEN', 'FLY_FLEET_APP', 'FLY_FLEET_REGION']) {
      expect(envExample).toContain(key);
    }
  });
});
