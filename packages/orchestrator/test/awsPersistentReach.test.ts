import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_HOST_AGENT_INGRESS_DESCRIPTION,
  HOST_AGENT_PORT,
  HOST_CERTIFICATE_VALIDITY_DAYS,
  HostCertificateError,
  OrchestratorApiError,
  createAwsPersistentOrchestrator,
  createHostAgentClient,
  hostServerSubject,
  mintHostCertificateAuthority,
  mintHostClientCertificate,
  mintHostServerCertificate,
  parseInstanceUserData,
  type PersistentContainerHandle,
  type PersistentContainerSpec,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  FakeHostAgentClient,
  TEST_HOSTER_CA,
  TEST_HOSTER_CLIENT,
  testHostAgentConfig,
} from './contract/awsHostAgentFake';
import {
  AWS_HOSTER_AMI_ID,
  AWS_HOSTER_SHARD_TAG as SHARD,
  AWS_HOSTER_ZONES,
  AWS_PERSISTENT_SPEC as SPEC,
} from './contract/awsPersistentHarness';

// The AWS adapter's REACH CHANNEL (Story MOTIR-9361 · MOTIR-9470): exec, liveness
// and the terminal endpoint through the instance's host agent on 8443 over mutual
// TLS — the per-instance server certificate, the one inbound rule, the
// address that changes on every start, and the real client against a local
// HTTPS server that demands a client certificate.

const START = Date.parse('2026-10-24T10:00:00.000Z');
const MARKER = 'RUN-CREDENTIAL-MARKER-9470';

let ec2: AwsEc2Fake;
let agent: FakeHostAgentClient;

function adapter() {
  return createAwsPersistentOrchestrator({
    ec2,
    hostAgent: testHostAgentConfig(agent),
    region: 'us-east-1',
    shardTag: SHARD,
    amiId: AWS_HOSTER_AMI_ID,
    now: () => new Date(START),
    sleep: async () => {},
  });
}

function spec(overrides: Partial<PersistentContainerSpec> = {}): PersistentContainerSpec {
  return { ...SPEC, ...overrides };
}

function addressOf(handle: PersistentContainerHandle): string | undefined {
  return ec2.instances.get(handle.machineId)?.publicIpAddress;
}

function documentOf(handle: PersistentContainerHandle) {
  return parseInstanceUserData(ec2.userData.get(handle.machineId)!);
}

/** Everything the fake EC2 holds that is not the config document. */
function everythingButTheDocument(): string {
  return JSON.stringify({
    instances: [...ec2.instances.values()].map((i) => ({
      ...i,
      request: { ...i.request, userData: '' },
    })),
    volumes: [...ec2.volumes.values()],
    rules: [...ec2.ingressRules.values()],
    calls: ec2.calls.map((c) =>
      c.method === 'runInstances' || c.method === 'modifyInstanceUserData' ? c.method : c,
    ),
  });
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.now = () => new Date(START);
  ec2.seedShardNetwork(SHARD, AWS_HOSTER_ZONES);
  agent = new FakeHostAgentClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exec — through the host agent at the instance’s public address', () => {
  it('passes the argv, the stdin and the timeout unchanged, and resolves a non-zero exit', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    agent.behaviour = { exitCode: 7, stdout: 'out', stderr: 'err' };
    const result = await orchestrator.exec(handle, ['motir', 'launch'], {
      stdin: MARKER,
      timeoutSeconds: 30,
    });
    expect(result).toEqual({ exitCode: 7, stdout: 'out', stderr: 'err' });
    expect(agent.calls).toEqual([
      {
        address: addressOf(handle),
        request: { command: ['motir', 'launch'], stdin: MARKER, timeoutSeconds: 30 },
      },
    ]);
    await orchestrator.exec(handle, ['true']);
    expect(agent.calls[1]!.request).toEqual({ command: ['true'], timeoutSeconds: 120 });
  });

  it('is unreachable on an instance with no public address, and when the agent cannot be reached', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    agent.behaviour = { unreachable: true };
    await expect(orchestrator.exec(handle, ['true'])).rejects.toMatchObject({
      provider: 'aws',
      status: 503,
      message: expect.stringContaining('unreachable'),
    });
    agent.behaviour = {};
    await orchestrator.stop(handle);
    await expect(orchestrator.exec(handle, ['true'])).rejects.toMatchObject({ status: 503 });
    ec2.terminateOutside(handle.machineId);
    ec2.ageOut(handle.machineId);
    await expect(orchestrator.exec(handle, ['true'])).rejects.toMatchObject({ status: 503 });
    expect(agent.calls).toHaveLength(0);
  });

  it('carries a run credential in the exec only — no tag, user-data, rule or error holds it', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    await orchestrator.exec(handle, ['motir', 'launch'], { stdin: MARKER });
    agent.behaviour = { unreachable: true };
    const err = await orchestrator.exec(handle, ['x'], { stdin: MARKER }).catch((e: unknown) => e);
    expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain(MARKER);
    expect(everythingButTheDocument()).not.toContain(MARKER);
    expect(ec2.userData.get(handle.machineId)).not.toContain(MARKER);
  });
});

