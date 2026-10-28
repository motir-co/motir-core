import type { TenantClients, TenantCloudFormation, TenantStack, TenantStackWrite } from './clients';
import { AwsTenantApiError } from './errors';

// The FAULT-INJECTING FAKE of a tenant account (MOTIR-10004): CloudFormation held
// in memory by stack name, with the state machine's in-progress states, and a
// control that makes the Nth call of a named operation throw — before it acts
// (the request never landed) or after (it landed, the answer was lost). A test
// cuts a run off at every call in turn and replays it. Later cards add their
// services' fakes to the same bundle.

export type FakeCloudFormationOperation = keyof TenantCloudFormation;

export interface FakeStackRecord {
  status: string;
  templateBody: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  outputs: Record<string, string>;
  /** Describes left before an in-progress state settles. */
  pendingPolls: number;
  settlesTo: string;
  /** What the stack becomes when it settles. */
  next: TenantStackWrite | null;
}

export interface FakeTenantCloudFormation extends TenantCloudFormation {
  readonly stacks: ReadonlyMap<string, FakeStackRecord>;
  /** Every call made, in order: `operation:stackName`. */
  readonly calls: string[];
  /** The `n`th call (1-based, counted from now) of `operation` throws — `before`
   *  it acts, or `after` it has. */
  failAt(operation: FakeCloudFormationOperation, n: number, when?: 'before' | 'after'): void;
  /** The next create of `name` fails and rolls back (`ROLLBACK_COMPLETE`). */
  failNextCreate(name: string): void;
  /** Put a stack in any state, as another actor would. */
  setStatus(name: string, status: string, pendingPolls?: number, settlesTo?: string): void;
  /** How many describes an in-progress state lasts (default 1). */
  pollsToSettle: number;
}

export interface FakeTenantCloudFormationOptions {
  /** A stack's outputs from its name and parameters (default: every parameter
   *  echoed, plus `StackName`). */
  readonly outputs?: (
    name: string,
    parameters: Readonly<Record<string, string>>,
  ) => Record<string, string>;
}

export function createFakeTenantCloudFormation(
  options: FakeTenantCloudFormationOptions = {},
): FakeTenantCloudFormation {
  const outputsOf = options.outputs ?? ((name, parameters) => ({ StackName: name, ...parameters }));
  const stacks = new Map<string, FakeStackRecord>();
  const calls: string[] = [];
  const faults: Array<{ operation: string; at: number; when: 'before' | 'after' }> = [];
  const counts = new Map<string, number>();
  const failingCreates = new Set<string>();

  /** Counts the call; throws when a `before` fault is due; answers whether an
   *  `after` fault is. */
  function enter(operation: FakeCloudFormationOperation, name: string): boolean {
    calls.push(`${operation}:${name}`);
    const count = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, count);
    const index = faults.findIndex((f) => f.operation === operation && f.at === count);
    if (index < 0) return false;
    const [fault] = faults.splice(index, 1);
    if (fault!.when === 'before') throw injected();
    return true;
  }
  const injected = () => new AwsTenantApiError('cloudformation', 'InjectedFault', null);

  function missing(name: string): AwsTenantApiError {
    return new AwsTenantApiError('cloudformation', `ValidationError:${name}`, 400);
  }

  function snapshot(name: string, record: FakeStackRecord): TenantStack {
    return {
      name,
      status: record.status,
      parameters: { ...record.parameters },
      tags: { ...record.tags },
      outputs: { ...record.outputs },
    };
  }

  function settle(name: string, record: FakeStackRecord): void {
    record.status = record.settlesTo;
    if (record.status === 'DELETE_COMPLETE') {
      stacks.delete(name);
      return;
    }
    const next = record.next;
    if (next && (record.status === 'CREATE_COMPLETE' || record.status === 'UPDATE_COMPLETE')) {
      record.templateBody = next.templateBody;
      record.parameters = { ...next.parameters };
      record.tags = { ...next.tags };
      record.outputs = outputsOf(name, next.parameters);
    }
    record.next = null;
  }

  const fake: FakeTenantCloudFormation = {
    stacks,
    calls,
    pollsToSettle: 1,

    failAt(operation, n, when = 'before') {
      faults.push({ operation, at: (counts.get(operation) ?? 0) + n, when });
    },
    failNextCreate(name) {
      failingCreates.add(name);
    },
    setStatus(name, status, pendingPolls = 0, settlesTo = status) {
      const record = stacks.get(name);
      if (!record) throw missing(name);
      Object.assign(record, { status, pendingPolls, settlesTo });
    },

    async describeStack(name) {
      const lost = enter('describeStack', name);
      const record = stacks.get(name);
      let answer: TenantStack | null = null;
      if (record) {
        if (record.status.endsWith('_IN_PROGRESS')) {
          if (record.pendingPolls <= 0) settle(name, record);
          else record.pendingPolls -= 1;
        }
        answer = stacks.has(name) ? snapshot(name, record) : null;
      }
      if (lost) throw injected();
      return answer;
    },

    async getTemplateBody(name) {
      const lost = enter('getTemplateBody', name);
      const record = stacks.get(name);
      if (!record) throw missing(name);
      if (lost) throw injected();
      return record.templateBody;
    },

    async createStack(input) {
      const lost = enter('createStack', input.name);
      if (stacks.has(input.name)) {
        throw new AwsTenantApiError('cloudformation', 'AlreadyExistsException', 400);
      }
      const fails = failingCreates.delete(input.name);
      stacks.set(input.name, {
        status: 'CREATE_IN_PROGRESS',
        templateBody: input.templateBody,
        parameters: { ...input.parameters },
        tags: { ...input.tags },
        outputs: {},
        pendingPolls: fake.pollsToSettle,
        settlesTo: fails ? 'ROLLBACK_COMPLETE' : 'CREATE_COMPLETE',
        next: fails ? null : input,
      });
      if (lost) throw injected();
    },

    async updateStack(input) {
      const lost = enter('updateStack', input.name);
      const record = stacks.get(input.name);
      if (!record) throw missing(input.name);
      if (record.status.endsWith('_IN_PROGRESS')) {
        throw new AwsTenantApiError('cloudformation', 'ValidationError:InProgress', 400);
      }
      const unchanged =
        record.templateBody === input.templateBody &&
        JSON.stringify(record.parameters) === JSON.stringify(input.parameters) &&
        JSON.stringify(record.tags) === JSON.stringify(input.tags);
      if (!unchanged) {
        Object.assign(record, {
          status: 'UPDATE_IN_PROGRESS',
          pendingPolls: fake.pollsToSettle,
          settlesTo: 'UPDATE_COMPLETE',
          next: input,
        });
      }
      if (lost) throw injected();
      return unchanged ? 'no_change' : 'updating';
    },

    async deleteStack(name) {
      const lost = enter('deleteStack', name);
      const record = stacks.get(name);
      if (record && !record.status.endsWith('_IN_PROGRESS')) {
        Object.assign(record, {
          status: 'DELETE_IN_PROGRESS',
          pendingPolls: fake.pollsToSettle,
          settlesTo: 'DELETE_COMPLETE',
          next: null,
        });
      }
      if (lost) throw injected();
    },
  };
  return fake;
}

/** A tenant account's clients, all fakes. */
export function createFakeTenantClients(
  options: FakeTenantCloudFormationOptions & { accountId?: string; region?: string } = {},
): TenantClients & { readonly cloudformation: FakeTenantCloudFormation } {
  return {
    accountId: options.accountId ?? '210987654321',
    region: options.region ?? 'us-east-1',
    cloudformation: createFakeTenantCloudFormation(options),
  };
}
