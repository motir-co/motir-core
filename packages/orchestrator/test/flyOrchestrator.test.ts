import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  FLEET_METADATA_KEY,
  FLEET_METADATA_VALUES,
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
  createFlyOrchestrator,
  exitCodeOf,
  flyFleetConfig,
  flyOrchestrator,
  isFlyFleetConfigured,
  isPreStartState,
  isTerminalState,
  startedAtOf,
  stoppedAtOf,
  toFlyMachine,
  type ContainerHandle,
  type ContainerSpec,
  type UsageAttribution,
} from '../src/index';

// The FLY adapter's wire (Story MOTIR-1916 · MOTIR-1921) — what the port turns
// into on `api.machines.dev`, and what each provider answer means.
//
// The assertions the card names as acceptance criteria live here: the create
// request carries the two independent single-use guarantees (§7.1's
// `auto_destroy` + `restart: no`), teardown produces exactly one usage row on
// every path, and the reaper destroys by AGE against the PROVIDER's list rather
// than against anything Motir remembers.
//
// No database. `fetch` is the only fake.

const APP = 'motir-ci-fleet';
const IMAGE = 'registry.fly.io/motir-ci-runner@sha256:abc123';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  /** The deadline's `AbortSignal` — null is the regression MOTIR-2011 fixed. */
  signal: AbortSignal | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fly's machine JSON, with the events array the §5 timestamps come from. */
function machine(
  overrides: {
    id?: string;
    state?: string;
    region?: string;
    createdAt?: string | null;
    metadata?: Record<string, string> | null;
    /** Loosely typed on purpose: an `exit` event nests its code under
     *  `request.exit_event`, and several cases here feed deliberately malformed
     *  timestamps to prove the parser tolerates them. */
    events?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'd8901ab',
    name: 'motir-runner-44001',
    state: overrides.state ?? 'started',
    region: overrides.region ?? 'iad',
    created_at:
      overrides.createdAt === null
        ? undefined
        : (overrides.createdAt ?? '2026-08-02T10:00:00.000Z'),
    updated_at: '2026-08-02T10:00:05.000Z',
    config: {
      metadata:
        overrides.metadata === null
          ? {}
          : (overrides.metadata ?? { [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.ci_runner }),
    },
    events: overrides.events ?? [
      { type: 'start', status: 'started', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
    ],
  };
}

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: IMAGE,
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'secret-config' },
  timeoutSeconds: 3600,
  region: 'iad',
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

const HANDLE: ContainerHandle = {
  provider: 'fly',
  id: 'd8901ab',
  region: 'iad',
  createdAt: new Date('2026-08-02T10:00:00.000Z'),
};

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
  vi.stubEnv('FLY_FLEET_APP', APP);
  vi.stubEnv('MOTIR_RUNNER_IMAGE', IMAGE);
  vi.stubEnv('FLY_FLEET_REGION', 'iad');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        signal: init?.signal ?? null,
      };
      calls.push(call);
      return handler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configuration is read at CALL time', () => {
  it('defaults the region to `iad`, where §11 fixes the fleet', () => {
    vi.stubEnv('FLY_FLEET_REGION', '');
    expect(flyFleetConfig().region).toBe('iad');
  });

  it('names every missing variable rather than failing opaquely', () => {
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(() => flyFleetConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => flyFleetConfig()).toThrow(/FLY_FLEET_API_TOKEN, MOTIR_RUNNER_IMAGE/);
  });

  it('an unwired deployment answers "not configured" without throwing', () => {
    // A self-hosted build never provisions a container and must not crash on
    // boot for want of a Fly token — `appAuth.ts`'s contract.
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    expect(isFlyFleetConfigured()).toBe(false);
  });
});

