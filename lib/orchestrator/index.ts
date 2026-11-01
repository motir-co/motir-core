import {
  AWS_MANAGEMENT_ENV,
  AWS_RUNNER_IAM_ROLE,
  awsTerminalEndpoint,
  awsManagementCredentials,
  awsManagementRequiredEnv,
  createAwsFleetInventory,
  createAwsManagementApi,
  createAwsOrchestrator,
  createAwsPersistentOrchestrator,
  createEc2Api,
  Ec2ApiError,
  createFakeOrchestrator,
  createFlyOrchestrator,
  createHostAgentClient,
  createUsageSink,
  fakeFleetInventory,
  flyFleetInventory,
  isFlyInventoryConfigured,
  fakeOrchestrator,
  fakePersistentOrchestrator,
  OrchestratorCapacityError,
  type FakeCapacityOperation,
  flyFleetConfig,
  flyIndexerImage,
  flyOrchestrator,
  flyPersistentOrchestrator,
  isFlyFleetConfigured,
  isFlyInstancesConfigured,
  isFlyIndexerImageConfigured,
  INDEXER_IMAGE_ENV_VAR,
  OrchestratorNotConfiguredError,
  probeImagePull,
  type AwsManagementApi,
  type ContainerOrchestrator,
  type Ec2Api,
  type FakeOrchestratorControls,
  type FleetInventory,
  type OrchestratorProvider,
  type PersistentContainerHandle,
  type PersistentContainerOrchestrator,
  type PersistentTerminalEndpoint,
  type RegistryCredentialResolver,
} from '@motir/orchestrator';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  appendShardFakeCall,
  holdShardShared,
  releaseShardShared,
  shardFakeJournalShared,
  shardHeldShared,
} from '@/lib/orchestrator/shardFakeJournal';
import { selectedOrchestratorProvider } from './provider';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { ciPreviewUsageMeterService } from '@/lib/services/ciPreviewUsageMeterService';
import { observeHostingDestroyApp } from './hosting';
import { observeDatabaseBranchDelete } from './database';
import { withPlatformMeterReport } from '@/lib/services/platformMeterReportEnqueue';

// ⚠️ THIS FILE IS THE PACKAGE'S COMPOSITION ROOT (MOTIR-4299), and it is the ONE
// app file that names `@motir/orchestrator`'s implementation choices.
//
// Everything under `lib/orchestrator/` moved into `packages/orchestrator` —
// eleven files, the port, both adapters and the fake. What could NOT move is
// what is written below: choosing an adapter reads THIS DEPLOYMENT's
// environment, and recording a container's cost calls THIS APP's service. Both
// are composition, and `docs/decisions/app-shell-over-packages.md` §1 puts
// composition in the app, precisely so the package can be built and tested
// without one.
//
// So this file does three things and nothing else: it SELECTS (the adapter),
// it BINDS (the cost meter into the package's `UsageMeter` port), and it
// RE-EXPORTS the package's surface so no consumer above has to know which half
// of the boundary a symbol came from.

// WHICH adapter is behind the port on this deployment (Story MOTIR-1916 ·
// MOTIR-1921).
//
// This module is the ONLY place that names both adapters, and it is the reason
// no caller has to. `ciRunnerBootService` asks for "the orchestrator" and gets
// one; swapping Fly for §3's documented migration target (B1 · RunsOn) is a new
// file under `adapters/` plus one branch here.
//
// ⚠️ READ AT CALL TIME, never module load. A self-hosted `motir-core` never
// provisions a container (§8.5's posture, one domain over: off-cloud there is no
// meter, no pool and no fleet), and it must not crash on boot for want of a Fly
// token — it must simply be unable to reach this path. Same contract
// `appAuth.ts` and `ciMetering/config.ts` hold.

// The selector itself lives in `./provider`, which loads no database, so a
// DB-free caller (the hosting accessor, `./hosting`) can read it too.
export { selectedOrchestratorProvider } from './provider';

/**
 * The orchestrator, or the typed not-configured error.
 *
 * It THROWS rather than returning null for the reason
 * `projectRunnerGroupService.requireRunnerGroupId` does: a nullable return
 * invites a lenient fallback at the call site, and the lenient fallback for "no
 * orchestrator" is silently not booting a runner while reporting success — a job
 * that then queues at GitHub for 24 hours and is cancelled, which reads as an
 * outage rather than a misconfiguration.
 */
export function getOrchestrator(): ContainerOrchestrator {
  const provider = selectedOrchestratorProvider();
  if (provider === 'fake') return fakeOrchestrator;
  if (!isFlyFleetConfigured()) {
    throw new OrchestratorNotConfiguredError(
      'set FLY_FLEET_API_TOKEN, FLY_FLEET_APP and MOTIR_RUNNER_IMAGE, or select the fake adapter',
    );
  }
  return flyOrchestrator;
}

/**
 * The PERSISTENT half of the port — a user agent instance's machine and volume
 * (Story MOTIR-6860 · MOTIR-6869, `docs/decisions/agent-instances.md` §1, §7) —
 * or the typed not-configured error. Selected by the same
 * `MOTIR_FLEET_ORCHESTRATOR` switch as the ephemeral half, so a suite that
 * selects the fake gets both fakes; configured by the instance lane's OWN
 * variables, never `FLY_FLEET_*` (§7).
 */
export function getPersistentOrchestrator(): PersistentContainerOrchestrator {
  if (selectedOrchestratorProvider() === 'fake') return fakePersistentOrchestrator;
  if (!isFlyInstancesConfigured()) {
    throw new OrchestratorNotConfiguredError(
      'set FLY_INSTANCES_API_TOKEN, or select the fake adapter',
    );
  }
  return flyPersistentOrchestrator;
}

/**
 * Where the terminal relay dials ONE agent's terminal server
 * (`docs/decisions/agent-terminal.md` Q2 · MOTIR-6940), through the selected
 * adapter's `terminalEndpoint`. Deliberately NOT via
 * {@link getPersistentOrchestrator}: that one refuses without
 * `FLY_INSTANCES_API_TOKEN`, and the relay holds NO Fly token (Q1) — resolving an
 * address needs none, since the Fly adapter's answer is pure (the org app's
 * public hostname plus `fly-force-instance-id`).
 */
export async function persistentTerminalEndpoint(
  handle: PersistentContainerHandle,
): Promise<PersistentTerminalEndpoint> {
  const adapter =
    selectedOrchestratorProvider() === 'fake'
      ? fakePersistentOrchestrator
      : flyPersistentOrchestrator;
  // Awaited since MOTIR-9470: an AWS instance's address is read at dial time.
  return await adapter.terminalEndpoint(handle);
}

