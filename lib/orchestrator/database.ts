// The composition root of the DATABASE PORT (MOTIR-9971). A module of its own,
// beside `./hosting` and for the same reason: it loads no database, so the
// operator deploy check can run it from a laptop with only the provider tokens
// set. `./index` re-exports everything here.
import {
  createFakeDatabasePort,
  OrchestratorNotConfiguredError,
  type DatabasePort,
  type DatabaseProvider,
} from '@motir/orchestrator';
import { selectedOrchestratorProvider } from './provider';

// ── The DATABASE PORT (Story MOTIR-9793 · MOTIR-9971) ───────────────────────
//
// One port for an application's own database. The fake while
// `MOTIR_FLEET_ORCHESTRATOR=fake`, so a suite that selects the fake gets every
// fake; otherwise the adapter registered for the provider, so the Neon adapter
// lands as one file and one `registerDatabaseAdapter` call.

/** Builds a provider's adapter, at call time. */
export type DatabaseAdapterFactory = () => DatabasePort;

const databaseAdapters = new Map<DatabaseProvider, DatabaseAdapterFactory>();
const databaseFakes = new Map<DatabaseProvider, DatabasePort>();

/** Register (or replace) the adapter for a provider. */
export function registerDatabaseAdapter(
  provider: DatabaseProvider,
  factory: DatabaseAdapterFactory,
): void {
  databaseAdapters.set(provider, factory);
}

/** Forget a registration — for tests. */
export function unregisterDatabaseAdapter(provider: DatabaseProvider): void {
  databaseAdapters.delete(provider);
}

/** The database port for a provider, or the typed not-configured error. The
 *  fake is one per process, so a suite sees one store. */
export function getDatabasePort(provider: DatabaseProvider = 'neon'): DatabasePort {
  if (selectedOrchestratorProvider() === 'fake') {
    let fake = databaseFakes.get(provider);
    if (!fake) {
      fake = createFakeDatabasePort({ provider });
      databaseFakes.set(provider, fake);
    }
    return fake;
  }
  const registered = databaseAdapters.get(provider);
  if (registered) return registered();
  throw new OrchestratorNotConfiguredError(`no ${provider} database adapter is registered`);
}

/** Drop the fakes — for tests. */
export function resetDatabaseFakes(): void {
  databaseFakes.clear();
}