describe('provision — the two single-use guarantees are in the request body', () => {
  it('sends `auto_destroy: true` AND `restart: { policy: no }` (§7.1)', async () => {
    // Independent on purpose: `auto_destroy` alone would race a restart policy
    // that keeps bringing the runner back, and a runner that returns after its
    // ephemeral job de-registered is a machine that idles and bills until
    // something notices.
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);

    const create = calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
    const config = create.body?.['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(true);
    expect(config['restart']).toEqual({ policy: 'no' });
  });

  it('provisions the §M machine class — 2 DEDICATED vCPU, 8 GB', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    // `performance`, not `shared`: the customer is metered on wall clock, so CPU
    // steal costs the customer more billed minutes AND Motir more
    // container-seconds — the same slowdown paid for twice (§8).
    expect(config['guest']).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 8192 });
    expect(config['image']).toBe(IMAGE);
  });

  it('injects the JIT config as ENV, never bakes it into the image', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    expect(config['env']).toMatchObject({ ACTIONS_RUNNER_INPUT_JITCONFIG: 'secret-config' });
  });

  it('tags the machine so the reaper can recognise it without in-process state', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    expect(config['metadata']).toMatchObject({
      [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.ci_runner,
      motir_org_id: 'org-1',
      motir_project_id: 'proj-1',
    });
  });

  // ── the WORKLOAD, at the provider (MOTIR-2025) ──────────────────────────

  it('a CI spec still produces TODAY’S exact machine name and metadata keys', async () => {
    // ⚠️ THE REGRESSION GUARD FOR THE WHOLE CARD. Teaching the port a second
    // workload is only safe if the first one did not move: machines already
    // running in the fleet app are named `motir-runner-<jobId>` and tagged
    // `ci-runner`, and `reap()` recognises its own containers by exactly that
    // tag. This asserts the NAME and the metadata KEY SET, so a drift in either
    // — a renamed prefix, an added or dropped key — fails here rather than
    // stranding live machines outside the sweep that stops them billing.
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const body = calls[0]!.body!;
    const config = body['config'] as Record<string, unknown>;
    expect(body['name']).toBe('motir-runner-44001');
    expect(config['metadata']).toEqual({
      motir_fleet: 'ci-runner',
      motir_intent_id: '44001',
      motir_org_id: 'org-1',
      motir_project_id: 'proj-1',
    });
  });

  it('a jobless container is neither named nor tagged as a CI runner', async () => {
    // A hosted-agent container has no GitHub job at all, so it must not be booted
    // by inventing a job id — which would name it `motir-runner-<a lie>` and tag
    // it `ci-runner` in the Fly console and to the reaper.
    handler = () => json(200, machine());
    await flyOrchestrator.provision({
      ...SPEC,
      workload: 'hosted_agent',
      workflowJobId: null,
    });
    const body = calls[0]!.body!;
    const metadata = (body['config'] as Record<string, unknown>)['metadata'] as Record<
      string,
      string
    >;
    expect(body['name']).not.toMatch(/^motir-runner-/);
    expect(body['name']).toMatch(/^motir-agent-/);
    expect(metadata['motir_fleet']).toBe('hosted-agent');
    expect(metadata['motir_fleet']).not.toBe('ci-runner');
    // An empty `motir_intent_id` reads as an intent that could NOT be resolved,
    // which is a different and worse claim than "this workload has none".
    expect(metadata).not.toHaveProperty('motir_intent_id');
    expect(metadata['motir_org_id']).toBe('org-1');
    expect(metadata['motir_project_id']).toBe('proj-1');
  });

  it("a jobless container's repo slug is trimmed of hyphens, and stays linear on a long run of them", async () => {
    // MOTIR-7816 — the slug trims by scanning; `/-+$/` was polynomial on a run of '-'.
    handler = () => json(200, machine());
    await flyOrchestrator.provision({
      ...SPEC,
      workload: 'hosted_agent',
      workflowJobId: null,
      repoFullName: 'acme/--My__Repo--',
    });
    expect(calls[0]!.body!['name']).toMatch(/^motir-agent-my-repo-[0-9a-f]{8}$/);

    calls.length = 0;
    const started = performance.now();
    await flyOrchestrator.provision({
      ...SPEC,
      workload: 'hosted_agent',
      workflowJobId: null,
      repoFullName: `acme/a${'-'.repeat(100_000)}!`,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls[0]!.body!['name']).toMatch(/^motir-agent-a-[0-9a-f]{8}$/);
  });

  it("a jobless container's name is stable, and DIFFERENT per repo in one project", async () => {
    // A Fly machine name is unique within the app, and a Motir project spans
    // several repositories — so a name built from the project alone would
    // collide the moment two of its repos ran at once. Determinism is the
    // other half: the same unit of work must always produce the same name, or an
    // orphan in the console stops being traceable to what it served.
    const nameFor = async (spec: Parameters<typeof flyOrchestrator.provision>[0]) => {
      calls = [];
      handler = () => json(200, machine());
      await flyOrchestrator.provision(spec);
      return calls[0]!.body!['name'] as string;
    };
    const base = { ...SPEC, workload: 'hosted_agent' as const, workflowJobId: null };
    const first = await nameFor(base);
    expect(await nameFor(base)).toBe(first);
    expect(await nameFor({ ...base, repoFullName: 'motir-projects/acme-api' })).not.toBe(first);
    expect(await nameFor({ ...base, projectId: 'proj-2' })).not.toBe(first);
    // Fly's own charset: lower-case alphanumerics and hyphens.
    expect(first).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('returns an opaque handle carrying the provider, id, region and creation instant', async () => {
    handler = () => json(200, machine());
    const handle = await flyOrchestrator.provision(SPEC);
    expect(handle).toEqual({
      provider: 'fly',
      id: 'd8901ab',
      region: 'iad',
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
    });
  });

  it('leaves NOTHING behind when Fly refuses', async () => {
    // The port's contract: "throws a typed error; NEVER leaves an untracked
    // container". A refusal created nothing, so there is nothing to destroy —
    // proven by there being exactly one call.
    handler = () => json(422, { error: 'insufficient capacity' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 422,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a 200 whose shape has no machine id', async () => {
    handler = () => json(200, { state: 'started' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
    });
  });
});

describe('§6.2 — an UNPULLABLE image is its own named failure, not one more 400', () => {
  // `docs/decisions/fleet-image-pull.md` §6: an unpullable digest and an
  // unreachable Fly arrive at the same `catch` as a non-2xx, and they are
  // OPPOSITE problems — one needs a human to fix a registry, the other resolves
  // itself. Before this they were the same sentence.
  //
  // ⚠️ THE FIXTURE IS FLY'S OWN BODY, MEASURED. `{"error":"failed to get manifest
  // <ref>: unauthorized"}` at HTTP 400, observed live against api.machines.dev
  // on 2026-08-02 with a private GHCR reference (ADR §2.2, re-run by
  // MOTIR-2006). Nothing here is a guess about what Fly says.
  const FLY_MANIFEST_400 = {
    error: 'failed to get manifest ghcr.io/motir-co/motir-sandbox:claude: unauthorized',
  };

  it('classifies the measured manifest refusal as OrchestratorImageUnpullableError', async () => {
    handler = () => json(400, FLY_MANIFEST_400);

    const error = await flyOrchestrator.provision(SPEC).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OrchestratorImageUnpullableError);
    // It is STILL an OrchestratorApiError, so every existing catch site keeps
    // working — the subclass adds a diagnosis, it does not fork the hierarchy.
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect(error).toMatchObject({ status: 400, imageReference: IMAGE });
    // The MESSAGE is the deliverable: it lands in the intent's `failure_detail`
    // and in the operator dashboard's failure column, so it has to name the
    // image and say what happened without a log line beside it.
    expect((error as Error).message).toContain(IMAGE);
    expect((error as Error).message).toContain('could not PULL');
    expect((error as Error).message).toContain('private, absent, or the pinned digest is gone');
  });

  it.each([
    ['a manifest Fly could not resolve', { error: 'failed to resolve manifest ghcr.io/x/y' }],
    ['an unknown manifest', { error: 'manifest unknown' }],
    ['a pull that failed after resolution', { error: 'failed to pull image ghcr.io/x/y' }],
    ['an image Fly cannot find', { error: 'image not found' }],
  ])('also names %s as unpullable', async (_label, body) => {
    handler = () => json(400, body);
    await expect(flyOrchestrator.provision(SPEC)).rejects.toBeInstanceOf(
      OrchestratorImageUnpullableError,
    );
  });

  it('does NOT claim an image problem when the FLEET TOKEN is what Fly refused', async () => {
    // ⚠️ THE MIS-DIAGNOSIS THIS GUARDS AGAINST. Fly says `unauthorized` for a bad
    // `FLY_FLEET_API_TOKEN` too, and reporting that as "your image is private"
    // would send an operator to the GHCR settings page while the token rots. The
    // classifier matches the IMAGE-specific phrasing, never `unauthorized` alone.
    handler = () => json(401, { error: 'unauthorized' });

    const error = await flyOrchestrator.provision(SPEC).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect(error).not.toBeInstanceOf(OrchestratorImageUnpullableError);
  });

  it('does NOT claim an image problem for a capacity refusal', async () => {
    handler = () => json(422, { error: 'insufficient capacity' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.not.toBeInstanceOf(
      OrchestratorImageUnpullableError,
    );
  });
});

describe('describe — GONE is a real answer', () => {
  it('reports a live machine with its provider-attested start instant', async () => {
    handler = () => json(200, machine());
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status).toMatchObject({
      handleId: 'd8901ab',
      exists: true,
      state: 'started',
      terminal: false,
      startedAt: new Date('2026-08-02T10:00:10.000Z'),
    });
  });

  it('reports a 404 as terminal, not as a failure — the `auto_destroy` happy path', async () => {
    handler = () => json(404, { error: 'machine not found' });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status).toMatchObject({ exists: false, state: 'destroyed', terminal: true });
  });

  it('treats `stopped` as terminal', async () => {
    handler = () =>
      json(200, {
        ...machine({ state: 'stopped' }),
        events: [
          { type: 'start', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
          { type: 'exit', timestamp: Date.parse('2026-08-02T10:04:10.000Z') },
        ],
      });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status.terminal).toBe(true);
    expect(status.stoppedAt).toEqual(new Date('2026-08-02T10:04:10.000Z'));
  });

  it('surfaces a real read failure rather than pretending the machine is gone', async () => {
    // A 500 must NOT read as "destroyed": that would let supervision conclude a
    // running container had finished and stop watching it.
    handler = () => json(500, { error: 'boom' });
    await expect(flyOrchestrator.describe(HANDLE)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 500,
    });
  });

  // ── the EXIT REASON (MOTIR-2025) ────────────────────────────────────────

  it("reports the container's exit code from Fly's `exit_event`", async () => {
    // For an index container this number is the ENTIRE diagnostic channel: it
    // writes no ledger row, so `30` (BUILD) versus `50` (CREDENTIAL_REFUSED) is
    // the only thing distinguishing "the repo does not compile" from "the
    // credential Motir minted was refused".
    handler = () =>
      json(200, {
        ...machine({ state: 'stopped' }),
        events: [
          { type: 'start', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
          {
            type: 'exit',
            timestamp: Date.parse('2026-08-02T10:04:10.000Z'),
            request: { exit_event: { exit_code: 30, guest_exit_code: 30, oom_killed: false } },
          },
        ],
      });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status.exitCode).toBe(30);
    // ⚠️ A PLAIN NUMBER, not a Fly event — §4 rule 1 holds through this field.
    expect(typeof status.exitCode).toBe('number');
  });

  it('reports a successful exit as 0 — distinguishable from "code unknown"', async () => {
    handler = () =>
      json(200, {
        ...machine({ state: 'stopped' }),
        events: [
          {
            type: 'exit',
            timestamp: Date.parse('2026-08-02T10:04:10.000Z'),
            request: { exit_event: { guest_exit_code: 0, exit_code: 0 } },
          },
        ],
      });
    // `0` and `null` must never collapse into each other: one says the indexer
    // finished, the other says nobody knows whether it did.
    expect((await flyOrchestrator.describe(HANDLE)).exitCode).toBe(0);
  });

  it('reports null when the machine is GONE — the code went with it', async () => {
    handler = () => json(404, { error: 'machine not found' });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status.exitCode).toBeNull();
    expect(status.exists).toBe(false);
  });

  it('reports null when the machine exited but Fly kept no code', async () => {
    handler = () =>
      json(200, {
        ...machine({ state: 'stopped' }),
        events: [{ type: 'exit', timestamp: Date.parse('2026-08-02T10:04:10.000Z') }],
      });
    // "Stopped, code unknown" is the port's third outcome, and the consumer has
    // to treat it as its own case rather than as success.
    expect((await flyOrchestrator.describe(HANDLE)).exitCode).toBeNull();
  });

  it('reports null for a machine that is still RUNNING', async () => {
    handler = () => json(200, machine());
    expect((await flyOrchestrator.describe(HANDLE)).exitCode).toBeNull();
  });
});

