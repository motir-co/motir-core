import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// ════════════════════════════════════════════════════════════════════════════
// MOTIR-4343 — THE CONSENT FLAG RIDES EVERY PLANNING SUBMIT, INCLUDING THE ONES
// THAT BYPASS THE SHARED ONE
// ════════════════════════════════════════════════════════════════════════════
//
// `Project.aiRecordPlanningMistakes` is a CONSENT setting: an org can switch off
// the planner recording what it got wrong. It crosses to motir-ai on the job
// envelope's `context` and nowhere else — motir-ai cannot read motir-core's
// database — and `mayRecordPlanningMistakes` (motir-ai `src/envelope.ts`) reads
// an ABSENT value as ON, deliberately, so a producer that predates the field
// keeps working.
//
// The consequence is the whole reason this file exists: **a submit that drops the
// field does not fail anywhere.** It is not a type error (there is no shared type
// across the boundary), it is not a runtime error, and it does not show up in a
// coverage report. It is a project's consent setting silently not being honoured.
//
// The defect it was written for: the flag was resolved INSIDE
// `aiPlanEditsService.submitPlanEditJob`, so the four entrances routing through
// that shared submit carried it and the two calling `submitJob` DIRECTLY —
// `aiGenerationService.startGeneration` and `aiPlanEditsService.submitRevise` —
// never resolved it at all. Both bypass the shared submit for real reasons (a
// revision holds a lease and opens no plan; generation opens its own), so the fix
// resolves the flag at each site rather than merging the paths — which is exactly
// the shape that can recur, and is why the second half of this file is a
// CALL-SITE guard rather than another behavioural case.
//
// ⚠️ WHAT EACH HALF CAN AND CANNOT SEE, because neither substitutes for the other:
//
//   1. THE VALUE ON THE WIRE (below). Drives a project with the setting switched
//      OFF through both entrances and asserts the submitted value is `false` —
//      the SETTING, not merely the key's presence. `storyGate.oneKindOnTheWire`
//      asserts presence across all six; presence with a hard-coded `true` would
//      pass that and defeat the feature entirely. It cannot see an entrance
//      nobody has written yet.
//   2. THE CALL SITES (the second describe). A static assertion over `lib/`,
//      derived from the call sites themselves rather than from a list of the
//      entrances that happen to exist today. It is what stops a SEVENTH entrance
//      reintroducing this by bypassing the shared submit again. It cannot see
//      what any of them actually SEND.

import { db } from '@/lib/db';
import { RECORD_PLANNING_MISTAKES_CONTEXT_FIELD } from '@/lib/ai/lessonCapture';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  allSubmitSitesInLib,
  PLANNING_KIND,
  planningSitesMissing,
  submitSites,
  type SubmitSite,
} from '../../helpers/submitJobSites';
import type { ProjectContext } from '@/lib/projects';
import type { WorkItemFixture } from '../../fixtures';

const ORIGIN = 'http://motir-ai.consent-flag.test';

// The WIRE STRING, written out rather than imported from the code under test.
// motir-ai spells this same literal in its own repository and no shared type
// binds them, so a test that read the name out of the module would agree with
// itself about it and prove nothing about the contract.
const WIRE_KEY = 'recordPlanningMistakes';

/** Every request body the seam received, in order. */
const bodies: Record<string, unknown>[] = [];

let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-consent-flag-'));
  const fixture = join(dir, 'jobs.json');
  writeFileSync(fixture, JSON.stringify({}));
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixture);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);

  // ⚠️ INSTALLED ONCE, deliberately — `observeAiJobSubmit` keeps its subscribers
  // in module scope, so installing per-test would stack observers and double
  // every capture.
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

const ctxOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b['context'] ?? {}) as Record<string, unknown>;

/**
 * Drive the TWO entrances that bypass `submitPlanEditJob`, with the project's
 * capture setting at `value`, and hand back the bodies they put on the wire.
 */
