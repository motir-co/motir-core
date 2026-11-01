import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import {
  assembleDispatchPrompt,
  type ContinueFromForPrompt,
  type FindingsPolicy,
} from '@/lib/dispatch/promptTemplate';
import { ContinueFromInvalidError } from '@/lib/dispatchRuns/errors';
import { readHeldGateVerdict } from '@/lib/services/resumeStateService';
import {
  endedHow,
  resolveContinueBranch,
  runTimeoutReason,
} from '@/lib/services/workItemContinueService';
import type { DispatchPromptDto, DispatchRepoDto } from '@/lib/dto/dispatch';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { listDispatchRepoNames, resolveDispatchRepoForItem } from '@/lib/workItems/dispatchRepo';
import { resolveDispatchRepo } from '@/lib/workItems/targetRepo';
import type { RepoDelivery, RepoDeliveryState } from '@/lib/workItems/repoDelivery';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { designAccessService } from '@/lib/services/designAccessService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import type { DesignVerdictDto } from '@/lib/dto/designAccess';
import { readProject } from '@/lib/workspaces/tenantRead';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { toOrgContentLanguage } from '@/lib/workItems/contentLanguage';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { parseDecisionRecord } from '@/lib/approvalGates/decisionRecord';
import {
  obsolescenceNoteFirstLine,
  type ChangesRequestedForPrompt,
  type ConfirmedDecisionForPrompt,
  type ObsoleteNeighbour,
} from '@/lib/dispatch/promptTemplate';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { parseWorkItemKeys, parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { approvalGatesService } from '@/lib/services/approvalGatesService';

// The DISPATCH-PROMPT read (Story 7.9 · MOTIR-1802) — resolve everything the
// canonical prompt is assembled from, then hand it to the PURE assembler
// (`lib/dispatch/promptTemplate.ts`). This module is the only half that touches
// state; the grammar itself reads nothing, which is what keeps the prompt a pure
// function of server state (two calls for an unchanged item are byte-identical).
//
// It lives in its own service file rather than on `workItemsService` for the
// same reason `lib/workItems/targetRepo.ts` does: that service is already a
// 4000-line, coverage-gated module, and prompt assembly is a self-contained
// read with no write path, no transaction, and no shared state with it.
//
// Access: the item is resolved through `workItemsService.getWorkItemByIdentifier`,
// which enforces the workspace check AND the 6.4 browse gate and raises
// `WorkItemNotFoundError` either way — so an unknown key and another tenant's key
// are indistinguishable to the caller (no existence leak), exactly as every
// sibling read behaves.

/** The blockers of a work item, resolved to their `PROD-<n>` keys in ascending
 *  key order (deterministic — the prompt lists them verbatim). */
async function resolveBlockerKeys(workItemId: string, workspaceId: string): Promise<string[]> {
  // ONE bound transaction for the edge read and the batch it resolves: unbound,
  // both returned nothing and the dispatched prompt listed no blockers at all —
  // which is worse than an empty screen, because the agent then starts work
  // whose prerequisites are unbuilt.
  const rows = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const links = await workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by', tx);
    return workItemRepository.findByIds(
      links.map((l) => l.toId),
      tx,
    );
  });
  return rows
    .slice()
    .sort((a, b) => a.key - b.key)
    .map((r) => r.identifier);
}

/**
 * The MARKED neighbours of a work item (Story MOTIR-6576 · MOTIR-6657) — its
 * parent, its `is_blocked_by` blockers and the work items its `## Context refs`
 * name, kept only where they carry an obsolescence mark, each with the keys of
 * the work items that superseded it. The dispatched card itself is never among
 * them: only a finished card carries a mark (MOTIR-6575).
 *
 * BOUNDED, whatever the card names: one bound transaction and at most four reads
 * — the blocker edges (the SAME `is_blocked_by` edges `resolveBlockerKeys` reads,
 * so the two never disagree), the bare context-ref keys, the union of every
 * neighbour id, and the superseders of the marked ones.
 *
 * Context refs resolve INSIDE the card's own project: a `[label](motir:<id>)`
 * chip or a bare `<PROJECTKEY>-<n>` key naming another project's item, an
 * unknown key and a non-work-item ref (a path) all yield nothing. A work item
 * named twice keeps its FIRST role, in the order parent → blocker → context ref.
 */
