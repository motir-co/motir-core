import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PROFILES } from '../src/agentProfiles.js';

// Drift guards for the sandbox VALIDATION harness (7.9.7c / MOTIR-885) — the
// smoke scripts, the profile/liveness matrix, and the workflow that runs them —
// plus the RELEASE lane that publishes what that matrix built (7.9.7e /
// MOTIR-1788). Both callers are asserted here because the publish gate IS the
// shared matrix: an image nothing smoke-tested must not be able to reach GHCR.
//
// The harness itself is a docker build plus a container run: 15+ minutes, and
// unavailable to anyone without a daemon. So the expensive lane checks the
// ARTIFACT, and this suite checks that the lane is still WIRED and still
// describes the same set of agents as the CLI's own profile table. A renamed
// binary, an agent added to AGENT_PROFILES, or a `run:` line quietly deleted
// fails here in milliseconds instead of surfacing as a green matrix that tested
// nothing.
//
// The companion suite is `sandbox.test.ts` (7.9.7a/b), which guards the image
// SOURCES — Dockerfile, entrypoint, install arms, compose, devcontainers.

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_DIR = join(CLI_DIR, 'sandbox', 'smoke');
const WORKFLOW_DIR = join(CLI_DIR, '..', '..', '.github', 'workflows');

const read = (path: string): string => readFileSync(path, 'utf8');

const installAgent = read(join(CLI_DIR, 'sandbox', 'install-agent.sh'));
const ci = read(join(WORKFLOW_DIR, 'ci.yml'));
// The matrix itself (7.9.7c) and the tagged lane that publishes what it built
// (7.9.7e). One matrix, two callers — which is the property this file guards.
const images = read(join(WORKFLOW_DIR, 'sandbox-images.yml'));
const release = read(join(WORKFLOW_DIR, 'release-sandbox.yml'));
const readme = read(join(CLI_DIR, 'sandbox', 'README.md'));

/**
 * The `sandbox:` job in `ci.yml`, and only it — from its own key to the next
 * top-level job key, with comments stripped.
 *
 * ⚠️ This used to be `ci.slice(ci.indexOf('  sandbox:'))`, i.e. slice-to-EOF,
 * which was the same thing ONLY while `sandbox:` was the last job in the file.
 * MOTIR-1978 appended a `runner-image:` job after it, at which point the
 * "the pull-request lane cannot push" assertion below silently started guarding
 * a job it knows nothing about — and failed on that job's COMMENT explaining
 * that it, too, has no `packages: write`. Both halves are fixed here: the window
 * is the sandbox job, and a comment is not a permission grant.
 */
const sandboxJob = (() => {
  // Comments are dropped BEFORE the window is cut, not after: a job's
  // documentation sits above its key, so a window that ends at the next key
  // would otherwise swallow the next job's entire comment block.
  const lines = ci.split('\n').filter((line) => !line.trim().startsWith('#'));
  const start = lines.findIndex((line) => line === '  sandbox:');
  // Loud rather than an empty window silently passing every assertion below.
  if (start === -1) throw new Error('ci.yml has no `sandbox:` job — this suite guards nothing');
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
})();
const runSh = read(join(SMOKE_DIR, 'run.sh'));
const loopSh = read(join(SMOKE_DIR, 'loop-smoke.sh'));
const confinementSh = read(join(SMOKE_DIR, 'confinement.sh'));
const fakeAgentSh = read(join(SMOKE_DIR, 'fake-agent.sh'));

interface MatrixProfile {
  id: string;
  tier: 1 | 2;
  liveness: string;
}

const matrix = (JSON.parse(read(join(SMOKE_DIR, 'profiles.json'))) as { profiles: MatrixProfile[] })
  .profiles;

/** A profile's case arm in install-agent.sh — its own label up to the next `;;`. */
const armOf = (id: string): string => {
  const start = new RegExp(`^\\s{4}${id}\\)$`, 'm').exec(installAgent);
  if (!start) return '';
  const rest = installAgent.slice(start.index);
  const end = rest.indexOf('\n        ;;');
  return end === -1 ? rest : rest.slice(0, end);
};

describe('the CI build/liveness matrix', () => {
  it('covers EVERY agent profile the CLI knows about, at the same tier', () => {
    // The matrix is what CI iterates. A profile added to AGENT_PROFILES but not
    // here would ship an install arm no job ever builds.
    expect(matrix.map((p) => p.id).sort()).toEqual(AGENT_PROFILES.map((p) => p.id).sort());
    for (const profile of AGENT_PROFILES) {
      const entry = matrix.find((p) => p.id === profile.id);
      expect(entry?.tier, `tier for ${profile.id}`).toBe(profile.tier);
    }
  });

  it('names the four Tier-1 profiles the sandbox matrix pins', () => {
    // Tier 1 is the gating set — these four must BUILD AND RUN for a pull
    // request to be green, so demoting one is a decision, not a typo.
    expect(
      matrix
        .filter((p) => p.tier === 1)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['claude', 'codex', 'kimi', 'opencode']);
  });

  it('runs the liveness command install-agent.sh actually installs', () => {
    // The trap this closes: `binary` in agentProfiles.ts is a LOOKUP KEY, not
    // the installed command — `antigravity` installs `agy`, `cursor` installs
    // `agent`. Taking the liveness command from the id would make those two
    // matrix legs fail with "command not found" 15 minutes into a docker build.
    for (const profile of matrix) {
      const arm = armOf(profile.id);
      expect(arm, `install arm for ${profile.id}`).not.toBe('');
      const versionLine = /^\s+(\S+) --version$/m.exec(arm);
      expect(versionLine, `a --version smoke test in the ${profile.id} arm`).not.toBeNull();
      expect(profile.liveness, `liveness command for ${profile.id}`).toBe(
        `${versionLine?.[1]} --version`,
      );
    }
  });
});

