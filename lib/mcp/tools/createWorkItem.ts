import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  Executor,
  WorkItemDifficulty,
  WorkItemObsolescence,
  WorkItemPriority,
  WorkItemType,
} from '@/generated/prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { Locale } from '@/lib/i18n/locales';
import { languageArgs, languageInput, languagesInput } from './contentLanguage';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CreateWorkItemInput,
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemObsolescenceDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  WORK_ITEM_SECTIONS_INPUT_DESCRIPTION,
  workItemSectionsInputSchema,
} from '../sectionsInput';
import { obsolescenceNoteWriteField, obsolescenceWriteField } from '../obsolescence';
import { derived } from '../payloads/define';
import { presentMcpWorkItem, workItemPlacementWritePayload } from '../payloads/workItems';
import type { WorkItemPlacement } from '../payloads/workItems';
import { describePlacement, readPlacement } from './placement';
import { normalizeIdentifier } from './workItemRef';

// `create_work_item` (Story 7.8 · Subtask 7.8.5) — create a work item (epic /
// story / task / bug / subtask) under a project, optionally parented. A THIN
// adapter over `workItemsService.createWorkItem`: the kind-parent matrix
// (finding #41), the per-project key allocation, the initial-status seed, the
// revision row, and the 6.4 edit gate all run in the service UNCHANGED — this
// tool adds no business logic, it only resolves the project + parent KEYS to
// ids and pins the reporter to the token's owning user (`ctx.userId`).
//
// `kind: bug` under a story/epic IS the findings bug-logging protocol — the
// description below says so, so an agent told to "log this bug in Motir" finds
// THIS tool.
//
// `kind: epic` creates a TOP-LEVEL epic (MOTIR-1345). Epic was previously
// EXCLUDED from this tool on the theory that epics are seed/scaffolding-only —
// but the AI Planning Layer (Epic 7) GENERATES the whole work-item tree, epics
// included (7.4 / MOTIR-805), so the agent surface that planner rides MUST be
// able to create one; there is no other MCP path to a top-level epic. The
// service is already total over `epic` — the kind-parent matrix
// (`lib/issues/parentRules.ts`) places an epic at the ROOT only:
// `assertValidParent(null, 'epic')` passes (an epic is not in
// `TYPES_REQUIRING_PARENT`), while any `parentKey` is rejected with the typed
// `IllegalParentTypeError` (no kind lists `epic` as a legal child). So widening
// this input enum is the entire fix; the gate + DB trigger stay the backstops.
//
// Leaf-authoring fields (MOTIR-1081): besides `storyPoints`, this tool also
// accepts `estimateMinutes`, `type`, and `executor` — the same leaf fields
// `update_work_item` patches — so a subtask can be created FULLY-SPECIFIED in
// one call (the MOTIR.md estimation gate satisfiable at create time, no
// mandatory create-then-update round-trip). They map straight onto the
// `CreateWorkItemInput` fields the service already validates: the leaf-only
// `type`/`executor` rule (`TypeNotAllowedOnKindError` on an epic/story kind),
// the type→executor seed (a `type` set without an explicit `executor` seeds it
// from `defaultExecutorForType`), and the shared estimate validation all run in
// the service UNCHANGED — this tool only widens the input surface.
//
// FOLDERS (Story MOTIR-5310 · MOTIR-5413): `folderId` files the new item into a
// folder at create, the other placement beside `parentKey`. The service owns
// every rule — both together is `PLACEMENT_CONFLICT`, an unknown folder
// `FOLDER_NOT_FOUND`, another project's `CROSS_PROJECT_FOLDER`, and a filed
// SUBTASK is legal (a folder satisfies its must-have-a-parent rule). The result
// carries a `placement` field read back off the row.

export const CREATE_WORK_ITEM_TOOL_NAME = 'create_work_item';

