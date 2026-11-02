// A planner session's CODE READS, as a value (MOTIR-10122): the caps both write
// doors enforce and the one parser every stored read goes through. Pure: no I/O.
//
// ⚠️ WHAT WAS ASKED AND HOW MUCH CAME BACK — NEVER THE CODE. A read names its
// tool, its file and range or its query and scope, the commit it was made at and
// a short outcome. There is no field a file's text could ride in, every string is
// capped, and `detail` is cut to a refusal's length, so a planner that put a
// file's contents into a field would store a truncated label, not the file.
//
// ⚠️ A COMMIT IS A RESOLVED HEX ID, NEVER A BRANCH NAME. The default branch moves
// within one plan, so a read cited as `main` cannot be re-opened as the code the
// session saw. Every `sha` must match `COMMIT_SHA_PATTERN` after normalization;
// a read whose ref resolved to nothing (a refused path, a ref that names no
// commit, a failure to ask) carries no commit at all, never a stand-in.

import { normalizeCommitSha } from '@/lib/git/commitSha';

/** The most reads one call may carry. */
export const PLAN_CODE_READ_BATCH_MAX = 50;
/** The most commits one read may cite — one per repository a graph read covered. */
export const PLAN_CODE_READ_COMMITS_MAX = 20;
/** The most rows one page of the read-back carries, and its default. */
export const PLAN_CODE_READ_PAGE_MAX = 500;

/** The longest value kept per field, in code points. */
export const PLAN_CODE_READ_FIELD_MAX = {
  tool: 40,
  repo: 200,
  path: 1024,
  askedRef: 200,
  query: 1000,
  outcome: 60,
  detail: 200,
} as const;

/** One commit a read was made at. */
export interface PlanCodeReadCommit {
  /** `owner/name`, or a local checkout's name; absent when the read named one repository. */
  repo?: string;
  /** The resolved hex id, lower-cased. */
  sha: string;
  /** A local checkout whose working tree had changes when the session read it. */
  dirty?: boolean;
}

/** One read, as parsed and ready to store (`planId`, `sessionKey`, `seq` are the store's). */
export interface PlanCodeReadFields {
  tool: string;
  repo: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  askedRef: string | null;
  query: string | null;
  commits: PlanCodeReadCommit[];
  outcome: string;
  lines: number | null;
  hits: number | null;
  detail: string | null;
}

/** A read the door refused, and why — the whole call is refused, nothing written. */
export class PlanCodeReadRefusal extends Error {}

const TOOL = /^[A-Za-z][A-Za-z0-9_.-]*(?: [A-Za-z][A-Za-z0-9_.-]*)?$/;
const OUTCOME = /^[a-z][a-z0-9_]*$/;
const CONTROL = /\p{Cc}/gu;

type Raw = Record<string, unknown>;

function cap(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/** An optional one-line string, trimmed, controls dropped and capped; `null` when absent or blank. */
function optionalText(
  raw: Raw,
  key: keyof typeof PLAN_CODE_READ_FIELD_MAX,
  at: string,
): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PlanCodeReadRefusal(`${at}.${key} must be a string.`);
  const text = value.replace(CONTROL, ' ').trim();
  return text.length === 0 ? null : cap(text, PLAN_CODE_READ_FIELD_MAX[key]);
}

function optionalCount(raw: Raw, key: string, at: string, min: number): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new PlanCodeReadRefusal(`${at}.${key} must be an integer of at least ${min}.`);
  }
  return value as number;
}

function parseCommit(raw: unknown, at: string): PlanCodeReadCommit {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanCodeReadRefusal(`${at} must be an object { repo?, sha, dirty? }.`);
  }
  const c = raw as Raw;
  const sha = typeof c.sha === 'string' ? normalizeCommitSha(c.sha) : null;
  if (!sha?.ok) {
    throw new PlanCodeReadRefusal(
      `${at}.sha must be a resolved commit id (7 to 64 hex characters), never a branch name.`,
    );
  }
  const repo = optionalText(c, 'repo', at);
  if (c.dirty !== undefined && typeof c.dirty !== 'boolean') {
    throw new PlanCodeReadRefusal(`${at}.dirty must be a boolean.`);
  }
  return { ...(repo ? { repo } : {}), sha: sha.commitSha, ...(c.dirty ? { dirty: true } : {}) };
}

function parseCommits(raw: unknown, at: string): PlanCodeReadCommit[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > PLAN_CODE_READ_COMMITS_MAX) {
    throw new PlanCodeReadRefusal(
      `${at}.commits must be an array of at most ${PLAN_CODE_READ_COMMITS_MAX} commits.`,
    );
  }
  return raw.map((c, i) => parseCommit(c, `${at}.commits[${i}]`));
}

function requiredText(raw: Raw, key: 'tool' | 'outcome', pattern: RegExp, at: string): string {
  const value = optionalText(raw, key, at);
  if (value === null || !pattern.test(value)) {
    throw new PlanCodeReadRefusal(
      key === 'tool'
        ? `${at}.tool must name the tool, e.g. "read_file" or "git show".`
        : `${at}.outcome must be the result's outcome code, e.g. "found" or "too_large".`,
    );
  }
  return value;
}

/** Parse ONE read, or throw {@link PlanCodeReadRefusal} naming the field. */
export function parsePlanCodeRead(raw: unknown, at = 'codeReads[0]'): PlanCodeReadFields {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanCodeReadRefusal(`${at} must be an object.`);
  }
  const r = raw as Raw;
  if ('text' in r || 'content' in r) {
    throw new PlanCodeReadRefusal(
      `${at} carries file content; a read records what was asked, never the code.`,
    );
  }
  const startLine = optionalCount(r, 'startLine', at, 1);
  const endLine = optionalCount(r, 'endLine', at, 1);
  if (startLine !== null && endLine !== null && endLine < startLine) {
    throw new PlanCodeReadRefusal(`${at}.endLine must not be before startLine.`);
  }
  return {
    tool: requiredText(r, 'tool', TOOL, at),
    repo: optionalText(r, 'repo', at),
    path: optionalText(r, 'path', at),
    startLine,
    endLine,
    askedRef: optionalText(r, 'askedRef', at),
    query: optionalText(r, 'query', at),
    commits: parseCommits(r.commits, at),
    outcome: requiredText(r, 'outcome', OUTCOME, at),
    lines: optionalCount(r, 'lines', at, 0),
    hits: optionalCount(r, 'hits', at, 0),
    detail: optionalText(r, 'detail', at),
  };
}

/** Parse a whole call's batch: 1 to {@link PLAN_CODE_READ_BATCH_MAX} reads, every one valid. */
export function parsePlanCodeReads(raw: unknown): PlanCodeReadFields[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_CODE_READ_BATCH_MAX) {
    throw new PlanCodeReadRefusal(
      `\`codeReads\` is 1 to ${PLAN_CODE_READ_BATCH_MAX} reads — nothing was recorded.`,
    );
  }
  return raw.map((r, i) => parsePlanCodeRead(r, `codeReads[${i}]`));
}
