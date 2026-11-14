import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// ════════════════════════════════════════════════════════════════════════════
// THE STORY GATE FOR MOTIR-3943 (motir-core half) — EVERY ENTRANCE, ONE KIND
// ════════════════════════════════════════════════════════════════════════════
//
// Each subtask in this story verifies its own submit. This asserts the ASSEMBLED
// behaviour, because the property the story promises lives in a JOIN no single
// card can test: SIX entrances, ONE kind on the wire, and the distinction they
// used to carry in that kind now carried by the CONTEXT instead.
//
// ⚠️ ASSERTED ON THE REQUEST BODY, NOT ON `submitJob`'s ARGUMENTS. Every sibling
// suite in this directory mocks `@/lib/ai/motirAiClient` and reads the args the
// service passed — which is right for what those cards are about, and one layer
// short for this one. This story is about WHAT CROSSES THE WIRE, so the client is
// REAL here and the boundary is stubbed at the HTTP seam: what is asserted is the
// JSON motir-ai would have received. That additionally proves `submitJob` builds
// the envelope around the kind, which no argument assertion can see.
//
// Everything below the HTTP boundary is real — real Postgres, the real services,
// the real `plansService` transactions, the real envelope builder.

import { db } from '@/lib/db';
import { JOB_KINDS } from '@/lib/ai/types';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture as makeFixture, createTestWorkItem } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkItemFixture } from '../../fixtures';
import type { UsageRunDTO } from '@/lib/dto/aiUsage';

const ORIGIN = 'http://motir-ai.one-kind-gate.test';

/** The five planning kinds this story retired — none may reappear on a submit. */
const RETIRED = ['generate_tree', 'expand_item', 'augment', 'replan', 'revise_plan'] as const;

/** Every request body the seam received, in order. */
const bodies: Record<string, unknown>[] = [];

let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-one-kind-gate-'));
  const fixture = join(dir, 'jobs.json');
  writeFileSync(fixture, JSON.stringify({}));
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixture);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);

  // ⚠️ INSTALLED ONCE, deliberately. `observeAiJobSubmit` keeps its subscribers
  // in module scope, so installing per-test (or resetting the module registry
  // between tests) would stack observers and double every capture.
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  bodies.length = 0;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** A story to anchor `expand` at — it rejects a non-container. */
async function seedStory(fx: WorkItemFixture): Promise<string> {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story: Login' });
  return story.identifier;
}

/** A `planned` plan for a revision to be held against. */
async function plannedPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

type Ctx = Record<string, unknown>;
const ctxOf = (b: Record<string, unknown>): Ctx => (b['context'] ?? {}) as Ctx;

/** Drive all five entrances once, and hand back the bodies they put on the wire.
 *  (There were six until MOTIR-4261 retired `submitReplan` with the `/api/ai/replan`
 *  route that was its only caller — on the wire it was byte-identical to `expand`.) */