async function driveTheTwoBypasses(
  value: boolean,
): Promise<Record<'generation' | 'revise', Record<string, unknown>>> {
  const fx = await makeFixture();
  const c = projectCtx(fx);
  const planId = await plannedPlan(fx);

  await projectAiSettingsService.updateAiSettings(
    fx.project.identifier,
    { aiRecordPlanningMistakes: value },
    { userId: fx.ownerId, workspaceId: fx.workspaceId },
  );
  // Read the row back: the assertions below are about a stored `false` reaching
  // the wire, so a patch that silently did not persist would make them vacuous.
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  expect(row.aiRecordPlanningMistakes, 'the setting did not persist').toBe(value);

  bodies.length = 0;
  await aiGenerationService.startGeneration(c, { prompt: 'build a thing' });
  const generation = bodies[0]!;

  bodies.length = 0;
  await aiPlanEditsService.submitRevise(planId, 'split the second story', c);
  const revise = bodies[0]!;

  return { generation, revise };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE VALUE ON THE WIRE — the setting, not merely the key
// ════════════════════════════════════════════════════════════════════════════

describe('a project that switched capture OFF sends `false` on BOTH bypassing entrances', () => {
  it('generation and revision each send `recordPlanningMistakes: false`', async () => {
    const sent = await driveTheTwoBypasses(false);

    for (const [name, body] of Object.entries(sent)) {
      const context = ctxOf(body);
      // PRESENT — asserted separately from the value, because they fail
      // differently. An absent key is read on the far side as "old producer" and
      // therefore as ON; `JSON.stringify` drops a key whose value is `undefined`,
      // so a producer that resolved "off" to `undefined` would look correct at
      // the call site and send nothing at all.
      expect(
        Object.prototype.hasOwnProperty.call(context, WIRE_KEY),
        `${name} did not send ${WIRE_KEY} at all — the far side reads that as ON`,
      ).toBe(true);
      // …and the VALUE, which is the half a presence check cannot make: a site
      // that hard-coded `true` would satisfy every presence assertion in the
      // story gate and honour nobody's setting.
      expect(context[WIRE_KEY], `${name} sent the wrong value`).toBe(false);
    }
  });

  it('and `true` when the same project switches it back on — so `false` was not a constant', async () => {
    // The counterfactual. Without it, a producer that sent a hard-coded `false`
    // would pass the case above, and the assertion would be measuring the literal
    // rather than the setting.
    const sent = await driveTheTwoBypasses(true);

    for (const [name, body] of Object.entries(sent)) {
      expect(ctxOf(body)[WIRE_KEY], `${name} sent the wrong value`).toBe(true);
    }
  });

  it('a project that never touched the setting sends `true` — the unset default', async () => {
    const fx = await makeFixture();
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    // The real unset case, asserted on the row rather than on a written `true`.
    expect(row.aiRecordPlanningMistakes).toBeNull();

    bodies.length = 0;
    await aiGenerationService.startGeneration(projectCtx(fx), { prompt: 'build a thing' });
    expect(ctxOf(bodies[0]!)[WIRE_KEY]).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1b. THE SHARED BUILDER — three submits, one set of always-present fields (MOTIR-7916)
// ════════════════════════════════════════════════════════════════════════════

// The final check (MOTIR-11264) crosses the same way and fails the same way: an
// ABSENT `finalCheck` reads on the far side as ON. So the VALUE is asserted on
// the three entrances that resolve it outside the shared plan-edit context —
// the routing run, a generation and a revision — for a project that turned it off.
describe('a project that turned the final check OFF sends `finalCheck: false` on the bypassing entrances', () => {
  it('the routing run, a generation and a revision each send `finalCheck: false`, and `true` once it is back on', async () => {
    const fx = await makeFixture();
    const c = projectCtx(fx);
    const settingsCtx = { userId: fx.ownerId, workspaceId: fx.workspaceId };

    // A fresh plan per round: a revision holds its plan until it lands.
    async function driveAll(): Promise<Record<string, Record<string, unknown>>> {
      bodies.length = 0;
      await aiGenerationService.startRoutingRun(c);
      const routing = bodies[0]!;
      bodies.length = 0;
      await aiGenerationService.startGeneration(c, { prompt: 'build a thing' });
      const generation = bodies[0]!;
      const planId = await plannedPlan(fx);
      bodies.length = 0;
      await aiPlanEditsService.submitRevise(planId, 'split the second story', c);
      const revise = bodies[0]!;
      return { routing, generation, revise };
    }

    await projectAiSettingsService.updateAiSettings(
      fx.project.identifier,
      { aiFinalCheck: false },
      settingsCtx,
    );
    for (const [name, body] of Object.entries(await driveAll())) {
      const context = ctxOf(body);
      expect(
        Object.prototype.hasOwnProperty.call(context, 'finalCheck'),
        `${name} did not send finalCheck at all — the far side reads that as ON`,
      ).toBe(true);
      expect(context['finalCheck'], `${name} sent the wrong value`).toBe(false);
    }

    await projectAiSettingsService.updateAiSettings(
      fx.project.identifier,
      { aiFinalCheck: true },
      settingsCtx,
    );
    for (const [name, body] of Object.entries(await driveAll())) {
      expect(ctxOf(body)['finalCheck'], `${name} sent the wrong value`).toBe(true);
    }
  });
});

describe('submitPlanEditJob, submitRevise and submitResume each send the always-present fields', () => {
  it('generateExplanations, the consent flag and the onboarding marker, on every one', async () => {
    const fx = await makeFixture();
    const c = projectCtx(fx);
    const planId = await plannedPlan(fx);
    await projectAiSettingsService.updateAiSettings(
      fx.project.identifier,
      { aiRecordPlanningMistakes: false },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );

    bodies.length = 0;
    await aiPlanEditsService.submitAugment('add a thing', c);
    const edit = bodies[0]!;
    bodies.length = 0;
    await aiPlanEditsService.submitRevise(planId, 'split it', c);
    const revise = bodies[0]!;
    bodies.length = 0;
    await aiPlanEditsService.submitResume(planId, 'job-failed', c, c.userId);
    const resume = bodies[0]!;

    for (const [name, body] of Object.entries({ edit, revise, resume })) {
      const context = ctxOf(body);
      expect(context, `${name} dropped generateExplanations`).toHaveProperty(
        'generateExplanations',
      );
      expect(context[WIRE_KEY], `${name} sent the wrong consent value`).toBe(false);
      expect(context, `${name} dropped the onboarding marker`).toHaveProperty('onboarding');
    }
  });

  it('only the resume carries `resume` on the envelope, and a resume names no planId in the bag', async () => {
    const fx = await makeFixture();
    const c = projectCtx(fx);
    const planId = await plannedPlan(fx);

    bodies.length = 0;
    await aiPlanEditsService.submitAugment('add a thing', c);
    const edit = bodies[0]!;
    bodies.length = 0;
    await aiPlanEditsService.submitResume(planId, 'job-failed', c, c.userId);
    const resume = bodies[0]!;

    expect(edit).not.toHaveProperty('resume');
    expect(resume['resume']).toEqual({ planId, fromJobId: 'job-failed' });
    expect(ctxOf(resume)).not.toHaveProperty('planId');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE CALL SITES — derived from the source, not from a list of entrances
// ════════════════════════════════════════════════════════════════════════════

/**
 * The token a planning submit must carry. It is the COMPUTED KEY form
 * (`[RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: …`) rather than the bare string,
 * because that is the discipline `lib/ai/lessonCapture.ts` states in its own
 * words: there is no shared type across the boundary, so the name is a string
 * agreement between two codebases and a typo on either side is not a type error.
 * A site spelling the literal instead is flagged, correctly.
 */
const REQUIRED_TOKEN = '[RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]';

/**
 * ⚠️ THE SOURCE WALKER MOVED, THE PROPERTY DID NOT (MOTIR-4736). `submitSites`
 * and its comment-blanking / regex-literal handling used to live in this file.
 * A SECOND envelope field now needs the same population — the onboarding marker,
 * guarded in `planningSubmitCarriesOnboardingFlag.test.ts` — and two copies of a
 * parser whose every subtlety is load-bearing is two places for the same silent
 * under-count to be reintroduced. The walker's own reasoning (why not a `grep`,
 * why offsets must survive the strip, why regex literals are tracked) travelled
 * with it to `tests/helpers/submitJobSites.ts`; the counterfactual that proves it
 * can go RED stays HERE, because it is what makes THIS file's absence assertions
 * evidence rather than a green tick.
 */
function offendersAmong(sites: SubmitSite[]): string[] {
  return planningSitesMissing(sites, REQUIRED_TOKEN);
}

describe('no `submitJob` call site can send a planning kind without the consent flag', () => {
  async function allSites(): Promise<SubmitSite[]> {
    const { files, sites } = await allSubmitSitesInLib();
    // The walker itself is asserted, because a walker that finds nothing passes
    // every absence: this is the tautology check that makes the assertion below
    // evidence rather than a green tick.
    expect(files.length, 'the source walk found no files').toBeGreaterThan(50);
    expect(files).toContain('lib/services/aiPlanEditsService.ts');
    expect(files).toContain('lib/services/aiGenerationService.ts');
    return sites;
  }

  it('every planning `submitJob` in `lib/` names the consent-flag constant', async () => {
    const sites = await allSites();
    const offenders = offendersAmong(sites);
    expect(
      offenders,
      `a planning submit drops the consent flag. An ABSENT field is read by motir-ai's ` +
        `mayRecordPlanningMistakes as ON, so this silently keeps capturing for a project ` +
        `that switched capture off (MOTIR-4343). Resolve it with ` +
        `resolveRecordPlanningMistakesForJob and send it unconditionally:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the walk actually FOUND the planning submits — an absence over an empty set is vacuous', async () => {
    const sites = await allSites();
    const planning = sites.filter((s) => s.kind === PLANNING_KIND);

    // Three today: `submitPlanEditJob` (the shared submit the four plan-edit
    // entrances route through), `submitRevise`, and `startGeneration`. Asserted
    // as a FLOOR rather than an equality, so adding a legitimate seventh entrance
    // does not fail this line — it is caught by the guard above if it drops the
    // flag, which is the property, and this line only says the guard had
    // something to read.
    expect(
      planning.length,
      `found no planning submit at all — the extractor stopped matching`,
    ).toBeGreaterThanOrEqual(3);
    const files = new Set(planning.map((s) => s.file));
    expect(files).toContain('lib/services/aiGenerationService.ts');
    expect(files).toContain('lib/services/aiPlanEditsService.ts');

    // …and the NON-planning submits are still seen and still excluded. This is
    // what says the filter is a filter rather than an accident of the extractor
    // failing to parse them: `ask_project`, `analyze_bug`, `discovery`,
    // `plan_sprint`, `propose_convention`, `noop` and `generate_explanation` are
    // correct submits and none of this card's business.
    const nonPlanning = sites.filter((s) => s.kind !== null && s.kind !== PLANNING_KIND);
    expect(nonPlanning.length, 'the extractor saw no non-planning submits').toBeGreaterThan(0);
    expect(offendersAmong(nonPlanning)).toEqual([]);
  });

  it('THE DETECTOR CAN GO RED — the same extractor, over sources it should and should not flag', () => {
    // ⚠️ THE COUNTERFACTUAL, and the reason this test exists at all. Everything
    // above asserts an EMPTY list, and an empty list is what a broken extractor
    // returns too — so a guard that has never been shown failing is not evidence,
    // it is a tautology. These four fixtures run the SAME `submitSites` +
    // `offendersAmong` the real scan runs, so a change that stops the detector
    // matching fails HERE rather than passing everywhere.

    // (a) A seventh entrance bypassing the shared submit — the exact regression.
    const bypassing = `
      const { jobId } = await submitJob(
        'plan',
        tenant,
        { prompt, generateExplanations: p.aiGenerateExplanations },
        { userId: ctx.userId },
      );`;
    expect(offendersAmong(submitSites('fake/bypass.ts', bypassing))).toHaveLength(1);

    // (b) The same site, fixed.
    const fixed = bypassing.replace(
      '{ prompt,',
      '{ prompt, [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,',
    );
    expect(offendersAmong(submitSites('fake/fixed.ts', fixed))).toEqual([]);

    // (c) ⚠️ THE FLAG NAMED ONLY IN A COMMENT IS STILL AN OFFENDER. Every real
    // call site here is wrapped in prose about this field, so a `grep`-shaped
    // guard would pass a site that documents the contract and sends nothing.
    const commentedOnly = `
      const { jobId } = await submitJob(
        'plan',
        tenant,
        {
          // [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD] rides every planning submit.
          prompt,
        },
        { userId: ctx.userId },
      );`;
    expect(offendersAmong(submitSites('fake/commented.ts', commentedOnly))).toHaveLength(1);

    // (d) A NON-planning submit with no flag is correct and must not be flagged —
    // the guard is about planning consent, not about every job the product runs.
    const nonPlanning = `await submitJob('ask_project', tenant, { prompt }, { userId });`;
    expect(offendersAmong(submitSites('fake/ask.ts', nonPlanning))).toEqual([]);

    // (e) ⚠️ A QUOTE-BEARING REGEX EARLIER IN THE FILE MUST NOT HIDE THE SITE.
    // `lib/email.ts` contains exactly this pattern, and a walker that read its
    // `["']` as a string delimiter desynchronises for the rest of the file — so
    // every submit AFTER it silently leaves the population and the absence
    // assertion passes over a set that quietly shrank. Asserted in the direction
    // that matters: the offender is still FOUND.
    const afterRegex = `
      const links = html.match(/<a\\s+[^>]*href=["']([^"']+)["'][^>]*>/gi);
      const label = text.replace(/\`([^\`]*)\`/g, '$1');
      ${bypassing}`;
    expect(offendersAmong(submitSites('fake/afterRegex.ts', afterRegex))).toHaveLength(1);
  });

  it('the required token IS the exported constant’s name', () => {
    // The guard checks for an identifier, so it is only meaningful while that
    // identifier is the thing the call sites use. A rename that leaves this
    // unchanged would make the guard match nothing and pass silently.
    expect(REQUIRED_TOKEN).toBe('[RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]');
    expect(RECORD_PLANNING_MISTAKES_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
