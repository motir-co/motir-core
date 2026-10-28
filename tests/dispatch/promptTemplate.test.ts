import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_LANE_PUBLISHES_CHECK,
  assembleDispatchPrompt,
  branchSlug,
  FINDINGS_POLICY_TOKENS,
  FULL_FINDINGS_POLICY,
  DESIGN_DIR_ENV,
  GET_CODING_CONVENTION_TOOL_NAME,
  GET_DESIGN_TOOL_NAME,
  HOW_TO_TEST_TOOL_NAME,
  LINKING_RATIONALE,
  LIST_DESIGNS_TOOL_NAME,
  NO_INJECTIONS,
  parseFindingsPolicy,
  RECORD_DISCREPANCY_TOOL_NAME,
  RENDERED_SURFACE_TRIGGER,
  renderErrorEvidence,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME } from '@/lib/mcp/tools/publishTestInstructions';
import { RECORD_RUN_DISCREPANCY_TOOL_NAME } from '@/lib/mcp/tools/recordRunDiscrepancy';
import { REPORT_UNBUILDABLE_TARGET_TOOL_NAME } from '@/lib/mcp/tools/reportUnbuildableTarget';
import { GET_CODING_CONVENTION_TOOL_NAME as REGISTERED_GET_CODING_CONVENTION } from '@/lib/mcp/tools/getCodingConvention';
import { GET_DESIGN_TOOL_NAME as REGISTERED_GET_DESIGN } from '@/lib/mcp/tools/getDesign';
import { LIST_DESIGNS_TOOL_NAME as REGISTERED_LIST_DESIGNS } from '@/lib/mcp/tools/listDesigns';
import { MOTIR_DESIGN_DIR_ENV as CLI_MOTIR_DESIGN_DIR_ENV } from '../../packages/cli/src/designFiles';
import { splitPlanBody } from '@/lib/markdown/planBody';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import {
  AI_REQUIREMENT_FIELDS,
  AI_REQUIREMENT_REQUIRED_NON_EMPTY,
} from '../fixtures/settledRequirement';

// PURE unit suite for the dispatch-prompt GRAMMAR (Story 7.9 · MOTIR-1802). No
// DB — the assembler reads nothing, which is the property that makes the prompt
// byte-identical across calls (the contract MOTIR-881 tests against). The
// service-level, real-Postgres half lives in `tests/dispatch/dispatchPrompt.test.ts`.

/** A complete `code` source; each test overrides only what it is about. */
function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 5,
    estimateMinutes: 90,
    descriptionMd: [
      'Build the filter bar above the ready list.',
      '',
      '## Acceptance criteria',
      '',
      '- The bar filters by kind and priority.',
      '- An empty result renders the empty state.',
      '',
      '## Context refs',
      '',
      '- `lib/dto/ready.ts` — the DTO',
      '- `app/(authed)/ready/page.tsx`',
    ].join('\n'),
    blockerKeys: ['PROD-3', 'PROD-5'],
    openDependentKeys: [],
    errorEvidence: [],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

/** The four canonical section headings, in the order the grammar emits them.
 *  Matched as a line PREFIX — `ACCEPTANCE CRITERIA` carries a suffix. */
const SECTIONS = [
  'CONTEXT',
  'WHAT TO DO',
  'ACCEPTANCE CRITERIA',
  'GIT WORKFLOW',
  'REPORTING THE OUTCOME',
];

/** Everything from the outcome heading to the end — the section under test in
 *  the MOTIR-2406 block, sliced so an assertion about it cannot be satisfied by
 *  text somewhere else in the prompt. */
function outcomeSection(prompt: string): string {
  const at = prompt.indexOf('REPORTING THE OUTCOME');
  expect(at, 'the prompt carries a REPORTING THE OUTCOME section').toBeGreaterThan(-1);
  return prompt.slice(at);
}

/**
 * The outcome section UP TO the third branch (MOTIR-3020).
 *
 * The section grew a sibling — FOUND A DEFECT, which is about something other
 * than this card — and an assertion written about the two card-outcome branches
 * must keep its original subject rather than silently widen to text it was never
 * written about. Used where the claim is "the agent is offered X and not Y for
 * ITS OWN card"; the whole-section helper is still right for anything else.
 */
function cardOutcomeBranches(prompt: string): string {
  const section = outcomeSection(prompt);
  const third = section.indexOf('FOUND A DEFECT');
  return third === -1 ? section : section.slice(0, third);
}

describe('splitPlanBody — the plan-body section parser', () => {
  it('partitions narrative / acceptance criteria / context refs', () => {
    const parsed = splitPlanBody(source().descriptionMd);
    expect(parsed.body).toBe('Build the filter bar above the ready list.');
    expect(parsed.acceptanceCriteria).toEqual([
      '- The bar filters by kind and priority.',
      '- An empty result renders the empty state.',
    ]);
    expect(parsed.contextRefs).toEqual(['lib/dto/ready.ts', 'app/(authed)/ready/page.tsx']);
  });

  it('returns empty parts for an empty body, and the whole body when it follows no convention', () => {
    expect(splitPlanBody(null)).toEqual({ body: '', acceptanceCriteria: [], contextRefs: [] });
    expect(splitPlanBody('')).toEqual({ body: '', acceptanceCriteria: [], contextRefs: [] });
    const plain = splitPlanBody('# Title\n\nJust prose.\n\n## Notes\n\n- a note');
    expect(plain.body).toBe('# Title\n\nJust prose.\n\n## Notes\n\n- a note');
    expect(plain.acceptanceCriteria).toEqual([]);
    expect(plain.contextRefs).toEqual([]);
  });

  it('is case- and level-insensitive on the headings and keeps nested criteria indentation', () => {
    const parsed = splitPlanBody(
      [
        '### ACCEPTANCE CRITERIA',
        '',
        '- top',
        '  - nested',
        '',
        '### Context Ref',
        '- `a.ts`',
      ].join('\n'),
    );
    expect(parsed.acceptanceCriteria).toEqual(['- top', '  - nested']);
    expect(parsed.contextRefs).toEqual(['a.ts']);
  });

  it('keeps `extractContextRefs` behaviour identical (it now delegates here)', () => {
    const md = '## Context refs\n\n- `path/one.ts` — the DTO\n- plain ref two - trailing\n';
    expect(extractContextRefs(md)).toEqual(['path/one.ts', 'plain ref two']);
    expect(extractContextRefs(null)).toEqual([]);
    expect(extractContextRefs('No refs here.')).toEqual([]);
  });
});

describe('assembleDispatchPrompt — the work branch as a field (MOTIR-6539)', () => {
  it('names the branch the GIT WORKFLOW tells the agent to create, the one it instructs', () => {
    const { prompt, workBranch } = assembleDispatchPrompt(source());
    expect(workBranch).toBe('subtask/PROD-7-add-the-ready-set-filter-bar');
    expect(prompt).toContain(`-b ${workBranch} origin/main`);
  });

  it('is the same branch on a session lineage — the pull request comes from the lineage', () => {
    const out = assembleDispatchPrompt(source({ sessionBranch: 'motir/session-9' }));
    expect(out.workflowMode).toBe('session_lineage');
    expect(out.sessionBranch).toBe('motir/session-9');
    expect(out.workBranch).toBe('subtask/PROD-7-add-the-ready-set-filter-bar');
    expect(out.prompt).toContain(`-b ${out.workBranch} origin/motir/session-9`);
  });

  it('is null for a MANUAL item, which renders no GIT WORKFLOW at all', () => {
    expect(assembleDispatchPrompt(source({ type: 'manual', executor: 'human' })).workBranch).toBe(
      null,
    );
  });
});

describe('assembleDispatchPrompt — the four-section grammar', () => {
  it('emits all four sections in order, with the card interpolated', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(source());

    // Sections, in order.
    const positions = SECTIONS.map((s) => prompt.indexOf(`\n${s}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // The card's own content, not a template placeholder.
    expect(prompt).toContain('You are working on the Motir project.');
    expect(prompt).toContain('You are executing Subtask PROD-7: Add the ready-set filter bar.');
    expect(prompt).toContain('- Project: Motir (PROD)');
    expect(prompt).toContain('- Sizing: 5 story points · ~90 min');
    expect(prompt).toContain('- Repo: motir-core');
    expect(prompt).toContain('- Parent: PROD-2 — Ready surface');
    expect(prompt).toContain('- Depends on (already landed): PROD-3, PROD-5');
    expect(prompt).toContain('    - lib/dto/ready.ts');
    expect(prompt).toContain('Build the filter bar above the ready list.');
    expect(prompt).toContain('- The bar filters by kind and priority.');

    // The narrative body must NOT re-print the two sections that got their own.
    expect(prompt).not.toContain('## Acceptance criteria');
    expect(prompt).not.toContain('## Context refs');

    expect(workflowMode).toBe('per_item_pr');
    expect(sessionBranch).toBeNull();
    expect(prompt.endsWith('\n')).toBe(true);
  });

  it('is a PURE function — two calls for the same input are byte-identical', () => {
    const src = source();
    expect(assembleDispatchPrompt(src).prompt).toBe(assembleDispatchPrompt(source()).prompt);
    // …and the default injection set is the same as passing it explicitly.
    expect(assembleDispatchPrompt({ ...src, injections: NO_INJECTIONS }).prompt).toBe(
      assembleDispatchPrompt(src).prompt,
    );
  });

  it('states the honest fallbacks when the card names nothing', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        descriptionMd: null,
        blockerKeys: [],
        parent: null,
        targetRepo: null,
        storyPoints: null,
        estimateMinutes: null,
      }),
    );
    expect(prompt).toContain('(The card carries no description body.)');
    expect(prompt).toContain('The card names no explicit acceptance criteria.');
    expect(prompt).toContain('- Context refs: none named on the card.');
    expect(prompt).toContain('- Parent: none (top-level item)');
    expect(prompt).toContain('- Depends on: nothing');
    expect(prompt).toContain('- Repo: not pinned.');
    expect(prompt).not.toContain('- Sizing:');
  });

  it('renders one sizing fact when only one of points / estimate is set', () => {
    expect(assembleDispatchPrompt(source({ estimateMinutes: null })).prompt).toContain(
      '- Sizing: 5 story points\n',
    );
    expect(assembleDispatchPrompt(source({ storyPoints: null })).prompt).toContain(
      '- Sizing: ~90 min\n',
    );
  });
});

describe('assembleDispatchPrompt — the per-type WHAT TO DO variant', () => {
  // Every type gets its OWN steps; a marker phrase per type proves the variant
  // actually swapped rather than falling through to a shared default.
  const MARKERS: Record<WorkItemTypeDto, string> = {
    code: 'Ship the TESTS that cover the change',
    design: 'Draw the ACCESS PATH',
    test: 'Make each test fail for the right reason first',
    content: 'match the terms the app',
    copy: 'never coin a synonym for a shipped term',
    translate: 'a translation card authors no new',
    research: 'A research card ships a document',
    review: 'A finding without a scenario is an opinion',
    verification: 'verification that cannot fail has verified nothing',
    decision: 'ships a decision, not a survey',
    choice: 'that pick is the whole of the work',
    deploy: 'how it is rolled back',
    manual: 'Never paste a secret into the work item.',
    legal: 'stop at the draft',
    chore: 'keep the diff to that change alone',
  };

  it.each(Object.entries(MARKERS))('type %s yields its own steps', (type, marker) => {
    const { prompt } = assembleDispatchPrompt(
      source({ type: type as WorkItemTypeDto, executor: 'coding_agent' }),
    );
    expect(prompt).toContain(marker);
  });

  // ── MOTIR-9953: a code run owns the suites that pin what it changes, and the
  // coverage of what it adds. Only the `code` steps carry it; a design or test
  // card's steps are untouched.
  describe('WHAT_TO_DO.code owns the pinned suites and the coverage of the change (MOTIR-9953)', () => {
    const PINNED_SUITES = [
      'The suites that ALREADY assert the behaviour you change are part of the',
      'grep the tests for every function, route, message and state you',
      'update each suite that asserts the old behaviour in this same',
      'existing suite is modified, does not stop this: make the update, and record',
      'the mismatch with the record_run_discrepancy tool (BUILD THROUGH below).',
      'files you added or changed — the existing suites you updated under 3 are',
    ];
    const COVERAGE = [
      'COVER the code you add to at least 90% — statements, branches, functions and',
      'lines: per file for every file you add, and every function and branch you add',
      'Measure the change, never the',
      'Where the repository has its own coverage gates,',
      'Run coverage over the files you changed and put each changed',
      'file’s numbers in the pull request body.',
    ];
    const promptFor = (type: WorkItemTypeDto) =>
      assembleDispatchPrompt(source({ type, executor: 'coding_agent' })).prompt;

    it.each([...PINNED_SUITES, ...COVERAGE])('a code dispatch is told: %s', (rule) => {
      expect(promptFor('code')).toContain(rule);
    });

    it('keeps the pinned-suite step inside step 3, before step 4', () => {
      const prompt = promptFor('code');
      const step3 = prompt.indexOf('3. Ship the TESTS that cover the change');
      const pinned = prompt.indexOf('The suites that ALREADY assert the behaviour you change');
      const step4 = prompt.indexOf('4. Run the repository checks');
      expect(step3).toBeGreaterThan(-1);
      expect(pinned).toBeGreaterThan(step3);
      expect(step4).toBeGreaterThan(pinned);
    });

    it.each(['design', 'test'] as const)('a %s dispatch carries neither rule', (type) => {
      const prompt = promptFor(type);
      for (const rule of [...PINNED_SUITES, ...COVERAGE]) {
        expect(prompt).not.toContain(rule);
      }
    });
  });

  // ── MOTIR-7437: the DECISION lane writes a PAGE and publishes it
  //
  // The gate asks a person about the published page VERSION (`approval-gates.md`
  // §8's NINTH AMENDMENT), not a `docs/decisions/*.md` file at a pull request's head
  // (MOTIR-5682, retired). The lane names both tools literally and leaves no
  // instruction that could send an agent to a branch.
  describe('WHAT_TO_DO.decision writes a page and publishes it (MOTIR-7437)', () => {
    const RULES = [
      "3. Record it as ONE PAGE in this card's project, written with the create_page",
      'tool (or update_page, per 3a)',
      '4. When the page is COMPLETE, call the publish_decision_page tool ONCE with key',
      '5. Open NO branch, make NO commit, open NO pull request, and link nothing.',
      'Stop after the publish.',
    ];
    const agent = () =>
      assembleDispatchPrompt(source({ type: 'decision', executor: 'coding_agent' }));
    const agentPrompt = () => agent().prompt;

    it.each(RULES)('an agent’s decision card is told: %s', (rule) => {
      expect(agentPrompt()).toContain(rule);
    });

    it('carries no docs/decisions file, no pull request to open, and no repository STOP', () => {
      const prompt = agentPrompt();
      expect(prompt).not.toContain('docs/decisions/');
      expect(prompt).not.toMatch(/open (a|the) pull request/i);
      expect(prompt).not.toContain('link_pull_request');
      expect(prompt).not.toContain('If this card pins NO repository');
    });

    it('renders no GIT WORKFLOW and names no branch', () => {
      const out = agent();
      expect(out.prompt).not.toContain('GIT WORKFLOW');
      expect(out.prompt).not.toContain('git worktree add');
      expect(out.prompt).not.toContain('git push');
      expect(out.branch).toBeNull();
      expect(out.workBranch).toBeNull();
      expect(out.workflowMode).toBe('per_item_pr');
    });

    it('its FINISHED is the publish: no status write and no How to test', () => {
      const prompt = agentPrompt();
      expect(prompt).toContain('FINISHED — the decision page is written and published:');
      expect(prompt).toContain('publish_decision_page has returned for PROD-7, with a gateId');
      expect(prompt).toContain('Do NOT move PROD-7 with transition_status.');
      expect(prompt).not.toContain("4b. publish this run's HOW TO TEST");
      expect(prompt).toContain('PUBLISH NOTHING.');
    });

    // ── MOTIR-6194, restated for pages: the record's SUBJECT and its SCOPE.
    // `motir-meta` `prompts/run.md` step 5b carries the same rules for the runbook.
    describe('the record’s SUBJECT and SCOPE are bounded (MOTIR-6194)', () => {
      it('names the page from the decision’s SUBJECT, not from the text it contradicts', () => {
        const prompt = agentPrompt();
        expect(prompt).toContain('3a. WHICH page — the record goes where its SUBJECT lives');
        expect(prompt).toContain('Name it from the thing being DECIDED, not');
        expect(prompt).toContain('DEFAULT to a new page named for the');
        expect(prompt).toContain('update an EXISTING page only when it already OWNS this subject');
        expect(prompt).toContain('does not belong in');
      });

      it('requires an updated page to be READABLE AS ONE QUESTION', () => {
        const prompt = agentPrompt();
        expect(prompt).toContain('small enough to be READ AS ONE QUESTION');
        expect(prompt).toContain('WHOLE published version, not your edit');
        expect(prompt).toContain('unreadable and absent look the same');
      });

      it('bounds the record to the card’s own decision', () => {
        const prompt = agentPrompt();
        expect(prompt).toContain(
          "3b. HOW MUCH — the record is BOUNDED by this card's own decision",
        );
        expect(prompt).toContain('Do not settle a neighbouring question');
        expect(prompt).toContain('Something else wrong in');
      });

      it('asks for a “What this does NOT decide” fence, so the scope is checkable at the gate', () => {
        const prompt = agentPrompt();
        expect(prompt).toContain('3c. End the record with a "What this does NOT decide" section');
      });
    });

    it('a CODE card still publishes How to test and opens its pull request', () => {
      const { prompt } = assembleDispatchPrompt(source({ type: 'code', executor: 'coding_agent' }));
      expect(prompt).toContain("4b. publish this run's HOW TO TEST");
      expect(prompt).toContain('Its body carries a "## How to test" section');
      expect(prompt).toContain('GIT WORKFLOW');
    });

    // ── MOTIR-6094: a decision is NEVER dispatched onto a session branch — now
    // because it takes no branch at all.
    describe('a decision offered a session lineage still takes none (MOTIR-6094)', () => {
      const offered = () =>
        assembleDispatchPrompt(
          source({ type: 'decision', executor: 'coding_agent', sessionBranch: 'motir/auto-1' }),
        );

      it('is per_item_pr, reports no session branch, and names no branch', () => {
        expect(offered().workflowMode).toBe('per_item_pr');
        expect(offered().sessionBranch).toBeNull();
        expect(offered().branch).toBeNull();
        expect(offered().prompt).not.toContain('motir/auto-1');
        expect(offered().prompt).not.toContain('call the mark_integrated tool');
      });

      it('a CODE card offered the same lineage still joins it', () => {
        const code = assembleDispatchPrompt(source({ sessionBranch: 'motir/auto-1' }));
        expect(code.workflowMode).toBe('session_lineage');
        expect(code.sessionBranch).toBe('motir/auto-1');
      });
    });

    it('a HUMAN decision card never reaches the lane — it gets the manual steps and none of the rules', () => {
      const { prompt } = assembleDispatchPrompt(source({ type: 'decision', executor: 'human' }));
      expect(prompt).toContain('Never paste a secret into the work item.');
      for (const rule of RULES) expect(prompt).not.toContain(rule);
      expect(prompt).not.toContain('docs/decisions/<kebab-slug>.md');
    });
  });

  // ── MOTIR-3059, REWRITTEN BY MOTIR-3783: the design step that closes the loop
  //
  // MOTIR-3059 pinned a CONFIRMATION: the result was published by CI from a step
  // sharing a job with the design-asset guards, so a guard failure skipped it
  // silently and the agent's job was to notice (MOTIR-2413 / MOTIR-2981).
  //
  // ⚠️ THAT WHOLE FRAME IS GONE. MOTIR-3780 moved the publish from a CI script to
  // the `publish_design_result` tool, because a script has to BE PRESENT in the
  // repository the design lands in and that was true of exactly one of the four.
  // So the agent no longer confirms somebody else's publish — it MAKES the
  // publish, and the step is written in `linkingStep`'s register: a named tool
  // with named arguments, no conditional, no route names, no job log.
  //
  // The failure MODE the old step existed for is unchanged and is why the
  // absence assertions below matter: a design card whose result never arrives
  // still looks exactly like one that succeeded.
  describe('WHAT_TO_DO.design PUBLISHES the result only when work waits on it (MOTIR-5495)', () => {
    /** The WHAT TO DO section alone, so an assertion cannot be met elsewhere. */
    const whatToDo = (prompt: string): string =>
      prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    const designPrompt = (openDependentKeys: string[] = ['X-2']): string =>
      assembleDispatchPrompt(
        source({ type: 'design', executor: 'coding_agent', openDependentKeys }),
      ).prompt;

    it('with a waiting dependent: names the TOOL, the key that waits, and the two kinds', () => {
      const steps = whatToDo(designPrompt(['X-2']));
      expect(steps).toContain('PUBLISH the design result');
      expect(steps).toContain('publish_design_result');
      expect(steps).toContain('X-2 is blocked_by this card');
      for (const arg of ['"mock"', '"note_file"']) {
        expect(steps, `the design step omits the ${arg} kind`).toContain(arg);
      }
    });

    it('names the waiting keys in the plural too', () => {
      expect(whatToDo(designPrompt(['X-2', 'X-9']))).toContain('X-2, X-9 are blocked_by this card');
    });

    it('⚠️ ABSENCE: neither render names a retired input — not even to forbid it', () => {
      // AMENDMENT 4 retired the screenshot and the inline note. Naming either,
      // even in a "do not send", is how an agent learns the argument exists.
      for (const keys of [['X-2'], []]) {
        const prompt = designPrompt(keys);
        for (const retired of ['.png', 'image', 'noteMd']) {
          expect(prompt, `keys=${keys.join()} still names \`${retired}\``).not.toContain(retired);
        }
      }
    });

    it('with NOTHING waiting: says not to publish, and carries no publish step', () => {
      const steps = whatToDo(designPrompt([]));
      expect(steps).toContain('Do NOT publish a design result');
      expect(steps).toContain('its pull request is its review');
      expect(steps).not.toContain('PUBLISH the design result');
      expect(steps).not.toContain('"note_file"');
      expect(steps).not.toContain('create_design_upload');
    });

    it('BOTH renders instruct the two-file set and the delta-mock rule', () => {
      for (const keys of [['X-2'], []]) {
        const steps = whatToDo(designPrompt(keys));
        expect(steps).toContain('TWO files');
        expect(steps).toContain('design-notes.md');
        expect(steps).toContain('<surface>.mock.html');
        expect(steps).toContain('<surface>--<change>.mock.html');
        expect(steps).toContain('holding only the panels that change');
        expect(steps).toContain('do not edit its mock');
      }
    });

    it('⚠️ ABSENCE: no retired CI string can creep back in a later edit', () => {
      const prompt = designPrompt();
      for (const retired of [
        'design-asset guards',
        'Published N design artifact(s)',
        'SKIPPED when the guards fail',
        'upload-token',
        'design-evidence',
        'job log',
        'If it is not there',
        'CONFIRM the design result reached the work item',
      ]) {
        expect(prompt, `the design step still names the retired \`${retired}\``).not.toContain(
          retired,
        );
      }
    });

    it('still never routes a design asset through the general attach door', () => {
      expect(designPrompt()).not.toContain('attach_file');
      expect(designPrompt([])).not.toContain('attach_file');
    });

    it('keeps the silent-failure warning, RETARGETED at the un-made call', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('looks exactly like one that succeeded');
      expect(prompt).toContain('card empty');
    });

    it('makes the PUBLISHED RESULT the source of truth, and asks for the evidence id', () => {
      // ⚠️ AMENDED ON THE RECORD (MOTIR-5563). This test asserted the opposite —
      // `REPOSITORY stays the source of truth` and `never a replacement for
      // committing the two files` — and `design-result.md` AMENDMENT 5 Q1
      // RETIRES that rule: a project may not commit its designs at all, and a
      // hosted agent has no checkout to read them from. The retired phrases are
      // asserted ABSENT rather than merely un-asserted, so a revert is a red test
      // rather than a silent return.
      const prompt = designPrompt();
      expect(prompt).not.toContain('REPOSITORY stays the source of truth');
      expect(prompt).not.toContain('never a replacement for committing the two files');
      expect(prompt).toContain('THE PUBLISHED RESULT IS THE SOURCE OF TRUTH');
      expect(prompt).toContain('Committing the two files to the repository is OPTIONAL');
      expect(prompt).toContain('the published result is');
      expect(prompt).toContain('evidence id');
    });

    it('keeps the upload door for a large file', () => {
      const prompt = designPrompt();
      expect(prompt).toContain('create_design_upload');
      expect(prompt).toContain('One publish uses one form for all of its assets');
    });

    // ⚠️ RENUMBERED BY MOTIR-6963: the IDENTIFY step became step 1, so the stop is
    // step 7 and the publish step 8 — numbered from the design list, not typed.
    it('"Stop at the asset" SURVIVES as the stopping condition, before either step 8', () => {
      for (const keys of [['X-2'], []]) {
        const steps = whatToDo(designPrompt(keys));
        expect(steps).toContain(
          '7. Stop at the asset. A design is reviewed before anything is built',
        );
        expect(steps.indexOf('Stop at the asset')).toBeLessThan(steps.indexOf('\n8. '));
      }
    });

    it('the publish step is numbered DIRECTLY after the last design step, in both renders', () => {
      expect(whatToDo(designPrompt(['X-2']))).toContain('\n8. PUBLISH the design result — X-2');
      expect(whatToDo(designPrompt([]))).toContain('\n8. Do NOT publish a design result.');
      for (const keys of [['X-2'], []]) {
        const numbers = [...whatToDo(designPrompt(keys)).matchAll(/^(\d+)\. /gm)].map((m) =>
          Number(m[1]),
        );
        expect(numbers, `keys=${keys.join()}`).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      }
    });

    it('carries the step in BOTH workflow variants', () => {
      for (const sessionBranch of [null, 'session/MOTIR-1-lineage']) {
        const { prompt } = assembleDispatchPrompt(
          source({
            type: 'design',
            executor: 'coding_agent',
            sessionBranch,
            openDependentKeys: ['X-2'],
          }),
        );
        expect(prompt).toContain('PUBLISH the design result');
      }
    });

    it('changes NO other type’s steps', () => {
      // Asserted as a set difference rather than by eye: a broad edit to the
      // WHAT_TO_DO record would otherwise pass every marker test above.
      for (const type of Object.keys(MARKERS) as WorkItemTypeDto[]) {
        if (type === 'design') continue;
        const { prompt } = assembleDispatchPrompt(
          source({ type, executor: 'coding_agent', openDependentKeys: ['X-2'] }),
        );
        expect(prompt).not.toContain('PUBLISH the design result');
        expect(prompt).not.toContain('Do NOT publish a design result');
      }
    });
  });

  // ── MOTIR-6963: the design steps tell the two kinds of project apart.
  //
  // A project imported with its own component library has none of Motir's
  // tokens, and the old step 3 said only "the real design system", which an
  // agent filled with whatever it knew best. Step 1 now names the check, and the
  // three branches it decides between.
  describe('WHAT_TO_DO.design IDENTIFIES the design system first (MOTIR-6963)', () => {
    const whatToDo = (prompt: string): string =>
      prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    const steps = (openDependentKeys: string[] = ['X-2']): string =>
      whatToDo(
        assembleDispatchPrompt(
          source({ type: 'design', executor: 'coding_agent', openDependentKeys }),
        ).prompt,
      );

    it('step 1 is the identify step: BOTH checks, and the verdict in design-notes.md', () => {
      for (const keys of [['X-2'], []]) {
        const s = steps(keys);
        const one = s.slice(s.indexOf('\n1. '), s.indexOf('\n2. '));
        expect(one).toContain('1. IDENTIFY THE DESIGN SYSTEM before anything else.');
        expect(one).toContain('depends on @motir/design-system, AND its global CSS imports');
        expect(one).toContain('@motir/design-system/theme.css. Either check alone is NOT enough.');
        expect(one).toContain('the verdict as the first lines of design-notes.md');
        // Inventory keeps its meaning, one step later.
        expect(s).toContain('2. Read the card description above, then INVENTORY');
      }
    });

    it('the Motir Design branch: pinned version, own axes, renderMock or the fallback, parts order, missing parts', () => {
      const s = steps();
      for (const phrase of [
        '(a) ON MOTIR DESIGN (both checks hold). Read the installed version',
        'node_modules/@motir/design-system/package.json, else the lockfile',
        'data-palette / data-type (or its DESIGN.md',
        'never the',
        '@motir/design-system/mock, build the mock with renderMock',
        'actual markup with that version’s theme.css inlined',
        'width of the screen it is opened on, whatever its page’s own column:',
        "on a full-width board — renderMock’s boardWidth 'full'",
        'never post-process the rendered HTML',
        'package’s parts first, then the project’s own local components, then new',
        '"proposed addition to @motir/design-system" or "product-local component"',
      ]) {
        expect(s, `the Motir branch lost: ${phrase}`).toContain(phrase);
      }
    });

    it('the own-system branch names no token of Motir’s, and the empty case writes a Working palette', () => {
      const s = steps();
      const own = s.slice(s.indexOf('(b) ON ITS OWN SYSTEM'), s.indexOf('(c) NO COHERENT SYSTEM'));
      expect(own).toContain('its components directory, its Tailwind config or');
      expect(own).toContain('Use no --el-* token and no @motir/design-system import.');
      // `--el-*` appears there only to FORBID it.
      expect(own.split('Use no --el-* token').join('')).not.toContain('--el-');
      const none = s.slice(s.indexOf('(c) NO COHERENT SYSTEM'), s.indexOf('NEVER MIGRATE'));
      expect(none).toContain('BEFORE drawing');
      expect(none).toContain('"## Working palette"');
      expect(none).toContain('each with the file it came from');
    });

    it('states NEVER MIGRATE, and no sentence tells an agent to install or adopt the package', () => {
      const s = steps();
      expect(s).toContain(
        'NEVER MIGRATE: in every branch, the design never adds, installs or proposes',
      );
      const sentences = s.replace(/\s+/g, ' ').split(/(?<=\.) /);
      const adopting = sentences.filter(
        (x) =>
          /\b(install|adopt|add|migrate)\b/i.test(x) &&
          x.includes('@motir/design-system') &&
          !/\bnever\b/i.test(x),
      );
      expect(adopting).toEqual([]);
    });

    it('the two-file step composes from the system step 1 identified', () => {
      expect(steps()).toContain('composed from the design system');
      expect(steps()).toContain('step 1 identified, never a raw hex colour or a fixed radius.');
      expect(steps()).not.toContain("the real design\n   system's primitives");
    });
  });

  it('every type produces a DISTINCT WHAT TO DO block', () => {
    const blocks = (Object.keys(MARKERS) as WorkItemTypeDto[]).map((type) => {
      const { prompt } = assembleDispatchPrompt(source({ type, executor: 'coding_agent' }));
      return prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    });
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('an UNTYPED item gets the generic form and says so', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: null, executor: null }));
    expect(prompt).toContain('this work item has no `type` set');
    expect(prompt).toContain('type unset · executor unset');
    // It is still an agent prompt — the git workflow is present.
    expect(prompt).toContain('\nGIT WORKFLOW\n');
  });
});

