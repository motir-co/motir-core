// Which orchestrator adapter this deployment selected (`MOTIR_FLEET_ORCHESTRATOR`).
// Split out of `./index` so a caller that must not load the database (the hosting
// accessor in `./hosting`, and through it the operator deploy check) can read the
// same selector. Read at call time, never module load.
import type { OrchestratorProvider } from '@motir/orchestrator';

/** The selector's env var. Unset means `fly`, which is §1's decision; `fake` is
 *  what the test suites and MOTIR-1927's gate select. */
const SELECTOR_ENV = 'MOTIR_FLEET_ORCHESTRATOR';

/** Which adapter this deployment has selected, whether or not it is configured. */
export function selectedOrchestratorProvider(): OrchestratorProvider {
  const raw = process.env[SELECTOR_ENV]?.trim().toLowerCase();
  return raw === 'fake' ? 'fake' : 'fly';
}
