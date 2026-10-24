import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnRunner } from './exec';
import { createServer } from './server';
import { containerTerminalTarget } from './terminal';

// The host agent's entry point (Story MOTIR-9361 · MOTIR-9480): read the TLS
// files and the config document the boot script writes, and listen on 8443.
// The paths are the contract's defaults (`docs/decisions/aws-hoster-host-agent.md`
// §1); each can be moved with an environment value for a test or an image that
// lays them out differently. No value read here is ever logged.

export const HOST_AGENT_PORT = 8443;
export const DEFAULT_TLS_DIR = '/etc/motir/host-agent';
export const DEFAULT_CONFIG_FILE = '/etc/motir/instance.json';

/** The terminal server's internal port, from the config document — read at
 *  every dial, because an update rewrites the document and restarts the machine. */
export async function terminalPortFrom(configFile: string): Promise<number> {
  const document = JSON.parse(await readFile(configFile, 'utf8')) as {
    terminal?: { service?: { internalPort?: unknown } } | null;
  };
  const port = document.terminal?.service?.internalPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('no_terminal');
  }
  return port;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const tlsDir = env['MOTIR_HOST_AGENT_TLS_DIR'] || DEFAULT_TLS_DIR;
  const configFile = env['MOTIR_INSTANCE_CONFIG'] || DEFAULT_CONFIG_FILE;
  const port = Number(env['MOTIR_HOST_AGENT_PORT'] || HOST_AGENT_PORT);
  const [certPem, keyPem, caPem] = await Promise.all(
    ['server.crt', 'server.key', 'ca.crt'].map((name) => readFile(join(tlsDir, name), 'utf8')),
  );
  const server = createServer({
    tls: { certPem: certPem!, keyPem: keyPem!, caPem: caPem! },
    runInContainer: spawnRunner(),
    terminalTarget: containerTerminalTarget(() => terminalPortFrom(configFile)),
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  process.stdout.write(`${JSON.stringify({ listening: port })}\n`);
}