describe('assembleDispatchPrompt — the MANUAL / human form', () => {
  it.each([
    ['type manual', { type: 'manual' as const, executor: 'coding_agent' as const }],
    ['executor human', { type: 'code' as const, executor: 'human' as const }],
  ])('%s yields the human-instruction form with NO git workflow', (_label, over) => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(source(over));
    expect(prompt).toContain('This is a MANUAL work item');
    expect(prompt).toContain('Never paste a secret into the work item.');
    expect(prompt).not.toContain('\nGIT WORKFLOW\n');
    expect(prompt).not.toContain('git worktree add');
    expect(prompt).toContain('There is no git workflow for this work item');
    expect(workflowMode).toBe('per_item_pr');
    expect(sessionBranch).toBeNull();
  });

  it('a manual item on an inherited lineage still reports no branch', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(
      source({ type: 'manual', sessionBranch: 'session/PROD-2-run' }),
    );
    expect(sessionBranch).toBeNull();
    expect(workflowMode).toBe('per_item_pr');
    expect(prompt).not.toContain('session/PROD-2-run');
  });

  it('still carries CONTEXT and ACCEPTANCE CRITERIA', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).toContain('\nCONTEXT\n');
    expect(prompt).toContain('- The bar filters by kind and priority.');
  });
});

describe('assembleDispatchPrompt — the GIT WORKFLOW variants', () => {
  it('no session branch → the per-item-PR variant', () => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source());
    expect(workflowMode).toBe('per_item_pr');
    expect(prompt).toContain('ships as ONE pull request of its own');
    expect(prompt).toContain(
      'git worktree add ../motir-core-prod-7 -b subtask/PROD-7-add-the-ready-set-filter-bar origin/main',
    );
    // MOTIR-3529 — UPDATED, not removed. This used to assert `TITLE carries`,
    // and the stakes it stood for are unchanged; what changed is the mechanism.
    // The title survives as a LABEL and the LINK is what carries the merge back.
    expect(prompt).toContain(`${'PROD-7'} in the TITLE as well`);
    expect(prompt).toContain('the title is a LABEL, not what links the pull');
    expect(prompt).toContain('LINK it: call the link_pull_request tool');
    expect(prompt).toContain('STOP at the open pull request');
    expect(prompt).not.toContain('mark_integrated');
  });

  it('the per-item-PR variant names everything the link call needs, so no step is a lookup', () => {
    // MOTIR-3529 criterion 2. An agent that has to go and FIND an argument is an
    // agent that skips the step, which is the failure the whole story is about.
    const { prompt } = assembleDispatchPrompt(source());
    const step = prompt.split('\n').find((l) => l.includes('link_pull_request'));
    expect(step, 'the link step is missing from the per-item-PR grammar').toBeDefined();
    expect(step).toContain('PROD-7');
    // MOTIR-3678 — the step's wording is now the SHARED one, so this asserts the
    // property the older text was standing in for: every argument is in hand.
    expect(prompt).toContain('pull request (its URL, or repository + number), plus headRef');
    expect(prompt).toContain('headRef subtask/PROD-7-add-the-ready-set-filter-bar');
    expect(prompt).toContain('baseRef main');
    // And it is IMMEDIATELY after the pull request, not left to the end.
    expect(prompt.indexOf('open a pull request against main')).toBeLessThan(
      prompt.indexOf('LINK it: call the link_pull_request tool'),
    );
  });

  it('an inherited session branch → the session-lineage variant', () => {
    const { prompt, workflowMode, sessionBranch } = assembleDispatchPrompt(
      source({ sessionBranch: 'session/PROD-2-run' }),
    );
    expect(workflowMode).toBe('session_lineage');
    expect(sessionBranch).toBe('session/PROD-2-run');
    expect(prompt).toContain('inherits the session branch session/PROD-2-run');
    expect(prompt).toContain('origin/session/PROD-2-run');
    expect(prompt).toContain('mark_integrated');
    // MOTIR-3678 — the agent no longer opens one OF ITS OWN, and is told what to
    // do about the one the run has usually already opened.
    expect(prompt).toContain('Do NOT open a pull request of your own.');
    expect(prompt).toContain('If it does not exist yet, you are the');
  });

  it('the branch PREFIX follows the diff content, not the card kind', () => {
    const branchOf = (type: WorkItemTypeDto) =>
      assembleDispatchPrompt(source({ type })).prompt.match(/-b (\S+) origin\/main/)?.[1];
    expect(branchOf('code')).toMatch(/^subtask\//);
    expect(branchOf('chore')).toMatch(/^subtask\//);
    expect(branchOf('design')).toMatch(/^design\//);
    // A decision takes no branch at all (MOTIR-7437).
    expect(branchOf('decision')).toBeUndefined();
    expect(branchOf('research')).toMatch(/^docs\//);
  });

  it('names a generic worktree directory when the repo is unknown', () => {
    const { prompt } = assembleDispatchPrompt(source({ targetRepo: null }));
    expect(prompt).toContain('git worktree add ../<repo>-prod-7');
  });
});

describe('branchSlug', () => {
  it('lower-cases, collapses punctuation, and caps the length', () => {
    expect(branchSlug('Add the ready-set filter bar')).toBe('add-the-ready-set-filter-bar');
    expect(branchSlug('  Fix: `targetRepo` (MOTIR-1804)!  ')).toBe('fix-targetrepo-motir-1804');
    expect(branchSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('never yields an empty or dangling-dash slug', () => {
    expect(branchSlug('———')).toBe('work');
    expect(branchSlug('')).toBe('work');
    // A title whose 40-char cut lands mid-separator must not end in a dash.
    expect(branchSlug(`${'a'.repeat(39)} tail`).endsWith('-')).toBe(false);
  });
});

describe('assembleDispatchPrompt — the Epic-9 injection extension point', () => {
  it('renders nothing when the slots are empty (the motir-core default)', () => {
    const withEmpty = assembleDispatchPrompt(source({ injections: NO_INJECTIONS })).prompt;
    expect(withEmpty).toBe(assembleDispatchPrompt(source()).prompt);
  });

  it('appends a filled lessons slot to CONTEXT', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ injections: { lessons: ['LESSON BLOCK'] } }),
    );
    const context = prompt.slice(prompt.indexOf('CONTEXT'), prompt.indexOf('WHAT TO DO'));
    expect(context).toContain('LESSON BLOCK');
  });

  it('has no conventions slot: the convention is fetched, not pasted (MOTIR-9084)', () => {
    expect(Object.keys(NO_INJECTIONS)).toEqual(['lessons']);
  });
});

// The PROSE-vs-GRAPH advisory block (MOTIR-2079) — items the card's ACCEPTANCE
// CRITERIA name while it carries no `blocked_by` edge to them, rendered into
// CONTEXT so EVERY harness inherits the instruction. The CLI never assembles
// prompt text, so a warning that lived only there would reach one harness; this
// is the half that reaches all of them.
describe('assembleDispatchPrompt — the prose-vs-graph advisory block (MOTIR-2079)', () => {
  const advisory = (referenced: string, referencedStatus: string) => ({
    item: 'PROD-7',
    referenced,
    referencedStatus,
    severity: 'likely-missing-edge' as const,
  });

  it('renders each reference with its status, inside CONTEXT', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review')] }),
    );
    const context = prompt.slice(prompt.indexOf('CONTEXT'), prompt.indexOf('WHAT TO DO'));
    expect(context).toContain('PROD-5 (in_review)');
    expect(context).toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('renders the exact counted blocker claim beside the graph count', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        advisories: [
          {
            kind: 'shape',
            item: 'PROD-7',
            severity: 'likely-blocker-count-mismatch',
            claim: 'all four siblings this card is blocked_by',
            claimedCount: 4,
            blockerCount: 2,
          },
        ],
      }),
    );
    expect(prompt).toContain('"all four siblings this card is blocked_by" says 4');
    expect(prompt).toContain('graph holds 2 blocked_by edges');
  });

  it('names an UNDER-AUTHORED card and tells the agent to proceed, not stop (MOTIR-5427)', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        advisories: [
          { kind: 'shape', item: 'PROD-7', severity: 'under-authored', criteria: 'no-heading' },
        ],
      }),
    );
    expect(prompt).toContain('THIS CARD IS UNDER-AUTHORED');
    expect(prompt).toContain('This is not a');
  });

  it('instructs the agent to VERIFY against origin/main and to STOP rather than rebuild', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review')] }),
    );
    expect(prompt).toContain('origin/main');
    expect(prompt).toContain('blocked_by');
    // The specific failure it exists to prevent, named so the agent cannot read
    // this as "go ahead and build the other half too".
    expect(prompt).toContain('Do not rebuild the other half');
  });

  it('lists EVERY advisory, not just the first', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ advisories: [advisory('PROD-5', 'in_review'), advisory('PROD-9', 'todo')] }),
    );
    expect(prompt).toContain('PROD-5 (in_review)');
    expect(prompt).toContain('PROD-9 (todo)');
  });

  it('renders NOTHING for an empty list — no heading, byte-identical to omitting it', () => {
    const empty = assembleDispatchPrompt(source({ advisories: [] })).prompt;
    expect(empty).toBe(assembleDispatchPrompt(source()).prompt);
    expect(empty).not.toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('changes NOTHING but the CONTEXT text — same workflow mode, same branch, same sections', () => {
    // The load-bearing invariant: an advisory is told, never acted on. If a
    // future change lets one steer the GIT WORKFLOW variant, it has become a
    // gate — which would falsely stop the three legitimate shapes MOTIR-1969
    // enumerates (boundary-contract cards, contrast references, will-be-done-first).
    const without = assembleDispatchPrompt(source());
    const with_ = assembleDispatchPrompt(source({ advisories: [advisory('PROD-5', 'todo')] }));
    expect(with_.workflowMode).toBe(without.workflowMode);
    expect(with_.sessionBranch).toBe(without.sessionBranch);
    for (const heading of SECTIONS) expect(with_.prompt).toContain(heading);
    // …and the sections AFTER context are untouched, character for character.
    const tail = (p: string) => p.slice(p.indexOf('WHAT TO DO'));
    expect(tail(with_.prompt)).toBe(tail(without.prompt));
  });
});

