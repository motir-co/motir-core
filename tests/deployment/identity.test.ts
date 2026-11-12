import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deploymentIdentity,
  hostInstanceId,
  hostProcessGroup,
  hostRegion,
} from '@/lib/deployment/identity';

// THE HOST TAGS READ FARGATE (MOTIR-10962). `hostInstanceId`, `hostRegion` and
// `hostProcessGroup` feed the terminal relay's connection rows and Sentry's
// `instance.*` tags. They answer only on a Fargate task, and `undefined`
// everywhere else, so the relay's hostname + pid fallback still applies.

const TASK_ID = '3b3b1c2a9d3d4f8fa8b0c1d2e3f4a5b6';

/** What ECS injects into a core task's container, plus the one variable infra sets. */
const FARGATE = {
  AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE',
  AWS_REGION: 'us-east-1',
  ECS_CONTAINER_METADATA_URI_V4: `http://169.254.170.2/v4/${TASK_ID}-2531612879`,
  MONITORING_CLOUDWATCH_SERVICE: 'web',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('on a Fargate task', () => {
  it('hostInstanceId() answers the task id from the container metadata URI', () => {
    expect(hostInstanceId(FARGATE)).toBe(TASK_ID);
  });

  it('hostRegion() answers AWS_REGION', () => {
    expect(hostRegion(FARGATE)).toBe('us-east-1');
  });

  it.each(['web', 'worker', 'relay'])('hostProcessGroup() answers the process name %j', (name) => {
    expect(hostProcessGroup({ ...FARGATE, MONITORING_CLOUDWATCH_SERVICE: name })).toBe(name);
  });

  it('reads process.env when no env is passed', () => {
    for (const [name, value] of Object.entries(FARGATE)) vi.stubEnv(name, value);
    expect([hostInstanceId(), hostRegion(), hostProcessGroup()]).toEqual([
      TASK_ID,
      'us-east-1',
      'web',
    ]);
  });

  it('accepts a trailing slash and surrounding whitespace on the metadata URI', () => {
    const uri = `  ${FARGATE.ECS_CONTAINER_METADATA_URI_V4}/  `;
    expect(hostInstanceId({ ...FARGATE, ECS_CONTAINER_METADATA_URI_V4: uri })).toBe(TASK_ID);
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['a v3 URI', `http://169.254.170.2/v3/${TASK_ID}-2531612879`],
    ['a non-task id', 'http://169.254.170.2/v4/not-a-task-id'],
    ['an upper-case id', `http://169.254.170.2/v4/${TASK_ID.toUpperCase()}-2531612879`],
    ['an id with no suffix', `http://169.254.170.2/v4/${TASK_ID}`],
  ])('hostInstanceId() answers undefined when the metadata URI is %s', (_label, uri) => {
    expect(hostInstanceId({ ...FARGATE, ECS_CONTAINER_METADATA_URI_V4: uri })).toBeUndefined();
  });

  it('omits a region or process that is unset or blank rather than answering ""', () => {
    const bare = { ...FARGATE, AWS_REGION: '  ', MONITORING_CLOUDWATCH_SERVICE: undefined };
    expect(hostRegion(bare)).toBeUndefined();
    expect(hostProcessGroup(bare)).toBeUndefined();
  });
});

describe('off Fargate', () => {
  it.each([
    ['with no execution env (local, tests, a self-host)', undefined],
    ['on another AWS launch type', 'AWS_ECS_EC2'],
    ['on Lambda', 'AWS_Lambda_nodejs20.x'],
  ])('each accessor answers undefined %s, even with the other variables set', (_label, exec) => {
    const env = { ...FARGATE, AWS_EXECUTION_ENV: exec };
    expect(hostInstanceId(env)).toBeUndefined();
    expect(hostRegion(env)).toBeUndefined();
    expect(hostProcessGroup(env)).toBeUndefined();
  });

  it('reads no Fly variable: a former Fly machine answers undefined', () => {
    const fly = { FLY_MACHINE_ID: '148e21ea7e5389', FLY_REGION: 'iad', FLY_PROCESS_GROUP: 'app' };
    expect(hostInstanceId(fly)).toBeUndefined();
    expect(hostRegion(fly)).toBeUndefined();
    expect(hostProcessGroup(fly)).toBeUndefined();
  });
});

describe('deploymentIdentity (unchanged by MOTIR-10962)', () => {
  it('still reports no per-task instance id on Fargate', () => {
    for (const [name, value] of Object.entries(FARGATE)) vi.stubEnv(name, value);
    vi.stubEnv('MOTIR_ECS_CLUSTER', 'motir-core');
    expect(deploymentIdentity()).toMatchObject({
      provider: 'fargate',
      app: 'motir-core',
      region: 'us-east-1',
      instanceId: null,
    });
  });
});