/** Can this deployment boot agent instances at all? Never throws. */
export function isPersistentOrchestratorConfigured(): boolean {
  return selectedOrchestratorProvider() === 'fake' || isFlyInstancesConfigured();
}

/**
 * The FLEET INVENTORY (Story MOTIR-6906 · MOTIR-6925) — what the provider says
 * is running across Motir's whole fleet organisation, for the attribution
 * reconciler — or null on a deployment that has no fleet to inventory. Selected
 * by the same `MOTIR_FLEET_ORCHESTRATOR` switch, so a suite that selects the
 * fake inventories the fakes it booted.
 */
export function getFleetInventory(): FleetInventory | null {
  if (selectedOrchestratorProvider() === 'fake') return fakeFleetInventory;
  return isFlyInventoryConfigured() ? flyFleetInventory : null;
}

/** Can this deployment provision containers at all? Never throws — the sweep
 *  uses it to stay inert on a self-hosted build rather than logging an error
 *  every minute. */
export function isOrchestratorConfigured(): boolean {
  return selectedOrchestratorProvider() === 'fake' || isFlyFleetConfigured();
}

// ── The INDEX workload's configuration (MOTIR-1981 · MOTIR-1989) ─────────────
//
// The index fleet needs everything the CI fleet needs (an orchestrator that can
// boot a machine) PLUS its own digest-pinned image, which is a different image
// with its own release lane. The two accessors below are the index workload's
// twin of `getOrchestrator()` / `isOrchestratorConfigured()`, and they live here
// — the composition root — for the reason that function does: this is the one
// file outside `adapters/fly/` permitted to name the adapter, so the CONFIG
// stays Fly-shaped in exactly one place and every consumer above sees a
// provider-neutral `{ image, region }`.

// ═══════════════════════════════════════════════════════════════════════════
// ONE ORCHESTRATOR PER FLEET ACCOUNT (Story MOTIR-8953 · MOTIR-8964)
// ═══════════════════════════════════════════════════════════════════════════
// The only place an account row becomes an adapter. The package stays
// account-blind — it takes a plain `{ token, app, region }` or `{ ec2, region,
// shardTag, amiId }` — and nothing below this seam names a vendor except the
// `fly` and `aws` cases (MOTIR-9276).
//
// Any other provider resolves through a REGISTRY keyed on provider: an adapter
// registers `{ orchestrator(shard), inventory(shard) }` and is handed the WHOLE
// account (fleet kind, provider, location, `credentialRef`).

/** What a provider adapter registers: how to reach one account's containers,
 *  and how to list its machines (null when another inventory already covers it). */
export interface ShardAdapter {
  orchestrator(shard: FleetShardDTO): ContainerOrchestrator;
  inventory(shard: FleetShardDTO): FleetInventory | null;
  /** How to reach one account's agent instances (MOTIR-9469). Absent for a
   *  provider that hosts no agent instances. */
  persistent?(shard: FleetShardDTO): PersistentContainerOrchestrator;
}

const shardAdapters = new Map<string, ShardAdapter>();

/** Register (or replace) the adapter for a provider's accounts. */
export function registerShardAdapter(provider: string, adapter: ShardAdapter): void {
  shardAdapters.set(provider, adapter);
}

/** Forget a registration — for tests. */
export function unregisterShardAdapter(provider: string): void {
  shardAdapters.delete(provider);
}

function registeredAdapter(provider: string): ShardAdapter {
  const adapter = shardAdapters.get(provider);
  if (!adapter) throw new OrchestratorNotConfiguredError(`no ${provider} adapter is registered`);
  return adapter;
}

/** Each account's own fake while the fake is selected, so a test can see WHICH
 *  account received a provision. */
const shardFakes = new Map<string, ContainerOrchestrator & FakeOrchestratorControls>();

/** The fake standing in for one account — created on first use. */
export function fakeOrchestratorForShard(
  shardId: string,
): ContainerOrchestrator & FakeOrchestratorControls {
  let fake = shardFakes.get(shardId);
  if (!fake) {
    fake = createFakeOrchestrator({ idPrefix: `fake-${shardId}` });
    shardFakes.set(shardId, fake);
  }
  return fake;
}

/** A persistent fake for one account: the shared persistent fake, seen through
 *  a view that records which of its operations THIS account was asked for
 *  (MOTIR-9472). One store holds every machine, so a handle is found whichever
 *  view it is passed to; `calls` tells a test where an instance was routed.
 *  With the fake's state file shared (the E2E lane), the calls and the holds are
 *  shared too, by `shardFakeJournal.ts` (MOTIR-9478). */
export type ShardPersistentFake = PersistentContainerOrchestrator & {
  readonly calls: string[];
  /** THIS account refuses `op` as full (`OrchestratorCapacityError`) until
   *  {@link releaseCapacity} — the waiting-for-room control (MOTIR-9474). */
  holdCapacity(op: FakeCapacityOperation): void;
  /** Lift this account's refusals (all of them, or one operation's). */
  releaseCapacity(op?: FakeCapacityOperation): void;
};

const persistentShardFakes = new Map<string, ShardPersistentFake>();

/** The persistent fake standing in for one account — created on first use. */
export function fakePersistentOrchestratorForShard(shardId: string): ShardPersistentFake {
  let fake = persistentShardFakes.get(shardId);
  if (!fake) {
    const calls: string[] = [];
    const held = new Set<FakeCapacityOperation>();
    const controls = {
      holdCapacity: (op: FakeCapacityOperation) => {
        held.add(op);
        holdShardShared(shardId, op);
      },
      releaseCapacity: (op?: FakeCapacityOperation) => {
        if (op) held.delete(op);
        else held.clear();
        releaseShardShared(shardId, op);
      },
    };
    fake = new Proxy(fakePersistentOrchestrator, {
      get(target, prop, receiver) {
        if (prop === 'calls') return calls;
        if (prop === 'holdCapacity' || prop === 'releaseCapacity') return controls[prop];
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        return (...args: unknown[]) => {
          calls.push(prop);
          const op = prop === 'provisionPersistent' ? 'provision' : prop;
          const shared = shardFakeJournalShared();
          if (shared && op !== 'provision') {
            appendShardFakeCall({ shardId, op: prop, ref: refOf(args) });
          }
          if (
            (op === 'provision' || op === 'start') &&
            (held.has(op) || (shared && shardHeldShared(shardId, op)))
          ) {
            if (shared && op === 'provision') {
              appendShardFakeCall({ shardId, op: prop, ref: null });
            }
            return Promise.reject(
              new OrchestratorCapacityError('fake', 422, 'quota_exceeded', null, 'held'),
            );
          }
          const answer = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (shared && op === 'provision') {
            // A provision names its machine only once it has made one.
            return Promise.resolve(answer).then(
              (handle) => {
                appendShardFakeCall({
                  shardId,
                  op: prop,
                  ref: (handle as PersistentContainerHandle).machineId,
                });
                return handle;
              },
              (err: unknown) => {
                appendShardFakeCall({ shardId, op: prop, ref: null });
                throw err;
              },
            );
          }
          return answer;
        };
      },
    }) as unknown as ShardPersistentFake;
    persistentShardFakes.set(shardId, fake);
  }
  return fake;
}

