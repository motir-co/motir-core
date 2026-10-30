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
import type { WorkItemLanguageField } from '@/lib/dto/workItems';
import { languageArgs, languageInput, languagesInput } from './contentLanguage';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  ExecutorDto,
  UpdateWorkItemInput,
  WorkItemDifficultyDto,
  WorkItemDto,
  WorkItemObsolescenceDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import {
  WORK_ITEM_SECTIONS_INPUT_DESCRIPTION,
  workItemSectionsInputSchema,
} from '../sectionsInput';
import { obsolescenceNoteWriteField, obsolescenceWriteField } from '../obsolescence';
import { derived } from '../payloads/define';
import { presentMcpWorkItem, workItemWritePayload } from '../payloads/workItems';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `update_work_item` (Story 7.8 · Subtask 7.8.14; `storyPoints` added 7.8.21) —
// EDIT a work item's fields, the partial-patch counterpart of `create_work_item`.
// `create_work_item` can only set kind/title/parentKey/descriptionMd/priority/
// storyPoints; this tool patches the REST of the UI-editable fields (`type`,
// `executor`, `estimateMinutes`, `storyPoints`, `assigneeId`, `dueDate`) plus the
// ones create also sets — so an agent can FIX a card after creating it instead of
// the old cancel-and-recreate hack.
//
// A THIN adapter over `workItemsService.updateWorkItem`: the leaf-only `type`/
// `executor` rule, the type→executor seed, the assignee-membership check, the
// 6.4 edit gate, the shared story-point validation, and the revision row all run
// in the service UNCHANGED. Workflow STATUS is deliberately NOT here — it stays
// on `transition_status` (the legal-transition validation lives there);
// `kind`/`parentId` re-parenting also stays out (a structural move, not a field
// edit). `storyPoints` (7.8.21) is now a first-class patch field — set / change /
// clear — validated with the SAME shared `validateStoryPoints` rule the UI
// estimation surface uses, so the agent surface is never stricter or looser than
// the human one (the per-field validation lives in the service, not here).

export const UPDATE_WORK_ITEM_TOOL_NAME = 'update_work_item';

const inputSchema = {
  key: workItemKeyField,
  title: z.string().min(1).optional().describe('New title (one line).'),
  descriptionMd: z
    .string()
    .nullable()
    .optional()
    .describe('New Markdown description body; null clears it.'),
  sections: workItemSectionsInputSchema.optional().describe(WORK_ITEM_SECTIONS_INPUT_DESCRIPTION),
  explanationMd: z
    .string()
    .nullable()
    .optional()
    .describe('New Markdown explanation body (the "why"); null clears it.'),
  // The language of the text this call writes (Story MOTIR-7731 · MOTIR-8098).
  // Metadata about a field, not a field: alone it patches nothing.
  language: languageInput,
  languages: languagesInput(['title', 'description', 'explanation'] as const),
  priority: z.nativeEnum(WorkItemPriority).optional().describe('New priority (lowest…highest).'),
  type: z
    .nativeEnum(WorkItemType)
    .nullable()
    .optional()
    .describe(
      'New work type (code, design, test, …) — leaf items only; null clears it. ' +
        'Setting a type the first time seeds the executor from the type default.',
    ),
  executor: z
    .nativeEnum(Executor)
    .nullable()
    .optional()
    .describe(
      'Who executes the work ("coding_agent" or "human") — leaf items only; null clears it.',
    ),
  difficulty: z
    .nativeEnum(WorkItemDifficulty)
    .nullable()
    .optional()
    .describe(
      'How hard the work is to REASON about, not how big it is: "trivial", "low", ' +
        '"medium" or "high" — leaf items only; null clears it. A non-null value on an epic or story is ' +
        'refused (DIFFICULTY_NOT_ALLOWED_ON_KIND), and so is changing the kind of a leaf ' +
        'that carries one to a container without clearing it in the same call.',
    ),
  // The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6582) — any kind, any status.
  obsolescence: obsolescenceWriteField,
  obsolescenceNoteMd: obsolescenceNoteWriteField,
  estimateMinutes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Estimated minutes of work; null clears it.'),
  storyPoints: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Story-point estimate (the agile sizing number, distinct from the time ' +
        'estimate above): a non-negative number ≤ 9999.99 with at most two ' +
        'decimal places. null clears it.',
    ),
  targetRepo: z
    .string()
    .nullable()
    .optional()
    .describe(
      'WHICH REPO this item ships in — the bare repo name (e.g. "motir-core") or ' +
        'the "owner/name" form; must name one of the PROJECT\'s repositories — a ' +
        'row of its repository set, including one not created yet. A repository ' +
        'connected to the workspace but not linked to this project is rejected. ' +
        'Routes the CLI to the right checkout at dispatch (one subtask = one repo ' +
        '= one PR). null clears the pin.',
    ),
  targetRepos: z
    .array(z.string())
    .optional()
    .describe(
      'Replace the repository SET wholesale — EVERY repository this item ships ' +
        'in, ORDERED, the FIRST element being the PRIMARY the CLI is dispatched ' +
        'into. The list does not decide completion: the item completes when every ' +
        "pull request LINKED to it has merged onto its repository's default branch. " +
        'Use it for a card that legitimately spans repositories (a story or a task — ONE ' +
        'SUBTASK is still ONE REPO). Same validation as create; `[]` clears the ' +
        "set. MUTUALLY EXCLUSIVE with targetRepo, which IS this list's first " +
        'element: supplying both is rejected rather than silently resolved.',
    ),
  targetRepositories: z
    .array(z.string())
    .optional()
    .describe(
      "Replace the repository set wholesale, as REFERENCES to the project's " +
        'repository ROWS — their ids, ORDERED, the FIRST being the PRIMARY the CLI ' +
        'is dispatched into. Prefer this over targetRepos when you have the ids: a ' +
        'reference survives a rename and can name one of two rows sharing a role. ' +
        'Same validation as create; `[]` clears the set. MUTUALLY EXCLUSIVE with ' +
        'BOTH targetRepo and targetRepos.',
    ),
  assigneeId: z
    .string()
    .nullable()
    .optional()
    .describe('New assignee user id (must be a workspace member); null unassigns.'),
  dueDate: z
    .string()
    .nullable()
    .optional()
    .describe('Due date as an ISO-8601 string; null clears it.'),
};

