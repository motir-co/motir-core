import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import {
  testInstructionsRepository,
  type TestInstructionsWithRepos,
} from '@/lib/repositories/testInstructionsRepository';
import { testInstructionsRepoRepository } from '@/lib/repositories/testInstructionsRepoRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import {
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { normalizeCommitSha } from '@/lib/git/commitSha';
import { authorOf } from '@/lib/howToTest/author';
import { userRepository } from '@/lib/repositories/userRepository';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import type {
  CurrentTestInstructionsDTO,
  HowToTestDraftDTO,
  PublishTestInstructionsResultDTO,
  TestInstructionsDTO,
} from '@/lib/dto/testInstructions';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
} from '@/lib/testInstructions/caps';
import {
  TestInstructionsCapExceededError,
  TestInstructionsConflictError,
  TestInstructionsInvalidFieldError,
  TestInstructionsRepoNotInProjectError,
  TestInstructionsWorkItemNotFoundError,
} from '@/lib/testInstructions/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * HOW TO TEST — business logic (Story MOTIR-4906 · Subtask MOTIR-5328;
 * `docs/decisions/approval-gates.md` §9 and its 2026-09-13 amendment).
 *
 * HOW TO TEST is per RUN. A run writes ONE record onto its RUN TARGET — the item
 * it was launched against — its content RICH TEXT (`bodyMd`, sections allowed,
 * commands in fenced code blocks) and one section per repository it touched. The target keeps exactly one CURRENT record (the newest
 * run's) and every earlier run's as history — the `design_evidence` shape. This
 * service is the only writer. It ends at a record that can be written and read;
 * the MCP door (MOTIR-5331), the read (MOTIR-5333) and the rendering (MOTIR-5336)
 * sit on top of it.
 */

/** One repository section of a publish. */
export interface PublishTestInstructionsRepoInput {
  /**
   * The repository, as EITHER the `GithubRepo` id (`repoId`) OR how a person
   * names it (`repoRef`: `name` or `owner/name`) — exactly one. Either way it
   * must be one of the item's project repositories.
   */
  repoId?: string | null;
  repoRef?: string | null;
  /** The head commit the run pushed to this repository. */
  commitSha: string;
}

export interface PublishTestInstructionsInput {
  /** The run target. */
  workItemId: string;
  /** The run's HOW TO TEST as rich text (Markdown). Stored as written, trimmed. */
  bodyMd: string;
  previewPath?: string | null;
  /**
   * One entry per repository the run pushed to. OPTIONAL since MOTIR-5689: a
   * PERSON writing from the form names no repository (they are derived from the
   * card's linked pull requests), so an absent or empty list is a legal record.
   * An AGENT should still send one per repository it pushed to — its record is
   * the evidence for a delivery set.
   */
  repos?: readonly PublishTestInstructionsRepoInput[];
  /**
   * Attribute the record to the newest RUNNING dispatch run targeting or
   * carrying this item (the MCP door sets it; MOTIR-5331). Never an id the
   * caller passes: an agent cannot know it, and must not be able to claim
   * another run's.
   */
  attributeToRunningDispatch?: boolean;
  /**
   * The RUN door's run (MOTIR-10877, `POST /api/v1/dispatch-runs/{id}/how-to-test`): the
   * record is attributed to THIS run, which must be running, opened by the caller, and hold
   * the item as an OPEN leg — all read under the run row's lock, in the publish's own
   * transaction. Set only by the server from a validated path; it wins over
   * {@link attributeToRunningDispatch}.
   */
  forRunId?: string;
}

/** One validated, normalised repository section (its repository not yet resolved). */
interface NormalizedRepoSection {
  repoId: string | null;
  repoRef: string | null;
  commitSha: string;
}

/** The validated, normalised content a record stores — also what "identical" compares. */
interface NormalizedContent {
  bodyMd: string;
  previewPath: string | null;
  repos: NormalizedRepoSection[];
}

// The commit-id pattern and its normalisation moved to `@/lib/git/commitSha`
// (MOTIR-5619) — this rule was the only one of the three publish paths that had
// it, and the acceptance-receipt path stored whatever it was handed. Defining it
// once is what stops the doors on one card refusing different things.

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertChars(field: string, value: string, cap: number): void {
  if (value.length > cap) throw new TestInstructionsCapExceededError(field, cap, 'characters');
}

/**
 * Validate and normalise a publish's content. Every bound is a typed refusal
 * naming the field — never a silent truncation (lib/testInstructions/caps.ts).
 * The body is NOT parsed: its sections and code blocks are the agent's, and the
 * one Markdown pipeline renders them.
 *
 * Exported so the rules are unit-testable without a database.
 */
export function normalizeTestInstructionsContent(
  input: PublishTestInstructionsInput,
): NormalizedContent {
  const bodyMd = (input.bodyMd ?? '').trim();
  if (!bodyMd) {
    throw new TestInstructionsInvalidFieldError(
      'bodyMd',
      'write How to test as Markdown — sections for the precondition, local setup and click-path, every command in a fenced code block.',
    );
  }
  if (Buffer.byteLength(bodyMd, 'utf8') > TEST_INSTRUCTIONS_MAX_BODY_BYTES) {
    throw new TestInstructionsCapExceededError('bodyMd', TEST_INSTRUCTIONS_MAX_BODY_BYTES, 'bytes');
  }

  // A PATH on the preview host, never a URL. A protocol-relative `//host` would
  // change the host once the read joins it onto the preview URL, so it is refused.
  const previewPath = blankToNull(input.previewPath);
  if (previewPath) {
    if (!previewPath.startsWith('/') || previewPath.startsWith('//')) {
      throw new TestInstructionsInvalidFieldError(
        'previewPath',
        'expected a path starting with a single "/", e.g. "/items/ACME-7".',
      );
    }
    assertChars('previewPath', previewPath, TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS);
  }

  // ⚠️ AN EMPTY SECTION LIST IS LEGAL (Subtask MOTIR-5689; `approval-gates.md`
  // §9's 2026-09-17 amendment, point 3). This used to refuse `repos: []` with
  // *at least one*, which was right while an agent was the only author: a run
  // knows what it pushed to. A PERSON's form has no repository control — the
  // repositories are DERIVED from the card's linked pull requests — so on a card
  // with nothing linked there is nothing to put here, and the refusal made the
  // form unsaveable for exactly the team the amendment protects: one that keeps
  // its pull requests on the host and its work items in Motir.
  //
  // Every other refusal below stands. They govern the entries that ARE given,
  // and an agent's contract is unchanged: the dispatch prompt still asks for one
  // entry per repository it pushed to, because its record is the evidence for a
  // delivery set.
  const rawRepos = input.repos ?? [];
  if (rawRepos.length > TEST_INSTRUCTIONS_MAX_REPOS) {
    throw new TestInstructionsCapExceededError('repos', TEST_INSTRUCTIONS_MAX_REPOS, 'items');
  }
  const repos = rawRepos.map((entry, r) => {
    const field = `repos[${r}]`;
    const sha = normalizeCommitSha(entry.commitSha);
    if (!sha.ok) {
      throw new TestInstructionsInvalidFieldError(`${field}.commitSha`, sha.reason);
    }
    const commitSha = sha.commitSha;
    const repoId = blankToNull(entry.repoId);
    const repoRef = blankToNull(entry.repoRef);
    if ((repoId === null) === (repoRef === null)) {
      throw new TestInstructionsInvalidFieldError(
        `${field}.repo`,
        'name exactly one repository — by id or by name.',
      );
    }
    return { repoId, repoRef, commitSha };
  });

  return { bodyMd, previewPath, repos };
}

/** A section once its repository is resolved to a project `GithubRepo` id. */
interface ResolvedRepoSection {
  repoId: string;
  commitSha: string;
}

/** Does a stored record carry exactly this content? (The idempotency comparison.) */
function sameContent(
  row: TestInstructionsWithRepos,
  content: NormalizedContent,
  repos: readonly ResolvedRepoSection[],
): boolean {
  const dto = toTestInstructionsDto(row);
  return (
    dto.bodyMd === content.bodyMd &&
    dto.previewPath === content.previewPath &&
    JSON.stringify(dto.repos) === JSON.stringify(repos)
  );
}

/**
 * Translate a lost one-current race into a typed error so a raw `P2002` never
 * escapes the service. Exported so the mapping is testable without a real race.
 */
export function translateTestInstructionsConflict(err: unknown, workItemId: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new TestInstructionsConflictError(workItemId);
  }
  return err;
}