async function driveAllFive(): Promise<Record<string, Record<string, unknown>>> {
  const fx = await makeFixture();
  const c = projectCtx(fx);
  const storyKey = await seedStory(fx);
  const planId = await plannedPlan(fx);

  const at = (n: number) => bodies[n]!;
  const out: Record<string, Record<string, unknown>> = {};

  bodies.length = 0;
  await aiGenerationService.startGeneration(c, { prompt: 'build a thing' });
  out['generation'] = at(0);

  bodies.length = 0;
  await aiPlanEditsService.submitAugment('add a login flow', c);
  out['augment'] = at(0);

  bodies.length = 0;
  await aiPlanEditsService.submitContextual('split this story', [storyKey], c);
  out['contextual'] = at(0);

  bodies.length = 0;
  await aiPlanEditsService.submitExpand(storyKey, c);
  out['expand'] = at(0);

  bodies.length = 0;
  await aiPlanEditsService.submitRevise(planId, 'split the second story', c);
  out['revise'] = { ...at(0), __planId: planId };

  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE SEAM — five entrances, one kind, and the context that replaced it
// ════════════════════════════════════════════════════════════════════════════

describe('EVERY planning entrance puts ONE kind on the wire (MOTIR-3943)', () => {
  it('all five submits send `jobKind: "plan"` — read off the request body', async () => {
    const sent = await driveAllFive();

    // Five entrances actually fired — a fixture that silently drove fewer would
    // make every assertion below vacuous.
    expect(Object.keys(sent).sort()).toEqual([
      'augment',
      'contextual',
      'expand',
      'generation',
      'revise',
    ]);
    for (const [name, body] of Object.entries(sent)) {
      expect(body['jobKind'], `${name} did not send plan`).toBe('plan');
      expect(body['envelopeVersion'], name).toBe('v1');
    }
  });

  it('the CONTEXT carries the distinction the kind used to — per arm, distinctly', async () => {
    const sent = await driveAllFive();

    // ⚠️ A SINGLE "all five sent plan" ASSERTION DOES NOT SATISFY THIS, and the
    // criterion says so: the whole point of collapsing the kind is that the
    // CONTEXT now decides which grounding a run reads. `readerForPlan` resolves
    // `planId` → the plan, `rootItemKey`/`targetKeys` → the work item, neither →
    // the project. So each arm is asserted on what it CARRIES *and* on what it
    // does NOT — an anchor that leaked onto the revision would silently re-route
    // it to the anchored arm.

    // ARM 1 — the PLAN. `planId` is the only thing that makes this a revision.
    const revise = ctxOf(sent['revise']!);
    expect(revise['planId']).toBe(sent['revise']!['__planId']);
    expect(revise['rootItemKey']).toBeUndefined();
    expect(revise['targetKeys']).toBeUndefined();

    // ARM 2 — the WORK ITEM, reached by either field.
    const expand = ctxOf(sent['expand']!);
    expect(typeof expand['rootItemKey']).toBe('string');
    expect(expand['planId']).toBeUndefined();
    const contextual = ctxOf(sent['contextual']!);
    expect(Array.isArray(contextual['targetKeys'])).toBe(true);
    expect((contextual['targetKeys'] as string[]).length).toBeGreaterThan(0);
    expect(contextual['planId']).toBeUndefined();

    // ARM 3 — NEITHER, which is how a run says *plan the project*.
    for (const name of ['generation', 'augment']) {
      const ctx = ctxOf(sent[name]!);
      expect(ctx['rootItemKey'], name).toBeUndefined();
      expect(ctx['targetKeys'], name).toBeUndefined();
      expect(ctx['planId'], name).toBeUndefined();
    }
  });

  it('the two SETTINGS ride every one of the five — the shared-submit refactor’s likeliest loss', async () => {
    const sent = await driveAllFive();

    // These are read ONLY from the envelope on the far side, so a submit that
    // drops one does not fail — it silently disables a project's setting on that
    // path.

    // `generateExplanations` rides ALL FIVE, and is always PRESENT rather than
    // spread conditionally: absence reads as unset on the far side.
    for (const [name, body] of Object.entries(sent)) {
      expect(
        Object.prototype.hasOwnProperty.call(ctxOf(body), 'generateExplanations'),
        `${name} dropped generateExplanations`,
      ).toBe(true);
    }

    // ⚠️ `recordPlanningMistakes` NOW RIDES ALL FIVE — ⚠️ CORRECTED (MOTIR-4343).
    // KEPT AS A PARTITION, with `dropsFlag` EMPTY, because the shape of the
    // defect is what this assertion is about and a flat "all five carry it" loop
    // cannot say it.
    //
    // ~~It rode FOUR of the six, and the two that dropped it were exactly the two
    // that bypass the shared submit.~~ That was true when this story shipped and
    // it is the finding this gate produced: the flag was resolved INSIDE
    // `submitPlanEditJob`, so the four submits routing through it carried it and
    // the two calling `submitJob` DIRECTLY —
    // `aiGenerationService.startGeneration` and
    // `aiPlanEditsService.submitRevise` — never resolved it at all. Filed as
    // MOTIR-4343 rather than absorbed here, and fixed there by resolving the flag
    // at each bypassing site (NOT by routing them through the shared submit —
    // both bypass it for real reasons).
    //
    // ⚠️ The stale member is REMOVED rather than left in `dropsFlag`, and the old
    // failure message went with it: it named MOTIR-4326 — an unrelated `low`
    // drawer bug under Epic 8 — where it meant MOTIR-4343, so the one reader it
    // was written for would have been sent to the wrong card.
    //
    // Why the partition still earns its place: `mayRecordPlanningMistakes` reads
    // ABSENT as ON, and the gate lives in `assemblePlannerInputs` — the one
    // shared assembler BOTH arms have always called. An entrance that stops
    // carrying the field does not fail anywhere; it silently resumes capturing
    // for a project that switched capture off. So the list that must stay empty
    // is asserted as a list, and a sixth entrance that bypasses the shared
    // submit again is caught by the CALL-SITE guard in
    // `tests/integration/ai/planningSubmitCarriesConsentFlag.test.ts`, which this
    // seam test cannot see.
    const carriesFlag = ['augment', 'contextual', 'expand', 'generation', 'revise'];
    const dropsFlag: string[] = [];
    for (const name of carriesFlag) {
      expect(
        Object.prototype.hasOwnProperty.call(ctxOf(sent[name]!), 'recordPlanningMistakes'),
        `${name} dropped recordPlanningMistakes — an absent field reads as ON on the far side, so this silently re-enables capture for a project that switched it off (MOTIR-4343)`,
      ).toBe(true);
    }
    expect(dropsFlag, 'no planning entrance may drop the consent flag (MOTIR-4343)').toEqual([]);
    // …and the partition is TOTAL over the five, which is what stops an entrance
    // being dropped from both lists rather than moved between them.
    expect(carriesFlag.length + dropsFlag.length).toBe(Object.keys(sent).length);
    expect([...carriesFlag].sort()).toEqual(Object.keys(sent).sort());

    // `finalCheck` (MOTIR-11264) rides ALL FIVE as well, always PRESENT: motir-ai
    // reads an absent field as ON, so an entrance that dropped it would run the
    // final check for a project that turned it off.
    for (const [name, body] of Object.entries(sent)) {
      expect(
        Object.prototype.hasOwnProperty.call(ctxOf(body), 'finalCheck'),
        `${name} dropped finalCheck — an absent field reads as ON on the far side (MOTIR-11264)`,
      ).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE GUARDS — what a coverage percentage cannot see
// ════════════════════════════════════════════════════════════════════════════

describe('no `submitJob` call site can reintroduce a per-operation kind', () => {
  it('no `submitJob(` in `lib/` names a RETIRED planning kind, naming any that does', async () => {
    // ⚠️ A STATIC ASSERTION OVER THE SOURCE, deliberately. The seam test above
    // proves the five entrances that exist today; this is what stops a SIXTH
    // being added later by copying an old call site. A behavioural test cannot
    // see a submit nobody has written yet.
    //
    // ⚠️ IT FLAGS THE FIVE RETIRED NAMES, NOT "anything but `plan`". The first
    // draft of this guard asserted every `submitJob` literal was `plan` and
    // flagged five call sites that are entirely correct — `ask_project`,
    // `analyze_bug`, `discovery`, `plan_sprint`, `propose_convention`. Those are
    // NON-planning kinds and are none of this story's business. The property is
    // that a retired PLANNING kind cannot come back, not that the product has
    // one job kind.
    const { globSync } = await import('node:fs');
    const files = globSync('lib/**/*.ts');
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // `submitJob(` and its first argument, ACROSS LINES — the multi-line form
      // is exactly what a same-line pattern misses, and missing it is how this
      // story's own greps under-counted their populations twice.
      for (const m of src.matchAll(/submitJob\(\s*(?:\/\/[^\n]*\n\s*)*'([a-z_]+)'/g)) {
        if ((RETIRED as readonly string[]).includes(m[1]!)) {
          offenders.push(`${file}: submitJob('${m[1]}')`);
        }
      }
    }
    expect(
      offenders,
      `a submit site names a RETIRED planning kind:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('and the two PLANNING submit sites do name `plan` — the positive half', async () => {
    // The guard above is an absence, so on its own it passes in a repository
    // with no submits at all. This is what says the planning entrances exist and
    // send the right thing.
    const planning = ['lib/services/aiGenerationService.ts', 'lib/services/aiPlanEditsService.ts'];
    for (const file of planning) {
      const src = readFileSync(file, 'utf8');
      const literals = [...src.matchAll(/submitJob\(\s*(?:\/\/[^\n]*\n\s*)*'([a-z_]+)'/g)].map(
        (m) => m[1],
      );
      expect(literals, `${file} makes no literal submit`).not.toEqual([]);
      expect(new Set(literals), file).toEqual(new Set(['plan']));
    }
  });

  it('the guard actually READ the sources — a walker finding nothing passes every absence', async () => {
    const { globSync } = await import('node:fs');
    const files = globSync('lib/**/*.ts');
    expect(files.length).toBeGreaterThan(50);
    // …and it reaches the file the submits actually live in.
    expect(files).toContain('lib/services/aiPlanEditsService.ts');
    // …which really does call `submitJob` with a literal, so the pattern above is
    // matching something rather than vacuously finding no candidates.
    const src = readFileSync('lib/services/aiPlanEditsService.ts', 'utf8');
    expect(
      [...src.matchAll(/submitJob\(\s*(?:\/\/[^\n]*\n\s*)*'([a-z_]+)'/g)].length,
    ).toBeGreaterThan(0);
  });
});

describe('the retired names are gone from BOTH frozen lists', () => {
  it('neither `JOB_KINDS` nor the canonical set carries one', async () => {
    // `tests/ai/contract.test.ts` asserts the two lists are EQUAL; this asserts
    // what they must not contain, which equality alone cannot say.
    const canonical = readFileSync('tests/ai/contract.test.ts', 'utf8');
    const block = canonical.slice(
      canonical.indexOf('const CANONICAL_JOB_KINDS'),
      canonical.indexOf('] as const;', canonical.indexOf('const CANONICAL_JOB_KINDS')),
    );
    expect(block.length).toBeGreaterThan(20);
    for (const kind of RETIRED) {
      expect([...JOB_KINDS], kind).not.toContain(kind);
      expect(block, `${kind} is still in CANONICAL_JOB_KINDS`).not.toContain(`'${kind}'`);
    }
    expect([...JOB_KINDS]).toContain('plan');
    expect(block).toContain("'plan'");
  });
});

describe('the run log stays TOTAL over persisted history', () => {
  it('`UsageRunDTO.jobKind` is a `string`, not a union', () => {
    // ⚠️ A TYPE-LEVEL ASSERTION, because the failure it prevents is a well-meant
    // LATER narrowing. `AiUsage.jobKind` holds what was submitted at the time —
    // including the five kinds this story retired — so narrowing this field to
    // the live enum would make every historical row un-typeable and the run log
    // wrong about what an organization was billed for.
    type IsString<T> = string extends T ? true : false;
    const totalOverAnyString: IsString<UsageRunDTO['jobKind']> = true;
    expect(totalOverAnyString).toBe(true);

    // …and the runtime half: a retired value is still a legal thing to render.
    const historical: UsageRunDTO['jobKind'] = 'generate_tree';
    expect(historical).toBe('generate_tree');
  });
});
