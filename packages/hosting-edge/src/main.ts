// The edge forwarder's process entry (MOTIR-10127): read the configuration,
// refuse to start without it, listen on 8080 on every interface (Fly's proxy
// reaches the Machine over IPv6), and close cleanly on SIGTERM so a Machine
// update drains.
import { EDGE_PORT, EdgeConfigError, readEdgeConfig } from './config.ts';
import { createEdgeServer } from './server.ts';

function start(): void {
  let config;
  try {
    config = readEdgeConfig(process.env);
  } catch (err) {
    if (!(err instanceof EdgeConfigError)) throw err;
    process.stderr.write(`[motir-hosting-edge] ${err.message}\n`);
    process.exit(1);
  }
  const server = createEdgeServer(config, { fetch: globalThis.fetch });
  // No host: Node binds `::` (dual stack) where IPv6 exists, else 0.0.0.0.
  server.listen(EDGE_PORT, () => {
    process.stdout.write(
      `[motir-hosting-edge] listening on ${EDGE_PORT}, resolving hosts at ${config.baseUrl}\n`,
    );
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

start();