describe('checkLiveness — over the AWS exec, never a throw', () => {
  it('answers alive, exit, timeout and unreachable', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    expect(await orchestrator.checkLiveness(handle, ['agent', '--version'])).toEqual({
      alive: true,
    });
    agent.behaviour = { exitCode: 2, stderr: 'no agent' };
    expect(await orchestrator.checkLiveness(handle, ['agent'])).toMatchObject({
      alive: false,
      reason: 'exit',
      exitCode: 2,
    });
    agent.behaviour = { hangs: true };
    expect(
      await orchestrator.checkLiveness(handle, ['agent'], { timeoutSeconds: 5 }),
    ).toMatchObject({ alive: false, reason: 'timeout' });
    agent.behaviour = { unreachable: true };
    expect(await orchestrator.checkLiveness(handle, ['agent'])).toMatchObject({
      alive: false,
      reason: 'unreachable',
    });
  });
});

describe('terminalEndpoint — the host agent’s address now, with mutual TLS', () => {
  it('resolves the running address with the CA and the client pair, and the new one after a wake', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    const first = await orchestrator.terminalEndpoint(handle);
    expect(first).toEqual({
      url: `wss://${addressOf(handle)}:${HOST_AGENT_PORT}/v1/terminal`,
      headers: {},
      tls: {
        caPem: TEST_HOSTER_CA.certPem,
        certPem: TEST_HOSTER_CLIENT.certPem,
        keyPem: TEST_HOSTER_CLIENT.keyPem,
      },
    });
    await orchestrator.stop(handle);
    await expect(orchestrator.terminalEndpoint(handle)).rejects.toMatchObject({
      provider: 'aws',
      status: 409,
      message: expect.stringContaining('no_public_address'),
    });
    await orchestrator.start(handle);
    const second = await orchestrator.terminalEndpoint(handle);
    expect(second.url).toBe(`wss://${addressOf(handle)}:${HOST_AGENT_PORT}/v1/terminal`);
    expect(second.url).not.toBe(first.url);
  });
});

