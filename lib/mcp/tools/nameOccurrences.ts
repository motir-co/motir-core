import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NAME_LOOKUP_MAX, NAME_RECORD_MAX } from '@/lib/codeGraph/errors';
import type { NameOccurrenceLookupDTO, NameOccurrenceRecordDTO } from '@/lib/dto/nameOccurrences';
import {
  nameOccurrencesService,
  type LookupNameOccurrencesArgs,
  type RecordNameOccurrencesArgs,
} from '@/lib/services/nameOccurrencesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `record_name_occurrences` and `lookup_name_occurrences` (MOTIR-11647 · story
// MOTIR-11497) — the organisation-wide record of where code names occur, for plan.py
// holding only its Motir token. Each is a thin adapter over `nameOccurrencesService`,
// which forwards through motir-ai: no code-graph credential is read or held here.
//
// Only the door's own refusals are errors (no `ai:plan`, project not found, a repo
// outside the set, a cap, an empty or duplicate list, a malformed row). A forward that
// fails is an ANSWER in the same shape — an all-miss look-up, `{ recorded: 0 }` — with
// a `note` sentence and a `reason` code.

export const RECORD_NAME_OCCURRENCES_TOOL_NAME = 'record_name_occurrences';
export const LOOKUP_NAME_OCCURRENCES_TOOL_NAME = 'lookup_name_occurrences';

const repoField = z
  .string()
  .min(1)
  .describe(
    'The repository in the project’s set — its bare name ("motir-core") or `owner/name`, ' +
      'case-insensitively. A repository outside the set is refused with the set.',
  );

// The occurrence fields are typed but not REQUIRED by the schema, so a row missing one
// is refused by the door's own typed error naming the row and the field.
const occurrenceField = z.object({
  blob: z
    .string()
    .optional()
    .describe('REQUIRED. The git blob id of the file content the name was found in.'),
  name: z.string().optional().describe('REQUIRED. The code name, exactly as written.'),
  startLine: z
    .number()
    .optional()
    .describe('REQUIRED. The first line of the occurrence, 1-based, in that blob.'),
  endLine: z
    .number()
    .optional()
    .describe('REQUIRED. The last line of the occurrence, inclusive, not before `startLine`.'),
});

const recordSchema = {
  projectKey: projectKeyField,
  repo: repoField.describe(
    'The repository in the project’s set the occurrences were read in — its bare name or ' +
      '`owner/name`. It names which organisation’s record the rows go to; the rows themselves ' +
      'belong to a blob, not to a repository.',
  ),
  occurrences: z
    .array(occurrenceField)
    .describe(
      `1 to ${NAME_RECORD_MAX} occurrences, each \`{ blob, name, startLine, endLine }\`. ` +
        'Over the cap, empty, or with a row missing a field is refused.',
    ),
};

const lookupSchema = {
  projectKey: projectKeyField,
  repo: repoField,
  commit: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The commit to answer at (a full sha). Omit to answer at the record’s ' +
        'indexed head of the default branch.',
    ),
  names: z
    .array(z.string())
    .describe(
      `1 to ${NAME_LOOKUP_MAX} distinct names. Over the cap, empty, or with a repeat is refused.`,
    ),
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The text of a look-up answer: the note when degraded, then one line per name. */
export function summarizeNameLookup(dto: NameOccurrenceLookupDTO): string {
  const hits = dto.names.filter((n) => n.occurrences.length > 0).length;
  const head =
    dto.note !== null
      ? `The name record could not be asked (${dto.reason}): ${dto.note} Every name below is a miss for that reason, not because the code lacks it.`
      : `${hits} of ${plural(dto.names.length, 'name')} found in the record${dto.commit ? ` at ${dto.commit}` : ''}.`;
  const lines = dto.names.map((n) =>
    n.occurrences.length === 0
      ? `- ${n.name}: miss`
      : `- ${n.name}: ${n.occurrences.map((o) => `${o.path}:${o.startLine}-${o.endLine} (blob ${o.blob})`).join(', ')}`,
  );
  return [head, ...lines].join('\n');
}

/** The text of a record answer. */
export function summarizeNameRecord(dto: NameOccurrenceRecordDTO): string {
  const head = `${plural(dto.recorded, 'occurrence')} recorded.`;
  return dto.note !== null
    ? `${head} The record did not answer in full (${dto.reason}): ${dto.note}`
    : head;
}

export async function runRecordNameOccurrences(
  args: { projectKey: string } & RecordNameOccurrencesArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const dto = await nameOccurrencesService.record(
      args.projectKey.trim().toUpperCase(),
      { repo: args.repo, occurrences: args.occurrences },
      ctx,
    );
    return toolOk(summarizeNameRecord(dto), exempt(RECORD_NAME_OCCURRENCES_TOOL_NAME, { ...dto }));
  } catch (err) {
    return toToolError(err);
  }
}

export async function runLookupNameOccurrences(
  args: { projectKey: string } & LookupNameOccurrencesArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const dto = await nameOccurrencesService.lookup(
      args.projectKey.trim().toUpperCase(),
      {
        repo: args.repo,
        names: args.names,
        ...(args.commit !== undefined ? { commit: args.commit } : {}),
      },
      ctx,
    );
    return toolOk(summarizeNameLookup(dto), exempt(LOOKUP_NAME_OCCURRENCES_TOOL_NAME, { ...dto }));
  } catch (err) {
    return toToolError(err);
  }
}

const DEGRADED =
  'When the record cannot be asked — motir-ai unreachable or not configured, the repository not ' +
  'mapped or not indexed, the commit not held — the answer keeps its shape and carries a `note` ' +
  'sentence and a `reason` code (`ai_not_configured`, `ai_unreachable`, `ai_error`, ' +
  '`record_unanswered`); it is never a tool error.';

export function registerNameOccurrences(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    RECORD_NAME_OCCURRENCES_TOOL_NAME,
    {
      title: 'Record where names occur',
      description:
        'Record where code names occur in file content you read — each occurrence a name, the ' +
        'git blob of the content and the 1-based line range — in the organisation-wide record ' +
        'both Motir planners ask before searching. A planner records after each author session the ' +
        `names its card wrote, from the files that session read. At most ${NAME_RECORD_MAX} per ` +
        'call. Answers `{ recorded, note, reason }`: `recorded` is how many rows the record ' +
        'inserted (a repeat of a row it holds inserts none). ' +
        DEGRADED +
        ' Gated on the planning permission. The project key resolves inside the token’s own ' +
        'workspace.',
      inputSchema: recordSchema,
    },
    async (args, extra) => {
      try {
        return await runRecordNameOccurrences(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
  server.registerTool(
    LOOKUP_NAME_OCCURRENCES_TOOL_NAME,
    {
      title: 'Look up where names occur',
      description:
        'Ask the organisation-wide name record where each of a batch of code names occurs in one ' +
        'repository, at a commit — the record both Motir planners write after their sessions ' +
        'read files. Answers `{ commit, names, note, reason }`: exactly one entry per asked ' +
        'name, in the order asked, each with the occurrences `{ path, startLine, endLine, blob }` ' +
        'at that commit; an empty list is a miss — the record holds nothing for it, which is NOT ' +
        `proof the code lacks it. 1 to ${NAME_LOOKUP_MAX} distinct names per call. ` +
        DEGRADED +
        ' Read-only; gated on the planning permission. The project key resolves inside the ' +
        'token’s own workspace.',
      inputSchema: lookupSchema,
    },
    async (args, extra) => {
      try {
        return await runLookupNameOccurrences(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
