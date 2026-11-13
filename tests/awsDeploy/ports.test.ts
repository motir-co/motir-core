import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ECRClient, ImageNotFoundException } from '@aws-sdk/client-ecr';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awsSdkPorts } from '@/scripts/aws-deploy/ports';

// MOTIR-9927 — the SDK adapter is one command per method. Each client's `send`
// is replaced, so these tests see the command and its input and reach no network.

type Sent = { command: string; input: Record<string, unknown> };
type Responder = (command: string, input: Record<string, unknown>) => unknown;

function stubClients(respond: Responder) {
  const sent: Sent[] = [];
  for (const client of [
    CloudFormationClient,
    ECSClient,
    SSMClient,
    ECRClient,
    CloudWatchLogsClient,
    SecretsManagerClient,
  ]) {
    vi.spyOn(client.prototype, 'send').mockImplementation(((command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      const name = command.constructor.name;
      sent.push({ command: name, input: command.input });
      try {
        return Promise.resolve(respond(name, command.input));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }) as never);
  }
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('awsSdkPorts', () => {
  // MOTIR-10883 — the image pins' secret reads and writes.
  it('reads a secret, writes one, and reads a missing secret as granted and empty', async () => {
    let missing = false;
    const sent = stubClients((c) => {
      if (missing) throw new ResourceNotFoundException({ message: 'no', $metadata: {} });
      return c === 'GetSecretValueCommand' ? { SecretString: 'ref' } : {};
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.getSecretValue('motir/core/x')).toEqual({ state: 'granted', value: 'ref' });
    await ports.putSecretValue('motir/core/x', 'new');
    expect(sent).toEqual([
      { command: 'GetSecretValueCommand', input: { SecretId: 'motir/core/x' } },
      {
        command: 'PutSecretValueCommand',
        input: { SecretId: 'motir/core/x', SecretString: 'new' },
      },
    ]);
    missing = true;
    expect(await ports.getSecretValue('motir/core/x')).toEqual({
      state: 'granted',
      value: undefined,
    });
  });

  it('reads an AccessDenied secret as not granted, and rethrows any other error', async () => {
    let name = 'AccessDeniedException';
    stubClients(() => {
      const err = new Error('refused');
      err.name = name;
      throw err;
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.getSecretValue('s')).toEqual({ state: 'not_granted' });
    name = 'ThrottlingException';
    await expect(ports.getSecretValue('s')).rejects.toThrow('refused');
  });

  it('reads and overwrites a parameter, with no type or tags on the write', async () => {
    const sent = stubClients((c) =>
      c === 'GetParameterCommand' ? { Parameter: { Value: 'v' } } : {},
    );
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.getParameter('/p')).toBe('v');
    await ports.putParameter('/p', 'w');
    expect(sent).toEqual([
      { command: 'GetParameterCommand', input: { Name: '/p' } },
      { command: 'PutParameterCommand', input: { Name: '/p', Value: 'w', Overwrite: true } },
    ]);
  });

  // MOTIR-10986 — the indexer pin is a parameter, read the way a pinned secret is.
  it('reads a pinned parameter, and a missing one as granted and empty', async () => {
    let missing = false;
    const sent = stubClients(() => {
      if (missing) throw new ParameterNotFound({ message: 'no', $metadata: {} });
      return { Parameter: { Value: 'ref' } };
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.readParameter('/motir/core/indexer-image')).toEqual({
      state: 'granted',
      value: 'ref',
    });
    expect(sent).toEqual([
      { command: 'GetParameterCommand', input: { Name: '/motir/core/indexer-image' } },
    ]);
    missing = true;
    expect(await ports.readParameter('/motir/core/indexer-image')).toEqual({
      state: 'granted',
      value: undefined,
    });
  });

  it('reads an AccessDenied parameter as not granted, and rethrows any other error', async () => {
    let name = 'AccessDeniedException';
    stubClients(() => {
      const err = new Error('refused');
      err.name = name;
      throw err;
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.readParameter('/p')).toEqual({ state: 'not_granted' });
    name = 'ThrottlingException';
    await expect(ports.readParameter('/p')).rejects.toThrow('refused');
  });

  it('returns undefined for a parameter with no value', async () => {
    stubClients(() => ({}));
    expect(await awsSdkPorts('us-east-1').getParameter('/p')).toBeUndefined();
  });

  it('finds an image by digest, and reads ImageNotFound as absent', async () => {
    let found = true;
    const sent = stubClients(() => {
      if (!found) throw new ImageNotFoundException({ message: 'no', $metadata: {} });
      return { imageDetails: [{ imageDigest: 'd' }] };
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.imageExists('motir-prod/motir-core', 'd')).toBe(true);
    expect(sent[0]).toEqual({
      command: 'DescribeImagesCommand',
      input: { repositoryName: 'motir-prod/motir-core', imageIds: [{ imageDigest: 'd' }] },
    });
    found = false;
    expect(await ports.imageExists('r', 'd')).toBe(false);
  });

  it('reads an empty image list as absent, and rethrows any other ECR error', async () => {
    let fail = false;
    stubClients(() => {
      if (fail) throw new Error('AccessDenied');
      return {};
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.imageExists('r', 'd')).toBe(false);
    fail = true;
    await expect(ports.imageExists('r', 'd')).rejects.toThrow('AccessDenied');
  });

  it('describes and registers task definitions, refusing an empty answer', async () => {
    let empty = false;
    stubClients((c) => {
      if (empty) return {};
      if (c === 'DescribeTaskDefinitionCommand') return { taskDefinition: { family: 'f' } };
      return { taskDefinition: { taskDefinitionArn: 'arn:f:2' } };
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.describeTaskDefinition('f')).toEqual({ family: 'f' });
    expect(await ports.registerTaskDefinition({ family: 'f', containerDefinitions: [] })).toBe(
      'arn:f:2',
    );
    empty = true;
    await expect(ports.describeTaskDefinition('f')).rejects.toThrow('no task definition f');
    await expect(
      ports.registerTaskDefinition({ family: 'f', containerDefinitions: [] }),
    ).rejects.toThrow('registering f returned no ARN');
  });

  it('runs a task and names the failures when none starts', async () => {
    let started = true;
    stubClients(() =>
      started
        ? { tasks: [{ taskArn: 'arn:task/1' }] }
        : { tasks: [], failures: [{ reason: 'RESOURCE:ENI' }, {}] },
    );
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.runTask({ cluster: 'c', taskDefinition: 't' })).toBe('arn:task/1');
    started = false;
    await expect(ports.runTask({ cluster: 'c', taskDefinition: 't' })).rejects.toThrow(
      'RunTask started no task: RESOURCE:ENI, unknown',
    );
  });

  it('says so when RunTask gives no reason', async () => {
    stubClients(() => ({}));
    await expect(awsSdkPorts('us-east-1').runTask({ taskDefinition: 't' })).rejects.toThrow(
      'no reason given',
    );
  });

  it('describes and stops one task', async () => {
    const sent = stubClients((c) =>
      c === 'DescribeTasksCommand' ? { tasks: [{ lastStatus: 'STOPPED' }] } : {},
    );
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.describeTask('c', 'arn:t')).toEqual({ lastStatus: 'STOPPED' });
    await ports.stopTask('c', 'arn:t', 'why');
    expect(sent.map((s) => s.input)).toEqual([
      { cluster: 'c', tasks: ['arn:t'] },
      { cluster: 'c', task: 'arn:t', reason: 'why' },
    ]);
  });

  it('pages through ListServices', async () => {
    const sent = stubClients((_c, input) =>
      input.nextToken ? { serviceArns: ['b'] } : { serviceArns: ['a'], nextToken: 'n' },
    );
    expect(await awsSdkPorts('us-east-1').listServices('c')).toEqual(['a', 'b']);
    expect(sent).toHaveLength(2);
  });

  it('reads an empty service list', async () => {
    stubClients(() => ({}));
    expect(await awsSdkPorts('us-east-1').listServices('c')).toEqual([]);
  });

  it('describes services ten at a time', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `s${String(i)}`);
    const sent = stubClients((_c, input) => ({
      services: (input.services as string[]).map((s) => ({ serviceName: s })),
    }));
    const services = await awsSdkPorts('us-east-1').describeServices('c', names);
    expect(services.map((s) => s.serviceName)).toEqual(names);
    expect(sent.map((s) => (s.input.services as string[]).length)).toEqual([10, 2]);
  });

  it('reads a batch with no services as none', async () => {
    stubClients(() => ({}));
    expect(await awsSdkPorts('us-east-1').describeServices('c', ['a'])).toEqual([]);
  });

  it('updates a service onto a task definition', async () => {
    const sent = stubClients(() => ({}));
    await awsSdkPorts('us-east-1').updateService('c', 'web', 'arn:td');
    expect(sent).toEqual([
      {
        command: 'UpdateServiceCommand',
        input: { cluster: 'c', service: 'web', taskDefinition: 'arn:td' },
      },
    ]);
  });

  it('tails a log stream from its end', async () => {
    const sent = stubClients(() => ({ events: [{ message: 'one' }, {}] }));
    expect(await awsSdkPorts('us-east-1').tailLog('g', 's', 50)).toEqual(['one', '']);
    expect(sent[0]?.input).toEqual({
      logGroupName: 'g',
      logStreamName: 's',
      limit: 50,
      startFromHead: false,
    });
  });

  it('reads a stream with no events as empty', async () => {
    stubClients(() => ({}));
    expect(await awsSdkPorts('us-east-1').tailLog('g', 's', 50)).toEqual([]);
  });

  // MOTIR-11235 — the wait between the migrate and the roll.
  it("reads a stack's status, and a stack with no answer as granted and empty", async () => {
    let stacks: unknown = [{ StackStatus: 'UPDATE_IN_PROGRESS' }];
    const sent = stubClients(() => ({ Stacks: stacks }));
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.stackStatus('motir-prod-services')).toEqual({
      state: 'granted',
      value: 'UPDATE_IN_PROGRESS',
    });
    expect(sent).toEqual([
      { command: 'DescribeStacksCommand', input: { StackName: 'motir-prod-services' } },
    ]);
    stacks = undefined;
    expect(await ports.stackStatus('motir-prod-services')).toEqual({
      state: 'granted',
      value: undefined,
    });
  });

  it('reads a missing stack as granted and empty, a refusal as not granted, and rethrows the rest', async () => {
    let failure: { name: string; message: string } | string = {
      name: 'ValidationError',
      message: 'Stack with id motir-prod-services does not exist',
    };
    stubClients(() => {
      if (typeof failure === 'string') throw failure as unknown as Error;
      const err = new Error(failure.message);
      err.name = failure.name;
      throw err;
    });
    const ports = awsSdkPorts('us-east-1');
    expect(await ports.stackStatus('s')).toEqual({ state: 'granted', value: undefined });
    for (const name of ['AccessDenied', 'AccessDeniedException']) {
      failure = { name, message: 'not authorized' };
      expect(await ports.stackStatus('s')).toEqual({ state: 'not_granted' });
    }
    failure = { name: 'ValidationError', message: 'StackName is malformed' };
    await expect(ports.stackStatus('s')).rejects.toThrow('StackName is malformed');
    failure = { name: 'Throttling', message: 'Rate exceeded' };
    await expect(ports.stackStatus('s')).rejects.toThrow('Rate exceeded');
    failure = 'not an error';
    await expect(ports.stackStatus('s')).rejects.toBe('not an error');
  });

  it('sleeps on a real timer', async () => {
    vi.useFakeTimers();
    try {
      const ports = awsSdkPorts('us-east-1');
      let done = false;
      const slept = ports.sleep(1000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await slept;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