async function resolveObsoleteNeighbours(
  item: { id: string; projectId: string; parentId: string | null; descriptionMd: string | null },
  projectIdentifier: string,
  workspaceId: string,
): Promise<ObsoleteNeighbour[]> {
  const refs = splitPlanBody(item.descriptionMd).contextRefs;
  // One ordered list of what the refs name, a chip's id or a bare key, in the
  // order the card names them.
  const named: Array<{ id: string } | { key: string }> = [];
  for (const ref of refs) {
    // A chip bullet reads back as its link TARGET (`motir:<id>`, MOTIR-9027 — a
    // chip's label and why are never the ref); a hand-written one may still carry
    // the whole `[KEY](motir:<id>)` token.
    const chipTarget = ref.match(/^motir:(\S+)$/)?.[1];
    if (chipTarget) named.push({ id: chipTarget });
    for (const id of parseWorkItemTokenIds(ref)) named.push({ id });
    for (const key of parseWorkItemKeys(ref, projectIdentifier)) named.push({ key });
  }

  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const blockerLinks = await workItemLinkRepository.findByFromItem(item.id, 'is_blocked_by', tx);
    const keys = [...new Set(named.flatMap((n) => ('key' in n ? [n.key] : [])))];
    const keyRows = await workItemRepository.findByIdentifiers(item.projectId, keys, tx);
    const idOfKey = new Map(keyRows.map((r) => [r.identifier, r.id]));

    const roles: Array<{ id: string; role: ObsoleteNeighbour['role'] }> = [];
    if (item.parentId) roles.push({ id: item.parentId, role: 'parent' });
    for (const link of blockerLinks) roles.push({ id: link.toId, role: 'blocker' });
    for (const n of named) {
      const id = 'id' in n ? n.id : idOfKey.get(n.key);
      if (id) roles.push({ id, role: 'context ref' });
    }

    const rows = await workItemRepository.findByIds([...new Set(roles.map((r) => r.id))], tx);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seen = new Set<string>([item.id]);
    const marked: Array<{ role: ObsoleteNeighbour['role']; row: (typeof rows)[number] }> = [];
    const blockers: typeof marked = [];
    for (const { id, role } of roles) {
      const row = byId.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      // A context ref resolves inside the card's own project only.
      if (role === 'context ref' && row.projectId !== item.projectId) continue;
      if (row.obsolescence === null) continue;
      // Blockers are listed in ascending key order, as the Depends-on line lists them.
      (role === 'blocker' ? blockers : marked).push({ role, row });
    }
    blockers.sort((a, b) => a.row.key - b.row.key);
    const parentFirst = marked.filter((m) => m.role === 'parent');
    const ordered = [...parentFirst, ...blockers, ...marked.filter((m) => m.role !== 'parent')];
    if (ordered.length === 0) return [];

    const superseders = await workItemLinkRepository.findSupersedersOf(
      ordered.map((m) => m.row.id),
      tx,
    );
    return ordered.map(({ role, row }) => ({
      role,
      key: row.identifier,
      title: row.title,
      mark: row.obsolescence as ObsoleteNeighbour['mark'],
      supersededByKeys: superseders
        .filter((s) => s.toId === row.id)
        .sort((a, b) => a.supersederKey - b.supersederKey)
        .map((s) => s.supersederIdentifier),
      noteFirstLine: obsolescenceNoteFirstLine(row.obsolescenceNoteMd),
    }));
  });
}

/**
 * The OPEN work items `blocked_by` this one, resolved to their `PROD-<n>` keys in
 * ascending key order (MOTIR-5495). The ids come from
 * `designEvidenceService.findWaitingDependentIds` — the SAME read the design-result
 * publish refuses on — so a design prompt carries the publish step exactly when
 * the server would accept the publish, and there is no second done-category rule.
 */
async function resolveOpenDependentKeys(
  workItemId: string,
  ctx: ServiceContext,
): Promise<string[]> {
  const ids = await designEvidenceService.findWaitingDependentIds(workItemId, ctx);
  if (ids.length === 0) return [];
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findByIds(ids, tx),
  );
  return rows
    .slice()
    .sort((a, b) => a.key - b.key)
    .map((r) => r.identifier);
}