describe('teardown — destroys, and RETURNS what it cost', () => {
  it("reads BEFORE destroying so the row carries Fly's own timestamps (§5)", async () => {
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, {
          ...machine({ state: 'stopped' }),
          events: [
            { type: 'start', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
            { type: 'exit', timestamp: Date.parse('2026-08-02T10:05:10.000Z') },
          ],
        });
      }
      return new Response(null, { status: 200 });
    };

    const usage = await flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION);

    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1]!.url).toContain('force=true');
    expect(usage.startedAt).toEqual(new Date('2026-08-02T10:00:10.000Z'));
    expect(usage.stoppedAt).toEqual(new Date('2026-08-02T10:05:10.000Z'));
    expect(usage.billableSeconds).toBe(300);
    expect(usage.costUsd).toBe('0.0094908147');
    expect(usage.teardownReason).toBe('job_completed');
  });

  it.each(['stopped', 'destroying', 'started'])(
    "records `destroyed` as the terminal state, not Fly's pre-destroy state (%s)",
    async (state) => {
      handler = (call) =>
        call.method === 'GET' ? json(200, machine({ state })) : new Response(null, { status: 200 });

      const usage = await flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION);

      expect(usage.terminalState).toBe('destroyed');
    },
  );

  it("falls back to the CALLER's observed start when the machine self-destroyed", async () => {
    // ⚠️ THE HAPPY PATH IS THE HARD CASE. `auto_destroy` means a completed run
    // deletes its own machine, taking its event log with it — so without this
    // fallback the best-behaved containers would produce zero-second rows and
    // Motir's cost would read as near zero while the invoice did not.
    handler = (call) =>
      call.method === 'GET' ? json(404, {}) : new Response(null, { status: 200 });
    const observedStartedAt = new Date(Date.now() - 120_000);

    const usage = await flyOrchestrator.teardown(HANDLE, 'job_completed', {
      ...ATTRIBUTION,
      observedStartedAt,
    });

    expect(usage.startedAt).toEqual(observedStartedAt);
    expect(usage.billableSeconds).toBeGreaterThanOrEqual(119);
    expect(Number(usage.costUsd)).toBeGreaterThan(0);
  });

  it('still destroys and still costs when the pre-read fails', async () => {
    // A read failure must not stop a teardown: the container is what bills.
    handler = (call) =>
      call.method === 'GET' ? json(500, {}) : new Response(null, { status: 200 });
    const usage = await flyOrchestrator.teardown(HANDLE, 'job_timed_out', ATTRIBUTION);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(usage.teardownReason).toBe('job_timed_out');
  });

  it('is IDEMPOTENT — a second teardown on a destroyed machine does not throw', async () => {
    handler = (call) => (call.method === 'GET' ? json(404, {}) : json(404, { error: 'gone' }));
    await expect(flyOrchestrator.teardown(HANDLE, 'reaped', ATTRIBUTION)).resolves.toMatchObject({
      teardownReason: 'reaped',
    });
  });

  it('propagates a destroy that genuinely failed', async () => {
    // The one thing that must NOT be swallowed here: if the machine is still
    // alive, the caller has to know so the reaper keeps it in scope.
    handler = (call) =>
      call.method === 'GET' ? json(200, machine()) : json(500, { error: 'boom' });
    await expect(
      flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION),
    ).rejects.toMatchObject({ code: 'ORCHESTRATOR_API_FAILED', status: 500 });
  });
});

