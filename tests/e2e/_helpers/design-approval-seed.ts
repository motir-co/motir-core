import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from '@playwright/test';

import { adminDb } from '@/tests/helpers/adminDb';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';
import { servePrivateObjectStore } from './object-store';

// THE DESIGN-APPROVAL seed (Story MOTIR-4778 · Subtask MOTIR-4797).
//
// Plants the one shape this story's whole claim rests on: a published design
// AWAITING a decision, a card that is BLOCKED BY the card carrying it, and two
// people who stand in different relations to the question.
//
// ⚠️ THE GATE IS NOT SEEDED. `designEvidenceService` creates the `awaiting`
// `design_result` gate as part of PUBLISHING (it calls the kind's own `routeTo`
// and writes the row), so a seed that inserted a gate directly would be
// asserting against a row the product did not make. The spec publishes through
// the real `publish_design_result` tool over `/api/mcp`, exactly as
// `design-result-publish.spec.ts` does and for the same reason — that path is
// reachable in this lane, and it is the only way the gate's `subjectId`,
// `routedToId` and the evidence row are guaranteed to agree.
//
// ⚠️ THE DESIGN CARD IS SEEDED `in_progress`, AND THAT IS LOAD-BEARING RATHER
// THAN COSMETIC. Approving a design gate with no open pull request writes the
// project's `done` through `workItemsService.applyStatusTransition`, which
// validates the edge — and `todo → done` is NOT in `DEFAULT_TRANSITIONS`
// (`lib/workflows/defaultWorkflow.ts`), while `in_progress → done` is. A card
// left at `todo` would make the approval record a decision and move nothing,
// and the spec would fail on the status assertion for a reason that has nothing
// to do with the gate. It is also the honest shape: an agent claims the card,
// publishes from it, and the reviewer arrives afterwards.
//
// ⚠️ AND THE PUBLISH ITSELF THEN MOVES IT TO `in_review` (Bug MOTIR-6009): a
// design card has no pull request, so nothing else would ever move it out of
// the status a run left it in, and the publish writes it in the transaction
// that raises the gate. `in_review → done` is a declared edge too, so the
// approval below is unaffected — but a spec asserting the BEFORE state reads
// In Review, not In Progress. That is why this seed stays `in_progress`: what
// it seeds is where the AGENT leaves the card, not where the reviewer finds it.

// ⚠️ THE TWO DIRECT WRITES GO THROUGH `adminDb`, NOT `@/lib/db`, AND THE GUARD
// THAT SAYS SO IS RATCHETED. `tests/rls/test-singleton-statement-guard.test.ts`
// counts direct singleton statements under `tests/e2e/**` against a ceiling that
// only ever falls — this file went red at 454 against 452 on its first push, for
// exactly these two lines. The reason behind the ratchet is not bookkeeping:
// under `TEST_DB_APP_ROLE=1` the singleton is the NON-BYPASS runtime role, so a
// seed write through it is REFUSED and a seed read returns `[]` — and neither
// raises. A spec seeded that way drives a browser against a database it believes
// it populated. `adminDb` is the owner half of the two-client model
// (`tests/helpers/adminDb.ts`), which is what fixtures are supposed to hold.
//
// Everything else here seeds through the SERVICES on purpose — they are the
// shipped write paths, and using them is what makes the fixture's tree a tree
// the product could actually have produced. These two rows have no service door.

export const DESIGN_APPROVAL_PASSWORD = 'design-approval-e2e-pass-7';

export interface DesignApprovalSeed {
  workspaceId: string;
  projectKey: string;
  /** The design subtask carrying the published result and its awaiting gate. */
  designKey: string;
  designTitle: string;
  /** The card `blocked_by` the design subtask — the one the story is FOR. */
  dependentKey: string;
  dependentTitle: string;
  /** The gate's routed-to actor: the design card's ASSIGNEE, who may decide. */
  reviewerEmail: string;
  /** A project member who is neither assignee, reporter, nor a workspace
   *  manager — so `canDecide` is false and the frame draws no verbs. */
  readerEmail: string;
  /** A project `admin` who is NOT the routed recipient — may decide through the
   *  manager arm (`approval:decide_any`) while the gate is routed to the reviewer.
   *  The item page's door serves AUTHORITY, not routing (MOTIR-5215). */
  adminEmail: string;
  password: string;
  /** A token holding EXACTLY `CLI_TOKEN_GRANT` — a dispatched run's own grant. */
  token: string;
}

