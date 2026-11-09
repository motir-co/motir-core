import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVAL_GATE_HANDLERS, UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';

// STORY MOTIR-4778's OWN GATE — the ONE-LANGUAGE guards (Subtask MOTIR-4796).
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHY IT IS NOT A SECOND COPY OF THE UNIT TESTS.
// Every card in this story shipped a correct piece and its own units to prove
// it. What no single card can assert is the property the STORY claims:
// **approving means ONE thing.** That property is about the relationship
// BETWEEN the pieces, so it is only checkable from outside all of them — which
// is this file, and nowhere else.
//
// Each guard below closes a different way the claim decays, and each is
// STRUCTURAL rather than behavioural on purpose. An appearance test passes on
// two components that agree today and says nothing about the day they diverge;
// a test that drives the door proves the door works and says nothing about a
// second door existing beside it. So these read the SOURCE the way a reviewer
// would — the `planChangeArchitecture` / `render-single-source` pattern — and
// they fail on the arrival of a second thing, which is the event that matters.
//
//   1 · ONE CONTROL. The approval frame is a shared, composable component:
//       kind-agnostic in its own source, with everything kind-specific arriving
//       as props, and every surface that renders a gate rendering THAT module.
//   2 · ONE DOOR. A gate's DECISION state has exactly one writer, and the
//       non-decision writers are DECLARED here with their call sites.
//   3 · REGISTRY TOTALITY, the half the shipped probe does not cover: a NEW
//       member of the enum fails the build.
//
// ⚠️ GUARD 3 IS DELIBERATELY THE SECOND HALF OF A PAIR.
// `tests/approval-gate-registry.test.ts` (MOTIR-4790) already runs a real `tsc`
// probe for the registry's OTHER compile-time guarantee — *promoting* a kind
// into the registered set fails until its handler exists. Re-writing that here
// would be re-covering what a code subtask's units already prove, which this
// card is told not to do. The guarantee with no probe was the first one the
// registry's own header claims — *"A NEW ENUM MEMBER FAILS THE BUILD"* — and
// that is the one below.

const ROOT = process.cwd();

/** Every gate kind, sourced from the registry rather than re-typed. The
 *  registry's own `_KindsAreExhaustive` assertion is what makes this total over
 *  the Prisma enum, so a fifth kind joins this list by existing. */
