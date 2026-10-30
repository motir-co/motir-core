// Node-only motir-ai CODE-GRAPH READ boundary mock for E2E (Story MOTIR-7858 ·
// MOTIR-7866).
//
// The MCP `code_explore` / `code_search` / `code_grep` tools call motir-ai's
// `POST /v1/code-graph/read` through `motirAiClient.readCodeGraph`, inside the
// Next server, so nothing a Playwright runner does can see or answer that call.
// This is that seam, the SAME shape `test-code-health-mock` uses: an undici
// intercept on the shared `MockAgent`, installed from `lib/test-mock-seams.ts`
// behind `E2E_TEST_CODE_GRAPH_READ=1`, dormant everywhere else. The real client,
// the real service (the tenant, the gate, the repository set, the enrichment)
// and the real `/api/mcp` route all stay in the path.
//
// TWO FILES, as the GitHub merge seam has them and for the same reason:
//   * the FIXTURE (MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH) — the spec WRITES, the
//     mock READS, re-read on every request. A list of `{ match, answer }`; the
//     FIRST entry whose `match` fits the request answers it.
//   * the JOURNAL (MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH) — the mock APPENDS one
//     JSONL line per request (its bearer and its body), the spec READS it, which
//     is how a runner in another process proves what crossed the boundary.
//
// ⚠️ A REQUEST NO ENTRY MATCHES IS A 500, so a fixture the spec forgot to write
// fails loud rather than reading as some plausible state. (The service maps a 5xx
// to `graph_unavailable`, which the spec's own assertion then names.)

import type { CodeGraphReadRequest, RawCodeGraphRead } from '@/lib/ai/motirAiClient';
import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** What one fixture entry matches on. An omitted field matches anything;
 *  `cursor: null` matches a request that sent NO cursor (a page-1 read). */
export interface CodeGraphReadMatch {
  tool?: CodeGraphReadRequest['tool'];
  repos?: string[];
  cursor?: string | null;
}

export interface CodeGraphReadFixtureEntry {
  match: CodeGraphReadMatch;
  /** The route's answer — its own state union, sent as a 200. */
  answer: RawCodeGraphRead;
}

/** The fixture file: a list, first match wins. */
export type CodeGraphReadFixture = CodeGraphReadFixtureEntry[];

/** One journalled request (a JSONL line). */
export interface CodeGraphReadJournalLine {
  authorization: string | null;
  body: CodeGraphReadRequest;
}

const PATH = '/v1/code-graph/read';

interface MockReply {
  statusCode: number;
  data: object;
  responseOptions: { headers: Record<string, string> };
}

const reply = (statusCode: number, data: object): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

function readFixture(): CodeGraphReadFixture {
  const p = process.env['MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH'];
  if (!p) return [];
  try {
    const parsed: unknown = JSON.parse(readFixtureFileSync(p));
    return Array.isArray(parsed) ? (parsed as CodeGraphReadFixture) : [];
  } catch {
    // No file yet, or a half-written one: nothing matches, so every read is a 500.
    return [];
  }
}

function journal(line: CodeGraphReadJournalLine): void {
  const p = process.env['MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH'];
  if (!p) return;
  try {
    appendFixtureFileSync(p, `${JSON.stringify(line)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does `match` fit this request? */
export function codeGraphReadMatches(
  match: CodeGraphReadMatch,
  body: CodeGraphReadRequest,
): boolean {
  if (match.tool !== undefined && match.tool !== body.tool) return false;
  if (match.repos !== undefined && !sameList(match.repos, body.args?.repos)) return false;
  if (match.cursor !== undefined && (match.cursor ?? undefined) !== body.args?.cursor) {
    return false;
  }
  return true;
}

function headerOf(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name,
  );
  return entry ? String(entry[1]) : null;
}

export function installCodeGraphReadBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;

  agent
    .get(origin)
    .intercept({ path: PATH, method: 'POST' })
    .reply((req): MockReply => {
      let body: CodeGraphReadRequest;
      try {
        body = JSON.parse(String(req.body ?? '{}')) as CodeGraphReadRequest;
      } catch {
        return reply(400, { code: 'validation_error', status: 400, title: 'Bad Request' });
      }
      journal({ authorization: headerOf(req.headers, 'authorization'), body });
      const entry = readFixture().find((e) => codeGraphReadMatches(e.match, body));
      if (!entry) {
        return reply(500, {
          code: 'internal_error',
          status: 500,
          title: 'No code-graph read fixture matched this request',
        });
      }
      return reply(200, entry.answer);
    })
    .persist();
}
