import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The DSN gate (Subtask 8.5.6 / MOTIR-1162).
//
// ⚠️ THE CARD ASKED FOR THIS TO BE A TEST RATHER THAN A TRY. "With the DSN unset
// the app builds and runs with monitoring disabled" is the self-hoster's whole
// guarantee, and the way it breaks is not a crash — it is an SDK that
// initialises against an empty DSN, installs its integrations, patches the
// globals and then quietly fails to send. Trying it once and seeing nothing
// arrive proves nothing about that state; asserting `init` was never CALLED
// does.
//
// The three surfaces are asserted separately because they are three separate
// files that Next loads by NAME, in three different runtimes. A shared helper
// they all called would make this one test; they do not have one, deliberately
// (the Edge runtime resolves `@sentry/nextjs` to a different build), so the
// gate is asserted three times.

const init = vi.hoisted(() => vi.fn());
const captureRouterTransitionStart = vi.hoisted(() => vi.fn());
const captureRequestError = vi.hoisted(() => vi.fn());
const withScope = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nextjs', () => ({
  init,
  captureRouterTransitionStart,
  captureRequestError,
  withScope,
}));

const TASK_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** A core web task on Fargate: what ECS injects, plus the process name infra sets. */
function stubFargateTask(): void {
  vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', `http://169.254.170.2/v4/${TASK_ID}-2531612879`);
  vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', 'web');
}

/** Every monitoring variable cleared — the self-hoster's environment. */
function clearMonitoringEnv(): void {
  for (const name of [
    'SENTRY_DSN',
    'SENTRY_ENVIRONMENT',
    'NEXT_PUBLIC_SENTRY_DSN',
    'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
    'SENTRY_TRACES_SAMPLE_RATE',
    'AWS_EXECUTION_ENV',
    'AWS_REGION',
    'ECS_CONTAINER_METADATA_URI_V4',
    'MONITORING_CLOUDWATCH_SERVICE',
  ]) {
    vi.stubEnv(name, '');
  }
}

beforeEach(() => {
  vi.resetModules();
  init.mockClear();
  clearMonitoringEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  ['server', '@/sentry.server.config', 'SENTRY_DSN'],
  ['edge', '@/sentry.edge.config', 'SENTRY_DSN'],
  ['client', '@/instrumentation-client', 'NEXT_PUBLIC_SENTRY_DSN'],
] as const)('the %s runtime', (_runtime, modulePath, dsnVar) => {
  it('does NOT call Sentry.init when the DSN is unset', async () => {
    await import(modulePath);
    expect(init).not.toHaveBeenCalled();
  });

  it('does NOT call Sentry.init when the DSN is whitespace', async () => {
    // A secret set to an empty string is the shape a mis-typed `--build-arg`
    // produces, and `Boolean('  ')` is true.
    vi.stubEnv(dsnVar, '   ');
    await import(modulePath);
    expect(init).not.toHaveBeenCalled();
  });

  it('DOES call Sentry.init when the DSN is set, and never sends PII', async () => {
    vi.stubEnv(dsnVar, 'https://key@o1.ingest.us.sentry.io/2');
    await import(modulePath);
    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['dsn']).toBe('https://key@o1.ingest.us.sentry.io/2');
    // An error report is a subset of what the database already holds only if it
    // stays one. MOTIR-1161's transfer basis was recorded for error payloads.
    expect(options['sendDefaultPii']).toBe(false);
    // Error monitoring is what this card buys; tracing has a bill and no
    // baseline to justify it yet.
    expect(options['tracesSampleRate']).toBe(0);
  });
});

describe('the SERVER and EDGE runtimes read the RUNTIME environment', () => {
  it.each(['@/sentry.server.config', '@/sentry.edge.config'])(
    '%s takes its environment from SENTRY_ENVIRONMENT and filters expected 4xx',
    async (modulePath) => {
      vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
      vi.stubEnv('SENTRY_ENVIRONMENT', 'staging');

      await import(modulePath);

      const options = init.mock.calls[0]![0] as Record<string, unknown>;
      // Deliberately a runtime read, not a build-time one: it is the only thing
      // distinguishing two deployments of the SAME image (MOTIR-1161 §4).
      expect(options['environment']).toBe('staging');
      expect(typeof options['beforeSend']).toBe('function');
    },
  );
});

