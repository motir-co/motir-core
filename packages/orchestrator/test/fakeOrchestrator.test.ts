import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FLEET_CONTAINER_SIZE,
  createFakeOrchestrator,
  fakeOrchestrator,
  type ContainerHandle,
  type ContainerSpec,
  type UsageAttribution,
  sparedByCaller,
} from '../src/index';

// The FAKE adapter's own behaviour (Story MOTIR-1916 · MOTIR-1921).
//
// The port's guarantees are not here: they live once, in
// `test/contract/orchestratorContract.ts`, and run against the fake and Fly
// alike (MOTIR-8960). This file keeps what only the fake does — the controls
// other suites drive it with, the cross-process store, and the places the fake
// is stricter than the port.

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  image: 'motir/ci-runner@sha256:abc',
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit' },
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

beforeEach(() => {
  fakeOrchestrator.reset();
});

describe('what only the fake does — the port itself is the shared contract suite', () => {
  // The port's guarantees run once per adapter in `orchestratorContract.*.test.ts`
  // (MOTIR-8960). What stays here is the fake's own surface: the controls
  // other suites drive it with, and the places it is stricter than the port.

  it('a second teardown returns the IDENTICAL first row — stricter than the port', async () => {
    // The port only promises a row for the same handle (Fly builds a fresh one);
    // the fake memoises, so a caller's second write is visibly the same figure.
    const handle = await fakeOrchestrator.provision(SPEC);
    const first = await fakeOrchestrator.teardown(handle, 'job_completed', ATTRIBUTION);
    const second = await fakeOrchestrator.teardown(handle, 'reaped', ATTRIBUTION);
    expect(second).toBe(first);
    expect(second.teardownReason).toBe('job_completed');
  });

  it("a `hang` container never becomes terminal — only the caller's timeout ends it", async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).terminal).toBe(false);
    expect((await fakeOrchestrator.describe(handle)).terminal).toBe(false);
  });

  // ── the EXIT REASON, driven through the fake (MOTIR-2025) ───────────────

  it('a container can be completed with a chosen exit code, and `describe` reports it', async () => {
    // The control the index dispatcher is built against: the whole classification
    // it will do — `20` re-dispatch, `50` mint a fresh credential — is a function
    // of this number, and this is the only way to exercise every branch of it
    // without booting real containers.
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id, { exitCode: 50 });
    expect((await fakeOrchestrator.describe(handle)).exitCode).toBe(50);
  });

  it('reports the code of a container that has already SELF-DESTROYED', async () => {
    // ⚠️ `exists: false` IS THE HAPPY PATH — `auto_destroy` means a successful
    // run ends with the machine deleting itself. A fake that dropped the code
    // there could not exercise the one case that matters most: a container that
    // ran, failed at BUILD, and took itself away.
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id, { exitCode: 30 });
    const status = await fakeOrchestrator.describe(handle);
    expect(status.exists).toBe(false);
    expect(status.exitCode).toBe(30);
  });

  it('distinguishes exit 0 from "stopped, code unknown"', async () => {
    const succeeded = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(succeeded.id, { exitCode: 0 });
    expect((await fakeOrchestrator.describe(succeeded)).exitCode).toBe(0);

    // The DEFAULT is `null`, not `0`: a machine that deleted itself before
    // anyone read it genuinely has no observable code, and defaulting to success
    // would let a consumer that never handles the unknown case pass its tests.
    const unknown = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(unknown.id);
    expect((await fakeOrchestrator.describe(unknown)).exitCode).toBeNull();
  });

  it('a running container has no exit code yet', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).exitCode).toBeNull();
  });
});