// THE OUTCOME PROTOCOL (MOTIR-2406).
//
// `motir auto` runs `claude --dangerously-skip-permissions` in a sandbox against
// the user's own key: no wrapper, no policy layer, no second channel. The prompt
// is the entire contract with the agent, so every assertion here is about text
// that either reaches it or does not exist.
// ── THE LINKING SENTENCE (Story MOTIR-3672 · MOTIR-3678) ─────────────────────
//
// One text, every grammar. The point of the card is that an agent never has to
// work out which lane it is in before it can follow the instruction, and the
// only way that stays true is a test that fails when the two drift.
describe('assembleDispatchPrompt — the linking sentence is ONE text', () => {
  const RATIONALE = LINKING_RATIONALE.join('\n');

  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'motir/auto-20260827-120000'],
  ])('renders it BYTE-IDENTICALLY in the %s grammar', (mode, sessionBranch) => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    // Indentation is the only thing a grammar may vary, so the comparison is on
    // the de-indented text — which is what makes this an assertion about the
    // WORDS rather than about the list they sit in.
    const flat = prompt
      .split('\n')
      .map((l) => l.trim())
      .join('\n');
    expect(flat).toContain(
      RATIONALE.split('\n')
        .map((l) => l.trim())
        .join('\n'),
    );
  });

  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'motir/auto-20260827-120000'],
  ])('tells the %s grammar to CALL link_pull_request with the card key', (mode, sessionBranch) => {
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(prompt).toContain('call the link_pull_request tool with key PROD-7');
  });

  it('says the title is a LABEL with no fallback, and NAMES the failing check', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('There is no fallback');
    expect(prompt).toContain('Motir / work item link');
    expect(prompt).toContain('it goes green on the link itself');
  });

  // ⚠️ The contradiction this card was filed on: `outcomeProtocol` renders for
  // BOTH grammars and used to say "open the pull request" to an agent whose git
  // workflow said not to.
  it('never tells a SESSION-LINEAGE agent to open a pull request of its own', () => {
    const branch = 'motir/auto-20260827-120000';
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch: branch }));
    expect(prompt).not.toContain('    3. open the pull request');
    expect(prompt).toContain('find the session pull request for this repository');
    expect(prompt).toContain(`gh pr list --head ${branch}`);
  });

  it('still tells a PER-ITEM agent to open one', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('    3. open the pull request');
  });
});

describe('assembleDispatchPrompt — REPORTING THE OUTCOME', () => {
  // ⚠️ BOTH VARIANTS, asserted separately. A section added to one branch of a
  // two-branch assembler is the classic half-shipped prompt change, and it would
  // read as working right up until the first item of a run — which is exactly
  // the one with no lineage.
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('is present in the %s variant', (mode, sessionBranch) => {
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    expect(outcomeSection(prompt)).toContain('Two outcomes end this work');
  });

  // THE MODEL SELF-REPORT (MOTIR-2419) — the one fact only the agent holds.
  // It rides in this section because it applies to BOTH outcomes: a card that
  // turned out to be wrong was still worked by a model.
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('asks for the model in the %s variant', (mode, sessionBranch) => {
    // Same half-shipped hazard as the protocol around it: a line added to one
    // branch of the assembler leaves every first-item-of-a-run with no model.
    const { prompt, workflowMode } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(workflowMode).toBe(mode);
    const outcome = outcomeSection(prompt);
    expect(outcome).toContain('MOTIR_AGENT_REPORT');
    expect(outcome).toContain('{"model": "<the model you are running as>"}');
  });

  it('tells the agent to write NOTHING rather than guess', () => {
    // The version of the provenance bug that would survive the fix: a model the
    // agent inferred looks exactly like one it observed.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('write no file at all');
    expect(outcome).toContain('and a guessed one is not');
    // …and the REASON it is the only chance, so the instruction is not read as
    // ceremony to skip when busy.
    expect(outcome).toContain('Nothing outside your process can observe which model answered');
  });

  it('is conditional on the variable, so a --print reader is not told to invent a path', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('If the variable is unset, skip this entirely');
  });

  it('comes BEFORE the two outcomes, because it applies to both', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const report = outcome.indexOf('MOTIR_AGENT_REPORT');
    expect(report).toBeGreaterThan(-1);
    for (const later of ['FINISHED —', 'THE CARD IS WRONG']) {
      expect(outcome.indexOf(later), `${later} comes after the self-report`).toBeGreaterThan(
        report,
      );
    }
  });

  it('the FINISHED signal names implemented and says it is REQUIRED', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('status implemented');
    expect(outcome).toContain('REQUIRED, not a courtesy');
    // The reason, not just the rule: an agent told only "do this" treats it as
    // ceremony, and the loop's whole ability to tell success from a quiet death
    // rests on it.
    expect(outcome).toContain('died quietly');
  });

  it('states the ORDER — commit, push, open the PR, THEN transition (MOTIR-3004)', () => {
    // Asserted as an ORDER on the assembled string, not as four strings that
    // happen to be present: an agent handed an unordered list does the cheap
    // status call first, and then the card claims built work that exists only in
    // a worktree the run is about to delete.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const at = (needle: string) => outcome.indexOf(needle);
    expect(at('1. commit')).toBeGreaterThan(-1);
    expect(at('2. push the branch')).toBeGreaterThan(at('1. commit'));
    expect(at('3. open the pull request')).toBeGreaterThan(at('2. push the branch'));
    expect(at('status implemented')).toBeGreaterThan(at('3. open the pull request'));
    // …and it says WHAT the status claims, which is the whole reason for the order.
    expect(outcome).toContain('THE CODE IS ON THE REMOTE');
  });

  it('tells the agent that In Review belongs to CI, not to it (MOTIR-3004)', () => {
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('Do NOT set In Review');
    expect(outcome).toContain('CI does');
  });

  it("no assembled text still claims the agent's pull request causes In Review", () => {
    // The GIT WORKFLOW step used to say the title reference "is what moves this
    // work item to In Review". After this story that half is false, and a prompt
    // that says both things teaches the agent the wrong owner of the status.
    const prompt = assembleDispatchPrompt(source()).prompt;
    expect(prompt).not.toContain('moves this work item to In Review');
  });

  it('the defect signal names Planning and NEVER offers `blocked`', () => {
    // The intuitive word for "this card cannot proceed" is `blocked`, and an
    // agent offered both will reach for it — where it would change a label and
    // nothing else, leaving the card ready and pickable (MOTIR-2425).
    // Scoped to the CARD-OUTCOME branches: the claim is about which STATUS the
    // agent is offered for its own card, and the FOUND A DEFECT branch that now
    // follows names the `blocked_by` EDGE — a different word in a different role,
    // and the one thing a filed bug must not create.
    const outcome = cardOutcomeBranches(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('status planning');
    expect(outcome).toContain('in-progress');
    expect(outcome.toLowerCase()).not.toContain('blocked');
  });

  it('REVERT FIRST comes before every other defect step', () => {
    // Ordering is the assertion, not presence. An agent that reads "record the
    // finding" before "commit nothing" has already had four steps in which to
    // commit a half-change.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    const revert = outcome.indexOf('REVERT FIRST');
    expect(revert).toBeGreaterThan(-1);
    for (const later of ['Do not improvise', 'Comment the finding', 'Move PROD-7 to Planning']) {
      expect(outcome.indexOf(later), `${later} comes after REVERT FIRST`).toBeGreaterThan(revert);
    }
  });

  it('names the exact submit, key substituted — the TOOL, anchored at this card', () => {
    // Verbatim, because an agent told to "submit your findings for re-planning"
    // will invent an invocation — and the likely invention is an unanchored
    // thread, which produces a project-wide plan about one card's defect.
    // ⚠️ THE INVOCATION CHANGED (MOTIR-4083): the door is `submit_plan_session`
    // with `targetKeys: [<KEY>]`, not `motir plan --detach <KEY>`. The full
    // contract of the two tool steps is the MOTIR-4083 block below; this keeps
    // the original claim — the anchor is spelled out, with the key in it.
    const outcome = outcomeSection(assembleDispatchPrompt(source({ key: 'PROD-99' })).prompt);
    expect(outcome).toContain('submit_plan_session tool');
    expect(outcome).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(outcome).toContain('anchors the thread to this card');
    expect(outcome).not.toContain('motir plan');
  });

  it('bans RESTRUCTURING the plan, and no longer bans creation at all', () => {
    // ⚠️ THIS REPLACES an assertion that pinned the opposite (MOTIR-3020). The
    // old text forbade creating any work item, justified as *"A plan is
    // PROPOSALS awaiting a human's approval; writing the cards would be doing
    // the approving"* — a sentence that misdescribes the mechanism, since
    // `create_work_item` is a direct write entering no proposal pipeline. The
    // half that was load-bearing survives and is what is asserted here; the
    // justification must be gone from the WHOLE prompt, not merely reworded.
    const { prompt } = assembleDispatchPrompt(source());
    const outcome = outcomeSection(prompt);
    expect(outcome).toContain('Do NOT RESTRUCTURE THE PLAN');
    for (const forbidden of ['no archiving', 're-parenting', 're-scoping']) {
      expect(outcome).toContain(forbidden);
    }
    expect(prompt).not.toContain('PROPOSALS');
    expect(prompt).not.toContain('do not create or edit work items yourself');
  });

  it('gives the no-retry rule its REASON, not a bare prohibition', () => {
    // A rule with no reason is a rule an agent reasons its way around — "the
    // timeout means it did not land, so retrying is safe" is exactly the
    // inference that spends the credits twice.
    const outcome = outcomeSection(assembleDispatchPrompt(source()).prompt);
    expect(outcome).toContain('Never retry it');
    expect(outcome).toContain('credits');
  });

  it('comes LAST — after the git workflow, not before it', () => {
    // Placement is emphasis: the last thing in the prompt is what the agent is
    // holding when it starts acting. With the protocol earlier, the git workflow
    // is the final word and "move the card to In Review" is the step that gets
    // forgotten.
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt.indexOf('REPORTING THE OUTCOME')).toBeGreaterThan(prompt.indexOf('GIT WORKFLOW'));
    // The section's own last line, which MOTIR-3020 moved: the third branch now
    // closes it, and its final instruction is the one that matters most about a
    // side-finding — that it is not an ending.
    expect(prompt.trimEnd().endsWith('report its own outcome as above.')).toBe(true);
  });

  it('a MANUAL item gets NEITHER — it has no branch, no commit and no session', () => {
    // `motir auto` skips human work, and a person is not going to call
    // `transition_status`. The manual closing note already says how to report
    // completion.
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).not.toContain('REPORTING THE OUTCOME');
    expect(prompt).not.toContain('YOUR COMMIT');
    // Nor the model self-report: no agent runs, so there is no model to name
    // and nothing writes the file the loop would read (MOTIR-2419).
    expect(prompt).not.toContain('MOTIR_AGENT_REPORT');
    expect(prompt).toContain('There is no git workflow for this work item');
  });
});

describe('assembleDispatchPrompt — REPORTING YOUR STEPS (MOTIR-7501)', () => {
  it('a run prompt tells the agent to call report_action before each step, naming its key', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('\nREPORTING YOUR STEPS');
    expect(prompt).toContain('call the report_action tool with key PROD-7');
    expect(prompt).toContain('report_action { key: "PROD-7", action: "Run the changed tests" }');
    expect(prompt).toContain('at most 500 characters');
    expect(prompt).toContain('Never a transcript, file contents, a diff, a prompt or a secret');
    expect(prompt).toContain('Do not send `events`');
    // Before the git workflow, so it is read before the agent starts working.
    expect(prompt.indexOf('REPORTING YOUR STEPS')).toBeLessThan(prompt.indexOf('GIT WORKFLOW'));
  });

  it('a session-lineage prompt carries it too', () => {
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch: 'session/PROD-2-run' }));
    expect(prompt).toContain('call the report_action tool with key PROD-7');
  });

  it('a prompt that builds nothing — a MANUAL item — does not', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual', executor: 'human' }));
    expect(prompt).not.toContain('report_action');
    expect(prompt).not.toContain('REPORTING YOUR STEPS');
  });
});

