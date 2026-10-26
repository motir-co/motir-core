import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-5752's `motir-core` COVERAGE FLOOR (write a page; MOTIR-7281), and
// STORY MOTIR-5753's (the `/pages` tree; MOTIR-7377) and STORY MOTIR-5760's (the
// page tools over the MCP; MOTIR-7413), each of which extends the same lane
// rather than adding a second job: the tree's app files join `STORY_FILES` and its
// gate (`tests/integration/pagesTreeStoryGate.test.ts`) joins `include`. The tree
// story's other app files are gated where they already were — the folder surface
// it moved to `components/folders/` and `folderRepository` / `foldersService` /
// `folderMappers` by the main lane (`vitest.config.ts`), the rest by the entries
// below — and `packages/pages/src/move.ts` by the package's own floor.
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether the
// assembled pages layer is correct — `tests/integration/pagesStoryGate.test.ts`
// holds what a percentage cannot see (an editor-shaped update through the save
// door and back out of `getPage`, two stale saves in parallel both surviving,
// the derived formats agreeing with the stored state after every save, a page
// image outliving the orphan sweep, create → rename → list, the tenant and
// project ceilings, and every page door per built-in role). What a floor catches
// is what those cannot: a LATER change that deletes a branch's only test and
// leaves the branch.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and over the files this story CREATED. The package
// half of the story (`packages/pages/src/**`) carries its own per-file floor in
// `packages/pages/vitest.config.ts`, run by the `pages` job.
//
// ⚠️ THE TWO SHARED FILES THE STORY CHANGED ARE REPORTED, NOT GATED.
// `attachmentsService.ts` and `attachmentRepository.ts` belong to the attachments
// surface (Subtask 2.3.7 onward), and this lane runs only the suites that reach
// the PAGE path, so a whole-file floor would measure other stories' lines — the
// hosted-agent-run and review-agent lanes' reason for the same choice. The
// story's own lines in them — the page arm of `getContentRedirect`,
// `uploadPageImage`, `linkToPage` and the orphan predicate's `pageId: null` — are
// covered by this lane's suites (measured on this branch, 2026-10-02): every line
// and every branch arm of them but ONE, `if (!page) throw` in the page arm of
// `getContentRedirect`. That arm is defensive: `attachment.page_id` is
// `ON DELETE SET NULL`, so a row naming a page that does not exist cannot be
// read, only raced (a page deleted between the two reads of one transaction).
// The report's other uncovered ranges in both files fall outside the story's
// lines.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE. Measured with:
//   pnpm coverage:pages
// It needs Postgres and the built `@motir/pages` (`pnpm --filter @motir/pages
// build`), which the app resolves from the package's `dist/`.
//
// ⚠️ ROUTE GROUPS AND DYNAMIC SEGMENTS ARE MATCHED WITH `**` / `*`, NEVER THE
// LITERAL `(authed)` or `[pageId]` (MOTIR-2449: both are glob syntax to the
// matcher the coverage provider uses, so a literal path matches no file and its
// threshold passes vacuously).
//
// ⚠️ IT DOES NOT OVERRIDE `resolve` — spread the base config and change only what
// this lane is about (the onboarding-routing lane's comment says why).
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

