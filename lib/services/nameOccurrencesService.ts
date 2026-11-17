import {
  lookUpNameOccurrences,
  recordNameOccurrences,
  type RawNameOccurrencesLookup,
} from '@/lib/ai/motirAiClient';
import { MotirAiConfigError, MotirAiError, MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  DuplicateNameOccurrenceNamesError,
  EmptyNameOccurrenceBatchError,
  EmptyNameOccurrenceNamesError,
  MalformedNameOccurrenceError,
  NAME_LOOKUP_MAX,
  NAME_RECORD_MAX,
  NameOccurrenceBatchTooLargeError,
  NameOccurrenceNamesTooManyError,
  UnknownNameOccurrenceRepoError,
} from '@/lib/codeGraph/errors';
import type {
  NameOccurrenceInput,
  NameOccurrenceLookupDTO,
  NameOccurrenceReason,
  NameOccurrenceRecordDTO,
} from '@/lib/dto/nameOccurrences';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE NAME RECORD, over the MCP (MOTIR-11647 · story MOTIR-11497) — what
// `record_name_occurrences` / `lookup_name_occurrences` call. plan.py, holding only its
// Motir token, records where its author sessions found each code name and asks that
// record before any search, sharing the organisation-wide record the hosted planner
// keeps. motir-core holds no code-graph credential: both verbs forward through motir-ai
// (`POST /v1/code-graph/name-occurrences/record` and `/lookup`).
//
// The preamble is `codeGraphReadService.read`'s: the key resolves inside the actor's
// workspace (another tenant's key is the plain not-found), `ai:plan` is asserted before
// anything else is read, and the agent's `repo` is matched against the project's set in
// core, so a miss is refused with the set and no round trip.
//
// ⚠️ THE REFUSAL / DEGRADED LINE. The caller's own input — over a cap, empty, a
// duplicate, a malformed row, a repo outside the set — is a TYPED ERROR (fixable in one
// hop). Everything the FORWARD meets — motir-ai unconfigured, unreachable, a non-2xx, or
// motir-ai's own degraded 200 — is an ANSWER in the same shape: an all-miss look-up or
// `{ recorded: 0 }`, with a `note` sentence and a `reason` code. Mirrors the hosted
// planner's `lookUpNameOccurrences` in motir-ai `src/llm/nameOccurrences.ts`, which
// answers a miss for any failed call and never rejects.

/** Match an agent's `repo` against the set: `owner/name` first, then the bare name. */
function matchRepo(repo: string, repoSet: readonly string[]): string | null {
  const wanted = repo.trim().toLowerCase();
  if (!wanted) return null;
  const full = repoSet.find((r) => r.toLowerCase() === wanted);
  if (full) return full;
  return repoSet.find((r) => r.slice(r.lastIndexOf('/') + 1).toLowerCase() === wanted) ?? null;
}

/** A forward failure → its reason and one sentence; `null` for an error that is a bug here. */
function degradedBy(err: unknown): { reason: NameOccurrenceReason; note: string } | null {
  if (err instanceof MotirAiConfigError) {
    return {
      reason: 'ai_not_configured',
      note: 'motir-ai is not configured for this deployment, so the name record was not asked.',
    };
  }
  if (err instanceof MotirAiUnavailableError) {
    return {
      reason: 'ai_unreachable',
      note: 'motir-ai could not be reached or did not answer in time, so the name record was not asked.',
    };
  }
  if (err instanceof MotirAiError) {
    return {
      reason: 'ai_error',
      note: 'motir-ai answered the forward with an error (it may not serve the name record yet), so the name record was not asked.',
    };
  }
  return null;
}

/** motir-ai's own state sentence as a degraded answer's note, flattened to one line. */
function stateNote(
  state: string | undefined,
): { note: string; reason: 'record_unanswered' } | null {
  if (typeof state !== 'string' || state.trim() === '') return null;
  return { note: state.replace(/\s+/g, ' ').trim(), reason: 'record_unanswered' };
}

const isLine = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
const isText = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

