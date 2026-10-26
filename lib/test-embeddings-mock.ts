// Node-only motir-ai EMBEDDINGS boundary mock for E2E (Story MOTIR-9490 ·
// MOTIR-9577).
//
// Page search by meaning crosses motir-ai's `POST /v1/embeddings` twice, in two
// processes: the job WORKER embeds a page after every save
// (`pageEmbeddingsService.embedPage`), and the Next SERVER embeds the query
// (`workItemEmbeddingsService.embedQuery`). Neither call is reachable from a
// Playwright runner, so this is that seam, the SAME shape
// `test-code-graph-read-mock` uses: an undici intercept on the shared
// `MockAgent`, installed from `lib/test-mock-seams.ts` behind
// `E2E_TEST_EMBEDDINGS=1`, dormant everywhere else. The real client, the real
// job, the real search and the real routes all stay in the path.
//
// THE VECTORS ARE A TOPIC FUNCTION, deterministic and stateless, so the server
// and the worker agree without sharing memory: each topic owns one axis, a
// text's vector is the normalised count of its topic words, and a text with
// none gets an axis of its own. A page and a query on one topic share an axis
// and no word ("engineers take turns answering overnight incidents" and "who
// gets woken up when production breaks").
//
// TWO FILES, both re-read on every request, so one file steers both processes:
//   * the CONTROL (MOTIR_AI_EMBEDDINGS_CONTROL_PATH) — the spec WRITES
//     `{ "mode": "unavailable" }` to make every call a 503, which is the
//     degraded arm `embedQuery` turns into `full-text-only`. Absent, or any
//     other mode, answers.
//   * the JOURNAL (MOTIR_AI_EMBEDDINGS_JOURNAL_PATH) — one JSONL line per
//     request (its texts and the status it got), which is how a runner proves
//     what did, and did not, cross the boundary.

import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** What the control file says the backend does. */
export interface EmbeddingsControl {
  mode: 'healthy' | 'unavailable';
}

/** One journalled request (a JSONL line). */
export interface EmbeddingsJournalLine {
  input: string[];
  status: number;
}

export const EMBEDDINGS_MOCK_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const PATH = '/v1/embeddings';

/** Each topic's axis and its words. Page text uses some, queries use others. */
const TOPICS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [
    1,
    [
      'call',
      'rota',
      'engineers',
      'turns',
      'answering',
      'overnight',
      'incidents',
      'escalation',
      'outages',
      'woken',
      'production',
      'breaks',
    ],
  ],
  [2, ['office', 'plants', 'ficus', 'ferns', 'water', 'fridays', 'houseplants', 'watering']],
];

/** An axis of its own for a text with no topic word, so unrelated texts are orthogonal. */
function ownAxis(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 100 + (h % 1400);
}

/** The deterministic vector for one text. */
export function topicVector(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const v = Array.from({ length: DIMENSIONS }, (): number => 0);
  for (const [axis, vocabulary] of TOPICS) {
    v[axis] = words.filter((w) => vocabulary.includes(w)).length;
  }
  if (!v.some((x) => x !== 0)) v[ownAxis(text)] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function readControl(): EmbeddingsControl {
  const p = process.env['MOTIR_AI_EMBEDDINGS_CONTROL_PATH'];
  if (!p) return { mode: 'healthy' };
  try {
    const parsed = JSON.parse(readFixtureFileSync(p)) as Partial<EmbeddingsControl> | null;
    return { mode: parsed?.mode === 'unavailable' ? 'unavailable' : 'healthy' };
  } catch {
    // No file yet, or a half-written one: the backend answers.
    return { mode: 'healthy' };
  }
}

function journal(line: EmbeddingsJournalLine): void {
  const p = process.env['MOTIR_AI_EMBEDDINGS_JOURNAL_PATH'];
  if (!p) return;
  try {
    appendFixtureFileSync(p, `${JSON.stringify(line)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

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

export function installEmbeddingsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;

  agent
    .get(origin)
    .intercept({ path: PATH, method: 'POST' })
    .reply((req): MockReply => {
      let input: string[];
      try {
        const body = JSON.parse(String(req.body ?? '{}')) as { input?: unknown };
        input = Array.isArray(body.input) ? body.input.map(String) : [];
      } catch {
        return reply(400, { code: 'validation_error', status: 400, title: 'Bad Request' });
      }
      if (readControl().mode === 'unavailable') {
        journal({ input, status: 503 });
        return reply(503, {
          code: 'service_unavailable',
          status: 503,
          title: 'The embedding backend is unavailable (E2E control file)',
        });
      }
      journal({ input, status: 200 });
      return reply(200, {
        model: EMBEDDINGS_MOCK_MODEL,
        dimensions: DIMENSIONS,
        embeddings: input.map(topicVector),
      });
    })
    .persist();
}
