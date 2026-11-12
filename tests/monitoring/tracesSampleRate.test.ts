import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monitoringInstanceTags, serverTracesSampleRate } from '@/lib/monitoring/config';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { relaySentryInitOptions } from '@/lib/agentTerminal/relay/monitoring';

// THE TRACE RATE IS OPT-IN PER PROCESS (MOTIR-8549).
//
// `SENTRY_TRACES_SAMPLE_RATE` is a deployment secret, and it reaches EVERY
// process of the deployment — the job worker and the terminal relay included.
// So the shared options builder must answer an explicit 0 unless its caller
// asks for tracing, and only the web server asks. An omitted rate would not be
// "off": the Node SDK reads the same variable itself.

const DSN = 'https://key@o1.ingest.us.sentry.io/2';

beforeEach(() => {
  for (const name of [
    'SENTRY_DSN',
    'SENTRY_TRACES_SAMPLE_RATE',
    'AWS_EXECUTION_ENV',
    'AWS_REGION',
    'ECS_CONTAINER_METADATA_URI_V4',
    'MONITORING_CLOUDWATCH_SERVICE',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('serverTracesSampleRate', () => {
  it.each([
    ['0', 0],
    ['0.05', 0.05],
    [' 0.5 ', 0.5],
    ['1', 1],
  ])('reads %j as %d', (value, expected) => {
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', value);
    expect(serverTracesSampleRate()).toBe(expected);
  });

  it('is 0 when unset, with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(serverTracesSampleRate()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abc', '1.5', '-0.1', 'NaN', 'Infinity'])(
    'is 0 for %j and warns exactly once, naming the variable',
    (value) => {
      vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', value);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => serverTracesSampleRate()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('SENTRY_TRACES_SAMPLE_RATE');
      // `() => …` above already called it once; reset and count one call.
      warn.mockClear();
      expect(serverTracesSampleRate()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('monitoringInstanceTags', () => {
  it('is empty locally and when self-hosted', () => {
    expect(monitoringInstanceTags()).toEqual({});
  });

  it('omits each value that is unset, rather than tagging an empty string', () => {
    vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
    vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', 'worker');
    vi.stubEnv('AWS_REGION', '  ');
    expect(monitoringInstanceTags()).toEqual({ 'instance.process_group': 'worker' });
  });

  it('is empty off Fargate, even with the process and region set (MOTIR-10962)', () => {
    vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', 'worker');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    expect(monitoringInstanceTags()).toEqual({});
  });
});

describe('the worker and relay guarantee — no tracing unless asked for', () => {
  it('serverSentryInitOptions() with no argument is 0 even when the rate is 1', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
    const options = serverSentryInitOptions();
    // A NUMBER, never undefined: an omitted key lets the SDK read the secret.
    expect(options?.tracesSampleRate).toBe(0);
    expect(serverSentryInitOptions({ traces: false })?.tracesSampleRate).toBe(0);
  });

  it('serverSentryInitOptions({ traces: true }) reads the deployment rate', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '0.1');
    expect(serverSentryInitOptions({ traces: true })?.tracesSampleRate).toBe(0.1);
  });

  it('the relay is 0 even when the rate is 1, and still carries instance tags', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
    vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
    vi.stubEnv('MONITORING_CLOUDWATCH_SERVICE', 'relay');
    const options = relaySentryInitOptions();
    expect(options?.tracesSampleRate).toBe(0);
    expect(options?.initialScope.tags).toEqual({ 'instance.process_group': 'relay' });
  });

  it('the worker and relay sources never opt in', () => {
    // The worker cannot be imported (it starts a claim loop), so the guard is
    // a source read — the same shape sentry-init-gate's worker block uses.
    for (const file of ['scripts/worker.ts', 'lib/agentTerminal/relay/monitoring.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/traces:\s*true/);
    }
  });

  it('no DSN is still null, whatever the rate', () => {
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
    expect(serverSentryInitOptions({ traces: true })).toBeNull();
    expect(relaySentryInitOptions()).toBeNull();
  });
});
