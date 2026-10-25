import {
  OrchestratorApiError,
  mintHostCertificateAuthority,
  mintHostClientCertificate,
  type AwsHostAgentConfig,
  type HostAgentClient,
  type HostAgentExecRequest,
  type PersistentExecResult,
} from '../../src/index';
import type { PersistentExecBehaviour, PersistentExecRecord } from './persistentContract';

// An in-memory HOST AGENT (Story MOTIR-9361 · MOTIR-9470) — what the AWS adapter's
// exec reaches on an instance's 8443, as the real client would report it: a
// result, the agent's own timeout as status 408, and a transport failure as 503
// `unreachable`. Plus a test CA and Motir client certificate, minted once per
// test process (a real hoster CA arrives with the secrets card).

const NOW = new Date('2026-10-24T10:00:00.000Z');

export const TEST_HOSTER_CA = await mintHostCertificateAuthority({
  name: 'Motir hoster CA (test)',
  now: NOW,
  days: 3650,
});

export const TEST_HOSTER_CLIENT = await mintHostClientCertificate({
  ca: TEST_HOSTER_CA,
  name: 'motir-control-plane (test)',
  now: NOW,
});

export class FakeHostAgentClient implements HostAgentClient {
  /** Every exec that reached an agent, with the address it was sent to. */
  readonly calls: Array<{ address: string; request: HostAgentExecRequest }> = [];
  behaviour: PersistentExecBehaviour = {};

  async exec(address: string, request: HostAgentExecRequest): Promise<PersistentExecResult> {
    if (this.behaviour.unreachable) throw new OrchestratorApiError('aws', 503, 'unreachable');
    this.calls.push({ address, request });
    if (this.behaviour.hangs) throw new OrchestratorApiError('aws', 408, 'exec_timeout');
    return {
      exitCode: this.behaviour.exitCode ?? 0,
      stdout: this.behaviour.stdout ?? '',
      stderr: this.behaviour.stderr ?? '',
    };
  }

  /** The commands as the contract records them, against `machineOf(address)`. */
  records(machineOf: (address: string) => string): PersistentExecRecord[] {
    return this.calls.map((c) => ({
      machineId: machineOf(c.address),
      command: c.request.command,
      ...(c.request.stdin !== undefined ? { stdin: c.request.stdin } : {}),
    }));
  }
}

/** The adapter's host agent config over `client`, with the test CA and client pair. */
export function testHostAgentConfig(
  client: HostAgentClient = new FakeHostAgentClient(),
): AwsHostAgentConfig {
  return {
    client,
    ca: TEST_HOSTER_CA,
    clientTls: {
      caPem: TEST_HOSTER_CA.certPem,
      certPem: TEST_HOSTER_CLIENT.certPem,
      keyPem: TEST_HOSTER_CLIENT.keyPem,
    },
  };
}
