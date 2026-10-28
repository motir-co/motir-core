import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awsErrorCode,
  createServerlessAwsApi,
  defaultServerlessClientFactory,
  serverlessCredentialProvider,
} from '../src/adapters/serverless/client';
import { environmentOfLabel, unitOf } from '../src/adapters/serverless/names';
import { computeSecondsOf, metricPeriodSeconds } from '../src/adapters/serverless/usage';
import {
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  createServerlessHostingDeployPort,
  serverlessHostingConfig,
  signFunctionUrlRequest,
  type ServerlessSdkClientFactory,
} from '../src/index';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim } from './contract/hostingLambdaSim';

// MOTIR-9972 — the serverless adapter's edges below the port: its two variables,
// the SDK client module (the assumed role, error codes, sparse answers), the
// SigV4 helper's defaults, and the names and usage arithmetic.

const ROLE = `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`;
const CONFIG = { roleArn: ROLE, region: SIM_REGION };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A factory whose every client answers `answer(commandName)`. */
function stubFactory(answer: (command: string) => unknown): ServerlessSdkClientFactory {
  return () => ({
    async send(command) {
      const name = (command as object).constructor.name;
      if (name === 'AssumeRoleCommand') {
        return {
          Credentials: { AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't' },
        };
      }
      return answer(name);
    },
  });
}

describe('serverlessHostingConfig', () => {
  it('names the role variable when it is unset or not a role ARN', () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', '');
    expect(() => serverlessHostingConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => serverlessHostingConfig()).toThrow(/set MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN/);
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', 'arn:aws:iam::123:user/zhuyue');
    expect(() => serverlessHostingConfig()).toThrow(/is not an IAM role ARN/);
  });

  it('takes the account from the role ARN and defaults the region to us-east-1', () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', ROLE);
    vi.stubEnv('MOTIR_HOSTING_AWS_REGION', '');
    expect(serverlessHostingConfig()).toEqual({
      roleArn: ROLE,
      accountId: SIM_ACCOUNT,
      region: 'us-east-1',
      appPrefix: 'mh-',
    });
    vi.stubEnv('MOTIR_HOSTING_AWS_REGION', 'eu-west-1');
    expect(serverlessHostingConfig().region).toBe('eu-west-1');
  });
});