/** The machine (else the disk) a persistent call names: a handle's, or the
 *  `(app, id)` pair of a destroy. */
function refOf(args: readonly unknown[]): string | null {
  const [first, second] = args;
  if (first && typeof first === 'object' && 'machineId' in first) {
    return String((first as PersistentContainerHandle).machineId);
  }
  return typeof second === 'string' ? second : null;
}

/** Forget every account's fake — for tests. */
export function resetShardFakes(): void {
  shardFakes.clear();
  persistentShardFakes.clear();
}

function flyOrchestratorForShard(shard: FleetShardDTO): ContainerOrchestrator {
  const token = process.env[shard.credentialRef]?.trim();
  if (!token) throw new OrchestratorNotConfiguredError(`set ${shard.credentialRef}`);
  if (!shard.fly) {
    throw new OrchestratorNotConfiguredError(`fleet account ${shard.name} names no Fly location`);
  }
  return createFlyOrchestrator({ token, app: shard.fly.app, region: shard.fly.region });
}

/** The env var naming the runner AMI every AWS account boots (MOTIR-9272). */
export const AWS_RUNNER_AMI_ENV_VAR = 'MOTIR_AWS_RUNNER_AMI_ID';

/** The env var naming the Docker-host AMI an AWS index VM boots (MOTIR-9446) —
 *  the ECS-optimized Amazon Linux 2023 AMI. Optional: unset, the account still
 *  boots runners and refuses an index spec as not configured. */
export const AWS_INDEXER_AMI_ENV_VAR = 'MOTIR_AWS_INDEXER_AMI_ID';

/**
 * THE ACCEPTANCE LANE'S EC2 (MOTIR-9429): a factory `lib/test-fake-aws.ts`
 * installs when `MOTIR_FAKE_AWS_STATE_PATH` is set, so the lane's three processes
 * drive the REAL AWS adapter and inventory over one file-backed fake EC2. Given
 * the caller's own `Ec2ApiError`, because the hook and the route that reads this
 * are separate bundles with separate copies of the package, and the adapter tells
 * a refusal by `instanceof`.
 *
 * Held on `globalThis` for the same reason `lib/blob/s3.ts`'s transport is: a
 * module variable set at instrumentation is not the binding a route reads. Unset
 * in every real deployment, and with it unset every line below is unchanged.
 */
export type AwsEc2Override = (
  shard: FleetShardDTO,
  errors: { Ec2ApiError: typeof Ec2ApiError },
) => Ec2Api;

const AWS_EC2_OVERRIDE_KEY = Symbol.for('motir.orchestrator.e2eAwsEc2');
type AwsEc2OverrideHolder = { [AWS_EC2_OVERRIDE_KEY]?: AwsEc2Override };

/** The lane's EC2 factory, or null outside it. */
function awsEc2Override(): AwsEc2Override | null {
  return (globalThis as AwsEc2OverrideHolder)[AWS_EC2_OVERRIDE_KEY] ?? null;
}

/** Install (or with `null`, remove) the lane's EC2 factory — tests and the lane only. */
export function setAwsEc2OverrideForTests(factory: AwsEc2Override | null): void {
  if (factory) (globalThis as AwsEc2OverrideHolder)[AWS_EC2_OVERRIDE_KEY] = factory;
  else delete (globalThis as AwsEc2OverrideHolder)[AWS_EC2_OVERRIDE_KEY];
}

/** The AMI the lane's fake EC2 is handed: it boots nothing, so no image is read. */
const FAKE_AWS_AMI_ID = 'ami-00000000000000000';

/** Is this an `aws` account the lane's fake EC2 answers for? */
function onFakeAws(shard: FleetShardDTO): boolean {
  return shard.provider === 'aws' && awsEc2Override() !== null;
}

/**
 * An AWS account's EC2 client and region — the ONE place the orchestrator and
 * the inventory of an account build it, so a kill and its settle land in the
 * account the VM was listed in. Its credential is ALWAYS a session of the
 * account's `motir-fleet-runner` ROLE, assumed from the management credential
 * (MOTIR-9460, MOTIR-9847): no pool account holds a runner key, and no
 * `<credentialRef>_*` variable is read; the SDK asks the provider again before
 * the session lapses. `extra` names variables only
 * the caller needs (the AMI, for a launch); every missing one is named at once,
 * as `indexFleetConfig` does.
 */
