import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withdrawPullRequestApprovalGateOnSetChange } from './pullRequestApprovalGates';
import { recomputeWorkItemCiState } from './deliveryVerdict';
import { recomputeWorkItemFixReason } from './fixReasonService';
import { refreshLinkCheckForPullRequest } from './pullRequestLinkCheckService';
import { resyncLinkedPullRequest } from './changeRequestStatusSync';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoSetService } from './projectRepoSetService';
import { toLinkedPullRequestDto, toPullRequestLinkCandidateDto } from '@/lib/mappers/githubMappers';
import {
  GithubNotConnectedError,
  GithubPullRequestNotFoundError,
  GithubRepoNotFoundError,
} from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type {
  DeliveredWorkItemDto,
  LinkedPullRequestDto,
  PullRequestDeliveriesDto,
  PullRequestLinkCandidateDto,
  PullRequestNotLinkedReason,
} from '@/lib/dto/github';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { captureDecisionDocument } from './decisionDocumentCaptureService';

// Explicit item→PR link (Story 7.10 · MOTIR-1596, design/github Panel 5) — once
// the MANUAL override of the MOTIR-892 auto-resolver, and since MOTIR-3674
// deleted that resolver simply THE way a pull request reaches a card from this
// surface. Two operations back the detail-page "+ Link pull request" affordance:
//   * searchLinkCandidates — the query-driven picker's server search over the
//     ORGANISATION's ingested PRs (installation → repo → PR), annotating any PR
//     already delivering another item (the takeover chip). Organisation, not
//     workspace, since MOTIR-5152: a repository is connected once to the org
//     (MOTIR-4669), so every workspace of that org links pull requests on it.
//   * linkPullRequest — write the `work_item_delivery` row (a re-link/takeover is
//     allowed, no confirm). It used to stamp `linkedManually` alongside, to keep
//     the link sticky against the webhook resolver; there is no resolver to be
//     sticky against and MOTIR-4894 removed the stamp.
// 4-layer: this owns the workspace validation + the one transaction and returns
// DTOs; the Server Action is transport-only.

/** Picker candidate cap — a bounded, keystroke-driven read (mirrors the issue
 *  link picker's quick-search window). */
const PR_CANDIDATE_LIMIT = 10;

/**
 * THE key every door that writes or removes a `work_item_delivery` row asserts —
 * the item page's two arms ({@link githubPullRequestService.linkPullRequest} /
 * `unlinkPullRequest`) and the MCP tools' two (`…ByCoordinates`) alike. Declaring
 * which card a pull request delivers is editing that card. One constant so the
 * arms cannot drift apart again: until MOTIR-6318 only the MCP arms asserted it,
 * and the item page's actions — the door a PERSON uses — asserted nothing, so a
 * browse-only actor could link or unlink by calling the action directly.
 * `TOOL_PERMISSIONS` declares the same key for both tools, pinned by
 * `tests/github/prLinkPermission.test.ts`.
 */
export const PULL_REQUEST_LINK_PERMISSION = 'work_item:edit' satisfies PermissionKey;

// ⚠️ `retireDesignGateForOpenPullRequest` STOOD HERE AND IS RETIRED (Story
// MOTIR-5652 · Subtask MOTIR-5662; `docs/decisions/design-result.md` AMENDMENT 6
// Q1 and Q7, reversing AMENDMENT 4 Q8 / MOTIR-5534). Linking an OPEN pull request
// superseded an awaiting `design_result` gate, on the reasoning that the card's
// approve-to-merge gate now carried the design decision. **A link is evidence the
// design gate is ABOUT, not an answer to it** — and the merge gate it deferred to
// then refused on the run target, leaving the card with no question at all.
//
// Both of its call sites go with it. Nothing replaces them: a link changes the
// DELIVERY set, which `withdrawPullRequestApprovalGateOnSetChange` already
// handles, and the design question is untouched by it.

