import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_GATE_HANDLERS,
  UNREGISTERED_GATE_KINDS,
  handlerFor,
  isRegisteredGateKind,
} from '@/lib/approvalGates/registry';
import { ApprovalGateKindUnregisteredError } from '@/lib/approvalGates/errors';
import type { ApprovalGateKind } from '@/generated/prisma/client';

// THE REGISTRY'S TOTALITY (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md §1).
//
// The card's acceptance criterion is that the registry *"is typed over the
// `ApprovalGateKind` enum and FAILS TO COMPILE if a member has no handler —
// asserted by a type test"*. A runtime test cannot assert that: it can only
// observe what the compiler already let through. So this file does both halves,
// and they are different claims:
//
//   · the RUNTIME half — every kind is classified exactly once, the registered
//     one dispatches, and an unregistered one is a NAMED refusal rather than an
//     `undefined` handler;
//   · the COMPILE-TIME half — a real `tsc` run over a file that removes a
//     handler, asserting it FAILS. That is the only way to test a negative about
//     the type system, and without it the criterion is discharged by a comment.

// The members of the Prisma enum, written out. A LITERAL on purpose: this
// is the list the registry must be total over, and deriving it from the same
// type the registry derives from would assert that type equals itself.
const ALL_KINDS = [
  'design_result',
  'decision_approval',
  'pull_request_approval',
  'pull_request_merge',
  'acceptance_result',
  // Story MOTIR-4914 · MOTIR-5891: a person PICKS one of a choice work item's options.
  'decision_choice',
  // Story MOTIR-5871 · MOTIR-5954: a person CONFIRMS or overturns a `human` decision.
  'decision_confirmation',
  // Story MOTIR-6012 · MOTIR-6032: a person approves or declines a PLAN — no card.
  'plan_approval',
  // Story MOTIR-1626 · MOTIR-6818: the REVIEW AGENT's question (ADR §12) — a NOT-YET hole
  // until MOTIR-6819 registered its handler.
  'agent_review',
  // Story MOTIR-7460 · MOTIR-7474: a manual card a run reached, waiting on a person.
  'manual_work',
  'planning_session',
] as const satisfies readonly ApprovalGateKind[];

describe('the approval-gate registry — totality at runtime', () => {
  it('classifies every kind exactly once: registered, or a declared hole', () => {
    const registered = Object.keys(APPROVAL_GATE_HANDLERS);
    const unregistered = [...UNREGISTERED_GATE_KINDS];

    expect([...registered, ...unregistered].sort()).toEqual([...ALL_KINDS].sort());
    // Disjoint — a kind cannot be both, which is what makes "exactly once" true.
    expect(registered.filter((k) => unregistered.includes(k as never))).toEqual([]);
  });

  it('registers `design_result`, `decision_approval`, `acceptance_result` and `pull_request_approval`, and NOT the retired merge kind', () => {
    expect(Object.keys(APPROVAL_GATE_HANDLERS)).toEqual([
      'design_result',
      'decision_approval',
      'pull_request_approval',
      'acceptance_result',
      'decision_choice',
      'decision_confirmation',
      // MOTIR-6035 (Story MOTIR-6012): the PLAN gate — Approve and Decline, no card.
      'plan_approval',
      // MOTIR-6819 (Story MOTIR-1626): the REVIEW AGENT's gate (ADR §12).
      'agent_review',
      // MOTIR-7474 (Story MOTIR-7460): MANUAL WORK — Mark done, no Request changes.
      'manual_work',
      'planning_session',
    ]);
    expect(isRegisteredGateKind('manual_work')).toBe(true);
    expect(isRegisteredGateKind('agent_review')).toBe(true);
    expect(isRegisteredGateKind('design_result')).toBe(true);
    expect(isRegisteredGateKind('plan_approval')).toBe(true);
    // MOTIR-5954 (Story MOTIR-5871): the CONFIRM gate — Confirm and Overturn.
    expect(isRegisteredGateKind('decision_confirmation')).toBe(true);
    // MOTIR-5891 (Story MOTIR-4914): the CHOICE gate — its verbs are its options.
    expect(isRegisteredGateKind('decision_choice')).toBe(true);
    // MOTIR-5676 (Story MOTIR-4907): the DECISION gate left the holes it was declared in.
    expect(isRegisteredGateKind('decision_approval')).toBe(true);
    expect(isRegisteredGateKind('pull_request_approval')).toBe(true);
    // MOTIR-4950: a story's acceptance receipt joins the contract (§1's MOTIR-5787 amendment).
    expect(isRegisteredGateKind('acceptance_result')).toBe(true);
    // Bug MOTIR-5603 · MOTIR-5616: registered by MOTIR-4793, retired here. A card holds
    // ONE approve-to-merge gate, so the per-pull-request kind has no producer, no
    // decider and no surface — and a registry entry for it would promise all three.
    expect(isRegisteredGateKind('pull_request_merge')).toBe(false);
  });

  it('leaves ONE declared hole — the RETIRED merge kind', () => {
    // `plan_approval` was a NOT-YET here from MOTIR-6032 until MOTIR-6035 registered its
    // handler (ADR `approval-gates.md` §11), so it left the list. `agent_review` is the
    // same shape: MOTIR-6818 added the enum value, MOTIR-6819 registered the handler and
    // took it off this list.
    expect([...UNREGISTERED_GATE_KINDS]).toEqual(['pull_request_merge']);
    // ⚠️ `decision_approval` WAS THE OTHER HOLE — unbuilt, owned by MOTIR-4907 — until
    // MOTIR-5676 built it. `pull_request_merge` is a different kind of hole: it was built
    // (MOTIR-4793), raised real gates, and was WITHDRAWN by MOTIR-5616 — nothing owns it
    // and nothing will register it again. The enum keeps the value because the rows
    // MOTIR-5614 superseded still reference it; the registry is where a kind stops being
    // live.
  });

  it('a registered kind dispatches to a handler carrying the full contract', () => {
    const handler = handlerFor('design_result');
    expect(typeof handler.resolveSubject).toBe('function');
    expect(typeof handler.routeTo).toBe('function');
    expect(typeof handler.approve).toBe('function');
    expect(typeof handler.requestChanges).toBe('function');
    // ADR §2's amendment: the design gate keeps `work_item:edit` as its FLOOR,
    // with the relationship rule applied on top of it by the door.
    expect(handler.permission).toBe('work_item:edit');
    // ADR §1's table: which status transition the gate OWNS. An intent, never a
    // key — the door resolves it against the project's own workflow.
    expect(handler.statusIntent).toEqual({ key: 'done', category: 'done' });
  });

  it('an unregistered kind is a NAMED refusal, never an undefined handler', () => {
    // Unreachable through the product today — nothing creates a gate of an
    // unregistered kind — but a row can carry one without any source file being
    // wrong (a fixture, a migration, a half-landed sibling). The honest answer
    // to that row is a refusal that names the kind; `undefined.approve(...)` is
    // a `TypeError` that sends the next reader to the wrong file.
    for (const kind of UNREGISTERED_GATE_KINDS) {
      expect(isRegisteredGateKind(kind)).toBe(false);
      expect(() => handlerFor(kind)).toThrow(ApprovalGateKindUnregisteredError);
      expect(() => handlerFor(kind)).toThrow(kind);
    }
  });
});