const inputSchema = {
  projectKey: z
    .string()
    .min(1)
    .describe(
      'The project key the item is created in — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
    ),
  kind: z
    .enum(['epic', 'story', 'task', 'bug', 'subtask'])
    .describe(
      'The work item kind. Use "epic" (no parentKey) to create a top-level capability ' +
        'area; "bug" under a story/epic to log a defect (the bug-logging protocol).',
    ),
  title: z.string().min(1).describe('The work item title (one line).'),
  parentKey: z
    .string()
    .optional()
    .describe(
      'Optional parent work item identifier (e.g. "ACME-3") — must be a kind-legal, same-project parent. ' +
        'Mutually exclusive with folderId.',
    ),
  folderId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: the id of a folder (as `list_folders` returns it) to FILE the new item into — the ' +
        'other placement beside parentKey, which it may not be combined with (PLACEMENT_CONFLICT). ' +
        'A filed item is a root, so any kind may be filed, a subtask included. The folder must be ' +
        "in this project: an unknown id is FOLDER_NOT_FOUND, another project's is CROSS_PROJECT_FOLDER.",
    ),
  descriptionMd: z.string().optional().describe('Optional Markdown description body.'),
  sections: workItemSectionsInputSchema.optional().describe(WORK_ITEM_SECTIONS_INPUT_DESCRIPTION),
  // The language the text is written in (Story MOTIR-7731 · MOTIR-8098). No
  // `explanation` member: this tool writes no explanation.
  language: languageInput,
  languages: languagesInput(['title', 'description'] as const),
  priority: z
    .nativeEnum(WorkItemPriority)
    .optional()
    .describe('Optional priority (lowest…highest); omit for the project default.'),
  storyPoints: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Optional story-point estimate (the agile sizing number, distinct from a ' +
        'time estimate). A non-negative number ≤ 9999.99 with at most two decimal ' +
        'places; omit (or null) to leave it unestimated.',
    ),
  estimateMinutes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Optional estimated minutes of work (the TIME estimate, distinct from ' +
        'story points); omit (or null) to leave it unestimated.',
    ),
  type: z
    .nativeEnum(WorkItemType)
    .nullable()
    .optional()
    .describe(
      'Optional work type (code, design, test, …) — leaf items (task / bug / ' +
        'subtask) only; rejected on a story. Setting a type seeds the executor ' +
        'from the type default unless an explicit executor is also given. ' +
        'Omit (or null) to leave it untyped.',
    ),
  executor: z
    .nativeEnum(Executor)
    .nullable()
    .optional()
    .describe(
      'Optional executor ("coding_agent" or "human") — leaf items only; ' +
        'overrides the type default when supplied. Omit (or null) to take the ' +
        'type default (or leave it unset when no type is given).',
    ),
  difficulty: z
    .nativeEnum(WorkItemDifficulty)
    .nullable()
    .optional()
    .describe(
      'Optional difficulty — how hard the work is to REASON about, not how big it ' +
        'is: "trivial", "low", "medium" or "high". Leaf items (task / bug / subtask) only; a ' +
        'non-null value on an epic or story is refused (DIFFICULTY_NOT_ALLOWED_ON_KIND). ' +
        'Omit (or null) to leave it unset.',
    ),
  // The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6582) — any kind, any status.
  obsolescence: obsolescenceWriteField,
  obsolescenceNoteMd: obsolescenceNoteWriteField,
  targetRepo: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Optional: WHICH REPO this item ships in — the bare repo name (e.g. ' +
        '"motir-core") or the "owner/name" form. Must name one of the PROJECT\'s ' +
        'repositories — a row of its repository set, including one not created ' +
        'yet. A repository connected to the workspace but not linked to this ' +
        'project is rejected, as is an unknown name. This is what routes the CLI ' +
        'to the right checkout at dispatch (one subtask = one repo = one PR). Omit ' +
        '(or null) to leave it unpinned — dispatch then falls back to the ' +
        "project's single established repository, or reports no repo when the " +
        'project has none or several.',
    ),
  targetRepos: z
    .array(z.string())
    .optional()
    .describe(
      'Optional: EVERY repository this item ships in, ORDERED — bare repo names ' +
        '(e.g. ["motir-core", "motir-ai"]) or the "owner/name" form. The FIRST ' +
        'element is the PRIMARY: the one dispatch routes the CLI to. The rest ' +
        "record where the item's other work may land. The list does not decide " +
        'completion: the item completes when every pull request LINKED to it has ' +
        "merged onto its repository's default branch, so a listed repository that " +
        'needed no change never holds it open. Each element is validated against the ' +
        "project's repository domain; duplicates collapse, blank elements are " +
        'dropped, and one unknown element rejects the whole write. Use it for a ' +
        'card that legitimately spans repositories — ONE SUBTASK is still ONE REPO, ' +
        'so this is for a story or a task, not a subtask. `[]` is the empty set. ' +
        "MUTUALLY EXCLUSIVE with targetRepo, which IS this list's first element: " +
        'supplying both is rejected rather than silently resolved.',
    ),
  targetRepositories: z
    .array(z.string())
    .optional()
    .describe(
      'Optional: EVERY repository this item ships in, as REFERENCES to the ' +
        "project's repository ROWS — their ids, ORDERED, the FIRST being the " +
        'PRIMARY the CLI is dispatched into. Prefer this over targetRepos when you ' +
        'have the ids: a reference survives the repository being renamed, and it ' +
        'can name one of two rows that share a role, which a name cannot. The names ' +
        "you read back are what these resolve to. An id outside THIS item's " +
        'project is rejected (the error lists the project\'s rows as "id (name)"); ' +
        'duplicates collapse; `[]` is the empty set. MUTUALLY EXCLUSIVE with BOTH ' +
        'targetRepo and targetRepos — they are the same field in three forms, so ' +
        'supplying two is rejected rather than silently resolved.',
    ),
  // Planning provenance (MOTIR-1685): an item created through this tool is
  // stamped `planningSource = mcp` server-side; the agent MAY self-report the
  // harness + model it planned with. Both open free-text (recorded as-is, no
  // verification implied). Omitted → the harness/model columns stay null.
  plannedWithHarness: z
    .string()
    .optional()
    .describe(
      'Optional: the harness/tool this item was planned with (e.g. "Claude Code", ' +
        '"Codex"). Recorded as self-reported planning provenance alongside the ' +
        'server-set source "mcp"; omit to leave it unrecorded.',
    ),
  plannedWithModel: z
    .string()
    .optional()
    .describe(
      'Optional: the LLM this item was planned with (e.g. "claude-opus-4-8", ' +
        '"deepseek-chat"). Recorded as self-reported planning provenance; omit to ' +
        'leave it unrecorded.',
    ),
};

