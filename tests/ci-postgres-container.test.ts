import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-1742: a GitHub Actions `services:` container is pulled during
// `Initialize containers`, which runs BEFORE `actions/checkout` and has no retry
// hook — so a transient Docker Hub outage killed whole jobs with zero tests run
// (six occurrences in ~24h). Postgres now comes from `.github/actions/postgres`,
// which pulls mirror-first and retries. These assertions keep a future job from
// silently reintroducing the flaky path, which no other test would catch: the
// workflow files are not type-checked, linted, or executed by any suite.

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');
const ACTION_PATH = join(process.cwd(), '.github/actions/postgres/action.yml');
const ACTION_REF = 'uses: ./.github/actions/postgres';

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

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

/** Every job across every workflow, as [file, jobId, body] triples. */
const allJobs = workflowFiles.flatMap((file) => {
  const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
  return [...jobsOf(source)].map(([id, body]) => ({ file, id, body }));
});

/** Jobs that talk to Postgres — the ones that used to declare the service. */
const dbJobs = allJobs.filter((j) => j.body.includes('DATABASE_URL: postgresql://'));

describe('CI Postgres container (MOTIR-1742)', () => {
  it('finds the workflow jobs it is meant to guard', () => {
    // A parser regression (or a wholesale workflow restructure) would otherwise
    // make every assertion below pass vacuously.
    expect(allJobs.length).toBeGreaterThan(5);
    expect(dbJobs.map((j) => `${j.file}:${j.id}`).sort()).toEqual([
      // The acceptance lane, lifted out of the `e2e` matrix into its own
      // `paths:`-filtered workflow by MOTIR-1949, and split by MOTIR-2600 into
      // one build + four sharded test legs. BOTH halves need a database: the
      // build because `pnpm build` runs `prisma migrate deploy` (the same reason
      // `ci.yml:build` has one), the test legs because they seed and drive the
      // app. The matrix does not multiply the entry — a matrix is one job.
      'acceptance-tests.yml:acceptance',
      'acceptance-tests.yml:build',
      // The regression lane (MOTIR-9411): the same build-then-shards shape, for
      // the same two reasons.
      'acceptance-tests.yml:regression',
      'acceptance-tests.yml:regression-build',
      'ci.yml:build',
      'ci.yml:e2e',
      // The volume legs, split out of `e2e` by MOTIR-3148 so they can be gated
      // off the pull-request lane. Same steps, same per-leg ephemeral database
      // — the split changed WHEN they run, not what they need.
      'ci.yml:e2e-at-scale',
      // MOTIR-6826's review-agent coverage lane (Story MOTIR-1626): the story journeys
      // and the per-card server suites it measures run against a real database.
      'ci.yml:story-1626-coverage',
      // Story MOTIR-4753's per-file coverage floor (MOTIR-4761). It measures six
      // files whose specs — the substrate read, the entrance predicate's chain
      // test, the step machine — all run against a real database, per the
      // repository's own convention. Same ephemeral Postgres, started by the
      // shared action rather than declared as a service, exactly like its
      // neighbours.
      'ci.yml:story-4753-coverage',
      // MOTIR-5142's story coverage floor, for the same reason as its neighbour
      // above: the rollup, the children aggregate and the story gate all run
      // against a real database.
      'ci.yml:story-4905-coverage',
      // MOTIR-7281's pages coverage lane (Story MOTIR-5752): the story gate and
      // the per-card page suites it measures run against a real database.
      'ci.yml:story-5752-coverage',
      // MOTIR-6621's story coverage floor: the item read over real delivery rows
      // and the changed-files route both run against a real database.
      'ci.yml:story-6617-coverage',
      // MOTIR-692's hosted-agent-run coverage lane (Story MOTIR-683): the story
      // gate and the per-card hosted-run tests it measures run against a real
      // database.
      'ci.yml:story-683-coverage',
      // MOTIR-6876's agent-instances coverage lane (Story MOTIR-6860): the story
      // gate and the per-card instance tests run against a real database.
      'ci.yml:story-6860-coverage',
      // MOTIR-7296's operator-console coverage lane (Story MOTIR-727): the audited
      // platform reads and the meter reporter it measures run against a real database.
      'ci.yml:story-727-coverage',
      // MOTIR-7644's session-lifecycle coverage lane (Story MOTIR-7630): the end
      // operation, the sweeps and the copy it measures run against a real database.
      'ci.yml:story-7630-coverage',
      // MOTIR-7652's Plan-something-new coverage lane (Story MOTIR-7631): the restart
      // gate and its two doors run against a real database.
      'ci.yml:story-7631-coverage',
      // MOTIR-7806's bug-filing coverage lane (Story MOTIR-7797): the log-bug route,
      // the guide landing and the story gate it measures run against a real database.
      'ci.yml:story-7738-coverage',
      'ci.yml:story-7797-coverage',
      // MOTIR-7832's plan-progress coverage lane (Story MOTIR-7820): the story gate,
      // both signal doors and the Planning read it measures run against a real database.
      'ci.yml:story-7820-coverage',
      // MOTIR-7865's story coverage floor (Story MOTIR-7858): the three MCP
      // code-read tools resolve the project, its repository set and every
      // permission decision against a real database.
      'ci.yml:story-7858-coverage',
      // MOTIR-7892's plan-overlay-only coverage lane (Story MOTIR-7883): the story gate
      // reads real plans and sessions through the real review route.
      'ci.yml:story-7883-coverage',
      // MOTIR-7933's waiting-plan-carry coverage lane (Story MOTIR-7928): the story gate
      // carries real plans between real sessions and races them on separate connections.
      'ci.yml:story-7928-coverage',
      // MOTIR-7981's tool-call narration coverage lane (Story MOTIR-7974): the story gate
      // streams a recorded run through the real anchored route against a real database.
      'ci.yml:story-7974-coverage',
      // MOTIR-8003's talk-to-the-planner coverage lane (Story MOTIR-7990): the story gate
      // drives the ask, settle, late-change and pause doors against a real database.
      'ci.yml:story-7990-coverage',
      // MOTIR-8066's planner-narration coverage lane (Story MOTIR-8060): the story gate
      // drives both step doors and reads the narration back against a real database.
      'ci.yml:story-8060-coverage',
      // MOTIR-8143's story coverage floor (Story MOTIR-8136): the outage faces.
      'ci.yml:story-8136-coverage',
      'ci.yml:story-8684-coverage',
      // MOTIR-9075's run-overlay-parity coverage lane (Story MOTIR-8982): the story gate
      // reads real run rows and legs through the real service.
      'ci.yml:story-8982-coverage',
      'ci.yml:test',
    ]);
  });

  it.each(workflowFiles)('%s declares no Postgres service container', (file) => {
    const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    // `image: postgres:...` under a `services:` block is exactly the pull that
    // `Initialize containers` performs with no in-repo resilience.
    expect(source).not.toMatch(/^\s*image:\s*postgres/m);
  });

  it.each(dbJobs.map((j) => [`${j.file}:${j.id}`, j.body] as const))(
    '%s starts Postgres through the retrying composite action',
    (_label, body) => {
      expect(body).toContain(ACTION_REF);
    },
  );

  it.each(dbJobs.map((j) => [`${j.file}:${j.id}`, j.body] as const))(
    '%s starts Postgres before it runs any command',
    (_label, body) => {
      const lines = body.split('\n');
      const actionAt = lines.findIndex((l) => l.includes(ACTION_REF));
      const firstRunAt = lines.findIndex((l) => /^\s+-?\s*run:/.test(l));
      expect(actionAt).toBeGreaterThanOrEqual(0);
      // A step that shells out before the DB is up (pnpm install → prisma
      // migrate deploy) would fail on a cold connection instead of waiting.
      expect(firstRunAt === -1 || actionAt < firstRunAt).toBe(true);
    },
  );
});

