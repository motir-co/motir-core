import type { Page } from '@playwright/test';
import { jobStreamBody } from './job-stream-frames';

// The onboarding specs' BROWSER-SIDE stubs (Story MOTIR-8238 · MOTIR-8257),
// shared so a new walk does not copy them.
//
// Every lane runs the app in a separate `next start` process, so an in-process
// module mock cannot reach it. These stubs sit on the browser side of that
// boundary instead (`page.route`), which is where the open-core split already
// draws it: the browser only ever talks to motir-core's own routes.
//
//   - `stubDiscoveryApi` — the three motir-ai-backed endpoints the discovery
//     chat reads (`/api/ai/pre-plan`, `POST /api/ai/chat`, its SSE stream).
//     Moved out of `onboarding-discovery.spec.ts`, behaviour unchanged.
//   - `stubMigrateRoutes` — the migrate run's state machine (start, advance,
//     skip import, index status, the resume read). Moved out of
//     `onboarding-migrate.spec.ts`, behaviour unchanged, except that
//     `completeIndex()` only flips the state: the wait for the wizard's next
//     poll belongs to the spec that needs it, not to a shared helper.

// ── Discovery (motir-ai) ─────────────────────────────────────────────────────

/** The plain-language tier titles the reader renders (`DirectionDocView`'s h1, from `TIER_META`). */
export const TIER_TITLE = {
  discovery: 'Understanding your project',
  vision: "What we'll build",
  feasibility: 'Is it worth building?',
  validation: 'Will people want it?',
} as const;

/** A recognizable body sentence per tier, so a spec asserts the doc body — not just its chrome. */
export const TIER_BODY = {
  discovery: 'Freelancers who bill clients hate chasing invoices.',
  vision: 'A calm invoicing workspace that sends and tracks for you.',
  feasibility: 'The unit economics work at a low monthly price.',
  validation: 'Ten freelancers said they would switch today.',
} as const;

export type Tier = keyof typeof TIER_TITLE;
export const TIERS: Tier[] = ['discovery', 'vision', 'feasibility', 'validation'];

export const EMPTY_PREPLAN = { session: null, docs: [], catalog: null };

function tierDoc(kind: Tier) {
  return {
    kind,
    // The reader strips this leading `# …` title and shows TIER_TITLE instead;
    // the rest is the rendered body.
    currentBody: `# ${kind} (Tier)\n\n${TIER_BODY[kind]}`,
    currentVersion: 1,
    summary: [],
    versions: [
      {
        version: 1,
        changeReason: null,
        changeKind: null,
        diff: null,
        createdAt: '2026-06-21T00:00:00.000Z',
      },
    ],
  };
}

/** The full pre-plan read once the interview has produced everything: all 4 tiers + the catalog. */
export const FULL_PREPLAN = {
  session: {
    classification: 'startup',
    platform: 'web',
    designStarter: null,
    validationTiming: 'standard',
    docSkipSet: [] as string[],
    currentGate: 'validation',
    status: 'active',
    conversation: [],
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  },
  docs: TIERS.map(tierDoc),
  catalog: {
    categories: [
      {
        id: 'cat_1',
        title: 'Invoicing',
        features: [
          {
            id: 'f1',
            name: 'Recurring invoices',
            descriptionMd: 'Auto-send on a schedule.',
            phase: 'mvp',
            status: 'todo',
          },
          {
            id: 'f2',
            name: 'Payment reminders',
            descriptionMd: 'Nudge late payers.',
            phase: 'v1',
            status: 'todo',
          },
        ],
      },
    ],
    glossary: [
      {
        id: 'g1',
        title: 'Core',
        concepts: [
          {
            id: 'c1',
            term: 'Invoice',
            aka: null,
            descriptionMd: 'A bill sent to a client.',
            example: null,
          },
        ],
      },
    ],
  },
};

/** The conductor job `stubDiscoveryApi`'s chat door answers with. */
const CONDUCTOR_JOB_ID = 'job_test';

/** The conductor SSE: an assistant turn + one docs frame announcing all four tiers,
 *  on motir-ai's wire — each in its `{ jobId, seq, data }` envelope (MOTIR-10880). */
export const CONDUCTOR_SSE = jobStreamBody(CONDUCTOR_JOB_ID, [
  ['assistant', { text: "Here's the direction I've put together." }],
  ['docs', { docs: TIERS.map((kind, i) => ({ id: `d${i + 1}`, kind, version: 1 })) }],
]);

/** A conductor turn that only replies: no tiers, so the loop stays on the hub. */
export const CONDUCTOR_REPLY_SSE = jobStreamBody(CONDUCTOR_JOB_ID, [
  ['assistant', { text: 'Who is it for?' }],
]);

/**
 * Stub the three motir-ai-backed endpoints. Pre-plan returns the EMPTY state
 * until a chat turn is submitted, then the FULL 4-tier + catalog state — gated
 * on the POST having happened (robust to however many times the hook re-reads
 * pre-plan on mount).
 *
 * `produceTiers: false` keeps the interview at its first question: the turn is
 * answered with a reply alone and pre-plan stays EMPTY, so the hub (canvas +
 * chat rail) stays on screen instead of opening the last tier's review. An
 * entrance idea is sent as the first turn on arrival, so a walk that comes in
 * from the entrance needs this to see the hub at all.
 */