function awsShardClient(
  shard: FleetShardDTO,
  extra: readonly string[] = [],
): { ec2: Ec2Api; region: string; values: Record<string, string> } {
  const override = awsEc2Override();
  if (override) {
    // The lane carries no AWS key and no AMI; the fake needs neither.
    if (!shard.aws) {
      throw new OrchestratorNotConfiguredError(`fleet account ${shard.name} names no AWS location`);
    }
    const values: Record<string, string> = {};
    for (const name of extra) values[name] = process.env[name]?.trim() || FAKE_AWS_AMI_ID;
    return { ec2: override(shard, { Ec2ApiError }), region: shard.aws.region, values };
  }
  const management = runnerRoleManagement();
  const values: Record<string, string> = {};
  const missing = management
    ? []
    : awsManagementRequiredEnv(process.env).filter((name) => !process.env[name]?.trim());
  for (const name of extra) {
    const value = process.env[name]?.trim();
    if (value) values[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new OrchestratorNotConfiguredError(
      `set ${missing.join(', ')}` +
        (management
          ? ''
          : ` (the management credential, ${Object.values(AWS_MANAGEMENT_ENV).join(', ')}, assumes ${AWS_RUNNER_IAM_ROLE})`),
    );
  }
  if (!shard.aws) {
    throw new OrchestratorNotConfiguredError(`fleet account ${shard.name} names no AWS location`);
  }
  const { accountId, region } = shard.aws;
  const ec2 = createEc2Api({
    region,
    credentialProvider: runnerRoleCredentialProvider(management!, accountId),
  });
  return { ec2, region, values };
}

/** The SDK credential provider for an account's runner ROLE (MOTIR-9460): each
 *  call assumes a fresh session through the management API; a session with no
 *  expiry is handed over without one. */
export function runnerRoleCredentialProvider(
  management: Pick<AwsManagementApi, 'assumeRunnerRole'>,
  accountId: string,
) {
  return async () => {
    const session = await management.assumeRunnerRole(accountId);
    return {
      accessKeyId: session.accessKeyId,
      secretAccessKey: session.secretAccessKey,
      sessionToken: session.sessionToken,
      ...(session.expiration ? { expiration: session.expiration } : {}),
    };
  };
}

/** The management API the runner role is assumed through, or null when the
 *  management credential is not set. */
function runnerRoleManagement(): AwsManagementApi | null {
  try {
    return createAwsManagementApi(awsManagementCredentials(process.env));
  } catch (err) {
    if (err instanceof OrchestratorNotConfiguredError) return null;
    throw err;
  }
}

/** An AWS account's orchestrator (MOTIR-9276): its EC2 client, the fleet's AMI
 *  and its region. The shard tag is the account's name — what its network is
 *  tagged with. */

function awsOrchestratorForShard(shard: FleetShardDTO): ContainerOrchestrator {
  const { ec2, region, values } = awsShardClient(shard, [AWS_RUNNER_AMI_ENV_VAR]);
  return createAwsOrchestrator({
    ec2,
    region,
    shardTag: shard.name,
    amiId: values[AWS_RUNNER_AMI_ENV_VAR]!,
    indexerAmiId: process.env[AWS_INDEXER_AMI_ENV_VAR]?.trim() || undefined,
  });
}

/** The env var naming the hoster AMI every AWS agent-instance account boots (MOTIR-9469). */
export const AWS_HOSTER_AMI_ENV_VAR = 'MOTIR_AWS_HOSTER_AMI_ID';

/**
 * The Motir hoster CA and client certificate (MOTIR-9470): the CA signs each AWS
 * agent instance's host-agent server certificate, and the client pair is what
 * the exec client and the relay present to it. PEM, with a literal `\n` read as
 * a line break so a one-line secret store can hold them.
 */
export const HOSTER_CA_CERT_ENV_VAR = 'MOTIR_HOSTER_CA_CERT';
export const HOSTER_CA_KEY_ENV_VAR = 'MOTIR_HOSTER_CA_KEY';
export const HOSTER_CLIENT_CERT_ENV_VAR = 'MOTIR_HOSTER_CLIENT_CERT';
export const HOSTER_CLIENT_KEY_ENV_VAR = 'MOTIR_HOSTER_CLIENT_KEY';

/** A PEM read from a one-line secret: a literal `\n` is a line break. */
function pem(value: string): string {
  return value.replace(/\\n/g, '\n');
}

/** The hoster account's whole persistent config: its key, the hoster AMI, and
 *  the hoster CA and client pair — every missing variable named at once. */
function awsHosterConfig(shard: FleetShardDTO) {
  const { ec2, region, values } = awsShardClient(shard, [
    AWS_HOSTER_AMI_ENV_VAR,
    HOSTER_CA_CERT_ENV_VAR,
    HOSTER_CA_KEY_ENV_VAR,
    HOSTER_CLIENT_CERT_ENV_VAR,
    HOSTER_CLIENT_KEY_ENV_VAR,
  ]);
  const env = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, pem(v)]));
  const clientTls = {
    caPem: env[HOSTER_CA_CERT_ENV_VAR]!,
    certPem: env[HOSTER_CLIENT_CERT_ENV_VAR]!,
    keyPem: env[HOSTER_CLIENT_KEY_ENV_VAR]!,
  };
  return {
    ec2,
    region,
    shardTag: shard.name,
    amiId: env[AWS_HOSTER_AMI_ENV_VAR]!,
    hostAgent: {
      client: createHostAgentClient(clientTls),
      ca: { certPem: clientTls.caPem, keyPem: env[HOSTER_CA_KEY_ENV_VAR]! },
      clientTls,
    },
  };
}

/**
 * Where the RELAY dials an agent instance's terminal on ONE account
 * (MOTIR-9470). For an `aws` account it reads, lazily and only here, the
 * account's key (a describe of the instance's address is all it does), the
 * hoster CA certificate and Motir's client pair — never the AMI id and never the
 * CA KEY, which the relay must not hold. A `fly` account answers as
 * {@link persistentTerminalEndpoint} does.
 */
export async function hosterTerminalEndpointFor(
  shard: FleetShardDTO,
  handle: PersistentContainerHandle,
): Promise<PersistentTerminalEndpoint> {
  if (selectedOrchestratorProvider() === 'fake' || shard.provider !== 'aws') {
    return persistentTerminalEndpoint(handle);
  }
  const { ec2, values } = awsShardClient(shard, [
    HOSTER_CA_CERT_ENV_VAR,
    HOSTER_CLIENT_CERT_ENV_VAR,
    HOSTER_CLIENT_KEY_ENV_VAR,
  ]);
  const env = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, pem(v)]));
  return awsTerminalEndpoint(
    ec2,
    {
      caPem: env[HOSTER_CA_CERT_ENV_VAR]!,
      certPem: env[HOSTER_CLIENT_CERT_ENV_VAR]!,
      keyPem: env[HOSTER_CLIENT_KEY_ENV_VAR]!,
    },
    handle,
  );
}

/**
 * The PERSISTENT orchestrator for ONE account — where its agent instances live
 * (Story MOTIR-9361 · MOTIR-9469). An `aws` account gets its own adapter over its
 * own key and the hoster AMI; a `fly` account is the process-wide Fly instance
 * lane, exactly what {@link getPersistentOrchestrator} returns. Reached through
 * `fleetShardOrchestratorService.persistentOrchestratorFor`, which reads the
 * account recorded on the instance (MOTIR-9472).
 */
export function persistentOrchestratorForShard(
  shard: FleetShardDTO,
): PersistentContainerOrchestrator {
  if (selectedOrchestratorProvider() === 'fake')
    return fakePersistentOrchestratorForShard(shard.id);
  switch (shard.provider) {
    case 'fly':
      return getPersistentOrchestrator();
    case 'aws':
      return createAwsPersistentOrchestrator(awsHosterConfig(shard));
    default: {
      const unrouted: never = shard.provider;
      const adapter = registeredAdapter(unrouted);
      if (!adapter.persistent) {
        throw new OrchestratorNotConfiguredError(`${unrouted} hosts no agent instances`);
      }
      return adapter.persistent(shard);
    }
  }
}

/**
 * The orchestrator for ONE account. Throws `OrchestratorNotConfiguredError` when
 * it cannot be reached — its credential unset, or no adapter registered for its
 * provider.
 *
 * The `switch` is exhaustive over the account's provider: a new member is a
 * compile error here until it is routed (to the registry — one `case` line).
 */