describe('provisionPersistent — the server certificate and the one inbound rule', () => {
  it('mints a CA-signed, year-long certificate per instance, carried only in the document', async () => {
    const orchestrator = adapter();
    const a = await orchestrator.provisionPersistent(spec());
    const b = await orchestrator.provisionPersistent(spec({ instanceId: 'inst-reach-b' }));
    const docA = documentOf(a).hostAgent!;
    const docB = documentOf(b).hostAgent!;
    expect(docA.caPem).toBe(TEST_HOSTER_CA.certPem);

    const cert = new X509Certificate(docA.certPem);
    const ca = new X509Certificate(TEST_HOSTER_CA.certPem);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.subject).toContain(`motir-instance-${SPEC.instanceId}`);
    const lifeDays = (Date.parse(cert.validTo) - START) / 86_400_000;
    expect(Math.round(lifeDays)).toBe(HOST_CERTIFICATE_VALIDITY_DAYS);
    expect(docA.keyPem).not.toBe(docB.keyPem);
    expect(
      new X509Certificate(docB.certPem).publicKey.export({ format: 'pem', type: 'spki' }),
    ).not.toBe(cert.publicKey.export({ format: 'pem', type: 'spki' }));

    // The private key is nowhere but the document.
    const keyBody = docA.keyPem.split('\n')[1]!;
    expect(everythingButTheDocument()).not.toContain(keyBody);
  });

  it('opens TCP 8443 from anywhere and nothing else, once, however often it provisions', async () => {
    const orchestrator = adapter();
    await orchestrator.provisionPersistent(spec());
    await orchestrator.provisionPersistent(spec({ instanceId: 'inst-reach-b' }));
    expect(ec2.count('authorizeSecurityGroupIngress')).toBe(2);
    expect(ec2.ingressRules.get(`sg-${SHARD}`)).toEqual([
      { port: 8443, cidrIp: '0.0.0.0/0', description: AWS_HOST_AGENT_INGRESS_DESCRIPTION },
    ]);
  });

  it('a refused rule (other than a duplicate) stops the provision before any launch', async () => {
    ec2.failNext('authorizeSecurityGroupIngress', 'UnauthorizedOperation', 403);
    await expect(adapter().provisionPersistent(spec())).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
    expect(ec2.count('runInstances')).toBe(0);
  });
});

describe('hostCertificates', () => {
  const now = new Date(START);

  it('signs with an RSA CA as well, and names the instance in the subject', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = await mintHostCertificateAuthority({ name: 'any', now, days: 1 });
    // An RSA key with an EC CA certificate still signs: the issuer name is what is read.
    const minted = await mintHostServerCertificate({
      ca: {
        certPem: ec.certPem,
        keyPem: privateKey.export({ format: 'pem', type: 'pkcs1' }) as string,
      },
      instanceId: 'inst,odd=name',
      now,
    });
    expect(new X509Certificate(minted.certPem).subject).toContain('motir-instance-inst_odd_name');
    expect(hostServerSubject('a')).toBe('CN=motir-instance-a, O=Motir');
  });

  it('refuses a CA key it cannot sign with, and unreadable PEM, without echoing it', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const ed = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const cases: Array<[{ certPem: string; keyPem: string }, string]> = [
      [{ certPem: TEST_HOSTER_CA.certPem, keyPem: ed }, 'unsupported_key'],
      [{ certPem: TEST_HOSTER_CA.certPem, keyPem: `not a key ${MARKER}` }, 'unreadable_key'],
      [
        { certPem: `not a cert ${MARKER}`, keyPem: TEST_HOSTER_CA.keyPem },
        'unreadable_certificate',
      ],
    ];
    for (const [ca, reason] of cases) {
      const err = await mintHostServerCertificate({ ca, instanceId: 'i', now }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HostCertificateError);
      expect(err).toMatchObject({ reason });
      expect((err as Error).message).not.toContain(MARKER);
    }
  });
});