interface UpdateWorkItemArgs {
  key: string;
  title?: string;
  descriptionMd?: string | null;
  sections?: Record<string, unknown>;
  explanationMd?: string | null;
  language?: Locale;
  languages?: Partial<Record<WorkItemLanguageField, Locale>>;
  priority?: WorkItemPriority;
  type?: WorkItemType | null;
  executor?: Executor | null;
  difficulty?: WorkItemDifficulty | null;
  obsolescence?: WorkItemObsolescence | null;
  obsolescenceNoteMd?: string | null;
  estimateMinutes?: number | null;
  storyPoints?: number | null;
  targetRepo?: string | null;
  targetRepos?: string[];
  targetRepositories?: string[];
  assigneeId?: string | null;
  dueDate?: string | null;
}

/** Build the partial patch from only the args the caller actually supplied. */
function toPatch(args: UpdateWorkItemArgs): UpdateWorkItemInput {
  const patch: UpdateWorkItemInput = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.descriptionMd !== undefined) patch.descriptionMd = args.descriptionMd;
  // Sections (MOTIR-9031): the service merges them over the stored body and renders.
  if (args.sections !== undefined)
    patch.sections = args.sections as NonNullable<UpdateWorkItemInput['sections']>;
  if (args.explanationMd !== undefined) patch.explanationMd = args.explanationMd;
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.type !== undefined) patch.type = args.type as WorkItemTypeDto | null;
  if (args.executor !== undefined) patch.executor = args.executor as ExecutorDto | null;
  if (args.difficulty !== undefined) {
    patch.difficulty = args.difficulty as WorkItemDifficultyDto | null;
  }
  // The mark and its note (MOTIR-6582): `null` clears; the service validates the
  // value (InvalidObsolescenceError → INVALID_OBSOLESCENCE) on ANY kind, and refuses
  // SETTING a mark on an unfinished item (MOTIR-6672, OBSOLESCENCE_REQUIRES_FINISHED).
  if (args.obsolescence !== undefined) {
    patch.obsolescence = args.obsolescence as WorkItemObsolescenceDto | null;
  }
  if (args.obsolescenceNoteMd !== undefined) patch.obsolescenceNoteMd = args.obsolescenceNoteMd;
  if (args.estimateMinutes !== undefined) patch.estimateMinutes = args.estimateMinutes;
  if (args.storyPoints !== undefined) patch.storyPoints = args.storyPoints;
  if (args.targetRepo !== undefined) patch.targetRepo = args.targetRepo;
  if (args.targetRepos !== undefined) patch.targetRepos = args.targetRepos;
  if (args.targetRepositories !== undefined) patch.targetRepositories = args.targetRepositories;
  if (args.assigneeId !== undefined) patch.assigneeId = args.assigneeId;
  if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
  return patch;
}

