import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-2018: `docker/setup-buildx-action@v3` boots BuildKit by
// pulling `moby/buildkit:buildx-stable-1` ANONYMOUSLY from Docker Hub, and when
// Hub is slow or rate-limiting the runner's shared egress IP the job dies in
// ~30 s — before `actions/checkout`, before a line of repo code — leaving a red
// required check on a PR whose diff contains no Dockerfile. Three observations
// across two job families (`Sandbox images`, `Runner image`) before it was
// filed.
//
// Every Docker build now boots through `.github/actions/buildx`, which routes
// BOTH registry paths at a mirror. These assertions keep a future job from
// silently reintroducing the anonymous one — which nothing else would catch,
// since workflow YAML is neither type-checked, linted, nor executed by any
// suite. Same mould, and the same no-YAML-dependency constraint, as
// `tests/ci-postgres-container.test.ts` (MOTIR-1742, the same failure class one
// registry path over).
//
// The assertions are predicates over what the workflows ACTUALLY contain rather
// than a fixed list of today's three call sites: the card's acceptance criterion
// is that the fix reaches every job that boots buildkit, "found by grepping the
// workflows, not by listing today's two."

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');
const ACTION_PATH = join(process.cwd(), '.github/actions/buildx/action.yml');
const ACTION_REF = 'uses: ./.github/actions/buildx';

const UPSTREAM_BUILDX = 'docker/setup-buildx-action';
const UPSTREAM_QEMU = 'docker/setup-qemu-action';
const BUILD_ACTION = 'docker/build-push-action';

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const action = readFileSync(ACTION_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body } without a YAML
 * dependency (the repo has none). Job ids sit at exactly two spaces of
 * indentation; everything in a job body is indented further.
 */
function jobsOf(source: string): Map<string, string> {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  if (jobsAt === -1) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.set(current, body.join('\n'));
      current = header[1]!;
      body = [];
      continue;
    }
    // A non-indented, non-blank line means we've dedented out of `jobs:`.
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/** Executable lines only — a comment must stay free to NAME the thing it
 *  explains, and every comment added by this card names the anonymous path it
 *  replaced. Without this, each assertion below would trip on its own rationale. */
function code(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** Every job across every workflow, as { file, id, body } records. */
const allJobs = workflowFiles.flatMap((file) => {
  const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
  return [...jobsOf(source)].map(([id, body]) => ({ file, id, body: code(body) }));
});

/** Jobs that run a Docker build, i.e. that need a builder at all. */
const buildJobs = allJobs.filter((j) => j.body.includes(BUILD_ACTION));

/**
 * True when an image reference names an explicit non-Docker-Hub registry. A
 * reference's first path segment is a registry host only if it contains a dot;
 * `moby/buildkit` and `tonistiigi/binfmt` therefore resolve to Docker Hub
 * implicitly, which is exactly the failure being guarded.
 */
function isMirrored(ref: string): boolean {
  const host = ref.split('/')[0] ?? '';
  return host.includes('.') && !/^(registry-1\.)?docker\.io$/.test(host);
}

describe('BuildKit pulls through a mirror, never anonymously from Docker Hub (MOTIR-2018)', () => {
  it('finds the workflow jobs it is meant to guard', () => {
    // A parser regression or a wholesale workflow restructure would otherwise
    // make every assertion below pass vacuously — the negative control.
    expect(allJobs.length).toBeGreaterThan(5);
    expect(existsSync(ACTION_PATH)).toBe(true);
    expect(buildJobs.map((j) => `${j.file}:${j.id}`).sort()).toEqual([
      'hosted-agent-image.yml:hosted-agent-image',
      'hosting-guard-image.yml:hosting-guard-image',
      'runner-image.yml:runner-image',
      'sandbox-images.yml:sandbox-profiles',
      'sandbox-images.yml:sandbox-smoke',
    ]);
  });

  it.each(workflowFiles)('%s calls no workflow-level `setup-buildx-action`', (file) => {
    // The upstream action's DEFAULTS are the bug: a job that reaches for it
    // directly gets the anonymous Docker Hub builder back, silently. It is
    // legal in exactly one place — the composite action, asserted below.
    expect(code(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))).not.toContain(UPSTREAM_BUILDX);
  });

  it.each(buildJobs.map((j) => [`${j.file}:${j.id}`, j.body] as const))(
    '%s boots its builder through the mirrored composite action',
    (_name, body) => {
      expect(body).toContain(ACTION_REF);
    },
  );

  it('pins the BUILDER image itself to a mirror', () => {
    // buildkitd does not exist yet when this image is pulled, so its own
    // registry config cannot cover it — the mirror has to be in the reference.
    const image = /driver-opts:\s*image=(\S+)/.exec(code(action))?.[1];
    expect(image).toBeDefined();
    expect(isMirrored(image!)).toBe(true);
  });

  it('routes everything buildkitd pulls AFTERWARDS through a mirror too', () => {
    // The `# syntax=docker/dockerfile:1` frontend both Dockerfiles declare, and
    // every `FROM` base. Pinning only the builder leaves these on the anonymous
    // path — the half-fix this assertion exists to reject.
    const mirrors = /\[registry\."docker\.io"\][\s\S]*?mirrors\s*=\s*\[([^\]]*)\]/.exec(
      action,
    )?.[1];
    expect(mirrors).toBeDefined();
    const hosts = [...mirrors!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(isMirrored(host)).toBe(true);
  });

  it.each(workflowFiles)('%s pulls binfmt from a mirror wherever it registers QEMU', (file) => {
    // Release-lane only (multi-arch), so this one never showed up on the PR
    // path — but it is one more anonymous Docker Hub pull in the same boot
    // sequence, and a release killed by it is worse than a PR re-run.
    const source = code(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    const uses = source.split(/\n(?=\s*-\s)/).filter((step) => step.includes(UPSTREAM_QEMU));
    for (const step of uses) {
      const image = /image:\s*(\S+)/.exec(step)?.[1];
      expect(image, `${file}: setup-qemu-action with no explicit image`).toBeDefined();
      expect(isMirrored(image!)).toBe(true);
    }
  });
});
