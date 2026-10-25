import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { embedTexts } from '@/lib/ai/motirAiClient';
import {
  EMBEDDINGS_MOCK_MODEL,
  installEmbeddingsBoundaryMock,
  topicVector,
  type EmbeddingsJournalLine,
} from '@/lib/test-embeddings-mock';
import { embeddingsSeamEnv } from './e2e/_helpers/job-worker-process';

// The motir-ai EMBEDDINGS seam the page-meaning acceptance spec stands on
// (Story MOTIR-9490 · MOTIR-9577), driven through the REAL `embedTexts` client:
// the recipe's page and query share an axis and no word, the control file turns
// every call into a 503, the journal records each call, and the job worker gets
// the seam with the same two files.

const AI = 'https://ai.embeddings-seam.test';
const dir = mkdtempSync(path.join(tmpdir(), 'embeddings-seam-'));
const controlPath = path.join(dir, 'control.json');
const journalPath = path.join(dir, 'journal.jsonl');
let previous: Dispatcher;

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const journal = (): EmbeddingsJournalLine[] =>
  readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EmbeddingsJournalLine);

beforeAll(() => {
  previous = getGlobalDispatcher();
  vi.stubEnv('MOTIR_AI_URL', AI);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  vi.stubEnv('MOTIR_AI_EMBEDDINGS_CONTROL_PATH', controlPath);
  vi.stubEnv('MOTIR_AI_EMBEDDINGS_JOURNAL_PATH', journalPath);
  const agent = new MockAgent();
  agent.disableNetConnect();
  installEmbeddingsBoundaryMock(agent);
  setGlobalDispatcher(agent);
});

beforeEach(() => {
  writeFileSync(controlPath, JSON.stringify({ mode: 'healthy' }));
  writeFileSync(journalPath, '');
});

afterAll(() => {
  setGlobalDispatcher(previous);
  vi.unstubAllEnvs();
});

describe('the embeddings seam', () => {
  it('answers the real client with deterministic topic vectors, and journals the call', async () => {
    const page = 'On-call rota\n\nengineers take turns answering overnight incidents';
    const query = 'who gets woken up when production breaks';
    const plants = 'houseplants watering';

    const batch = await embedTexts([page, query, plants]);

    expect(batch.model).toBe(EMBEDDINGS_MOCK_MODEL);
    expect(batch.dimensions).toBe(1536);
    const [p, q, w] = batch.embeddings as [number[], number[], number[]];
    expect(p).toHaveLength(1536);
    expect(cosine(p, q)).toBeCloseTo(1, 6);
    expect(cosine(p, w)).toBeCloseTo(0, 6);
    expect(topicVector(query)).toEqual(q);
    expect(journal()).toEqual([{ input: [page, query, plants], status: 200 }]);
  });

  it('gives a text with no topic word an axis of its own', () => {
    expect(cosine(topicVector('alpha beta'), topicVector('gamma delta'))).toBeCloseTo(0, 6);
  });

  it('answers 503 while the control file says unavailable, and journals that too', async () => {
    writeFileSync(controlPath, JSON.stringify({ mode: 'unavailable' }));

    await expect(embedTexts(['rota'])).rejects.toThrow();
    expect(journal()).toEqual([{ input: ['rota'], status: 503 }]);

    writeFileSync(controlPath, JSON.stringify({ mode: 'healthy' }));
    expect((await embedTexts(['rota'])).embeddings).toHaveLength(1);
  });
});

describe('the job worker gets the same seam', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('mirrors nothing unless the lane opts in', () => {
    vi.stubEnv('E2E_JOB_WORKER_EMBEDDINGS_SEAM', '');
    expect(embeddingsSeamEnv()).toEqual({});
  });

  it('mirrors the flag and both files', () => {
    vi.stubEnv('E2E_JOB_WORKER_EMBEDDINGS_SEAM', '1');
    vi.stubEnv('MOTIR_AI_EMBEDDINGS_CONTROL_PATH', '/tmp/c.json');
    vi.stubEnv('MOTIR_AI_EMBEDDINGS_JOURNAL_PATH', '/tmp/j.jsonl');
    expect(embeddingsSeamEnv()).toEqual({
      E2E_TEST_EMBEDDINGS: '1',
      MOTIR_AI_EMBEDDINGS_CONTROL_PATH: '/tmp/c.json',
      MOTIR_AI_EMBEDDINGS_JOURNAL_PATH: '/tmp/j.jsonl',
    });
  });

  it('is switched on by the acceptance lane, on its server and its worker', () => {
    const config = readFileSync(
      path.join(process.cwd(), 'playwright.acceptance.config.ts'),
      'utf8',
    );
    expect(config).toMatch(/process\.env\['E2E_JOB_WORKER_EMBEDDINGS_SEAM'\] \?\?= '1'/);
    expect(config).toMatch(/E2E_TEST_EMBEDDINGS: '1'/);
  });
});