/** Compact human-readable summary of the patched fields. */
function summarize(dto: WorkItemDto, patchedKeys: string[]): string {
  return [
    `Updated ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${dto.title}`,
    `Patched: ${patchedKeys.join(', ')}`,
  ].join('\n');
}

/**
 * The stable code carried by the empty-patch refusal.
 *
 * ⚠️ A PATCH THAT CHANGES NOTHING IS NOT A SUCCESS (bug MOTIR-3342). This
 * summary used to render `Patched: nothing` and return `toolOk` — a successful
 * call that changed nothing, styled exactly like the line that reports a real
 * edit. It was the one line that could have caught the unknown-key strip this
 * bug is really about, and instead it hid it: `update_work_item({ key,
 * description: '<2 000 words>' })` answered `Updated MOTIR-3334 … Patched:
 * nothing` and lost the body.
 *
 * The unknown-key half is closed at the registration seam
 * (`lib/mcp/strictInput.ts`), which refuses the typo with a `-32602` before this
 * runner is reached. This is the SECOND half, and it stands on its own: an
 * update that patches no field is never what a caller meant — it is either a
 * key the caller could not spell or a caller with nothing to say, and neither
 * deserves a success.
 */
export const NO_FIELDS_TO_PATCH_CODE = 'NO_FIELDS_TO_PATCH' as const;

/** The adapter: resolve the project + item by key, then apply the patch. */
export async function runUpdateWorkItem(
  args: UpdateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const patch = toPatch(args);
    // Counted BEFORE the language keys join: a language re-labels nothing on
    // its own, so `{ key, language }` is still an empty patch (MOTIR-8098).
    const patchedKeys = Object.keys(patch);
    if (patchedKeys.length === 0) {
      return toolError(
        NO_FIELDS_TO_PATCH_CODE,
        'update_work_item was called with no field to change — only "key" was supplied. ' +
          'Name at least one of: title, descriptionMd, sections, explanationMd, priority, type, ' +
          'executor, difficulty, obsolescence, obsolescenceNoteMd, estimateMinutes, ' +
          'storyPoints, targetRepo, targetRepos, ' +
          'targetRepositories, assigneeId, dueDate. (Use transition_status for the ' +
          'workflow status.)',
      );
    }
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const dto = await workItemsService.updateWorkItem(
      item.id,
      { ...patch, ...languageArgs(args) },
      ctx,
    );
    return toolOk(
      summarize(dto, patchedKeys),
      derived(workItemWritePayload, presentMcpWorkItem(dto)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerUpdateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    UPDATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Update work item',
      description:
        'Edit a work item (by identifier, e.g. "ACME-7"): patch any subset of title, ' +
        'description, explanation, priority, type, executor, difficulty, obsolescence mark ' +
        'and its note, estimate, story points, target repo, assignee, or due date. Use ' +
        'transition_status for the workflow status. The obsolescence mark (`outdated` · ' +
        '`deprecated`) and `obsolescenceNoteMd` may be set on ANY kind, and `null` clears ' +
        'either; a value outside the enum is refused with INVALID_OBSOLESCENCE. A MARK is a ' +
        'FINISHED item’s state: setting one on an item whose status is outside the done ' +
        'category is refused with OBSOLESCENCE_REQUIRES_FINISHED — archive an item nobody will ' +
        'finish instead. Clearing is always legal, and after it the item can be reopened. ' +
        'Re-parenting under a marked item is refused with MARKED_CARD_CANNOT_REOPEN. Honors the same leaf-only type/difficulty rules, ' +
        'project-repository validation, assignee-membership check, and access checks as the UI. ' +
        'Send `sections` (see get_section_sets) instead of `descriptionMd` to merge named ' +
        'sections over the stored body: the door checks them for the item\u2019s type after this ' +
        'write, names a missing one (INVALID_SECTIONS) and renders them; sending both is refused ' +
        '(SECTIONS_AND_DESCRIPTION_CONFLICT) and a plain `descriptionMd` is stored as sent. ' +
        '`language` (or per-field `languages`) names the language of the text written; an ' +
        "edited field with none records the organisation's content language, and a language " +
        'alone changes nothing (NO_FIELDS_TO_PATCH).',
      inputSchema,
    },
    async (args, extra) => runUpdateWorkItem(args, resolveContext(extra)),
  );
}
