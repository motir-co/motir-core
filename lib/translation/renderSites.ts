// THE WORK-CONTENT RENDER SITES (Story MOTIR-7738 · MOTIR-8834) — every file that
// draws a work item's TITLE next to its key, and what it owes the project's
// auto-translate switch.
//
// A project that turns auto-translate on promises that a member reads work content in
// their own language ACROSS THE APP. The failure that breaks the promise is silent: a
// new list, card or chip draws `{item.title}` raw, and the one screen the reader opens
// next is in the original language while every other is not. So the sites are listed
// here, each with a status, and `tests/translation/workContentRenderSites.test.ts`
// fails when a file draws a title beside a key and is not on the list.
//
//   covered   the site renders the title through the title-translation kit
//             (`components/workItems/titleTranslation/*`, `useItemScope`'s host, or
//             `lib/pages/surfaceTranslation`) — the guard checks the import.
//   exempt    the title is not translatable work content, or another mechanism owns it.
//   deferred  a real gap, named with the reason. Each is a known omission, not a
//             decision; a deferred site that gets covered moves to `covered`.

export type RenderSiteStatus = 'covered' | 'exempt' | 'deferred';

export interface RenderSite {
  readonly file: string;
  readonly status: RenderSiteStatus;
  readonly why: string;
}

const covered = (file: string, why: string): RenderSite => ({ file, status: 'covered', why });
const exempt = (file: string, why: string): RenderSite => ({ file, status: 'exempt', why });
const deferred = (file: string, why: string): RenderSite => ({ file, status: 'deferred', why });

export const WORK_CONTENT_RENDER_SITES: readonly RenderSite[] = [
  covered('app/(authed)/workbench/_components/WorkbenchList.tsx', 'page host: /workbench'),
  covered('app/(authed)/backlog/_components/BacklogRow.tsx', 'page host: /backlog'),
  covered(
    'app/(authed)/backlog/_components/SprintReport.tsx',
    'hosts: /backlog, /sprints/[id]/report',
  ),
  covered('app/(authed)/items/_components/issueColumns.tsx', 'page host: /items'),
  covered(
    'app/(authed)/items/_components/IssueQuickViewPanel.tsx',
    'item-scope host + related titles',
  ),
  covered('app/(authed)/items/[key]/_components/ChildList.tsx', 'item-scope host + related titles'),
  covered(
    'app/(authed)/items/[key]/_components/ParentBreadcrumb.tsx',
    'item-scope host + related titles',
  ),
  covered(
    'app/(authed)/items/[key]/_components/CoreFieldsPanel.tsx',
    'item-scope host + related titles',
  ),
  covered(
    'app/(authed)/items/[key]/_components/RelationshipsPanel.tsx',
    'item-scope host + related titles',
  ),
  covered(
    'app/(authed)/items/archived/_components/ArchivedWorkItemsList.tsx',
    'page host: /items/archived',
  ),
  covered('app/(authed)/boards/_components/BoardCard.tsx', 'page host: /boards'),
  covered('components/ui/ReadinessBadge.tsx', 'follows whichever host the badge sits under'),
  covered('components/planning/WorkItemNode.tsx', 'page host: /roadmap'),
  covered(
    'components/planning/CantPlanAlert.tsx',
    'page host: /roadmap (the alert renders under the canvas card)',
  ),
  covered('components/approvals/ApprovalRow.tsx', 'hosts: /approvals, /workbench'),

  exempt(
    'app/(authed)/items/[key]/_view.tsx',
    'the opened item is translated by the item-scope host',
  ),
  exempt(
    'app/(authed)/triage/_components/TriageQueue.tsx',
    'a search haystack over the stored text, not a rendering',
  ),
  exempt(
    'app/(authed)/_components/ReportWidgetModal.tsx',
    "echoes the reader's own just-typed report title",
  ),
  exempt(
    'app/(authed)/settings/project/ai-planning/lessons/[lessonId]/page.tsx',
    'a lesson, not a work item',
  ),
  exempt('app/tokens/tree-table/page.tsx', 'a design-system specimen'),
  exempt('components/pages/PageEditorHost.tsx', 'a page, not a work item'),
  exempt(
    'components/planning/PlanProposalList.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/PlanItemNode.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/PlanChangeRail.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/TargetSearchListbox.tsx',
    "a search picker over the planner's targets",
  ),
  exempt(
    'components/planning/SupersedesChip.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/ProposalPeek.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/workItemLevel.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt(
    'components/planning/PlanningTargetChip.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt('components/planning/planLevel.tsx', "the planner's draft items, not stored work content"),
  exempt(
    'components/planning/PlanPreview.tsx',
    "the planner's draft items, not stored work content",
  ),
  exempt('components/planning/GuideRail.tsx', "the planner's draft items, not stored work content"),

  deferred(
    'app/(authed)/dashboard/_components/FilterResultsBody.tsx',
    'a dashboard is workspace-wide: its results span projects, and the switch is per project',
  ),
  deferred(
    'app/(authed)/my-agents/_components/AgentRunLine.tsx',
    'the run DTO carries a key and a title but no work item id to register',
  ),
  deferred(
    'app/(authed)/my-agents/_components/agentRefusal.tsx',
    'the run DTO carries a key and a title but no work item id to register',
  ),
  deferred(
    'components/approvals/ApprovalOverlay.tsx',
    'mounted in the shell layout, outside any page host; its chips carry no id',
  ),
  deferred(
    'app/(authed)/_components/CreateIssueLinksField.tsx',
    'a search picker rendered inside a modal, outside any page host',
  ),
  deferred(
    'components/ui/markdownEditorMentions.tsx',
    'editor mention suggestions come from a search, outside any page host',
  ),
  deferred(
    'app/(visitor)/p/[identifier]/requested-features/_components/RequestedFeaturesList.tsx',
    'a public visitor page with no member reader to translate for',
  ),
  deferred(
    'components/pages/WorkItemEmbedCard.tsx',
    "the page's embedded card draws the title as the work item stores it, like the mention chip beside it; registering the page's work-item cards with the title kit is a follow-up (MOTIR-7566)",
  ),
  deferred(
    'app/(authed)/pages/[pageId]/_components/LinkedWorkItemsStrip.tsx',
    "the page's Linked work items strip draws the title as the work item stores it, like the embed card; registering it with the title kit is a follow-up (MOTIR-9200)",
  ),
  deferred(
    'app/(authed)/pages/[pageId]/_components/LinkWorkItemControl.tsx',
    'a search picker for linking a work item to a page, drawn outside any item-scope host; registering it with the title kit is a follow-up (MOTIR-9200)',
  ),
];