// ── THE TRACE RATE IS A PER-DEPLOYMENT SETTING (MOTIR-8549) ────────────────
//
// It was a compiled 0. It is now `SENTRY_TRACES_SAMPLE_RATE`, read at boot by the
// server and the edge only; unset, empty or nonsense is still 0, the browser is
// still 0, and none of it can make a DSN-less build call `init`.
describe('the SERVER and EDGE trace at the deployment rate (MOTIR-8549)', () => {
  const DSN = 'https://key@o1.ingest.us.sentry.io/2';

  it.each(['@/sentry.server.config', '@/sentry.edge.config'])(
    '%s passes SENTRY_TRACES_SAMPLE_RATE through when it is in [0, 1]',
    async (modulePath) => {
      vi.stubEnv('SENTRY_DSN', DSN);
      vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '0.25');
      await import(modulePath);
      const options = init.mock.calls[0]![0] as Record<string, unknown>;
      expect(options['tracesSampleRate']).toBe(0.25);
    },
  );

  it.each([
    ['@/sentry.server.config', ''],
    ['@/sentry.server.config', 'abc'],
    ['@/sentry.server.config', '2'],
    ['@/sentry.server.config', '-1'],
    ['@/sentry.edge.config', ''],
    ['@/sentry.edge.config', 'abc'],
    ['@/sentry.edge.config', '2'],
    ['@/sentry.edge.config', '-1'],
  ])('%s falls back to 0 for %j', async (modulePath, value) => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import(modulePath);
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['tracesSampleRate']).toBe(0);
    warn.mockRestore();
  });

  it('the CLIENT stays at 0 whatever the runtime rate says', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
    await import('@/instrumentation-client');
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['tracesSampleRate']).toBe(0);
  });

  it.each(['@/sentry.server.config', '@/sentry.edge.config'])(
    '%s tags every event with its Fargate task, process and region (MOTIR-10962)',
    async (modulePath) => {
      vi.stubEnv('SENTRY_DSN', DSN);
      stubFargateTask();
      await import(modulePath);
      const options = init.mock.calls[0]![0] as { initialScope?: { tags?: unknown } };
      expect(options.initialScope?.tags).toEqual({
        'instance.machine': TASK_ID,
        'instance.process_group': 'web',
        'instance.region': 'eu-west-1',
      });
    },
  );

  it.each(['@/sentry.server.config', '@/sentry.edge.config'])(
    '%s carries NO instance tag off Fargate — never an empty string',
    async (modulePath) => {
      vi.stubEnv('SENTRY_DSN', DSN);
      await import(modulePath);
      const options = init.mock.calls[0]![0] as { initialScope?: { tags?: unknown } };
      expect(options.initialScope?.tags).toEqual({});
    },
  );

  it.each(['@/sentry.server.config', '@/sentry.edge.config', '@/instrumentation-client'])(
    '%s still never calls init without a DSN, whatever the rate and the instance tags say',
    async (modulePath) => {
      vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
      stubFargateTask();
      await import(modulePath);
      expect(init).not.toHaveBeenCalled();
    },
  );
});

describe('the transaction-stall monitor sits behind the SAME gate (MOTIR-6701)', () => {
  // The event-loop histogram a P2028 report reads is a timer and a native
  // monitor. A self-hosted build with no DSN reports nothing, so it must not
  // pay for measuring either — the gate is `init`'s, not a second one.
  it('starts NO monitor on the server when the DSN is unset', async () => {
    await import('@/sentry.server.config');
    const { isTransactionStallMonitorRunning } = await import('@/lib/monitoring/transactionStall');
    expect(isTransactionStallMonitorRunning()).toBe(false);
  });

  // MOTIR-8265: the blocking-stack watchdog is a THREAD and an inspector
  // session, so it must not exist where Sentry does not.
  it('starts NO watchdog thread, inspector session or GC observer when the DSN is unset', async () => {
    await import('@/sentry.server.config');
    const { __forTests, isLoopBlockWatchdogRunning } =
      await import('@/lib/monitoring/loopBlockWatchdog');
    expect(isLoopBlockWatchdogRunning()).toBe(false);
    expect(__forTests.threadId()).toBeNull();
  });

  it('starts the watchdog thread when the DSN is set, and stopping it ends the thread', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    await import('@/sentry.server.config');
    const { __forTests } = await import('@/lib/monitoring/loopBlockWatchdog');
    const { stopTransactionStallMonitor } = await import('@/lib/monitoring/transactionStall');
    expect(__forTests.threadId()).not.toBeNull();
    const exited = __forTests.exited();
    stopTransactionStallMonitor();
    await exited;
    expect(__forTests.threadId()).toBeNull();
  });

  it('starts the monitor on the server when the DSN is set', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    await import('@/sentry.server.config');
    const { isTransactionStallMonitorRunning, stopTransactionStallMonitor } =
      await import('@/lib/monitoring/transactionStall');
    expect(isTransactionStallMonitorRunning()).toBe(true);
    stopTransactionStallMonitor();
  });
});