describe('assembleDispatchPrompt — ONE CARD, ONE COMMIT (MOTIR-2406)', () => {
  it.each([
    ['per_item_pr', null],
    ['session_lineage', 'session/PROD-2-run'],
  ])('the commit contract rides the %s git workflow', (_mode, sessionBranch) => {
    const { prompt } = assembleDispatchPrompt(source({ sessionBranch }));
    expect(prompt).toContain('ONE commit for PROD-7');
  });

  it('says the message BECOMES the pull request, and what that asks of it', () => {
    // The reason the instruction is here rather than in a reviewer's
    // expectations: nobody reading the pull request opens the card, so this
    // message is the only per-card narrative that reaches them.
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('THE MESSAGE BECOMES THE PULL REQUEST');
    expect(prompt).toContain('REVIEWER WHO WAS NOT');
    expect(prompt).toContain('will not open the card');
    // Subject AND body, because a one-liner leaves the pull request with a
    // heading and no reasoning under it.
    expect(prompt).toContain('Subject: what changed');
    expect(prompt).toContain('one-liner');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The MULTI-REPOSITORY grammar (Story MOTIR-2731 · MOTIR-3132)
// ─────────────────────────────────────────────────────────────────────────────
//
// The instruction this replaces was not vague — it was COMPLETE, and wrong for
// one shape of card. `perItemPrWorkflow` names a worktree, a branch, a commit
// convention and a stopping point, so an agent handed a two-repository card
// follows it exactly, opens one pull request and exits 0. The card then sits at
// In Review forever, held by a completion gate waiting on a repository nothing
// ever told anyone to open a pull request against, and the run that caused it
// looks green.
//
// So the property under test is a pair:
//
//   * fewer than two repositories renders EXACTLY today's text — asserted
//     against the source with and without the field, byte for byte, because
//     "every existing card is unaffected" is the whole back-compatibility claim
//     and it is cheap to prove rather than intend;
//   * two or more renders one worktree, one branch and one pull request PER
//     repository, sharing ONE branch name, every pull-request title carrying the
//     key, and a closing line that says the item completes only when all of them
//     have merged.

/** Two repositories, primary first, with different default branches — so a
 *  block that branched from a hardcoded `main` is visible. */
const TWO_REPOS = [
  { name: 'motir-core', defaultBranch: 'main' },
  { name: 'motir-ai', defaultBranch: 'trunk' },
];

describe('the repository COUNT axis — fewer than two changes nothing', () => {
  it('renders byte-identically with no field, an empty set, and a one-element set', () => {
    const base = assembleDispatchPrompt(source()).prompt;
    expect(assembleDispatchPrompt(source({ targetRepos: [] })).prompt).toBe(base);
    expect(
      assembleDispatchPrompt(
        source({ targetRepos: [{ name: 'motir-core', defaultBranch: 'main' }] }),
      ).prompt,
    ).toBe(base);
  });

  it('renders byte-identically for an UNPINNED card and for a SESSION-LINEAGE card', () => {
    const unpinned = source({ targetRepo: null });
    expect(assembleDispatchPrompt({ ...unpinned, targetRepos: [] }).prompt).toBe(
      assembleDispatchPrompt(unpinned).prompt,
    );
    const lineage = source({ sessionBranch: 'motir/auto-1' });
    expect(
      assembleDispatchPrompt({
        ...lineage,
        targetRepos: [{ name: 'motir-core', defaultBranch: 'main' }],
      }).prompt,
    ).toBe(assembleDispatchPrompt(lineage).prompt);
  });

  it('renders NO GIT WORKFLOW at all for a manual item, however many repositories it names', () => {
    // A manual item has no branch and no pull request; instructing N of them
    // would be a lie the CLI could act on, and the repository count does not
    // make it less of one.
    const manual = assembleDispatchPrompt(
      source({ type: 'manual', executor: 'human', targetRepos: TWO_REPOS }),
    );
    expect(manual.prompt).not.toContain('GIT WORKFLOW');
    expect(manual.prompt).not.toContain('git worktree add');
    expect(manual.workflowMode).toBe('per_item_pr');
    expect(manual.sessionBranch).toBeNull();
  });
});

describe('the MULTI-REPOSITORY per-item-PR workflow', () => {
  const built = () => assembleDispatchPrompt(source({ targetRepos: TWO_REPOS })).prompt;

  it('renders one worktree, one branch and one pull request PER repository, in set order', () => {
    const prompt = built();
    expect(prompt.match(/git worktree add/g)).toHaveLength(2);
    expect(prompt).toContain('git worktree add ../motir-core-prod-7 -b');
    expect(prompt).toContain('git worktree add ../motir-ai-prod-7 -b');
    // Each block ENTERS its own repository first, so every worktree path is the
    // same `../<repo>-<key>` the single-repository grammar renders.
    expect(prompt).toContain('1. cd . && git fetch origin');
    expect(prompt).toContain('1. cd ../motir-ai && git fetch origin');
    // Set order, primary first — the primary is the one the agent stands in.
    expect(prompt.indexOf('motir-core  (your working directory)')).toBeLessThan(
      prompt.indexOf('motir-ai  (a sibling checkout)'),
    );
  });

  it('branches each repository from ITS OWN default branch, never a hardcoded main', () => {
    const prompt = built();
    expect(prompt).toContain('-b subtask/PROD-7-add-the-ready-set-filter-bar origin/main');
    expect(prompt).toContain('-b subtask/PROD-7-add-the-ready-set-filter-bar origin/trunk');
    expect(prompt).toContain('open a pull request against trunk.');
  });

  it('falls back to `origin/main` for a repository whose default branch Motir does not know', () => {
    // `null`, never a guessed branch — the same rule the payload's coordinates
    // follow. `main` is the fallback the single-repository grammar has always
    // hardcoded, so an unknown default branch renders the text that already
    // shipped rather than a second unknown.
    const prompt = assembleDispatchPrompt(
      source({
        targetRepos: [
          { name: 'motir-core', defaultBranch: null },
          { name: 'motir-ai', defaultBranch: null },
        ],
      }),
    ).prompt;
    expect(prompt.match(/origin\/main/g)).toHaveLength(2);
    expect(prompt).toContain('open a pull request against main.');
  });

  it('uses the SAME branch name in every repository', () => {
    const branch = `subtask/PROD-7-${branchSlug('Add the ready-set filter bar')}`;
    const names = [...built().matchAll(/-b (\S+) origin\//g)].map((m) => m[1]);
    expect(names).toEqual([branch, branch]);
  });

  it('LINKS every pull request — once per repository, the reference the completion gate reads', () => {
    // MOTIR-3529 — UPDATED, not removed. This used to count `TITLE carries`
    // lines. The stakes are unchanged and still the reason it exists: the gate
    // counts merges against the item's LINKED pull requests, so a pull request
    // the gate cannot see holds the card open on work that has shipped. What
    // changed is that the link is now DECLARED rather than parsed out of a
    // string — and it is per REPOSITORY, because each has its own pull request.
    //
    // Counted on the GIT-WORKFLOW step specifically. The outcome protocol names
    // the tool a third time, in its finish order — deliberately, and asserted
    // separately below rather than folded into this count, since one is
    // per-repository and the other is per-item.
    const linkSteps = built()
      .split('\n')
      .filter((l) => l.includes('LINK it: call the link_pull_request tool'));
    expect(linkSteps).toHaveLength(2);
    for (const step of linkSteps) expect(step).toContain('PROD-7');
    expect(built()).toContain('ONCE PER REPOSITORY');
  });

  it('the outcome protocol’s finish ORDER carries the link too — between the PR and Implemented', () => {
    // The third carrier, and the one that would otherwise contradict the two
    // above: an agent following this list literally would go commit → push →
    // open → transition and never link.
    const prompt = built();
    const order = prompt.slice(prompt.indexOf('IN THIS ORDER'));
    expect(order.indexOf('3. open the pull request')).toBeLessThan(
      order.indexOf('4. link it with the link_pull_request tool'),
    );
    expect(order.indexOf('4. link it with the link_pull_request tool')).toBeLessThan(
      order.indexOf('5. move PROD-7 to Implemented'),
    );
    expect(order).toContain('once per repository if this item');
  });

  it('keeps the key in every TITLE, re-framed as a LABEL rather than the mechanism', () => {
    // The label half of the same change: dropping it would cost a human reading
    // a pull-request list, which is a real reader with no other affordance.
    const titleSteps = built()
      .split('\n')
      .filter((l) => l.includes('in the TITLE as well'));
    expect(titleSteps).toHaveLength(2);
    for (const step of titleSteps) expect(step).toContain('PROD-7');
    expect(built()).toContain('it is not what links the pull request');
  });

  it('says the item completes only when EVERY pull request has merged, and never instructs a merge', () => {
    const prompt = built();
    expect(prompt).toContain('STOP at the 2 open pull requests.');
    expect(prompt).toContain('EVERY one of them has merged');
    expect(prompt).not.toContain('squash-merge');
    expect(prompt).not.toContain('git branch -d');
  });

  it('has the agent take a no-change repository OFF the card and record why (MOTIR-9235)', () => {
    // Reporting it was not enough: the repository stayed on the card, the
    // completion gate counted it `awaiting`, and the card was held after its
    // real work merged. The sentence is pinned whole, because each clause is a
    // step: the tool, the field, the order, and the discrepancy it is recorded as.
    const prompt = built();
    expect(prompt).toContain(
      [
        'If one repository turns out to need no change at all, open no pull request there.',
        'Take it off the card instead: call the update_work_item tool with key PROD-7',
        'and targetRepos set to the repositories you DID change, in their current order.',
        'The item completes only when every repository on its list has merged, so a',
        'repository left there holds it open for ever. Then record why as a point of your',
        'ONE record_run_discrepancy call — planAsked: that repository; built: no change;',
        'why: what made the change unnecessary — and name it in your outcome report.',
      ].join('\n'),
    );
    expect(prompt).not.toContain('somebody has to decide what it means');
  });

  it('names every repository in CONTEXT, marks the working directory, and asserts no absolute path', () => {
    const prompt = built();
    expect(prompt).toContain('- Repositories (2) — this item ships in EVERY one of them:');
    expect(prompt).toContain('- motir-core — the PRIMARY, and your working directory.');
    expect(prompt).toContain('- motir-ai — expected as a sibling of it, at ../motir-ai.');
    // The server cannot know where a person keeps their checkouts; the run does.
    expect(prompt).not.toMatch(/^\s*-\s+\/[A-Za-z]/m);
    // The single-repository line is GONE for this card, not printed beside it.
    expect(prompt).not.toContain('- Repo: motir-core');
  });

  it('carries NO delivery state — the prompt instructs, the run informs', () => {
    // Delivery is the one fact that DIFFERS between two dispatches of an
    // unchanged card, and the prompt is a pure function of server state. Putting
    // it here would make a resumed run read as a different card (MOTIR-3136 owns
    // telling the person).
    // Scoped to the CONTEXT block that names the repositories: the word
    // "awaiting" legitimately appears in the outcome protocol, about a PLAN
    // awaiting approval, which is a different fact entirely.
    const repoBlock = built()
      .split('\n')
      .filter((l) => l.includes('motir-core') || l.includes('motir-ai'))
      .join('\n');
    for (const state of ['delivered', 'awaiting', 'unestablished', 'excluded']) {
      expect(repoBlock).not.toContain(state);
    }
  });
});

describe('the MULTI-REPOSITORY session-lineage workflow', () => {
  const built = () =>
    assembleDispatchPrompt(source({ targetRepos: TWO_REPOS, sessionBranch: 'motir/auto-1' }));

  it('instructs the same session branch in every repository and exactly ONE mark_integrated', () => {
    const { prompt, workflowMode, sessionBranch } = built();
    expect(workflowMode).toBe('session_lineage');
    expect(sessionBranch).toBe('motir/auto-1');
    expect(prompt.match(/origin\/motir\/auto-1/g)).toHaveLength(2);
    expect(prompt.match(/Integrate the commit into motir\/auto-1/g)).toHaveLength(2);
    // ONE call for the item, not one per repository: `work_item.sessionBranch`
    // is a scalar, which is the same reason the branch name is shared.
    expect(prompt.match(/mark_integrated/g)).toHaveLength(1);
  });

  it('opens no pull request in any repository', () => {
    expect(built().prompt).toContain('Do NOT open a pull request OF YOUR OWN in any repository.');
    expect(built().prompt).not.toContain('TITLE carries');
  });
});

// ── the FOUND A DEFECT branch and the per-run findings policy (MOTIR-3020) ───
//
// `docs/decisions/run-findings-protocol.md` Q1 (the policy's shape) and Q3 (the
// bug's parent) are what this asserts against.

/** The third branch's text alone — an assertion about it must not be satisfiable
 *  by the two card-outcome branches above it. */
function defectBranch(prompt: string): string {
  const at = prompt.indexOf('FOUND A DEFECT');
  expect(at, 'the prompt carries a FOUND A DEFECT branch').toBeGreaterThan(-1);
  return prompt.slice(at);
}

const VARIANTS: { name: string; over: Partial<DispatchPromptSource> }[] = [
  { name: 'per_item_pr', over: { sessionBranch: null } },
  { name: 'session_lineage', over: { sessionBranch: 'motir/auto-20260819' } },
];

describe('assembleDispatchPrompt — FOUND A DEFECT', () => {
  it('instructs: reproduce first, file a bug with the evidence, then carry on', () => {
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('REPRODUCE IT FIRST');
    expect(branch).toContain('create_work_item');
    expect(branch).toContain("kind:      'bug'");
    expect(branch).toContain('THE REPRODUCTION');
    expect(branch).toContain('THE EVIDENCE');
    expect(branch).toContain('Carry on with your card');
  });

  it('says explicitly that filing does NOT end the run or change its own outcome', () => {
    // The one thing an agent gets wrong unprompted: it has just found something
    // broken, and treats that as a reason to stop.
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('This is NOT');
    expect(branch).toContain('an ending');
    expect(branch).toContain('does not finish your card');
    expect(branch).toContain('does not fail it');
  });

  it('names the parent as a KEY, leaving nothing for the agent to choose', () => {
    // ADR Q3: the in-flight card's PARENT, which is already on the dispatch
    // payload — so the text states the key rather than a rule to apply.
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('parentKey: PROD-2');
    expect(branch).toContain('not a choice');
    expect(branch).toContain('do not invent one');
  });

  it('falls back to the card ITSELF when it has no parent — never the project root', () => {
    const branch = defectBranch(assembleDispatchPrompt(source({ parent: null })).prompt);
    expect(branch).toContain('parentKey: PROD-7');
    expect(branch).toContain('which has no parent of its own');
  });

  it('opens the bug description with the literal found-while line, key filled in (MOTIR-5994)', () => {
    // The agent COPIES a line rather than composing one, so every dispatched
    // bug opens the same way — and the activity is `running` by construction,
    // because a dispatched agent is only ever running a card.
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('**Found while:** running PROD-7');
    expect(branch).toContain('description OPENS with this exact line');
    // It comes BEFORE the reproduction and the evidence, which keep their order.
    const line = branch.indexOf('**Found while:** running PROD-7');
    const repro = branch.indexOf('THE REPRODUCTION');
    const evidence = branch.indexOf('THE EVIDENCE');
    expect(line).toBeLessThan(repro);
    expect(repro).toBeLessThan(evidence);
    // The branch/commit reason survives the fold, and the old free-form bullet is gone.
    expect(branch).toContain('the branch or commit');
    expect(branch).toContain('A number measured on an unmerged branch is not a number');
    expect(branch).not.toContain('WHERE IT WAS SEEN');
  });

  it('renders the found-while line with the IN-FLIGHT key for a top-level card too', () => {
    // The two `parentNote` arms: the parent key differs, the found-while key does not.
    const withParent = defectBranch(assembleDispatchPrompt(source()).prompt);
    const topLevel = defectBranch(assembleDispatchPrompt(source({ parent: null })).prompt);
    expect(withParent).toContain('parentKey: PROD-2');
    expect(withParent).toContain('**Found while:** running PROD-7');
    expect(topLevel).toContain('parentKey: PROD-7');
    expect(topLevel).toContain('**Found while:** running PROD-7');
    expect(topLevel).not.toContain('**Found while:** running PROD-2');
  });

  it('keeps the comment branch free of the found-while line when filing is off', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: false, replan: true, autoApproveReplan: false } }),
    );
    expect(defectBranch(prompt)).not.toContain('**Found while:**');
  });

  it('requires the relates_to trace and forbids the bug blocking anything', () => {
    const branch = defectBranch(assembleDispatchPrompt(source()).prompt);
    expect(branch).toContain('relates_to');
    expect(branch).toContain('BLOCKS NOTHING');
    expect(branch).toContain('No blocked_by edge, no sprint, no estimate');
  });

  it('the WHAT TO DO step and the outcome protocol agree, read out of ONE prompt', () => {
    // ⚠️ The drift this closes: `WHAT_TO_DO.code` step 5 told the agent to "log
    // anything else you find as a separate work item" while the outcome protocol
    // two sections later forbade creating any work item — both in every shipped
    // `code` prompt. Asserted from a SINGLE assembled string so the two texts
    // cannot disagree again without failing here.
    const { prompt } = assembleDispatchPrompt(source({ type: 'code' }));
    const step = prompt.slice(prompt.indexOf('WHAT TO DO'), prompt.indexOf('ACCEPTANCE CRITERIA'));
    expect(step).toContain('FOUND A DEFECT');
    // The exact instruction that contradicted the protocol is gone — and it is
    // the PHRASE that has to go, not the word: the step still says "auto-loaded"
    // two lines up, and an assertion on `log` alone would fail on that.
    expect(step).not.toContain('log anything else you find as a separate work item');
    expect(step).toContain('whether this run may file it');
    // And what it points at actually exists in the same prompt.
    expect(prompt).toContain('FOUND A DEFECT — your card is fine');
  });
});

describe('assembleDispatchPrompt — the per-run findings policy', () => {
  it('renders the FULL protocol when no policy is supplied', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).toContain('FOUND A DEFECT');
    expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
  });

  it('renders the FULL protocol for an explicitly-permissive policy, identically', () => {
    // The default is a VALUE, not a separate code path: an omitted policy and an
    // all-true one must produce the same bytes, or "omitted means full" is a
    // second implementation of the same claim.
    const omitted = assembleDispatchPrompt(source()).prompt;
    const explicit = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false } }),
    ).prompt;
    expect(explicit).toBe(omitted);
  });

  describe.each(VARIANTS)('on $name', ({ over }) => {
    it('with bug filing DISABLED renders no branch at all, and says comment instead', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: false, replan: true, autoApproveReplan: false },
        }),
      );
      // Empty in, nothing out: no instructions, no `create_work_item`, no trace.
      expect(prompt).not.toContain('create_work_item');
      expect(prompt).not.toContain('REPRODUCE IT FIRST');
      expect(prompt).not.toContain('BLOCKS NOTHING');
      // But the finding still reaches a human — a disabled policy was never
      // asking the agent to forget what it saw.
      expect(prompt).toContain('without bug filing');
      expect(prompt).toContain('Comment the finding on PROD-7 instead');
      // The other switch is untouched.
      expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
    });

    it('with re-planning DISABLED renders no submit step, and leaves the card in progress', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: true, replan: false, autoApproveReplan: false },
        }),
      );
      expect(prompt).not.toContain('submit_plan_session');
      expect(prompt).not.toContain('append_plan_turn');
      expect(prompt).not.toContain('status planning');
      expect(prompt).toContain('leave the card In Progress');
      expect(prompt).toContain('without re-planning');
      // The other switch is untouched.
      expect(prompt).toContain('create_work_item');
    });

    it('with BOTH disabled keeps the FINISHED branch whole', () => {
      const { prompt } = assembleDispatchPrompt(
        source({
          ...over,
          findingsPolicy: { logBug: false, replan: false, autoApproveReplan: false },
        }),
      );
      expect(prompt).toContain('FINISHED — the work is done');
      expect(prompt).toContain('status implemented');
      expect(prompt).not.toContain('create_work_item');
      expect(prompt).not.toContain('submit_plan_session');
    });
  });

  it('DETERMINISM holds per policy — and two policies differ, so the switch is not inert', () => {
    // ⚠️ BOTH HALVES. The module's contract (MOTIR-881) is byte-identical output
    // for an unchanged input; the policy is now part of that input. Asserting
    // only the first half would pass just as well against a switch that renders
    // the same text whatever it is handed, and every disabled-branch assertion
    // above would then be vacuous.
    const full = source({
      findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false },
    });
    const none = source({
      findingsPolicy: { logBug: false, replan: false, autoApproveReplan: false },
    });
    expect(assembleDispatchPrompt(full).prompt).toBe(assembleDispatchPrompt(full).prompt);
    expect(assembleDispatchPrompt(none).prompt).toBe(assembleDispatchPrompt(none).prompt);
    expect(assembleDispatchPrompt(full).prompt).not.toBe(assembleDispatchPrompt(none).prompt);
  });
});

