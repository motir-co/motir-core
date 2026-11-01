// The guard's process entry (MOTIR-9947): read the configuration, refuse to
// start without it, listen on 9180 on every interface (Fly's proxy reaches the
// Machine over IPv6), and close cleanly on SIGTERM so a Machine update drains.
import { GUARD_PORT, GuardConfigError, createGuardServer, readGuardConfig } from './guard.ts';

function start(): void {
  let config;
  try {
    config = readGuardConfig(process.env);
  } catch (err) {
    if (!(err instanceof GuardConfigError)) throw err;
    process.stderr.write(`[motir-hosting-guard] ${err.message}\n`);
    process.exit(1);
  }
  const server = createGuardServer(config);
  // No host: Node binds `::` (dual stack) where IPv6 exists, else 0.0.0.0.
  server.listen(GUARD_PORT, () => {
    process.stdout.write(
      `[motir-hosting-guard] listening on ${GUARD_PORT}, forwarding to 127.0.0.1:${config.appPort}\n`,
    );
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

start();