describe('the approval-gate registry — totality at COMPILE time', () => {
  // ⚠️ WHY A REAL `tsc` RUN. Every other assertion in this file observes what the
  // compiler ALREADY accepted, which cannot distinguish "the registry is total"
  // from "the registry happens to be total today and nothing would stop it
  // drifting". The criterion is about the BUILD FAILING, so the test has to run
  // a build.
  //
  // It compiles a tiny throwaway module against the repo's own paths, so it is
  // testing the real types rather than a copy of them. It was ~2–4 s when it was
  // written; the probe's import graph now reaches ~5,000 files, and the same
  // `tsc -p` measures ~37 s on main and on the MOTIR-10236 branch alike (check
  // time ~30 s). On a loaded CI shard that crossed the old 60 s budget twice in a
  // row, so the budget is 180 s — what is measured is still the build failing.
  it('promoting a kind into the registered set FAILS the build until its handler exists', () => {
    // The probe lives INSIDE the repo (and is removed in `finally`) so its
    // tsconfig can `extends` the repo's own base — the `paths` mapping cannot be
    // passed on the command line (TS6064), and re-declaring it would test a copy
    // of the config rather than the config.
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.tsprobe-'));
    try {
      const probe = path.join(dir, 'probe.ts');
      fs.writeFileSync(
        probe,
        [
          "import type { GateHandler } from '@/lib/approvalGates/registry';",
          "import { designResultGateHandler } from '@/lib/approvalGates/designResultHandler';",
          '',
          '// The registry as it would stand if `decision_approval` were promoted',
          '// into the registered set WITHOUT anybody writing its handler. This is',
          '// the exact edit a future card makes first, and it must not compile.',
          "type PromotedKind = 'design_result' | 'decision_approval';",
          'export const HANDLERS: Record<PromotedKind, GateHandler> = {',
          '  design_result: designResultGateHandler,',
          '};',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: '../tsconfig.base.json',
          compilerOptions: { noEmit: true, composite: false, incremental: false },
          include: ['probe.ts'],
        }),
      );

      let failed = false;
      let output = '';
      try {
        execFileSync(
          'node',
          [
            path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
            '-p',
            path.join(dir, 'tsconfig.json'),
          ],
          { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (err) {
        failed = true;
        output = String((err as { stdout?: string }).stdout ?? '');
      }

      expect(failed).toBe(true);
      // Not merely "some error": the error must be the MISSING HANDLER, named.
      // A probe that failed for an unrelated reason would pass a bare
      // `expect(failed).toBe(true)` while proving nothing.
      expect(output).toMatch(/decision_approval/);
      expect(output).toMatch(/TS2741|TS2739|is missing.*propert/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
