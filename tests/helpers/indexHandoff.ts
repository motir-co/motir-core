import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { INDEX_AI_URL, INDEX_SERVICE_TOKEN, stubAppCredentials } from './indexFleet';

// THE INDEX HANDOFF'S WORLD (MOTIR-11883). Both index jobs hand the index to
// motir-ai and poll its status route, so this world stubs exactly two hosts at the
// HTTP boundary — motir-ai and GitHub — and records every request each received:
//
//   motir-ai  POST /v1/credits/index-check       the index allowance
//             POST /v1/code-graph/index-handoff  recorded; answers `handoff`
//             GET  /v1/code-graph/index-status   answers the next `statuses` entry
//             GET  /v1/code-audit                "already audited" (a neutral first audit)
//   GitHub    /access_tokens                     an installation token
//             /commits/<ref>                     the live head, `handoffWorld.head`
//             /compare/<base>...<head>           `handoffWorld.compare` (MOTIR-11887)
//             /tarball/<ref>                     a 302 to a URL carrying `SOURCE_URL_SENTINEL`
//
// Any other request throws, so a call to the container path (a credential mint, a
// verdict read) fails the suite by name rather than passing quietly.

/** The live default-branch head GitHub answers. */
export const HANDOFF_HEAD = 'c0ffee'.padEnd(40, '1');
/** A different, older commit. */
export const HANDOFF_OLDER = 'beef'.padEnd(40, '2');
/** Planted in every minted source URL; the secrecy guards search for it. */
export const SOURCE_URL_SENTINEL = `sentinel-${randomUUID()}`;

/** The pre-signed URL GitHub's 302 names for `ref`. */
export function presignedUrlFor(ref: string): string {
  return `https://codeload.github.com/moooon/motir-core/legacy.tar.gz/${ref}?token=${SOURCE_URL_SENTINEL}`;
}

type StatusAnswer = Record<string, unknown>;

export const handoffWorld: {
  allowanceOutcome: string;
  /** The head `/commits/<ref>` answers; `HANDOFF_HEAD` unless a case moves it. */
  head: string;
  /** What the handoff answers: accepted, the registration retry, or a refusal. */
  handoff: 'accepted' | 'rate_limited' | 'refused';
  /** Answered in order; the last entry repeats. */
  statuses: StatusAnswer[];
  handoffs: Record<string, unknown>[];
  jobIds: string[];
  statusReads: { coreOrganizationId: string | null; repoRef: string | null }[];
  tarballRefs: string[];
  headReads: string[];
  aiPaths: string[];
  /**
   * What GitHub's comparison answers (MOTIR-11887): the files it lists, or a
   * status it refuses with. `null` (the default) throws, so a case that never
   * expected a comparison fails by name if one is asked.
   */
  compare: { files: GithubCompareFile[] } | { status: number } | null;
  /** Every comparison asked, as `base...head`. */
  compareReads: string[];
} = {
  allowanceOutcome: 'ok',
  head: HANDOFF_HEAD,
  handoff: 'accepted',
  statuses: [],
  handoffs: [],
  jobIds: [],
  statusReads: [],
  tarballRefs: [],
  headReads: [],
  aiPaths: [],
  compare: null,
  compareReads: [],
};

/** One `files[]` entry of GitHub's compare answer — names only. */
export interface GithubCompareFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  previous_filename?: string;
}

/** A status answer: the four fields, every one null unless given. */
export function statusAnswer(fields: Partial<Record<string, unknown>> = {}): StatusAnswer {
  return {
    state: 'not_indexed',
    indexedCommit: null,
    inProgressJob: null,
    lastFailure: null,
    ...fields,
  };
}

/** Published at `commit`, at `when` (a fixed past instant unless given). */
export const publishedAt = (commit: string, when = '2026-11-22T10:00:00.000Z'): StatusAnswer =>
  statusAnswer({
    state: 'indexed',
    indexedCommit: { commit, publishedAt: when },
  });

/** A job for `commit` still running. */
export const runningAt = (commit: string): StatusAnswer =>
  statusAnswer({
    inProgressJob: {
      jobId: randomUUID(),
      kind: 'first_index',
      commit,
      ref: 'main',
      state: 'running',
      enqueuedAt: '2026-11-22T10:00:00.000Z',
      startedAt: '2026-11-22T10:00:01.000Z',
    },
  });

/**
 * The last failure, at `commit`. `when` defaults to a minute after the moment the
 * answer is built, so a failure staged before a run reads as that run's own: a run
 * counts a failure only when it came after its handoff.
 */