interface CreateWorkItemArgs {
  projectKey: string;
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  title: string;
  parentKey?: string;
  folderId?: string;
  descriptionMd?: string;
  sections?: Record<string, unknown>;
  language?: Locale;
  languages?: Partial<Record<'title' | 'description', Locale>>;
  priority?: WorkItemPriority;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  type?: WorkItemType | null;
  executor?: Executor | null;
  difficulty?: WorkItemDifficulty | null;
  obsolescence?: WorkItemObsolescence | null;
  obsolescenceNoteMd?: string | null;
  targetRepo?: string | null;
  targetRepos?: string[];
  targetRepositories?: string[];
  plannedWithHarness?: string;
  plannedWithModel?: string;
}

/** Compact human-readable summary of a freshly-created work item. */
function summarize(dto: WorkItemDto, placement: WorkItemPlacement): string {
  return [
    `Created ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${dto.title}`,
    `Status: ${dto.status} · Priority: ${dto.priority} · Reporter: ${dto.reporterId}`,
    `Placed ${describePlacement(placement)}`,
  ].join('\n');
}

/** The adapter: resolve project (+ optional parent) by key, then create. */
export async function runCreateWorkItem(
  args: CreateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);

    let parentId: string | null = null;
    let parentKey: string | null = null;
    if (args.parentKey != null && args.parentKey.trim() !== '') {
      // A parent must be in the SAME project (the create service re-checks
      // same-project + kind-legality). Resolve it within the new item's project;
      // a foreign/unknown parent identifier 404s here as WorkItemNotFoundError
      // (no existence leak), and the kind-legal check is the service's job.
      const parent = await workItemsService.getWorkItemByIdentifier(
        project.id,
        normalizeIdentifier(args.parentKey),
        ctx,
      );
      parentId = parent.id;
      parentKey = parent.identifier;
    }

    const input: CreateWorkItemInput = {
      projectId: project.id,
      kind: args.kind as WorkItemKindDto,
      title: args.title,
      parentId,
      // FOLDERS (MOTIR-5413): forwarded only when supplied. The service refuses
      // it beside `parentId` and validates the folder under a lock.
      ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
      // Sections (MOTIR-9031): with `sections` the service renders the body, so a
      // missing `descriptionMd` stays ABSENT (never `null`, which would read as a
      // second source) and one that is sent is left for the service to refuse.
      // Without it, today's `?? null` is unchanged.
      ...(args.sections !== undefined
        ? {
            sections: args.sections as NonNullable<CreateWorkItemInput['sections']>,
            ...(args.descriptionMd !== undefined ? { descriptionMd: args.descriptionMd } : {}),
          }
        : { descriptionMd: args.descriptionMd ?? null }),
      // The service records the org's content language when neither is supplied.
      ...languageArgs(args),
      ...(args.priority ? { priority: args.priority } : {}),
      // Story points (7.8.21): forward only when supplied — both a number and an
      // explicit null pass through (the service validates + treats null as
      // unestimated); omitted leaves the column default.
      ...(args.storyPoints !== undefined ? { storyPoints: args.storyPoints } : {}),
      // Leaf-authoring fields (MOTIR-1081): forward only when supplied so an
      // omitted field still leaves the column default. The service owns the
      // leaf-only `type`/`executor` rule + the type→executor seed + the
      // estimate validation — this is a thin pass-through.
      ...(args.estimateMinutes !== undefined ? { estimateMinutes: args.estimateMinutes } : {}),
      ...(args.type !== undefined ? { type: args.type as WorkItemTypeDto | null } : {}),
      ...(args.executor !== undefined ? { executor: args.executor as ExecutorDto | null } : {}),
      // Difficulty (Story MOTIR-6016): the service owns the leaf-only refusal.
      ...(args.difficulty !== undefined
        ? { difficulty: args.difficulty as WorkItemDifficultyDto | null }
        : {}),
      // The obsolescence mark + note (MOTIR-6582): forwarded only when supplied;
      // the service validates the value (InvalidObsolescenceError) on any kind, and
      // refuses a MARK on the unfinished initial status (MOTIR-6672,
      // OBSOLESCENCE_REQUIRES_FINISHED) — `toToolError` answers it typed.
      ...(args.obsolescence !== undefined
        ? { obsolescence: args.obsolescence as WorkItemObsolescenceDto | null }
        : {}),
      ...(args.obsolescenceNoteMd !== undefined
        ? { obsolescenceNoteMd: args.obsolescenceNoteMd }
        : {}),
      // Target repo (MOTIR-1804): forward only when supplied. The service owns
      // the normalization (`owner/name` → name) and the connected-set validation
      // — this stays a thin pass-through, like every other leaf field here.
      ...(args.targetRepo !== undefined ? { targetRepo: args.targetRepo } : {}),
      // The repository SET (MOTIR-2728): same thin pass-through. The service owns
      // the per-element validation AND the refusal when both fields arrive — the
      // scalar is the set's first element, so the two can disagree.
      ...(args.targetRepos !== undefined ? { targetRepos: args.targetRepos } : {}),
      ...(args.targetRepositories !== undefined
        ? { targetRepositories: args.targetRepositories }
        : {}),
      // Planning provenance (MOTIR-1685): server-set `source: 'mcp'` for anything
      // created through this agent tool surface; the harness/model are the agent's
      // self-reported values (null when not supplied). The source is fixed here —
      // never taken from a caller field — so an agent cannot claim `manual`/`native`.
      provenance: {
        planning: {
          source: 'mcp',
          harness: args.plannedWithHarness ?? null,
          model: args.plannedWithModel ?? null,
        },
      },
    };
    const dto = await workItemsService.createWorkItem(input, ctx);
    const placement = await readPlacement(dto.id, parentKey, ctx);
    return toolOk(
      summarize(dto, placement),
      derived(workItemPlacementWritePayload, { ...presentMcpWorkItem(dto), placement }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CREATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Create work item',
      description:
        'Create a work item (epic, story, task, bug, or subtask) in a project, optionally ' +
        'under a parent OR filed into a folder (folderId, from list_folders — never both). ' +
        'The result carries a `placement` field saying where it landed. The reporter is the token owner. Use kind "epic" with no parent to ' +
        'create a top-level capability area; kind "bug" under a story/epic to LOG A BUG. ' +
        'Optionally set the leaf-authoring fields up front — story points, estimate ' +
        '(minutes), work type, executor and difficulty — so a subtask can be created ' +
        'fully-specified in one call. `obsolescence` (`outdated` · `deprecated`) and ' +
        '`obsolescenceNoteMd` may be set on any kind; a value outside the enum is refused ' +
        'with INVALID_OBSOLESCENCE. A MARK is a finished item’s state and a new item lands ' +
        'at the workflow’s initial status, so a mark on create is refused with ' +
        'OBSOLESCENCE_REQUIRES_FINISHED unless that status is in the done category — set it ' +
        'with update_work_item once the item is finished. A parent that carries a mark takes ' +
        'no new children (MARKED_CARD_CANNOT_REOPEN). ' +
        'Honors the same kind-parent rules (an epic is root-only — ' +
        'a parented epic is rejected), leaf-only type/executor/difficulty rule, and access ' +
        'checks as the UI. `language` (or per-field `languages`) names the language the ' +
        "text is written in; omitted, the organisation's content language is recorded. " +
        'Send `sections` (see get_section_sets) instead of `descriptionMd` to have the door ' +
        'check them for the kind and type, name a missing one (INVALID_SECTIONS) and render ' +
        'them into the description; sending both is refused (SECTIONS_AND_DESCRIPTION_CONFLICT) ' +
        'and a plain `descriptionMd` is stored exactly as sent.',
      inputSchema,
    },
    async (args, extra) => runCreateWorkItem(args, resolveContext(extra)),
  );
}