export function orchestratorForShard(shard: FleetShardDTO): ContainerOrchestrator {
  // Under the lane's fake EC2 an `aws` account runs the real adapter (MOTIR-9429).
  if (selectedOrchestratorProvider() === 'fake' && !onFakeAws(shard)) {
    return fakeOrchestratorForShard(shard.id);
  }
  switch (shard.provider) {
    case 'fly':
      return flyOrchestratorForShard(shard);
    case 'aws':
      return awsOrchestratorForShard(shard);
    default: {
      const unrouted: never = shard.provider;
      return registeredAdapter(unrouted).orchestrator(shard);
    }
  }
}

/**
 * The machine listing for ONE account, for the reconciler. Null for `fly`: the
 * Fly ORGANISATION inventory already walks every Fly app, and a second listing
 * would judge each machine twice.
 *
 * An AWS account of the INDEXER pool lists every instance it has (MOTIR-9450),
 * with that account's own key, so an index VM no record owns is reaped there. A
 * CI-runner AWS account has none: its runners are swept by the adapter's
 * tag-scoped reaper, and its key may only terminate shard-tagged instances. With
 * the fake orchestrator selected nothing reads EC2.
 */
export function inventoryForShard(shard: FleetShardDTO): FleetInventory | null {
  switch (shard.provider) {
    case 'fly':
      return null;
    // The account's whole region, untagged instances included (MOTIR-9426), on
    // the same EC2 client its orchestrator launches through. Under the fake
    // orchestrator there is no EC2 to list.
    case 'aws': {
      if (selectedOrchestratorProvider() === 'fake' && !onFakeAws(shard)) return null;
      const { ec2, region } = awsShardClient(shard);
      return createAwsFleetInventory({ ec2, region, accountName: shard.name });
    }
    default: {
      const unrouted: never = shard.provider;
      return registeredAdapter(unrouted).inventory(shard);
    }
  }
}

/** WHERE an account's containers live, as a key two routes to one place share —
 *  so the volume sweep runs once per place, not once per route. */
export function shardLocationKey(shard: FleetShardDTO): string {
  if (selectedOrchestratorProvider() === 'fake') return `fake:${shard.id}`;
  if (shard.provider === 'fly' && shard.fly) return `fly:${shard.fly.app}`;
  return `${shard.provider}:${shard.id}`;
}

/** The process-wide fleet's location key — see {@link shardLocationKey}. */
export function legacyFleetLocationKey(): string {
  if (selectedOrchestratorProvider() === 'fake') return 'fake:process';
  return `fly:${process.env['FLY_FLEET_APP']?.trim() ?? ''}`;
}

/** The CI runner image, whichever account boots it (`MOTIR_RUNNER_IMAGE`). The
 *  fake path has none set, and the placeholder keeps its spec well-formed. */
export function fleetRunnerImage(): string {
  return process.env['MOTIR_RUNNER_IMAGE']?.trim() || 'motir/ci-runner@sha256:unset';
}

/** The region a process-wide-fleet boot asks for (`FLY_FLEET_REGION`, `iad` by
 *  default — where the fleet has always run). */
export function fleetRunnerRegion(): string {
  return process.env['FLY_FLEET_REGION']?.trim() || 'iad';
}

/** What an index container needs from this deployment's configuration. Neutral:
 *  no Fly type, no token, no app name — a second adapter fills the same shape. */
export interface IndexFleetConfig {
  /** The digest-pinned indexer image. On Fly, the `registry.fly.io` reference. */
  readonly image: string;
  readonly region: string;
}

/**
 * Is this deployment wired to run INDEX containers? Never throws.
 *
 * True on the `fake` adapter — which is what the test suites select — for the
 * same reason `isOrchestratorConfigured()` is: the fake boots no real machine, so
 * there is no image to pull and nothing to configure. Requiring a real image
 * there would put a production-only variable in front of every test that drives
 * the port, and the usual response to that is a placeholder in the test env,
 * which is the same placeholder that would then work in production.
 */
export function isIndexFleetConfigured(): boolean {
  if (selectedOrchestratorProvider() === 'fake') return true;
  return isFlyFleetConfigured() && isFlyIndexerImageConfigured();
}

/**
 * The index workload's configuration, or the typed not-configured error naming
 * EVERY missing variable at once.
 *
 * ⚠️ ALL OF THEM, NOT THE FIRST. A misconfigured deployment discovers its gaps
 * one boot at a time otherwise, and every one of those boots is a billed machine
 * and a dead-lettered run. `flyFleetConfig()` already collects its three; this
 * adds the image to the same message.
 *
 * ⚠️ AND IT THROWS RATHER THAN NO-OPPING. `docs/decisions/code-graph-index-fleet.md`
 * §5's hard constraint is the ledger: one `job_run` per repo, `succeeded`, with
 * one `output.repoRef`. A path that quietly returned "nothing to do" when
 * unconfigured would still let the job record that row — telling the enqueue gate
 * (`listSucceededCodeGraphIndexRepoRefs`) and the onboarding wizard's per-repo
 * rows that a repo is indexed when nothing ever ran. Unconfigured must be
 * LOUD; {@link isIndexFleetConfigured} is what keeps a self-hosted deploy out of
 * this path, and it is not a licence to be silent once inside it.
 *
 * ⚠️ IT ALSO REQUIRES `MOTIR_RUNNER_IMAGE`, WHICH INDEXING DOES NOT USE — stated
 * rather than hidden. The index workload shares the fleet's Fly ORG, APP and
 * TOKEN with CI (§3: one shared `motir-fleet` org), and those three arrive
 * through `flyFleetConfig()`, which also demands the CI runner's image. Reading
 * the app and token here instead would put a SECOND copy of two env-var names in
 * the codebase, which `lib/ciFleet/config.ts` records the cost of: "two literals
 * that agree today are not one constant." No deployment is affected — the cloud
 * sets both, and a self-hosted one sets neither — so the coupling is accepted and
 * named. Splitting the accessor belongs with the second adapter, alongside the
 * `defaultSpecDefaults()` the port boundary's own guard already anticipates.
 */
export function indexFleetConfig(): IndexFleetConfig {
  if (selectedOrchestratorProvider() === 'fake') {
    // The fake adapter boots nothing, so this reference is never pulled. It is
    // still a well-formed DIGEST rather than a tag, so a test asserting "the spec
    // is digest-pinned" exercises the real shape.
    return { image: 'motir/indexer@sha256:fake', region: 'iad' };
  }
  const missing: string[] = [];
  let region = 'iad';
  try {
    region = flyFleetConfig().region;
  } catch (err) {
    // Merge the fleet's own list of missing variables with this one's, and say
    // `set …` once: read the refusal's `detail`, never its rendered message
    // (MOTIR-6571). `flyFleetConfig` throws nothing but this refusal.
    missing.push((err as OrchestratorNotConfiguredError).detail.replace(/^set /, ''));
  }
  const image = flyIndexerImage();
  if (!image) missing.push(INDEXER_IMAGE_ENV_VAR);
  // `|| !image` is what narrows the type; `missing.length` alone cannot, and a
  // cast here would be a cast that outlives the reason for it.
  if (missing.length > 0 || !image) {
    throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  }
  return { image, region };
}