/**
 * EVERY repository the item ships in, as the dispatch payload's ordered element
 * list (Story MOTIR-2731 · MOTIR-3131 · ADR § *Amendment 2026-08-19* §B1).
 *
 * Composed rather than derived a second time, which is the whole point:
 *
 * - the NAMES and the per-repository DELIVERY state come from
 *   `workItemsService.listRepoDelivery`, the shared classifier the completion
 *   gate and the item-detail panel already answer from (and which resolves the
 *   set through the item's REFERENCES, so a repository renamed on the host is
 *   named correctly here — `lib/workItems/expectedRepos.ts`);
 * - the COORDINATES come from `resolveDispatchRepo` against the project's
 *   domain, the same function that produced the scalar `targetRepo` pair.
 *
 * ⚠️ It therefore THROWS `ArchivedTargetRepoError` for an archived repository
 * ANYWHERE in the set, not only for the primary. A read-only repository can
 * accept no branch and no pull request, so a card carrying one is undispatchable
 * rather than degraded — and a non-primary archived repository is the worse of
 * the two, because the run otherwise appears to succeed while the completion
 * gate holds the card forever on work that can never merge.
 *
 * The `primary` argument is the resolved scalar. When the item carries no
 * repository of its own but the project has exactly one — `resolveDispatchRepo`'s
 * second rung — the set is that one repository with a `null` delivery state, so
 * `targetRepos[0]?.name ?? null === targetRepo` stays total.
 */
/**
 * A repository a CHILD card's own pull request delivered (MOTIR-8811) is
 * `delivered` on the wire. The distinction is the item panel's — it explains why
 * the item has no pull-request row of its own there — and what a dispatched run
 * needs is only that a merge reached that trunk. Keeping it off the `/api/v1`
 * enum also keeps every published CLI parsing the payload: its generated
 * validators reject an enum member they were not generated with.
 */
function toDispatchDelivery(state: RepoDeliveryState): DispatchRepoDto['delivery'] {
  return state === 'delivered_by_child' ? 'delivered' : state;
}

async function resolveDispatchRepos(
  delivery: readonly RepoDelivery[],
  projectId: string,
  primary: { name: string; cloneUrl: string | null; defaultBranch: string | null } | null,
  ctx: ServiceContext,
): Promise<DispatchRepoDto[]> {
  if (delivery.length === 0) {
    // No set of its own. Either Motir cannot say where this ships at all (`[]`),
    // or the project's single repository answered for it — carry that one so the
    // scalar stays a projection of this array.
    return primary === null ? [] : [{ ...primary, delivery: null }];
  }
  const domain = await listDispatchRepoNames(projectId, ctx);
  return delivery.map((d) => {
    // TOTAL for a non-null pin: `resolveDispatchRepo` returns the name it was
    // given, with whatever coordinates the domain knows (`null` where it knows
    // none). Its `null` return is the UNPINNED case, which cannot arise from a
    // name — so there is no fallback arm here to write, and writing one would be
    // an untestable branch pretending the contract is weaker than it is. It is
    // also the throw site for the archived refusal above.
    const resolved = resolveDispatchRepo(d.repo, domain)!;
    return {
      name: resolved.name,
      cloneUrl: resolved.cloneUrl,
      defaultBranch: resolved.defaultBranch,
      delivery: toDispatchDelivery(d.state),
    };
  });
}

