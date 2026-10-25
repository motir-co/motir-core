import { X509Certificate } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CERTIFICATE_RENEW_BEFORE_DAYS,
  certificateNotAfter,
  createAwsPersistentOrchestrator,
  hostCertificateNeedsRenewal,
  hostServerSubject,
  parseInstanceUserData,
  renderInstanceUserData,
  type PersistentContainerHandle,
  type PersistentTerminalConfig,
} from '../src/index';
import { TEST_HOSTER_CA, testHostAgentConfig } from './contract/awsHostAgentFake';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  AWS_HOSTER_AMI_ID,
  AWS_HOSTER_SHARD_TAG as SHARD,
  AWS_HOSTER_ZONES,
  AWS_PERSISTENT_SPEC as SPEC,
} from './contract/awsPersistentHarness';

// RENEWING THE HOST AGENT'S SERVER CERTIFICATE ON WAKE (Story MOTIR-9361 ·
// MOTIR-9481): `ensureMachineConfig` on a stopped instance reissues the
// certificate when fewer than 60 days remain, past its end or unreadable — the
// `hostAgent` block only, in the same single write as a terminal rewrite.

const DAY = 86_400_000;
const START = Date.parse('2026-10-24T10:00:00.000Z');
const MARKER = 'SECRET-MARKER-RENEWAL';

const TERMINAL: PersistentTerminalConfig = {
  version: 2,
  keyId: 'kid-a',
  command: ['motir', 'agent-terminal', 'serve'],
  env: { MOTIR_TERMINAL_KEY: MARKER },
  service: {
    internalPort: 7681,
    ports: [{ port: 443, handlers: ['tls', 'http'] }],
    autostart: false,
    autostop: 'off',
  },
};

let ec2: AwsEc2Fake;
let clock: number;

function adapter() {
  return createAwsPersistentOrchestrator({
    ec2,
    hostAgent: testHostAgentConfig(),
    region: 'us-east-1',
    shardTag: SHARD,
    amiId: AWS_HOSTER_AMI_ID,
    now: () => new Date(clock),
    sleep: async () => {},
  });
}

const docOf = (handle: PersistentContainerHandle) =>
  parseInstanceUserData(ec2.userData.get(handle.machineId)!);

async function stopped() {
  const orchestrator = adapter();
  const handle = await orchestrator.provisionPersistent({
    ...SPEC,
    env: { ...SPEC.env, API_TOKEN: MARKER },
    terminal: TERMINAL,
  });
  await orchestrator.stop(handle);
  return { orchestrator, handle };
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  clock = START;
  ec2.now = () => new Date(clock);
  ec2.seedShardNetwork(SHARD, AWS_HOSTER_ZONES);
});

describe('hostCertificateNeedsRenewal', () => {
  it('renews under 60 days, past the end, or with no readable certificate', async () => {
    const { handle } = await stopped();
    const pem = docOf(handle).hostAgent!.certPem;
    const end = certificateNotAfter(pem)!.getTime();
    const at = (daysLeft: number) => new Date(end - daysLeft * DAY);
    expect(hostCertificateNeedsRenewal(pem, at(HOST_CERTIFICATE_RENEW_BEFORE_DAYS + 1))).toBe(
      false,
    );
    expect(hostCertificateNeedsRenewal(pem, at(HOST_CERTIFICATE_RENEW_BEFORE_DAYS - 1))).toBe(true);
    expect(hostCertificateNeedsRenewal(pem, at(-1))).toBe(true);
    expect(hostCertificateNeedsRenewal(undefined, new Date(START))).toBe(true);
    expect(hostCertificateNeedsRenewal('not a certificate', new Date(START))).toBe(true);
    expect(certificateNotAfter(null)).toBeNull();
  });
});

describe('ensureMachineConfig — the certificate', () => {
  it('with 30 days left, reissues it for a year from the CA, changes nothing else, and answers updated', async () => {
    const { orchestrator, handle } = await stopped();
    const before = docOf(handle);
    clock = START + 335 * DAY;
    const writes = ec2.count('modifyInstanceUserData');

    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('updated');

    const after = docOf(handle);
    expect(ec2.count('modifyInstanceUserData')).toBe(writes + 1);
    const { hostAgent: oldAgent, ...oldRest } = before;
    const { hostAgent: newAgent, ...newRest } = after;
    expect(newRest).toEqual(oldRest);
    expect(newAgent!.caPem).toBe(oldAgent!.caPem);
    expect(newAgent!.keyPem).not.toBe(oldAgent!.keyPem);
    const cert = new X509Certificate(newAgent!.certPem);
    expect(cert.verify(new X509Certificate(TEST_HOSTER_CA.certPem).publicKey)).toBe(true);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(clock + 364 * DAY);
    expect(cert.subject).toContain(
      hostServerSubject(SPEC.instanceId).split(',')[0]!.replace('CN=', ''),
    );
    expect(ec2.instances.get(handle.machineId)!.state).toBe('stopped');

    // A second call has nothing left to do.
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('current');
    expect(ec2.count('modifyInstanceUserData')).toBe(writes + 1);
  });

  it('with 200 days left, writes nothing and answers current', async () => {
    const { orchestrator, handle } = await stopped();
    clock = START + 165 * DAY;
    const writes = ec2.count('modifyInstanceUserData');
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('current');
    expect(ec2.count('modifyInstanceUserData')).toBe(writes);
  });

  it('replaces an expired certificate, and one the document lost', async () => {
    const { orchestrator, handle } = await stopped();
    clock = START + 400 * DAY;
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('updated');
    expect(certificateNotAfter(docOf(handle).hostAgent!.certPem)!.getTime()).toBeGreaterThan(clock);

    ec2.userData.set(
      handle.machineId,
      renderInstanceUserData({ ...docOf(handle), hostAgent: null }),
    );
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('updated');
    expect(docOf(handle).hostAgent).toMatchObject({ caPem: TEST_HOSTER_CA.certPem });
  });

  it('a terminal rewrite and a renewal are ONE write', async () => {
    const { orchestrator, handle } = await stopped();
    clock = START + 340 * DAY;
    const writes = ec2.count('modifyInstanceUserData');
    const rotated = { ...TERMINAL, version: 3 };
    expect(await orchestrator.ensureMachineConfig(handle, rotated)).toBe('updated');
    expect(ec2.count('modifyInstanceUserData')).toBe(writes + 1);
    expect(docOf(handle).terminal).toEqual(rotated);
    expect(hostCertificateNeedsRenewal(docOf(handle).hostAgent!.certPem, new Date(clock))).toBe(
      false,
    );
  });

  it('never writes a running instance: current while its stamp is, refused otherwise', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    clock = START + 335 * DAY;
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('current');
    await expect(
      orchestrator.ensureMachineConfig(handle, { ...TERMINAL, version: 9 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('puts no key, certificate or document in a log line or an error', async () => {
    const { orchestrator, handle } = await stopped();
    const key = docOf(handle).hostAgent!.keyPem;
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    clock = START + 335 * DAY;
    ec2.failNext('modifyInstanceUserData', 'InternalError', 500);
    const err = await orchestrator.ensureMachineConfig(handle, TERMINAL).catch((e: unknown) => e);
    const text = `${String(err)} ${JSON.stringify(err)} ${logged.join('\n')}`;
    expect(text).not.toContain(key);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(MARKER);
    vi.restoreAllMocks();
  });
});