describe('reap — the provider is the source of truth, and AGE is the test', () => {
  const OLDER_THAN = new Date('2026-08-02T12:00:00.000Z');
  const resolveAll = async () => ATTRIBUTION;

  it('destroys a fleet machine older than the cutoff and returns its cost row', async () => {
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, [machine({ id: 'old-1', createdAt: '2026-08-02T09:00:00.000Z' })]);
      }
      return new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      handleId: 'old-1',
      teardownReason: 'reaped',
      terminalState: 'destroyed',
    });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('leaves a machine that is NOT old enough alone', async () => {
    handler = () => json(200, [machine({ id: 'fresh', createdAt: '2026-08-02T12:30:00.000Z' })]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it("ignores a machine that is not tagged as fleet — it is not the fleet's to destroy", async () => {
    handler = () =>
      json(200, [
        machine({ id: 'someone-else', createdAt: '2026-08-02T09:00:00.000Z', metadata: {} }),
      ]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('sweeps EVERY registered workload, not just the runners (MOTIR-2025)', async () => {
    // ⚠️ THE FAILURE THIS CLOSES. The sweep used to match one hardcoded tag
    // value, so the instant the fleet had a second workload it would have walked
    // straight past a leaked agent or instance container — which bills exactly like
    // a runner does, in an org `ci-runner-fleet.md` §9 records has neither a
    // spending cap nor a billing alert underneath it.
    const old = '2026-08-02T09:00:00.000Z';
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, [
          machine({ id: 'runner', createdAt: old, metadata: { motir_fleet: 'ci-runner' } }),
          machine({ id: 'instance', createdAt: old, metadata: { motir_fleet: 'agent-instance' } }),
          machine({ id: 'agent', createdAt: old, metadata: { motir_fleet: 'hosted-agent' } }),
          machine({ id: 'stranger', createdAt: old, metadata: { motir_fleet: 'something-else' } }),
        ]);
      }
      return new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);

    expect(usages.map((u) => u.handleId).sort()).toEqual(['agent', 'instance', 'runner']);
    // The stranger is still NOT ours to destroy: recognising more workloads must
    // not widen the sweep to the whole Fly organisation.
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toHaveLength(3);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('stranger'))).toBe(false);
  });

  it('every tag value the registry declares is one the sweep answers to', () => {
    // A registry entry the reaper does not recognise is a workload that leaks
    // silently. Asserted over the RECORD rather than a list of literals, so a
    // fourth workload cannot be added with a tag nothing sweeps.
    for (const [kind, value] of Object.entries(FLEET_METADATA_VALUES)) {
      expect(value, kind).toMatch(/^[a-z0-9-]+$/);
    }
    expect(new Set(Object.values(FLEET_METADATA_VALUES)).size).toBe(
      Object.keys(FLEET_METADATA_VALUES).length,
    );
    expect(FLEET_METADATA_VALUES.ci_runner).toBe('ci-runner');
  });

  it('reports — and does NOT destroy — a fleet machine Fly describes with no creation instant', async () => {
    // Destroying on a guess could kill a container that booted a second ago.
    handler = () => json(200, [machine({ id: 'undated', createdAt: null })]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('destroys an UNATTRIBUTABLE orphan but emits no cost row for it', async () => {
    // Stopping the bleeding is what costs money; a row attributed to nobody would
    // pollute the meter with spend it cannot assign.
    handler = (call) =>
      call.method === 'GET'
        ? json(200, [machine({ id: 'orphan', createdAt: '2026-08-02T09:00:00.000Z' })])
        : new Response(null, { status: 200 });
    const usages = await flyOrchestrator.reap(OLDER_THAN, async () => null);
    expect(usages).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it("one machine's destroy failure does not abandon the rest of the sweep", async () => {
    // The sweep is the last line; a fleet-wide leak because one DELETE 500'd is
    // the failure mode it exists to prevent.
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, [
          machine({ id: 'bad', createdAt: '2026-08-02T09:00:00.000Z' }),
          machine({ id: 'good', createdAt: '2026-08-02T09:00:00.000Z' }),
        ]);
      }
      return call.url.includes('bad')
        ? json(500, { error: 'boom' })
        : new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);
    expect(usages.map((u) => u.handleId)).toEqual(['good']);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('leaves a machine the caller SPARES — asked before it is resolved or destroyed (MOTIR-6450)', async () => {
    // A hosted run still holding its fleet slot is old by the CI cutoff and alive
    // by design; the caller's predicate keeps it, and only it.
    handler = (call) =>
      call.method === 'GET'
        ? json(200, [
            machine({ id: 'long-run', createdAt: '2026-08-02T09:00:00.000Z' }),
            machine({ id: 'orphan', createdAt: '2026-08-02T09:00:00.000Z' }),
          ])
        : new Response(null, { status: 200 });
    const resolved: string[] = [];
    const usages = await flyOrchestrator.reap(
      OLDER_THAN,
      async (handle) => {
        resolved.push(handle.id);
        return ATTRIBUTION;
      },
      async (handle) => handle.id === 'long-run',
    );
    expect(usages.map((u) => u.handleId)).toEqual(['orphan']);
    expect(resolved).toEqual(['orphan']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      expect.stringContaining('orphan'),
    ]);
  });

  it('a spare check that throws spares nothing — the reaper is the backstop', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json(200, [machine({ id: 'old-1', createdAt: '2026-08-02T09:00:00.000Z' })])
        : new Response(null, { status: 200 });
    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll, async () => {
      throw new Error('the slot table is unreachable');
    });
    expect(usages.map((u) => u.handleId)).toEqual(['old-1']);
  });

  it('tolerates a list containing entries that are not machines', async () => {
    handler = () =>
      json(200, [null, 'nope', machine({ id: 'real', createdAt: '2026-08-02T09:00:00.000Z' })]);
    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);
    expect(usages.map((u) => u.handleId)).toEqual(['real']);
  });

  it('surfaces a list failure rather than reporting an empty fleet', async () => {
    // "No machines" and "could not ask" must never be the same answer: the first
    // means nothing to reap, the second means the reaper did not run.
    handler = () => json(500, { error: 'boom' });
    await expect(flyOrchestrator.reap(OLDER_THAN, resolveAll)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
    });
  });
});

