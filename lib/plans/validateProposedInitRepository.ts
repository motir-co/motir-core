// ── An INIT card's declared repository, at the append (MOTIR-11051) ───────────
//
// A plan that needs a repository the project does not have yet lays ONE card
// whose subject is the `init` member, ahead of the cards that ship in that
// repository (Story MOTIR-10162). That card cannot name the repository through
// the PIN axis: a pin is resolved against the project's repository set at
// approve (`resolveProposedTargetRepos`), and a name the set does not hold is a
// `PlanItemUnknownTargetRepoError` — the very reason the init card was laid.
// A pinned init card would also be dispatched into a checkout that does not
// exist, and owe a merged pull request in a repository it has not created.
//
// So the name travels on its own carrier, `initRepositoryName`, the way
// `subject` does: settled at the append, shape-checked only, resolved against
// NOTHING, stored on the proposal and written onto the work item at approve.
//
// This module is the carrier's ONE rule. PURE: no read, no context. A refusal is
// an `InvalidProposalError` (422, `INVALID_PROPOSAL`), the family every other
// proposal-content refusal uses — NOT a `PlanGrammarError` reason, because the
// approve gate can never re-derive it: the value is reachable by no correction
// door (`mergeProposedFields` does not carry it, `UpdateProposalInput` has no
// member for it), so a re-check at the close or at approve would be unreachable.
//
// What it deliberately does NOT do: resolve the name (a declaration naming a
// repository the project already holds is accepted), count declarations (one
// init card per repository is the lay rule's), normalise case (every consumer
// compares case-insensitively), or re-implement the git host's character set
// (the creation door reports the host's own refusal).

import { InvalidProposalError } from '@/lib/plans/errors';

/** The subject member an init card carries — the rule pack
 *  `prompts/plan-rules/subject-init.md` in the corpus. */
export const INIT_SUBJECT = 'init';

/** The proposal fields this rule reads. A structural subset of
 *  `PlanItemProposedFields`, so a hand-built proposal can drive it. */
export interface InitRepositoryFields {
  subject?: string | null;
  initRepositoryName?: string | null;
  targetRepo?: string | null;
  targetRepos?: readonly string[] | null;
  targetRepositories?: readonly string[] | null;
  targetRepositoryRef?: string | null;
  targetRepoRole?: string | null;
}

/** The pin axis's five spellings, in the order a refusal names them. */
const PIN_KEYS = [
  'targetRepo',
  'targetRepos',
  'targetRepositories',
  'targetRepositoryRef',
  'targetRepoRole',
] as const satisfies readonly (keyof InitRepositoryFields)[];

/** Whether one pin spelling carries a pin. `undefined`, `null` and an empty
 *  list pin nothing — they are how the axis says "no repository". */
function carriesPin(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Refuse an `initRepositoryName` the append must not store. Absent (`undefined`)
 * or `null` is not a declaration and passes untouched.
 *
 * Three refusals, each naming the field, the value and the fix:
 * 1. the proposal's subject is not the `init` member;
 * 2. the proposal also carries a repository pin (any of five spellings);
 * 3. the name is not a bare repository name — blank, containing whitespace, or
 *    containing a `/` (an `owner/name` form would match no repository).
 */
export function assertProposedInitRepository(fields: InitRepositoryFields, label: string): void {
  const name = fields.initRepositoryName;
  if (name === undefined || name === null) return;

  if (fields.subject !== INIT_SUBJECT) {
    const actual = fields.subject == null ? 'no subject' : `subject \`${fields.subject}\``;
    throw new InvalidProposalError(
      `Proposal ${label} declares \`initRepositoryName\` \`${name}\` but carries ${actual}. ` +
        `Only a card whose subject is the \`${INIT_SUBJECT}\` member may declare the repository it will create — ` +
        `set \`subject: '${INIT_SUBJECT}'\`, or drop \`initRepositoryName\`.`,
    );
  }

  const pinned = PIN_KEYS.filter((key) => carriesPin(fields[key]));
  if (pinned.length > 0) {
    throw new InvalidProposalError(
      `Proposal ${label} declares \`initRepositoryName\` \`${name}\` and also pins a repository through ` +
        `${pinned.map((k) => `\`${k}\``).join(', ')}. An init card creates its repository and ships in none, ` +
        `so it carries no pin — drop ${pinned.length === 1 ? 'the pin' : 'the pins'} and keep the declaration.`,
    );
  }

  if (typeof name !== 'string' || name.trim() === '' || /\s/.test(name) || name.includes('/')) {
    throw new InvalidProposalError(
      `Proposal ${label} declares \`initRepositoryName\` \`${String(name)}\`, which is not a bare repository name. ` +
        `Send the bare name of the repository the card will create — no owner, no \`/\`, no whitespace (e.g. \`motir-infra\`).`,
    );
  }
}