export const githubPullRequestService = {
  /**
   * Candidate PRs for the explicit-link picker, server-searched by `query`
   * (title / repo owner+name / number) — the detail-page Combobox fetches this
   * per debounced keystroke. Gates the current item to the caller's workspace
   * (cross-workspace / missing → 404). Throws {@link GithubNotConnectedError}
   * when the workspace has no connected or created REPO (the disconnected
   * banner) — asked of the repo rows, not of the installation (MOTIR-1931): a
   * project whose repos Motir CREATED has no installation of its own, and
   * asking the old question would have made this picker permanently
   * "not connected" for it. An
   * empty/short query returns `[]` (the picker prompts "type to search").
   *
   * ⚠️ THE SELF-EXCLUSION IS A **CONTAINS** TEST, over the DELIVERY SET
   * (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §3). It used to
   * be `row.workItemId !== currentItemId` — scalar inequality against the one item
   * the FK named — which dropped a candidate only when the current item happened to
   * be the item that column pointed at. A pull request DELIVERING the current item
   * alongside three others named at most one of them, so the picker offered the
   * page's own pull request back to it as a fresh candidate. The question is
   * unchanged in words and now true in fact: *does this pull request already
   * deliver me?*
   *
   * It is deliberately the same predicate as the subsumption advisory's
   * (`proseGraphAdvisoryService`), and the two are written to agree: both ask
   * whether an id is IN a delivery set, neither asks whether a set is exactly one
   * id.
   *
   * A candidate that survives carries `linkedTo` — every card it already delivers,
   * oldest link first. The chip the picker renders from it is INFORMATION rather
   * than a takeover warning: picking a candidate ADDS a delivery row.
   */
  async searchLinkCandidates(
    currentItemId: string,
    query: string,
    ctx: ServiceContext,
  ): Promise<PullRequestLinkCandidateDto[]> {
    // ⚠️ TWO TIERS IN ONE TRANSACTION, and NOTHING BINDS `app.organization_id`.
    // The org read arms resolve the organisation from the bound WORKSPACE
    // (`app_caller_organization_id()`), which is what the migration adding them
    // was written for — `withWorkspaceContext` binds no org GUC. Binding one
    // would buy nothing and would drag this transaction's workspace-keyed reads
    // (`work_item`, `work_item_delivery`) into the swept population of
    // `tests/rls/org-context-arm-guard.test.ts`, where the honest verdict is
    // that they are not org-spanning at all. Measured under `motir_app` in
    // `tests/github/prLinkOrganisationTenancy.test.ts`.
    //
    // The ITEM gate stays WORKSPACE-scoped — `work_item` has no org read arm and
    // must not get one here, so a cross-workspace id still reads as absent. The
    // REPOSITORY read is ORGANISATION-scoped, because a repository is connected
    // once to the org (Story MOTIR-4669) and any of its workspaces may link a
    // pull request on it. Asking the workspace returned zero rows in every
    // workspace but the one the App was installed from, and the zero became
    // `GithubNotConnectedError` — the picker reporting a disconnected
    // organisation that was connected, on a page whose org-tier sibling was
    // listing those very repositories.
    const { connected, organizationId } = await withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(currentItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(currentItemId);
      // Trusted resolution off the workspace ROW, never request input.
      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
      return {
        connected: await githubRepoRepository.listByOrganization(organizationId, tx),
        organizationId,
      };
    });
    if (connected.length === 0) throw new GithubNotConnectedError();

    if (query.trim().length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
    // ONE transaction for both reads: the delivery table's only tenant gate is an
    // RLS policy on `app.workspace_id`, so a read outside the bound context comes
    // back EMPTY rather than raising — every candidate would then look unlinked.
    // ⚠️ AND NOTHING BINDS `app.organization_id` — see the note on the gate
    // above. The candidates come back across the organisation anyway, while the
    // chip's identifiers stay scoped to this workspace, which is exactly the
    // pair of answers the picker wants.
    const { rows, deliveredBy } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const found = await githubPullRequestRepository.searchCandidates(
        organizationId,
        query,
        PR_CANDIDATE_LIMIT,
        tx,
      );
      // ONE batched read for all ten candidates, not one per row.
      const deliveries = await workItemDeliveryRepository.listByPullRequests(
        found.map((row) => row.id),
        tx,
      );
      const byPr = new Map<string, string[]>();
      for (const d of deliveries) {
        const ids = byPr.get(d.githubPullRequestId);
        if (ids) ids.push(d.workItemId);
        else byPr.set(d.githubPullRequestId, [d.workItemId]);
      }
      // Identifiers are resolved separately and TOLERANTLY, the same shape
      // `resolveDeliveredWorkItems` uses: a delivery whose target this tenant
      // context cannot see must shorten the chip's count, never fabricate an
      // item. The `Map` preserves the read's (pull request, link age) order.
      const targets = await workItemRepository.findByIds(
        [...new Set(deliveries.map((d) => d.workItemId))],
        tx,
      );
      const identifierById = new Map(targets.map((t) => [t.id, t.identifier]));
      return { rows: found, deliveredBy: { byPr, identifierById } };
    });

    return rows
      .filter((row) => !(deliveredBy.byPr.get(row.id) ?? []).includes(currentItemId))
      .map((row) =>
        toPullRequestLinkCandidateDto(
          row,
          (deliveredBy.byPr.get(row.id) ?? []).flatMap((id) => {
            const identifier = deliveredBy.identifierById.get(id);
            return identifier ? [identifier] : [];
          }),
        ),
      );
  },

  /**
   * Link an ingested PR to the current item — the explicit declaration, written
   * as a `work_item_delivery` row and nowhere else. Gates the current item AND
   * the PR to the caller's workspace in ONE transaction (a cross-workspace or
   * unknown PR → {@link GithubPullRequestNotFoundError}, no existence leak). A
   * re-link (takeover from another item) is allowed with no confirm — and it ADDS
   * a delivery rather than moving one, since MOTIR-3757 dropped the scalar that
   * could only name one item. Returns the linked-row DTO for the caller to
   * reflect optimistically; the mirror row is UNCHANGED by a link, so that DTO is
   * built from the row this method already read.
   */
  async linkPullRequest(
    currentItemId: string,
    pullRequestId: string,
    ctx: ServiceContext,
  ): Promise<LinkedPullRequestDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(currentItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(currentItemId);
      // The key the MCP arm asserts, on the project that owns the item. Only
      // resolvable once the item is read, so it runs here rather than before the
      // transaction as `linkPullRequestByCoordinates`' does — still ahead of
      // every write (MOTIR-6318).
      await projectAccessService.assertPermission(
        item.projectId,
        ctx,
        PULL_REQUEST_LINK_PERMISSION,
        tx,
      );

      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);

      const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      // The REPO row is the tenant (MOTIR-1931), not its installation — and the
      // TIER is the ORGANISATION (MOTIR-4649), not the workspace, since
      // MOTIR-5152. This gate read `pr.repo.workspaceId !== ctx.workspaceId`,
      // which is the tier a repository is connected FROM; in any other workspace
      // of the same organisation it refused a pull request the picker had just
      // OFFERED. Widening `searchLinkCandidates` without widening this one
      // would have shipped exactly that: a list whose every row answers "that
      // pull request could not be found" when you click it. The item gate above
      // stays workspace-scoped — the CARD is the workspace's, the REPOSITORY is
      // the organisation's, and that asymmetry is the model rather than an
      // oversight.
      if (!pr || pr.repo.organizationId !== organizationId)
        throw new GithubPullRequestNotFoundError(pullRequestId);

      // ⚠️ NO WRITE TO THE MIRROR ROW AT ALL (MOTIR-4894). A stamp used to go
      // here — `markLinkedManually`, the DECLARED-not-inferred flag — and it was
      // already writing for its own sake once MOTIR-3757 took away the FK it
      // qualified. It is gone, so a link now touches exactly one table, and `pr`
      // (read above, with its repo and check rows) IS the row the DTO is built
      // from: nothing between that read and here changes it.
      // THE LINK (Story MOTIR-3655 · MOTIR-3658, ADR
      // `docs/decisions/work-item-delivery-links.md`), and since MOTIR-3757 the
      // ONLY one: a pull request's association with a work item is a row in this
      // table and lives nowhere else.
      //
      // It is a SET, which is the shape the retired column could never express:
      // a re-link ADDS rather than moving, because one pull request delivering
      // several cards is a real thing (a `motir auto` run is exactly it). Taking
      // an association back is `unlinkPullRequest`, not a side effect of linking
      // somewhere else.
      // Read BEFORE the idempotent add, so a re-link — which changes nothing — withdraws
      // nothing either (MOTIR-5482).
      const alreadyDelivered = (
        await workItemDeliveryRepository.listByPullRequest(pullRequestId, tx)
      ).some((row) => row.workItemId === currentItemId);
      await workItemDeliveryRepository.add(
        {
          workspaceId: ctx.workspaceId,
          workItemId: currentItemId,
          githubPullRequestId: pullRequestId,
          repoId: pr.repoId,
        },
        tx,
      );
      // The project now ships from this repository, so its set records it
      // (MOTIR-11040) — in this transaction, beside the delivery row, because it
      // is a local insert rather than a host call: a link and its record commit
      // together or not at all. It never refuses; its outcome is not this door's.
      await projectRepoSetService.adoptConnectedRepo(
        {
          projectId: item.projectId,
          workspaceId: ctx.workspaceId,
          githubRepoId: pr.repoId,
          name: pr.repo.name,
        },
        tx,
      );
      // A NEW member changes the set an approve-and-merge gate asked about.
      if (!alreadyDelivered) await withdrawPullRequestApprovalGateOnSetChange(currentItemId, tx);
      // …and it changes the set the card's own CI verdict is folded over, so the
      // verdict is recomputed in the same transaction (MOTIR-5470). This is
      // defect 4 of the four MOTIR-5469 enumerates: linking a red pull request to
      // a card used to leave that card's `ciState` reading whatever it read
      // before — green, or nothing at all — until the NEXT check event happened
      // to fire, which for a pull request whose checks have already finished is
      // never. The link is exactly the moment the answer changes.
      if (!alreadyDelivered) await recomputeWorkItemCiState(currentItemId, tx);
      // The same set is what the card's to-fix answer reads (MOTIR-6602).
      if (!alreadyDelivered) await recomputeWorkItemFixReason(currentItemId, tx);
      return toLinkedPullRequestDto(pr);
    }).then(async (dto) => {
      // MOTIR-3675 — turn the unlinked-pull-request check GREEN, now rather than
      // on the next push. That immediacy is what makes "link it" an escape hatch
      // instead of an instruction to go and push something. POST-COMMIT and
      // best-effort by construction: the link is the durable fact, the check is a
      // view of it, and a host that refuses the write must never turn a recorded
      // link into an error the caller sees.
      await refreshLinkCheckForPullRequest(pullRequestId);
      // …and apply the sync the `opened` delivery could not, because at the
      // moment it arrived this link did not exist. See `resyncLinkedPullRequest`.
      await resyncLinkedPullRequest(pullRequestId);
      // A decision card's document, captured now rather than on the next push:
      // the `opened` delivery arrived before this link and found no decision card
      // to capture for (MOTIR-5674). Best-effort; it swallows its own failures.
      await captureDecisionDocument(pullRequestId);
      return dto;
    });
  },

  /**
   * Link a pull request to a work item by its GITHUB COORDINATES —
   * `(owner/name, number)` — creating the row when no webhook delivery has
   * arrived yet (Story MOTIR-3525 · Subtask MOTIR-3526).
   *
   * ── Why this is not {@link linkPullRequest} with a different lookup ────────
   * The picker resolves an INGESTED pull request by Motir's internal cuid, which
   * is a reasonable thing to ask of a person reading a list. It is the wrong
   * question for the actor this path is for. An agent that has just run
   * `gh pr create` is the FIRST party to know the pull request exists — ahead of
   * GitHub's own webhook — and it addresses it the way the world does, by
   * repository and number. So the row may not be there yet, and requiring it to
   * be there would make the link impossible in exactly the moment it is certain.
   *
   * ── The division of authority ─────────────────────────────────────────────
   * The caller is authoritative about the LINK and about nothing else; the
   * webhook is authoritative about STATE and about nothing else. That used to
   * need a boundary marker, because both wrote the same column: `linkedManually`
   * made a declared link STICKY against the sync's branch/title parse. Nothing
   * of that is left — the parse went with MOTIR-3674, the association column with
   * MOTIR-3757, and the flag's last writer with MOTIR-4894 — so the two claims
   * now live in two different tables and cannot collide. A delivery refreshes
   * `state` / `merged` / `headRef` / `baseRef` / `title` on the mirror row and
   * reaches no association at all.
   *
   * That is why the two arms below are asymmetric, and the asymmetry is the
   * whole behaviour rather than an optimisation:
   *
   *  · **No row yet** — write one from what the caller truthfully knows at that
   *    moment (`state: 'open'`, `merged: false`, plus the refs and title it was
   *    given) AND the link.
   *  · **A row already** — touch ONLY the link. The caller's `open` / `false` are
   *    stale guesses about a row the webhook has already spoken for, and writing
   *    them would re-open a merged pull request.
   *
   * ── Tenancy ───────────────────────────────────────────────────────────────
   * The repository is resolved from the REPO ROW, never through its installation
   * (MOTIR-1931) — under Motir's shared provisioning installation the
   * installation names no workspace, so that join would have made this
   * permanently not-found for every repository Motir created. And it is resolved
   * at the ORGANISATION tier (MOTIR-5188): a repository is connected once, to the
   * organisation (Story MOTIR-4669), so any of its workspaces may link a pull
   * request on it — the same widening MOTIR-5152 gave `linkPullRequest`. The
   * ITEM stays workspace-scoped. An unknown repository, another organisation's
   * repository and an unknown item all raise their typed not-found, so none leaks
   * existence.
   *
   * ⚠️ THE ASSOCIATION IS A SET: a call naming a different work item ADDS a
   * second delivery rather than moving the first, and there is no move to report
   * (MOTIR-3757 — the scalar `movedFrom` described is gone with the column). A
   * mistaken link is retracted by `unlinkPullRequest`, which is why that door
   * exists.
   */
  async linkPullRequestByCoordinates(
    input: {
      /** The work item to link — already resolved and known to the caller. */
      workItemId: string;
      /** Its project, for the permission assertion. */
      projectId: string;
      owner: string;
      name: string;
      number: number;
      /** The branch the pull request is FROM, as the caller knows it. */
      headRef: string;
      /** The branch it TARGETS, as the caller knows it. */
      baseRef: string;
      title: string | null;
    },
    ctx: ServiceContext,
  ): Promise<{ link: LinkedPullRequestDto; created: boolean }> {
    // The key this tool DECLARES, asserted where the write happens rather than
    // left to the MCP permission gate alone: the gate says what the TOKEN may
    // reach, this says what its owner may do to this project. Runs BEFORE the
    // transaction so a refusal costs no row lock.
    await projectAccessService.assertPermission(input.projectId, ctx, PULL_REQUEST_LINK_PERMISSION);

    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(input.workItemId);

      // The ORGANISATION's repository, resolved off the workspace ROW — never
      // request input. Asking the workspace raised `GithubRepoNotFoundError` in
      // every workspace but the installing one, shutting the only door an agent
      // has for linking a pull request (MOTIR-5188).
      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
      const repo = await githubRepoRepository.findConnectedByOrganizationAndName(
        organizationId,
        input.owner,
        input.name,
        tx,
      );
      if (!repo) throw new GithubRepoNotFoundError(`${input.owner}/${input.name}`);

      // Lock BEFORE reading, because what is written next is DERIVED from what
      // is read (the lock-before-read-derived-update rule): a concurrent webhook
      // delivery deciding whether to preserve a manual link must serialize
      // against this. A no-op when the row does not exist yet — the upsert's
      // P2002 catch is what converges that case.
      await githubPullRequestRepository.lockByRepoAndNumber(repo.id, input.number, tx);
      const existing = await githubPullRequestRepository.findByRepoAndNumber(
        repo.id,
        input.number,
        tx,
      );

      let prId: string;
      if (existing) {
        prId = existing.id;
      } else {
        const row = {
          // ⚠️ THE REPO ROW's discriminator, never `repo.installation.provider`
          // — MOTIR-1931's rule one layer deeper than it is usually met. The
          // repo row resolves here because it carries its own `workspace_id`;
          // its INSTALLATION does not, because under Motir's shared
          // provisioning install that row's `workspace_id` is NULL and
          // `github_installation` is policy-gated, so the join comes back null
          // inside a workspace-bound transaction. Prisma types the include as
          // present, so this is a runtime null the compiler cannot name — the
          // suite is what names it.
          provider: repo.provider,
          repoId: repo.id,
          number: input.number,
          // What the caller can truthfully assert about a pull request it just
          // opened. Every one of these is REPLACED by the first delivery.
          state: 'open',
          merged: false,
          headRef: input.headRef,
          baseRef: input.baseRef,
          title: input.title,
          // ⚠️ NOT ASSERTED — the one field this caller is never asked about
          // (MOTIR-5002). `link_pull_request` takes the refs and the title because
          // an agent that has just run `gh pr create` truthfully knows them; it is
          // not asked whether the pull request is a draft, so this row must not
          // say. `undefined` is the repository input's word for that: the column
          // stays NULL on this insert, and NULL is what makes
          // `resyncLinkedPullRequest` decline rather than guess.
          //
          // Writing `false` here would be the defect with a different author. It
          // costs nothing to leave: a row this arm CREATES means no delivery has
          // arrived, so there is nothing to resync in the first place — and the
          // delivery still to come is the authority that fills it in.
          draft: undefined,
          // Nor is it asked the head commit (MOTIR-7005): the delivery still to come
          // writes it, and until then `pullRequestHead` falls back to the check rows.
          headSha: undefined,
          // Nor its author (MOTIR-10340): the delivery still to come writes it.
          authorGithubUserId: undefined,
          authorLogin: undefined,
        };
        try {
          prId = (await githubPullRequestRepository.upsert(row, tx)).id;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Converge on a lost `(repo_id, number)` race exactly as
          // `syncChangeRequestStatus` does: the winner wrote the same row, so
          // re-write to reflect this call and carry on.
          prId = (await githubPullRequestRepository.upsert(row, tx)).id;
        }
      }

      // A READ, where a write used to be (MOTIR-4894). `markLinkedManually` was
      // the one narrow write both arms shared — `linked_manually` and nothing
      // else, so the already-ingested case could not clobber a delivery's state
      // fields — and with the flag retired there is no column left for a link to
      // touch on the mirror row. What the arms actually needed from it was the
      // row WITH its context, which this returns without writing anything.
      //
      // Non-null by construction: `prId` names a row this transaction either
      // read or wrote, and the read is inside it. The throw is the type's, not a
      // case — it reports a row that vanished under a lock we hold.
      const updated = await githubPullRequestRepository.findByIdWithInstallation(prId, tx);
      if (!updated) throw new GithubPullRequestNotFoundError(prId);
      // THE LINK — see the note on the sibling arm. `repo.id` rather than a
      // re-read: this arm already resolved the repository row, and the gate
      // compares each member's merge against THAT repository's own default
      // branch, so the column is stored rather than joined for per member.
      // The same set-change withdrawal the sibling arm makes (MOTIR-5482).
      const alreadyDelivered = (await workItemDeliveryRepository.listByPullRequest(prId, tx)).some(
        (row) => row.workItemId === input.workItemId,
      );
      await workItemDeliveryRepository.add(
        {
          workspaceId: ctx.workspaceId,
          workItemId: input.workItemId,
          githubPullRequestId: prId,
          repoId: repo.id,
        },
        tx,
      );
      // The same record the sibling arm writes (MOTIR-11040), for the card's own
      // project — the item's, read above, rather than the caller's claim of it.
      await projectRepoSetService.adoptConnectedRepo(
        {
          projectId: item.projectId,
          workspaceId: ctx.workspaceId,
          githubRepoId: repo.id,
          name: repo.name,
        },
        tx,
      );
      if (!alreadyDelivered) {
        await withdrawPullRequestApprovalGateOnSetChange(input.workItemId, tx);
        // The AGENT's link door owes the recompute exactly as the picker's does
        // (MOTIR-5470). It is the arm that matters MORE, not less: this is the
        // call a run makes seconds after `gh pr create`, so it is the one that
        // decides what a card's badge says for the whole life of that pull
        // request — and the one that can write the FIRST delivery a card has
        // ever had.
        await recomputeWorkItemCiState(input.workItemId, tx);
        await recomputeWorkItemFixReason(input.workItemId, tx);
      }

      return {
        link: toLinkedPullRequestDto(updated),
        created: existing === null,
        prId,
      };
    }).then(async ({ prId, ...result }) => {
      // MOTIR-3675 — the same post-commit refresh the sibling arm does, and this
      // is the arm that matters most: it is the one a RUN calls, seconds after
      // `gh pr create`, often before any delivery has arrived at all.
      await refreshLinkCheckForPullRequest(prId);
      // The arm a RUN calls, so the one where the delivery has almost always
      // already been and gone — and `created` is exactly how this arm knows.
      // A row this call CREATED means no delivery has arrived yet: there is
      // nothing to catch up on, and the `opened` delivery still to come will
      // transition the card itself. A row that already existed means a delivery
      // came, found no link, and correctly moved nothing.
      if (!result.created) await resyncLinkedPullRequest(prId);
      // The arm a run calls right after `gh pr create` — the one where the
      // `opened` delivery almost always came first and found no decision card to
      // capture for (MOTIR-5674).
      await captureDecisionDocument(prId);
      return result;
    });
  },

  /**
   * Remove ONE delivery link — the door a mistaken link needs (Story MOTIR-3655 ·
   * MOTIR-3658).
   *
   * ── Why this has to exist now, when it never did before ───────────────────
   * While the association was one nullable column a correction was expressible as
   * a MOVE: link the pull request to the right item and the wrong association
   * vanished, because there was only ever one. `work_item_delivery` is a set, so
   * a re-link ADDS and the mistaken row stays. Removal therefore stops being a
   * side effect of the fix and has to be its own operation.
   *
   * ── What it does NOT touch ────────────────────────────────────────────────
   * The pull-request MIRROR row. It holds no association to remove — the scalar
   * that used to sit beside this table was dropped by MOTIR-3757 — so this door
   * deletes one delivery row and leaves `github_pull_request` exactly as the
   * webhook last wrote it. There is no provenance flag left to reason about
   * either: MOTIR-4894 retired the one an unlink used to leave standing.
   *
   * Returns whether a row was actually removed, so a caller can say "nothing to
   * unlink" rather than reporting a success that did nothing.
   */
  async unlinkPullRequest(
    workItemId: string,
    pullRequestId: string,
    ctx: ServiceContext,
  ): Promise<{ removed: boolean }> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(workItemId);
      // The link arm's key, asserted before the delete — and so before the
      // merge gate this unlink would withdraw (MOTIR-6318).
      await projectAccessService.assertPermission(
        item.projectId,
        ctx,
        PULL_REQUEST_LINK_PERMISSION,
        tx,
      );

      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);

      const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      // The REPO row is the tenant (MOTIR-1931), never its installation, at the
      // ORGANISATION tier (MOTIR-4649) — the same gate the link arm uses, and
      // for the same reason. It travels WITH that arm rather than after it: a
      // link a member can make and cannot remove is a worse state than one they
      // can make neither of, and leaving this workspace-scoped would have built
      // exactly that trap for every sibling workspace (MOTIR-5152).
      if (!pr || pr.repo.organizationId !== organizationId)
        throw new GithubPullRequestNotFoundError(pullRequestId);

      const count = await workItemDeliveryRepository.remove(workItemId, pullRequestId, tx);
      // The row left the card, so the card's merge question about it goes too, in
      // the same transaction: a member left the set the approve-and-merge gate asked
      // about (MOTIR-5482). The per-pull-request gate retired with MOTIR-5611.
      if (count > 0) {
        await withdrawPullRequestApprovalGateOnSetChange(workItemId, tx);
        // And the card's CI verdict is folded over that same set, so removing a
        // member re-decides it (MOTIR-5470). This direction is the one that
        // strands a card visibly: retracting a mis-linked RED pull request left
        // the card reading `failing` with nothing red left on it, and no event
        // was ever coming to correct it — the pull request it would have come
        // from is the one that just stopped delivering this card.
        await recomputeWorkItemCiState(workItemId, tx);
        await recomputeWorkItemFixReason(workItemId, tx);
      }
      return { removed: count > 0 };
    }).then(async (result) => {
      // The mirror of the link arm (MOTIR-3675): removing the last delivery makes
      // the pull request unlinked again, and the check has to say so. Post-commit
      // and best-effort, for the same reason.
      if (result.removed) await refreshLinkCheckForPullRequest(pullRequestId);
      return result;
    });
  },

  /**
   * Remove ONE delivery link addressed by GITHUB COORDINATES — `(owner/name,
   * number)` — the correction door an AGENT can reach (MOTIR-3756).
   *
   * ── Why it is not {@link unlinkPullRequest} with a different lookup ────────
   * Exactly the asymmetry {@link linkPullRequestByCoordinates} documents, in the
   * other direction. The item page addresses a pull request by Motir's internal
   * cuid because it is rendering a row it already read; an agent that mis-linked
   * one seconds ago knows it as `owner/name#number` and nothing else. Requiring
   * the cuid would make the correction unreachable by the actor who makes the
   * mistake, which is the whole population this door is for.
   *
   * ── Why a coordinate that names NOTHING is a not-found, not a no-op ───────
   * An unknown repository or an unknown number raises rather than answering
   * `removed: false`. The two answers look alike and mean opposite things: *there
   * is no such pull request* is almost always a typo in the argument, and
   * reporting it as a successful nothing lets the caller believe a mis-link was
   * corrected while it stands. `removed: false` is reserved for the one case that
   * really is benign — the pull request exists, the item exists, and they were
   * simply not linked (a retry, or a correction somebody else already made).
   *
   * ── What it does NOT touch ────────────────────────────────────────────────
   * The pull-request mirror row, for the reason the sibling arm states.
   */
  async unlinkPullRequestByCoordinates(
    input: {
      /** The work item to unlink — already resolved and known to the caller. */
      workItemId: string;
      /** Its project, for the permission assertion. */
      projectId: string;
      owner: string;
      name: string;
      number: number;
    },
    ctx: ServiceContext,
  ): Promise<{ removed: boolean; pullRequestId: string }> {
    // The key this tool DECLARES — the same one `link_pull_request` asserts, and
    // asserted here rather than left to the MCP gate alone, for the same reason:
    // the gate says what the TOKEN may reach, this says what its owner may do to
    // this project. Undoing a link is editing the card the link was made against.
    await projectAccessService.assertPermission(input.projectId, ctx, PULL_REQUEST_LINK_PERMISSION);

    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(input.workItemId);

      // The organisation tier, travelling WITH the link arm above: a link a
      // sibling workspace can make and cannot retract is the worse trap.
      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
      const repo = await githubRepoRepository.findConnectedByOrganizationAndName(
        organizationId,
        input.owner,
        input.name,
        tx,
      );
      if (!repo) throw new GithubRepoNotFoundError(`${input.owner}/${input.name}`);

      const pr = await githubPullRequestRepository.findByRepoAndNumber(repo.id, input.number, tx);
      if (!pr)
        throw new GithubPullRequestNotFoundError(`${input.owner}/${input.name}#${input.number}`);

      // EXACTLY ONE row: the repository's `deleteMany` is keyed on the
      // `(work_item_id, github_pull_request_id)` unique pair, so the pair it names
      // is the only row it can reach. A pull request delivering four cards loses
      // the one named here and keeps the other three, which is the difference
      // between a correction and a retraction.
      const count = await workItemDeliveryRepository.remove(input.workItemId, pr.id, tx);
      // The same withdrawal the sibling arm makes (MOTIR-5482), and the same
      // recompute (MOTIR-5470) — all four link doors change the delivery set, so
      // all four re-decide the verdict folded over it.
      if (count > 0) {
        await withdrawPullRequestApprovalGateOnSetChange(input.workItemId, tx);
        await recomputeWorkItemCiState(input.workItemId, tx);
        await recomputeWorkItemFixReason(input.workItemId, tx);
      }
      return { removed: count > 0, pullRequestId: pr.id };
    }).then(async (result) => {
      // The same post-commit refresh both other arms do (MOTIR-3675): removing the
      // LAST delivery makes the pull request unlinked again and its check has to
      // say so. Best-effort — the removal is the durable fact, the check a view of
      // it, and a host that refuses the write must never turn a recorded removal
      // into an error the caller sees.
      if (result.removed) await refreshLinkCheckForPullRequest(result.pullRequestId);
      return result;
    });
  },

  /**
   * The cards ONE pull request delivers — the reverse of `link_pull_request`
   * (MOTIR-10331), read for `find_work_items_for_pull_request`.
   *
   * ⚠️ THE DELIVERY ROWS ARE THE ONLY LINK. A key in the pull request's title,
   * branch or body is a label nobody parses; a card is delivered by a pull request
   * exactly when a `work_item_delivery` row says so, so that is the one thing read.
   * An INHERITED delivery (a child whose parent's pull request delivers it) is not
   * a row of its own: the caller reaches it by walking the tree from the card
   * this returns.
   *
   * ⚠️ TENANCY. Every read runs in ONE workspace-bound transaction. Repositories
   * are organisation-tier, so the repository and the pull request resolve across
   * the organisation (as `unlinkPullRequestByCoordinates` resolves them), but the
   * delivery rows and the cards are gated by RLS on `app.workspace_id`: a pull
   * request that delivers only a sibling workspace's cards answers `no_deliveries`,
   * and no card of that workspace can reach the answer.
   *
   * The three `not_linked` reasons are answers, not errors. After the lookup, the
   * caller's `work_item:edit` is asserted on the project of every card returned —
   * the answer exists to submit a review verdict for those cards.
   */
  async findWorkItemsForPullRequest(
    input: { owner: string; name: string; number: number },
    ctx: ServiceContext,
  ): Promise<PullRequestDeliveriesDto> {
    const pullRequest = `${input.owner}/${input.name}#${input.number}`;
    const found = await withWorkspaceContext(ctx, (tx) => readDeliveredWorkItems(input, ctx, tx));
    if (found.outcome === 'not_linked')
      return { outcome: 'not_linked', pullRequest, reason: found.reason };

    for (const projectId of new Set(found.items.map((item) => item.projectId))) {
      await projectAccessService.assertPermission(projectId, ctx, PULL_REQUEST_LINK_PERMISSION);
    }
    return {
      outcome: 'linked',
      pullRequest,
      workItems: found.items.map(({ projectId: _projectId, ...item }) => item),
    };
  },
};