export interface DispatchPromptOptions {
  /**
   * A session branch to fall back to when the item carries NO lineage of its own
   * — the `motir auto` seed (MOTIR-882).
   *
   * It is a FALLBACK, never an override. An item whose dependencies are already
   * integrated somewhere, or that is itself already integrated, keeps THAT
   * branch: a caller that could redirect a live lineage would strand an
   * integrated dependency chain across two branches, which is precisely what
   * {@link DispatchPromptDto.workflowMode} being server-chosen exists to prevent.
   *
   * What it DOES enable is the first item of an unattended run. `motir auto`
   * opens one session branch per repo and integrates every item onto it; without
   * a seed the run's first item — which by definition has no integrated
   * dependency yet — would be told to open a pull request of its own, breaking
   * the one-PR-per-run contract before the run had produced anything.
   */
  sessionBranch?: string | null;
  /**
   * What this run permits its agent to WRITE (MOTIR-3020) — bug filing and
   * re-plan submission, independently.
   *
   * ⚠️ IT HAS TO ARRIVE HERE, not stay in the client. The prompt is the entire
   * contract with a sandboxed agent: a flag the agent never reads changes
   * nothing about what it does. That is why this is a request parameter rather
   * than CLI-side behaviour (`docs/decisions/run-findings-protocol.md` Q1).
   *
   * OMITTED means the COMPLETE protocol — see
   * {@link import('@/lib/dispatch/promptTemplate').FULL_FINDINGS_POLICY}. This
   * service does not default it; the template does, so every caller of the
   * template gets the same answer for an absent policy.
   */
  findingsPolicy?: FindingsPolicy;
  /**
   * The id of a DEAD run of this item to CONTINUE (MOTIR-6531). When set, the
   * prompt carries the CONTINUE block and the continue git workflow, on the dead
   * run's branch. The run must hold a leg for this item (or be scoped to it) and
   * have ended without success, else `ContinueFromInvalidError` (422).
   */
  continueFrom?: string;
  /**
   * Whether the runner posts the `$MOTIR_AGENT_REPORT` findings (MOTIR-8810) — see
   * {@link import('@/lib/dispatch/promptTemplate').DispatchPromptSource.runnerPostsAgentReport}.
   * Passed through undefaulted, for the same reason as `findingsPolicy`.
   */
  runnerPostsAgentReport?: boolean;
  /**
   * Whether the runner also posts the agent's `decisions` (MOTIR-10000) — see
   * {@link import('@/lib/dispatch/promptTemplate').DispatchPromptSource.runnerPostsDecisions}.
   */
  runnerPostsDecisions?: boolean;
}

/**
 * Resolve `continueFrom` into what the template renders — the dead run, how it
 * ended, and where its work is, through the SAME branch resolution the continue
 * claim uses (`resolveContinueBranch`), so the claim and the prompt name one branch.
 */
async function resolveContinueFrom(
  runId: string,
  itemId: string,
  primaryRepo: string | null,
  ctx: ServiceContext,
): Promise<ContinueFromForPrompt> {
  return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const run = await dispatchRunRepository.findForWorkItemById(runId, itemId, tx);
    if (!run) throw new ContinueFromInvalidError(runId, 'unknown');
    if (run.status === 'running') throw new ContinueFromInvalidError(runId, 'still_running');
    // A run that STOPPED AT A GATE is resumed once a gate it stopped on is approved
    // (MOTIR-7708) — the continue claim's own reading of its held gates.
    const held =
      run.status === 'succeeded' && run.stopReason === 'gated'
        ? await readHeldGateVerdict(run.id, tx)
        : null;
    if (held?.verdict === 'awaiting') throw new ContinueFromInvalidError(runId, 'gate_awaiting');
    if (held?.verdict === 'sent_back') throw new ContinueFromInvalidError(runId, 'gate_sent_back');
    if (run.status === 'succeeded' && held === null) {
      throw new ContinueFromInvalidError(runId, 'succeeded');
    }
    const { branch, branches, pullRequest } = await resolveContinueBranch(
      itemId,
      run,
      tx,
      primaryRepo,
    );
    if (branch === null) throw new ContinueFromInvalidError(runId, 'unknown');
    return {
      deadRunId: run.id,
      endedHow: endedHow(run, await runTimeoutReason(run, tx)),
      lastHeardAt: (run.lastHeartbeatAt ?? run.endedAt ?? run.startedAt).toISOString(),
      dispatcherName: run.createdBy?.name ?? null,
      branch,
      // One entry per repository, primary first (MOTIR-6791). A one-repository
      // run's single entry leaves the prompt exactly as it was.
      branches: branches.map((b) => ({
        repository: b.repository,
        branch: b.branch,
        pullRequest: b.pullRequest
          ? { repo: b.pullRequest.repo, number: b.pullRequest.number, url: b.pullRequest.url }
          : null,
      })),
      pullRequest: pullRequest
        ? { repo: pullRequest.repo, number: pullRequest.number, url: pullRequest.url }
        : null,
      resume: held
        ? {
            approved: held.released.map((g) => ({ key: g.key, kind: g.kind })),
            changesRequested: held.changesRequested.map((g) => ({ key: g.key, kind: g.kind })),
            stillWaiting: [...held.waiting, ...held.sentBack].map((g) => ({
              key: g.key,
              kind: g.kind,
              state: g.state,
            })),
          }
        : null,
    };
  });
}

