import 'server-only';

// THE GATEWAY-SATURATION READER SEAM (MOTIR-9675). The two numbers the series
// needs beside connections in use — created machines and the per-machine hard
// limit — are not in the gateway capacity read, and where they come from is an
// open decision (MOTIR-9679). Everything downstream (the judge, the alert, the
// screen) reads this one typed shape, so wiring a source later changes this file
// and nothing else.
//
// Until a source is wired the reader answers `not_configured`, which the screen
// shows as unavailable and the evaluation treats as no evidence either way.

export type GatewaySaturationReading =
  | {
      outcome: 'answered';
      /** Connections the gateway's machines hold open now; `null` when not read. */
      connectionsInUse: number | null;
      /** Machines created for the app, running or stopped; `null` when not read. */
      createdMachines: number | null;
      /** The per-machine Fly `hard_limit`; `null` when not read. */
      hardLimit: number | null;
    }
  | { outcome: 'unavailable'; reason: 'not_configured' | 'read_failed' };

export type GatewaySaturationReader = () => Promise<GatewaySaturationReading>;

const notConfigured: GatewaySaturationReader = async () => ({
  outcome: 'unavailable',
  reason: 'not_configured',
});

/** The reader in force. */
export function gatewaySaturationReader(): GatewaySaturationReader {
  return notConfigured;
}