export async function stubDiscoveryApi(
  page: Page,
  { produceTiers = true }: { produceTiers?: boolean } = {},
): Promise<void> {
  let turnSubmitted = false;

  await page.route('**/api/ai/pre-plan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(produceTiers && turnSubmitted ? FULL_PREPLAN : EMPTY_PREPLAN),
    });
  });

  await page.route('**/api/ai/chat', async (route) => {
    turnSubmitted = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: CONDUCTOR_JOB_ID }),
    });
  });

  await page.route('**/api/ai/chat/*/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: produceTiers ? CONDUCTOR_SSE : CONDUCTOR_REPLY_SSE,
    });
  });
}

// ── The migrate run ──────────────────────────────────────────────────────────

export interface RepoStatus {
  provider: string;
  repoRef: string;
  /** The per-repo state the index read reports (MOTIR-8768). */
  status: 'indexed' | 'queued' | 'indexing' | 'failed';
}

export function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-mig',
    projectId: 'p1',
    kind: 'migrate',
    step: 'connect',
    status: 'active',
    connectedRepoRef: null,
    codeGraphReady: false,
    conventionApprovedAt: null,
    discoveryJobId: null,
    generateJobId: null,
    importSkipped: false,
    importCompleted: false,
    latestImport: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeIndexStatus(repos: RepoStatus[]) {
  const indexed = repos.filter((r) => r.status === 'indexed').length;
  return {
    repos,
    indexedCount: indexed,
    failedCount: repos.filter((r) => r.status === 'failed').length,
    total: repos.length,
    hasRunning: repos.some((r) => r.status === 'indexing'),
    allIndexed: indexed === repos.length,
  };
}

export interface MigrateStubs {
  /** Flip every repo to indexed; the wizard picks it up on its next poll. */
  completeIndex(): void;
}

/**
 * Install page.route stubs that simulate the migrate state machine.
 *
 * The closure holds mutable state so `step` advances on each
 * POST …/advance and GET …/index-status returns the current repo list.
 */
export async function stubMigrateRoutes(page: Page): Promise<MigrateStubs> {
  let step: string = 'connect';
  const repos: RepoStatus[] = [
    { provider: 'github', repoRef: 'acme/web', status: 'queued' },
    { provider: 'github', repoRef: 'acme/api', status: 'queued' },
    { provider: 'github', repoRef: 'acme/shared', status: 'queued' },
  ];
  let allIndexed = false;

  await page.route('**/api/onboarding/migrate**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    // POST /api/onboarding/migrate — start a new run
    if (method === 'POST' && url.endsWith('/migrate')) {
      step = 'connect';
      await route.fulfill({
        status: 200,
        json: makeRun({ step: 'connect' }),
      });
      return;
    }

    // POST .../advance — move to the next step
    if (method === 'POST' && url.includes('/advance')) {
      const next: Record<string, string> = {
        connect: 'index',
        index: 'import',
        // The wizard ends at Import (MOTIR-8246, design MOTIR-8767 revision A).
        import: 'done',
        audit_convention: 'discovery',
        discovery: 'generate',
        generate: 'review',
        review: 'done',
      };
      step = next[step] ?? 'done';
      const pastSetup = !['connect', 'index'].includes(step);
      await route.fulfill({
        status: 200,
        json: makeRun({
          step,
          ...(step === 'done' ? { status: 'completed' } : {}),
          codeGraphReady: pastSetup,
          importSkipped: !['connect', 'index', 'import'].includes(step),
          connectedRepoRef: 'acme/web',
        }),
      });
      return;
    }

    // POST .../skip-import — skip the optional import step, which ends the run
    if (method === 'POST' && url.includes('/skip-import')) {
      step = 'done';
      await route.fulfill({
        status: 200,
        json: makeRun({ step: 'done', status: 'completed', importSkipped: true }),
      });
      return;
    }

    // POST .../enter — Enter Motir from Index or Import (MOTIR-8770): the run
    // completes and the index keeps going.
    if (method === 'POST' && url.includes('/enter')) {
      step = 'done';
      await route.fulfill({
        status: 200,
        json: makeRun({ step: 'done', status: 'completed', connectedRepoRef: 'acme/web' }),
      });
      return;
    }

    // GET .../index-status — return per-repo progress (drives aria-live region)
    if (method === 'GET' && url.includes('/index-status')) {
      const out = allIndexed ? repos.map((r) => ({ ...r, status: 'indexed' as const })) : repos;
      await route.fulfill({ status: 200, json: makeIndexStatus(out) });
      return;
    }

    // GET .../connect-state — the Connect step's own read (MOTIR-8472): an
    // installation bound to the organisation, with the three repositories connected.
    if (method === 'GET' && url.includes('/connect-state')) {
      await route.fulfill({
        status: 200,
        json: {
          organizationId: 'org-mig',
          installation: {
            bound: true,
            accounts: [{ installationRef: '1', accountLogin: 'acme', accountType: 'Organization' }],
          },
          repositories: repos.map((r) => ({
            provider: r.provider,
            repoRef: r.repoRef,
            defaultBranch: 'main',
          })),
          outcome: 'already_connected',
          snapshot: 'stub-snapshot',
        },
      });
      return;
    }

    // GET .../:id — resume head read (the page's server-component read)
    if (method === 'GET' && url.match(/\/migrate\/[^/]+$/)) {
      await route.fulfill({ status: 200, json: makeRun({ step }) });
      return;
    }

    await route.continue();
  });

  return {
    completeIndex() {
      allIndexed = true;
    },
  };
}