describe('the sandbox smoke harness', () => {
  const scripts = [
    'run.sh',
    'loop-smoke.sh',
    'failure-smoke.sh',
    'confinement.sh',
    'env-credential-smoke.sh',
    'login-smoke.sh',
    'readonly-login-smoke.sh',
    'entrypoint-bypass-smoke.sh',
    'agent-update-smoke.sh',
    'runtimes-smoke.sh',
    'home-seed-smoke.sh',
    'fake-agent.sh',
    'failing-agent.sh',
    'stub-server.mjs',
    'assert-run.mjs',
    join('bin', 'gh'),
  ];

  it('ships every script, each EXECUTABLE', () => {
    // The scripts are mounted into the container through /workspace, not baked
    // into the image, so the committed mode bit is what makes them runnable —
    // a 0644 file fails with "permission denied" inside the container only.
    for (const name of scripts) {
      const path = join(SMOKE_DIR, name);
      expect(existsSync(path), `${name} exists`).toBe(true);
      expect(statSync(path).mode & 0o111, `${name} is executable`).not.toBe(0);
    }
  });

  it('runs the container through the DOCUMENTED mount recipe', () => {
    // The whole confinement claim is a property of HOW the container is
    // launched. A smoke run that mounted something else would assert nothing
    // about what users actually run.
    expect(runSh).toContain('-v "$FIXTURE:/workspace"');
    expect(runSh).toContain('-v "$CREDENTIAL:/home/node/.config/motir:ro"');
    expect(runSh).toContain('/workspace/.smoke/confinement.sh');
    expect(runSh).toContain('/workspace/.smoke/loop-smoke.sh');
    // The FAILURE path only reproduces under the real read-only credential
    // mount (MOTIR-1836), so it has to run in the container too — a driver that
    // stopped at the happy path is how the defect stayed invisible.
    expect(runSh).toContain('/workspace/.smoke/failure-smoke.sh');
    // …and so does the login REFUSAL, for the same reason: it is the read-only
    // mount that makes the write fail.
    expect(runSh).toContain('/workspace/.smoke/readonly-login-smoke.sh');
    // The three runtimes, asserted as `node` (MOTIR-6204) — FIRST in the chain,
    // because a missing runtime explains any later failure in it and nothing
    // later explains a missing runtime. Read from the `bash -c` CHAIN rather
    // than the file: this driver documents its suites in a header comment too,
    // and an ordering assertion over the whole file would compare two mentions
    // in prose and pass for the wrong reason.
    const chain = runSh.slice(runSh.indexOf("bash -c '/workspace/.smoke/"));
    expect(chain).toContain('/workspace/.smoke/runtimes-smoke.sh');
    expect(chain.indexOf('/workspace/.smoke/runtimes-smoke.sh')).toBeLessThan(
      chain.indexOf('/workspace/.smoke/confinement.sh'),
    );
  });

  it('runs the MOUNT-FREE recipes as their own container runs (MOTIR-1877)', () => {
    // Whether a credential mount exists cannot be simulated from inside a
    // container that has one — the same argument the confinement suite rests on.
    // So the env tier and the in-container login each get a run of their own,
    // launched WITHOUT the credential bind.
    const mountFree = runSh.slice(runSh.indexOf('the mount-free recipes'));
    expect(mountFree).toContain('/workspace/.smoke/env-credential-smoke.sh');
    expect(mountFree).toContain('/workspace/.smoke/login-smoke.sh');
    expect(mountFree).toContain('-e "MOTIR_TOKEN=env-not-a-real-token"');
    expect(mountFree).toContain('-e "MOTIR_SERVER=http://127.0.0.1:$ENV_PORT"');
    // THE assertion: neither mount-free run may carry the credential bind, or
    // the tier under test would never be the one that supplied the credential.
    expect(mountFree).not.toContain('/home/node/.config/motir');
  });

  it('runs the persistent-home recipes with a directory mounted over /home/node (MOTIR-6887)', () => {
    // A user agent instance boots with a volume over the image's HOME, and
    // whether HOME is a mount is a property of the LAUNCH — so both cases are
    // container runs of their own: an empty home the entrypoint must seed, and a
    // populated one it must leave byte-for-byte.
    const legs = runSh.slice(runSh.indexOf('the persistent-home recipes'));
    expect(legs).toContain('-v "$HOME_EMPTY:/home/node"');
    expect(legs).toContain('/workspace/.smoke/home-seed-smoke.sh empty');
    expect(legs).toContain('-v "$HOME_POPULATED:/home/node"');
    expect(legs).toContain('/workspace/.smoke/home-seed-smoke.sh populated "$RC_SHA" "$USER_SHA"');
    // …and the leg refuses to pass on the image's own home.
    const script = read(join(SMOKE_DIR, 'home-seed-smoke.sh'));
    expect(script).toContain('/proc/self/mounts');
  });

  it('makes each mount-free leg PROVE the bind is absent before asserting anything', () => {
    // A driver edit that re-added the mount would otherwise leave both legs
    // green while testing the old path — the failure mode is a test that still
    // passes, which is the worst kind.
    for (const name of ['env-credential-smoke.sh', 'login-smoke.sh']) {
      const script = read(join(SMOKE_DIR, name));
      expect(script, `${name} reads the mount table`).toContain('/proc/self/mounts');
      expect(script, `${name} refuses a pre-existing credential`).toContain('config.json');
    }
  });

  it('drives `motir login` against the stub REAL device routes, not a mock', () => {
    // The login is the one command that speaks something other than MCP, so the
    // stub has to serve `/api/cli/device/*` for the leg to mean anything.
    const stub = read(join(SMOKE_DIR, 'stub-server.mjs'));
    expect(stub).toContain('/api/cli/device/start');
    expect(stub).toContain('/api/cli/device/token');
    expect(stub).toContain('authorization_pending');
    const loginSh = read(join(SMOKE_DIR, 'login-smoke.sh'));
    expect(loginSh).toContain('motir login --server "$SERVER" --no-browser');
    // The credential it wrote must then be USED — a file appearing proves less
    // than a read that succeeds because of it.
    expect(loginSh).toContain('motir ready');
  });

  it('runs the entrypoint-bypass guard on EVERY profile leg (MOTIR-4956)', () => {
    // The defect this reproduces is invisible to every other check in this
    // workflow: the image builds, `motir --version` runs, the liveness command
    // runs — all through the ENTRYPOINT, which is precisely the thing a
    // devcontainer replaces. The guard has to launch the container the way the
    // published recipe does, or it asserts nothing about that route.
    expect(images).toContain('packages/cli/sandbox/smoke/entrypoint-bypass-smoke.sh');
    expect(images).toContain('--profile ${{ matrix.profile.id }}');
    const guard = read(join(SMOKE_DIR, 'entrypoint-bypass-smoke.sh'));
    expect(guard).toContain('--entrypoint /bin/bash');
    // Both shell shapes a devcontainer produces, and the failure names the card.
    expect(guard).toContain("check 'login shell' -lc");
    // ⚠️ The second arm must be INTERACTIVE. Debian's stock ~/.bashrc opens
    // with `case $- in *i*) ;; *) return;; esac`, so `bash -c '. ~/.bashrc'`
    // returns before the line the image appends and the guard reports UNSET —
    // blaming the product for the check's own shape. That is exactly what this
    // guard did on its first CI run, with the login-shell arm passing beside it.
    expect(guard).toContain("check 'interactive non-login shell' -ic");
    // …and stdin stays open for it, while no `-t` is asked for: a CI runner has
    // no tty, and bash needs none to run `-c`.
    expect(guard).toContain('docker run --rm -i --entrypoint /bin/bash');
    expect(guard).not.toContain('docker run --rm -it');
    expect(guard).toContain('MOTIR-4956');
    // It must demand the image-owned home, not merely a non-empty value: the
    // read-only mount is a perfectly non-empty path and is the wrong answer.
    expect(guard).toContain('EXPECTED_PREFIX=/home/node/.motir-sandbox/agent-config');
  });

  it('runs the agent-update guard on EVERY profile leg (MOTIR-6183)', () => {
    // The built image, as node: the agent resolves under the node-owned prefix
    // and can be rewritten by its own updater; motir stays root-owned.
    expect(images).toContain('packages/cli/sandbox/smoke/agent-update-smoke.sh');
    expect(images).toContain('--liveness "${{ matrix.profile.liveness }}"');
    const guard = read(join(SMOKE_DIR, 'agent-update-smoke.sh'));
    expect(guard).toContain('--entrypoint /bin/bash');
    expect(guard).toContain('AGENT_PREFIX=/opt/motir-agents');
    expect(guard).toContain('/usr/local/bin/motir');
    expect(guard).toContain('/usr/local/lib/node_modules/@motir/cli');
    expect(guard).toContain('MOTIR-6183');
  });

  it('asserts the read-only login fails as ONE SENTENCE, never as a stack', () => {
    // MOTIR-1836's class: a supported configuration used correctly must not
    // surface as a raw errno.
    const roSh = read(join(SMOKE_DIR, 'readonly-login-smoke.sh'));
    expect(roSh).toContain('Could not write the credential');
    expect(roSh).toContain('MOTIR_TOKEN');
    expect(roSh).toContain("'Unexpected error' 'EROFS'");
  });

  it('gives the failure leg its OWN stub port, and a CREDENTIAL that covers it', () => {
    // The credential mount is READ-ONLY, so every port any suite will speak to
    // has to be minted before the container starts. A suite on a port the
    // credential does not carry dies with "Not logged in to http://127.0.0.1:…"
    // before it dispatches anything — which is a startup failure wearing the
    // costume of the thing the suite was meant to assert.
    const loopPort = /MOTIR_SMOKE_PORT:-(\d+)/.exec(
      readFileSync(join(SMOKE_DIR, 'loop-smoke.sh'), 'utf8'),
    )?.[1];
    const failurePort = /MOTIR_SMOKE_PORT_FAILURE:-(\d+)/.exec(
      readFileSync(join(SMOKE_DIR, 'failure-smoke.sh'), 'utf8'),
    )?.[1];
    expect(loopPort).toBeDefined();
    expect(failurePort).toBeDefined();
    expect(failurePort).not.toBe(loopPort);

    // Both ports resolve in run.sh, are carried into the container, and each has
    // its own entry in the read-only credential.
    expect(runSh).toContain(`MOTIR_SMOKE_PORT_FAILURE:-${failurePort}`);
    expect(runSh).toContain('-e "MOTIR_SMOKE_PORT_FAILURE=$FAILURE_PORT"');
    expect(runSh).toContain('"http://127.0.0.1:$PORT"');
    expect(runSh).toContain('"http://127.0.0.1:$FAILURE_PORT"');
  });

  it('agrees with the loop script about the stub port', () => {
    // The credential mount is READ-ONLY, so the server URL it carries is fixed
    // before the run starts — the stub must listen on exactly that port.
    const portOf = (source: string): string | undefined =>
      /MOTIR_SMOKE_PORT:-(\d+)/.exec(source)?.[1];
    expect(portOf(runSh)).toBeDefined();
    expect(portOf(loopSh)).toBe(portOf(runSh));
    expect(runSh).toContain('"http://127.0.0.1:$PORT"');
  });

  it('drives the loop with a fake agent and no real credential', () => {
    expect(loopSh).toMatch(/motir auto --agent "\$SMOKE_DIR\/fake-agent\.sh"/);
    expect(runSh).toContain('smoke-not-a-real-token');
  });

  it('asserts the REQUEST SEQUENCE, not just the exit code', () => {
    // A loop that skipped the integration record, or read the ready set ahead in
    // a batch, would still exit 0.
    //
    // ⚠️ RE-POINTED, not lowered (MOTIR-2436). This named the four MCP TOOLS the
    // loop used to call; the CLI is an `/api/v1` client since 11.5.6, so it names
    // the four ENDPOINTS instead. Deleting the check would have been the easy
    // fix and the wrong one — what it guards is that `assert-run.mjs` still
    // covers every step of the loop, and that claim survived the protocol
    // change unchanged.
    expect(loopSh).toContain('assert-run.mjs');
    const assertRun = read(join(SMOKE_DIR, 'assert-run.mjs'));
    for (const endpoint of ['/ready', '/dispatch-prompt', '/transitions', '/integration']) {
      expect(assertRun, `assertion covering ${endpoint}`).toContain(endpoint);
    }
    // …and it must not have quietly gone back to asserting a protocol nothing
    // speaks: a `tools/call` here would mean the stub and the CLI disagree again.
    expect(assertRun).not.toContain('tools/call: ');
  });

  it('makes the fake agent verify BOTH prompt delivery channels', () => {
    // agentRun.ts delivers the prompt on stdin AND at $MOTIR_PROMPT_FILE. An
    // agent that only read one would leave the other free to rot.
    expect(fakeAgentSh).toContain('MOTIR_PROMPT_FILE');
    expect(fakeAgentSh).toContain('stdin_prompt');
    expect(fakeAgentSh).toContain('"$stdin_prompt" != "$file_prompt"');
  });
});