// ── Parsing Fly's JSON, which is not a contract ─────────────────────────────

describe('toFlyMachine tolerates every shape Fly actually sends', () => {
  /**
   * Fly's machine JSON is a REST response, not a schema, and the fleet reads it
   * on the two paths that must not fail: the reaper's list, and the pre-teardown
   * read that sources the §5 timestamps. A parser that threw — or that silently
   * produced `undefined` where a Date belongs — would turn a malformed payload
   * into either a crashed sweep or a cost row nobody can audit.
   */
  it('refuses anything without a usable id — that is what "not a machine" means', () => {
    expect(toFlyMachine(null)).toBeNull();
    expect(toFlyMachine('a string')).toBeNull();
    expect(toFlyMachine([])).toBeNull();
    expect(toFlyMachine({})).toBeNull();
    expect(toFlyMachine({ id: 42 })).toBeNull();
    expect(toFlyMachine({ id: '' })).toBeNull();
  });

  it('defaults every missing string field rather than propagating undefined', () => {
    const parsed = toFlyMachine({ id: 'm1' });

    expect(parsed).toMatchObject({ id: 'm1', name: '', state: '', region: '' });
    expect(parsed?.createdAt).toBeNull();
    expect(parsed?.updatedAt).toBeNull();
    expect(parsed?.metadata).toEqual({});
    expect(parsed?.events).toEqual([]);
  });

  it('reads an events timestamp in EPOCH MILLISECONDS, the shape Fly uses there', () => {
    // ⚠️ The two timestamp dialects in one payload: the machine's own
    // `created_at` is RFC 3339, its EVENTS are epoch millis. Both land in the
    // same parser, and getting the second wrong is what makes a boot-latency
    // reading silently absurd.
    const at = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({ id: 'm1', events: [{ type: 'start', timestamp: at }] });
    expect(parsed?.events[0]?.timestamp).toEqual(new Date(at));
  });

  it('drops an UNPARSEABLE timestamp rather than producing an Invalid Date', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      created_at: 'not a date',
      events: [
        { type: 'start', timestamp: 'also not a date' },
        { type: 'exit', timestamp: Number.NaN },
        { type: 'stop', timestamp: { nested: true } },
      ],
    });

    expect(parsed?.createdAt).toBeNull();
    expect(parsed?.events.map((e) => e.timestamp)).toEqual([null, null, null]);
    // An Invalid Date compares as NaN everywhere and would make `reap(olderThan)`
    // quietly skip the machine — a leak with no error.
    expect(startedAtOf(parsed!)).toBeNull();
    expect(stoppedAtOf(parsed!)).toBeNull();
  });

  it('keeps only STRING metadata, so a non-string tag cannot masquerade as one', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      config: {
        metadata: { [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.ci_runner, port: 8080, on: true },
      },
    });
    expect(parsed?.metadata).toEqual({ [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES.ci_runner });
  });

  it('tolerates an events value that is not an array, and entries that are not events', () => {
    expect(toFlyMachine({ id: 'm1', events: 'nope' })?.events).toEqual([]);
    expect(toFlyMachine({ id: 'm1', events: [null, 7, 'x'] })?.events).toEqual([]);
  });

  it('defaults an event’s own type/status to empty strings', () => {
    const parsed = toFlyMachine({ id: 'm1', events: [{ timestamp: 1 }] });
    expect(parsed?.events[0]).toMatchObject({ type: '', status: '' });
  });
});

