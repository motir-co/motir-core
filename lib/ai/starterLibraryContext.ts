import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { seedRegistryService } from '@/lib/services/seedRegistryService';

// ── The STARTER LIBRARY a planner is handed (Story MOTIR-10162 · MOTIR-11041) ──
//
// The ONE function both of motir-core's planning hand-offs call — the planning
// job envelope (`context.starterLibrary`, for the hosted planner) and the
// project-state read (`ProjectStateDto.starterLibrary`, for the runbook planner)
// — so the two can never drift into two different libraries.
//
// The rule, stated once:
//
//   * ACTIVE entries only. `resolveForEstablish` refuses a retired entry, so a
//     planner that named one would produce a plan that cannot be established.
//   * The WHOLE `SeedRegistryEntryDto`, never re-shaped. Its coverage is its own
//     fields (key, label, role, stack, template source, use cases, sizes, hosting
//     targets); a narrowed second DTO would be a second place to keep in step
//     with the registry.
//   * `[]` means THE REGISTRY HOLDS NO ACTIVE ENTRY — an answer, never "nobody
//     looked". That is why the envelope carries it as its own context field,
//     always sent, and not inside the repository unit, which is omitted outright
//     for a project that records no repositories: the very case a repository has
//     to be created.
//
// Read at request time, so an entry retired between two calls is gone from the
// second.

/**
 * The envelope key the library rides under, as a constant rather than a literal at
 * each call site: motir-ai spells the same string in its own repository and no
 * shared type binds the two, so the call-site guard
 * (`planningSubmitCarriesStarterLibrary.test.ts`) looks for THIS name.
 */
export const STARTER_LIBRARY_CONTEXT_FIELD = 'starterLibrary';

export async function resolveStarterLibraryContext(): Promise<SeedRegistryEntryDto[]> {
  return seedRegistryService.listActiveEntries();
}
