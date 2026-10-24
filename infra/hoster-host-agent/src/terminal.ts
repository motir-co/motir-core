import type { IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { CONTAINER_NAME } from './exec';

// `GET /v1/terminal` and `/v1/chat` (Story MOTIR-9361 · MOTIR-9480): the relay's
// WebSocket, carried byte for byte to the container's terminal server. The
// upgrade request is replayed to the terminal server as it arrived — the same
// path, the same `Motir-Relay` authorization header — so the terminal server
// answers the handshake itself and the frames are never parsed here. When
// either side closes or fails, the other is destroyed.

/** Where the terminal server listens — the seam a test points at a stub. */
export type TerminalTarget = () => Promise<{ host: string; port: number }>;

/** The paths the relay dials. */
export const TERMINAL_PATHS = new Set(['/v1/terminal', '/v1/chat']);

/**
 * The real target: the container's address on Docker's bridge network (the boot
 * script publishes no host port), and the terminal's internal port from the
 * config document. Read at every dial, because a wake starts a fresh container.
 */
export function containerTerminalTarget(internalPort: () => Promise<number>): TerminalTarget {
  return async () => {
    const host = await new Promise<string>((resolve, reject) => {
      execFile(
        'docker',
        [
          'inspect',
          '--format',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
          CONTAINER_NAME,
        ],
        { timeout: 5_000 },
        (err, stdout) => {
          const address = String(stdout).trim();
          if (err || !address) reject(new Error('container_unavailable'));
          else resolve(address);
        },
      );
    });
    return { host, port: await internalPort() };
  };
}

/** The upgrade request as the client sent it, ready to replay. */
function replayOf(req: IncomingMessage): string {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Carry one upgrade to the terminal server. Answers the status the log records:
 * 101 once the two sides are joined, 502 when the terminal server cannot be
 * reached (the client gets a plain 502 and the socket is closed).
 */
export async function proxyTerminal(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  target: TerminalTarget,
): Promise<number> {
  let upstream: Socket;
  try {
    const { host, port } = await target();
    upstream = await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host, port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return 502;
  }
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  upstream.write(replayOf(req));
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
  return 101;
}