/** The note SECTIONS the design card publishes.
 *
 * ⚠️ THE HEADING SHARES NO WORDS WITH ANY CARD TITLE, and that is a rule rather
 * than a style choice: `getByRole` matches an accessible name by SUBSTRING, so
 * an overlap resolves to two headings and dies on a strict-mode violation —
 * not on anything the spec is about. (`design-publish-seed.ts` records the same
 * rule, having paid for it on its own first run.) */
export const NOTE_HEADING = 'Composition and spacing';
export const NOTE_BODY = 'The confirm step states what approving will do before it does it.';
export const NOTE_MD = [
  `## ${NOTE_HEADING}`,
  '',
  NOTE_BODY,
  '',
  'It composes `Button` for each verb and routes colour through `--el-*` only.',
].join('\n');

export const MOCK_SOURCE_PATH = 'design/work-items/approval-frame.mock.html';
export const NOTE_SOURCE_PATH = 'design/work-items/design-notes.md';

/** A self-contained mock — inline CSS, no `<script>`, no remote URL (ADR §5). */
export const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Approval frame</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif}section{padding:20px}</style>
</head><body><section><h2>Approval frame</h2><p>Three bands: what is being decided, the subject, the verbs.</p></section></body></html>`;

// ⚠️ Deliberately NOT substrings of one another, nor of the note heading above:
// `getByRole` matches by SUBSTRING and an overlap dies on strict mode.
const STORY_TITLE = 'Let a reviewer settle a published design';
const DESIGN_TITLE = 'Draw the approval frame for a published design';
const DEPENDENT_TITLE = 'Wire the frame into the late section stack';

export async function seedDesignApproval(slug: string): Promise<DesignApprovalSeed> {
  const owner = await createTestPerson({
    email: `da-owner-${slug}@example.com`,
    password: DESIGN_APPROVAL_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Design Approval E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Approval Gates',
    identifier: 'GATE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  async function pin(userId: string): Promise<void> {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  // ⚠️ BOTH ARE PLAIN WORKSPACE MEMBERS, and that is what makes the two
  // assertions mean anything. `approvalGatesService` composes `canDecide` as
  // *assignee, or reporter when there is NO assignee, or workspace manager* (ADR
  // §2's 2026-09-11 amendment), and the manager arm is the
  // `approval:decide_any` permission (MOTIR-5292), which a workspace owner holds
  // through the always-pass rail and a project `admin` holds too. Seeding the reviewer as the
  // workspace OWNER would make them able to decide everything, and the spec
  // would pass without the assignee arm existing at all.
  async function member(label: string, role: 'admin' | 'member' | 'viewer'): Promise<string> {
    const user = await createTestPerson({
      email: `da-${label}-${slug}@example.com`,
      password: DESIGN_APPROVAL_PASSWORD,
      name: label === 'reviewer' ? 'Robin Vale' : label === 'admin' ? 'Avery Admin' : 'Sam Reader',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await adminDb.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id },
    });
    // Roles live on the workspace since MOTIR-6168.
    await setWorkspaceRoleFor(user.id, workspace.id, role);
    await pin(user.id);
    return user.id;
  }

  const reviewerId = await member('reviewer', 'member');
  // The reader's id is never used again — they are defined entirely by what
  // they are NOT (assignee, reporter, workspace manager), which is the point.
  await member('reader', 'member');
  // A project ADMIN, never assignee or reporter: the one reader the To-approve
  // tab does not route this gate to and who may still decide it (MOTIR-5215).
  await member('admin', 'admin');
  await pin(owner.id);

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // A design result attaches to the LEAF that produced it (ADR §3), and a
  // subtask needs a parent — so the story is scaffolding, not a subject.
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: STORY_TITLE },
    ctx,
  );
  const design = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: DESIGN_TITLE,
      parentId: story.id,
      type: 'design',
      // The gate routes to `assigneeId ?? reporterId`, so this is what puts the
      // question in front of the reviewer rather than in front of the owner.
      assigneeId: reviewerId,
    },
    ctx,
  );
  const dependent = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: DEPENDENT_TITLE,
      parentId: story.id,
      type: 'code',
      assigneeId: reviewerId,
    },
    ctx,
  );

  // The edge the whole story exists to move: the dependent card cannot start
  // until the design is settled. Same direction `relationshipToLink` produces
  // for the UI's `blocked_by` — `fromId` is the blocked card.
  await workItemsService.linkWorkItems(
    { fromId: dependent.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );

  // See the header: `in_progress → done` is a legal edge and `todo → done` is
  // not, so the design card has to be claimed before it can be approved.
  // `updateStatus`, never `applyStatusTransition` directly — the public entry
  // point is what wraps the funnel in `withWorkspaceContext`, and without those
  // GUCs every gate read inside it comes back empty under `motir_app`.
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  // ⚠️ THE GRANT COMES FROM THE EXPORTED CONSTANT, never re-listed — so a green
  // run is evidence about the door a DISPATCHED run publishes through, and a
  // later narrowing of `CLI_TOKEN_GRANT` fails this journey rather than
  // silently un-shipping it.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'design-approval-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    workspaceId: workspace.id,
    projectKey: project.identifier,
    designKey: design.identifier,
    designTitle: DESIGN_TITLE,
    dependentKey: dependent.identifier,
    dependentTitle: DEPENDENT_TITLE,
    reviewerEmail: `da-reviewer-${slug}@example.com`,
    readerEmail: `da-reader-${slug}@example.com`,
    adminEmail: `da-admin-${slug}@example.com`,
    password: DESIGN_APPROVAL_PASSWORD,
    token: minted.token,
  };
}

// ── THE PUBLISH, AND THE PORT'S BYTES ───────────────────────────────────────
// Both halves of "get an AWAITING gate in front of a browser", extracted here
// (Bug MOTIR-5118) so the specs that need that shape share one copy. The
// comments below moved with the code from `design-approval.spec.ts`,
// which paid for them.

/** Open an MCP session as an AGENT would — a bearer, no cookie, no session. */
export async function openAgentSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'design-approval-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/**
 * Publish the seed's design result onto `key` through the REAL tool.
 *
 * ⚠️ THE GATE IS NOT SEEDED — publishing is what CREATES it, with its subject
 * pinned to these bytes and its question routed to the card's assignee. See
 * this file's header.
 */
export async function publishDesignResult(client: Client, key: string): Promise<CallToolResult> {
  return client.callTool({
    name: 'publish_design_result',
    arguments: {
      key,
      assets: [
        {
          kind: 'mock',
          sourcePath: MOCK_SOURCE_PATH,
          contentType: 'text/html',
          contentBase64: Buffer.from(MOCK_HTML).toString('base64'),
        },
        {
          kind: 'note_file',
          sourcePath: NOTE_SOURCE_PATH,
          contentType: 'text/markdown',
          contentBase64: Buffer.from(NOTE_MD).toString('base64'),
        },
      ],
      // AMENDMENT 4 (MOTIR-5491): the mock and ONE note file — no `.png`, no
      // inline `noteMd`. The seed's dependent card is `blocked_by` the design,
      // which is what lets the publish through at all.
      producedByKey: key,
    },
  }) as Promise<CallToolResult>;
}

/**
 * Serve the published mock's bytes at the app's content route.
 *
 * ⚠️ THIS IS A BROWSER LIMITATION RATHER THAN A SHORTCUT — `design-result.spec.ts`
 * and `design-result-publish.spec.ts` both document it. The mock renders in a
 * frame with `sandbox=""`, so its document loads into an OPAQUE origin; the
 * content route's 302 is interceptable, but the fetch that FOLLOWS it is made by
 * the frame against the store host and escapes `page.route` entirely, dying
 * `ERR_NAME_NOT_RESOLVED` against the `.invalid` TLD.
 *
 * ⚠️ AND IT IS LOAD-BEARING FOR THE VERBS, not only for what a reader sees:
 * `ApprovalGateControl` withholds every verb until the port reports `'rendered'`
 * (`components/approvals/portRenderStatus.tsx` — *"you cannot approve what is
 * not yet on screen"*), so a spec that skips this never gets an Approve button.
 *
 * Nothing a spec is about is stubbed: the publish is real, the decision is real,
 * and the `.png` keeps its real content-route → signed-URL → store hop, which is
 * why non-HTML passes straight through.
 */
export async function servePublishedMock(page: Page): Promise<void> {
  await servePrivateObjectStore(page);
  await page.route('**/api/attachments/*/content', async (route) => {
    // A frame can still be loading a mock when the test ends; its fetch then
    // fails against a closed page, and a throwing route handler fails a test
    // that already passed. Seen once the regression lane dropped the holds
    // that used to outlast every load (MOTIR-9411).
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (err) {
      // The page may not report itself closed yet while its context is being
      // torn down, so the error's own message is the reliable test.
      if (page.isClosed() || /has been closed|Test ended/.test(String(err))) return;
      throw err;
    }
    const location = response.headers()['location'] ?? '';
    if (location.includes('.html')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: MOCK_HTML,
      });
      return;
    }
    await route.fulfill({ response });
  });
}