type DeliveredRead =
  | { outcome: 'linked'; items: (DeliveredWorkItemDto & { projectId: string })[] }
  | { outcome: 'not_linked'; reason: PullRequestNotLinkedReason };

/** The reads behind {@link githubPullRequestService.findWorkItemsForPullRequest},
 *  inside its one workspace-bound transaction. */
async function readDeliveredWorkItems(
  input: { owner: string; name: string; number: number },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<DeliveredRead> {
  const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
  const repo = await githubRepoRepository.findConnectedByOrganizationAndName(
    organizationId,
    input.owner,
    input.name,
    tx,
  );
  if (!repo) return { outcome: 'not_linked', reason: 'repository_not_connected' };

  const pr = await githubPullRequestRepository.findByRepoAndNumber(repo.id, input.number, tx);
  if (!pr) return { outcome: 'not_linked', reason: 'pull_request_unknown' };

  const deliveries = await workItemDeliveryRepository.listByPullRequest(pr.id, tx);
  // Resolved TOLERANTLY, as `resolveDeliveredWorkItems` does: a delivery whose
  // card this workspace cannot see shortens the answer and never fabricates one.
  // The explicit workspace filter is the tenant gate as well as RLS, because the
  // dev and CI superuser bypasses RLS (finding #26).
  const cards = await workItemRepository.findByIdsInWorkspace(
    [...new Set(deliveries.map((d) => d.workItemId))],
    ctx.workspaceId,
    tx,
  );
  // An archived card is still delivered by the pull request, so it is answered;
  // the caller decides what an archived card means for its work.
  const projects = await projectRepository.findManyByIds(
    [...new Set(cards.map((card) => card.projectId))],
    tx,
  );
  const projectKeyById = new Map(projects.map((p) => [p.id, p.identifier]));
  const byId = new Map(cards.map((card) => [card.id, card]));
  // The delivery read's (link age) order, which is the order the cards were linked.
  // A card this workspace cannot see never reaches this map, so it drops out here.
  const ordered = [...new Set(deliveries.map((d) => d.workItemId))].flatMap((id) => {
    const card = byId.get(id);
    const projectKey = card ? projectKeyById.get(card.projectId) : undefined;
    if (!card || !projectKey) return [];
    return [
      {
        key: card.identifier,
        title: card.title,
        kind: card.kind,
        status: card.status,
        projectKey,
        projectId: card.projectId,
      },
    ];
  });
  return ordered.length > 0
    ? { outcome: 'linked', items: ordered }
    : { outcome: 'not_linked', reason: 'no_deliveries' };
}

/** A lost unique-constraint race, spelled the same way `changeRequestStatusSync`
 *  spells it — the two converge on the same `(repo_id, number)` pair. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