describe('THE CARD IS WRONG — the agent COMPOSES the WHAT, through the plan-session TOOLS (MOTIR-4083)', () => {
  // The submit used to be one shell command that sent a KEY and nothing else;
  // the evidence went into a comment a person reads, and the first thing a
  // triggered re-plan did was open a conversation to ask what was wrong. Now
  // the agent appends the finding as a turn, composes motir-ai's six-field
  // requirement, and submits both — through the tools it was already holding.
  //
  // ⚠️ EVERY ASSERTION HERE IS ON THE COMPOSED PROMPT — the artifact the agent
  // receives — never on the template source. And the field names are read
  // against the fixture that mirrors motir-ai's OWN list, because this seam
  // already failed once with both halves green (MOTIR-4168): a prompt asserted
  // only against itself is what let it.

  /** The card-is-wrong branch alone: from its heading to the third branch. */
  function replanArm(prompt: string): string {
    const section = cardOutcomeBranches(prompt);
    const at = section.indexOf('STOP — the WHAT itself breaks');
    expect(at, 'the prompt carries THE CARD IS WRONG').toBeGreaterThan(-1);
    return section.slice(at);
  }

  /**
   * The two tool steps, sliced by their own numbering, so an assertion about
   * one call cannot be satisfied by text belonging to the other.
   */
  function toolSteps(arm: string): { append: string; submit: string } {
    // Renumbered by MOTIR-6287: the report became step 4, so the append is 6,
    // the submit 7 and the once rule 8.
    const append = arm.indexOf('6. Put the finding on the planning thread');
    const submit = arm.indexOf('7. Compose the WHAT');
    const once = arm.indexOf('8. SUBMITTING IS THE ACT THAT SPENDS');
    expect(append, 'step 6 is the append').toBeGreaterThan(-1);
    expect(submit, 'step 7 is the submit').toBeGreaterThan(append);
    expect(once, 'step 8 is the once rule').toBeGreaterThan(submit);
    return { append: arm.slice(append, submit), submit: arm.slice(submit, once) };
  }

  /** One field's entry under `requirement:` — its name line plus the deeper-indented continuation lines. */
  function fieldEntry(submit: string, field: string): string {
    const lines = submit.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^\\s+${field}\\s{2,}`).test(l));
    expect(start, `${field} is taught`).toBeGreaterThan(-1);
    let end = start + 1;
    while (end < lines.length && /^\s{20,}\S/.test(lines[end]!)) end++;
    return lines.slice(start, end).join('\n');
  }

  it('steps 6 and 7 name the TOOLS — append, then submit — after the Planning transition, and the shell-out is GONE', () => {
    const { prompt } = assembleDispatchPrompt(source({ key: 'PROD-99' }));
    const arm = replanArm(prompt);
    const at = (needle: string) => arm.indexOf(needle);
    expect(at('status planning')).toBeGreaterThan(-1);
    expect(at('append_plan_turn tool')).toBeGreaterThan(at('status planning'));
    expect(at('submit_plan_session tool')).toBeGreaterThan(at('append_plan_turn tool'));
    expect(at('Stop. Do not pick up other work')).toBeGreaterThan(at('submit_plan_session tool'));
    // ABSENCE, on the WHOLE prompt: a composed prompt still naming the retired
    // door fails here, whatever else it says.
    expect(prompt).not.toContain('motir plan');
    expect(prompt).not.toContain('--detach');
  });

  it('carries `targetKeys: [<KEY>]` on BOTH calls — the anchor is an argument now, and two calls are two chances to drop it', () => {
    const { prompt } = assembleDispatchPrompt(source({ key: 'PROD-99' }));
    const { append, submit } = toolSteps(replanArm(prompt));
    expect(append).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(submit).toMatch(/targetKeys:\s+\[PROD-99\]/);
    expect(append).toMatch(/projectKey:\s+PROD\b/);
    expect(submit).toMatch(/projectKey:\s+PROD\b/);
    // …and it says WHY at the first call, and that both carry it at the second.
    expect(append).toContain('anchors the thread to this card');
    expect(append).toContain('PROJECT-WIDE thread');
    expect(submit).toContain('Both calls carry targetKeys');
  });

  it('teaches the six FIELD NAMES the wire and the validator use, in CANONICAL ORDER — read against motir-ai’s list', () => {
    // A rename on any of the three sides — the prompt, `submit_plan_session`'s
    // schema, motir-ai's `REQUIREMENT_FIELDS` (mirrored by the fixture) — fails
    // here rather than at a planning run in production.
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('six named fields, in this order');
    let last = -1;
    for (const field of AI_REQUIREMENT_FIELDS) {
      const at = submit.search(new RegExp(`^\\s+${field}\\s{2,}`, 'm'));
      expect(at, `${field} is taught, after the field before it`).toBeGreaterThan(last);
      last = at;
    }
    // Exactly six — no seventh field invented, none dropped.
    const taught = submit.split('\n').filter((l) => /^ {11}[A-Za-z]+ {2,}/.test(l));
    expect(taught).toHaveLength(AI_REQUIREMENT_FIELDS.length);
  });

  it('marks exactly the REQUIRED three, and says "" is an ANSWER for the other three', () => {
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    for (const field of AI_REQUIREMENT_FIELDS) {
      const required = (AI_REQUIREMENT_REQUIRED_NON_EMPTY as readonly string[]).includes(field);
      const entry = fieldEntry(submit, field);
      if (required) {
        expect(entry, `${field} is marked required`).toContain('REQUIRED');
        expect(entry, `${field} does not offer ""`).not.toContain('""');
      } else {
        expect(entry, `${field} is not marked required`).not.toContain('REQUIRED');
        expect(entry, `${field} says "" is an answer`).toContain('""');
      }
    }
    expect(submit).toContain('three REQUIRED fields must be non-empty');
    expect(submit).toContain('which is an answer, not a blank to skip');
  });

  it('states the SELF-CONTAINED bar, and names the pointer as insufficient', () => {
    // "See my comment" satisfies "pass your evidence" and supplies nothing — it
    // is the answer a vaguer instruction gets, so the prompt names it.
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('SELF-CONTAINED');
    expect(submit).toContain('"see my comment on the card"');
    expect(submit).toContain('supplies nothing');
    expect(submit).toContain('put the content in the field');
  });

  it('says the turn is the agent’s ONLY contribution — a brief, not a note', () => {
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toContain('This is your ONLY contribution');
    expect(submit).toContain('nothing will come back and ask you');
    expect(submit).toMatch(/Write a brief, not a\s+note/);
  });

  it('says APPENDING IS NOT SUBMITTING, and that submitting is the act that spends', () => {
    // "Run it once" has two parts now, and this is the one the split makes easy
    // to get wrong: an agent that thinks its append submitted stops having done
    // nothing. Stated in the prompt's own voice, not left to the tool text.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    const { append } = toolSteps(arm);
    expect(append).toContain('APPENDING IS NOT SUBMITTING');
    expect(append).toMatch(/costs nothing and\s+starts no job/);
    expect(append).toContain('Nothing has reached the planner until step 7');
    expect(arm).toContain("SUBMITTING IS THE ACT THAT SPENDS the token owner's AI credits");
  });

  it('the one legitimate retry is its OWN sentence, apart from *submit ONCE*', () => {
    // Two distinct sentences, because collapsing them is how "never retry"
    // becomes "retry freely". A schema-rejected requirement spent nothing, so
    // that ONE case is re-submitted — without the requirement.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    const once = arm.indexOf('do it exactly ONCE. Never retry it, even on a timeout');
    const exception = arm.indexOf('REJECTS your arguments');
    expect(once).toBeGreaterThan(-1);
    expect(exception).toBeGreaterThan(once);
    expect(arm).toMatch(/nothing happened — no job was created and no credits were spent/);
    expect(arm).toMatch(/re-submit once, WITHOUT the requirement/);
    expect(arm).toContain('That is the only retry there is');
  });

  it('does NOT ask the agent to diagnose the planning rules — asserted by absence', () => {
    // That is the fix phase's work, and an agent asked to classify invents.
    const { prompt } = assembleDispatchPrompt(source());
    for (const forbidden of [
      'planning rule',
      'planning bug',
      'log_planning_bug',
      'MOTIR-1465',
      'which rule',
      'lesson',
    ]) {
      expect(prompt.toLowerCase(), `no "${forbidden}"`).not.toContain(forbidden.toLowerCase());
    }
    const arm = replanArm(prompt);
    expect(arm).toContain('you are not asked to classify the');
    expect(arm).toMatch(/what is wrong with the\s+CARD, not why it was planned that way/);
  });

  it('a refusal with NO composed WHAT is still SENT', () => {
    // Refusing must never become conditional on writing well — the consumer
    // falls back to opening a conversation (MOTIR-4082), and the tool forwards a
    // partial or absent requirement unchanged (MOTIR-4172).
    const { submit } = toolSteps(replanArm(assembleDispatchPrompt(source()).prompt));
    expect(submit).toMatch(/submit anyway, WITHOUT\s+requirement/);
    expect(submit).toContain('must never wait on writing well');
  });

  it('the comment STAYS, and the turn carries the SAME content', () => {
    // Composed once, delivered twice: the human-readable trail is not traded
    // for the machine-readable one.
    const arm = replanArm(assembleDispatchPrompt(source()).prompt);
    expect(arm).toContain('3. Comment the finding on PROD-7');
    expect(toolSteps(arm).append).toContain('the SAME text as your step-3 comment');
  });

  it('is ONE text in both workflow variants — the arm does not vary by lineage', () => {
    // The composition is decided by the run's POLICY and the card, never by
    // which git workflow the item was dispatched under.
    const per = replanArm(assembleDispatchPrompt(source({ sessionBranch: null })).prompt);
    const lineage = replanArm(
      assembleDispatchPrompt(source({ sessionBranch: 'session/PROD-2-run' })).prompt,
    );
    expect(lineage).toBe(per);
  });

  it('with re-planning DISABLED, neither tool is named and nothing is composed', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: false, autoApproveReplan: false } }),
    );
    const outcome = outcomeSection(prompt);
    for (const gone of [
      'append_plan_turn',
      'submit_plan_session',
      'targetKeys',
      'requirement',
      'ONLY contribution',
      'SUBMITTING IS THE ACT',
    ]) {
      expect(outcome, `no "${gone}"`).not.toContain(gone);
    }
    expect(outcome).toContain('leave the card In Progress');
  });
});

describe('parseFindingsPolicy — the shared wire vocabulary', () => {
  it.each([undefined, null, '', '   '])('%o means the full protocol', (raw) => {
    expect(parseFindingsPolicy(raw)).toEqual({
      policy: { logBug: true, replan: true, autoApproveReplan: false },
      unknown: null,
    });
  });

  it.each([
    ['log-bug', { logBug: false, replan: true, autoApproveReplan: false }],
    ['replan', { logBug: true, replan: false, autoApproveReplan: false }],
    ['log-bug,replan', { logBug: false, replan: false, autoApproveReplan: false }],
    [' replan , log-bug ', { logBug: false, replan: false, autoApproveReplan: false }],
    ['log-bug,,replan', { logBug: false, replan: false, autoApproveReplan: false }],
  ])('%s disables what it names', (raw, expected) => {
    expect(parseFindingsPolicy(raw)).toEqual({ policy: expected, unknown: null });
  });

  it('REFUSES an unrecognised capability rather than ignoring it', () => {
    // The lie this parameter exists to remove: an operator who typed the CLI
    // flag's spelling on the wire must not be handed the full protocol while
    // believing they narrowed it.
    expect(parseFindingsPolicy('no-log-bug')).toEqual({ policy: null, unknown: 'no-log-bug' });
    expect(parseFindingsPolicy('log-bug,nonsense')).toEqual({ policy: null, unknown: 'nonsense' });
  });

  it('names both capabilities in the vocabulary it publishes', () => {
    expect([...FINDINGS_POLICY_TOKENS]).toEqual(['log-bug', 'replan']);
  });
});

// ── THE TWO LANES a re-plan can go down (MOTIR-4085) ────────────────────────
//
// `--auto-approve-replan` lets an unattended loop approve a re-plan itself and
// carry on. The BOUND on what it may approve is the loop's, enforced over the
// plan that comes back — nothing here is trusted. What the prompt buys is that
// the agent KNOWS which choice it is making: keep the correction to its own card
// and its siblings and the loop may act on it, or reach wider on purpose and a
// person decides.
//
// ⚠️ THE TESTS THAT MATTER MOST ARE THE ABSENCE ONES. A section rendered
// unconditionally would tell every agent on every run that its plan might be
// approved unattended, which is false for every run without the flag — and false
// in the direction an agent cannot check.
describe('THE CARD IS WRONG — the two lanes (MOTIR-4085)', () => {
  const withLane = (over: Partial<DispatchPromptSource> = {}) =>
    assembleDispatchPrompt(
      source({
        ...over,
        findingsPolicy: { logBug: true, replan: true, autoApproveReplan: true },
      }),
    ).prompt;

  it('renders NOTHING without the flag — the default prompt is byte-identical', () => {
    // The whole no-regression claim in one assertion: a run with no
    // auto-approving loop must send the prompt it sent before this existed.
    const before = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false } }),
    ).prompt;
    expect(before).toBe(assembleDispatchPrompt(source()).prompt);
    expect(before).not.toContain('TWO LANES');
  });

  it('names BOTH lanes, and the card and container each is anchored at', () => {
    const prompt = withLane();
    expect(prompt).toContain('TWO LANES');
    expect(prompt).toContain('--auto-approve-replan');
    // The card's own lane is the leaf plus its siblings under its parent…
    expect(prompt).toContain('PROD-7 and its siblings under PROD-2');
    // …and the normal lane is the container, by key, in BOTH calls.
    expect(prompt).toContain('[PROD-2]');
    expect(prompt).toContain('in BOTH calls');
  });

  it('says the normal lane is ALWAYS available, and that stopping is correct', () => {
    // ⚠️ THE ANTI-INCENTIVE HALF. An agent that believes it must keep the run
    // going has a reason to invent a local fix it does not believe in — which
    // buys continuity by spending plan quality. So the text has to say, in
    // words, that it is not being asked to keep the run going.
    const prompt = withLane();
    expect(prompt).toContain('ALWAYS available');
    expect(prompt).toContain('CHOOSE THE LANE THAT IS TRUE');
    expect(prompt).toContain('You are not being asked to keep the run going');
  });

  it('says a plan anchored here but wider is NOT approved, and is not a rejection', () => {
    const prompt = withLane();
    expect(prompt).toContain('the loop does not approve it');
    expect(prompt).toContain('names what fell outside');
    expect(prompt).toContain('not a rejection of your finding');
  });

  it('offers the anchorless lane for a missing PRECONDITION', () => {
    // The case with no card to name: nothing that exists is the target, so the
    // planner settles a new one. Omitting targetKeys is how that is expressed.
    expect(withLane()).toContain('omit targetKeys entirely');
  });

  it('degrades honestly for a PARENTLESS card — no sibling level to offer', () => {
    const prompt = withLane({ parent: null });
    expect(prompt).toContain('it has no parent, so it has no sibling level either');
    // …and it must not invent a container key it does not have.
    expect(prompt).not.toMatch(/siblings under (?!PROD-2)/);
  });

  it('renders nothing when re-planning is DISABLED — there is no plan to approve', () => {
    // Contradictory by construction, and `parseFindingsPolicy` resolves it to
    // the safe side. This asserts the template does not describe a lane for a
    // submission the same prompt has just forbidden.
    const prompt = assembleDispatchPrompt(
      source({ findingsPolicy: { logBug: true, replan: false, autoApproveReplan: true } }),
    ).prompt;
    expect(prompt).not.toContain('TWO LANES');
    expect(prompt).toContain('without re-planning');
  });

  it('leaves the submit steps and their anchor UNCHANGED', () => {
    // The lane block is added BESIDE the protocol, not woven into it: the two
    // calls, the requirement fields and the one-shot rule are what they were.
    const prompt = withLane();
    expect(prompt).toMatch(/append_plan_turn[\s\S]*targetKeys:\s+\[PROD-7\]/);
    expect(prompt).toMatch(/submit_plan_session[\s\S]*targetKeys:\s+\[PROD-7\]/);
    expect(prompt).toContain('SUBMITTING IS THE ACT THAT SPENDS');
  });

  it('is DETERMINISTIC, and the two policies differ — so the switch is not inert', () => {
    const on = source({ findingsPolicy: { logBug: true, replan: true, autoApproveReplan: true } });
    const off = source({
      findingsPolicy: { logBug: true, replan: true, autoApproveReplan: false },
    });
    expect(assembleDispatchPrompt(on).prompt).toBe(assembleDispatchPrompt(on).prompt);
    expect(assembleDispatchPrompt(on).prompt).not.toBe(assembleDispatchPrompt(off).prompt);
  });

  describe.each(VARIANTS)('on $name', ({ over }) => {
    it('renders the lane block in both git workflows', () => {
      // The election is about the PLAN, not about the branch, so it must not
      // vary with the workflow the run happens to be in.
      expect(withLane(over)).toContain('TWO LANES');
    });
  });
});

describe('parseFindingsPolicy — the auto-approve lane rides its own parameter', () => {
  it('defaults to FALSE, so every existing caller parses to what it always did', () => {
    expect(parseFindingsPolicy(undefined).policy).toEqual(FULL_FINDINGS_POLICY);
    expect(parseFindingsPolicy('').policy?.autoApproveReplan).toBe(false);
    expect(parseFindingsPolicy('log-bug').policy?.autoApproveReplan).toBe(false);
  });

  it('carries the flag through an empty and a non-empty disable list alike', () => {
    expect(parseFindingsPolicy('', { autoApproveReplan: true }).policy).toEqual({
      logBug: true,
      replan: true,
      autoApproveReplan: true,
    });
    expect(parseFindingsPolicy('log-bug', { autoApproveReplan: true }).policy).toEqual({
      logBug: false,
      replan: true,
      autoApproveReplan: true,
    });
  });

  it('RESOLVES the contradiction to the safe side — no re-plan means no lane', () => {
    // Approving a re-plan the agent was told not to submit is not a lane, it is
    // a nonsense. The CLI refuses the two flags at parse time; this is the same
    // rule for every other caller, and it fails to NO LANE rather than to one.
    expect(parseFindingsPolicy('replan', { autoApproveReplan: true }).policy).toEqual({
      logBug: true,
      replan: false,
      autoApproveReplan: false,
    });
  });

  it('still refuses an unknown token, whatever the flag says', () => {
    const parsed = parseFindingsPolicy('no-log-bug', { autoApproveReplan: true });
    expect(parsed.policy).toBeNull();
    expect(parsed.unknown).toBe('no-log-bug');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE-RECEIPT STEPS (bug MOTIR-4704)
//
// Both directions are asserted, and the NEGATIVE one is the reason this block
// exists. The bug being fixed is that the runner was never told to publish; the
// bug this could introduce is telling every `type: test` card to publish a
// recording it never made, which sends an agent hunting for a video that does
// not exist. A suite that only checks the positive direction leaves the
// condition itself untested.
// ─────────────────────────────────────────────────────────────────────────────

describe('the acceptance-receipt steps are conditional on the card recording one', () => {
  const acceptanceCard = (over: Partial<DispatchPromptSource> = {}) =>
    source({
      key: 'PROD-40',
      type: 'test',
      title: 'Story E2E (Playwright) + ACCEPTANCE VIDEO — walk both surfaces',
      descriptionMd: [
        'Record the story working, paced for a human.',
        '',
        '## Acceptance criteria',
        '',
        '- The spec declares its story and stays under 60s.',
      ].join('\n'),
      ...over,
    });

  it('names BOTH calls on a card that records an acceptance video', () => {
    const { prompt } = assembleDispatchPrompt(acceptanceCard());

    expect(prompt).toContain('create_acceptance_upload');
    expect(prompt).toContain('publish_acceptance_result');
    // The mint-then-PUT shape has to be stated, or an agent reads two tool names
    // and looks for the argument that takes the bytes.
    expect(prompt).toContain('Content-Type: video/webm');
    // The silence is the hazard, so the prompt says so where the agent is
    // standing when it decides whether the run is over — scoped, since
    // MOTIR-7254, to the repositories where no lane publishes.
    expect(prompt).toContain('WHERE NO LANE PUBLISHES, NOTHING ELSE MAKES THAT CALL');
  });

  // ── WHO PUBLISHES — the checkout decides (MOTIR-7254) ──────────────────────
  //
  // CI publishes again where the repository's lane carries the uploader
  // (MOTIR-7253). The prompt cannot see a repository's workflows, so the agent
  // reads its own checkout. Both branches must be present and explicit: a
  // stand-down that reads as "skip publishing" in a repository with NO lane
  // brings back the silent missing receipt MOTIR-4704 ended.
  it('spells out the checkout check, the stand-down branch and the report line', () => {
    const { prompt } = assembleDispatchPrompt(acceptanceCard());
    expect(prompt).toContain(
      "grep -rlE 'uses:\\s*\\./\\.github/actions/upload-acceptance-video' .github/workflows/",
    );
    expect(ACCEPTANCE_LANE_PUBLISHES_CHECK).toBe(
      "grep -rlE 'uses:\\s*\\./\\.github/actions/upload-acceptance-video' .github/workflows/",
    );
    expect(prompt).toContain('IF IT PRINTS A FILE');
    expect(prompt).toContain('Make NO\n   MCP publish');
    expect(prompt).toContain(
      'this repository’s acceptance lane publishes\n   the receipt on a green run; no MCP publish made',
    );
    // …and the other branch keeps BOTH calls, in order, after the check.
    expect(prompt).toContain('IF IT PRINTS NOTHING');
    const check = prompt.indexOf('5. FIRST, find out WHO publishes');
    const publish = prompt.indexOf('6. OTHERWISE, PUBLISH the receipt');
    expect(check).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(check);
    expect(prompt.indexOf('create_acceptance_upload', publish)).toBeGreaterThan(publish);
    expect(prompt.indexOf('publish_acceptance_result', publish)).toBeGreaterThan(publish);
  });

  it('asserts nowhere, unconditionally, that only the agent publishes', () => {
    const { prompt } = assembleDispatchPrompt(acceptanceCard());
    // The pre-MOTIR-7254 sentence opened the paragraph on its own.
    expect(prompt).not.toMatch(/^\s*NOTHING ELSE MAKES THAT CALL/m);
    expect(prompt).not.toContain('No CI lane uploads');
  });

  it('a CONTINUE prompt (what `motir continue` fetches) stands down exactly as a fresh one', () => {
    const { prompt } = assembleDispatchPrompt(
      acceptanceCard({
        continueFrom: {
          deadRunId: 'run_dead',
          endedHow: 'the run stopped reporting',
          lastHeardAt: '2026-09-27T14:02:00.000Z',
          dispatcherName: 'Mara S.',
          branch: 'subtask/PROD-40-e2e',
          pullRequest: null,
        },
      }),
    );
    expect(prompt).toContain('CONTINUE — you are carrying on a run that DIED');
    expect(prompt).toContain(ACCEPTANCE_LANE_PUBLISHES_CHECK);
    expect(prompt).toContain('IF IT PRINTS A FILE');
    expect(prompt).toContain('IF IT PRINTS NOTHING');
    expect(prompt).toContain('publish_acceptance_result');
  });

  it('keeps the ordinary test steps and APPENDS to them', () => {
    // Appended, never substituted: an acceptance card still writes and greens
    // its spec, and the publish is the step after that.
    const { prompt } = assembleDispatchPrompt(acceptanceCard());
    expect(prompt).toContain('4. Run the test files you added or changed and leave them green.');
    expect(prompt).toContain('5. FIRST, find out WHO publishes the receipt');
    expect(prompt).toContain('6. OTHERWISE, PUBLISH the receipt');
  });

  it('finds the signal in the DESCRIPTION when the title does not carry it', () => {
    const { prompt } = assembleDispatchPrompt(
      acceptanceCard({
        title: 'Story E2E — an admin and a member walk the spend surfaces',
        descriptionMd: "Declare the story with `acceptanceStory('PROD-39')` and pace it.",
      }),
    );
    expect(prompt).toContain('publish_acceptance_result');
  });

  it('says NOTHING about publishing on an ordinary regression test card', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'test',
        title: 'Cover the ready-filter reducer',
        descriptionMd: 'Write unit tests for the reducer’s three branches.',
      }),
    );

    expect(prompt).not.toContain('create_acceptance_upload');
    expect(prompt).not.toContain('publish_acceptance_result');
    expect(prompt).not.toContain('upload-acceptance-video');
    expect(prompt).not.toContain('WHO publishes');
    expect(prompt).toContain('4. Run the test files you added or changed and leave them green.');
  });

  it('says nothing about publishing on a `code` card that merely mentions the video', () => {
    // The gate is the TYPE and the text together. A code card describing the
    // acceptance lane is not a card that records a receipt.
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'code',
        title: 'Rename the acceptance video lane',
        descriptionMd: 'The lane is called `Acceptance video` and publishes nothing.',
      }),
    );
    expect(prompt).not.toContain('publish_acceptance_result');
  });

  it('says nothing on a MANUAL item, which has no run to record in', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        type: 'manual',
        executor: 'human',
        title: 'Watch the acceptance video and approve it',
        descriptionMd: 'A person watches the receipt and decides.',
      }),
    );
    expect(prompt).not.toContain('create_acceptance_upload');
  });
});

describe('assembleDispatchPrompt — HOW TO TEST is per RUN, on the run target (MOTIR-5334)', () => {
  const GRAMMARS = [
    ['per_item_pr', null],
    ['session_lineage', 'motir/auto-20260913-120000'],
  ] as const;
  const flat = (prompt: string) => prompt.replace(/\n\s+/g, ' ');

  it.each(GRAMMARS)(
    'the %s grammar, with the item as its own run target, renders step 4b between the link and the transition',
    (_mode, sessionBranch) => {
      const { prompt } = assembleDispatchPrompt(source({ sessionBranch }));
      const order = prompt.slice(prompt.indexOf('IN THIS ORDER'));
      const link = order.indexOf('4. link it with the link_pull_request tool');
      const publish = order.indexOf(
        `4b. publish this run's HOW TO TEST with the ${HOW_TO_TEST_TOOL_NAME} tool`,
      );
      const transition = order.indexOf('5. move PROD-7 to Implemented');
      expect(link).toBeGreaterThan(-1);
      expect(publish).toBeGreaterThan(link);
      expect(transition).toBeGreaterThan(publish);
    },
  );

  it('an UNSCOPED session lineage (runTargetKey null) still renders the step, on the card', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ sessionBranch: 'motir/auto-20260913-120000', runTargetKey: null }),
    );
    expect(flat(prompt)).toContain(`ONCE, on PROD-7 (this item is the run's target)`);
  });

  it('a run targeting the item ITSELF renders the step, on the card', () => {
    const { prompt } = assembleDispatchPrompt(source({ runTargetKey: 'PROD-7' }));
    expect(prompt).toContain(HOW_TO_TEST_TOOL_NAME);
  });

  it('a SCOPED run on another item renders NO publish, and names the run target the close-out writes to', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ sessionBranch: 'motir/run-20260913-120000', runTargetKey: 'PROD-1' }),
    );
    expect(prompt).not.toContain(HOW_TO_TEST_TOOL_NAME);
    const text = flat(prompt);
    expect(text).toContain('4b. do NOT publish How to test for PROD-7.');
    expect(text).toContain("written once, onto PROD-1, by the run's close-out step");
  });

  it('interpolates the runbook trigger, byte for byte', () => {
    // The scope sentence of motir-meta `prompts/run.md` § "The how-to-test rule —
    // every UI-touching feature PR states how to test it". Re-typed here ON
    // PURPOSE: the constant is what the prompt says, this literal is what the
    // runbook says, and the test is the only thing that holds the two together.
    expect(RENDERED_SURFACE_TRIGGER).toBe(
      'creates or changes any rendered surface (a UI `type: code` subtask, or any subtask adding/editing a page, component, route-rendered view, modal, or interactive control)',
    );
    const { prompt } = assembleDispatchPrompt(source());
    expect(flat(prompt)).toContain(`If this change ${RENDERED_SURFACE_TRIGGER}`);
  });

  it('tells the agent: ONE call on the card, a rich-text body with sections and fenced commands, a repos entry per repository, no branch fetch', () => {
    const text = flat(assembleDispatchPrompt(source()).prompt);
    expect(text).toContain('ONCE, on PROD-7');
    expect(text).toContain('"bodyMd" is RICH TEXT (Markdown) with sections');
    expect(text).toContain('Put EVERY command in its own fenced code block');
    expect(text).toContain('one "repos" entry per repository you pushed to');
    expect(text).toContain('commitSha = its pushed head');
    expect(text).toContain('Motir fills in the branch fetch itself — do not include it.');
    expect(text).toContain('Otherwise say in the body why there is none');
  });

  it('tells the agent a refused publish is reported and does not block the transition', () => {
    const text = flat(assembleDispatchPrompt(source()).prompt);
    expect(text).toContain('If the publish is refused, say so in your FINISHED report');
    expect(text).toContain('a refused publish does not prevent the transition');
  });

  // MOTIR-6065: How to test is written for the WORK ITEM, not for a commit, and the
  // item page no longer flags a record whose commit the pull request moved past —
  // so the agent that makes a later commit is the one told to keep it true.
  it('tells the agent How to test belongs to the item, and a later commit that changes a step re-publishes it', () => {
    const text = flat(assembleDispatchPrompt(source()).prompt);
    expect(text).toContain('How to test belongs to PROD-7, not to a commit.');
    expect(text).toContain(
      'If a later commit in this run changes anything it describes — a precondition, a setup, migrate or seed command, a click-path step — publish it again with the whole corrected text',
    );
    expect(text).toContain('A commit that changes none of them needs no new publish.');
  });

  it('a SCOPED child is not told to re-publish — it publishes nothing', () => {
    const text = flat(
      assembleDispatchPrompt(
        source({ sessionBranch: 'motir/run-20260913-120000', runTargetKey: 'PROD-1' }),
      ).prompt,
    );
    expect(text).not.toContain('not to a commit');
  });

  it('the per-item lane requires a "## How to test" section in the pull request body it opens', () => {
    const text = flat(assembleDispatchPrompt(source({ sessionBranch: null })).prompt);
    expect(text).toContain('3. open the pull request. Its body carries a "## How to test" section');
    expect(text).toContain('the SAME Markdown step 4b publishes on the run target');
  });

  it('the session lineage opens no pull request of its own, so it carries no body section instruction', () => {
    const text = flat(
      assembleDispatchPrompt(source({ sessionBranch: 'motir/auto-20260913-120000' })).prompt,
    );
    expect(text).not.toContain('"## How to test" section');
  });

  it('a MANUAL item — the lane that opens no pull request — renders no publish step', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual' }));
    expect(prompt).not.toContain(HOW_TO_TEST_TOOL_NAME);
  });

  it('names the REGISTERED tool, so a rename fails here', () => {
    expect(HOW_TO_TEST_TOOL_NAME).toBe(PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(HOW_TO_TEST_TOOL_NAME);
  });
});