const ALL_GATE_KINDS: readonly string[] = [
  ...Object.keys(APPROVAL_GATE_HANDLERS),
  ...UNREGISTERED_GATE_KINDS,
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * A file with its comments stripped.
 *
 * ⚠️ EVERY GUARD BELOW ASSERTS THE ABSENCE OF SOMETHING, and these files
 * discuss that very something at length in prose — the service's own header
 * names `approvalGateRepository.decide`, the control's header names
 * `design_result`. Matching raw source would make each guard fail on its
 * subject's documentation, and the reflex repair (delete the comment) removes
 * the best explanation in the file. So the guards read CODE.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `app` + `components` + `lib`, repo-relative — the product surface the guards
 *  quantify over. Tests are deliberately outside it: a fixture may name a kind
 *  or build a gate row, and that is not a second vocabulary. */
const SOURCE_FILES: readonly string[] = ['app', 'components', 'lib']
  .flatMap((d) => collectSourceFiles(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f));

const CONTROL = 'components/approvals/ApprovalGateControl.tsx';

describe('ONE CONTROL — the approval frame is SHARED and COMPOSABLE (MOTIR-4796)', () => {
  // ⚠️ THIS GUARD IS THE AMENDED ONE, AND THE AMENDMENT MADE IT STRONGER.
  // The card as written asked for component IDENTITY across three surfaces —
  // the design-result panel, the Development section and the Approvals row.
  // MOTIR-4778's split moved two of those to sibling stories, so this build has
  // exactly ONE production render site, and "two subjects render the same
  // module" is not assertable here.
  //
  // That is not a weaker property to settle for; it is the STRONGER half of the
  // pair. Two call sites rendering one component is a fact about today that a
  // third call site can falsify. A component that is kind-agnostic BY
  // CONSTRUCTION — no kind in its source, everything kind-specific arriving as
  // data — is a property no later kind can break without breaking this guard.
  // Identity across surfaces then follows from it rather than being checked
  // beside it.

  it('names NO gate kind in its own code — a kind reaches it only as data', () => {
    const code = codeOf(CONTROL);
    const named = ALL_GATE_KINDS.filter((kind) => code.includes(kind));
    // A kind literal in the frame is the frame growing knowledge of one kind,
    // which is the exact shape ADR §1's registry exists to keep out of the
    // generic half. The remedy is a prop, never a branch.
    expect(named, `the shared approval frame branches on ${named.join(', ')}`).toEqual([]);
  });

  it('imports nothing kind-specific — no handler, no subject repository, no service', () => {
    const code = codeOf(CONTROL);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const offending = imports.filter(
      (spec) =>
        /designResult|designEvidence|pullRequest/i.test(spec) ||
        spec.startsWith('@/lib/services/') ||
        spec.startsWith('@/lib/repositories/'),
    );
    // The second clause is the client/server boundary the DTO's own note
    // records: a `'use client'` module importing the service layer compiles,
    // survives SSR and then fails in the browser. Both failures have the same
    // remedy — the frame takes data, not sources.
    expect(offending, `the frame imports ${offending.join(', ')}`).toEqual([]);
  });

  it('takes EVERY kind-specific thing as a prop — the slots ADR §1 promises', () => {
    const code = codeOf(CONTROL);
    const props = code.slice(code.indexOf('interface ApprovalGateControlProps'));
    // `port` is band 2 (the subject, rendered) and `verbs` is band 3 (the verb
    // SET, as data — a pair is one case, not the shape). Those two are what
    // make a third kind "a row in the enum, a handler, and a renderer" rather
    // than a second approval feature.
    for (const slot of [
      'kindLabel',
      'subjectMeta',
      'port',
      'verbs',
      'consequence',
      'confirmConsequences',
    ]) {
      expect(props, `the frame lost its \`${slot}\` slot`).toMatch(
        new RegExp(`^\\s*${slot}[?]?:`, 'm'),
      );
    }
  });

  it('is rendered by EVERY surface that renders a gate — no second control', () => {
    // THE POPULATION IS DERIVED, NOT LISTED. Any renderable module that handles
    // an `ApprovalGateDTO` is a surface that shows somebody a gate; each must
    // render the shared frame rather than its own markup. When
    // `pull_request_approval` lands, its section joins this population by
    // existing and is held to the same rule with no edit here — which is the
    // whole point of deriving it.
    const gateSurfaces = SOURCE_FILES.filter(
      (f) => f.endsWith('.tsx') && f !== CONTROL && codeOf(f).includes('ApprovalGateDTO'),
    );
    // Vacuity check: this guard is worthless if the population is empty, and an
    // empty population is exactly what a rename would produce.
    expect(gateSurfaces.length).toBeGreaterThan(0);

    // A KIND FRAME (MOTIR-5896) is a kind's port and verb set wrapped around the
    // shared control — `ChoiceGateFrame` holds the choice's selection and derives its
    // verbs from it. A surface may render one instead of the control directly, and
    // each kind frame is itself held to rendering the control, so the rule is the
    // same rule one hop further out rather than an exemption from it. `DecisionConfirmGateFrame`
    // (MOTIR-5960) is the second: the decision's sections and its Confirm · Overturn verbs.
    const KIND_FRAMES = [
      'components/approvals/ChoiceGate.tsx',
      // The decision's confirm port and its Confirm · Overturn verbs (MOTIR-5960).
      'components/approvals/DecisionConfirmGate.tsx',
      // The manual-work port — the to-do list read-only, Guide me through and Mark done
      // (MOTIR-7478).
      'components/approvals/ManualWorkGate.tsx',
    ];
    for (const frame of KIND_FRAMES) {
      expect(codeOf(frame), `${frame} is a kind frame that does not render the control`).toContain(
        "from '@/components/approvals/ApprovalGateControl'",
      );
    }
    for (const file of gateSurfaces) {
      const code = codeOf(file);
      const rendersTheFrame =
        code.includes("from '@/components/approvals/ApprovalGateControl'") ||
        KIND_FRAMES.some((frame) => code.includes(`from '@/${frame.replace(/\.tsx$/, '')}'`));
      expect(rendersTheFrame, `${file} renders a gate without the shared frame`).toBe(true);
    }
  });
});

describe('ONE DOOR — a gate DECISION has exactly one writer (MOTIR-4796)', () => {
  // ⚠️ THE CARD SAID "no gate's `state` is written anywhere but
  // `approvalGatesService.decide`", AND THAT SENTENCE IS FALSE OF SHIPPED CODE
  // — for two reasons that are both correct, which is why this guard states the
  // property at the altitude the claim actually lives at.
  //
  // A gate's `state` column is written by THREE things, and only one of them is
  // a decision:
  //
  //   · `create` writes `awaiting` — asking the question;
  //   · `supersedeAwaitingByWorkItem` writes `superseded` — WITHDRAWING the
  //     question (ADR §6b), which carries no actor, no authority and no note
  //     precisely so the audit can never read it as somebody's answer;
  //   · `decide` writes `approved` / `changes_requested` — the DECISION.
  //
  // The story's claim is about the third. A guard written to the card's literal
  // words would have to either fail on `main` or quietly exempt the supersede
  // path, and a quiet exemption is how a real second writer gets in later
  // wearing the same excuse. So the exemptions are DECLARED, with their single
  // call sites asserted — the registry's own *"the holes are declared, not
  // left"* discipline, applied to writers instead of kinds.

  const REPO = 'lib/repositories/approvalGateRepository.ts';
  const DOOR = 'lib/services/approvalGatesService.ts';

  /** The writes that are NOT decisions, each with the production callers it is
   *  allowed. Adding a row — or a caller — here is a deliberate act a reviewer
   *  sees.
   *
   *  ⚠️ AMENDED ON THE RECORD — MOTIR-5611 · MOTIR-5613, 2026-09-16. This list used
   *  to say: *"The merge gate (MOTIR-5515) is the second kind to ASK and WITHDRAW:
   *  `mergeGates.ts` raises one per green pull request and supersedes it BY SUBJECT,
   *  because a card's two pull requests are two independent questions."* A card now
   *  holds ONE approve-to-merge gate over its whole delivery set, so `mergeGates.ts`
   *  raises nothing, `supersedeAwaitingBySubject` has no callers left and is deleted,
   *  and the row for it is gone from this list rather than left with an empty
   *  `callers` array — a declared writer nobody calls is not a hole worth keeping
   *  open. */
  const DECLARED_NON_DECISION_WRITERS = [
    {
      method: 'create',
      writes: 'awaiting',
      // MOTIR-5482: the approve-and-merge gate is the third kind to ASK — one per card over
      // its delivery set, raised by `pullRequestApprovalGates.ts` in the promotion.
      // ⚠️ AMENDED ON THE RECORD — MOTIR-5663, 2026-09-17. The list SHRANK by one and
      // gained one, and the trade is the point of the level: `gateSetFor.ts` is now the
      // single place a gate row is created from the predicate's answer, and
      // `pullRequestApprovalGates.ts` is a thin wrapper over it. `designEvidenceService`
      // stays a declared caller because the publish creates the design gate inside its
      // own evidence transaction, over the row it has just inserted.
      // MOTIR-5789, 2026-09-19: a receipt publish raises the story's `acceptance_result`
      // gate through `reconcileGatesFor` (the predicate), so it adds NO caller here —
      // MOTIR-4950 declared `acceptanceEvidenceService` for one commit and this removes it.
      callers: ['lib/services/designEvidenceService.ts', 'lib/services/gateSetFor.ts'],
    },
    {
      method: 'supersedeAwaitingByWorkItem',
      writes: 'superseded',
      // ⚠️ AMENDED ON THE RECORD — MOTIR-5662, 2026-09-17. The declared second
      // caller was `githubPullRequestService.ts` (MOTIR-5534, `design-result.md`
      // AMENDMENT 4 Q8): linking an OPEN pull request withdrew an awaiting design
      // question, because that card's pull requests were taken to carry the
      // decision. They did not — the merge gate then refused on the run target,
      // and the card held no question at all (MOTIR-5652). AMENDMENT 6 Q1/Q7
      // retire the path, so the row is REMOVED from this list rather than left
      // with a caller nobody calls.
      // MOTIR-5482: the approve-and-merge gate is withdrawn BY CARD, because its subject is
      // the card's whole delivery set — a moved head, a closed member or a set change.
      // MOTIR-4950: a newer RECEIPT retires the story's awaiting acceptance question with
      // cause `republished` — the same write, and the same lock order, as a design
      // republish (the MOTIR-5787 amendment, point 5).
      //
      // AMENDED ON THE RECORD — MOTIR-5677, 2026-09-19 (`approval-gates.md` §8's FIFTH
      // AMENDMENT, clause 4): the DECISION gate is withdrawn when a capture shows a push
      // CHANGED the decision document's blob — `head_moved`, product-written, no actor.
      // It lives with the capture because that is the only moment the new version is
      // known; the decision it withdraws is still made only through the door.
      //
      // AMENDED ON THE RECORD — MOTIR-5891, 2026-09-21 (§1's MOTIR-5887 amendment,
      // point 3): the CHOICE question is withdrawn when the body's stamp moves
      // (`republished`), when the body stops parsing, or when the item stops being a
      // choice (`withdrawn`). Product-written, no actor — its one raiser owns it.
      callers: [
        // MOTIR-10731: a person's REQUEST CHANGES on a story run's approve-and-merge gate withdraws the
        // story's awaiting acceptance question, cause `pulled_back` — the video is the
        // evidence for that merge, so it closes with it. Product-written, no actor, never
        // a decision; the merge gate's own handler is its one writer, in the door's tx.
        'lib/approvalGates/pullRequestApprovalHandler.ts',
        'lib/services/acceptanceEvidenceService.ts',
        // MOTIR-6819 (`approval-gates.md` §12.5): switching the review agent OFF withdraws
        // every awaiting `agent_review` in the project, cause `review_agent_disabled` —
        // product-written, no actor, never a decision. The switch is its one writer.
        'lib/services/approvalGateSettingsService.ts',
        'lib/services/choiceGateService.ts',
        // MOTIR-5954: the CONFIRM question's raiser withdraws its own stale question —
        // a moved stamp, a broken body, an executor flipped off `human`.
        'lib/services/decisionConfirmationGateService.ts',
        'lib/services/decisionDocumentCaptureService.ts',
        // MOTIR-7432 (`approval-gates.md` §8 NINTH AMENDMENT, clause 3): publishing a NEW
        // page version as a card's decision retires the awaiting decision question, cause
        // `republished` — the design republish's write, product-written, no actor. The
        // new question is then raised by the predicate (`reconcileGatesFor`), so the
        // publish adds no `create` caller.
        'lib/services/decisionPageService.ts',
        'lib/services/designEvidenceService.ts',
        // MOTIR-6595 (`approval-gates.md` §4 FIFTH AMENDMENT, point 4): the operator
        // convergence withdraws a gate the OLD rule re-asked from a queue failure, with
        // cause `queue_failed` — product-written, no actor, never a decision.
        'lib/services/ejectedCardConvergenceService.ts',
        // MOTIR-6971 (`approval-gates.md` §8's EIGHTH AMENDMENT): the merge question is
        // withdrawn from a card that is not `in_review` (`withdrawMergeQuestionOffReview`,
        // cause `pulled_back`) — product-written, no actor, never a decision.
        'lib/services/gateSetFor.ts',
        // MOTIR-7474 (`manual-work-gate.md` §6): the MANUAL-WORK question is withdrawn when
        // its card stops being manual (`no_longer_manual`) or is closed by a write nobody
        // decided (`closed_without_decision`) — product-written, no actor, never a decision.
        'lib/services/manualWorkGateService.ts',
        'lib/services/pullRequestApprovalGates.ts',
        // MOTIR-10333 (`approval-gates.md` §12.14): an agent's SEND-BACK withdraws the
        // card's awaiting approve-and-merge gate, cause `agent_changes_requested` —
        // product-written, no actor, never a decision. The verdict door is its one writer.
        'lib/services/reviewVerdictService.ts',
      ],
    },
    // AMENDED ON THE RECORD — MOTIR-5527, 2026-09-14 (ADR `approval-gates.md` §6d
    // AMENDMENT, rule 6). A hand move that pulls the work back out of review, or
    // cancels it, WITHDRAWS every question on the item. That is a product-written
    // `superseded`, exactly like the publish path's: no actor, no note, no
    // decision — so it is a declared NON-decision writer, not a second door. It is
    // a sibling method rather than a second caller of the one above, because it
    // retires EVERY kind at once, and its one caller is the status funnel
    // (`applyStatusTransition`), which every status door already passes through.
    // AMENDED ON THE RECORD — MOTIR-5532, 2026-09-14 (ADR §6d AMENDMENT, rule 7).
    // Entering review ASKS AGAIN: a card returning to `in_review` whose current
    // subject has no awaiting or approved gate gets a fresh `awaiting` one. That
    // is a product-written question, like the publish path's `create` — never a
    // decision — raised by the review-entry seam in `approvalGatesService`. A
    // sibling method rather than a second `create` caller, because it must absorb
    // a concurrent double raise INSIDE a status transition, which a caught unique
    // violation cannot do without aborting that transaction.
    {
      method: 'createAwaitingIfAbsent',
      writes: 'awaiting',
      // MOTIR-5891: the CHOICE question's one raiser, inside the work item's own write —
      // a create, a body or type edit, or its last blocker landing — where a concurrent
      // double raise must be "already raised", not an aborted transaction.
      // MOTIR-5954: the CONFIRM question's one raiser, on the same three call sites.
      callers: [
        'lib/services/approvalGatesService.ts',
        'lib/services/choiceGateService.ts',
        'lib/services/decisionConfirmationGateService.ts',
        // MOTIR-7474 (`manual-work-gate.md` §2): the MANUAL-WORK question's one raiser,
        // inside a run's leg write; a second run, or a redelivery, is "already raised".
        'lib/services/manualWorkGateService.ts',
      ],
    },
    {
      method: 'supersedeAllAwaitingByWorkItem',
      writes: 'superseded',
      // …and, since MOTIR-7109, archiving a card, which abandons the work exactly as a
      // move to Cancelled does but never reaches the status funnel.
      callers: ['lib/approvalGates/withdrawOnArchive.ts', 'lib/services/workItemsService.ts'],
    },
    // Story MOTIR-6070 · MOTIR-6423 (`docs/decisions/design-refusal-verdict.md` §2): a
    // refusal that SENDS THE WORK BACK to To do withdraws the card's OTHER awaiting
    // questions as `pulled_back` — the pull-back rule's own product-written `superseded`,
    // no actor, no note, no decision. A sibling of the method above, because it runs
    // INSIDE the decide door before the deciding write and must EXCLUDE the gate being
    // decided (still `awaiting` at that moment). Its one caller is the shared gate-owned
    // return to To do; the refusal itself is still recorded only by the door.
    {
      method: 'supersedeOtherAwaitingByWorkItem',
      writes: 'superseded',
      // …and, since MOTIR-6503, a story run's acceptance refusal, which withdraws the
      // story's merge gate WITHOUT a return (no acceptance refusal moves a status).
      callers: [
        'lib/approvalGates/acceptanceResultHandler.ts',
        'lib/approvalGates/returnToTodo.ts',
        // …and, since MOTIR-7109, the funnel's move to Cancelled made BY the decide door
        // (an overturn), which withdraws every other question but the one being decided.
        'lib/services/workItemsService.ts',
      ],
    },
    // Story MOTIR-6012 (ADR `approval-gates.md` §11.7): the CARD-LESS plan gate's raise
    // and supersede, keyed on `(subjectId, kind)` because a plan gate has no work item.
    // Product-written questions and withdrawals, never decisions — the plan's own
    // approve and decline go through the door. MOTIR-6034 added the two writes;
    // MOTIR-6036 declares their ONE caller: `planGateService`, which the plan's plain
    // status writers (markPlanned, the drift writers, the lazy stale backstop and the
    // last-withdrawal discard) call inside their own transaction, plan lock first.
    {
      method: 'createCardlessAwaitingIfAbsent',
      writes: 'awaiting',
      // …and the `planning_session` gate's raise (MOTIR-7913), the same card-less shape.
      callers: ['lib/services/planGateService.ts', 'lib/services/planningSessionGateService.ts'],
    },
    {
      method: 'supersedeAwaitingCardlessBySubject',
      writes: 'superseded',
      callers: ['lib/services/planGateService.ts', 'lib/services/planningSessionGateService.ts'],
    },
    // Bug MOTIR-7146: a gate whose SUBJECT no longer resolves is withdrawn when a read
    // observes it — `subject_gone`, product-written, no actor, never a decision. By ID,
    // because the subject is the gate's own and a card's other questions may be live. Its
    // one caller is the service's withdraw, which re-reads the subject under the lock
    // through the kind's handler first.
    {
      method: 'supersedeAwaitingById',
      writes: 'superseded',
      callers: ['lib/services/approvalGatesService.ts'],
    },
    {
      method: 'setReviewUnavailableReason',
      // MOTIR-6820 (Story MOTIR-1626; `approval-gates.md` §12.6): why an AWAITING
      // `agent_review` gate's review could not run — written on a refused start or a run
      // that ended with no verdict, cleared by *Review again*. It moves no state and names
      // no decider: the gate stays `awaiting`, so it is a note on the open question, never a
      // decision.
      writes: 'awaiting',
      callers: [
        'lib/services/agentReviewStartService.ts',
        // MOTIR-10332 (`approval-gates.md` §12.10): switching the review source to `own`
        // CLEARS the reason on each awaiting review — could-not-run is hosted-only (§12.6).
        // The gate stays `awaiting`; nothing is decided.
        'lib/services/approvalGateSettingsService.ts',
        'lib/services/hostedRunService.ts',
      ],
    },
  ] as const;

  it('routes every DECISION through `approvalGatesService.decide` — one call site', () => {
    const callers = SOURCE_FILES.filter((f) =>
      codeOf(f).includes('approvalGateRepository.decide('),
    );
    expect(callers).toEqual([DOOR]);
  });

  it('writes the `approval_gate` table NOWHERE but the repository leaf', () => {
    // ⚠️ THE PREDICATE IS THE PRISMA WRITE, NOT THE STATE LITERAL, and the
    // first cut of this guard got that wrong in a way worth recording: it
    // matched `state: 'approved'` as source text and fired on two TYPE
    // POSITIONS — a constructor parameter in `errors.ts` and the `data`
    // parameter of `decide` itself — while matching the actual write not at
    // all, because the repository passes `data` through opaquely. A guard keyed
    // on how a value is SPELLED is falsifiable by spelling it differently; one
    // keyed on the write reaches a second writer whatever it writes.
    const writers = SOURCE_FILES.filter((f) =>
      /\bapprovalGate\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\b/.test(
        codeOf(f),
      ),
    );
    // A service, a route, a job or a server action reaching the table directly
    // would be a second door with none of this door's obligations — no lock, no
    // re-read, no actor gate, no audit set — and CLAUDE.md's 4-layer rule
    // already forbids it. Here it is also the mechanism the story's claim rests
    // on, so it is asserted where the claim is made.
    expect(writers).toEqual([REPO]);
  });

  it('keeps each DECLARED non-decision writer to its declared callers', () => {
    for (const { method, callers: declared } of DECLARED_NON_DECISION_WRITERS) {
      const callers = SOURCE_FILES.filter((f) =>
        codeOf(f).includes(`approvalGateRepository.${method}(`),
      );
      expect(callers, `\`${method}\` grew an undeclared caller`).toEqual([...declared]);
    }
  });

  it('lets NO new writer in unnoticed — the repository’s own writes are COUNTED', () => {
    // THE BACKSTOP, and the guard this file would be incomplete without. The
    // three assertions above each name a write we already know about; a FOURTH
    // one — a new repository method, reached by a new caller — satisfies every
    // one of them by not being mentioned in any. Counting is what closes that,
    // and it fails loudly on the one event that matters: the table growing a
    // way to be written that nobody has classified as a decision or declared as
    // not one.
    const repoWrites = [
      ...codeOf(REPO).matchAll(
        /\bapprovalGate\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\b/g,
      ),
    ].length;
    expect(
      repoWrites,
      'the gate repository grew a write this guard does not classify — ' +
        'declare it as a non-decision writer, or route it through the decide door',
    ).toBe(DECLARED_NON_DECISION_WRITERS.length + 1);
  });
});

describe('REGISTRY TOTALITY — a NEW enum member fails the build (MOTIR-4796)', () => {
  // ⚠️ WHY A REAL `tsc` RUN, and why THIS half. Every type-level assertion in
  // `registry.ts` observes what the compiler already accepted, which cannot
  // tell "the classification is total" from "it happens to be total today". The
  // criterion is about the BUILD FAILING, so the test runs a build — the same
  // reasoning, and the same mechanics, as the promotion probe MOTIR-4790
  // shipped in `tests/approval-gate-registry.test.ts`.
  //
  // What differs is WHICH guarantee is probed. That one edits the REGISTERED
  // set; this one widens the ENUM, which is the first thing a new kind's
  // migration does and the point at which the classification must stop
  // compiling. The probe imports the REAL `UNREGISTERED_GATE_KINDS` and the
  // REAL `RegisteredGateKind`, and checks them against the enum as it would
  // stand with one member added — so the only thing simulated is the widening
  // itself.

  it('a NEW `ApprovalGateKind` breaks the classification until somebody files it', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, '.tsprobe-kind-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'probe.ts'),
        [
          "import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';",
          "import type { RegisteredGateKind } from '@/lib/approvalGates/registry';",
          "import type { ApprovalGateKind } from '@/generated/prisma/client';",
          '',
          '// The enum as a migration would leave it the moment a fifth kind is',
          '// added — before anybody has classified it as registered or as a',
          '// declared hole. The tuple and the registered set are the REAL ones.',
          // ⚠️ A kind that does NOT exist. This line used `decision_choice` until
          // MOTIR-5891 made it a real member — at which point the widening became a
          // no-op and this must-not-compile probe would have compiled silently.
          "type WidenedKind = ApprovalGateKind | 'hypothetical_new_kind';",
          'type WidenedUnregistered = Exclude<WidenedKind, RegisteredGateKind>;',
          '',
          'type AssertEqual<A, B> =',
          '  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2',
          '    ? true',
          "    : { ERROR: 'approval-gate kinds are not exhaustively classified' };",
          '',
          '// This must NOT compile: the shipped tuple cannot enumerate a member',
          '// nobody has added to it.',
          'export const proof: true = null as unknown as AssertEqual<',
          '  (typeof UNREGISTERED_GATE_KINDS)[number],',
          '  WidenedUnregistered',
          '>;',
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
            path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
            '-p',
            path.join(dir, 'tsconfig.json'),
          ],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (err) {
        failed = true;
        output = String((err as { stdout?: string }).stdout ?? '');
      }

      expect(failed).toBe(true);
      // Not merely "some error": it must be THIS error. A probe that failed for
      // an unrelated reason would satisfy a bare `expect(failed).toBe(true)`
      // while proving nothing at all.
      expect(output).toMatch(/not exhaustively classified|TS2322/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // A cold `tsc` over the registry's import graph takes ~59s on a CI Vitest
    // leg, so 60s timed out on every other run (MOTIR-10657, PR #4038). The
    // sibling probe in `approval-gate-registry.test.ts` already allows 180s.
  }, 180_000);
});
