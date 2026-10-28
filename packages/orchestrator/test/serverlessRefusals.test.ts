import { describe, expect, it, vi } from 'vitest';
import {
  OrchestratorApiError,
  ReleaseArtifactUnsupportedError,
  ReleaseRuntimeRefusedError,
  createServerlessHostingDeployPort,
  parseStartCommand,
  type DeployReleaseInput,
  type ReleaseRuntime,
} from '../src/index';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim } from './contract/hostingLambdaSim';

// MOTIR-9974 — what the serverless target refuses by name before anything
// deploys (pointing to Fly), the start shapes it runs, and `always_on` as
// provisioned concurrency on the `live` alias.

const START = Date.parse('2026-10-28T00:00:00.000Z');
const REGISTRY = `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com`;
const HTTP_ONLY = { websockets: false, backgroundWork: false };

function setup() {
  const sim = createLambdaSim(() => START);
  const sleep = vi.fn(async () => {});
  const port = createServerlessHostingDeployPort(
    {
      roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`,
      accountId: SIM_ACCOUNT,
      region: SIM_REGION,
      appPrefix: 'mh-',
    },
    { clientFactory: sim.clientFactory, now: () => new Date(START), sleep },
  );
  return { sim, port, sleep };
}

function release(
  runtime: Partial<ReleaseRuntime> & { requires?: ReleaseRuntime['requires'] | undefined } = {},
  overrides: Partial<DeployReleaseInput> = {},
): DeployReleaseInput {
  const base: ReleaseRuntime = {
    port: 3000,
    healthCheck: { path: '/health' },
    startCommand: 'node server.js',
    database: { kind: 'none' },
    requires: HTTP_ONLY,
  };
  const merged = { ...base, ...runtime };
  if ('requires' in runtime && runtime.requires === undefined) delete merged.requires;
  return {
    appRef: 'mh-r1',
    environment: { kind: 'production' },
    artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production`, digest: 'sha256:one' },
    runtime: merged,
    env: [],
    idle: { mode: 'suspend', idleSeconds: 300 },
    ...overrides,
  };
}

async function refusal(input: DeployReleaseInput) {
  const { port, sim } = setup();
  const error = await port.deploy(input).catch((e: unknown) => e);
  expect(sim.callCount()).toBe(0);
  return error as ReleaseRuntimeRefusedError;
}

describe('parseStartCommand', () => {
  it.each([
    ['node server.js --port 3000', ['node', 'server.js', '--port', '3000']],
    ['./bin/start "two words"', ['./bin/start', 'two words']],
    ["serve 'it''s'", ['serve', 'its']],
    ['run "a \\"quoted\\" word" x\\ y', ['run', 'a "quoted" word', 'x y']],
    ['  spaced   out  ', ['spaced', 'out']],
    ['app "$HOME" \'$(literal)\'', ['app', '$HOME', '$(literal)']],
  ])('runs %j as %j', (text, argv) => {
    expect(parseStartCommand(text)).toEqual({ argv });
  });

  it.each([
    ['', 'is empty'],
    ['   ', 'is empty'],
    ['""', 'names no program'],
    ['npm start && node x', 'contains "&&"'],
    ['a || b', 'contains "||"'],
    ['a; b', 'contains ";"'],
    ['a | b', 'contains "|"'],
    ['node server.js &', 'contains "&"'],
    ['node server.js > out.log', 'contains ">"'],
    ['node < in', 'contains "<"'],
    ['echo $(id)', 'contains "$("'],
    ['echo "$(id)"', 'contains "$("'],
    ['echo `id`', 'contains "`"'],
    ['echo "`id`"', 'contains "`"'],
    ['node "unclosed', 'unbalanced double quote'],
    ["node 'unclosed", 'unbalanced single quote'],
    ['PORT=3000 node server.js', 'environment assignment (PORT=…)'],
    ['nohup node server.js', 'starts with "nohup"'],
    ['setsid node server.js', 'starts with "setsid"'],
  ])('refuses %j: %s', (text, reason) => {
    const parsed = parseStartCommand(text);
    expect(parsed).toHaveProperty('refused');
    expect((parsed as { refused: string }).refused).toContain(reason);
  });

  it('never echoes an assignment’s value', () => {
    expect(JSON.stringify(parseStartCommand('TOKEN=s3cr3t node x'))).not.toContain('s3cr3t');
  });
});