const STORY_FILES = [
  'lib/services/pagesService.ts',
  'lib/repositories/pageRepository.ts',
  'lib/mappers/pageMappers.ts',
  'lib/pages/index.ts',
  'lib/pages/pageStoreAdapter.ts',
  'lib/pages/routeErrors.ts',
  // `/api/pages`, `/api/pages/[pageId]`, `…/updates`, `…/images`, `…/versions`,
  // and (MOTIR-5754) `…/versions/[number]` and `…/versions/[number]/restore`.
  'app/api/pages/route.ts',
  'app/api/pages/*/route.ts',
  'app/api/pages/*/*/route.ts',
  'app/api/pages/*/*/*/route.ts',
  'app/api/pages/*/*/*/*/route.ts',
  'lib/repositories/pageVersionRepository.ts',
  // The editor host.
  'components/pages/*.tsx',
  // Story MOTIR-5753 (the `/pages` tree; MOTIR-7377): the tree, its rows, menus,
  // Move to… picker, drag, the page route's sidebar and breadcrumb, and the two
  // hooks — the `*.tsx` glob above stops at `components/pages/`, one level up.
  'components/pages/tree/*.tsx',
  'components/pages/tree/*.ts',
  // Story MOTIR-5755 (archive; MOTIR-7423): the archive / restore / delete
  // client, its two hooks, the confirms and the archived banner.
  'components/pages/archive/*.tsx',
  'components/pages/archive/*.ts',
  // The tree routes' `parent` parser (`?parent=` and the JSON `parent`).
  'lib/pages/parentInput.ts',
  // Story MOTIR-5755 (archive; MOTIR-7420): the Archived pages list's cursor.
  'lib/pages/archivedRootsCursor.ts',
  // `app/(authed)/pages/**` — the index, New page and the page at its address.
  'app/**/pages/page.tsx',
  'app/**/pages/*/page.tsx',
  'app/**/pages/_components/*.tsx',
  'app/**/pages/*/_components/*.tsx',
  // Story MOTIR-5760 (agents read and write a page over the MCP; MOTIR-7413):
  // the three page tools and the plumbing they share.
  'lib/mcp/tools/getPage.ts',
  'lib/mcp/tools/createPage.ts',
  'lib/mcp/tools/updatePage.ts',
  'lib/mcp/tools/pageRef.ts',
  // Story MOTIR-5761 (a decision may be a page; MOTIR-7441): the publish service, its
  // publication repository, mapper and refusals, the MCP tool and REST door an agent and
  // the confirm port use, and the confirm port's page picker. `components/pages/FrozenPill`
  // is gated by the `components/pages/*.tsx` glob above.
  'lib/services/decisionPageService.ts',
  'lib/repositories/decisionPagePublicationRepository.ts',
  'lib/mappers/decisionPageMappers.ts',
  'lib/decisionPages/errors.ts',
  'lib/mcp/tools/publishDecisionPage.ts',
  'app/api/work-items/*/decision-page/route.ts',
  'components/approvals/DecisionRecordPagePicker.tsx',
  // Story MOTIR-7565 (a page names a work item, and the work item knows it;
  // MOTIR-7576): the derived-link diff, the link table's repository, the work
  // item's Pages read with its cursor, mapper and route. The adapter's
  // `replaceDerivedLinks` and `getPage`'s chip data are gated by the
  // `pageStoreAdapter.ts` / `pagesService.ts` entries above; the package's
  // `extractLinks` and mention node by the package's own floor.
  'lib/pages/derivedLinks.ts',
  'lib/repositories/pageWorkItemLinkRepository.ts',
  'lib/services/pageLinksService.ts',
  'lib/pages/workItemPagesCursor.ts',
  'lib/mappers/pageLinkMappers.ts',
  'app/api/work-items/*/pages/route.ts',
  // Story MOTIR-7567 (the hand link, both ways): the pair's DELETE door, the
  // link-search and page-side routes (gated by the `app/api/pages/*` globs
  // above) and the two cursors.
  'app/api/work-items/*/pages/*/route.ts',
  'lib/pages/pageTitleSearchCursor.ts',
  'lib/pages/pageWorkItemsCursor.ts',
  // The work item page's Pages section (MOTIR-7575) and its fetch helper.
  'app/**/items/*/_components/PagesSection.tsx',
  'lib/workItems/pageLinksClient.ts',
  // MOTIR-9199 / MOTIR-9200: the Link page form and the extracted place line on
  // the work item page, and the page's strip fetch helper. The strip and its
  // Link work item control sit under `app/**/pages/*/_components/` above.
  // NOT gated: `lib/services/projectAccessService.ts` (one method added to a
  // shared service this lane reaches only in part), `lib/dto/pageLinks.ts`
  // (declaration-only) and `hooks/useLinkCandidateSearch.ts` (shared with the
  // create-issue links field).
  'app/**/items/*/_components/LinkPageForm.tsx',
  'app/**/items/*/_components/PagePlace.tsx',
  'lib/pages/pageLinkedWorkItemsClient.ts',
  // Story MOTIR-7694 (a work item tags a page; MOTIR-7699): the page-token
  // grammar and the item-body row derivation. The mention-search route is
  // gated by the `app/api/pages/*/route.ts` glob above.
  'lib/mentions/pageRefs.ts',
  'lib/workItems/bodyPageLinks.ts',
] as const;

