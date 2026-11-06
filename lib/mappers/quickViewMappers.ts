import { personDisplayName } from '@/lib/people/personLabel';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { IssueDetailDto, WorkItemRefMap } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { QuickViewSprintOption } from '@/lib/dto/quickView';
import type { ComponentDto } from '@/lib/dto/components';
import type { EstimationConfigDto } from '@/lib/dto/estimation';
import type { Locale } from '@/lib/i18n/locales';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

// Shapes the heavy IssueDetailDto (the SAME aggregate read the full detail page
// uses) into the condensed, serializable QuickViewData the peek modal renders
// (Subtask 2.5.19; moved out of the former IssueQuickViewContent server
// component for bug 8.8.2, where the peek became a client-fetched island).
// Member ids are resolved to display names here (server-side) so the client
// panel stays purely presentational. The readiness verdict is passed through
// unchanged — an item with NO blockers is `ready` (bug-ready-banner-no-deps);
// open blockers are named so the panel can map each to a `?peek=` swap-peek link.
//
// 8.8.8 widened the payload to the full core-field set (type/executor/labels/
// components/sprint/story-points/custom-fields/audit). All of it rides the
// SAME detail aggregate read EXCEPT the sprint NAME — `sprintId` is on the
// detail item but the name is not, so the service resolves it and hands it in
// as `sprintName` (the one field this mapper cannot derive from `detail`).
//
// 5.8.6 threads in `workItemRefs` (resolved `motir:` references in the
// description, for the peek body's live chips) + `projectIdentifier` (the prefix
// the peek header's title-linkify matches bare keys against) — both resolved by
// the service, since neither rides the detail aggregate.
export function toQuickViewData(
  detail: IssueDetailDto,
  members: WorkspaceMemberDTO[],
  locale: Locale,
  sprintName: string | null,
  workItemRefs: WorkItemRefMap,
  projectIdentifier: string,
  pullRequests: LinkedPullRequestDto[],
  canPlan: boolean,
  // MOTIR-2562 — the two option sources that do NOT ride the detail aggregate.
  // The service reads them and hands them in; this mapper stays pure.
  sprints: QuickViewSprintOption[],
  projectComponents: ComponentDto[],
  estimationConfig: EstimationConfigDto,
  /** Every repository the item ships in, with its delivery state (MOTIR-2416) —
   *  resolved by the same service call the detail page uses. */
  repoDelivery: RepoDelivery[],
  /** The card's DELIVERY SET (MOTIR-3660) — the Development section's rows and
   *  the rail caption's subject. Empty on nearly every card. */
  deliveries: WorkItemDeliveryDto[],
  /** The filed item's folder names, root first (MOTIR-5352); `[]` when unfiled. */
  folderPath: string[],
  /** The current design result when a linked pull request is open (Q8); null
   *  otherwise — the peek draws it only inside the Development block. */
  designEvidence: DesignEvidenceDTO | null = null,
): QuickViewData {
  const { item, parent, workflow } = detail;
  const nameById = new Map(members.map((m) => [m.userId, personDisplayName(m)]));
  const status = workflow.statuses.find((s) => s.key === item.status);

  return {
    // A Visitor's PRIVATE epic (MOTIR-10534): the peek wears "Not public" like the
    // canvas card, the board card and the item page. Absent on every member read.
    ...(detail.childrenHidden ? { childrenHidden: true as const } : {}),
    id: item.id,
    identifier: item.identifier,
    title: item.title,
    projectIdentifier,
    workItemRefs,
    kind: item.kind,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    fixReason: detail.fixReason,
    fixGate: detail.fixDetail?.gate ?? null,
    ...(detail.fixGroup && !detail.fixGroup.isHead ? { fixHeadKey: detail.fixGroup.headKey } : {}),
    // A dead run is never Fixing (MOTIR-10309) — the tag's own rule, kept on the wire too.
    ...(detail.fixDetail?.fixing && detail.fixReason !== 'run_died'
      ? { fixing: true as const }
      : {}),
    descriptionMd: item.descriptionMd,
    // The WHY — carried so PROPOSAL mode can render it inline (MOTIR-4183).
    // `/items` still defers it to the full page; this only makes it AVAILABLE.
    explanationMd: item.explanationMd,
    type: item.type,
    executor: item.executor,
    difficulty: item.difficulty,
    // The mark and its note (MOTIR-6674) — the peek draws the same field the page does.
    obsolescence: item.obsolescence,
    obsolescenceNoteMd: item.obsolescenceNoteMd,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    priority: item.priority,
    labels: detail.labels.map((l) => ({ id: l.id, name: l.name })),
    components: detail.components.map((c) => ({ id: c.id, name: c.name })),
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    sprintName,
    storyPoints: item.storyPoints,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
    customFields: detail.customFields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    // MOTIR-2050: the archived state — WHEN from `item.archivedAt`, WHO from
    // `detail.archivedBy` (the latest `'archived'` revision the detail read
    // already resolves for the detail page's banner). Both ride this aggregate,
    // so the peek's archived signal costs no extra read.
    archived: item.archivedAt
      ? { atLabel: formatDate(item.archivedAt, locale), byName: detail.archivedBy?.name ?? null }
      : null,
    parent: parent
      ? { identifier: parent.identifier, title: parent.title, kind: parent.kind }
      : null,
    readiness: {
      ready: detail.readiness.ready,
      blockers: detail.readiness.openBlockers.map((b) => b.identifier),
      blockedByAncestor: detail.readiness.blockedByAncestor
        ? {
            id: detail.readiness.blockedByAncestor.id,
            identifier: detail.readiness.blockedByAncestor.identifier,
            title: detail.readiness.blockedByAncestor.title,
          }
        : null,
    },
    pullRequests,
    repoDelivery,
    deliveries,
    designEvidence,
    // MOTIR-910: the peek header's Plan / Re-plan door. `hasChildren` rides the
    // detail aggregate already read above; `canPlan` is the project capability
    // the service resolves (this mapper stays pure).
    hasChildren: detail.children.length > 0,
    folderId: detail.folderId,
    folderPath,
    canPlan,
    // MOTIR-2562 — the editor inputs. Raw values ALONGSIDE the display strings
    // above (never instead of them): the strings keep the panel presentational,
    // these make its controls selectable.
    status: item.status,
    assigneeId: item.assigneeId,
    parentId: item.parentId,
    sprintId: item.sprintId,
    dueDate: item.dueDate,
    estimateMinutes: item.estimateMinutes,
    workflow,
    members,
    sprints,
    projectComponents,
    // The badge's edit gate is the SAME project capability the Plan door uses —
    // reuse the one already resolved rather than reading it twice.
    estimation: { ...estimationConfig, canEdit: canPlan },
  };
}