describe('the serverless refusals', () => {
  it('refuses background work by the manifest field, naming Fly, before any provider call', async () => {
    const error = await refusal(release({ requires: { websockets: false, backgroundWork: true } }));
    expect(error).toBeInstanceOf(ReleaseRuntimeRefusedError);
    expect(error).toMatchObject({ target: 'serverless', field: 'requires.backgroundWork' });
    expect(error.message).toMatch(/fly target/);
  });

  it('refuses websockets the same way, and names background work first when both are set', async () => {
    const websockets = await refusal(
      release({ requires: { websockets: true, backgroundWork: false } }),
    );
    expect(websockets).toMatchObject({ field: 'requires.websockets' });
    expect(websockets.message).toMatch(/fly target/);
    const both = await refusal(release({ requires: { websockets: true, backgroundWork: true } }));
    expect(both).toMatchObject({ field: 'requires.backgroundWork' });
    const { port } = setup();
    await expect(port.deploy(release({ requires: HTTP_ONLY }))).resolves.toMatchObject({
      releaseId: '1',
    });
  });

  it('refuses a release that does not say what it requires', async () => {
    expect(await refusal(release({ requires: undefined }))).toMatchObject({ field: 'requires' });
  });

  it('refuses an unsupported start shape by name, after the requires checks', async () => {
    const error = await refusal(release({ startCommand: 'npm run build && npm start' }));
    expect(error).toMatchObject({ field: 'startCommand' });
    expect(error.message).toContain(
      'contains "&&": a start command must be one foreground command',
    );
    expect(error.message).toMatch(/fly target/);
    const first = await refusal(
      release({ startCommand: 'a && b', requires: { websockets: true, backgroundWork: false } }),
    );
    expect(first).toMatchObject({ field: 'requires.websockets' });
  });

  it('checks the artifact before anything else', async () => {
    const bundle = await refusal(
      release(
        { startCommand: '', requires: { websockets: true, backgroundWork: true } },
        { artifact: { kind: 'bundle', ref: 's3://x' } },
      ),
    );
    expect(bundle).toBeInstanceOf(ReleaseArtifactUnsupportedError);
    const foreign = await refusal(
      release({ requires: undefined }, { artifact: { kind: 'image', ref: 'docker.io/x/y' } }),
    );
    expect(foreign).toBeInstanceOf(ReleaseArtifactUnsupportedError);
  });

  it('runs an accepted start command as the image command’s argv', async () => {
    const { port, sim } = setup();
    await port.deploy(release({ startCommand: './bin/start "two words"' }));
    expect(sim.liveSnapshot('mh-r1')!.command).toEqual(['./bin/start', 'two words']);
  });
});

describe('the serverless idle policy', () => {
  it('always-on deploys with provisioned concurrency 1 on live, ready before deploy returns', async () => {
    const { port, sim, sleep } = setup();
    const handle = await port.deploy(release({}, { idle: { mode: 'always_on' } }));
    expect(sim.functions.get('mh-r1')!.provisioned.get('live')).toEqual({
      instances: 1,
      status: 'READY',
    });
    const order = sim.calls.map((c) => c.command);
    expect(order.indexOf('PutProvisionedConcurrencyConfigCommand')).toBeGreaterThan(
      order.indexOf('CreateAliasCommand'),
    );
    expect(order.at(-1)).toBe('GetProvisionedConcurrencyConfigCommand');
    expect(sleep).toHaveBeenCalled();
    expect(await port.describe(handle)).toMatchObject({ state: 'healthy', releaseId: '1' });
  });

  it('a failed warm-up throws and leaves the new release live', async () => {
    const { port, sim } = setup();
    await port.deploy(release());
    sim.failProvisioning = true;
    await expect(
      port.deploy(release({ startCommand: 'node v2.js' }, { idle: { mode: 'always_on' } })),
    ).rejects.toThrow(/provisioned concurrency failed/);
    expect(sim.functions.get('mh-r1')!.aliases.get('live')).toBe('2');
  });

  it('a warm-up that never becomes ready is a typed error after a bounded wait', async () => {
    const { port, sim, sleep } = setup();
    const factory = sim.clientFactory;
    const stuck = createServerlessHostingDeployPort(
      {
        roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/r`,
        accountId: SIM_ACCOUNT,
        region: SIM_REGION,
        appPrefix: 'mh-',
      },
      {
        clientFactory: (service, options) => {
          const client = factory(service, options);
          return {
            async send(command) {
              const out = await client.send(command);
              return (command as object).constructor.name ===
                'GetProvisionedConcurrencyConfigCommand'
                ? { Status: 'IN_PROGRESS' }
                : out;
            },
          };
        },
        sleep,
      },
    );
    await expect(stuck.deploy(release({}, { idle: { mode: 'always_on' } }))).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    await expect(
      port.describe({
        target: 'serverless',
        appRef: 'mh-r1',
        environment: { kind: 'production' },
        releaseId: '1',
        providerRef: 'mh-r1',
      }),
    ).resolves.toMatchObject({ releaseId: '1' });
  });

  it('suspend after always-on removes the warm setting; suspend on a cold environment deletes nothing', async () => {
    const { port, sim } = setup();
    await port.deploy(release());
    expect(sim.calls.some((c) => c.command === 'DeleteProvisionedConcurrencyConfigCommand')).toBe(
      false,
    );
    await port.deploy(release({}, { idle: { mode: 'always_on' } }));
    await port.deploy(release({}, { idle: { mode: 'always_on' } }));
    expect(sim.functions.get('mh-r1')!.provisioned.size).toBe(1);
    await port.deploy(release({ startCommand: 'node v2.js' }));
    expect(sim.functions.get('mh-r1')!.provisioned.size).toBe(0);
    expect(
      sim.calls.filter((c) => c.command === 'DeleteProvisionedConcurrencyConfigCommand'),
    ).toHaveLength(1);
  });

  it('a rollback keeps the warm instance on live and makes no provisioned-concurrency call', async () => {
    const { port, sim } = setup();
    await port.deploy(release({}, { idle: { mode: 'always_on' } }));
    await port.deploy(release({ startCommand: 'node v2.js' }, { idle: { mode: 'always_on' } }));
    const before = sim.callCount();
    await port.rollback({ appRef: 'mh-r1', environment: { kind: 'production' } });
    const f = sim.functions.get('mh-r1')!;
    expect(f.aliases.get('live')).toBe('1');
    expect(f.provisioned.get('live')).toMatchObject({ instances: 1 });
    expect(sim.calls.slice(before).some((c) => c.command.includes('ProvisionedConcurrency'))).toBe(
      false,
    );
  });
});