describe('DESIGN REFERENCE — what this card is built against (MOTIR-5563)', () => {
  const approvedVerdict = (over: Record<string, unknown> = {}) => ({
    verdict: 'approved' as const,
    designCardKey: 'PROD-42',
    designCardTitle: 'Draw the ready-set filter bar',
    design: {
      designCardKey: 'PROD-42',
      designCardTitle: 'Draw the ready-set filter bar',
      evidenceId: 'ev_abc123',
      publishedAt: '2026-09-15T10:00:00.000Z',
      commitSha: 'deadbeef',
      assets: [
        {
          kind: 'mock' as const,
          sourcePath: 'design/work-items/ready-bar.mock.html',
          fileName: 'ready-bar.mock.html',
          contentType: 'text/html',
          byteSize: 4096,
          state: 'available' as const,
        },
        {
          kind: 'note_file' as const,
          sourcePath: 'design/work-items/design-notes.md',
          fileName: 'design-notes.md',
          contentType: 'text/markdown',
          byteSize: 2048,
          state: 'available' as const,
        },
      ],
      ...over,
    },
  });

  it('renders the key, the VERSION, every sourcePath, the dir path and the fetch fallback', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ designReference: [approvedVerdict()] as never }),
    );
    expect(prompt).toContain('DESIGN REFERENCE — what this card is built against');
    expect(prompt).toContain('PROD-42 — Draw the ready-set filter bar');
    // The VERSION, which is what makes the reference checkable later.
    expect(prompt).toContain('APPROVED, version ev_abc123');
    expect(prompt).toContain('design/work-items/ready-bar.mock.html');
    expect(prompt).toContain('design/work-items/design-notes.md');
    // BOTH ways of getting the files, because only the launcher knows which applies.
    expect(prompt).toContain(`$${DESIGN_DIR_ENV}/PROD-42/<sourcePath>`);
    expect(prompt).toContain(GET_DESIGN_TOOL_NAME);
    expect(prompt).toContain('expire within minutes');
    expect(prompt).toContain('OUTSIDE the repository checkout');
    // How to READ one — the source, every panel, and the delta's base.
    expect(prompt).toContain('*.mock.html SOURCE, not a rendering');
    expect(prompt).toContain('read EVERY panel');
    expect(prompt).toContain(LIST_DESIGNS_TOOL_NAME);
  });

  it('an UNAVAILABLE asset is named as such and not silently dropped', () => {
    const verdict = approvedVerdict();
    verdict.design.assets[0]!.state = 'unavailable' as never;
    const { prompt } = assembleDispatchPrompt(source({ designReference: [verdict] as never }));
    expect(prompt).toContain('design/work-items/ready-bar.mock.html');
    expect(prompt).toContain('UNAVAILABLE');
    expect(prompt).toContain('it is still the approved design');
  });

  it('a NOT-approved verdict renders its reason and the THE CARD IS WRONG instruction', () => {
    const { prompt } = assembleDispatchPrompt(
      source({
        designReference: [
          {
            verdict: 'not_approved',
            designCardKey: 'PROD-42',
            designCardTitle: 'Draw the ready-set filter bar',
            reason: 'not_done',
          },
        ] as never,
      }),
    );
    expect(prompt).toContain('NO APPROVED DESIGN (not_done)');
    expect(prompt).toContain('Stop through THE CARD');
    // The SHAPE of the correction, which is the part an agent gets wrong.
    expect(prompt).toContain('BESIDE this card');
    expect(prompt).toContain('never a child of it');
    expect(prompt).toContain('`relates_to` the design card(s) named');
    expect(prompt).toContain('blocked_by');
    expect(prompt).toContain('The old design card stays done');
  });

  it('the gate distinguishes an unspecified ELEMENT from an unspecified DETAIL', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ designReference: [approvedVerdict()] as never }),
    );
    expect(prompt).toContain('a whole panel,');
    expect(prompt).toContain('An unspecified DETAIL is not this');
    expect(prompt).toContain('hover');
  });

  it('an EMPTY designReference renders NO BLOCK — the ordinary card is unchanged', () => {
    // The HEADING, not the phrase: the `code` steps' look-first instruction
    // legitimately says the words "NO DESIGN REFERENCE is listed", and asserting
    // on the phrase would make this test pass only while that sentence is absent.
    const heading = 'DESIGN REFERENCE — what this card is built against';
    expect(assembleDispatchPrompt(source({ designReference: [] })).prompt).not.toContain(heading);
    // And an omitted field behaves identically to an empty one.
    expect(assembleDispatchPrompt(source()).prompt).not.toContain(heading);
  });

  it('a `code` card with NO design reference is told to LOOK first', () => {
    const { prompt } = assembleDispatchPrompt(source({ designReference: [] }));
    expect(prompt).toContain(`If this change ${RENDERED_SURFACE_TRIGGER}`);
    expect(prompt).toContain(`look first with the ${LIST_DESIGNS_TOOL_NAME} tool`);
    expect(prompt).toContain('If nothing does, STOP through THE CARD IS WRONG');
  });

  it('names the REGISTERED tools, so a rename fails here', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_DESIGN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(LIST_DESIGNS_TOOL_NAME);
    expect(GET_DESIGN_TOOL_NAME).toBe(REGISTERED_GET_DESIGN);
    expect(LIST_DESIGNS_TOOL_NAME).toBe(REGISTERED_LIST_DESIGNS);
  });

  it('names the variable the CLI actually sets — the two cannot drift', () => {
    // ⚠️ THE ONLY PLACE BOTH VALUES ARE REACHABLE. This module cannot import a
    // CLI module and the CLI package cannot import `lib/`, so the equality is
    // pinned here, reading the CLI's own exported constant. A drift makes the
    // prompt name a variable nothing sets, which reads to the agent as "there
    // is no design" — a failure with no error message.
    expect(DESIGN_DIR_ENV).toBe(CLI_MOTIR_DESIGN_DIR_ENV);
  });

  it('no longer tells an agent the REPOSITORY is the design’s source of truth', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ type: 'design', openDependentKeys: ['PROD-9'] }),
    );
    expect(prompt).not.toContain('The REPOSITORY stays the source of truth');
    expect(prompt).toContain('THE PUBLISHED RESULT IS THE SOURCE OF TRUTH');
    expect(prompt).toContain('Committing the two files to the repository is OPTIONAL');
  });
});

describe('a BUG card is REPRODUCED before THE CARD IS WRONG is reachable (MOTIR-5944)', () => {
  const bug = (over: Partial<DispatchPromptSource> = {}) =>
    source({ key: 'PROD-50', kind: 'bug', title: 'Debounced runs go missing', ...over });

  // The heading line of the exit, not the forward reference WHAT_TO_DO.code
  // makes to it ("STOP through THE CARD IS WRONG below").
  const EXIT_HEADING = 'THE CARD IS WRONG — its premise is false';

  it('renders the reporter’s base, the git-log classifier and the MATRIX with its PR-body table', () => {
    const { prompt } = assembleDispatchPrompt(bug());

    expect(prompt).toContain('THIS IS A BUG CARD');
    expect(prompt).toContain('REPORTER’S BASE, not at HEAD');
    expect(prompt).toContain('`git log <reporter’s base>..HEAD -- <the paths that serve it>`');
    expect(prompt).toContain('NEVER reproduced');
    expect(prompt).toContain('fixed in between');
    expect(prompt).toContain('obliges the MATRIX, not the verdict');
    expect(prompt).toContain('VARY each one');
    expect(prompt).toContain('results table — passing rows');
    expect(prompt).toContain('in the pull request body');
  });

  it('places the block inside WHAT TO DO, ahead of the type’s own steps and of THE CARD IS WRONG', () => {
    const { prompt } = assembleDispatchPrompt(bug());
    const block = prompt.indexOf('THIS IS A BUG CARD');
    const whatToDo = prompt.indexOf('WHAT TO DO');
    const firstStep = prompt.indexOf('1. Read the card description above');
    const exit = prompt.indexOf(EXIT_HEADING);

    expect(exit, 'the exit still renders').toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(whatToDo);
    expect(block).toBeLessThan(firstStep);
    expect(block).toBeLessThan(exit);
  });

  it('keeps REVERT FIRST as the exit’s first step — the block gates the exit, it does not replace it', () => {
    const { prompt } = assembleDispatchPrompt(bug());
    expect(prompt.slice(prompt.indexOf(EXIT_HEADING))).toContain('1. REVERT FIRST.');
  });

  it.each(['task', 'subtask', 'story'] as const)(
    'a %s card carries no reproduction block',
    (kind) => {
      const { prompt } = assembleDispatchPrompt(source({ kind }));
      expect(prompt).not.toContain('THIS IS A BUG CARD');
      expect(prompt).not.toContain('obliges the MATRIX');
    },
  );

  it.each(['code', 'test', 'chore', null] as const)(
    'renders for a bug of type %s, before THE CARD IS WRONG',
    (type) => {
      const { prompt } = assembleDispatchPrompt(bug({ type }));
      const block = prompt.indexOf('THIS IS A BUG CARD');
      expect(block).toBeGreaterThan(-1);
      expect(block).toBeLessThan(prompt.indexOf(EXIT_HEADING));
    },
  );

  it('renders on the session-lineage (parent / scoped run) grammar too', () => {
    const { prompt, workflowMode } = assembleDispatchPrompt(
      bug({ sessionBranch: 'motir/auto-run-1', runTargetKey: 'PROD-2' }),
    );
    expect(workflowMode).toBe('session_lineage');
    expect(prompt.indexOf('THIS IS A BUG CARD')).toBeLessThan(prompt.indexOf(EXIT_HEADING));
  });

  it('a MANUAL bug gets no block — it has no pull request body and no CARD IS WRONG to point at', () => {
    const { prompt } = assembleDispatchPrompt(bug({ type: 'manual', executor: 'human' }));
    expect(prompt).not.toContain('THIS IS A BUG CARD');
    expect(prompt).not.toContain(EXIT_HEADING);
  });
});

describe('assembleDispatchPrompt — the ERROR EVIDENCE section (MOTIR-5975 · MOTIR-5982)', () => {
  function link(overrides: Partial<MonitorIssueLinkDto> = {}): MonitorIssueLinkDto {
    return {
      id: 'mi-1',
      title: 'PrismaClientKnownRequestError: expired transaction',
      level: 'error',
      culprit: 'lib/services/githubWebhookService.ts',
      permalink: null,
      eventCount: 112,
      firstSeenAt: '2026-09-19T00:00:00.000Z',
      lastSeenAt: '2026-09-20T18:04:11.000Z',
      environment: 'production',
      release: '2026.09.20-1',
      connection: { id: 'c1', orgSlug: 'acme', projectSlug: 'web' },
      resolve: { state: null, attemptedAt: null, resolvedAt: null, error: null },
      assigneeNote: null,
      evidence: {
        state: 'present',
        stale: false,
        exception: {
          type: 'PrismaClientKnownRequestError',
          message: 'Transaction API error: A commit cannot be executed on an expired transaction.',
        },
        frames: [
          {
            filePath: 'lib/services/githubWebhookService.ts',
            function: 'handle',
            lineNumber: 88,
            inApp: true,
          },
          { filePath: 'node_modules/next/server.js', function: null, lineNumber: 12, inApp: false },
        ],
        tags: [
          { key: 'transaction', value: 'POST /api/github/webhook' },
          { key: 'route', value: '/api/github/webhook' },
        ],
        request: { method: 'POST', path: '/api/github/webhook' },
        eventId: 'ev-1',
        eventAt: '2026-09-20T18:04:11.000Z',
        readAt: '2026-09-20T18:30:00.000Z',
        lastFailedAt: null,
      },
      ...overrides,
    };
  }
  const HEADING = 'ERROR EVIDENCE';

  it('an EMPTY list renders a prompt byte-identical to one without the field', () => {
    const { errorEvidence: _dropped, ...withoutField } = source();
    expect(assembleDispatchPrompt(source({ errorEvidence: [] })).prompt).toBe(
      assembleDispatchPrompt(withoutField as DispatchPromptSource).prompt,
    );
    expect(assembleDispatchPrompt(source()).prompt).not.toContain(HEADING);
    expect(renderErrorEvidence([])).toEqual([]);
  });

  it('a PRESENT link renders the exception, every frame in order with in-app marked, every tag, the request and the event', () => {
    const { prompt } = assembleDispatchPrompt(source({ errorEvidence: [link()] }));
    const at = prompt.indexOf(HEADING);
    expect(at).toBeGreaterThan(-1);
    // With the card's WHAT — after its acceptance criteria, before the git workflow.
    expect(at).toBeGreaterThan(prompt.indexOf('ACCEPTANCE CRITERIA'));
    expect(at).toBeLessThan(prompt.indexOf('GIT WORKFLOW'));
    const block = prompt.slice(at, prompt.indexOf('GIT WORKFLOW'));
    expect(block).toContain('Exception: PrismaClientKnownRequestError');
    expect(block).toContain(
      'Transaction API error: A commit cannot be executed on an expired transaction.',
    );
    const first = block.indexOf('[app] lib/services/githubWebhookService.ts:88 handle');
    const second = block.indexOf('node_modules/next/server.js:12');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(block).not.toContain('[app] node_modules/next/server.js');
    expect(block).toContain('transaction = POST /api/github/webhook');
    expect(block).toContain('route = /api/github/webhook');
    expect(block).toContain('Request: POST /api/github/webhook');
    expect(block).toContain('Event: ev-1 at 2026-09-20T18:04:11.000Z');
    expect(block).toContain('Error 1 of 1: PrismaClientKnownRequestError: expired transaction');
  });

  it('a NEVER-READ link renders one sentence saying so, and no empty headings', () => {
    const lines = renderErrorEvidence([
      link({
        evidence: {
          ...link().evidence,
          state: 'never_read',
          exception: null,
          frames: [],
          tags: [],
          request: null,
          eventId: null,
          eventAt: null,
          readAt: null,
        },
      }),
    ]);
    const text = lines.join('\n');
    expect(text).toContain('The latest event has not been read yet');
    for (const heading of ['Exception:', 'Stack frames', 'Tags:', 'Request:', 'Event:']) {
      expect(text).not.toContain(heading);
    }
  });

  it('a STALE link renders its evidence plus one sentence naming when the last check failed', () => {
    const text = renderErrorEvidence([
      link({
        evidence: { ...link().evidence, stale: true, lastFailedAt: '2026-09-21T09:00:00.000Z' },
      }),
    ]).join('\n');
    expect(text).toContain('the last check of this error failed at 2026-09-21T09:00:00.000Z');
    expect(text).toContain('Exception: PrismaClientKnownRequestError');
  });

  it('a NO-EXCEPTION link says so and still shows its tags and request', () => {
    const text = renderErrorEvidence([
      link({
        evidence: { ...link().evidence, state: 'no_exception', exception: null, frames: [] },
      }),
    ]).join('\n');
    expect(text).toContain('No exception');
    expect(text).toContain('Request: POST /api/github/webhook');
    expect(text).not.toContain('Stack frames');
  });
});