/** Refuse a record batch the door will not forward; answer the rows as typed. */
function checkBatch(occurrences: readonly Partial<NameOccurrenceInput>[]): NameOccurrenceInput[] {
  if (occurrences.length === 0) throw new EmptyNameOccurrenceBatchError();
  if (occurrences.length > NAME_RECORD_MAX) {
    throw new NameOccurrenceBatchTooLargeError(occurrences.length);
  }
  return occurrences.map((o, i) => {
    if (!isText(o.blob)) throw new MalformedNameOccurrenceError(i, 'blob');
    if (!isText(o.name)) throw new MalformedNameOccurrenceError(i, 'name');
    if (!isLine(o.startLine)) throw new MalformedNameOccurrenceError(i, 'startLine');
    if (!isLine(o.endLine) || o.endLine < o.startLine) {
      throw new MalformedNameOccurrenceError(i, 'endLine');
    }
    return { blob: o.blob, name: o.name, startLine: o.startLine, endLine: o.endLine };
  });
}

/** Refuse a names list the door will not forward. */
function checkNames(names: readonly string[]): void {
  if (names.length === 0) throw new EmptyNameOccurrenceNamesError();
  if (names.length > NAME_LOOKUP_MAX) throw new NameOccurrenceNamesTooManyError(names.length);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new DuplicateNameOccurrenceNamesError(name);
    seen.add(name);
  }
}

/** The project and the matched repository, or a typed refusal. */
async function resolveTarget(
  projectKey: string,
  repo: string,
  ctx: ServiceContext,
): Promise<{ projectId: string; repoRef: string }> {
  const project = await projectsService.getByKey(projectKey, ctx);
  await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');
  // The ungated join `getPlanningCodeHealth` uses — legal because the gate ran.
  const { repos } = await resolveCodeContextState(project.id, ctx);
  const repoSet = repos.map((r) => r.repoRef);
  const repoRef = matchRepo(repo, repoSet);
  if (!repoRef) throw new UnknownNameOccurrenceRepoError(repo, repoSet);
  return { projectId: project.id, repoRef };
}

/** One entry per asked name, in the order asked, from whatever motir-ai answered. */
function inAskedOrder(
  names: readonly string[],
  answer: RawNameOccurrencesLookup | null,
): NameOccurrenceLookupDTO['names'] {
  const byName = new Map((answer?.names ?? []).map((e) => [e.name, e.occurrences]));
  return names.map((name) => ({
    name,
    occurrences: (byName.get(name) ?? []).map((o) => ({
      path: o.path,
      startLine: o.startLine,
      endLine: o.endLine,
      blob: o.blob,
    })),
  }));
}

export interface LookupNameOccurrencesArgs {
  repo: string;
  commit?: string;
  names: string[];
}

export interface RecordNameOccurrencesArgs {
  repo: string;
  occurrences: Partial<NameOccurrenceInput>[];
}

export const nameOccurrencesService = {
  async lookup(
    projectKey: string,
    args: LookupNameOccurrencesArgs,
    ctx: ServiceContext,
  ): Promise<NameOccurrenceLookupDTO> {
    const { projectId, repoRef } = await resolveTarget(projectKey, args.repo, ctx);
    checkNames(args.names);
    let answer: RawNameOccurrencesLookup;
    try {
      answer = await lookUpNameOccurrences({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        repoRef,
        names: [...args.names],
        ...(args.commit !== undefined ? { commit: args.commit } : {}),
      });
    } catch (err) {
      const degraded = degradedBy(err);
      if (degraded === null) throw err;
      console.warn('[name-occurrences] the look-up was not forwarded', { reason: degraded.reason });
      return { commit: null, names: inAskedOrder(args.names, null), ...degraded };
    }
    const state = stateNote(answer.state);
    if (state !== null) {
      return { commit: null, names: inAskedOrder(args.names, null), ...state };
    }
    return {
      commit: typeof answer.commit === 'string' ? answer.commit : null,
      names: inAskedOrder(args.names, answer),
      note: null,
      reason: null,
    };
  },

  async record(
    projectKey: string,
    args: RecordNameOccurrencesArgs,
    ctx: ServiceContext,
  ): Promise<NameOccurrenceRecordDTO> {
    const { projectId, repoRef } = await resolveTarget(projectKey, args.repo, ctx);
    const occurrences = checkBatch(args.occurrences);
    try {
      const answer = await recordNameOccurrences({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        repoRef,
        occurrences,
      });
      const recorded =
        typeof answer.recorded === 'number' && Number.isInteger(answer.recorded)
          ? Math.max(0, answer.recorded)
          : 0;
      const state = stateNote(answer.state);
      return state === null ? { recorded, note: null, reason: null } : { recorded, ...state };
    } catch (err) {
      const degraded = degradedBy(err);
      if (degraded === null) throw err;
      console.warn('[name-occurrences] the record was not forwarded', { reason: degraded.reason });
      return { recorded: 0, ...degraded };
    }
  },
};
