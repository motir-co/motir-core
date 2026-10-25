import { request as httpsRequest } from 'node:https';
import { OrchestratorApiError } from '../../errors';
import type { PersistentExecResult } from '../../types';

// The client for an AWS agent instance's HOST AGENT (Story MOTIR-9361 ·
// MOTIR-9470): the small HTTPS service on port 8443 of the instance that runs a
// command inside the instance's container and proxies its terminal. The contract
// — request and response shapes, the trust model — is
// `docs/decisions/aws-hoster-host-agent.md`.
//
// MUTUAL TLS. The client presents Motir's client certificate and trusts ONLY the
// Motir hoster CA (`ca`), never the system roots. The server's HOST NAME is not
// checked (`checkServerIdentity` returns no error): the address is a public IP
// that changes on every start, and a certificate signed by the CA for some
// instance is the identity. `rejectUnauthorized` stays true — the chain to the
// CA IS checked.
//
// ⚠️ THE STDIN CAN CARRY A RUN CREDENTIAL. It travels only in the TLS body of the
// one request; no error and no log line here holds it, or the command's output.

/** The host agent's port on every AWS agent instance. */
export const HOST_AGENT_PORT = 8443;

/** How much longer than the command's own timeout the request may take. */
export const HOST_AGENT_DEADLINE_MARGIN_SECONDS = 15;

/** The TLS material Motir dials a host agent with. */
export interface HostAgentTls {
  /** The Motir hoster CA certificate — the only trust anchor. */
  readonly caPem: string;
  /** Motir's client certificate and key. */
  readonly certPem: string;
  readonly keyPem: string;
}

/** One `POST /v1/exec`. */
export interface HostAgentExecRequest {
  readonly command: readonly string[];
  readonly stdin?: string;
  readonly timeoutSeconds: number;
}

/** The host agent as the adapter sees it — the seam a test replaces. */
export interface HostAgentClient {
  /** Run `request.command` in the instance's container at `address`. A non-zero
   *  exit is a result. The agent's own timeout throws status 408; a transport
   *  failure throws status 503 `unreachable`. */
  exec(address: string, request: HostAgentExecRequest): Promise<PersistentExecResult>;
}

/** The TLS options of every dial to a host agent — the exec client's and the relay's. */
export function hostAgentTlsOptions(tls: HostAgentTls) {
  return {
    ca: tls.caPem,
    cert: tls.certPem,
    key: tls.keyPem,
    rejectUnauthorized: true,
    // The chain to the Motir CA is the check; the address is a changing IP.
    checkServerIdentity: () => undefined,
  };
}

/** The `PersistentExecResult` in a host agent's answer, or null when it is not one. */
function execResultOf(body: unknown): PersistentExecResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['exitCode'] !== 'number' || !Number.isInteger(b['exitCode'])) return null;
  return {
    exitCode: b['exitCode'],
    stdout: typeof b['stdout'] === 'string' ? b['stdout'] : '',
    stderr: typeof b['stderr'] === 'string' ? b['stderr'] : '',
  };
}

export interface HostAgentClientOptions extends HostAgentTls {
  /** The port to dial — the test seam; {@link HOST_AGENT_PORT} otherwise. */
  readonly port?: number;
  /** The margin over the command's timeout — the test seam;
   *  {@link HOST_AGENT_DEADLINE_MARGIN_SECONDS} otherwise. */
  readonly deadlineMarginSeconds?: number;
}

/** A {@link HostAgentClient} over `node:https` with mutual TLS. */
export function createHostAgentClient(options: HostAgentClientOptions): HostAgentClient {
  const port = options.port ?? HOST_AGENT_PORT;
  const margin = options.deadlineMarginSeconds ?? HOST_AGENT_DEADLINE_MARGIN_SECONDS;
  const tls = hostAgentTlsOptions(options);
  return {
    exec(address, request) {
      const body = JSON.stringify({
        command: [...request.command],
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        timeoutSeconds: request.timeoutSeconds,
      });
      const deadlineMs = (request.timeoutSeconds + margin) * 1000;
      return new Promise<PersistentExecResult>((resolve, reject) => {
        const unreachable = () => reject(new OrchestratorApiError('aws', 503, 'unreachable'));
        const req = httpsRequest(
          {
            host: address,
            port,
            method: 'POST',
            path: '/v1/exec',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
            ...tls,
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('error', unreachable);
            res.on('end', () => {
              const status = res.statusCode ?? 0;
              if (status === 408) {
                reject(new OrchestratorApiError('aws', 408, 'exec_timeout'));
                return;
              }
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                parsed = null;
              }
              const result = status === 200 ? execResultOf(parsed) : null;
              if (result) resolve(result);
              // The agent's body is never echoed: it may hold the command's output.
              else reject(new OrchestratorApiError('aws', status || null, 'host_agent_refused'));
            });
          },
        );
        req.setTimeout(deadlineMs, () => req.destroy(new Error('deadline')));
        req.on('error', unreachable);
        req.end(body);
      });
    },
  };
}