// Story MOTIR-6016 · MOTIR-6099 — a leaf's DIFFICULTY is ONE fact line when it
// is set, and the prompt says nothing about it when it is not.
describe('the difficulty line', () => {
  it.each(['trivial', 'low', 'medium', 'high'] as const)(
    'states %s in exactly one line',
    (difficulty) => {
      const { prompt } = assembleDispatchPrompt(source({ difficulty }));
      const lines = prompt.match(/^- Difficulty: .*$/gm) ?? [];
      expect(lines).toHaveLength(1);
      expect(prompt).toMatch(new RegExp(`^- Difficulty: ${difficulty}\\b`, 'm'));
      // Named as reasoning, not size, so `high` is not read as "big".
      expect(lines[0]).toContain('not its size');
    },
  );

  it('says nothing about difficulty when it is unset — no line, no word', () => {
    const { prompt } = assembleDispatchPrompt(source({ difficulty: null }));
    expect(prompt).not.toMatch(/difficulty/i);
  });

  it('adds only its own line: an unset prompt is the set one minus that line', () => {
    const unset = assembleDispatchPrompt(source({ difficulty: null })).prompt;
    const set = assembleDispatchPrompt(source({ difficulty: 'medium' })).prompt;
    expect(set.replace(/^- Difficulty: .*\n/m, '')).toBe(unset);
  });
});

