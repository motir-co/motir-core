import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE SYSTEM-EVENT DOORS (Story MOTIR-3415 · Subtask MOTIR-3456).
//
// `sendSystemEvent` and `dispatchSystemEvent` exist so every `system.*` emitter
// goes through ONE seam. Four of them used to reach the queue directly, so a
// change to what emitting means — at the time the per-job cutover switch, today
// the engine's idempotency and debounce — simply did not reach them.
//
// ⚠️ WHAT THESE ASSERT IS THAT NOTHING OBSERVABLE MOVED. MOTIR-3413's boundary is
// "no job's OBSERVABLE behaviour changes", and routing four events through a new
// module is exactly the kind of change that quietly breaks that: the same event
// must still reach the same job with the same payload, and — the part most
// easily lost in a refactor — each caller's ERROR POLICY must survive. Two of
// the four deliberately do NOT swallow (one reports its outcome, one wants a
// step retry), which is why there are two doors rather than one.
//
// ⚠️ THERE USED TO BE TWO TRANSPORTS HERE (MOTIR-3418 removed one). This file
// mocked the dispatcher AND spied the vendor client, and half its assertions were
// about the relationship between them: both lanes attempted, the vendor send
// skipped once every subscriber had moved, an engine failure not cancelling the
// vendor send. There is one write now, so `dispatchEventToEngine` IS the
// transport, and each of those cases is either gone or restated against it.

const dispatchToEngineMock = vi.fn();

vi.mock('@/lib/jobs/engine/dispatcher', () => ({
  dispatchEventToEngine: (...a: unknown[]) => dispatchToEngineMock(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dispatchToEngineMock.mockResolvedValue({
    eventId: null,
    enqueued: [],
    alreadyEnqueued: [],
    coalesced: [],
    failed: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The four events that used to bypass the seam, with the payload each carries. */
const CONVERTED = [
  { name: 'system.billing-seat-sync', data: { organizationId: 'org_1' } },
  {
    name: 'system.code-graph-index',
    data: {
      installationId: 'inst_1',
      workspaceId: 'ws_1',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    },
  },
  {
    name: 'system.code-graph-refresh',
    data: {
      installationId: 'inst_1',
      workspaceId: 'ws_1',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    },
  },
  { name: 'system.ci-runner-boot', data: { intentId: 'intent_1', workspaceId: null } },
] as const;

describe('sendSystemEvent — the best-effort door', () => {
  it.each(CONVERTED)('reaches the engine for $name, with its payload', async ({ name, data }) => {
    const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');
    await sendSystemEvent(name, data as never);

    // The whole point of the card: the emitter goes through the seam, and the
    // payload arrives BYTE-IDENTICAL.
    expect(dispatchToEngineMock).toHaveBeenCalledWith(name, data, { idempotencyKey: null });
  });

  it('SWALLOWS a transport failure — the caller emits post-commit', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchToEngineMock.mockRejectedValue(new Error('engine down'));
    const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      sendSystemEvent('system.billing-seat-sync', { organizationId: 'org_1' }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});

describe('dispatchSystemEvent — the strict door', () => {
  it('RETHROWS a transport failure, so a step retry and an outcome report still work', async () => {
    dispatchToEngineMock.mockRejectedValue(new Error('engine down'));
    const { dispatchSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      dispatchSystemEvent('system.ci-runner-boot', { intentId: 'intent_1', workspaceId: null }),
    ).rejects.toThrow('engine down');
  });

  it('is otherwise identical to the best-effort door on the happy path', async () => {
    const { dispatchSystemEvent } = await import('@/lib/jobs/sendEvent');
    await dispatchSystemEvent('system.ci-runner-boot', { intentId: 'intent_1', workspaceId: null });

    expect(dispatchToEngineMock).toHaveBeenCalledWith(
      'system.ci-runner-boot',
      { intentId: 'intent_1', workspaceId: null },
      { idempotencyKey: null },
    );
  });
});

describe('the converted call sites keep their existing error policy', () => {
  // ⚠️ THESE THREE RESET THE MODULE GRAPH BEFORE MOCKING, and that is not
  // ceremony. `sendEvent` now side-effect-imports the registry, which imports
  // `definitions/ciRunnerFleet.ts`, which imports `@/lib/ciFleet/bootDispatch` —
  // so by the time a `vi.doMock` ran at test time the module under test was
  // already cached and the mock did nothing. Two of these tests passed anyway,
  // for the worst possible reason: unmocked, `isCloudBilling()` returns false and
  // `enqueueScaledTrackerSeatSync` returns before it ever reaches the transport,
  // so the assertion "it does not throw" held vacuously. Each test below now
  // asserts the transport was actually REACHED.

  /** A fresh module graph with the gates open and the transport failing. */
  async function withFailingTransport(): Promise<{ send: ReturnType<typeof vi.fn> }> {
    vi.resetModules();
    // SPREAD the originals — these modules export more than the one gate each
    // test opens, and a wholesale replacement drops constants their siblings
    // read (`ORCHESTRATOR_REQUEST_TIMEOUT_MS`, which `ciRunnerBootService` needs
    // at module scope).
    vi.doMock('@/lib/billing/availability', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/billing/availability')>()),
      isCloudBilling: () => true,
    }));
    vi.doMock('@/lib/orchestrator', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/orchestrator')>()),
      isOrchestratorConfigured: () => true,
      // The CI runner's own gate (MOTIR-10625), which `dispatchCiRunnerBoot` reads.
      isCiFleetConfigured: async () => true,
    }));
    const send = vi.fn().mockRejectedValue(new Error('down'));
    vi.doMock('@/lib/jobs/engine/dispatcher', () => ({
      dispatchEventToEngine: (...a: unknown[]) => send(...a),
    }));
    return { send };
  }

  afterEach(() => {
    vi.doUnmock('@/lib/billing/availability');
    vi.doUnmock('@/lib/orchestrator');
    vi.doUnmock('@/lib/jobs/engine/dispatcher');
    vi.resetModules();
  });

  it('enqueueScaledTrackerSeatSync SWALLOWS a transport failure it actually reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

    const { enqueueScaledTrackerSeatSync } = await import('@/lib/billing/seatSync');
    await expect(enqueueScaledTrackerSeatSync('org_1')).resolves.toBeUndefined();
    // The part that makes the assertion above mean anything.
    expect(send).toHaveBeenCalledWith(
      'system.billing-seat-sync',
      { organizationId: 'org_1' },
      {
        idempotencyKey: null,
      },
    );
  });

  it('dispatchCiRunnerBoot still REPORTS send_failed rather than swallowing silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

    const { dispatchCiRunnerBoot } = await import('@/lib/ciFleet/bootDispatch');
    // The outcome is the seam this function exists to expose. Had the strict door
    // swallowed, this would read 'dispatched' and the caller would be lied to.
    await expect(dispatchCiRunnerBoot('intent_1')).resolves.toBe('send_failed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('enqueueCodeGraphIndex SWALLOWS a transport failure it actually reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

    const { enqueueCodeGraphIndex } = await import('@/lib/github/indexEnqueue');
    await expect(
      enqueueCodeGraphIndex({
        installationId: 'i',
        workspaceId: 'w',
        repoOwner: 'o',
        repoName: 'r',
        defaultBranch: 'main',
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});
