import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanStatusWrites, statusWriteKey, type StatusWriteSite } from './statusWriteScan';

// The STATUS-WRITE guard (Story MOTIR-4777 · MOTIR-4780).
//
// `work_item.completedAt` is written in ONE place — `applyStatusTransition` —
// and a status write that reaches the column by any other route leaves the row
// in a done-category status with a null stamp, silently and for ever. The
// scanner beside this file enumerates every such route; this file is where a
// human rules on each one.
//
// Division of labour, the one `tests/rls/call-site-guard.test.ts` established:
// the machine enumerates, a human adjudicates, and a site nobody has ruled on
// fails the build by name. That shape is what makes the guard survive the thing
// it is protecting against — nobody adding a write is thinking about a column
// they have never read.

/** Why a status write outside `applyStatusTransition` is acceptable — or is not. */
type Verdict =
  /**
   * THE SEAM ITSELF. `applyStatusTransition` is the locked, tenant-gated,
   * access-gated funnel every status change goes through, and the stamp lives
   * in the same `update` as the status. Exactly one site may carry this.
   */
  | 'the-seam'
  /**
   * NOT A STATUS WRITE. The scanner reported the call because it could not
   * follow the patch — a parameter, a spread — and a read of the site shows it
   * never puts a `status` in. The reason names what it DOES write, so the next
   * reader re-checks rather than trusting this line.
   */
  | 'not-a-status-write'
  /**
   * A REAL status write that CANNOT cross the done-category boundary, so no
   * stamp is owed. The reason must say WHY it cannot — a category, not a key
   * literal, and not "the current code happens not to".
   */
  | 'never-terminal'
  /**
   * A REAL status write that CAN cross the boundary and CARRIES THE STAMP
   * ITSELF. The reason names where. Only ever a workflow-ADMIN operation that
   * deliberately walks no legal edges, which is why it cannot simply call the
   * seam.
   */
  | 'stamps-itself'
  /**
   * THE REPOSITORY DOOR. `workItemRepository.update` is the leaf every service
   * write lands on; it takes an opaque patch and is the wrong layer to know
   * about lifecycle. Ruling on it here rather than exempting the file is what
   * keeps a SECOND raw door visible.
   */
  | 'repository-leaf';

/**
 * One entry per (FILE, FUNCTION, door) triple. Keyed on the function rather
 * than the file so a new status write in `workItemsService.ts` cannot inherit
 * the ruling that clears `applyStatusTransition`.
 */