describe('the confinement assertions', () => {
  it('cover the read-only credential mount, the system tree and the docker socket', () => {
    expect(confinementSh).toContain('docker.sock');
    expect(confinementSh).toContain('refute_write "$CONFIG_DIR"');
    expect(confinementSh).toMatch(/refute_write "\$dir"/);
    expect(confinementSh).toContain('/usr/local/bin');
  });

  it('refuses a container running as root', () => {
    expect(confinementSh).toContain('if [ "$(id -u)" -eq 0 ]');
  });

  it('reads the MOUNT TABLE rather than trusting the documentation', () => {
    // The blast-radius claim is about host binds; /proc/self/mounts is the only
    // thing that actually knows what they are.
    expect(confinementSh).toContain('/proc/self/mounts');
    expect(confinementSh).toContain('undocumented host bind');
  });
});

describe('the CI jobs that run all of it', () => {
  it('are PULL-REQUEST triggered, so they gate a merge', () => {
    // notes.html #49: an inherited workflow with `on: push: main` LOOKS like CI
    // and gates nothing. Assert the trigger, never the file's existence.
    expect(ci).toMatch(/^on:\n\s+pull_request:/m);
    // The matrix is reusable, so it has no trigger of its own — the caller's
    // does. A `uses:` that pointed somewhere else would take the whole lane
    // with it.
    expect(ci).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(images).toMatch(/^on:\n\s+workflow_call:/m);
  });

  it('build the image and run the smoke driver', () => {
    expect(images).toContain('sandbox-smoke:');
    expect(images).toContain('file: packages/cli/sandbox/Dockerfile');
    expect(images).toContain('packages/cli/sandbox/smoke/run.sh --no-build');
  });

  it('give the base job a ceiling the RELEASE lane fits under, and push only after build + smoke', () => {
    // MOTIR-7217: the release lane's two-platform push of the base takes ~16
    // min, and the job ran 22m36s / 26m16s / 25m49s on cli-v0.9.0 / 0.10.0 /
    // 0.11.0 against a 25-minute ceiling. Two of those were cancelled with every
    // step green, and the verify and README jobs that `need` this one never ran.
    // Pin the floor at 1.5x the slowest observed run, not at a round number.
    const from = images.indexOf('\n  sandbox-smoke:\n');
    expect(from, 'sandbox-images.yml still has a `sandbox-smoke:` job').toBeGreaterThan(-1);
    const rest = images.slice(from + 1);
    const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    const job = next === -1 ? rest : rest.slice(0, next + 1);

    const ceiling = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]);
    const slowestReleaseMinutes = 26 + 16 / 60;
    expect(ceiling).toBeGreaterThanOrEqual(Math.ceil(1.5 * slowestReleaseMinutes));

    // The publish gate: the push is a LATER step of the job that built and
    // smoked the image, so a failing build or smoke never reaches it.
    const build = job.indexOf('- name: Build the base image');
    const smoke = job.indexOf('- name: Smoke the image');
    const push = job.indexOf('- name: Push the base image');
    expect(build).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(build);
    expect(push).toBeGreaterThan(smoke);
  });

  it('derive the profile matrix from profiles.json instead of restating it', () => {
    // Restating the agent list in YAML is the drift this whole suite exists to
    // prevent; reading the file means adding an agent extends CI by itself.
    expect(images).toContain('packages/cli/sandbox/smoke/profiles.json');
    expect(images).toContain('fromJson(needs.sandbox-profiles-matrix.outputs.profiles)');
  });

  it('run BOTH `motir --version` and the agent liveness check per profile', () => {
    expect(images).toContain(
      'docker run --rm motir-sandbox:${{ matrix.profile.id }} motir --version',
    );
    expect(images).toContain(
      'docker run --rm motir-sandbox:${{ matrix.profile.id }} ${{ matrix.profile.liveness }}',
    );
  });

  it('allow-fails Tier 2 on the PR lane only — a release gates on every tier', () => {
    // "Allow-fail, not removed" is 7.9.7c's posture: a vendor endpoint flaking
    // must not red-X an unrelated pull request, but the leg still runs and still
    // reports. A RELEASE that shipped six of eight images, green, is worse than
    // one that failed — so the exemption is scoped to the non-publish lane.
    expect(images).toContain(
      'continue-on-error: ${{ matrix.profile.tier == 2 && !inputs.publish }}',
    );
    expect(images).toContain('fail-fast: false');
  });

  it('skips when the diff cannot reach an image, like the other heavy lanes', () => {
    // The CLAIM is unchanged and the MECHANISM moved (MOTIR-3148). This lane
    // used to skip on the branch PREFIX — `seed/` / `design/` / `docs/` — which
    // is a guess about the diff read off a naming convention. It now reads the
    // `changes` job, which computes the same exclusion from the diff itself.
    //
    // Windowed to the NEXT job key rather than sliced to EOF: `ci.indexOf` +
    // an open-ended slice equals "this job" only while `sandbox:` is the last
    // job in the file, and it no longer is.
    const from = ci.indexOf('\n  sandbox:\n');
    expect(from, 'ci.yml still has a `sandbox:` job').toBeGreaterThan(-1);
    const rest = ci.slice(from + 1);
    const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    const call = next === -1 ? rest : rest.slice(0, next + 1);

    expect(call).toContain("needs.changes.outputs.images == 'true'");
    expect(call, 'the call job needs the job it reads').toMatch(/^\s*needs:.*\bchanges\b/m);
    expect(call, 'no branch-name gate survives here').not.toContain('startsWith(github.head_ref');

    // And the exclusion this test was written for still holds at the source:
    // a design-only or docs-only diff sets neither flag. Asserting only the
    // wiring above would pass a `changes` job that had stopped excluding them.
    const changes = ci.slice(ci.indexOf('\n  changes:\n'));
    expect(changes).toMatch(/docs\/\*\|design\/\*\|scripts\/plan-seed\/\*\|\*\.md/);
  });
});