describe('the machine-state predicates', () => {
  it('knows which states are TERMINAL', () => {
    expect(isTerminalState('destroyed')).toBe(true);
    expect(isTerminalState('started')).toBe(false);
  });

  it('knows which states are still ON THE WAY UP', () => {
    // The distinction a boot deadline needs: `created` is "keep waiting",
    // `started` is "it is up", and neither is "it failed".
    expect(isPreStartState('created')).toBe(true);
    expect(isPreStartState('started')).toBe(false);
    expect(isPreStartState('destroyed')).toBe(false);
  });
});

describe('the §5 instants, read from Fly’s event log', () => {
  it('takes the FIRST start event, ignoring events of other types', () => {
    const first = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'launch', timestamp: Date.parse('2026-08-02T10:00:00.000Z') },
        { type: 'start', timestamp: first },
        { type: 'start', timestamp: Date.parse('2026-08-02T10:05:00.000Z') },
      ],
    });
    expect(startedAtOf(parsed!)).toEqual(new Date(first));
  });

  it('skips a start event that carries no usable timestamp', () => {
    const good = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'start', timestamp: 'nonsense' },
        { type: 'start', timestamp: good },
      ],
    });
    expect(startedAtOf(parsed!)).toEqual(new Date(good));
  });

  it('takes the LATEST stop-ish event, whichever of the three types it is', () => {
    // `exit`, `stop` and `destroy` all end a machine, and Fly emits them in no
    // guaranteed order. The LAST one is when it actually stopped costing money.
    const early = Date.parse('2026-08-02T10:04:00.000Z');
    const late = Date.parse('2026-08-02T10:09:00.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'destroy', timestamp: late },
        { type: 'exit', timestamp: early },
        { type: 'stop', timestamp: null },
        { type: 'start', timestamp: Date.parse('2026-08-02T10:00:00.000Z') },
      ],
    });
    expect(stoppedAtOf(parsed!)).toEqual(new Date(late));
  });

  it('is null when the machine has stopped-ish events but none with an instant', () => {
    const parsed = toFlyMachine({ id: 'm1', events: [{ type: 'exit', timestamp: 'x' }] });
    expect(stoppedAtOf(parsed!)).toBeNull();
  });
});

describe('the exit CODE, read from Fly’s event log (MOTIR-2025 · MOTIR-4519)', () => {
  const at = (iso: string) => Date.parse(iso);

  /**
   * ⚠️ THE VERBATIM PRODUCTION PAYLOAD (MOTIR-4519), and it is the whole reason
   * the preference below runs the way it does.
   *
   * Read from the fleet's own Machines API on 2026-09-04 for machine
   * `8e3143b7164118` — one of the containers MOTIR-4518 watched die at
   * `getaddrinfo ENOTFOUND motir-ai.internal`, whose logs read
   * `{"ok":false,"failure":"UPLOAD","exitCode":40}`. **180 of 180 exit events in
   * the fleet app carried this exact pair**: the indexer's own
   * `src/indexer/exitCodes.ts` value in `exit_code`, and a flat `0` in
   * `guest_exit_code`.
   *
   * So the fixture is not an illustration — it is the shape production sends,
   * and any parse that prefers `guest_exit_code` reports every one of those
   * containers as a success.
   */
  const PRODUCTION_EXIT_EVENT = {
    requested_stop: false,
    restarting: false,
    guest_exit_code: 0,
    guest_signal: -1,
    guest_error: '',
    exit_code: 40,
    signal: -1,
    error: '',
    oom_killed: false,
    exited_at: '2026-09-04T15:35:18.203Z',
  } as const;

  it("reports the CONTAINER's code — the pair Fly really sends, guest 0 / exit 40", () => {
    // The regression MOTIR-4519 measured: this machine did not index anything,
    // and `exitCodeOf` answering 0 is what let `classifyIndexExit` call it
    // `indexed` and put a permanent claim in the ledger.
    const parsed = toFlyMachine({
      id: '8e3143b7164118',
      events: [
        { type: 'start', timestamp: at('2026-09-04T15:16:28.609Z') },
        {
          type: 'exit',
          timestamp: at('2026-09-04T15:35:18.299Z'),
          request: { exit_event: PRODUCTION_EXIT_EVENT },
        },
      ],
    });
    expect(exitCodeOf(parsed!)).toBe(40);
  });

  it("prefers the machine-level `exit_code` over the guest's, on every code in the taxonomy", () => {
    // Every member of `classifyIndexExit`'s taxonomy, each carried the way
    // production carries it. A parse that reads `guest_exit_code` first turns
    // ALL of them into 0 — the one value that means "indexed".
    for (const code of [10, 20, 30, 40, 41, 50, 137] as const) {
      const parsed = toFlyMachine({
        id: 'm1',
        events: [
          {
            type: 'exit',
            timestamp: at('2026-08-02T10:04:00.000Z'),
            request: { exit_event: { guest_exit_code: 0, exit_code: code } },
          },
        ],
      });
      expect(exitCodeOf(parsed!), `exit_code ${code}`).toBe(code);
    }
  });

  it('falls back to the GUEST code when Fly sent no machine-level one', () => {
    // A code we could have had is worse lost than approximated — the fallback
    // survives the correction, only its direction changed.
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        {
          type: 'exit',
          timestamp: at('2026-08-02T10:04:00.000Z'),
          request: { exit_event: { guest_exit_code: 137 } },
        },
      ],
    });
    expect(exitCodeOf(parsed!)).toBe(137);
  });

  it('takes the LATEST exit event, matching how the stop instant is read', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        {
          type: 'exit',
          timestamp: at('2026-08-02T10:09:00.000Z'),
          request: { exit_event: { guest_exit_code: 41 } },
        },
        {
          type: 'exit',
          timestamp: at('2026-08-02T10:04:00.000Z'),
          request: { exit_event: { guest_exit_code: 20 } },
        },
      ],
    });
    expect(exitCodeOf(parsed!)).toBe(41);
  });

  it('uses an UNDATED exit event only when nothing dated reported a code', () => {
    const undatedOnly = toFlyMachine({
      id: 'm1',
      events: [{ type: 'exit', timestamp: 'x', request: { exit_event: { guest_exit_code: 70 } } }],
    });
    expect(exitCodeOf(undatedOnly!)).toBe(70);

    const datedWins = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'exit', timestamp: 'x', request: { exit_event: { guest_exit_code: 70 } } },
        {
          type: 'exit',
          timestamp: at('2026-08-02T10:04:00.000Z'),
          request: { exit_event: { guest_exit_code: 10 } },
        },
      ],
    });
    expect(exitCodeOf(datedWins!)).toBe(10);
  });

  it('ignores a code on any event that is not an exit', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        {
          type: 'start',
          timestamp: at('2026-08-02T10:00:00.000Z'),
          request: { exit_event: { guest_exit_code: 99 } },
        },
      ],
    });
    expect(exitCodeOf(parsed!)).toBeNull();
  });

  it('is null for every shape Fly sends without a usable code', () => {
    // Each of these is a real answer of "unknown", never a zero — a parser that
    // defaulted to 0 would report every unreadable container as a success.
    const shapes: Array<Record<string, unknown>> = [
      { type: 'exit', timestamp: at('2026-08-02T10:04:00.000Z') },
      { type: 'exit', timestamp: at('2026-08-02T10:04:00.000Z'), request: {} },
      { type: 'exit', timestamp: at('2026-08-02T10:04:00.000Z'), request: { exit_event: null } },
      {
        type: 'exit',
        timestamp: at('2026-08-02T10:04:00.000Z'),
        request: { exit_event: { guest_exit_code: 'thirty' } },
      },
      {
        type: 'exit',
        timestamp: at('2026-08-02T10:04:00.000Z'),
        request: { exit_event: { guest_exit_code: Number.NaN } },
      },
    ];
    for (const event of shapes) {
      expect(
        exitCodeOf(toFlyMachine({ id: 'm1', events: [event] })!),
        JSON.stringify(event),
      ).toBeNull();
    }
  });
});