const STATUS_WRITE_VERDICTS: Record<string, readonly [Verdict, string]> = {
  'lib/services/workItemsService.ts#applyStatusTransition#workItemRepository.update': [
    'the-seam',
    'the stamp is built into this same `update`, inside the same $transaction and under the same lockById as the status',
  ],
  'lib/services/workItemsService.ts#recordImplementationProvenance#workItemRepository.update': [
    'not-a-status-write',
    'writes implementationSource / Harness / Model only; reported because the two conditional spreads are unfollowable, not because a status is in them',
  ],
  'lib/services/workItemsService.ts#fileWorkItem#workItemRepository.update': [
    'not-a-status-write',
    "writes `planFolderFiling`'s placement patch only — `folderId`, `parentId: null` and `position`; reported because the patch is a variable the scanner cannot follow, not because a status is in it",
  ],
  'lib/services/workItemsService.ts#updateWorkItem#workItemRepository.update': [
    'not-a-status-write',
    "the language-only write (MOTIR-8096): when a patch re-states unchanged text with an explicit language, `recordEditedLanguages`' result — `titleLanguage` / `descriptionLanguage` / `explanationLanguage` only — is stored on its own; reported because that patch is a function result the scanner cannot follow. The edit's main `update` (which can carry no status either) is followed and not reported",
  ],
  'lib/repositories/workItemRepository.ts#update#workItem.update': [
    'repository-leaf',
    'the door itself — an opaque `patch` parameter; lifecycle belongs to the service layer, and every caller of it is adjudicated above',
  ],
  'lib/services/plansService.ts#materialize#workItemRepository.update': [
    'never-terminal',
    "writes the project's own `blocked` status, resolved by category — `blocked` is category `todo`, so this write cannot enter or leave the done category; the row is also freshly created and carries no stamp to clear",
  ],
  // ⚠️ `applyModify` IS GONE FROM THIS LIST, and its absence is the point
  // (MOTIR-5646). It carried a `never-terminal` verdict for MOTIR-5359's
  // RE-SCOPE RESET, which put a status into the modify's patch. That reset is
  // REMOVED: `applyModify` now writes content only, so the scanner no longer
  // reports it at all, and a verdict naming a site that does not exist is what
  // the second case in this file fails on. The status it used to write is
  // `restPlanTargets`' below.
  'lib/services/plansService.ts#restPlanTargets#workItemRepository.update': [
    'never-terminal',
    "THE RESTING STATUS (MOTIR-5646, AMENDMENT 16 D6) — a target its plan parked goes to the project's own `blocked` or `todo`, both resolved from the project's status list and both asserted `todo`-CATEGORY before the write, so this can neither enter nor leave the done category and no `completedAt` stamp is ever owed. It writes only when the row is still at `planning`, which the same plan put there, and the legality of `planning → <target>` is read from the project's graph first",
  ],
  'lib/services/plansService.ts#writePlanDecidedStatus#workItemRepository.update': [
    'never-terminal',
    "THE RE-SCOPE MOVE (MOTIR-10102, AMENDMENT 28) — an approved `modify`'s target goes to the status `modifyTargetStatusFor` decided: its own prior status when that claims built work (in-progress CATEGORY, never done), or the project's `todo` / `blocked` / `in_progress`. The write resolves the target from the project's status list and refuses a done-CATEGORY one before it writes, so it can neither enter nor leave the done category and no `completedAt` stamp is ever owed",
  ],
  'lib/services/workflowsService.ts#deleteStatus#workItemRepository.update': [
    'stamps-itself',
    'the status-DELETION reassign — a workflow-admin bulk move that walks no legal edges, so it cannot call the seam; it compares the deleted and target CATEGORIES and stamps or clears `completedAt` in the same patch',
  ],
};

const SITES = scanStatusWrites();

function keysOf(sites: readonly StatusWriteSite[]): string[] {
  return [...new Set(sites.map(statusWriteKey))].sort();
}