describe('createHostAgentClient — mutual TLS against a local HTTPS host agent', () => {
  let server: Server;
  let port: number;
  let answer: (body: Record<string, unknown>) => { status: number; body: string; delayMs?: number };
  const received: Array<Record<string, unknown>> = [];

  async function listen() {
    const serverCert = await mintHostServerCertificate({
      ca: TEST_HOSTER_CA,
      instanceId: 'inst-local',
      now: new Date(),
    });
    server = createServer({
      cert: serverCert.certPem,
      key: serverCert.keyPem,
      ca: TEST_HOSTER_CA.certPem,
      requestCert: true,
      rejectUnauthorized: true,
    });
    server.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        received.push({ ...body, path: req.url, method: req.method });
        const out = answer(body);
        setTimeout(() => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(out.body);
        }, out.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(async () => {
    received.length = 0;
    answer = () => ({
      status: 200,
      body: JSON.stringify({ exitCode: 0, stdout: 'hi', stderr: '' }),
    });
    await listen();
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(overrides: Partial<Parameters<typeof createHostAgentClient>[0]> = {}) {
    return createHostAgentClient({
      caPem: TEST_HOSTER_CA.certPem,
      certPem: TEST_HOSTER_CLIENT.certPem,
      keyPem: TEST_HOSTER_CLIENT.keyPem,
      port,
      ...overrides,
    });
  }

  it('connects with the Motir client certificate, ignoring the host name, and posts the exec', async () => {
    const result = await client().exec('127.0.0.1', {
      command: ['git', 'clone'],
      stdin: MARKER,
      timeoutSeconds: 10,
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });
    expect(received).toEqual([
      {
        command: ['git', 'clone'],
        stdin: MARKER,
        timeoutSeconds: 10,
        path: '/v1/exec',
        method: 'POST',
      },
    ]);
    // A host name the certificate does not name is fine: the CA chain is the check.
    await expect(
      client().exec('localhost', { command: ['true'], timeoutSeconds: 1 }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('is refused without a client certificate signed by the CA', async () => {
    const stranger = await mintHostCertificateAuthority({
      name: 'stranger',
      now: new Date(),
      days: 1,
    });
    const strangerClient = await mintHostClientCertificate({
      ca: stranger,
      name: 'x',
      now: new Date(),
    });
    await expect(
      client({ certPem: strangerClient.certPem, keyPem: strangerClient.keyPem }).exec('127.0.0.1', {
        command: ['true'],
        timeoutSeconds: 1,
      }),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('unreachable') });
    expect(received).toHaveLength(0);
  });

  it('rejects a server whose certificate the CA did not sign', async () => {
    const stranger = await mintHostCertificateAuthority({
      name: 'stranger',
      now: new Date(),
      days: 1,
    });
    await expect(
      client({ caPem: stranger.certPem }).exec('127.0.0.1', {
        command: ['true'],
        timeoutSeconds: 1,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(received).toHaveLength(0);
  });

  it('reads the agent’s 408 as a timeout, any other answer as a refusal without its body', async () => {
    answer = () => ({ status: 408, body: '{}' });
    await expect(
      client().exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ status: 408, message: expect.stringContaining('exec_timeout') });
    answer = () => ({ status: 500, body: JSON.stringify({ error: MARKER }) });
    const err = await client()
      .exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ status: 500 });
    expect((err as Error).message).not.toContain(MARKER);
    answer = () => ({ status: 200, body: 'not json' });
    await expect(
      client().exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ message: expect.stringContaining('host_agent_refused') });
    answer = () => ({ status: 200, body: JSON.stringify({ exitCode: 1.5 }) });
    await expect(
      client().exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ message: expect.stringContaining('host_agent_refused') });
    answer = () => ({ status: 200, body: 'null' });
    await expect(
      client().exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ message: expect.stringContaining('host_agent_refused') });
    answer = () => ({ status: 200, body: JSON.stringify({ exitCode: 3 }) });
    await expect(
      client().exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).resolves.toEqual({
      exitCode: 3,
      stdout: '',
      stderr: '',
    });
  });

  it('gives up at its own deadline as unreachable', async () => {
    answer = () => ({ status: 200, body: '{}', delayMs: 2_000 });
    await expect(
      client({ deadlineMarginSeconds: 0.2 }).exec('127.0.0.1', {
        command: ['x'],
        timeoutSeconds: 0,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('dials the host agent port by default', async () => {
    // Nothing listens on 8443 here: the default port is the one refused.
    const defaults = createHostAgentClient({
      caPem: TEST_HOSTER_CA.certPem,
      certPem: TEST_HOSTER_CLIENT.certPem,
      keyPem: TEST_HOSTER_CLIENT.keyPem,
    });
    expect(HOST_AGENT_PORT).toBe(8443);
    await expect(
      defaults.exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(received).toHaveLength(0);
  });

  it('is unreachable when nothing listens', async () => {
    await expect(
      client({ port: 1 }).exec('127.0.0.1', { command: ['x'], timeoutSeconds: 1 }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
