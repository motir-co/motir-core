import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  fakePersistentOrchestrator as fake,
  type PersistentContainerSpec,
} from '../../src/index';
import type { PersistentContractHarness, PersistentExecBehaviour } from './persistentContract';

// The fake persistent adapter behind the shared persistent contract (MOTIR-9467).
// Every control maps onto the fake's own control surface. One control was added
// for it: `createOutside`, a machine made by hand with no instance metadata —
// the fake had no way to hold one, and the reconcile's untracked machine is a
// case the port must be able to answer.

const SPEC: PersistentContainerSpec = {
  orgId: 'org-contract',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'inst-contract-a',
  image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'c'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: {},
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
  terminal: null,
};

const START = Date.parse('2026-10-24T10:00:00.000Z');

export function fakePersistentHarness(): PersistentContractHarness {
  let clock = START;

  function respond(behaviour: PersistentExecBehaviour) {
    if (behaviour.hangs) throw new OrchestratorApiError('fake', 408, 'the command timed out');
    if (behaviour.unreachable) throw new OrchestratorApiError('fake', 502, 'no route to machine');
    return {
      exitCode: behaviour.exitCode ?? 0,
      stdout: behaviour.stdout ?? '',
      stderr: behaviour.stderr ?? '',
    };
  }

  return {
    orchestrator: fake,
    reset() {
      fake.reset();
      clock = START;
      fake.setNow(() => new Date(clock));
    },
    spec: (overrides = {}) => ({ ...SPEC, ...overrides }),
    advance(ms) {
      clock += ms;
    },
    failNextMachineCreate: () => fake.failNextMachineCreate(),
    setExecBehaviour(behaviour) {
      fake.setExecResponder(() => respond(behaviour));
    },
    execs: () => fake.execs.map((e) => ({ ...e })),
    destroyOutOfBand(handle, options = {}) {
      if (options.machine !== false) fake.destroyOutside(handle.machineId);
    },
    addUntrackedMachine: (app) => fake.createOutside(app),
    // The suite provisions in ONE organisation, so the fake's whole fleet is that
    // one app — or empty, for an app it never created.
    liveMachineIds: (app) => (fake.appNames().includes(app) ? fake.liveMachineIds() : []),
    liveVolumeIds: (app) => (fake.appNames().includes(app) ? fake.liveVolumeIds() : []),
    operationLog: () =>
      fake.operations.flatMap((op) => {
        const [kind, verb, id] = op.split(':');
        return verb === 'destroy' && (kind === 'machine' || kind === 'volume')
          ? [`${kind}:${id}`]
          : [];
      }),
  };
}