export const dispatchPromptService = {
  /**
   * Assemble the canonical dispatch prompt for ONE work item.
   *
   * Reads, in parallel where they are independent: the item (access-gated), its
   * parent, its `is_blocked_by` dependencies, its READINESS (for the inherited
   * session branch — the one thing that picks the GIT WORKFLOW variant), its
   * prose-vs-graph advisories (MOTIR-2079 — told to the agent, never acted on),
   * and the project's repo domain (for `targetRepo` + its coordinates). The repo resolves
   * through the SAME `resolveItemDispatchRepo` the ready dispatch payload uses
   * (MOTIR-1804 · MOTIR-1783), so the two dispatch surfaces can never route
   * differently — including the project → workspace scope ladder.
   *
   * Any work item can be asked for a prompt — not just a ready one. Readiness is
   * the CLI's concern (it dispatches from `claim_next_ready`); this is the
   * printable prompt for whatever key you name, which is what makes
   * `motir next --print <key>` and re-printing an in-progress item work.
   */
  async getDispatchPrompt(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    opts: DispatchPromptOptions = {},
  ): Promise<DispatchPromptDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    // A hosted run's own credential reads only its run's cards' prompts — checked
    // inside `getWorkItemByIdentifier` above (MOTIR-6557), before any read below.
    // Validated FIRST, before the fan-out: a continue that cannot happen is the
    // caller's to fix, and the answer must not wait on ten reads.
    const continueFrom = opts.continueFrom
      ? await resolveContinueFrom(opts.continueFrom, item.id, item.targetRepos[0] ?? null, ctx)
      : null;

    // ⚠️ `allSettledOrThrow`, NOT `Promise.all` (MOTIR-6235). The access gate
    // (`getWorkItemByIdentifier`) is awaited above, but one of these arms DOES
    // refuse: `resolveDispatchRepoForItem` returns `null` for an unresolvable
    // repo and THROWS `ArchivedTargetRepoError` for an archived one (MOTIR-1959).
    // MOTIR-3077 left this fan-out on `Promise.all` on the belief that it never
    // throws, so a refused prompt returned while up to ten sibling transactions
    // were still open — and the next test's `TRUNCATE` reset deadlocked against
    // them (`40P01`). `listRepoDelivery` classifies rather than refuses, and the
    // archived refusal over the whole SET is still raised AFTER this settles, in
    // `resolveDispatchRepos`.
    const [
      parentRow,
      blockerKeys,
      readiness,
      dispatchRepo,
      advisories,
      repoDelivery,
      runScope,
      openDependentKeys,
      designReference,
      confirmedDecisions,
      errorEvidence,
      ownRefusal,
      obsoleteNeighbours,
      contentLanguage,
    ] = await allSettledOrThrow([
      item.parentId
        ? withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
            workItemRepository.findById(item.parentId as string, tx),
          )
        : Promise.resolve(null),
      resolveBlockerKeys(item.id, ctx.workspaceId),
      workItemsService.getReadiness(item.id, ctx),
      resolveDispatchRepoForItem({ id: item.id, targetRepo: item.targetRepo, projectId }, ctx),
      // The prose-vs-graph advisories (MOTIR-2079) — a SIBLING of the reads
      // above, not a second pass, and deliberately independent of `readiness`:
      // nothing below consults it when deciding the workflow variant, so the
      // prompt an item gets is the same prompt whether or not it has one.
      buildDispatchProseAdvisories(item, ctx),
      // The per-repository DELIVERY state (MOTIR-3131) — a sixth peer read with
      // no refusal path of its own, and the source `targetRepos` is built from.
      // It resolves the set through the item's REFERENCES, so it is also what
      // makes the array survive a repository rename on the host.
      workItemsService.listRepoDelivery(item.id, item.targetRepos, ctx),
      // The RUN TARGET (MOTIR-5334): the scope of the running run that carries
      // this item, when there is one. It decides only WHO publishes How to test
      // — this agent on its own key, or the run's close-out on the scope — and
      // has no refusal path.
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        dispatchRunRepository.findRunningScopeForWorkItem(item.id, tx),
      ),
      // What waits on THIS item (MOTIR-5495) — read only for a design card, the
      // one type whose prompt branches on it; no refusal path.
      item.type === 'design'
        ? resolveOpenDependentKeys(item.id, ctx)
        : Promise.resolve([] as string[]),
      // The DESIGNS this card waits on (MOTIR-5563) — a peer read beside
      // `resolveBlockerKeys`, over the same `is_blocked_by` edges, so the
      // designs the prompt names and the blockers it lists can never disagree
      // about what this card is waiting for.
      //
      // ⚠️ NO REFUSAL PATH, deliberately. A design that could not be resolved
      // must never stop a card being dispatched: the prompt simply renders no
      // DESIGN REFERENCE, and the `code` steps' look-with-`list_designs`-first
      // instruction is what covers the gap. An empty array is also the ordinary
      // answer for the many cards that wait on no design at all.
      designAccessService
        .designsForWorkItem(item.identifier, ctx)
        .catch(() => [] as DesignVerdictDto[]),
      // The CONFIRMED DECISIONS on this card's epic (MOTIR-5959) — ONE statement,
      // however many the epic holds. Like the design read it has no refusal path:
      // a decision that could not be read never stops a dispatch.
      readConfirmedDecisions(item.id, ctx.workspaceId).catch(
        () => [] as ConfirmedDecisionForPrompt[],
      ),
      // The ERRORS linked to this card (Story MOTIR-5975 · MOTIR-5982) — the
      // SAME read the item page's Errors section and `get_work_item` make, over
      // Motir's store: no provider call, and no refusal path of its own (the
      // access gate above has already admitted the item). `[]` is the ordinary
      // answer and renders nothing.
      monitorIssueService.listForWorkItem(item.id, ctx),
      // The LATEST REFUSAL on this card (MOTIR-6422) — the reason its last attempt
      // was sent back, when the latest decided gate is `changes_requested`. No
      // refusal path: a refusal that could not be read never stops a dispatch.
      approvalGatesService.latestRefusalFor(item.id, ctx).catch(() => null),
      // The MARKED neighbours (MOTIR-6657) — the finished parent, blockers and
      // context refs that are no longer true of the code. No refusal path, like
      // the design read: a failure renders no obsolescence line and never stops
      // a dispatch.
      resolveObsoleteNeighbours(item, project.identifier, ctx.workspaceId).catch(
        () => [] as ObsoleteNeighbour[],
      ),
      // The organisation's CONTENT LANGUAGE (MOTIR-8745) — the language any work
      // item or to-do the agent writes is written in. No refusal path: a language
      // that could not be read never stops a dispatch; it falls back to the default.
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx),
      )
        .then(toOrgContentLanguage)
        .catch((): Locale => defaultLocale),
    ]);

    // …and its RUN TARGET's, when this card is a leg of a run launched against
    // another item — a story sent back at acceptance (MOTIR-6071) is re-run through
    // its members' prompts. Read after the fan-out because it needs `runScope`.
    const targetRefusal =
      runScope && runScope.id !== item.id
        ? await approvalGatesService.latestRefusalFor(runScope.id, ctx).catch(() => null)
        : null;
    const changesRequested: ChangesRequestedForPrompt[] = [];
    if (ownRefusal) changesRequested.push({ ...ownRefusal, key: item.identifier });
    if (targetRefusal && runScope) {
      changesRequested.push({ ...targetRefusal, key: runScope.identifier });
    }

    const targetRepo = dispatchRepo?.name ?? null;
    const targetRepos = await resolveDispatchRepos(repoDelivery, projectId, dispatchRepo, ctx);
    const assembled = assembleDispatchPrompt({
      key: item.identifier,
      title: item.title,
      kind: item.kind,
      type: item.type,
      executor: item.executor,
      difficulty: item.difficulty,
      priority: item.priority,
      storyPoints: item.storyPoints,
      estimateMinutes: item.estimateMinutes,
      descriptionMd: item.descriptionMd,
      blockerKeys,
      openDependentKeys,
      advisories,
      designReference,
      confirmedDecisions,
      errorEvidence,
      changesRequested,
      obsoleteNeighbours,
      contentLanguage,
      continueFrom,
      parent: parentRow ? { key: parentRow.identifier, title: parentRow.title } : null,
      projectName: project.name,
      projectKey: project.identifier,
      targetRepo,
      // The SET the multi-repository GIT WORKFLOW is rendered from (MOTIR-3132)
      // — the same resolution the payload publishes, never a second one. Fewer
      // than two elements renders exactly today's text.
      targetRepos: targetRepos.map((repo) => ({
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      })),
      // The lineage this item inherits from its integrated dependencies
      // (`getReadiness` is the single source — it ignores a terminal blocker's
      // stale branch and collapses the one integrated lineage). An item that was
      // ITSELF already integrated falls back to its OWN recorded branch, so
      // re-printing its prompt keeps it on the lineage it already lives on
      // rather than sending it back to `origin/main`. Only when BOTH are absent
      // does the caller's seed apply (see {@link DispatchPromptOptions}) — real
      // lineage always wins, so a seed can never redirect one.
      sessionBranch:
        readiness.inheritedSessionBranch ?? item.sessionBranch ?? opts.sessionBranch ?? null,
      runTargetKey: runScope?.identifier ?? null,
      // Passed through UNDEFAULTED. `undefined` is the template's own signal for
      // "the full protocol", so defaulting it here would put a second copy of
      // that decision in a second place.
      ...(opts.findingsPolicy ? { findingsPolicy: opts.findingsPolicy } : {}),
      ...(opts.runnerPostsAgentReport === undefined
        ? {}
        : { runnerPostsAgentReport: opts.runnerPostsAgentReport }),
      ...(opts.runnerPostsDecisions === undefined
        ? {}
        : { runnerPostsDecisions: opts.runnerPostsDecisions }),
    });

    return {
      key: item.identifier,
      prompt: assembled.prompt,
      // The same row the prompt's `- Parent:` line is rendered from — read once,
      // used twice (MOTIR-2445). Promoting it costs no query.
      parentKey: parentRow?.identifier ?? null,
      targetRepo,
      // The same coordinates the ready dispatch payload carries (MOTIR-1783) —
      // present with a null value whenever Motir cannot say, so a CLI reading
      // either surface handles one shape.
      targetRepoCloneUrl: dispatchRepo?.cloneUrl ?? null,
      targetRepoDefaultBranch: dispatchRepo?.defaultBranch ?? null,
      // The WHOLE set, ordered with the primary first — of which the three
      // scalars above are the projection (MOTIR-3131).
      targetRepos,
      workflowMode: assembled.workflowMode,
      sessionBranch: assembled.sessionBranch,
      workBranch: assembled.workBranch,
      branch: assembled.branch,
      // Handed over SEPARATELY as well as rendered into the prompt: the prompt
      // reaches the agent, this reaches the human watching the CLI. Always an
      // array, never omitted.
      advisories,
    };
  },
};

