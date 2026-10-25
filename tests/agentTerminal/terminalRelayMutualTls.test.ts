import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  mintHostCertificateAuthority,
  mintHostClientCertificate,
  mintHostServerCertificate,
  type HostCertificatePem,
} from '@motir/orchestrator';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';

// THE RELAY'S MUTUAL-TLS DIAL (Story MOTIR-9361 · MOTIR-9470): an AWS agent
// instance's terminal is its host agent on 8443, which accepts only a client
// certificate signed by the Motir hoster CA. When the authorized target carries
// `tls`, the relay presents that client pair, trusts ONLY that CA and does not
// check the host name (the address is a changing public IP). A dial without
// `tls` is the Fly / fake dial, unchanged — `terminalRelay.test.ts` covers it.

const ORIGIN = 'https://motir.test';
const NOW = new Date();

let ca: HostCertificatePem;
let client: HostCertificatePem;
let agent: {
  url: string;
  upgrades: Array<{ authorized: boolean; subject: string }>;
  close(): Promise<void>;
};
let relay: TerminalRelay;
let relayUrl: string;
let dialTls: { caPem: string; certPem: string; keyPem: string } | undefined;

async function startHostAgent(): Promise<typeof agent> {
  const server = await mintHostServerCertificate({ ca, instanceId: 'inst-tls', now: NOW });
  const upgrades: Array<{ authorized: boolean; subject: string }> = [];
  const wss = new WebSocketServer({ noServer: true });
  const httpsServer = https.createServer({
    cert: server.certPem,
    key: server.keyPem,
    ca: ca.certPem,
    requestCert: true,
    rejectUnauthorized: true,
  });
  httpsServer.on('upgrade', (req, socket, head) => {
    const tls = req.socket as TLSSocket;
    upgrades.push({
      authorized: tls.authorized,
      subject: String(tls.getPeerCertificate().subject?.CN ?? ''),
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => ws.send(Buffer.concat([Buffer.from('echo:'), raw as Buffer])));
    });
  });
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpsServer.address() as AddressInfo;
  return {
    // `localhost` is not in the server certificate: the host name is not checked.
    url: `wss://localhost:${port}/v1/terminal`,
    upgrades,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      httpsServer.closeAllConnections();
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    },
  };
}

beforeEach(async () => {
  ca = await mintHostCertificateAuthority({ name: 'Motir hoster CA (test)', now: NOW, days: 30 });
  client = await mintHostClientCertificate({ ca, name: 'motir-relay (test)', now: NOW });
  agent = await startHostAgent();
  dialTls = { caPem: ca.certPem, certPem: client.certPem, keyPem: client.keyPem };
  relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: async () => ({
      ok: true,
      target: {
        instanceId: 'inst-tls',
        userId: 'user-1',
        workspaceId: 'ws-1',
        channel: 'terminal',
        dial: {
          url: agent.url,
          headers: { authorization: 'Motir-Relay test' },
          ...(dialTls ? { tls: dialTls } : {}),
        },
      },
    }),
    openConnection: async () => 'conn-1',
    closeConnection: async () => {},
    touchActivity: async () => {},
    heartbeat: async () => {},
    log: () => {},
    reportError: () => {},
    now: () => Date.now(),
    authTimeoutMs: 1_000,
    dialTimeoutMs: 2_000,
    heartbeatIntervalMs: 60_000,
    pingIntervalMs: 60_000,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  relayUrl = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/terminal`;
});

afterEach(async () => {
  await relay.close();
  await agent.close();
});

/** A browser that authenticates and sends one frame; answers what came back or how it closed. */
async function browse(): Promise<{ echoed: string | null; closeCode: number | null }> {
  const ws = new WebSocket(relayUrl, { origin: ORIGIN });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ t: 'auth', ticket: 'ticket-1' }));
  return new Promise((resolve) => {
    const timer = setInterval(() => ws.send(Buffer.from('hi'), { binary: true }), 50);
    ws.on('message', (data) => {
      clearInterval(timer);
      ws.close();
      resolve({ echoed: Buffer.from(data as Buffer).toString('utf8'), closeCode: null });
    });
    ws.on('close', (code) => {
      clearInterval(timer);
      resolve({ echoed: null, closeCode: code });
    });
  });
}

describe('the relay dials a host agent over mutual TLS', () => {
  it('presents the Motir client certificate, trusts the CA, and ignores the host name', async () => {
    const result = await browse();
    expect(result.echoed).toBe('echo:hi');
    expect(agent.upgrades).toEqual([{ authorized: true, subject: 'motir-relay (test)' }]);
  });

  it('never reaches a server whose certificate another CA signed', async () => {
    const stranger = await mintHostCertificateAuthority({ name: 'stranger', now: NOW, days: 1 });
    dialTls = { caPem: stranger.certPem, certPem: client.certPem, keyPem: client.keyPem };
    const result = await browse();
    expect(result.closeCode).toBe(TERMINAL_CLOSE.unreachable);
    expect(agent.upgrades).toEqual([]);
  });

  it('is refused by the host agent without a CA-signed client certificate', async () => {
    const stranger = await mintHostCertificateAuthority({ name: 'stranger', now: NOW, days: 1 });
    const foreign = await mintHostClientCertificate({ ca: stranger, name: 'x', now: NOW });
    dialTls = { caPem: ca.certPem, certPem: foreign.certPem, keyPem: foreign.keyPem };
    const result = await browse();
    expect(result.closeCode).toBe(TERMINAL_CLOSE.unreachable);
    expect(agent.upgrades).toEqual([]);
  });
});
