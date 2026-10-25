import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  FakeAwsAccountState,
  FakeAwsInstanceRecord,
  FakeAwsRefusal,
  FakeAwsState,
  FleetSwitchFixture,
} from '@/lib/test-fake-aws';

// THE SPEC'S OWN HALF of `lib/test-fake-aws.ts` (Story MOTIR-9359 · MOTIR-9429):
// reset the fake AWS, flip the agent-runner switch, read what one account
// launched, find the instance a dispatch run booted and the container env it was
// booted with, and write the three controls (refuse the next launch, stop an
// instance as if its container exited, start an untagged VM "by hand"). The
// shape is the state file's own type, imported, so this file and the fake cannot
// drift. A TEST file, never reachable from `instrumentation.ts`, so it reads
// `node:fs` directly — the NFT-tracing rule `lib/test-fixture-file.ts` documents
// is about the production bundle and does not reach here.

/** The tag the AWS adapter names a hosted run's VM by (`AWS_DISPATCH_RUN_TAG_KEY`). */
const DISPATCH_RUN_TAG_KEY = 'motir_dispatch_run_id';

function envPath(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is not set — is this the acceptance lane?`);
  return path;
}

const statePath = () => envPath('MOTIR_FAKE_AWS_STATE_PATH');
const switchPath = () => envPath('MOTIR_FAKE_FLEET_SWITCH_PATH');

/** Replace a file whole, as the fake does, so no lane process reads half of it. */
function replaceFile(path: string, contents: string): void {
  const sibling = `${path}.${process.pid}.tmp`;
  writeFileSync(sibling, contents);
  renameSync(sibling, path);
}

/** The whole state file; the empty state before anything launched. */
export function readFakeAws(): FakeAwsState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<FakeAwsState>;
    return { accounts: parsed.accounts ?? {} };
  } catch {
    return { accounts: {} };
  }
}

function changeAccount(
  account: { id: string; name: string },
  change: (state: FakeAwsAccountState) => void,
): void {
  const state = readFakeAws();
  const slice = state.accounts[account.id] ?? {
    name: account.name,
    instances: {},
    byToken: {},
    refusals: [],
  };
  change(slice);
  state.accounts[account.id] = slice;
  replaceFile(statePath(), JSON.stringify(state));
}

/** Forget every account's instances and controls — once per test. */
export function resetFakeAws(): void {
  replaceFile(statePath(), JSON.stringify({ accounts: {} } satisfies FakeAwsState));
}

/** Point the agent runner at AWS or Fly; read on the next admission. */
export function writeAgentRunnerSwitch(provider: 'aws' | 'fly'): void {
  replaceFile(switchPath(), JSON.stringify({ hostedAgent: provider } satisfies FleetSwitchFixture));
}

/** Remove the switch fixture, so the server's env var decides again. */
export function clearAgentRunnerSwitch(): void {
  replaceFile(switchPath(), JSON.stringify({} satisfies FleetSwitchFixture));
}

/** Every instance one account (by shard id) holds, oldest first. */
export function fakeAwsInstances(shardId: string): FakeAwsInstanceRecord[] {
  const account = readFakeAws().accounts[shardId];
  if (!account) return [];
  return Object.values(account.instances).sort((a, b) =>
    (a.launchTime ?? '').localeCompare(b.launchTime ?? ''),
  );
}

/** The instance a dispatch run booted, on any account, with its account's id. */
export function fakeAwsInstanceForRun(
  dispatchRunId: string,
): { shardId: string; instance: FakeAwsInstanceRecord } | undefined {
  for (const [shardId, account] of Object.entries(readFakeAws().accounts)) {
    const instance = Object.values(account.instances).find((i) =>
      i.tags.some((t) => t.key === DISPATCH_RUN_TAG_KEY && t.value === dispatchRunId),
    );
    if (instance) return { shardId, instance };
  }
  return undefined;
}

/** The container env an instance was booted with — its user-data's
 *  `MOTIR_ENV_<NAME>=<value>` lines, decoded. Empty for a planted instance. */
export function fakeAwsContainerEnv(instance: FakeAwsInstanceRecord): Record<string, string> {
  if (!instance.request) return {};
  const env: Record<string, string> = {};
  const text = Buffer.from(instance.request.userData, 'base64').toString('utf8');
  for (const line of text.split('\n')) {
    const match = /^MOTIR_ENV_([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

/** The run's own credential, as `runTokenFor` reads it off the fake orchestrator. */
export function fakeAwsRunTokenFor(dispatchRunId: string): string {
  const found = fakeAwsInstanceForRun(dispatchRunId);
  const token = found ? fakeAwsContainerEnv(found.instance)['MOTIR_RUN_TOKEN'] : undefined;
  if (!token) {
    throw new Error(
      `no fake-AWS instance has booted for dispatch run ${dispatchRunId} yet (or it carries ` +
        `no MOTIR_RUN_TOKEN) — read this only after the boot has reached RunInstances`,
    );
  }
  return token;
}

/** CONTROL — refuse the next launch on an account (in `zone`, or any zone) with
 *  an AWS error code, e.g. `InsufficientInstanceCapacity` or `VcpuLimitExceeded`. */
export function refuseNextLaunch(
  account: { id: string; name: string },
  refusal: FakeAwsRefusal,
): void {
  changeAccount(account, (state) => {
    state.refusals.push(refusal);
  });
}

/** CONTROL — stop an instance as if its container exited: `describe` reads it
 *  ended, dated now. */
export function stopFakeAwsInstance(
  account: { id: string; name: string },
  instanceId: string,
): void {
  changeAccount(account, (state) => {
    const instance = state.instances[instanceId];
    if (!instance) throw new Error(`no instance ${instanceId} on ${account.name}`);
    instance.state = 'stopped';
    instance.stateTransitionReason = `User initiated (${new Date()
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')} GMT)`;
  });
}

/** CONTROL — a VM "started by hand": no tags at all, launched at `launchedAt`.
 *  Answers its instance id. */
export function plantUntaggedInstance(
  account: { id: string; name: string },
  launchedAt: Date,
): string {
  let id = '';
  for (let i = 0; i < 17; i += 1) id += Math.floor(Math.random() * 16).toString(16);
  const instanceId = `i-${id}`;
  changeAccount(account, (state) => {
    state.instances[instanceId] = {
      instanceId,
      state: 'running',
      launchTime: launchedAt.toISOString(),
      stateTransitionReason: null,
      availabilityZone: 'us-east-1a',
      tags: [],
      request: null,
    };
  });
  return instanceId;
}