export const failedAt = (
  commit: string,
  reason: string,
  message: string,
  when: string = new Date(Date.now() + 60_000).toISOString(),
): StatusAnswer =>
  statusAnswer({
    lastFailure: {
      reason,
      commit,
      kind: 'first_index',
      message,
      failedAt: when,
    },
  });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function allowanceVerdict(outcome: string): unknown {
  return {
    outcome,
    mayIndex: !outcome.startsWith('hard_stop_'),
    window: '2026-11',
    grantedCredits: 400,
    consumedCredits: 0,
    attributedCredits: 0,
  };
}

/** Install the world. Call in `beforeEach`; `vi.unstubAllGlobals` removes it. */
export function stubIndexHandoff(): void {
  handoffWorld.allowanceOutcome = 'ok';
  handoffWorld.head = HANDOFF_HEAD;
  handoffWorld.handoff = 'accepted';
  handoffWorld.statuses = [publishedAt(HANDOFF_HEAD)];
  handoffWorld.handoffs = [];
  handoffWorld.jobIds = [];
  handoffWorld.statusReads = [];
  handoffWorld.tarballRefs = [];
  handoffWorld.headReads = [];
  handoffWorld.aiPaths = [];
  handoffWorld.compare = null;
  handoffWorld.compareReads = [];
  stubAppCredentials();
  vi.stubEnv('MOTIR_AI_URL', INDEX_AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', INDEX_SERVICE_TOKEN);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(String(url));
      if (parsed.host === new URL(INDEX_AI_URL).host) {
        handoffWorld.aiPaths.push(parsed.pathname);
        if (parsed.pathname === '/v1/credits/index-check') {
          return json(200, allowanceVerdict(handoffWorld.allowanceOutcome));
        }
        if (parsed.pathname === '/v1/code-graph/index-handoff') {
          handoffWorld.handoffs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (handoffWorld.handoff === 'rate_limited') {
            return json(429, { code: 'rate_limited', status: 429, title: 'retry shortly' });
          }
          if (handoffWorld.handoff === 'refused') {
            return json(500, {
              code: 'ai_job_failed',
              status: 500,
              title: 'refused',
              detail: 'code-graph service refused the index call: unavailable',
            });
          }
          const jobId = randomUUID();
          handoffWorld.jobIds.push(jobId);
          return json(202, { jobId });
        }
        if (parsed.pathname === '/v1/code-graph/index-status') {
          handoffWorld.statusReads.push({
            coreOrganizationId: parsed.searchParams.get('coreOrganizationId'),
            repoRef: parsed.searchParams.get('repoRef'),
          });
          const index = Math.min(handoffWorld.statusReads.length, handoffWorld.statuses.length) - 1;
          return json(200, handoffWorld.statuses[index]);
        }
        if (parsed.pathname === '/v1/code-audit') {
          return json(200, {
            audit: {
              id: 'audit_fixture',
              healthSummary: {},
              codeGraphRef: 'cg_fixture',
              repoKey: 'moooon/motir-core',
              createdAt: new Date(0).toISOString(),
            },
            findings: [],
            total: 0,
            nextOffset: null,
          });
        }
        throw new Error(`unexpected motir-ai request ${parsed.pathname}`);
      }
      if (parsed.pathname.endsWith('/access_tokens')) {
        return json(201, {
          token: 'ghs_installation_token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const commits = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(parsed.pathname);
      if (commits) {
        handoffWorld.headReads.push(decodeURIComponent(commits[1]!));
        return new Response(handoffWorld.head, { status: 200 });
      }
      const compare = /\/repos\/[^/]+\/[^/]+\/compare\/([^/]+)$/.exec(parsed.pathname);
      if (compare) {
        handoffWorld.compareReads.push(decodeURIComponent(compare[1]!));
        const answer = handoffWorld.compare;
        if (answer === null) throw new Error(`unexpected comparison ${parsed.pathname}`);
        if ('status' in answer) return json(answer.status, { message: 'Server Error' });
        return json(200, { files: answer.files, commits: [] });
      }
      const tarball = /\/repos\/[^/]+\/[^/]+\/tarball\/([^/]+)$/.exec(parsed.pathname);
      if (tarball) {
        const ref = decodeURIComponent(tarball[1]!);
        handoffWorld.tarballRefs.push(ref);
        return new Response(null, { status: 302, headers: { location: presignedUrlFor(ref) } });
      }
      throw new Error(`unexpected fetch to ${parsed.href}`);
    }),
  );
}