// ── THE REPORT — step 4 of THE CARD IS WRONG, in both lanes (MOTIR-6287) ────
//
// `docs/decisions/run-found-trigger-dispatched-path.md`, *The prompt change*:
// right after the step-3 comment the runner calls `report_unbuildable_target`
// with the card and the SAME text, in BOTH lanes, because the lane changes what
// it does next, not what it found. It is told the call spends nothing, is safe
// to repeat and returns nothing to act on — and NOT what the server does with
// it, so it keeps describing the card rather than judging the plan.
//
// Every assertion is on the RENDERED prompt (`assembleDispatchPrompt`).
describe('THE CARD IS WRONG — the report_unbuildable_target step (MOTIR-6287)', () => {
  const REPLAN = { logBug: true, replan: true, autoApproveReplan: false };
  const NO_REPLAN = { logBug: true, replan: false, autoApproveReplan: false };
  const TWO_LANES = { logBug: true, replan: true, autoApproveReplan: true };
  const RENDERS = [
    { name: 're-planning ON', policy: REPLAN },
    { name: 're-planning OFF', policy: NO_REPLAN },
    { name: '--auto-approve-replan', policy: TWO_LANES },
  ] as const;

  /** THE CARD IS WRONG, from its heading up to FOUND A DEFECT. */
  function block(policy: DispatchPromptSource['findingsPolicy']): string {
    // A runner that posts the self-report (MOTIR-8810); the other route has its own block.
    const prompt = assembleDispatchPrompt(
      source({ key: 'PROD-99', findingsPolicy: policy, runnerPostsAgentReport: true }),
    ).prompt;
    const branches = cardOutcomeBranches(prompt);
    const at = branches.indexOf('STOP — the WHAT itself breaks');
    expect(at, 'the prompt carries THE CARD IS WRONG').toBeGreaterThan(-1);
    return branches.slice(at);
  }

  /** The numbered steps — `  N. <heading>` — in the order they render. */
  function steps(text: string): { n: number; heading: string; at: number }[] {
    return [...text.matchAll(/^ {2}(\d+)\. (.*)$/gm)].map((m) => ({
      n: Number(m[1]),
      heading: m[2]!,
      at: m.index!,
    }));
  }

  /** Step `n`'s whole text, up to the next numbered step. */
  function stepText(text: string, n: number): string {
    const all = steps(text);
    const i = all.findIndex((s) => s.n === n);
    expect(i, `step ${n} exists`).toBeGreaterThan(-1);
    return text.slice(all[i]!.at, all[i + 1]?.at ?? text.length);
  }

  it('names a REGISTERED tool', () => {
    expect(MCP_TOOL_NAMES).toContain(REPORT_UNBUILDABLE_TARGET_TOOL_NAME);
  });

  it.each(RENDERS)(
    '$name: exactly ONE report step, numbered 4, after the step-3 comment',
    ({ policy }) => {
      const text = block(policy);
      expect(text.split(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toHaveLength(2);
      const four = stepText(text, 4);
      expect(four).toMatch(/^ {2}4\. Report it\. If the environment variable MOTIR_AGENT_REPORT/);
      // The run's own file FIRST (MOTIR-8698): the CLI reports with the run's
      // credential, so an agent with no Motir token or MCP still reaches it.
      expect(four).toContain('"unbuildable": "<the SAME text as your step-3 comment>"');
      expect(four.indexOf('"unbuildable"')).toBeLessThan(
        four.indexOf(REPORT_UNBUILDABLE_TARGET_TOOL_NAME),
      );
      expect(four).toMatch(
        /If the variable is unset, report it with the report_unbuildable_target tool/,
      );
      expect(stepText(text, 3)).toContain('3. Comment the finding on PROD-99');
      expect(four).toMatch(/projectKey:\s+PROD\b/);
      expect(four).toMatch(/targetKey:\s+PROD-99\b/);
      expect(four).toMatch(/reason:\s+the SAME text as your step-3 comment/);
    },
  );

  it('re-planning ON: the report sits BEFORE the Planning transition, which is now step 5', () => {
    const text = block(REPLAN);
    expect(text.indexOf(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toBeLessThan(
      text.indexOf('status planning'),
    );
    expect(stepText(text, 5)).toContain('5. Move PROD-99 to Planning');
  });

  it('re-planning OFF: the report sits BEFORE "Stop, and leave the card In Progress"', () => {
    const text = block(NO_REPLAN);
    expect(text.indexOf(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toBeLessThan(
      text.indexOf('Stop, and leave the card In Progress'),
    );
    expect(stepText(text, 5)).toContain('5. Stop, and leave the card In Progress');
    expect(stepText(text, 6)).toContain('6. Do not pick up other work');
  });

  it('--auto-approve-replan: the step has the SAME number, text and position as re-planning ON', () => {
    const on = block(REPLAN);
    const lanes = block(TWO_LANES);
    expect(stepText(lanes, 4)).toBe(stepText(on, 4));
    expect(steps(lanes).map((s) => s.heading)).toEqual(steps(on).map((s) => s.heading));
  });

  it.each(RENDERS)(
    '$name: the step says free, repeatable, nothing to act on — and never what the server does',
    ({ policy }) => {
      const text = block(policy);
      const four = stepText(text, 4);
      expect(four).toContain('It spends nothing.');
      expect(four).toContain('It is safe to repeat');
      expect(four).toContain('one record per');
      expect(four).toContain('It returns nothing to act on.');
      expect(four).not.toMatch(/verdict|unchanged|native|planning bug|planner|classif/i);
      // …and the whole block gains none of them. The block's ONE pre-existing
      // "classify" is the negation the re-plan lane has always carried ("you are
      // not asked to classify the mistake") — the runner still classifies nothing.
      expect(text).not.toMatch(/verdict|unchanged|native|planning bug/i);
      const classify = text.match(/classify/gi) ?? [];
      if (policy.replan) {
        expect(classify).toHaveLength(1);
        expect(text).toMatch(/you are not asked to classify the/);
        expect(text).toMatch(
          /Describe what is wrong with the\s+CARD, not why it was planned that way/,
        );
      } else {
        expect(classify).toHaveLength(0);
      }
    },
  );

  it.each(RENDERS)(
    '$name: steps number contiguously from 1, and every "step N" names what it meant before',
    ({ policy }) => {
      const text = block(policy);
      const numbered = steps(text);
      expect(numbered.map((s) => s.n)).toEqual(numbered.map((_, i) => i + 1));
      expect(numbered).toHaveLength(policy.replan ? 9 : 6);

      // Every in-text reference, resolved to the heading of the step it names.
      // Before the report existed they named the comment (3), the append (5)
      // and the submit (6); they must still name those same steps.
      const heading = (n: number) => numbered.find((s) => s.n === n)?.heading ?? '<missing>';
      const refs = [...text.matchAll(/\bsteps?[ -](\d+)(?: and (\d+))?/gi)].flatMap((m) =>
        [m[1], m[2]].filter(Boolean).map(Number),
      );
      expect(refs.length).toBeGreaterThan(0);
      const allowed = [
        /^Comment the finding on /,
        /^Put the finding on the planning thread/,
        /^Compose the WHAT/,
      ];
      for (const n of refs) {
        expect(
          allowed.some((re) => re.test(heading(n))),
          `"step ${n}" names "${heading(n)}"`,
        ).toBe(true);
      }
      if (policy.replan) {
        expect(text).toContain('Nothing has reached the planner until step 7');
        expect(heading(7)).toMatch(/^Compose the WHAT/);
      }
      if (policy.autoApproveReplan) {
        expect(text).toContain('steps 6 and 7');
        expect(text).not.toContain('steps 5 and 6');
      }
    },
  );
});

// MOTIR-8722 — an agent with NO Motir tools (a hosted run, a run inside an agent) cannot make the
// build-through record or the STOP's writes itself. The prompt sends both through
// `$MOTIR_AGENT_REPORT`, and says plainly that the re-plan is not submitted on that path.
describe('NO MOTIR TOOLS — the build-through and the STOP go through the self-report (MOTIR-8722)', () => {
  // A runner that posts the self-report (MOTIR-8810): only then are the file routes named.
  const prompt = (policy: DispatchPromptSource['findingsPolicy']) =>
    assembleDispatchPrompt(
      source({ key: 'PROD-99', findingsPolicy: policy, runnerPostsAgentReport: true }),
    ).prompt;
  const REPLAN = { logBug: true, replan: true, autoApproveReplan: false };
  const NO_REPLAN = { logBug: true, replan: false, autoApproveReplan: false };

  it('the build-through puts its points into the file as "discrepancy" when the tool is missing', () => {
    const text = prompt(REPLAN);
    const at = text.indexOf('BUILD THROUGH — the WHAT holds');
    const through = text.slice(at, text.indexOf('STOP — the WHAT itself breaks'));
    expect(through).toContain('If the record_run_discrepancy tool is not available to you');
    expect(through).toContain('"discrepancy": [{"planAsked": "…", "built": "…", "why": "…"}]');
    // The JSON shown is the shape the CLI reads.
    const shown = JSON.parse(
      '{"model": "m", "discrepancy": [{"planAsked": "a", "built": "b", "why": "c"}]}',
    ) as { discrepancy: unknown[] };
    expect(shown.discrepancy).toHaveLength(1);
  });

  it('a re-planning STOP asks for "stop" with toPlanning and the six fields, and says nothing is submitted', () => {
    const text = prompt(REPLAN);
    const stop = text.slice(text.indexOf('STOP — the WHAT itself breaks'));
    expect(stop).toContain('NO MOTIR TOOLS?');
    expect(stop).toContain('"stop": {"toPlanning": true, "requirement": {"outcome": "…"');
    for (const field of AI_REQUIREMENT_FIELDS) expect(stop).toContain(`"${field}"`);
    expect(stop).toContain('It does NOT submit the');
    expect(stop).toContain('Do not report a re-plan as submitted.');
    // Before the Planning step it replaces, so the agent reads it in time.
    expect(stop.indexOf('NO MOTIR TOOLS?')).toBeLessThan(
      stop.indexOf('to Planning with the transition_status tool'),
    );
  });

  it('a STOP with re-planning off asks for "stop" with toPlanning false and moves nothing', () => {
    const stop = prompt(NO_REPLAN).slice(
      prompt(NO_REPLAN).indexOf('STOP — the WHAT itself breaks'),
    );
    expect(stop).toContain('"stop": {"toPlanning": false}');
    expect(stop).not.toContain('"toPlanning": true');
  });
});

describe('a runner that does NOT post the self-report gets the tool as the route (MOTIR-8810)', () => {
  // `@motir/cli` 0.12.0 sets `$MOTIR_AGENT_REPORT` and reads only `model` from it. The
  // prompt MOTIR-8698 deployed told every agent with that file to put its unbuildable
  // reason there and skip the tool, so with every CLI anyone could install the report was
  // lost. Only a client that declares it posts gets `runnerPostsAgentReport: true`; the
  // `/api/v1` route passes `false` otherwise, and the MCP tool passes nothing.
  const REPLAN = { logBug: true, replan: true, autoApproveReplan: false };
  const NO_REPLAN = { logBug: true, replan: false, autoApproveReplan: false };
  const text = (
    runnerPostsAgentReport: boolean | undefined,
    policy: DispatchPromptSource['findingsPolicy'] = REPLAN,
  ) =>
    assembleDispatchPrompt(
      source({
        key: 'PROD-99',
        findingsPolicy: policy,
        ...(runnerPostsAgentReport === undefined ? {} : { runnerPostsAgentReport }),
      }),
    ).prompt;
  const stopOf = (t: string) => t.slice(t.indexOf('STOP — the WHAT itself breaks'));
  const throughOf = (t: string) =>
    t.slice(
      t.indexOf('BUILD THROUGH — the WHAT holds'),
      t.indexOf('STOP — the WHAT itself breaks'),
    );

  it.each([
    ['re-planning on', REPLAN],
    ['re-planning off', NO_REPLAN],
  ])(
    'with %s, step 4 is the report_unbuildable_target call and names no file route',
    (_n, policy) => {
      expect(text(undefined, policy)).toBe(text(false, policy));
      const stop = stopOf(text(false, policy));
      expect(stop).toContain(
        `  4. Report it with the ${REPORT_UNBUILDABLE_TARGET_TOOL_NAME} tool:`,
      );
      expect(stop).toContain('targetKey:  PROD-99');
      expect(stop).not.toContain('no Motir tool needed');
      expect(stop).not.toContain('"unbuildable"');
      expect(stop).not.toContain('NO MOTIR TOOLS?');
      expect(stop).not.toContain('"stop": {');
    },
  );

  it('the build-through names no "discrepancy" file route', () => {
    const through = throughOf(text(false));
    expect(through).toContain(`Call the ${RECORD_RUN_DISCREPANCY_TOOL_NAME} tool ONCE`);
    expect(through).not.toContain('"discrepancy"');
    expect(through).not.toContain('NO MOTIR TOOLS?');
  });

  it('still asks for the model, which 0.12.0 does read', () => {
    expect(text(false)).toContain('{"model": "<the model you are running as>"}');
  });

  it('a runner that posts gets the file route, with the tool kept for an unset variable', () => {
    const t = text(true);
    expect(stopOf(t)).toContain('no Motir tool needed');
    expect(stopOf(t)).toContain(
      `If the variable is unset, report it with the ${REPORT_UNBUILDABLE_TARGET_TOOL_NAME} tool:`,
    );
    expect(stopOf(t)).toContain('NO MOTIR TOOLS?');
    expect(throughOf(t)).toContain('"discrepancy"');
  });
});

describe('the BRANCH the prompt instructs (MOTIR-6530) — what a local run records on checkout_ready', () => {
  it('is the card’s per-item branch in `per_item_pr` mode, and the prompt names that same branch', () => {
    const { prompt, branch } = assembleDispatchPrompt(source());
    expect(branch).toBe('subtask/PROD-7-add-the-ready-set-filter-bar');
    expect(prompt).toContain(branch!);
  });

  it('is the session branch in `session_lineage` mode', () => {
    expect(assembleDispatchPrompt(source({ sessionBranch: 'motir/auto-9' })).branch).toBe(
      'motir/auto-9',
    );
  });

  it('is null for a MANUAL item, which has no branch at all', () => {
    expect(assembleDispatchPrompt(source({ type: 'manual', executor: 'human' })).branch).toBeNull();
  });
});

describe('the CHECKPOINT step (MOTIR-6531) — every git workflow pushes after each commit', () => {
  const variants = {
    'per-item': source(),
    'session lineage': source({ sessionBranch: 'motir/auto-4' }),
    'multi-repo per-item': source({
      targetRepos: [
        { name: 'motir-core', defaultBranch: 'main' },
        { name: 'motir-ai', defaultBranch: 'main' },
      ],
    }),
    'multi-repo lineage': source({
      sessionBranch: 'motir/auto-4',
      targetRepos: [
        { name: 'motir-core', defaultBranch: 'main' },
        { name: 'motir-ai', defaultBranch: 'main' },
      ],
    }),
  };

  it.each(Object.entries(variants))('%s carries the checkpoint instruction', (_name, src) => {
    const { prompt, branch } = assembleDispatchPrompt(src);
    expect(prompt).toContain('CHECKPOINT: push the branch after EVERY commit');
    expect(prompt).toContain('it opens no pull request.');
    // It pushes the WORK branch, never the session branch.
    expect(prompt).toContain('`git push -u origin subtask/PROD-7-add-the-ready-set-filter-bar`');
    expect(branch).not.toBeNull();
  });

  it('a manual item has no git workflow, so no checkpoint either', () => {
    const { prompt } = assembleDispatchPrompt(source({ type: 'manual', executor: 'human' }));
    expect(prompt).not.toContain('CHECKPOINT');
  });
});

describe('the CONTINUE block and workflow (MOTIR-6531)', () => {
  const continueFrom = {
    deadRunId: 'run_dead',
    endedHow: 'the run stopped reporting (no heartbeat reached Motir)',
    lastHeardAt: '2026-09-27T14:02:00.000Z',
    dispatcherName: 'Mara S.',
    branch: 'subtask/PROD-7-earlier-work',
    pullRequest: { repo: 'acme/web', number: 131, url: 'https://github.com/acme/web/pull/131' },
  };

  /** The GIT WORKFLOW section's text. */
  const gitSection = (prompt: string) =>
    prompt.slice(prompt.indexOf('\nGIT WORKFLOW'), prompt.indexOf('\nREPORTING THE OUTCOME'));

  it('renders the dead run’s end, last heard, dispatcher, branch and open pull request', () => {
    const { prompt, branch } = assembleDispatchPrompt(source({ continueFrom }));
    expect(prompt).toContain('CONTINUE — you are carrying on a run that DIED, not starting fresh');
    expect(prompt).toContain('run_dead) was run by Mara S.');
    expect(prompt).toContain('It ended: the run stopped reporting (no heartbeat reached Motir).');
    expect(prompt).toContain('Last heard from 2026-09-27T14:02:00.000Z.');
    expect(prompt).toContain('Its work is on the branch subtask/PROD-7-earlier-work.');
    expect(prompt).toContain('acme/web #131');
    expect(prompt).toContain('do NOT create a new branch');
    expect(branch).toBe('subtask/PROD-7-earlier-work');
  });

  it('the git section CHECKS THE BRANCH OUT — no `-b` anywhere, and a second PR is refused', () => {
    const git = gitSection(assembleDispatchPrompt(source({ continueFrom })).prompt);
    expect(git).not.toMatch(/(^|\s)-b(\s|$)/m);
    expect(git).toContain('git worktree add ../motir-core-prod-7 subtask/PROD-7-earlier-work');
    expect(git).toContain('git merge origin/main');
    expect(git).toContain('`gh pr list --head subtask/PROD-7-earlier-work`');
    expect(git).toContain('CHECKPOINT: push the branch after EVERY commit');
    expect(git).toContain('LINK it: call the link_pull_request tool with key PROD-7');
  });

  it('a lineage card keeps integrating into its session branch', () => {
    const git = gitSection(
      assembleDispatchPrompt(source({ continueFrom, sessionBranch: 'motir/auto-9' })).prompt,
    );
    expect(git).not.toMatch(/(^|\s)-b(\s|$)/m);
    expect(git).toContain('git merge origin/motir/auto-9');
    expect(git).toContain('Integrate the commit into motir/auto-9 and push that branch.');
    expect(git).toContain('mark_integrated');
  });

  it('without continueFrom the fresh prompt carries NO continue block', () => {
    const { prompt } = assembleDispatchPrompt(source());
    expect(prompt).not.toContain('CONTINUE — you are carrying on');
    expect(gitSection(prompt)).toMatch(/-b subtask\/PROD-7/);
  });
});

// ── THE CARD IS WRONG, in two ways — the WHAT test, BUILD THROUGH and STOP (MOTIR-8658) ──
//
// Story MOTIR-8651. A run that finds its card wrong first asks ONE question about the WHAT. Yes
// builds through and records a discrepancy; no stops exactly as before. The test's wording is the
// decision page's (MOTIR-8654), quoted verbatim — where this suite and that page disagree, the
// page wins.

describe('THE CARD IS WRONG — the WHAT test, BUILD THROUGH and STOP (MOTIR-8658)', () => {
  const WHAT_TEST = [
    "Is the WHAT — the card's outcome and its acceptance criteria — unchanged,",
    "consistent with itself and with shipped reality and other cards' scope, and",
    'reachable by this run alone?',
  ].join(' ');
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  const POLICIES = [
    { name: 'full', policy: { logBug: true, replan: true, autoApproveReplan: false } },
    { name: 'no re-plan', policy: { logBug: true, replan: false, autoApproveReplan: false } },
    { name: 'two lanes', policy: { logBug: true, replan: true, autoApproveReplan: true } },
    { name: 'nothing filed', policy: { logBug: false, replan: false, autoApproveReplan: false } },
  ] as const;

  /** The card-is-wrong block of the composed prompt, from its heading to FOUND A DEFECT. */
  function wrongBlock(over: Partial<DispatchPromptSource> = {}): string {
    const branches = cardOutcomeBranches(assembleDispatchPrompt(source(over)).prompt);
    const at = branches.indexOf('THE CARD IS WRONG —');
    expect(at, 'the prompt carries THE CARD IS WRONG').toBeGreaterThan(-1);
    return branches.slice(at);
  }

  /** BUILD THROUGH's own text: from its heading up to the STOP heading. */
  function buildThrough(block: string): string {
    const at = block.indexOf('BUILD THROUGH — the WHAT holds');
    const stop = block.indexOf('STOP — the WHAT itself breaks');
    expect(at, 'a BUILD THROUGH section').toBeGreaterThan(-1);
    expect(stop, 'a STOP section').toBeGreaterThan(at);
    return block.slice(at, stop);
  }

  const DECISION = { type: 'decision', executor: 'coding_agent' } as const;

  it('names the tool from the REGISTERED constant, and never says "the nearest thing that works"', () => {
    expect(RECORD_DISCREPANCY_TOOL_NAME).toBe(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    for (const over of [{}, { sessionBranch: 'motir/auto-1' }, DECISION]) {
      const { prompt } = assembleDispatchPrompt(source(over));
      expect(prompt).not.toContain('nearest thing that works');
      expect(buildThrough(wrongBlock(over))).toContain(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    }
  });

  it.each([
    { lane: 'code', over: {} },
    { lane: 'decision', over: DECISION },
  ])(
    'the $lane lane: the test, then BUILD THROUGH, then STOP, then FOUND A DEFECT — in that order',
    ({ over }) => {
      const prompt = assembleDispatchPrompt(source({ key: 'PROD-7', ...over })).prompt;
      const branches = outcomeSection(prompt);
      const order = [
        branches.indexOf('THE CARD IS WRONG —'),
        flat(branches).indexOf(WHAT_TEST),
        branches.indexOf('BUILD THROUGH — the WHAT holds'),
        branches.indexOf('STOP — the WHAT itself breaks'),
        branches.indexOf('FOUND A DEFECT — your card is fine'),
      ];
      expect(
        order.every((n) => n > -1),
        `every part renders: ${order}`,
      ).toBe(true);
      // The test text is offset in the FLAT string, so compare the rest by position and the
      // test by presence: it has to sit between the header and BUILD THROUGH.
      const flatBranches = flat(branches);
      expect(flatBranches.indexOf(WHAT_TEST)).toBeGreaterThan(
        flatBranches.indexOf('THE CARD IS WRONG —'),
      );
      expect(flatBranches.indexOf(WHAT_TEST)).toBeLessThan(
        flatBranches.indexOf('BUILD THROUGH — the WHAT holds'),
      );
      expect(order[2]).toBeLessThan(order[3]!);
      expect(order[3]).toBeLessThan(order[4]!);
    },
  );

  it('BUILD THROUGH (code lane) records ONCE with the key and the three fields, before committing', () => {
    const section = flat(buildThrough(wrongBlock({ key: 'PROD-7' })));
    expect(section).toContain(`Call the ${RECORD_RUN_DISCREPANCY_TOOL_NAME} tool ONCE`);
    expect(section).toContain('after you have built and before you commit');
    expect(section).toContain('key: PROD-7');
    for (const field of ['planAsked', 'built', 'why']) expect(section).toContain(field);
    expect(section).toContain('DISCREPANCY_ALREADY_RECORDED');
    expect(section).toContain('## Deviations from the plan');
    expect(section).toContain('Discrepancy record missing: <the error code or message>');
    expect(section).toMatch(/recorded: false means PROD-7 has no open run leg/);
    expect(section).toContain('is NOT a failure');
    // What survives from STOP: the WHAT is never widened.
    expect(section).toContain('You change the ROUTE, never the WHAT');
    expect(section).toContain('Never edit, re-scope, re-parent or archive any card');
  });

  it('BUILD THROUGH hands nothing back: no report, no Planning, no planner, no classification vocabulary', () => {
    for (const over of [{}, { sessionBranch: 'motir/auto-1' }, DECISION]) {
      const section = buildThrough(wrongBlock(over));
      expect(section).not.toContain(REPORT_UNBUILDABLE_TARGET_TOOL_NAME);
      expect(section).not.toMatch(/submit_plan_session|append_plan_turn|status planning/);
      expect(section).not.toMatch(/verdict|unchanged|planning bug|classif/i);
    }
  });

  it('STOP keeps today’s steps under every policy, and names the report tool exactly once in the whole prompt', () => {
    for (const { name, policy } of POLICIES) {
      const over = { key: 'PROD-7', findingsPolicy: policy, runnerPostsAgentReport: true };
      const prompt = assembleDispatchPrompt(source(over)).prompt;
      const block = flat(wrongBlock(over));
      const stop = block.slice(block.indexOf('STOP — the WHAT itself breaks'));
      expect(stop, name).toContain('1. REVERT FIRST.');
      expect(stop, name).toContain('Do not improvise');
      expect(stop, name).toContain('Do NOT RESTRUCTURE THE PLAN');
      expect(stop, name).toContain('Comment the finding on PROD-7');
      expect(stop, name).toMatch(
        /report it with the report_unbuildable_target tool: projectKey: PROD targetKey: PROD-7 reason:/,
      );
      expect(prompt.split(REPORT_UNBUILDABLE_TARGET_TOOL_NAME), name).toHaveLength(2);
      if (policy.replan) {
        expect(stop, name).toContain('Move PROD-7 to Planning');
        expect(stop, name).toContain('submit_plan_session');
      } else {
        expect(stop, name).toContain('Stop, and leave the card In Progress');
        expect(stop, name).not.toContain('submit_plan_session');
      }
      // The two lanes are information inside STOP, and only under --auto-approve-replan.
      expect(stop.includes('TWO LANES, and WHICH ONE'), name).toBe(policy.autoApproveReplan);
    }
  });

  it('BUILD THROUGH renders identically under every combination of the findings policy', () => {
    const [first, ...rest] = POLICIES.map(({ policy }) =>
      buildThrough(wrongBlock({ key: 'PROD-7', findingsPolicy: policy })),
    );
    for (const section of rest) expect(section).toBe(first);
  });

  it('FOUND A DEFECT says it applies on BUILD THROUGH too, and keeps its comment-only alternative', () => {
    for (const { policy } of POLICIES) {
      const prompt = assembleDispatchPrompt(
        source({ key: 'PROD-7', findingsPolicy: policy }),
      ).prompt;
      const defect = flat(prompt.slice(prompt.indexOf('FOUND A DEFECT — your card is fine')));
      expect(defect).toContain('It applies during a BUILD THROUGH as well');
      expect(defect).toContain('filing a bug never turns a build-through into STOP');
      if (!policy.logBug) expect(defect).toContain('do NOT create a work item');
    }
  });

  it('the decision lane records BEFORE publish_decision_page, lists deviations in the report, and does not transition', () => {
    const block = wrongBlock({ key: 'PROD-7', ...DECISION });
    const section = flat(buildThrough(block));
    expect(section).toContain('before publish_decision_page');
    expect(section).toContain('list the same points in your FINISHED report');
    expect(section).toContain('do NOT transition the card');
    expect(section).not.toContain('## Deviations from the plan');
    expect(section).toContain('Discrepancy record missing:');
    // STOP still opens with PUBLISH NOTHING.
    const stop = block.slice(block.indexOf('STOP — the WHAT itself breaks'));
    expect(stop.indexOf('PUBLISH NOTHING')).toBeGreaterThan(-1);
    expect(stop.indexOf('PUBLISH NOTHING')).toBeLessThan(stop.indexOf('Do not improvise'));
  });

  it('with a session branch, the Deviations section goes in the SESSION pull request body, and no PR of its own is asked for', () => {
    const section = flat(
      buildThrough(wrongBlock({ key: 'PROD-7', sessionBranch: 'motir/auto-1' })),
    );
    expect(section).toContain(
      '"## Deviations from the plan" section for PROD-7 to the BODY of the session pull request',
    );
    expect(section).not.toMatch(/open (a|the) pull request/i);
  });
});

// THE REPOSITORY'S CONVENTION IS READ, NOT AUTO-LOADED (Story MOTIR-9079 · MOTIR-9084).
// The prompt used to send the agent to "its CLAUDE.md", which holds only on a harness
// that loads one and in a repository whose owner wrote one. It now names the MCP read
// that returns the convention the team keeps on the Code page, and says what to do
// when that read has nothing or fails.
describe('the repository convention is fetched with get_coding_convention (MOTIR-9084)', () => {
  const ALL_TYPES: WorkItemTypeDto[] = [
    'code',
    'design',
    'test',
    'content',
    'copy',
    'translate',
    'research',
    'review',
    'verification',
    'decision',
    'choice',
    'deploy',
    'manual',
    'legal',
    'chore',
  ];
  const CHANGES_A_REPO: (WorkItemTypeDto | null)[] = [
    'code',
    'test',
    'content',
    'copy',
    'translate',
    'chore',
    null,
  ];
  const render = (type: WorkItemTypeDto | null) =>
    assembleDispatchPrompt(source({ type, executor: 'coding_agent' })).prompt;

  it('the tool name is the REGISTERED one', () => {
    expect(GET_CODING_CONVENTION_TOOL_NAME).toBe(REGISTERED_GET_CODING_CONVENTION);
    expect(MCP_TOOL_NAMES).toContain(GET_CODING_CONVENTION_TOOL_NAME);
  });

  it.each([...ALL_TYPES, null])('the prompt for type %s never names CLAUDE.md', (type) => {
    expect(render(type)).not.toContain('CLAUDE.md');
  });

  it.each(CHANGES_A_REPO)(
    'type %s names the read with the project key and the target repository',
    (type) => {
      expect(render(type)).toContain(
        'get_coding_convention { projectKey: "PROD", repo: "motir-core" }',
      );
    },
  );

  it('says what to do when no convention is recorded and when the read fails', () => {
    const prompt = render('code');
    expect(prompt).toContain('BEFORE you build, read the repository’s coding convention');
    expect(prompt).toContain(
      'If it says no convention is recorded, follow the patterns of the surrounding',
    );
    expect(prompt).toContain(
      'If the call fails, say so in your report and follow the surrounding code.',
    );
    expect(prompt).toContain('this prompt never relies on one.');
  });

  it('a card with no target repository still names the read, without inventing a repo', () => {
    const { prompt } = assembleDispatchPrompt(
      source({ type: 'code', targetRepo: null, targetRepos: undefined }),
    );
    expect(prompt).toContain('repo: <the repository you are working in>');
  });

  it('a manual item is a person’s instructions and carries no tool call', () => {
    expect(render('manual')).not.toContain('get_coding_convention');
  });
});

describe('the run prompt states the product’s approval and receipt rules (MOTIR-9085)', () => {
  const designPrompt = assembleDispatchPrompt(
    source({ type: 'design', executor: 'coding_agent', openDependentKeys: ['X-2'] }),
  ).prompt;
  const acceptancePrompt = assembleDispatchPrompt(
    source({
      key: 'PROD-40',
      type: 'test',
      title: 'Story E2E (Playwright) + ACCEPTANCE VIDEO — walk both surfaces',
      descriptionMd: 'Record the story working.\n\n## Acceptance criteria\n\n- Declares its story.',
    }),
  ).prompt;
  const codePrompt = assembleDispatchPrompt(source({ type: 'code' })).prompt;

  it.each([
    'Publishing raises an approval gate on this card.',
    'you never approve it and have no way to.',
    'holds two gates and asks ONE question',
    'Approve\n     moves the card to done only when no pull request is open',
    'Your publish does NOT release a blocked_by on this card.',
    'Republish only because the design CHANGED.',
    'A second publish retires the\n     pending question',
    'A superseded design’s missing files are expected',
  ])('a design card that something waits on says: %s', (sentence) => {
    expect(designPrompt).toContain(sentence);
  });

  it('a design card nothing waits on carries none of the publish rules', () => {
    const quiet = assembleDispatchPrompt(
      source({ type: 'design', executor: 'coding_agent' }),
    ).prompt;
    expect(quiet).not.toContain('Publishing raises an approval gate');
  });

  it.each([
    'AN ACCEPTANCE SPEC IS A RECEIPT, NOT A REGRESSION TEST',
    'Approving pins the recording; it does not freeze the story.',
    'the story goes back below implemented',
    'Only the spec’s AUTHOR moves it out of the acceptance lane',
    'do NOT edit the assertion to match today',
  ])('an acceptance card says: %s', (sentence) => {
    expect(acceptancePrompt).toContain(sentence);
  });

  it('an ordinary code card is not told about receipts', () => {
    expect(codePrompt).not.toContain('ACCEPTANCE SPEC IS A RECEIPT');
  });

  it('every reporting section tells the agent a manual-mode pull request is awaiting approval', () => {
    expect(codePrompt).toContain('OPEN AND\n  AWAITING APPROVAL');
    expect(codePrompt).toContain('You never approve a gate or merge a pull request.');
  });

  it('names no motir-core path, lane or file in the new sentences', () => {
    for (const p of [designPrompt, acceptancePrompt, codePrompt]) {
      expect(p).not.toContain('tests/e2e/acceptance');
      expect(p).not.toContain('docs/approval-gates');
    }
  });
});

// ── DECIDE WHAT THE CARD LEAVES OPEN — the never-ask rule and the decision record (MOTIR-10000) ──

describe('DECIDE WHAT THE CARD LEAVES OPEN — a run never asks, decides by best practice, records it (MOTIR-10000)', () => {
  const HEADING = 'DECIDE WHAT THE CARD LEAVES OPEN — never ask';
  /** The block's own text: its heading up to the next rule-barred heading. */
  const blockOf = (prompt: string): string => {
    const at = prompt.indexOf(HEADING);
    expect(at, 'a DECIDE WHAT THE CARD LEAVES OPEN section').toBeGreaterThan(-1);
    // Past the heading's own closing rule, up to the next section's opening rule.
    const rest = prompt.slice(at + HEADING.length).replace(/^\n═+\n/, '');
    const next = rest.search(/\n═+\n[A-Z]/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const DECISION_CARD = {
    type: 'decision' as const,
    title: 'Pick the queue',
    kind: 'task' as const,
  };

  it('says never ask, how to decide, and that ease is never a reason — on the code lane', () => {
    const block = blockOf(assembleDispatchPrompt(source()).prompt);
    expect(block).toContain(
      'A detail the card and its plan leave open is YOURS to decide. Never ask anyone',
    );
    expect(block).toContain(
      'about the implementation: nobody is there to answer mid-run. Do not use',
    );
    expect(block).toContain(
      'AskUserQuestion, do not ask to confirm the scope, and do not offer options and',
    );
    expect(block).toContain(
      "  1. The repository's own conventions — its coding convention, its instruction",
    );
    expect(block).toContain(
      '  2. Where they are silent, the established industry best practice for the',
    );
    expect(block).toContain(
      'Take the best-practice option even when it is more work. Never choose an option',
    );
    expect(block).toContain('because it is the easiest, the smallest or the quickest to ship.');
    // No "simplest option" escape hatch anywhere in the block.
    expect(block).not.toMatch(/simplest|if in doubt, (pick|choose) the/i);
  });

  it('keeps the WHAT out of it: a question that changes the WHAT is THE CARD IS WRONG, not a question', () => {
    const block = blockOf(assembleDispatchPrompt(source()).prompt);
    expect(block).toContain(
      "card's outcome or an acceptance criterion — is not yours to decide: that is",
    );
    expect(block).toContain(
      'THE CARD IS WRONG below, and its STOP is an action you take, not a question.',
    );
  });

  it('records the decisions ONCE through record_run_discrepancy, before committing, in the SAME call as a build-through', () => {
    const block = blockOf(assembleDispatchPrompt(source({ key: 'PROD-42' })).prompt);
    expect(RECORD_DISCREPANCY_TOOL_NAME).toBe(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    expect(block).toContain(
      'RECORD every decision you made, ONCE, after you have built and before you commit,',
    );
    expect(block).toContain(`with the ${RECORD_RUN_DISCREPANCY_TOOL_NAME} tool:`);
    expect(block).toContain('         key:       PROD-42');
    expect(block).toContain(
      '                    { planSaid, chose, why, alternatives } — what the card said',
    );
    expect(block).toContain(
      '  that SAME call beside its points: the record is one call per run, and a',
    );
    expect(block).toContain(
      '  second call is refused DISCREPANCY_ALREADY_RECORDED. A run that decided',
    );
    expect(block).toContain('  "## Decisions the run made" section.');
    expect(block).toContain('         Decision record missing: <the error code or message>');
  });

  it('sits after the card’s own WHAT and before the closing sections', () => {
    const prompt = assembleDispatchPrompt(source()).prompt;
    const at = prompt.indexOf(HEADING);
    expect(at).toBeGreaterThan(prompt.indexOf('\nACCEPTANCE CRITERIA'));
    expect(at).toBeLessThan(prompt.indexOf('\nREPORTING YOUR STEPS'));
    expect(at).toBeLessThan(prompt.indexOf('\nGIT WORKFLOW'));
  });

  it('a session-lineage card lists the decisions in the session pull request body', () => {
    const block = blockOf(
      assembleDispatchPrompt(source({ sessionBranch: 'session/PROD-1-x' })).prompt,
    );
    expect(block).toContain(
      '  List the same decisions for PROD-7 in a "## Decisions the run made"',
    );
    expect(block).toContain('  section of the BODY of the session pull request.');
  });

  it('a decision card records before publish_decision_page and lists them in its report', () => {
    const block = blockOf(assembleDispatchPrompt(source(DECISION_CARD)).prompt);
    expect(block).toContain('before publish_decision_page,');
    expect(block).toContain('  List the same decisions in your FINISHED report.');
    expect(block).not.toContain('pull request');
  });

  it('a MANUAL item has no such section — a person does it, and there is no run to record on', () => {
    const prompt = assembleDispatchPrompt(source({ type: 'manual', executor: 'human' })).prompt;
    expect(prompt).not.toContain(HEADING);
  });

  it('names the "decisions" file route ONLY to a runner that declares it posts them', () => {
    const route = '"decisions" beside "model"';
    const withBoth = blockOf(
      assembleDispatchPrompt(source({ runnerPostsAgentReport: true, runnerPostsDecisions: true }))
        .prompt,
    );
    expect(withBoth).toContain(route);
    expect(withBoth).toContain(
      '         {"model": "<as above>", "decisions": [{"planSaid": "…", "chose": "…", "why": "…", "alternatives": "…"}]}',
    );
    // A CLI that posts the other findings but predates decisions would drop them.
    for (const over of [
      { runnerPostsAgentReport: true },
      { runnerPostsDecisions: true },
      {},
    ] as Partial<DispatchPromptSource>[]) {
      expect(blockOf(assembleDispatchPrompt(source(over)).prompt)).not.toContain(route);
    }
  });

  it('leaves BUILD THROUGH, STOP and FOUND A DEFECT byte-identical', () => {
    // The block is self-contained: removing it gives back exactly the prompt without it.
    for (const over of [
      {},
      DECISION_CARD,
      { runnerPostsAgentReport: true },
    ] as Partial<DispatchPromptSource>[]) {
      const prompt = assembleDispatchPrompt(source(over)).prompt;
      const outcome = prompt.slice(prompt.indexOf('THE CARD IS WRONG — its premise is false'));
      expect(outcome).not.toContain(HEADING);
      expect(outcome).not.toContain('decisions');
    }
  });
});