describe('status writes outside applyStatusTransition are adjudicated', () => {
  it('finds the seam itself — a scan that returns nothing is a broken scan, not a clean tree', () => {
    // The vacuous-pass trap: a scanner whose predicate silently stops matching
    // reports zero sites and reads exactly like a repository with no problem.
    // The seam is the one site guaranteed to exist, so its presence is what
    // proves the scan ran.
    const seam = SITES.filter(
      (s) => s.file === 'lib/services/workItemsService.ts' && s.fn === 'applyStatusTransition',
    );
    expect(seam).toHaveLength(1);
  });

  it('every status-write site has a verdict', () => {
    const unruled = keysOf(SITES).filter((k) => !(k in STATUS_WRITE_VERDICTS));
    expect(
      unruled,
      [
        'A status write reached `work_item.status` from a site nobody has ruled on.',
        '',
        'This is the guard doing its job, not a broken test. `work_item.completedAt`',
        'is stamped ONLY in `workItemsService.applyStatusTransition`, so a write that',
        'reaches the column another way leaves the row in a done-category status with',
        'a null stamp — invisible to the Workbench Recently-finished tab and to every',
        'cycle-time figure, silently and for ever.',
        '',
        'Route the write through `applyStatusTransition` if it is a lifecycle move.',
        'If it genuinely cannot (a workflow-admin bulk operation that must walk no',
        'legal edges), carry the stamp in the same patch and add a `stamps-itself`',
        'verdict below saying where. If the write cannot cross the done-category',
        'boundary at all, say WHY by category — never by a status key literal.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('every verdict names a site that still exists', () => {
    // A verdict left behind after its call site moved or went away is a claim
    // about the tree that nothing re-checks, and it is also what would let a
    // future site inherit a ruling written about something else.
    const live = new Set(keysOf(SITES));
    const stale = Object.keys(STATUS_WRITE_VERDICTS).filter((k) => !live.has(k));
    expect(stale, 'remove the verdict — its call site is gone').toEqual([]);
  });

  it('exactly one site is the seam', () => {
    const seams = Object.entries(STATUS_WRITE_VERDICTS).filter(([, [v]]) => v === 'the-seam');
    expect(seams.map(([k]) => k)).toEqual([
      'lib/services/workItemsService.ts#applyStatusTransition#workItemRepository.update',
    ]);
  });

  it('every verdict carries a reason', () => {
    const empty = Object.entries(STATUS_WRITE_VERDICTS)
      .filter(([, [, reason]]) => reason.trim().length < 20)
      .map(([k]) => k);
    expect(empty, 'a verdict without a real reason is an exemption, not an adjudication').toEqual(
      [],
    );
  });
});

describe('the scanner itself', () => {
  // A CONTROL over a synthetic tree, driving the SAME exported function the
  // guard above drives. Re-implementing the predicate here would prove the
  // control works rather than that the predicate does — the reasoning
  // `tests/hosting/abandonedPathGuard.ts` is split out for.
  it('reports a literal status write, resolves a patch variable, and clears one that has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'status-write-scan-'));
    try {
      mkdirSync(join(root, 'lib', 'services'), { recursive: true });
      writeFileSync(
        join(root, 'lib', 'services', 'fixtureService.ts'),
        [
          'export const fixtureService = {',
          '  async writesLiteral(tx: unknown) {',
          "    await workItemRepository.update('id', { status: 'done' }, tx);",
          '  },',
          '  async writesViaVariable(tx: unknown) {',
          '    const update: Record<string, unknown> = {};',
          "    update.status = 'done';",
          "    await workItemRepository.update('id', update, tx);",
          '  },',
          '  async writesSomethingElse(tx: unknown) {',
          '    const update: Record<string, unknown> = { assigneeId: null };',
          '    update.priority = 1;',
          "    await workItemRepository.update('id', update, tx);",
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      const found = scanStatusWrites(root);
      expect(keysOf(found)).toEqual([
        'lib/services/fixtureService.ts#writesLiteral#workItemRepository.update',
        'lib/services/fixtureService.ts#writesViaVariable#workItemRepository.update',
      ]);
      expect(found.find((s) => s.fn === 'writesLiteral')?.form).toBe('literal');
      expect(found.find((s) => s.fn === 'writesViaVariable')?.form).toBe('unresolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the enclosing METHOD, not the callback the write sits in', () => {
    // Almost every service write in this tree sits inside
    // `withWorkspaceContext(ctx, async (tx) => { … })`, so the innermost
    // function is anonymous and keying on it would file real call sites under
    // `<anonymous>` — which is a key that collides with every other one in the
    // file.
    const root = mkdtempSync(join(tmpdir(), 'status-write-scan-'));
    try {
      mkdirSync(join(root, 'lib', 'services'), { recursive: true });
      writeFileSync(
        join(root, 'lib', 'services', 'fixtureService.ts'),
        [
          'export const fixtureService = {',
          '  async inACallback(ctx: unknown) {',
          '    await withWorkspaceContext(ctx, async (tx) => {',
          "      await workItemRepository.update('id', { status: 'done' }, tx);",
          '    });',
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      expect(keysOf(scanStatusWrites(root))).toEqual([
        'lib/services/fixtureService.ts#inACallback#workItemRepository.update',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reaches the raw Prisma door as well as the repository one', () => {
    const root = mkdtempSync(join(tmpdir(), 'status-write-scan-'));
    try {
      mkdirSync(join(root, 'lib', 'repositories'), { recursive: true });
      writeFileSync(
        join(root, 'lib', 'repositories', 'fixtureRepository.ts'),
        [
          'export const fixtureRepository = {',
          '  async raw(tx: any) {',
          "    return tx.workItem.updateMany({ where: { id: 'x' }, data: { status: 'done' } });",
          '  },',
          '  async rawOther(tx: any) {',
          "    return tx.workItem.update({ where: { id: 'x' }, data: { assigneeId: null } });",
          '  },',
          '};',
        ].join('\n'),
        'utf8',
      );

      expect(keysOf(scanStatusWrites(root))).toEqual([
        'lib/repositories/fixtureRepository.ts#raw#workItem.updateMany',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