describe('the release lane that publishes the images (7.9.7e)', () => {
  it('is TAG-triggered on the @motir/cli release tag — never a push to main', () => {
    // Same notes.html #49 discipline as above, pointed the other way: a
    // `:latest` that moves on every merge is not a reproducible sandbox, so the
    // ABSENCE of a branch trigger is the load-bearing assertion.
    expect(release).toMatch(/^on:\n\s+push:\n\s+tags:\n\s+- 'cli-v\*'/m);
    expect(release).not.toMatch(/^\s+branches:/m);
  });

  it('guards the tag against the packages/cli version, so image and npm agree', () => {
    expect(release).toContain('${GITHUB_REF_NAME#cli-v}');
    expect(release).toContain("require('./packages/cli/package.json').version");
  });

  it('runs the SAME matrix, with publishing switched on', () => {
    // The whole gating argument depends on this being one workflow, not two: a
    // release-only matrix could build the image its own way and ship something
    // no smoke test ever ran.
    expect(release).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(ci).toContain('publish: false');
    expect(release).toMatch(/publish: \$\{\{ !\(github\.event_name == 'workflow_dispatch'/);
  });

  it('pushes only AFTER the smoke and liveness checks, in the same job', () => {
    // The publish gate is step ORDER inside one job: a failed check stops the
    // job before anything leaves the runner. Assert the order, because a
    // re-shuffle would silently publish an unverified image.
    const smoked = images.indexOf('- name: Smoke the image');
    const pushedBase = images.indexOf('- name: Push the base image');
    expect(smoked).toBeGreaterThan(-1);
    expect(pushedBase).toBeGreaterThan(smoked);

    const liveness = images.indexOf('- name: ${{ matrix.profile.liveness }}');
    const pushedProfile = images.indexOf('- name: Push ${{ matrix.profile.id }}');
    expect(liveness).toBeGreaterThan(-1);
    expect(pushedProfile).toBeGreaterThan(liveness);
  });

  it('authenticates with GITHUB_TOKEN under packages: write — no new secret', () => {
    expect(release).toContain('packages: write');
    expect(images).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
    // Any OTHER secret reference would mean an out-of-band credential someone
    // has to provision and rotate — exactly what GHCR + the job token avoids.
    const secrets = [...images.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)]).toEqual(['GITHUB_TOKEN']);
    // ...and the pull-request lane must not be able to push at all.
    // Scoped to the sandbox job itself (see `sandboxJob` above) — a sibling job
    // further down the file is not this suite's business, and the sandbox job
    // being last was never the property under test.
    expect(sandboxJob).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(sandboxJob).not.toContain('packages: write');
  });

  it('tags each profile both movably and immutably, for both architectures', () => {
    expect(images).toContain('${{ env.IMAGE }}:${{ matrix.profile.id }}');
    expect(images).toContain(
      '${{ env.IMAGE }}:${{ matrix.profile.id }}-${{ steps.ver.outputs.version }}',
    );
    expect(images).toContain('${{ env.IMAGE }}:base');
    expect(images).toContain('${{ env.IMAGE }}:base-${{ steps.ver.outputs.version }}');
    expect(images).toContain('platforms: linux/amd64,linux/arm64');
  });

  it('names the registry in LOWERCASE, the only form docker will pull', () => {
    // `ghcr.io/Motir-Co/...` is not a reference docker will even resolve —
    // OCI repository names are lowercase-only, and it fails before any network
    // call. The org is spelled `moooon-B-V` everywhere else, so this is a real
    // trap rather than a style point.
    expect(images).toContain('IMAGE: ghcr.io/motir-co/motir-sandbox');
    // Comments are exempt — the header explains the trap by SPELLING the
    // uppercase form out. Only references the workflow would actually push to
    // or pull from have to be lowercase.
    const yamlOnly = images
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(yamlOnly).not.toMatch(/ghcr\.io\/\S*[A-Z]/);
    expect(readme).not.toMatch(/ghcr\.io\/\S*[A-Z]/);
  });

  it('verifies the published images by PULLING them back, by digest', () => {
    // "The push exited 0" and "the bytes are in the registry and they run" are
    // different claims. The digest is the only reference that names the exact
    // bytes the moving tag pointed at.
    expect(images).toContain('sandbox-published:');
    expect(images).toContain('docker run --rm "${IMAGE}@${digest}" motir --version');
    expect(images).toContain('needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles]');
    // A profile whose leg was dropped uploads no digest — that must fail the
    // release rather than pass as a smaller one.
    expect(images).toContain('No digest was published for');
  });

  // ── A release that half-publishes says so, and a re-run finishes it (MOTIR-10884)
  // `cli-v0.17.2` lost six of nine pushes to an intermittent GHCR `denied`, every
  // check of the published set was SKIPPED because it needed every leg, and the
  // re-run rebuilt all nine and moved three immutable tags. These pin the three
  // fixes: the push is retried apart from the build, a job that names what is
  // missing runs whatever the legs did, and a re-run builds only what is missing.
  describe('and survives a refused push, names a partial release, and re-publishes only the gap', () => {
    const jobOf = (source: string, id: string): string => {
      const lines = source.split('\n').filter((line) => !line.trim().startsWith('#'));
      const start = lines.findIndex((line) => line === `  ${id}:`);
      if (start === -1) throw new Error(`sandbox-images.yml has no \`${id}:\` job`);
      const after = lines.slice(start + 1);
      const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
      return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
    };
    const base = jobOf(images, 'sandbox-smoke');
    const legs = jobOf(images, 'sandbox-profiles');
    const setup = jobOf(images, 'sandbox-profiles-matrix');
    const complete = jobOf(images, 'sandbox-complete');

    it.each([
      [
        'base',
        base,
        '- name: Build the base image for both architectures',
        '- name: Push the base image',
      ],
      [
        'profile',
        legs,
        '- name: Build ${{ matrix.profile.id }} for both architectures',
        '- name: Push ${{ matrix.profile.id }}',
      ],
    ])('builds the %s image ONCE, then pushes it through the retry', (_name, job, build, push) => {
      const built = job.indexOf(build);
      const pushed = job.indexOf(push);
      expect(built, 'a separate two-platform build step').toBeGreaterThan(-1);
      expect(pushed).toBeGreaterThan(built);
      const buildStep = job.slice(built, pushed);
      const pushStep = job.slice(pushed);
      // The build pushes nothing, so a failure there is a build failure and is
      // never retried; the cache it writes cannot fail the release either.
      expect(buildStep).not.toContain('push: true');
      expect(buildStep).toContain('platforms: linux/amd64,linux/arm64');
      expect(buildStep).toMatch(/cache-to: type=gha,[^\n]*,ignore-error=true/);
      // The push is the script around the push COMMAND, reading the digest the
      // record step needs from buildx's metadata file.
      expect(pushStep).toContain('node packages/cli/sandbox/smoke/push-with-retry.mjs');
      expect(pushStep).toContain('--github-output "$GITHUB_OUTPUT"');
      expect(pushStep).toContain('-- docker buildx build');
      expect(pushStep).toContain('--platform linux/amd64,linux/arm64');
      expect(pushStep).toContain('--push');
      expect(pushStep).toContain('id: push');
      expect(pushStep).not.toContain('docker/build-push-action');
    });

    it('plans the release from the registry, and skips what this version already has', () => {
      expect(setup).toContain('node packages/cli/sandbox/smoke/release-set.mjs plan');
      expect(setup).toContain('--digests "$DIGESTS"');
      expect(setup).toContain(
        'profiles: ${{ inputs.publish && steps.plan.outputs.profiles || steps.read.outputs.profiles }}',
      );
      // The already-published digests join the same artifact family the verify
      // jobs and the README record read, so they see the WHOLE release.
      expect(setup).toContain('name: sandbox-digest-already-published');
      // ...and the pull-back still checks every image, not only the ones this run pushed.
      expect(setup).toContain('all_profiles: ${{ steps.read.outputs.profiles }}');
      expect(jobOf(images, 'sandbox-published')).toContain(
        'PROFILES: ${{ needs.sandbox-profiles-matrix.outputs.all_profiles }}',
      );
      expect(base).toContain('needs: sandbox-profiles-matrix');
      expect(base).toContain(
        "if: ${{ !inputs.publish || needs.sandbox-profiles-matrix.outputs.base_published != 'true' }}",
      );
      // An empty matrix is a hard error, so a fully published re-run skips the legs.
      expect(legs).toContain("if: ${{ needs.sandbox-profiles-matrix.outputs.profiles != '[]' }}");
    });

    it('names every missing image in a job that runs however the legs ended', () => {
      expect(complete).toContain('if: ${{ inputs.publish && !cancelled() }}');
      expect(complete).toContain(
        'needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles]',
      );
      expect(complete).toContain('node packages/cli/sandbox/smoke/release-set.mjs verify');
      expect(complete).toContain('--profiles packages/cli/sandbox/smoke/profiles.json');
      // Anonymous, like `sandbox-public`: the consumer's question.
      expect(complete).not.toContain('docker/login-action');
      expect(complete).not.toContain('packages:');
      expect(complete).toMatch(/permissions:\n\s+contents: read\n/);
    });

    it('ships both scripts with a typed contract, like their neighbours', () => {
      for (const name of ['push-with-retry', 'release-set']) {
        expect(existsSync(join(SMOKE_DIR, `${name}.mjs`))).toBe(true);
        expect(existsSync(join(SMOKE_DIR, `${name}.d.mts`))).toBe(true);
      }
    });
  });

  // ── The consumer's question (MOTIR-2010) ─────────────────────────────────
  // `sandbox-published` above pulls as the PUBLISHER, for whom a private package
  // is pullable — which is how `cli-v0.1.0` shipped nine images that no user
  // could obtain, green. These assertions guard the job that asks the question
  // as a stranger, and above all guard the property that makes its answer worth
  // anything: that it holds no credential.
  describe('and then asks whether a STRANGER can pull them', () => {
    /** The `sandbox-public:` job window — its own key to the next top-level job
     *  key (or EOF), comments stripped. Same cut as `sandboxJob` above, and for
     *  the same reason: "this job contains no login" is a claim about THIS job,
     *  and a slice-to-EOF would quietly start including whatever lands next. */
    const publicJob = (() => {
      const lines = images.split('\n').filter((line) => !line.trim().startsWith('#'));
      const start = lines.findIndex((line) => line === '  sandbox-public:');
      if (start === -1) {
        throw new Error('sandbox-images.yml has no `sandbox-public:` job — MOTIR-2010 regressed');
      }
      const after = lines.slice(start + 1);
      const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
      return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
    })();

    it('runs on the release lane only, after everything has been published', () => {
      // `!failure()` so a re-run that SKIPPED an already-published job still
      // asks (MOTIR-10884); still the release lane only.
      expect(publicJob).toContain('if: ${{ inputs.publish && !cancelled() && !failure() }}');
      expect(publicJob).toContain(
        'needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles, sandbox-published]',
      );
    });

    it('holds NO credential — no login, and no `packages:` scope to log in with', () => {
      // The load-bearing assertion of this whole card. A `docker/login-action`
      // step, or a `packages:` grant, would turn the check back into the one
      // that already existed and already passed while the images were private.
      expect(publicJob).not.toContain('docker/login-action');
      expect(publicJob).not.toContain('packages:');
      expect(publicJob).toMatch(/permissions:\n\s+contents: read\n/);
    });

    it('probes every published DIGEST, not the moving tags', () => {
      expect(publicJob).toContain(
        'node packages/cli/sandbox/smoke/assert-public.mjs --image "$IMAGE" --digests digests',
      );
      expect(publicJob).toContain('pattern: sandbox-digest-*');
    });

    it('then runs the command docs/cli.md actually prints, on the profile it names', () => {
      // A readable manifest and a working `docker run` are not the same claim
      // either — and the documented onboarding path is the second one.
      expect(publicJob).toContain('digest=$(cat digests/claude)');
      expect(publicJob).toContain('docker run --rm "${IMAGE}@${digest}" motir --version');
      const documented = read(join(CLI_DIR, '..', '..', 'docs', 'cli.md'));
      expect(documented).toContain('ghcr.io/motir-co/motir-sandbox:claude');
    });
  });

  // ── And whether what it pulled CONTAINS the documented commands (MOTIR-2612) ─
  // The gap the two jobs above leave between them: one asks the publisher's
  // question of a version number, the other asks the consumer's question of a
  // pull. Neither reads the command set, so `/docs/sandbox` could — and for five
  // days did — instruct a command the image did not have.
  describe('and whether the CLI inside carries every command the docs name', () => {
    /** The `sandbox-commands:` job window. Same cut as `publicJob`, and for the
     *  same reason: "this job contains no login" is a claim about THIS job. */
    const commandsJob = (() => {
      const lines = images.split('\n').filter((line) => !line.trim().startsWith('#'));
      const start = lines.findIndex((line) => line === '  sandbox-commands:');
      if (start === -1) {
        throw new Error('sandbox-images.yml has no `sandbox-commands:` job — MOTIR-2612 regressed');
      }
      const after = lines.slice(start + 1);
      const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
      return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
    })();

    it('runs on the release lane only, after everything has been published', () => {
      expect(commandsJob).toContain('if: ${{ inputs.publish && !cancelled() && !failure() }}');
      expect(commandsJob).toContain(
        'needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles, sandbox-published]',
      );
    });

    it('holds NO credential — no login, and no `packages:` scope to log in with', () => {
      // The load-bearing assertion. The absence of a login step reads as an
      // oversight to anyone tidying this file later — logging in is what the
      // neighbouring job does and it would make this one marginally simpler —
      // and re-crediting it would turn the check back into one we run on
      // ourselves, which is how the same question got asked from the wrong side
      // in MOTIR-2010 and answered from the wrong ref in MOTIR-2611.
      expect(commandsJob).not.toContain('docker/login-action');
      expect(commandsJob).not.toContain('packages:');
      expect(commandsJob).not.toContain('secrets.');
      expect(commandsJob).toMatch(/permissions:\n\s+contents: read\n/);
    });

    it('checks every published DIGEST, via the script rather than YAML logic', () => {
      // Every profile's image, not just `:claude` — a profile whose build picked
      // up a different CLI is exactly the kind of thing one tag cannot show.
      expect(commandsJob).toContain(
        'node packages/cli/sandbox/smoke/assert-commands.mjs --image "$IMAGE" --digests digests',
      );
      expect(commandsJob).toContain('pattern: sandbox-digest-*');
      expect(existsSync(join(SMOKE_DIR, 'assert-commands.mjs'))).toBe(true);
      expect(existsSync(join(SMOKE_DIR, 'assert-commands.d.mts'))).toBe(true);
    });

    it('needs no Docker daemon, so it can check EVERY platform in the index', () => {
      // A `docker run` tests the runner's own architecture and nothing else,
      // while the index publishes amd64 and arm64 and every reader on an
      // M-series Mac gets the second. The registry-API route is also what lets a
      // human run this mid-investigation, which is the tool MOTIR-2611's
      // diagnosis did not have.
      expect(commandsJob).not.toContain('docker run');
      expect(commandsJob).not.toContain('docker/setup-qemu-action');
    });

    it('derives its expectation from the GUIDE, with no second list to drift', () => {
      // The property that makes the check maintenance-free: adding a
      // `cliCommands` entry to a guide step changes what the job asserts. A
      // hand-kept copy would eventually disagree with the page, and a check that
      // confidently asserts the wrong thing is worse than no check.
      const script = read(join(SMOKE_DIR, 'assert-commands.mjs'));
      expect(script).toContain("export const DEFAULT_GUIDE_PATH = 'lib/apiDocs/sandbox.ts'");
      const guide = read(join(CLI_DIR, '..', '..', 'lib', 'apiDocs', 'sandbox.ts'));
      expect(guide).toMatch(/cliCommands:\s*\['login'\]/);
      // The commands must NOT be restated in the script or the workflow — that
      // is the whole point, and it is a one-line diff away from being lost.
      expect(commandsJob).not.toMatch(/--(commands|expect)\b/);
      const derivation = script.slice(script.indexOf('export function parseCliCommands'));
      expect(derivation).not.toMatch(/'(login|link|doctor)'/);
    });
  });

  // ── The RECORD, not a claim (MOTIR-2699) ─────────────────────────────────
  // Everything above checks something about the published artifact. This job
  // writes the artifact's record — § Published images — which was retyped from a
  // job summary for four releases and skipped in one of them. These assertions
  // guard the properties that make an automated table worth as much as the hand
  // one: that it reads the registry rather than the summary, that it can FAIL,
  // and that it cannot commit nothing.
  describe('and then RECORDS what it published, in the README', () => {
    /** The `readme:` job window — its own key to the next top-level job key (or
     *  EOF), comments stripped. Same cut as `sandboxJob`, for the same reason. */
    const readmeJob = (() => {
      const lines = release.split('\n').filter((line) => !line.trim().startsWith('#'));
      const start = lines.findIndex((line) => line === '  readme:');
      if (start === -1) {
        throw new Error('release-sandbox.yml has no `readme:` job — MOTIR-2699 regressed');
      }
      const after = lines.slice(start + 1);
      const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
      return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
    })();

    it('runs on a real TAG only, after every image has been published and proven', () => {
      // A dry-run dispatch publishes nothing, so there is no release to record and
      // no digest artifact to read. `needs: images` covers the whole called
      // workflow, which includes the anonymous-pull and command checks — the
      // record is written only about images that passed them.
      expect(readmeJob).toContain('needs: images');
      expect(readmeJob).toContain("github.event_name == 'push' || (");
      // A Publish latest re-publish (MOTIR-10886) is a non-dry dispatch on the
      // `cli-v*` tag itself, and its pushed tags are recorded too.
      expect(readmeJob).toContain("github.event_name == 'workflow_dispatch' && !inputs.dry_run &&");
      expect(readmeJob).toContain("startsWith(github.ref, 'refs/tags/cli-v')");
    });

    it('edits MAIN, not the tag it was triggered by', () => {
      // A tag-triggered run checks out the tag's tree. Writing that copy would
      // revert whatever main has learned since the tag was cut, so the checkout is
      // pinned to the branch the record belongs on.
      expect(readmeJob).toContain('ref: main');
      // It reaches `main` through a pull request rather than a direct push
      // (MOTIR-3967): `main` carries a merge-queue ruleset that refuses one
      // outright — `GH013 ... Changes must be made through the merge queue`.
      expect(readmeJob).toContain('--base main');
      expect(readmeJob).toContain('gh pr create');
      expect(readmeJob).not.toContain('git push origin HEAD:main');
    });

    it('holds contents: READ and NO registry scope — it reads GHCR anonymously', () => {
      // It held `contents: write` while it pushed to `main` with the automatic
      // token. The branch push and the pull request are the App's now, so the
      // automatic token needs no write at all and does not get one.
      expect(readmeJob).toContain('contents: read');
      expect(readmeJob).not.toContain('contents: write');
      expect(readmeJob).not.toContain('packages:');
      expect(readmeJob).not.toContain('docker/login-action');
    });

    it('introduces no NEW secret — it reuses the release App, provisioning nothing', () => {
      // It used to name no secret at all, because the automatic token was the whole
      // credential. That token cannot open a pull request here (the repository's
      // "Allow GitHub Actions to create and approve pull requests" is off) and a
      // pull request it pushed would run no checks, so it could never clear the
      // merge queue. This job therefore borrows the App the release lane already
      // provisions — the SAME two secrets, nothing to add and nothing more to
      // rotate. Asserting the exact set is what keeps a third one from creeping in.
      expect(
        [...new Set([...readmeJob.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort(),
      ).toEqual(['RELEASE_APP_ID', 'RELEASE_APP_PRIVATE_KEY']);
    });

    it('names the SAME image repository the publish matrix pushes to', () => {
      // Two files name it now. This is the drift guard that keeps them one value —
      // a record written about a different repository than the one published to
      // would be wrong in the least visible way possible.
      const imageOf = (yaml: string) => /^\s*IMAGE: (\S+)$/m.exec(yaml)?.[1];
      expect(imageOf(release)).toBe(imageOf(images));
      expect(imageOf(release)).toBe('ghcr.io/motir-co/motir-sandbox');
    });

    it('calls the script rather than reimplementing the table in YAML', () => {
      // The invariants, the anonymous read and the no-op detection are unit-tested
      // in `sandboxDigestTable.test.ts`. A `run:` block that rendered rows itself
      // would be none of that, and this lane's commit starts no CI run.
      expect(readmeJob).toContain('node packages/cli/sandbox/smoke/render-digest-table.mjs');
      expect(readmeJob).toContain('--write');
      // Reads the version from the TAG, which the guard job has already pinned to
      // packages/cli/package.json — not from a second lookup that could disagree.
      expect(readmeJob).toContain('${TAG#cli-v}');
      expect(readmeJob).not.toMatch(/sha256:/);
      expect(existsSync(join(SMOKE_DIR, 'render-digest-table.mjs'))).toBe(true);
      expect(existsSync(join(SMOKE_DIR, 'render-digest-table.d.mts'))).toBe(true);
    });

    it('cross-checks the registry against what the push jobs recorded', () => {
      // The digests the push uploaded are handed over precisely so the two
      // readings can disagree and fail the release.
      expect(readmeJob).toContain('pattern: sandbox-digest-*');
      expect(readmeJob).toContain('--digests digests');
    });

    it('commits ONLY the README, authored as the CLA signatory, with no trailer', () => {
      expect(readmeJob).toContain('-- packages/cli/sandbox/README.md');
      expect(readmeJob).toContain("--author='Zhu Yue <zhuyue11@gmail.com>'");
      expect(readmeJob).not.toContain('Co-Authored-By');
      expect(readmeJob).not.toMatch(/git add -A|git commit -a/);
    });

    it('commits nothing at all when the release changed nothing', () => {
      // Criterion 5 of MOTIR-2699, as the workflow sees it: the commit step is
      // gated on the script's own verdict, so a re-run of an already-recorded tag
      // produces no commit rather than an empty one.
      expect(readmeJob).toContain("if: ${{ steps.render.outputs.changed == 'true' }}");
    });

    it('never forces anything onto main — the only force is its own per-tag branch', () => {
      // The rebase-and-retry loop this replaces was written for the race it named,
      // a merge landing between checkout and push. A ruleset is not a race, so the
      // loop could only burn three attempts and fail. What survives is the property
      // it existed to protect: this lane must never force over `main`.
      expect(readmeJob).not.toMatch(/push[^\n]*--force[^\n]*main\b(?!-)/);
      expect(readmeJob).not.toContain('git pull --rebase origin main');
      // The force it does use is confined to the branch that carries this tag's
      // record, so a re-run updates that branch instead of opening a second
      // pull request.
      expect(readmeJob).toContain('git push --force origin "HEAD:${branch}"');
      expect(readmeJob).toContain('branch="chore/sandbox-digests-${TAG}"');
    });

    it('leaves the README carrying the frame the next demotion needs', () => {
      // The section that is CURRENT is the one the next release demotes, and the
      // demotion is a bounded replacement rather than a regex over English. Losing
      // this frame does not corrupt anything — the lane refuses and says so — but
      // it stops the record cold, so it is guarded here rather than discovered on
      // a release.
      expect(readme).toContain('<!-- sandbox-digests:currency start -->');
      expect(readme).toContain('<!-- sandbox-digests:currency end -->');
      expect(readme).toMatch(/<!-- sandbox-digests:release cli-v\d+\.\d+\.\d+ -->/);
      // Exactly one section may claim to be the current release.
      expect(readme.match(/this is the current release/g)).toHaveLength(1);
    });

    it('no longer tells a human to paste the digest table anywhere', () => {
      // The sentence this whole card exists to delete, in all three places that
      // carried it: the summary the lane prints, the release procedure, and the
      // README's own account of where the digests come from.
      expect(images).not.toContain('Paste the table above');
      // Where the old wording survives in the procedure it is quoted as history,
      // not given as an instruction.
      expect(release).toMatch(/used to read "copy its digest table/);
      expect(release).toMatch(/RECORDS the digest table/);
      expect(readme).not.toMatch(/they are\s*\na transcription/);
    });
  });
});

// ── The tripwire for the gap BETWEEN releases (MOTIR-2131) ─────────────────
// Everything above guards the release lane, and the release lane was working:
// `cli-v0.1.0` built, smoke-tested, published and (after MOTIR-2129) served
// nine images anyone could pull. It was simply five days and eleven commits
// out of date, so the image greeted every new user with a credential banner
// naming one of the three tiers `docs/cli.md` promises, and `motir login` was
// not in it at all. No lane here fires between releases, by design — which is
// exactly why the drift needed its own scheduled check.
describe('the staleness tripwire that watches the gap between releases', () => {
  const staleness = read(join(WORKFLOW_DIR, 'sandbox-staleness.yml'));

  it('is SCHEDULED, and deliberately not part of the pull-request lane', () => {
    // The trigger is the design decision. A PR job would go red for a condition
    // its author did not cause and cannot fix, which is how a check gets muted
    // — and a muted check is indistinguishable from a passing one.
    expect(staleness).toMatch(/^on:\n\s+schedule:\n(\s+#.*\n)*\s+- cron:/m);
    expect(staleness).toContain('workflow_dispatch:');
    expect(ci).not.toContain('sandbox-staleness');
  });

  it('checks out with FULL history and tags — the whole check depends on it', () => {
    // A shallow checkout has no tags to compare against and cannot walk
    // `<tag>..HEAD`. The script refuses to answer in that case rather than
    // reporting "up to date", so without this the job can only ever say
    // "could not tell" — a check that never checks anything.
    expect(staleness).toMatch(/uses: actions\/checkout@v6\n\s+with:\n\s+fetch-depth: 0/);
  });

  it('calls the script rather than reimplementing the comparison in YAML', () => {
    // Same split as `sandbox-public` and `assert-public.mjs`: the logic is a
    // zero-dependency script with unit tests and a human can run it from any
    // shell; the workflow is a caller. Logic inlined into a `run:` block is
    // testable only by pushing to main.
    expect(staleness).toContain('node packages/cli/sandbox/smoke/assert-current.mjs');
    expect(existsSync(join(SMOKE_DIR, 'assert-current.mjs'))).toBe(true);
    expect(existsSync(join(SMOKE_DIR, 'assert-current.d.mts'))).toBe(true);
  });

  it('needs no registry credential, no Docker and no packages: scope', () => {
    // It answers a question about git, not about a registry. Any credential
    // here would be scope this job has no use for.
    expect(staleness).toMatch(/permissions:\n\s+contents: read/);
    expect(staleness).not.toContain('packages:');
    expect(staleness).not.toContain('docker/login-action');
    expect(staleness).not.toContain('secrets.');
  });

  it('passes the dispatch input through the environment, not into the shell', () => {
    // `${{ inputs.… }}` inside a `run:` body is substituted before bash sees
    // it, so a crafted value would be executed rather than passed.
    expect(staleness).toContain('MAX_AGE_DAYS: ${{ inputs.max_age_days }}');
    expect(staleness).toMatch(/args\+=\(--max-age-days "\$MAX_AGE_DAYS"\)/);
    expect(staleness).not.toMatch(/assert-current\.mjs.*\$\{\{/);
  });

  it('watches the tag prefix both release lanes actually key on', () => {
    // A bare `v*` would fire for the app too, which is why the lanes are
    // package-scoped — and why a tripwire watching a different prefix would
    // silently measure against nothing.
    const script = read(join(SMOKE_DIR, 'assert-current.mjs'));
    expect(script).toContain("export const TAG_PREFIX = 'cli-v'");
    expect(release).toContain("- 'cli-v*'");
  });
});

describe('the README, as the adoption path', () => {
  it('leads with `docker run` on the published image, not a git clone', () => {
    const run = readme.indexOf('## Run');
    const build = readme.indexOf('## Build it yourself');
    expect(run).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(run);
    expect(readme).toContain('ghcr.io/motir-co/motir-sandbox:claude');
  });

  it('documents the mounts the run contract is made of — and which one is optional', () => {
    expect(readme).toContain('-v "$PWD:/workspace"');
    expect(readme).toContain('-v "$HOME/.config/motir:/home/node/.config/motir:ro"');
    expect(readme).toContain('-v "$HOME/.claude:/home/node/.claude:ro"');
    // The mount-free form is what a machine with no prior host login runs, so it
    // is part of the adoption path, not a footnote (MOTIR-1877).
    expect(readme).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    expect(readme).toContain('### Three ways to give it a Motir credential');
  });

  it('records a digest per published tag and shows how to pin one', () => {
    expect(readme).toContain('ghcr.io/motir-co/motir-sandbox@sha256:');
    for (const profile of matrix) {
      expect(readme, `a published-image row for ${profile.id}`).toContain(
        `| \`ghcr.io/motir-co/motir-sandbox:${profile.id}\``,
      );
    }
    expect(readme).toContain('| `ghcr.io/motir-co/motir-sandbox:base`');
  });

  it('keeps the build-from-source path for anyone customising a profile', () => {
    expect(readme).toContain('docker build -f packages/cli/sandbox/Dockerfile');
  });
});