/** The env var holding the hosted-agent image (`hosted-agent-run.md` §6). */
export const HOSTED_AGENT_IMAGE_ENV_VAR = 'MOTIR_HOSTED_AGENT_IMAGE';

/** What the fake orchestrator answers for the hosted-agent image. */
const FAKE_HOSTED_AGENT_IMAGE = 'motir/hosted-agent@sha256:fake';

/** The variable's value, trimmed, or `''` when it is unset. */
function rawHostedAgentImage(): string {
  return process.env[HOSTED_AGENT_IMAGE_ENV_VAR]?.trim() ?? '';
}

/**
 * The registry host of an image reference, lower-cased: the first path segment
 * when it looks like a host (a `.`, a `:` or `localhost`), Docker Hub otherwise —
 * the same rule `docker pull` applies.
 */
function imageRegistryHost(image: string): string {
  const first = image.split('/')[0] ?? '';
  const isHost = image.includes('/') && (/[.:]/.test(first) || first === 'localhost');
  return isHost ? first.toLowerCase() : 'docker.io';
}

/** An ECR registry host: `<account>.dkr.ecr[-fips].<region>.amazonaws.com[.cn]`. */
const ECR_HOST = /^\d{12}\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * THE HOSTED-AGENT IMAGE for a run on `provider`'s fleet (MOTIR-9420) — the
 * pinned reference `MOTIR_HOSTED_AGENT_IMAGE` names, read on its own, with no
 * Fly fleet variable required.
 *
 * ⚠️ ONE VARIABLE SERVES BOTH FLEETS (`hosted-agent-run.md` §6, amended
 * 2026-10-24). A second `MOTIR_AWS_HOSTED_AGENT_IMAGE` would agree with this one
 * today and drift at the next pin.
 *
 * ⚠️ A DIGEST, NEVER A TAG — on every provider: a tag lets a publish change what
 * a running deployment boots, and a hosted run's image holds the agent a
 * customer's code is handed to.
 *
 * ⚠️ ON AWS, ONLY A REGISTRY A STRANGER CAN PULL FROM. An agent-runner VM boots
 * with no instance profile and no Fly org credential, so it pulls anonymously.
 * A `registry.fly.io` mirror needs the Fly org credential and an ECR repository
 * needs an IAM role; both are refused here by HOST, never by substring. Any other
 * host is accepted: whether it really serves an anonymous pull is
 * {@link verifyHostedAgentImagePullable}'s question, asked of the live registry.
 */
export function hostedAgentImage(provider: OrchestratorProvider): string {
  // An `aws` boot on the lane's fake EC2 builds real user-data, which takes
  // only a digest-pinned image (MOTIR-9429).
  const fakeAws = provider === 'aws' && awsEc2Override() !== null;
  if (provider === 'fake' || (selectedOrchestratorProvider() === 'fake' && !fakeAws)) {
    return FAKE_HOSTED_AGENT_IMAGE;
  }
  const image = rawHostedAgentImage();
  if (!image) throw new OrchestratorNotConfiguredError(`set ${HOSTED_AGENT_IMAGE_ENV_VAR}`);
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new OrchestratorNotConfiguredError(
      `${HOSTED_AGENT_IMAGE_ENV_VAR} must be pinned by digest (…@sha256:<64 hex>), not a tag`,
    );
  }
  const host = imageRegistryHost(image);
  if (provider === 'aws' && (host === FLY_REGISTRY_HOST || ECR_HOST.test(host))) {
    throw new OrchestratorNotConfiguredError(
      `${HOSTED_AGENT_IMAGE_ENV_VAR} names an image on ${host}, which an agent-runner VM ` +
        `cannot pull: it pulls anonymously, with no instance profile and no Fly org ` +
        `credential, so the image must stay on a public registry (ghcr.io)`,
    );
  }
  return image;
}

/**
 * The hosted-agent workload's configuration on the FLY fleet (MOTIR-690): the
 * fleet's region and {@link hostedAgentImage}'s image — or the typed
 * not-configured error naming every missing variable at once, like
 * {@link indexFleetConfig}. The digest rule lives in `hostedAgentImage` alone.
 */
export function hostedAgentFleetConfig(): IndexFleetConfig {
  if (selectedOrchestratorProvider() === 'fake') {
    return { image: FAKE_HOSTED_AGENT_IMAGE, region: 'iad' };
  }
  const missing: string[] = [];
  let region = 'iad';
  try {
    region = flyFleetConfig().region;
  } catch (err) {
    // Merge the fleet's own list of missing variables with this one's, and say
    // `set …` once: read the refusal's `detail`, never its rendered message.
    // `flyFleetConfig` throws nothing but this refusal.
    missing.push((err as OrchestratorNotConfiguredError).detail.replace(/^set /, ''));
  }
  if (!rawHostedAgentImage()) missing.push(HOSTED_AGENT_IMAGE_ENV_VAR);
  if (missing.length > 0) {
    throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  }
  return { image: hostedAgentImage('fly'), region };
}

/**
 * What the boot preflight concluded about ONE of this deployment's pull paths.
 *
 * Four arms, and the split between the last two is the whole reason this is not
 * a boolean: `unpullable` is a DEFINITE registry refusal that no amount of
 * waiting fixes, while `indeterminate` means the probe could not reach the
 * registry at all. Only the first fails the health check loudly — see
 * `system.daily-health-check`.
 *
 * ⚠️ IT DESCRIBES ONE IMAGE, AND THAT IS DELIBERATE (MOTIR-2030). `reference` is
 * a single string, so the fleet's SECOND pull path gets its own verdict rather
 * than widening this one. See {@link verifyIndexFleetBootable} for why a
 * per-path verdict is the honest shape.
 */
export type FleetBootableVerdict =
  /** The registry served the manifest to the caller that will boot it —
   *  anonymously on a third-party registry, or with the fleet's own org
   *  credential on `registry.fly.io`. A Fly Machine can boot it. */
  | { verdict: 'bootable'; reference: string; digest: string | null }
  /** DEFINITE: the registry will not serve this image. The loud one. */
  | { verdict: 'unpullable'; reference: string; detail: string }
  /** Nothing to check — this deployment provisions no real containers. */
  | { verdict: 'not_applicable'; detail: string }
  /** Could not tell. A transport failure, or a registry whose challenge this
   *  probe cannot answer and for which no credential is configured. Never a
   *  claim about the image (MOTIR-3606). */
  | { verdict: 'indeterminate'; reference: string; detail: string };