const SHARED_FILES = [
  'lib/services/attachmentsService.ts',
  'lib/repositories/attachmentRepository.ts',
  // MOTIR-5760: `toToolError` gained the page arms (every `@motir/pages`
  // refusal by its code, and the revision conflict as an instruction). The rest
  // of the file is every other tool's, which this lane does not run, so it is
  // reported, not gated; the page arms are covered by the tool suites below.
  'lib/mcp/toolResult.ts',
] as const;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gates — the assembly, on the real doors (MOTIR-5752 · MOTIR-5753).
      'tests/integration/pagesStoryGate.test.ts',
      'tests/integration/pagesTreeStoryGate.test.ts',
      'tests/integration/pageHistoryStoryGate.test.ts',
      // Story MOTIR-5755's (archive, restore and delete; MOTIR-7425).
      'tests/integration/pageArchiveStoryGate.test.ts',
      // Agents read and write a page over the MCP (Story MOTIR-5760 · MOTIR-7413):
      // the story gate, the three tools' suites and the device grant.
      'tests/integration/pagesMcpStoryGate.test.ts',
      'tests/mcp/getPageTool.test.ts',
      'tests/mcp/createPageTool.test.ts',
      'tests/mcp/updatePageTool.test.ts',
      'tests/mcp/pageRef.test.ts',
      'tests/cli/cliDevicePageGrant.test.ts',
      // The per-card server suites (MOTIR-7276 · 7277 · 7278 · 7279 · 7300).
      'tests/page-schema-rls.test.ts',
      'tests/pages/*.test.ts',
      'tests/pages/*.test.tsx',
      'tests/services/pagesService.*.test.ts',
      'tests/services/attachmentsService.pageImage.integration.test.ts',
      'tests/jobs/attachment-gc.test.ts',
      'tests/api/pages-routes.test.ts',
      'tests/api/pages-routes-refusals.test.ts',
      'tests/api/pages-routes-tree.test.ts',
      // A page's history (Story MOTIR-5754 · MOTIR-7385 · 7386).
      'tests/api/pages-history-routes.test.ts',
      // Archive, restore, delete and the Archived pages list (Story MOTIR-5755 · MOTIR-7422).
      'tests/api/pages-archive-routes.test.ts',
      // The `/api/v1` page resource (Story MOTIR-9486), which reaches the service's
      // page-id lookup (`getPageProjectId`, MOTIR-9493).
      'tests/api/v1/pages-*.test.ts',
      // The client surfaces (MOTIR-7280 · 7300).
      'tests/components/new-page-button.test.tsx',
      'tests/components/page-view.test.tsx',
      'tests/components/page-view-edges.test.tsx',
      'tests/components/pages-index.test.tsx',
      // A page mentions a work item (Story MOTIR-5747 · MOTIR-7574): the host's binding.
      'tests/components/pageEditorHost.test.tsx',
      // A page embeds a work item as a card (Story MOTIR-7566 · MOTIR-9182 · MOTIR-9183):
      // the host's card, and the read gate over the real doors.
      'tests/components/work-item-embed-card.test.tsx',
      'tests/integration/pages/embedStoryGate.test.ts',
      // A decision may be a page (Story MOTIR-5761 · MOTIR-7441): the story gate, then each
      // card's own suite over the files above.
      'tests/integration/decisionPageStoryGate.test.ts',
      'tests/services/decisionPageService.integration.test.ts',
      'tests/mcp/publishDecisionPageTool.test.ts',
      'tests/api/decisionPageRoute.test.ts',
      'tests/approvalGates/decisionPageGate.test.ts',
      'tests/approvalGates/decisionConfirmationPageRecord.test.ts',
      'tests/components/decision-port-page.test.tsx',
      'tests/components/decision-confirm-page-record.test.tsx',
      // A page names a work item (Story MOTIR-7565): the story gate
      // (`tests/pages/pageWorkItemLinks.story.integration.test.ts`, matched by
      // `tests/pages/*.test.ts` above) and the Pages read's own suites.
      'tests/services/pageLinksService.test.ts',
      'tests/api/workItemPagesRoute.test.ts',
      // The work item page's Pages section (MOTIR-7575).
      'tests/components/pagesSection.test.tsx',
      // The hand link's two UI surfaces (MOTIR-9199 · MOTIR-9200); the story gate
      // is `tests/pages/pageWorkItemHandLinks.story.integration.test.ts`
      // (matched by `tests/pages/*.test.ts`).
      'tests/components/linkPageForm.test.tsx',
      'tests/components/linkedWorkItemsStrip.test.tsx',
      // Story MOTIR-7567 (link a page and a work item by hand): the write
      // path (MOTIR-9197), the page-side read (MOTIR-9198) and the link
      // search (MOTIR-9204); `pagesService.linkSearch` is matched above.
      'tests/pages/pageWorkItemLinkRepository.manual.test.ts',
      'tests/services/pageLinksService.write.test.ts',
      'tests/services/pageLinksService.pageWorkItems.test.ts',
      'tests/api/workItemsPagesWrite.test.ts',
      'tests/api/pageWorkItemsRoute.test.ts',
      'tests/api/pagesLinkSearchRoute.test.ts',
      // A work item tags a page (Story MOTIR-7694): the item-derived link rows
      // (MOTIR-7696) and the page mention search route (MOTIR-7697).
      'tests/services/workItemsService.pageLinks.test.ts',
      'tests/api/pageMentionSearchRoute.test.ts',
      // Its story gate is `tests/pages/pageTags.story.integration.test.ts`
      // (matched above); the token grammar and the Visitor's label redaction.
      'tests/mentions/pageRefs.test.ts',
      'tests/visitor/redactPageRefLabels.test.ts',
      // Story MOTIR-9491 (search from the Pages tree; MOTIR-9639): the session route
      // `/api/pages/search` and the `/pages` search box fall under this lane's
      // `app/api/pages/*/route.ts` and `app/**/pages/_components/*.tsx` globs, so the
      // story's gate, route test and the box's component test run here too.
      'tests/integration/pages/pageSearchStoryGate.test.ts',
      'tests/api/pagesSearchRoute.test.ts',
      'tests/components/use-page-search.test.tsx',
      'tests/components/pages-search.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: true,
      include: [...STORY_FILES, ...SHARED_FILES],
      thresholds: {
        perFile: true,
        ...Object.fromEntries(STORY_FILES.map((file) => [file, FLOOR])),
      },
    },
  },
});