describe('the adapter’s fallbacks when Fly answers thinly', () => {
  it('a machine with NO region or creation instant still yields a usable handle', async () => {
    // `reap(olderThan)` compares against the handle's `createdAt`, so a null
    // there would make the container invisible to the one mechanism that exists
    // to catch it — the fallback is what keeps an un-dated machine reapable.
    handler = () => json(200, { id: 'thin-1', state: 'created' });
    const before = Date.now();

    const handle = await flyOrchestrator.provision(SPEC);

    expect(handle).toMatchObject({ provider: 'fly', id: 'thin-1', region: 'iad' });
    expect(handle.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a spec with no region of its own falls back to the DEPLOYMENT’s region', async () => {
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    handler = () => json(200, { id: 'thin-2', state: 'created' });

    const handle = await flyOrchestrator.provision({ ...SPEC, region: '' });

    expect(calls[0]?.body?.['region']).toBe('ams');
    expect(handle.region).toBe('ams');
  });

  it('describe dates an un-dated machine from the HANDLE rather than reporting none', async () => {
    handler = () => json(200, machine({ createdAt: null, events: [] }));

    const status = await flyOrchestrator.describe(HANDLE);

    expect(status.createdAt).toEqual(HANDLE.createdAt);
    expect(status.startedAt).toBeNull();
    expect(status.stoppedAt).toBeNull();
  });

  it('reports a refusal whose body is not JSON by STATUS alone', async () => {
    handler = () => new Response('<html>502</html>', { status: 502 });

    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 502,
    });
  });

  it('reads Fly’s `error` key as well as `message` — it sends both', async () => {
    handler = () => json(422, { error: 'no capacity in iad' });

    await expect(flyOrchestrator.provision(SPEC)).rejects.toThrow(/no capacity in iad/);
  });

  it('normalizes a NON-ERROR transport rejection to the typed error', async () => {
    // A rejected promise that is not an `Error` (a string thrown by an agent, an
    // aborted fetch in some runtimes) must not escape as an unnamed value.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'socket closed';
      }),
    );

    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      provider: 'fly',
      status: null,
    });
  });
});

describe('the reaper keeps sweeping when ONE machine refuses to die', () => {
  it('logs the refusal, skips that machine, and still destroys the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = '2026-08-01T00:00:00.000Z';
    handler = (call) => {
      if (call.method === 'GET' && call.url.endsWith('/machines')) {
        return json(200, [
          machine({ id: 'stubborn', createdAt: old }),
          machine({ id: 'compliant', createdAt: old }),
        ]);
      }
      if (call.method === 'DELETE' && call.url.includes('stubborn')) {
        return json(500, { error: 'machine is wedged' });
      }
      return new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(
      new Date('2026-08-02T00:00:00.000Z'),
      async () => ATTRIBUTION,
    );

    // A fleet-wide leak because one destroy 500'd is the failure the sweep
    // exists to prevent, so one refusal must not abandon the others.
    expect(usages.map((u) => u.handleId)).toEqual(['compliant']);
    expect(error).toHaveBeenCalled();
  });
});

