import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_ACTION_CONTEXT } from '@/lib/monitoring/expectedDomainErrors';

// THE CATCH-ALL REPORT of a result-shaped Server Action (MOTIR-10972). Sentry is
// faked at its module boundary; what is asserted is what reaches it and the log:
// the error (scrubbed), the action's context, and that a failing report never
// throws into the action.

const sentry = vi.hoisted(() => ({
  scope: {
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
  },
  captureException: vi.fn(),
  withScope: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  withScope: sentry.withScope,
}));

const { reportActionFault, actionFaultDetail } = await import('@/lib/actions/actionFault');

const TOKEN = 'ghs_abcdefghijklmnopqrstuvwxyz0123';

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  sentry.withScope.mockImplementation((fn: (scope: typeof sentry.scope) => void) =>
    fn(sentry.scope),
  );
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

describe('actionFaultDetail', () => {
  it('keeps an Error’s name and code and scrubs its message', () => {
    const err = Object.assign(new Error(`expired transaction near ${TOKEN}`), { code: 'P2028' });
    err.name = 'PrismaClientKnownRequestError';
    expect(actionFaultDetail(err)).toEqual({
      name: 'PrismaClientKnownRequestError',
      code: 'P2028',
      message: 'expired transaction near [redacted]',
    });
  });

  it('reads a numeric code as text, and no code as null', () => {
    expect(actionFaultDetail(Object.assign(new Error('x'), { code: 57014 })).code).toBe('57014');
    expect(actionFaultDetail(new Error('x')).code).toBeNull();
  });

  it('describes a thrown non-Error by its type and text', () => {
    expect(actionFaultDetail(`raw ${TOKEN}`)).toEqual({
      name: 'string',
      code: null,
      message: 'raw [redacted]',
    });
    expect(actionFaultDetail(null)).toEqual({ name: 'object', code: null, message: 'null' });
  });
});

describe('reportActionFault', () => {
  it('logs the constant line with the context and the scrubbed error', () => {
    const err = Object.assign(new Error(`boom ${TOKEN}`), { code: 'P2028' });
    reportActionFault(err, '[admin] thing failed', 'setThingAction', { projectId: 'p1', on: true });
    expect(log).toHaveBeenCalledWith('[admin] thing failed', {
      projectId: 'p1',
      on: true,
      error: { name: 'Error', code: 'P2028', message: 'boom [redacted]' },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it('reports to Sentry at error, tagged and with the action context kept by the filter', () => {
    const err = Object.assign(new Error(`boom ${TOKEN}`), { code: 'P2028' });
    err.stack = `Error: boom ${TOKEN}\n    at somewhere`;
    reportActionFault(err, '[admin] thing failed', 'setThingAction', { org: 'acme', on: false });

    expect(sentry.scope.setLevel).toHaveBeenCalledWith('error');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('action_fault', 'setThingAction');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('error_code', 'P2028');
    expect(sentry.scope.setContext).toHaveBeenCalledWith(SERVER_ACTION_CONTEXT, {
      action: 'setThingAction',
      org: 'acme',
      on: false,
    });
    const sent = sentry.captureException.mock.calls[0]![0] as Error;
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toBe('boom [redacted]');
    expect(sent.stack).toContain('at somewhere');
    expect(sent.stack).not.toContain(TOKEN);
  });

  it('sets no code tag for an error without one, and sends no stack for a non-Error', () => {
    reportActionFault('plain', '[admin] thing failed', 'setThingAction', {});
    expect(sentry.scope.setTag).not.toHaveBeenCalledWith('error_code', expect.anything());
    const sent = sentry.captureException.mock.calls[0]![0] as Error;
    expect(sent.name).toBe('string');
    expect(sent.stack).toBeUndefined();
  });

  it('never throws when Sentry does, and the log line still holds the fault', () => {
    sentry.withScope.mockImplementation(() => {
      throw new Error('sentry down');
    });
    expect(() =>
      reportActionFault(new Error('boom'), '[admin] thing failed', 'setThingAction', {}),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