describe('the CLIENT cannot read a runtime environment, and says so', () => {
  it('defaults to production', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    await import('@/instrumentation-client');
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['environment']).toBe('production');
  });

  it('is overridable through the build-argument seam', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_ENVIRONMENT', 'staging');
    await import('@/instrumentation-client');
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['environment']).toBe('staging');
  });

  it('drops React streaming-instruction echoes before they are sent (MOTIR-6773)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    await import('@/instrumentation-client');
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    const { dropOrphanedStreamingInstructions } =
      await import('@/lib/monitoring/orphanedStreamingInstruction');
    expect(options['beforeSend']).toBe(dropOrphanedStreamingInstructions);
  });

  it('records no session replay, at any sample rate', async () => {
    // Replay records the DOM, which here means work-item titles, comment bodies
    // and customer names — a different category of data from a stack trace, and
    // one the subprocessor record does not cover. A deliberate zero, not an
    // unset default.
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');
    await import('@/instrumentation-client');
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['replaysSessionSampleRate']).toBe(0);
    expect(options['replaysOnErrorSampleRate']).toBe(0);
  });

  it('exports the router-transition hook whether or not monitoring is on', async () => {
    // Next reads this module's EXPORTS to find the hook. Gating the export on an
    // env var would make a self-hosted build differ in SHAPE, and Next warns
    // about the missing hook on every such build.
    const mod = await import('@/instrumentation-client');
    expect(mod.onRouterTransitionStart).toBe(captureRouterTransitionStart);
  });
});

describe('the server request-error hook is always exported (`instrumentation.ts`)', () => {
  it('forwards to Sentry.captureRequestError, with no DSN set', async () => {
    // A wrapper since MOTIR-8214 (it tags the digest), so the export is no longer
    // the SDK function itself — what must hold is that every call reaches it.
    captureRequestError.mockClear();
    const mod = await import('@/instrumentation');
    const args = [
      new Error('boom'),
      { path: '/workbench', method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/workbench', routeType: 'render' },
    ] as Parameters<typeof mod.onRequestError>;
    mod.onRequestError(...args);
    expect(captureRequestError).toHaveBeenCalledWith(...args);
    expect(init).not.toHaveBeenCalled();
  });

  it('register() initialises the NODE runtime when a DSN is set', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');

    const { register } = await import('@/instrumentation');
    await register();

    expect(init).toHaveBeenCalledTimes(1);
  });

  it('register() initialises the EDGE runtime too — the early return is below it', async () => {
    // The mock-seam gate returns immediately outside the Node runtime, and
    // monitoring must not be behind that return: `proxy.ts` runs on the Edge and
    // its errors are as real as any other.
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.us.sentry.io/2');

    const { register } = await import('@/instrumentation');
    await register();

    expect(init).toHaveBeenCalledTimes(1);
  });
});

// ── THE FIFTH RUNTIME (MOTIR-3606) ─────────────────────────────────────────
//
// The four surfaces above are Next entry points. The JOB WORKER is not: it is a
// plain esbuild bundle (`pnpm build:worker` → `scripts/worker.ts`) running in
// `fly.toml`'s `worker` process group, and `instrumentation.ts` never executes
// there — its own header says so about the E2E seams. So for the whole life of
// the Postgres job engine, every scheduled job in production ran with NO error
// monitoring, which is half of why `system.daily-health-check` could dead-letter
// 23 mornings running and reach nobody.
//
// ⚠️ IT IS ASSERTED ON THE SOURCE, and that is a deliberate second-best.
// Importing `scripts/worker.ts` starts a claim loop against a database; there is
// nothing to call. What CAN be pinned is that the entrypoint reaches for the
// shared options builder at all — which is the property that was missing, and
// the one a future refactor would silently drop. The same guard shape
// `orchestratorPortBoundary.test.ts` uses, and for the same reason: some things
// only a source read can see.
describe('the WORKER process initialises monitoring — it is not a Next runtime', () => {
  it('scripts/worker.ts calls Sentry.init through the shared options builder', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'scripts/worker.ts'), 'utf8');

    expect(source).toContain('serverSentryInitOptions');
    // From `serverInit`, NOT `config` — `next.config.ts` imports `config`, and a
    // transitive `@/` alias reaching it fails `next build` with MODULE_NOT_FOUND.
    expect(source).toContain('@/lib/monitoring/serverInit');
    expect(source).toMatch(/Sentry\.init\(/);
    // The gate travels with the options: a null return means no DSN, and the
    // worker must then call nothing at all (the self-host contract).
    expect(source).toMatch(/if \(!options\) return;/);
  });

  it('the worker bundle keeps the SDK — it is not in the esbuild `external` set', async () => {
    // A packaging trap with a silent failure mode: marking `@sentry/*` external
    // would resolve at build time here and fail at RUNTIME inside the image,
    // whose `node_modules` is Next's minimal traced set. `build-worker.mjs`
    // states that hazard about `@prisma/client`; this pins it for the SDK.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const build = readFileSync(join(process.cwd(), 'scripts/build-worker.mjs'), 'utf8');
    const externals = /external:\s*\[([^\]]*)\]/.exec(build)?.[1] ?? '';
    expect(externals).not.toContain('sentry');
  });
});