describe('deadlines — the provider cannot hold an invocation open (docs/jobs.md rule 3, MOTIR-2011)', () => {
  /** A provider that ACCEPTS the request and never answers. Unbounded, this is
   *  what rides all the way to `FUNCTION_INVOCATION_TIMEOUT`. */
  function stallUntilAborted(signal: AbortSignal | null): Promise<Response> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(new DOMException('This operation was aborted', 'AbortError')),
      );
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a provision that never answers becomes a TYPED timeout, inside the budget', async () => {
    // ⚠️ THE WORST PLACE FOR AN UNBOUNDED CALL. This one runs AFTER the JIT
    // config is minted, so the invocation kill it used to cause left both a
    // registered runner and (possibly) a machine, with the boot's cleanup
    // unreachable on the other side of a process that no longer exists.
    vi.useFakeTimers();
    handler = (call) => stallUntilAborted(call.signal);

    const settled = flyOrchestrator.provision(SPEC).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_REQUEST_TIMEOUT_MS - 1);
    await expect(Promise.race([settled, Promise.resolve('still pending')])).resolves.toBe(
      'still pending',
    );

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(OrchestratorTimeoutError);
    expect(err).toMatchObject({
      code: 'ORCHESTRATOR_TIMEOUT',
      retryable: true,
      provider: 'fly',
    });
    expect((err as Error).message).toContain(String(ORCHESTRATOR_REQUEST_TIMEOUT_MS));
  });

  it('the POLL read is bounded too — one hung read must not span the whole step', async () => {
    vi.useFakeTimers();
    handler = (call) => stallUntilAborted(call.signal);

    const settled = flyOrchestrator.describe(HANDLE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_REQUEST_TIMEOUT_MS);

    expect(await settled).toBeInstanceOf(OrchestratorTimeoutError);
  });

  it('the TEARDOWN destroy is bounded — the guarantee cannot be held open by the provider', async () => {
    vi.useFakeTimers();
    // The pre-teardown read is deliberately quiet (`readQuietly`), so it absorbs
    // its own timeout and the destroy is the call that must surface one.
    handler = (call) => stallUntilAborted(call.signal);

    const settled = flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    // Two sequential deadlines: the quiet read, then the destroy.
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_REQUEST_TIMEOUT_MS);

    expect(await settled).toBeInstanceOf(OrchestratorTimeoutError);
  });

  it('EVERY Machines-API request carries the signal — asserted on the wire, not on a call count', async () => {
    // A property of every observed request, so a new endpoint inherits the
    // deadline instead of quietly escaping it.
    handler = (call) => (call.method === 'DELETE' ? json(200, {}) : json(200, machine()));

    await flyOrchestrator.provision(SPEC);
    await flyOrchestrator.describe(HANDLE);
    await flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION);

    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.signal, `${call.method} ${call.url} carries no deadline`).toBeInstanceOf(
        AbortSignal,
      );
    }
  });

  it('a transport failure is still the generic API error, NOT a timeout', async () => {
    handler = () => {
      throw new TypeError('fetch failed');
    };
    const err = await flyOrchestrator.describe(HANDLE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).not.toBeInstanceOf(OrchestratorTimeoutError);
  });
});

// ── One orchestrator per ACCOUNT (MOTIR-8964) ───────────────────────────────

describe('createFlyOrchestrator — an account’s app and token, whatever FLY_FLEET_* holds', () => {
  interface Seen {
    url: string;
    method: string;
    authorization: string | null;
  }

  let seen: Seen[];

  beforeEach(() => {
    seen = [];
    // The process-wide fleet is a THIRD app with a third token: neither account
    // may reach it.
    vi.stubEnv('FLY_FLEET_APP', 'process-wide-app');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'process_wide_token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const method = init?.method ?? 'GET';
        seen.push({ url: String(url), method, authorization: headers.get('authorization') });
        if (method === 'POST' && String(url).endsWith('/volumes')) {
          return json(200, { id: 'vol_1', name: 'motir_ci_docker', region: 'ord' });
        }
        if (method === 'POST') return json(200, machine({ region: 'ord' }));
        if (method === 'GET' && /\/(machines|volumes)$/.test(String(url))) return json(200, []);
        if (method === 'GET') return json(404, { error: 'not found' });
        return json(200, {});
      }),
    );
  });

  it('sends every Machines and Volumes request of each account to its own app with its own token', async () => {
    const a = createFlyOrchestrator({ token: 'token_a', app: 'app-a', region: 'ord' });
    const b = createFlyOrchestrator({ token: 'token_b', app: 'app-b', region: 'sjc' });

    for (const [orchestrator, app, token] of [
      [a, 'app-a', 'token_a'],
      [b, 'app-b', 'token_b'],
    ] as const) {
      seen = [];
      const handle = await orchestrator.provision({ ...SPEC, region: '', dockerVolumeGb: 20 });
      await orchestrator.describe(handle);
      await orchestrator.teardown(handle, 'job_completed', ATTRIBUTION);
      await orchestrator.reap(new Date(), async () => ATTRIBUTION);
      await orchestrator.sweepOrphanedVolumes!(new Date());

      expect(seen.length).toBeGreaterThan(5);
      for (const call of seen) {
        expect(call.url).toContain(`/apps/${app}/`);
        expect(call.url).not.toContain('process-wide-app');
        expect(call.authorization).toBe(`Bearer ${token}`);
      }
    }
  });

  it('boots a spec with no region in the account’s region', async () => {
    const orchestrator = createFlyOrchestrator({ token: 't', app: 'app-a', region: 'sjc' });
    await orchestrator.provision({ ...SPEC, region: '' });
    const create = seen.find((c) => c.method === 'POST' && c.url.endsWith('/machines'));
    expect(create).toBeDefined();
    const body = (vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body ?? '{}') as string;
    expect(JSON.parse(body)).toMatchObject({ region: 'sjc' });
  });
});

describe('an arm64 spec (MOTIR-11782)', () => {
  it('is refused before any API call — Fly boots no arm64 machine, never one as x86', async () => {
    const orchestrator = createFlyOrchestrator({ token: 't', app: APP, region: 'iad' });

    await expect(orchestrator.provision({ ...SPEC, architecture: 'arm64' })).rejects.toBeInstanceOf(
      OrchestratorNotConfiguredError,
    );
    expect(calls).toEqual([]);
  });
});