/**
 * CAN THIS DEPLOYMENT'S FLEET ACTUALLY BOOT? — §6.1 + §7 of
 * `docs/decisions/fleet-image-pull.md`, and the sibling `isFlyFleetConfigured()`
 * deliberately is not.
 *
 * The assertion MOTIR-1980 needed and did not have. The fleet shipped
 * code-complete and unbootable while every predicate in the codebase answered
 * "configured", because none of them asked the only question that matters: does
 * the registry serve the image the deployment is pinned to? This asks it, once,
 * out of band.
 *
 * ⚠️ CONSUMED BY THE HEALTH / PREFLIGHT SURFACE, NEVER BY THE PER-JOB PATH — §7
 * fixes this and it is not a stylistic preference. Per-job it would be a
 * registry round-trip inside `ci-runner-fleet.md` §6's ≤30s p50 boot budget,
 * taken once per queued job, to re-answer a deployment-wide question whose
 * answer changes about as often as an env var. The per-job backstop is
 * `OrchestratorImageUnpullableError` (§6.2) — a different mechanism for a
 * different case: an image that WAS pullable at preflight and is not now.
 *
 * ⚠️ IT NAMES FLY, AND THAT IS WHY IT LIVES HERE. This module is the
 * COMPOSITION ROOT — the one file outside `adapters/fly/` that
 * `tests/ciFleet/orchestratorPortBoundary.test.ts` permits to name the adapter.
 * The probe itself (`./imagePull`) knows nothing about Fly; marrying it to the
 * configured image is exactly the composition this file exists for, and a second
 * adapter would add one branch here rather than a new leak somewhere else.
 *
 * NEVER THROWS: the caller is a health check, and every "no" is more useful as a
 * sentence than as a stack trace.
 */
export async function verifyFleetBootable(): Promise<FleetBootableVerdict> {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      verdict: 'not_applicable',
      detail: 'the fake orchestrator is selected; no image is pulled',
    };
  }
  let image: string;
  try {
    image = flyFleetConfig().image;
  } catch {
    // A self-hosted build, or a cloud deploy not yet wired. NOT a failure —
    // `isOrchestratorConfigured()` already keeps this deployment out of the
    // provisioning path, so there is nothing here to be loud about. The CONFIG
    // ACCESSOR is asked rather than `isFlyFleetConfigured()`, even though the two
    // check the same three variables: the accessor is the thing that would
    // actually be used to boot, so consulting it here leaves no way for the
    // preflight and the boot to disagree about what "configured" means.
    return {
      verdict: 'not_applicable',
      detail: 'this deployment has no container fleet configured',
    };
  }

  return probeToVerdict(image, flyRegistryCredential);
}

/**
 * Fly's OWN container registry — the host §5's mirror copies a closed image into.
 *
 * Named HERE, in the composition root, for the same reason the adapter choice is:
 * this is the one file outside `adapters/fly/` permitted to know Fly exists
 * (`tests/ciFleet/orchestratorPortBoundary.test.ts`), and marrying a registry
 * HOST to a credential is exactly the composition this module is for. The probe
 * itself still knows nothing but "some registries want a username and password".
 */
const FLY_REGISTRY_HOST = 'registry.fly.io';

/**
 * The credential to probe `registry.fly.io` with — and the correction MOTIR-3606
 * is about.
 *
 * ⚠️ THIS IS NOT A WIDENING OF WHAT `bootable` MEANS, AND THE DISTINCTION IS THE
 * WHOLE POINT. §0's reduction — "can Fly boot this image?" is "will the registry
 * serve a stranger?" — is exact for a THIRD-PARTY registry, because the Machines
 * API create payload has no field to hand Fly a credential with. It is simply
 * false for Fly's own registry, which a Machine authenticates to as the org, and
 * which is why §5 mirrors a closed image there in the first place. So the
 * credential the probe uses here is the SAME org credential the boot uses; asking
 * anonymously was not the stricter question, it was the wrong one.
 *
 * ⚠️ AND IT MUST BE THE FLEET'S TOKEN, NOT A FLY TOKEN. `flyFleetConfig()` is
 * the accessor that already refuses a fallback to a general Fly credential
 * (`flyMachines.ts`: "a distinct variable and there is no fallback"), so reading
 * the host's credential through it inherits that refusal rather than re-deciding
 * it. On a deployment with no fleet configured it throws, and the probe is then
 * told there is no credential — which is correct, and lands on
 * `unauthenticatable` rather than a false alarm.
 *
 * The username is ignored by `registry.fly.io` (any value works; the token is the
 * password), and `x` is the convention `flyctl auth docker` writes.
 */
const flyRegistryCredential: RegistryCredentialResolver = (registry) =>
  registry === FLY_REGISTRY_HOST ? { username: 'x', password: flyFleetConfig().token } : null;

/**
 * One pull path's probe, mapped onto the verdict's three non-trivial arms.
 *
 * Shared by both preflights (MOTIR-2030) so the two paths cannot drift in what
 * `unpullable` vs `indeterminate` MEANS — which is the one distinction the
 * health check branches on, and therefore the one a second copy would eventually
 * get subtly wrong. The `not_applicable` arm is NOT here: it is decided from
 * CONFIGURATION, before there is an image to probe, and each path decides it
 * differently.
 */
async function probeToVerdict(
  image: string,
  resolveCredential: RegistryCredentialResolver | undefined,
): Promise<FleetBootableVerdict> {
  const probe = await probeImagePull(image, resolveCredential);
  if (probe.pullable === true) {
    return { verdict: 'bootable', reference: probe.reference, digest: probe.digest };
  }
  if (probe.pullable === false) {
    return {
      verdict: 'unpullable',
      reference: probe.reference,
      detail: `${probe.registry}: ${probe.detail} (${probe.reason})`,
    };
  }
  return { verdict: 'indeterminate', reference: probe.reference, detail: probe.detail };
}