describe('the control surface fails loudly on an unknown container', () => {
  it('completeJob throws rather than silently no-opping', async () => {
    // A test that arranges the wrong id would otherwise assert against a
    // lifecycle that never happened.
    expect(() => fakeOrchestrator.completeJob('nope')).toThrow(/no container nope/);
  });

  it('backdate throws rather than silently no-opping', () => {
    expect(() => fakeOrchestrator.backdate('nope', new Date())).toThrow(/no container nope/);
  });

  it('reset clears every container and every arranged failure', async () => {
    await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.failNextProvision();
    fakeOrchestrator.setBootBehaviour('hang');
    fakeOrchestrator.reset();

    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([]);
    // The arranged failure was cleared, so this resolves.
    const handle = await fakeOrchestrator.provision(SPEC);
    expect((await fakeOrchestrator.describe(handle)).state).toBe('started');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CROSS-PROCESS CONTAINER STORE (Story MOTIR-3778 · Subtask MOTIR-3828)
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ THESE ARE STATEMENTS ABOUT THE PORT TOO, not about a test convenience. The
// property under test is *a container OUTLIVES the process that provisioned it,
// and a later pass re-attaches to it* — which Fly gives for free and a
// module-level `Map` cannot express at all. It stopped being optional when
// `docs/decisions/job-queue-foundation.md` §16 made a supervision a state
// machine over RUNS: the pass that boots and the pass that polls are DIFFERENT
// worker processes by design, and against an in-process map the second one reads
// a perfectly healthy container as `exists: false` — which `pollIndexContainer`
// then correctly classifies `never_started`.
//
// So a fake without this seam does not merely cover less; it asserts the
// OPPOSITE of the port's contract. `tests/e2e/code-graph-refresh-engine.spec.ts`
// is where that surfaced, and these are the same facts at unit speed.
//
// Every test here drives the seam through its PUBLIC door — the environment
// variable — and each gets its own file, because a store leaking between two
// tests is precisely the confusion the seam exists to model deliberately.

/** The persisted shape, spelled out so a hand-written row is a real one. */
interface PersistedRow {
  handle: { provider: string; id: string; region: string; createdAt: string };
  spec: ContainerSpec;
  state: string;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  gone: boolean;
}

describe('the cross-process container store — a container outliving its process', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-orchestrator-store-'));
    // Deliberately a directory that does NOT exist yet: the lane names a path
    // under its own scratch root and expects the adapter to create it.
    statePath = join(dir, 'nested', 'containers.json');
    process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'] = statePath;
  });

  afterEach(() => {
    delete process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'];
    rmSync(dir, { recursive: true, force: true });
    fakeOrchestrator.reset();
  });

  const readStore = (): Record<string, PersistedRow> =>
    JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, PersistedRow>;

  /** Write a container NO test in this process provisioned — a previous worker's. */
  function seedForeignContainer(
    id: string,
    times: { createdAt: Date; startedAt: Date | null; state?: string },
  ): ContainerHandle {
    const handle: ContainerHandle = {
      provider: 'fake',
      id,
      region: 'iad',
      createdAt: times.createdAt,
    };
    const row: PersistedRow = {
      handle: { ...handle, createdAt: times.createdAt.toISOString() },
      spec: SPEC,
      state: times.state ?? 'started',
      createdAt: times.createdAt.toISOString(),
      startedAt: times.startedAt ? times.startedAt.toISOString() : null,
      stoppedAt: null,
      exitCode: null,
      gone: false,
    };
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ [id]: row }), 'utf8');
    return handle;
  }

  it('a provision WRITES the container out, timestamps as ISO strings', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    const store = readStore();
    expect(Object.keys(store)).toEqual([handle.id]);
    expect(store[handle.id]!.handle.createdAt).toBe(handle.createdAt.toISOString());
    expect(store[handle.id]!.startedAt).toBe(handle.createdAt.toISOString());
    expect(store[handle.id]!.stoppedAt).toBeNull();
    expect(store[handle.id]!.gone).toBe(false);
  });

  it('a `never_start` container serialises a NULL start instant', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const handle = await fakeOrchestrator.provision(SPEC);
    expect(readStore()[handle.id]!.startedAt).toBeNull();
    expect(readStore()[handle.id]!.state).toBe('created');
  });

  it('completeJob writes the STOP instant through, so another process sees the exit', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    fakeOrchestrator.completeJob(handle.id, { exitCode: 0 });
    const row = readStore()[handle.id]!;
    expect(row.gone).toBe(true);
    expect(row.exitCode).toBe(0);
    expect(typeof row.stoppedAt).toBe('string');
  });

  it('backdate reaches the shared store, not only this process', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    const old = new Date('2026-08-01T00:00:00.000Z');
    fakeOrchestrator.backdate(handle.id, old);
    expect(readStore()[handle.id]!.createdAt).toBe(old.toISOString());
    expect(readStore()[handle.id]!.handle.createdAt).toBe(old.toISOString());
  });

  it('⚠️ THE PROPERTY — a container THIS process never provisioned is live and describable', async () => {
    const createdAt = new Date('2026-08-20T10:00:00.000Z');
    const handle = seedForeignContainer('fake-machine-90001-1', {
      createdAt,
      startedAt: createdAt,
    });

    expect(fakeOrchestrator.liveContainerIds()).toEqual([handle.id]);
    const status = await fakeOrchestrator.describe(handle);
    expect(status).toMatchObject({ exists: true, state: 'started', terminal: false });
    expect(status.createdAt).toEqual(createdAt);
    expect(status.startedAt).toEqual(createdAt);
  });

  it('teardown of a container from another process meters ITS lifecycle, not the handle alone', async () => {
    // The header's own claim, asserted: without the shared read the usage row
    // would be built from the handle plus whatever the caller observed, and the
    // container's real start instant would be lost.
    const createdAt = new Date('2026-08-20T10:00:00.000Z');
    const startedAt = new Date('2026-08-20T10:00:04.000Z');
    const handle = seedForeignContainer('fake-machine-90002-1', { createdAt, startedAt });

    const usage = await fakeOrchestrator.teardown(handle, 'job_timed_out', {
      ...ATTRIBUTION,
      observedStartedAt: null,
    });
    expect(usage.startedAt).toEqual(startedAt);
    expect(usage.createdAt).toEqual(createdAt);
    expect(usage.billableSeconds).toBeGreaterThan(0);
    // …and the destroy is written back, so the next process does not re-attach.
    expect(readStore()[handle.id]!.gone).toBe(true);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('reap sees a container from another process, and is what makes the orphan case testable', async () => {
    const createdAt = new Date('2026-08-20T10:00:00.000Z');
    const handle = seedForeignContainer('fake-machine-90003-1', {
      createdAt,
      startedAt: createdAt,
    });
    const usages = await fakeOrchestrator.reap(new Date('2026-08-21T00:00:00.000Z'), async () => ({
      ...ATTRIBUTION,
    }));
    expect(usages.map((u) => u.handleId)).toEqual([handle.id]);
    expect(usages[0]!.teardownReason).toBe('reaped');
  });

  it('the handle id carries the PID under the seam, so two workers cannot collide', async () => {
    // `sequence` restarts at 0 in a fresh process, so without this a restarted
    // worker's first provision would take the previous one's id — and re-attach
    // to a container it never booted.
    const handle = await fakeOrchestrator.provision(SPEC);
    expect(handle.id).toBe(`fake-machine-${process.pid}-1`);
  });

  it('a TORN read is survived — a half-written file is not a corrupt fake', async () => {
    const handle = await fakeOrchestrator.provision(SPEC);
    // Exactly what a reader sees mid-write: valid JSON's opening, truncated.
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{"fake-machine-1":{"handle":{"prov', 'utf8');
    // No throw, and this process keeps what it already has — strictly better
    // than failing inside a provider call the caller cannot retry meaningfully.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([handle.id]);
  });

  it('a store file that does not exist yet is simply empty', () => {
    expect(existsSync(statePath)).toBe(false);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('reset clears the shared file too, so a lane does not inherit the last spec containers', async () => {
    await fakeOrchestrator.provision(SPEC);
    expect(Object.keys(readStore())).toHaveLength(1);
    fakeOrchestrator.reset();
    expect(readStore()).toEqual({});
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });
});

describe('with the seam OFF the fake is byte-for-byte the in-memory singleton', () => {
  it('writes no file and keeps the stable `fake-machine-N` ids every other suite reads', async () => {
    expect(process.env['MOTIR_FAKE_CONTAINER_STATE_PATH']).toBeUndefined();
    const handle = await fakeOrchestrator.provision(SPEC);
    expect(handle.id).toBe('fake-machine-1');
  });
});

describe('sparedByCaller', () => {
  it('a spare check that throws a non-Error still spares nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handle = { provider: 'fake' as const, id: 'c-1', region: 'iad', createdAt: new Date() };
    expect(await sparedByCaller(() => Promise.reject('not an error'), handle)).toBe(false);
    expect(warn.mock.calls[0]![1]).toMatchObject({ detail: 'unknown' });
    warn.mockRestore();
  });
});

describe('createFakeOrchestrator — one fake per fleet account (MOTIR-8964)', () => {
  it('keeps its own containers, apart from the singleton and from every other fake', async () => {
    const a = createFakeOrchestrator({ idPrefix: 'account-a' });
    const b = createFakeOrchestrator({ idPrefix: 'account-b' });

    const handle = await a.provision(SPEC);

    expect(handle.id).toBe('account-a-1');
    expect(a.liveContainerIds()).toEqual([handle.id]);
    expect(b.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('never takes the cross-process store, even with the seam variable set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-account-'));
    const path = join(dir, 'state.json');
    vi.stubEnv('MOTIR_FAKE_CONTAINER_STATE_PATH', path);
    try {
      const handle = await createFakeOrchestrator().provision(SPEC);
      expect(handle.id).toBe('fake-machine-1');
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the architecture each spec asked for (MOTIR-11782)', () => {
  it('is recorded in order, an absent architecture read as x86_64', async () => {
    await fakeOrchestrator.provision(SPEC);
    await fakeOrchestrator.provision({ ...SPEC, architecture: 'arm64' });
    await fakeOrchestrator.provision({ ...SPEC, architecture: 'x86_64' });

    expect(fakeOrchestrator.architectures()).toEqual(['x86_64', 'arm64', 'x86_64']);
  });
});
