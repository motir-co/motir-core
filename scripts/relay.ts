/**
 * THE TERMINAL RELAY'S ENTRYPOINT (Story MOTIR-6861 · MOTIR-6940,
 * `docs/decisions/agent-terminal.md` Q1).
 *
 * What the `motir-relay` Fly app runs (`fly.relay.toml`: `node relay/relay.mjs`).
 * It is motir-core's SAME image — the relay is a separate app, not a process
 * group, because an app routes by port and 443 already belongs to motir-core's
 * web tier (Q1's rejected alternatives).
 *
 * It does four things: initialise monitoring, build the relay over the real
 * services, listen, and drain on SIGTERM (a deploy drops only the transport —
 * the shell and its replay live on the agent, Q5 — and every open connection's
 * row is closed `relay_shutdown` first). Before it listens it closes, `relay_lost`,
 * any row its own machine left open when it was last killed, and while it runs it
 * refreshes its open rows' `lastSeenAt` once a minute (MOTIR-6959).
 *
 * ⚠️ IT IS BUNDLED, NOT RUN FROM SOURCE — `pnpm build:relay` esbuilds this file
 * into `.relay/relay.mjs`, which the Dockerfile stages at `/app/relay/`, for the
 * reason `scripts/worker.ts`'s header gives: the runtime image is a Next
 * standalone output and `lib/` is not in it.
 *
 * Environment: DATABASE_URL, MOTIR_TERMINAL_MASTER_KEY, MOTIR_BASE_URL (the one
 * Origin a browser may connect from), SENTRY_DSN, PORT (default 8080), and Fly's own
 * FLY_MACHINE_ID (which relay holds a row; hostname+pid off Fly). It holds
 * NO Fly token: it never starts, stops or execs a machine.
 */
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { terminalMasterKey } from '@/lib/agentInstances/terminal';
import { createTerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import { relayMachineId } from '@/lib/agentTerminal/relay/machineId';
import { relaySentryInitOptions, scrubbedError } from '@/lib/agentTerminal/relay/monitoring';
import { startEventLoopDelayPublisher } from '@/lib/monitoring/cloudwatchMetrics';
import { startWatchdogMetricsPublisher } from '@/lib/monitoring/watchdogMetrics';
import { agentTerminalRelayService } from '@/lib/services/agentTerminalRelayService';
import { agentInstanceActivityService } from '@/lib/services/agentInstanceActivityService';

/**
 * FIRST, so an exception while starting is reported. The same options builder as
 * every Node runtime, plus the relay's `beforeBreadcrumb` that drops console
 * breadcrumbs (Q8). No DSN → no init at all (the self-host contract).
 */
function initMonitoring(): void {
  const options = relaySentryInitOptions();
  if (!options) return;
  Sentry.init(options);
  console.info(`[relay] error monitoring on (environment: ${options.environment ?? 'unset'})`);
}

async function main(): Promise<void> {
  initMonitoring();
  // Event-loop delay as CloudWatch metrics when MONITORING_CLOUDWATCH_NAMESPACE
  // is set (MOTIR-9881); nothing at all otherwise.
  startEventLoopDelayPublisher();
  // Each ended loop block's length, and CPU steal when MONITORING_CLOUDWATCH_STEAL
  // is on (MOTIR-9882).
  startWatchdogMetricsPublisher();
  // Refuse to start without the master key: every connection would need it, and
  // a relay that accepts sockets it can never authenticate reads as an outage of
  // the agents rather than of its own configuration. (A short key throws here.)
  if (!terminalMasterKey()) {
    throw new Error('MOTIR_TERMINAL_MASTER_KEY is not set — the relay cannot sign a relay token');
  }
  const allowedOrigin = new URL(resolveBaseUrl()).origin;
  const machineId = relayMachineId();

  // A relay killed without shutting down (OOM, a host failure, `fly machine
  // kill`) left its rows open; on the same machine, close them now. A failure
  // here is reported, not fatal: the sweep closes them anyway.
  try {
    const { closed } = await agentTerminalRelayService.closeOwnLeftovers(machineId);
    if (closed > 0) console.info(`[relay] closed ${closed} connection(s) a previous run left open`);
  } catch (err) {
    console.error('[relay] closing leftover connections failed');
    Sentry.captureException(scrubbedError('relay: closing leftover connections failed', err));
  }

  const relay = createTerminalRelay({
    allowedOrigin,
    authorize: (ticket, channel) => agentTerminalRelayService.authorizeConnection(ticket, channel),
    openConnection: (input) =>
      agentTerminalRelayService.openConnection({ ...input, relayMachineId: machineId }),
    closeConnection: (input) => agentTerminalRelayService.closeConnection(input),
    touchActivity: (instanceId) => agentInstanceActivityService.touchActivity(instanceId),
    heartbeat: async (connections) => {
      await agentTerminalRelayService.heartbeatConnections({
        relayMachineId: machineId,
        connections,
      });
    },
    log: (line) => console.info(line),
    reportError: (err) => {
      console.error(`[relay] ${err.message}`);
      Sentry.captureException(err);
    },
    now: () => Date.now(),
  });

  const port = Number(process.env['PORT'] ?? 8080);
  relay.server.listen(port, '0.0.0.0', () => {
    console.info(`[relay] listening on :${port} (origin ${allowedOrigin}, machine ${machineId})`);
  });

  let draining = false;
  const drain = (signal: string) => {
    if (draining) return;
    draining = true;
    console.info(`[relay] ${signal} — closing ${relay.liveConnections} connection(s)`);
    void (async () => {
      await relay.close();
      await Sentry.flush(2_000).catch(() => false);
      await db.$disconnect();
      console.info('[relay] drained; exiting');
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[relay] failed to start', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
