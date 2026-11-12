import { INIT_SUBJECT } from '@/lib/plans/validateProposedInitRepository';

// ── WHICH CARD IS AN INIT CARD (Story MOTIR-10162 · Subtask MOTIR-11054) ──────
//
// An init card creates a repository the project does not have yet. Two facts mark
// one, and they are ONE rule answered from two sides:
//
//   * its SUBJECT is the `init` member — the fact the work-item DTO carries, and so
//     the only one the dispatch prompt can see;
//   * its declared `initRepositoryName` is set — the fact that NAMES the repository,
//     deliberately absent from the DTO and from every shared projection, and so the
//     only one the completion (which matches a settled row against it) can see.
//
// Each half reads the fact it can reach; this module is the single home both ask,
// so the prompt and the completion cannot disagree about which cards this is.
//
// `INIT_SUBJECT` keeps its one definition beside the plan door's declaration rule
// and is re-exported here, so the discriminator has every name it needs in one
// import and no second spelling of the member exists.

export { INIT_SUBJECT };

/** The facts {@link isInitCard} reads — any subset may be present. */
export interface InitCardShape {
  subject?: string | null;
  initRepositoryName?: string | null;
}

/** True when the card's subject is {@link INIT_SUBJECT} OR it declares the repository
 *  it will create. */
export function isInitCard(shape: InitCardShape): boolean {
  return shape.subject === INIT_SUBJECT || !!shape.initRepositoryName;
}
