import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';

// WHY THIS STARTER (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §1.2) — the
// sentence and the facts a not-yet-created row shows about the starter it will
// be created from. PURE and client-safe: the room's row renders it, a test pins
// it, and neither re-derives the matching (MOTIR-709 recorded HOW the starter was
// chosen on the row as `seedMatch`; this only explains that record).
//
// ⚠️ A DEFAULT IS NEVER DRESSED AS A MATCH. Only `matched` reads as a match; each
// other `seedMatch` names what the matching lacked, and a row a person re-pointed
// (`seedMatch` null) says so instead of borrowing a match's sentence.

/** Which of design §1.2's sentences the row reads. */
export type SeedWhyKind =
  /** Matched on target, use and size (or on target alone when the row names no use). */
  | 'matched'
  /** The closest starter for the target; it does not serve the row's use. */
  | 'soft_use'
  /** The closest starter for the target; it serves the use but not the size. */
  | 'soft_size'
  /** A role Motir hosting does not deploy: the role's own starter, no hosting shown. */
  | 'not_deployed'
  | 'no_stack_signal'
  | 'no_target'
  | 'no_match'
  /** Chosen by a person, not by the matching. */
  | 'by_hand';

export type SeedFactName = 'hosting' | 'use' | 'size' | 'stack';

/** `hit` takes a check, `miss` a dash, `none` a dash on a value the row lacks. */
export type SeedFactState = 'hit' | 'miss' | 'none';

export interface SeedFact {
  name: SeedFactName;
  state: SeedFactState;
  /** The row's value (a target, use case or size id, or the stack), or null. */
  value: string | null;
  /** Why a `miss` missed: a soft criterion the starter does not serve, or a
   *  target no starter of the row's role deploys to. */
  note?: 'not_served' | 'no_role_starter';
  /** What a `none` reads as: "Not set", "Not named" or "None". */
  empty?: 'not_set' | 'not_named' | 'none';
}

export interface SeedWhy {
  kind: SeedWhyKind;
  facts: SeedFact[];
}

type WhyRow = Pick<
  ProjectRepoDto,
  'role' | 'seedMatch' | 'hostingTarget' | 'hostingUseCase' | 'hostingSize'
>;
type WhyEntry = Pick<
  SeedRegistryEntryDto,
  'key' | 'stack' | 'useCases' | 'sizes' | 'hostingTargets'
>;

/** The role the hosting port deploys (decision MOTIR-706 v2 §3.5). */
const DEPLOYED_ROLE = 'web';

/** The sentence and facts for a row and the entry its seed names. */
export function seedWhy(row: WhyRow, entry: WhyEntry): SeedWhy {
  const kind = whyKind(row, entry);
  const facts = [
    hostingFact(row, entry, kind),
    servedUseFact(row, entry),
    servedSizeFact(row, entry),
  ];
  if (kind === 'matched' && row.seedMatch === 'matched') {
    facts.push({ name: 'stack', state: 'hit', value: entry.stack });
  }
  if (kind === 'no_stack_signal') {
    facts.push({ name: 'stack', state: 'none', value: null, empty: 'not_named' });
  }
  return { kind, facts };
}

function whyKind(row: WhyRow, entry: WhyEntry): SeedWhyKind {
  if (row.seedMatch === null) return 'by_hand';
  if (row.seedMatch === 'no_target') return 'no_target';
  if (row.seedMatch === 'no_match' || entry.key === SEED_SOURCE_INITIALISED) return 'no_match';
  // A role the hosting port does not deploy has no target to name, so the
  // no-stack sentence ("…the usual starter for a web repository on {target}")
  // cannot be said of it: it reads as that role's own starter.
  if (row.role !== DEPLOYED_ROLE && row.hostingTarget === null) return 'not_deployed';
  if (row.seedMatch === 'no_stack_signal') return 'no_stack_signal';
  if (row.hostingUseCase !== null && !entry.useCases.includes(row.hostingUseCase)) {
    return 'soft_use';
  }
  if (row.hostingSize !== null && !entry.sizes.includes(row.hostingSize)) return 'soft_size';
  return 'matched';
}

function hostingFact(row: WhyRow, entry: WhyEntry, kind: SeedWhyKind): SeedFact {
  const target = row.hostingTarget;
  if (target === null) {
    return {
      name: 'hosting',
      state: 'none',
      value: null,
      empty: row.role === DEPLOYED_ROLE ? 'not_set' : 'none',
    };
  }
  if (entry.hostingTargets.includes(target))
    return { name: 'hosting', state: 'hit', value: target };
  return {
    name: 'hosting',
    state: 'miss',
    value: target,
    ...(kind === 'no_match' ? { note: 'no_role_starter' as const } : {}),
  };
}

function servedUseFact(row: WhyRow, entry: WhyEntry): SeedFact {
  return softFact('use', row.hostingUseCase, entry.useCases);
}

function servedSizeFact(row: WhyRow, entry: WhyEntry): SeedFact {
  return softFact('size', row.hostingSize, entry.sizes);
}

function softFact(name: 'use' | 'size', value: string | null, served: readonly string[]): SeedFact {
  if (value === null) return { name, state: 'none', value: null, empty: 'not_set' };
  if (served.includes(value)) return { name, state: 'hit', value };
  return { name, state: 'miss', value, note: 'not_served' };
}