describe('the postgres composite action', () => {
  const action = readFileSync(ACTION_PATH, 'utf8');

  it('is a composite action', () => {
    expect(action).toMatch(/using:\s*composite/);
  });

  it('tries a mirror before Docker Hub', () => {
    // The list is DERIVED from `image-repository` now (MOTIR-2696 moved the
    // default off the official image to `pgvector/pgvector`, a Docker Hub USER
    // repo), so the assertion is on the derivation rather than on three frozen
    // literals. `mirror.gcr.io` is a general Docker Hub pull-through cache and
    // works for any repository; the `public.ecr.aws/docker/library/*` path exists
    // only for OFFICIAL images, so it is added conditionally.
    const sources = [
      ...action.matchAll(/^\s*"([^"]*\$\{IMAGE_REPOSITORY\}:\$\{IMAGE_TAG\})"$/gm),
    ].map((m) => m[1]!);
    expect(sources).toEqual([
      'mirror.gcr.io/${IMAGE_REPOSITORY}:${IMAGE_TAG}',
      '${IMAGE_REPOSITORY}:${IMAGE_TAG}',
    ]);
    // Docker Hub — the registry that went unreachable — must be the LAST
    // resort, not the first thing tried.
    expect(sources.at(-1)).toBe('${IMAGE_REPOSITORY}:${IMAGE_TAG}');
    // The official-image mirror is still reached for, when it applies.
    expect(action).toMatch(/public\.ecr\.aws\/docker\/library\/postgres:\$\{IMAGE_TAG\}/);
  });

  it('retries the pull beyond the runner built-in 3 attempts', () => {
    // Sources × 3 rounds of pull attempts, vs. the runner's 3 against a single
    // registry.
    expect(action).toMatch(/for attempt in 1 2 3/);
    expect(action).toMatch(/sleep "\$\{backoff\}"/);
    expect(action).toMatch(/::error::Could not pull \$\{IMAGE_REPOSITORY\}:\$\{IMAGE_TAG\}/);
  });

  it('keeps docker-compose on the SAME image and locale as CI', () => {
    // Local dev and CI disagreeing about either is how a suite goes green on one
    // and red on the other for reasons no assertion names — which is exactly what
    // MOTIR-2696 spent a CI round learning. Both files carry a comment pointing
    // at the other; this is the check that makes the pointer true.
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/image:\s*pgvector\/pgvector:pg16/);
    expect(compose).toMatch(/POSTGRES_INITDB_ARGS:\s*'--locale=C\.UTF-8'/);
  });

  it('runs an image that carries pgvector (MOTIR-2696)', () => {
    // `work_item_embedding`'s migration runs `CREATE EXTENSION vector`, which
    // fails outright on the plain `postgres` image — so every CI job that applies
    // migrations needs this one. Guarded here because the workflow files are not
    // type-checked, linted or executed by any other suite.
    expect(action).toMatch(/default:\s*pgvector\/pgvector/);
    expect(action).toMatch(/default:\s*pg16/);
  });

  it("PINS the initdb locale to production's byte-ordering collation", () => {
    // The other half of the image move, and the one that cost three red shards:
    // the pgvector image is glibc, whose default `en_US.utf8` is a DICTIONARY
    // collation, while production (Neon) is `C.UTF-8` — byte ordering, which is
    // what every base-62 `position` / `backlogRank` column depends on. The alpine
    // image matched production only because musl collates by byte regardless.
    // `tests/db-collation.test.ts` asserts the resulting ORDERING at runtime;
    // this asserts the action still asks for it.
    expect(action).toMatch(/default:\s*C\.UTF-8/);
    expect(action).toMatch(/POSTGRES_INITDB_ARGS="--locale=\$\{INITDB_LOCALE\}"/);
  });

  it('waits for the container to report healthy before yielding', () => {
    expect(action).toMatch(/--health-cmd "pg_isready/);
    expect(action).toMatch(/State\.Health\.Status/);
    expect(action).toMatch(/did not become healthy/);
  });
});