/**
 * The epic's CONFIRMED decisions as the prompt renders them (MOTIR-5959) — oldest
 * confirmation first, each reduced to the two sections a run acts on. The body is
 * re-read through the ONE parser; a body edited after its confirmation still gives
 * up its sections from the draft, so a decision is never dropped for an edit.
 */
async function readConfirmedDecisions(
  workItemId: string,
  workspaceId: string,
): Promise<ConfirmedDecisionForPrompt[]> {
  const [rows, pageRows] = await withWorkspaceServiceContext(workspaceId, (tx) =>
    Promise.all([
      approvalGateRepository.findConfirmedDecisionsUnderEpicOf(workItemId, tx),
      approvalGateRepository.findApprovedPageDecisionsUnderEpicOf(workItemId, tx),
    ]),
  );
  const confirmed: ConfirmedDecisionForPrompt[] = rows.map((row) => {
    const parse = parseDecisionRecord(row.descriptionMd);
    const sections = parse.ok ? parse : parse.draft;
    return {
      key: row.identifier,
      title: row.title,
      decidedAt: row.decidedAt.toISOString(),
      decisionMd: sections.decisionMd,
      resultingDirectionMd: sections.resultingDirectionMd,
    };
  });
  // AGENT decisions approved over a PAGE (MOTIR-7438) join the SAME ordered feed, by
  // the date a person decided them — one block, one calendar rule.
  if (pageRows.length === 0) return confirmed;
  const pages: ConfirmedDecisionForPrompt[] = pageRows.map((row) => ({
    key: row.identifier,
    title: row.title,
    decidedAt: row.decidedAt.toISOString(),
    decisionMd: '',
    resultingDirectionMd: '',
    page: { pageId: row.pageId, versionNumber: row.versionNumber },
  }));
  return [...confirmed, ...pages].sort(
    (a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.key.localeCompare(b.key),
  );
}