/**
 * Resolve every section's repository to a `GithubRepo` id that is one of the
 * project's repositories, or refuse naming the valid set. A repository named
 * twice (by any spelling) is refused — a run has one section per repository.
 *
 * `repoRef` matches the realized repository's `name` or `owner/name`,
 * case-insensitively. A bare name shared by two repositories under different
 * owners is ambiguous and refused — the valid set in the message shows the
 * `owner/name` to use instead.
 */
async function resolveProjectRepoSections(
  projectId: string,
  sections: readonly NormalizedRepoSection[],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<ResolvedRepoSection[]> {
  const set = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
  const realized = set.flatMap((row) => (row.githubRepo ? [row.githubRepo] : []));
  const valid = realized.map((r) => `${r.owner}/${r.name}`);
  const seen = new Set<string>();

  return sections.map((section, index) => {
    let repoId: string;
    if (section.repoId !== null) {
      if (!realized.some((r) => r.id === section.repoId)) {
        throw new TestInstructionsRepoNotInProjectError(section.repoId, valid);
      }
      repoId = section.repoId;
    } else {
      const wanted = section.repoRef!.toLowerCase();
      const matches = realized.filter(
        (r) => `${r.owner}/${r.name}`.toLowerCase() === wanted || r.name.toLowerCase() === wanted,
      );
      if (matches.length !== 1)
        throw new TestInstructionsRepoNotInProjectError(section.repoRef!, valid);
      repoId = matches[0]!.id;
    }
    if (seen.has(repoId)) {
      throw new TestInstructionsInvalidFieldError(
        `repos[${index}].repo`,
        'this repository already has a section — give one entry per repository.',
      );
    }
    seen.add(repoId);
    return { repoId, commitSha: section.commitSha };
  });
}

/**
 * The run door's guard (MOTIR-10877): the run is the caller's own, still running, and holds
 * the item as an open leg. The run row is locked first, as every run write locks it. An
 * unknown run and another operator's answer the same 404; a card the run does not hold, or
 * whose leg has settled, is `UNKNOWN_DISPATCH_RUN_CARD`.
 */
async function assertOpenLegOfRun(
  runId: string,
  item: { id: string; identifier: string },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const run = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
  if (!run || run.createdById !== ctx.userId) throw new DispatchRunNotFoundError(runId);
  if (run.status !== 'running') throw new DispatchRunTerminalError(runId, run.status);
  const leg = await dispatchRunCardRepository.findByRunAndWorkItem(runId, item.id, tx);
  if (!leg || leg.endedAt !== null) throw new UnknownDispatchRunCardError(item.identifier);
}

export const testInstructionsService = {
  /**
   * Write a run's HOW TO TEST record onto its run target, making it the
   * target's current version.
   *
   * - Asserts `work_item:edit` on the ITEM's project (resolved from the item,
   *   never from the actor's active project — the MOTIR-2365 gate).
   * - Refuses a repository that is not one of that project's repositories, and a
   *   repository named twice.
   * - IDEMPOTENT PER RUN: when the target's current record was written by the
   *   same run (or both by none) with identical content, it is returned and
   *   nothing is written (an agent's retry). Different content from the same
   *   run, or any publish from another run, becomes the new current record and
   *   the previous one stays as history.
   *
   * ⚠️ CONCURRENCY. The write is read-derived — it reads what is current and
   * replaces it — and an agent retries on an unclear result, so two publishes
   * for one target WILL race. Locking the current `test_instructions` row (the
   * `design_evidence` precedent) is not enough: on a target's FIRST publish there
   * is no row to lock, both callers would insert, and one would hit the partial
   * unique index. So the transaction locks the WORK ITEM row, which always
   * exists, before reading; the second publish waits, then sees the first's
   * outcome. The index stays as the backstop, translated to a typed error.
   */
  async publish(
    input: PublishTestInstructionsInput,
    ctx: ServiceContext,
  ): Promise<PublishTestInstructionsResultDTO> {
    const content = normalizeTestInstructionsContent(input);

    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(input.workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(input.workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');

    try {
      return await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          const repos = await resolveProjectRepoSections(item.projectId, content.repos, ctx, tx);
          // The run door's run, locked FIRST — the order every run write takes (MOTIR-10877).
          if (input.forRunId !== undefined) {
            await assertOpenLegOfRun(input.forRunId, item, ctx, tx);
          }
          // Serialise every publish for this item BEFORE the read that decides.
          const locked = await workItemRepository.lockById(item.id, tx);
          if (!locked) throw new TestInstructionsWorkItemNotFoundError(input.workItemId);

          const dispatchRunId =
            input.forRunId ??
            (input.attributeToRunningDispatch
              ? await dispatchRunRepository.findLatestRunningIdForWorkItem(item.id, tx)
              : null);

          const current = await testInstructionsRepository.findCurrentForWorkItem(item.id, tx);
          if (
            current &&
            current.dispatchRunId === dispatchRunId &&
            sameContent(current, content, repos)
          ) {
            return { record: toTestInstructionsDto(current), created: false };
          }

          await testInstructionsRepository.clearCurrent(item.id, tx);
          const { id } = await testInstructionsRepository.insert(
            {
              workspaceId: ctx.workspaceId,
              projectId: item.projectId,
              workItemId: item.id,
              bodyMd: content.bodyMd,
              previewPath: content.previewPath,
              dispatchRunId,
              publishedById: ctx.userId,
              isCurrent: true,
            },
            tx,
          );
          await testInstructionsRepoRepository.createMany(
            repos.map((section, position) => ({
              workspaceId: ctx.workspaceId,
              projectId: item.projectId,
              testInstructionsId: id,
              repoId: section.repoId,
              commitSha: section.commitSha,
              position,
            })),
            tx,
          );
          const row = await testInstructionsRepository.findById(id, tx);
          return { record: toTestInstructionsDto(row!), created: true };
        },
      );
    } catch (err) {
      throw translateTestInstructionsConflict(err, input.workItemId);
    }
  },

  /**
   * The DRAFT a PERSON's How-to-test form opens on (Story MOTIR-5450 · Subtask
   * MOTIR-5453; `approval-gates.md` §9's 2026-09-17 amendment, point 2).
   *
   * `publish` above is already the one writer for both author kinds — a person
   * calls it with `attributeToRunningDispatch` left false, which is what records
   * `dispatchRunId: null` and `publishedById` the person. What a person is
   * missing is not a write path, it is a FILLED-IN FORM, and that is all this is.
   *
   * On **Edit** it returns the current record's body and preview path; on **Add**
   * there is no record, so it returns `''` and `null`.
   *
   * ⚠️ IT READS NO REPOSITORY DATA. The form has no repository control — a
   * repository enters a record by having its pull request LINKED
   * (`design-notes.md` §24, decisions 8 and 8b) — so there is no section list to
   * suggest and no project-repository set to offer. That is why this is ONE
   * query: an earlier shape walked the subtree, the deliveries with their check
   * rows and the project's repositories to fill a picker that no longer exists.
   *
   * Asserts **`work_item:edit`** rather than `project:browse`: the draft exists
   * only for somebody who may save it, and it is the permission `publish` and
   * the explicit pull-request link both assert.
   */
  async getDraftForWorkItem(workItemId: string, ctx: ServiceContext): Promise<HowToTestDraftDTO> {
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    const item = await withWorkspaceContext(binding, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');

    const current = await withWorkspaceContext(binding, (tx) =>
      testInstructionsRepository.findCurrentForWorkItem(item.id, tx),
    );
    if (!current) return { bodyMd: '', previewPath: null };

    const record = toTestInstructionsDto(current);
    return { bodyMd: record.bodyMd, previewPath: record.previewPath };
  },

  /**
   * The CURRENT record for a run target named by its KEY, with each section's
   * repository `owner/name` — the public read a CLI renders into a session pull
   * request body (MOTIR-5358). `record: null` when no run has written one.
   * Requires `project:browse` on the item's project.
   */
  async getCurrentByIdentifier(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<CurrentTestInstructionsDTO> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    // WITH its run (MOTIR-5454): this response names the AUTHOR, and a run is
    // named by the command and start time its row carries, not by its id.
    const row = await withWorkspaceContext(binding, (tx) =>
      testInstructionsRepository.findCurrentForWorkItemWithRun(item.id, tx),
    );
    if (!row) return { workItemKey: item.identifier, record: null };
    const record = toTestInstructionsDto(row);

    const [repos, publishers] = await Promise.all([
      withWorkspaceContext(binding, (tx) =>
        projectRepoRepository.listByProject(item.projectId, ctx.workspaceId, tx),
      ),
      row.publishedById !== null ? userRepository.findByIds([row.publishedById]) : [],
    ]);
    const nameOf = new Map(
      repos.flatMap((r) =>
        r.githubRepo ? [[r.githubRepo.id, `${r.githubRepo.owner}/${r.githubRepo.name}`]] : [],
      ),
    );
    return {
      workItemKey: item.identifier,
      record: {
        ...record,
        repos: record.repos.map((section) => ({
          ...section,
          repoName: nameOf.get(section.repoId) ?? null,
        })),
        author: authorOf(row, new Map(publishers.map((user) => [user.id, user.name] as const))),
      },
    };
  },

  /**
   * The CURRENT record for one run target (or null), for a reader holding
   * `project:browse` on the item's project.
   */
  async getCurrentForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<TestInstructionsDTO | null> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => testInstructionsRepository.findCurrentForWorkItem(item.id, tx),
    );
    return row ? toTestInstructionsDto(row) : null;
  },
};