/**
 * CAN THIS DEPLOYMENT BOOT AN INDEX CONTAINER? — the INDEXER image's own
 * preflight (MOTIR-2030), and the twin of {@link verifyFleetBootable}.
 *
 * ⚠️ A SECOND PULL PATH NEEDS A SECOND PREFLIGHT, AND THE ADR SAYS SO IN THOSE
 * WORDS. `docs/decisions/fleet-image-pull.md` §5 lists three constraints on the
 * indexer's mirror and the third is this one verbatim: *"It is a second pull
 * path. The fleet then has two, and each needs §6's preflight independently."*
 * Before MOTIR-1989 there was one image and `verifyFleetBootable()` covered the
 * fleet; after it there are two, with two registries, two release lanes and two
 * failure modes — and the indexer's was probed by nothing.
 *
 * ⚠️ AND IT IS THE PATH MORE LIKELY TO GO MISSING. §5's second constraint:
 * `registry.fly.io` garbage-collects UNREFERENCED images ("we clean old ones up
 * after a few days"), and the reading that a live Machine's image is immune is
 * precisely the wrong shape for a fleet whose machines are ephemeral by design —
 * between jobs, nothing references it. Fly publishes no retention SLA, so this
 * cannot be reasoned away; §6 names the preflight as "what turns a GC'd image
 * into a loud failure instead of an outage."
 *
 * ⚠️ WHY A SEPARATE FUNCTION RATHER THAN A WIDER VERDICT.
 * {@link FleetBootableVerdict} is single-image by construction, and the two paths
 * genuinely fail independently: the CI runner can be perfectly pullable on a
 * deployment whose indexer image was collected last night. One verdict covering
 * both would have to pick which reference to name, and the operator surface is a
 * MESSAGE — naming the wrong image is worse than naming none.
 *
 * NEVER THROWS, for the reason its twin does not: the caller is a health check.
 */
export async function verifyIndexFleetBootable(): Promise<FleetBootableVerdict> {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      verdict: 'not_applicable',
      detail: 'the fake orchestrator is selected; no image is pulled',
    };
  }
  let image: string;
  try {
    // ⚠️ THE ACCESSOR, NOT THE PREDICATE — the same choice, for the same reason,
    // its twin makes over `isFlyFleetConfigured()`: `indexFleetConfig()` is what
    // would actually be used to boot an index container, so consulting it here
    // leaves no way for the preflight and the boot to disagree about what
    // "configured" means. It also folds BOTH not-applicable shapes into one
    // branch — no fleet at all, and a fleet with no indexer image.
    image = indexFleetConfig().image;
  } catch {
    // ⚠️ `not_applicable`, NEVER `unpullable`. A deployment that runs CI but has
    // not wired `MOTIR_INDEXER_IMAGE` is a deployment that does not INDEX — not a
    // broken one — and reporting it as a registry refusal would fail a daily
    // health check over a feature nobody enabled. That is the false alarm that
    // teaches an operator to ignore the row, which is how the next MOTIR-1980
    // gets missed. `isIndexFleetConfigured()` is what keeps such a deployment out
    // of the index path; this is the preflight agreeing with it.
    return {
      verdict: 'not_applicable',
      detail: 'this deployment is not configured to run index containers',
    };
  }

  return probeToVerdict(image, flyRegistryCredential);
}

/**
 * CAN AN AGENT-RUNNER VM PULL THE HOSTED-AGENT IMAGE? — the third pull path's
 * preflight (MOTIR-9420), the twin of {@link verifyIndexFleetBootable}.
 *
 * ⚠️ IT PASSES NO CREDENTIAL, ON PURPOSE. It asks the question an agent-runner
 * VM will ask: that VM has no instance profile and no Fly org credential, so its
 * `docker pull` is anonymous, and so is this probe — on a Bearer registry such as
 * GHCR it fetches an anonymous token and nothing else. `flyRegistryCredential`
 * is deliberately not used: a mirror only the Fly org can read would answer
 * `bootable` here and strand every AWS run. The same anonymous answer is right
 * for the Fly path, which pulls this public image anonymously too.
 *
 * `not_applicable` under the fake orchestrator or with the variable unset (a
 * deployment that runs no hosted agent). A variable set to a reference no VM can
 * pull — a tag, or a `registry.fly.io` / ECR host — is `unpullable`, with
 * {@link hostedAgentImage}'s refusal as the detail: that is a definite answer.
 *
 * NEVER THROWS, for the reason its twins do not: the caller is a health check.
 */
export async function verifyHostedAgentImagePullable(): Promise<FleetBootableVerdict> {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      verdict: 'not_applicable',
      detail: 'the fake orchestrator is selected; no image is pulled',
    };
  }
  const reference = rawHostedAgentImage();
  if (!reference) {
    return {
      verdict: 'not_applicable',
      detail: `this deployment runs no hosted agent (${HOSTED_AGENT_IMAGE_ENV_VAR} is unset)`,
    };
  }
  let image: string;
  try {
    image = hostedAgentImage('aws');
  } catch (err) {
    return {
      verdict: 'unpullable',
      reference,
      detail: (err as OrchestratorNotConfiguredError).detail,
    };
  }
  return probeToVerdict(image, undefined);
}

// ── The BOUND half: the package's usage sink, closed over the app's meter ────
//
// `createUsageSink` takes a `UsageMeter`; `ciFleetCostMeterService` implements
// it. Binding it HERE rather than importing the service inside the package is
// the third of MOTIR-4299's three inversions, and it is the one that changes a
// caller's world least: `recordContainerUsage` / `recordContainerAccrual` are
// still free functions on `@/lib/orchestrator`, with the same signatures and the
// same never-throw contract, at the same two call sites.
// The settle's platform meter report (Story MOTIR-727 · MOTIR-5286) rides on the
// same binding: a committed settle enqueues its report here, outside the meter.
const usageSink = createUsageSink(withPlatformMeterReport(ciFleetCostMeterService));

/** Emit one container's cost record. NEVER THROWS — see the package's sink. */
export const recordContainerUsage = usageSink.recordContainerUsage;
/** Emit a CHECKPOINT on a container still running. NEVER THROWS. */
export const recordContainerAccrual = usageSink.recordContainerAccrual;

// ── The preview meter, bound to the ports' destroys (MOTIR-5777) ────────────
//
// The lifecycle destroys a preview's app and branch through the ports and never
// calls billing code; binding the meter HERE is how a destroy's usage reaches
// the CI pool. `./hosting` and `./database` load no database, so they only hold
// the observer; this module, which does, binds it. The preview lifecycle imports
// its ports from `@/lib/orchestrator` for exactly that reason.
observeHostingDestroyApp((input) => ciPreviewUsageMeterService.recordDestroyedApp(input));
observeDatabaseBranchDelete((input) => ciPreviewUsageMeterService.recordDeletedBranch(input));

// ── The PURE half: re-exported verbatim from the package ─────────────────────
//
// So that `@/lib/orchestrator` remains one import for a consumer, and so that
// moving a symbol across the boundary later is not a change at every call site.
export * from '@motir/orchestrator';
export * from './hosting';
export * from './database';