describe('the serverless client module', () => {
  it('builds a real SDK client for every service it speaks to', () => {
    for (const service of ['sts', 'lambda', 'ecr', 'secrets', 'logs', 'cloudwatch'] as const) {
      expect(typeof defaultServerlessClientFactory(service, { region: SIM_REGION }).send).toBe(
        'function',
      );
    }
  });

  it('reads an AWS error code, never a message', () => {
    expect(awsErrorCode({ Code: 'Throttling', name: 'X', message: 'secret' })).toBe('Throttling');
    expect(awsErrorCode({ name: 'AccessDenied' })).toBe('AccessDenied');
    expect(awsErrorCode('boom')).toBe('UnknownError');
    expect(awsErrorCode(null)).toBe('UnknownError');
  });

  it('assumes the scoped role through the source key and its management role, and caches it', async () => {
    let clock = Date.parse('2026-10-28T00:00:00Z');
    const sim = createLambdaSim(() => clock);
    const provider = serverlessCredentialProvider(CONFIG, {
      clientFactory: sim.clientFactory,
      now: () => new Date(clock),
      sourceCredentials: {
        accessKeyId: 'AKIAMANAGEMENT',
        secretAccessKey: 'management-secret',
        roleArn: 'arn:aws:iam::576360162297:role/motir-add-shard',
      },
    });
    const first = await provider();
    expect(sim.sessions).toEqual([
      {
        roleArn: 'arn:aws:iam::576360162297:role/motir-add-shard',
        asKey: 'AKIAMANAGEMENT',
        accessKeyId: 'ASIASIM1',
      },
      { roleArn: ROLE, asKey: 'ASIASIM1', accessKeyId: 'ASIASIM2' },
    ]);
    expect(first.accessKeyId).toBe('ASIASIM2');
    expect(await provider()).toBe(first);
    clock += 3_590_000;
    expect((await provider()).accessKeyId).toBe('ASIASIM4');
  });

  it('assumes the role with the bare key, or the default chain, and keeps a session with no expiry', async () => {
    const sim = createLambdaSim(() => 0);
    await serverlessCredentialProvider(CONFIG, {
      clientFactory: sim.clientFactory,
      sourceCredentials: { accessKeyId: 'AKIAOPERATOR', secretAccessKey: 's' },
    })();
    expect(sim.sessions).toEqual([
      { roleArn: ROLE, asKey: 'AKIAOPERATOR', accessKeyId: 'ASIASIM1' },
    ]);

    const factory = vi.fn(stubFactory(() => ({})));
    const provider = serverlessCredentialProvider(CONFIG, { clientFactory: factory });
    const session = await provider();
    expect(session).toEqual({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' });
    expect(factory).toHaveBeenCalledWith('sts', { region: SIM_REGION });
    expect(await provider()).toBe(session);
  });

  it('refuses an AssumeRole answer without credentials, and maps an STS refusal to its code', async () => {
    const empty: ServerlessSdkClientFactory = () => ({ send: async () => ({}) });
    await expect(serverlessCredentialProvider(CONFIG, { clientFactory: empty })()).rejects.toThrow(
      /AssumeRole returned no credentials/,
    );
    const denied: ServerlessSdkClientFactory = () => ({
      send: async () => {
        throw Object.assign(new Error('User arn:… with key AKIA… is not authorized'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
      },
    });
    const error = await serverlessCredentialProvider(CONFIG, { clientFactory: denied })().catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect((error as Error).message).toBe(
      'The aws orchestrator refused a call (HTTP 403: sts: AccessDenied).',
    );
  });

  it('turns sparse answers into absent values or typed errors', async () => {
    const api = createServerlessAwsApi(CONFIG, { clientFactory: stubFactory(() => ({})) });
    expect(await api.getFunction('f')).toBeNull();
    expect(await api.getAliasVersion('f', 'live')).toBeNull();
    expect(await api.getFunctionUrl('f', 'live')).toBeNull();
    expect(await api.listFunctionNames()).toEqual([]);
    expect(await api.metricSums('f', new Date(0), new Date(60_000), 60)).toEqual({
      durationMs: 0,
      invocations: 0,
    });
    await expect(api.publishVersion('f')).rejects.toThrow(/returned no version/);
    await expect(api.ensureFunctionUrl('f', 'live')).rejects.toThrow(/returned no URL/);

    const partial = createServerlessAwsApi(CONFIG, {
      clientFactory: stubFactory((command) =>
        command === 'GetFunctionCommand'
          ? { Configuration: { FunctionArn: 'arn:f' } }
          : command === 'ListFunctionsCommand'
            ? { Functions: [{}, { FunctionName: 'mh-a' }] }
            : command === 'GetMetricDataCommand'
              ? { MetricDataResults: [{ Id: 'duration' }, { Id: 'other', Values: [5] }] }
              : {},
      ),
    });
    expect(await partial.getFunction('f')).toEqual({
      name: 'f',
      arn: 'arn:f',
      state: 'Pending',
      lastUpdateStatus: 'InProgress',
      tags: {},
    });
    expect(await partial.listFunctionNames()).toEqual(['mh-a']);
    expect(await partial.metricSums('f', new Date(0), new Date(1), 60)).toEqual({
      durationMs: 0,
      invocations: 0,
    });
  });

  it('throws what is not "already gone", with the service and code only', async () => {
    const failing: ServerlessSdkClientFactory = () => ({
      send: async () => {
        throw { name: 'ServiceUnavailable' };
      },
    });
    const api = createServerlessAwsApi(CONFIG, {
      clientFactory: (service, options) =>
        service === 'sts' ? stubFactory(() => ({}))(service, options) : failing(service, options),
    });
    await expect(api.deleteFunction('f')).rejects.toThrow(
      'The aws orchestrator could not be reached (lambda: ServiceUnavailable).',
    );
    await expect(api.deleteRepository('r')).rejects.toBeInstanceOf(OrchestratorApiError);
  });
});

describe('the serverless adapter’s defaults', () => {
  it('builds its own client from the config, and waits with a real timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const sim = createLambdaSim(() => 0);
    const port = createServerlessHostingDeployPort(
      { ...CONFIG, accountId: SIM_ACCOUNT, appPrefix: 'mh-' },
      { clientFactory: sim.clientFactory },
    );
    const deploying = port.deploy({
      appRef: 'mh-r1',
      environment: { kind: 'production' },
      artifact: {
        kind: 'image',
        ref: `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com/mh/r1/production`,
      },
      runtime: {
        port: 80,
        healthCheck: { path: '/' },
        startCommand: 'serve',
        database: { kind: 'none' },
        requires: { websockets: false, backgroundWork: false },
      },
      env: [],
      idle: { mode: 'suspend', idleSeconds: 60 },
    });
    await vi.runAllTimersAsync();
    const handle = await deploying;
    expect(handle.releaseId).toBe('1');
    expect(sim.calls.find((c) => c.command === 'CreateFunctionCommand')!.input['Code']).toEqual({
      ImageUri: `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com/mh/r1/production`,
    });

    // A function whose creation time was lost is settled from now: zero, never negative.
    delete sim.functions.get('mh-r1')!.tags['motir:created-at'];
    sim.functions.get('mh-r1')!.aliases.delete('live');
    expect(await port.destroyApp({ appRef: 'mh-r1' })).toEqual([
      expect.objectContaining({ releaseId: '', runningSeconds: 0, invocations: 0 }),
    ]);
  });
});

describe('signFunctionUrlRequest', () => {
  it('reads the config at call time, signs the body and keeps the region a function URL names', async () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', ROLE);
    vi.stubEnv('MOTIR_HOSTING_AWS_REGION', 'eu-west-1');
    const sim = createLambdaSim(() => 0);
    const signed = await signFunctionUrlRequest(
      'https://abc.lambda-url.us-east-2.on.aws/hook',
      { method: 'post', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      { clientFactory: sim.clientFactory },
    );
    expect(signed.method).toBe('POST');
    expect(signed.body).toBe('{"a":1}');
    expect(signed.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIASIM1\/\d{8}\/us-east-2\/lambda\/aws4_request,/,
    );
    expect(signed.headers['content-type']).toBe('application/json');
  });

  it('falls back to the configured region for another host, with given credentials', async () => {
    const signed = await signFunctionUrlRequest(
      'https://forwarder.example/x',
      {},
      {
        config: CONFIG,
        credentials: async () => ({ accessKeyId: 'AKIAGIVEN', secretAccessKey: 's' }),
      },
    );
    expect(signed.headers['authorization']).toContain(`AKIAGIVEN/`);
    expect(signed.headers['authorization']).toContain(`/${SIM_REGION}/lambda/`);
    expect(signed).not.toHaveProperty('body');
  });
});

describe('serverless names and usage arithmetic', () => {
  it('reads a unit back from its function name, and nothing from a bare prefix', () => {
    expect(unitOf('mh-', 'mh-r1-pr3')).toEqual({
      repositoryId: 'r1',
      environment: { kind: 'preview', pullRequest: 3 },
    });
    expect(unitOf('mh-', 'mh-r1')).toEqual({
      repositoryId: 'r1',
      environment: { kind: 'production' },
    });
    expect(unitOf('mh-', 'mh-')).toBeNull();
    expect(unitOf('mh-', 'other')).toBeNull();
    expect(environmentOfLabel(undefined)).toEqual({ kind: 'production' });
    expect(environmentOfLabel('pr-12')).toEqual({ kind: 'preview', pullRequest: 12 });
  });

  it('picks a period CloudWatch still holds at the window’s start', () => {
    const now = new Date('2026-10-28T00:00:00Z');
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    expect(metricPeriodSeconds(ago(1), now, now)).toBe(86_400);
    expect(metricPeriodSeconds(new Date(now.getTime() - 90_500), now, now)).toBe(120);
    expect(metricPeriodSeconds(ago(20), now, now) % 300).toBe(0);
    expect(metricPeriodSeconds(ago(100), now, now) % 3600).toBe(0);
    expect(metricPeriodSeconds(now, now, now)).toBe(60);
    expect(computeSecondsOf({ durationMs: 1499, invocations: 3 })).toBe(1);
  });
});
