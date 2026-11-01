import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { isReferenceAdvisory } from '@/lib/dto/workItems';
import type {
  ExecutorDto,
  WorkItemProseAdvisoryDto,
  WorkItemTypeDto,
  WorkItemValidityAdvisoryDto,
} from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { MOTIR_6236_DESIGN_CARD_CRITERIA } from '../fixtures/designCardCriteria';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { randomToken } from '../helpers/random';

// DISPATCH READS THE ADVISORIES (MOTIR-2079) — over REAL Postgres.
//
// MOTIR-1969 shipped the prose-vs-graph detector and it works. On the SEVENTH
// instance of the family it returned, unprompted and correctly,
// `{ referenced: MOTIR-2073, referencedStatus: in_review, severity:
// likely-missing-edge }` — and the card dispatched anyway, because every
// dispatch path computes readiness from EDGES alone and nothing called the
// detector. The verdict was addressed to nobody (`notes.html` #210). This suite
// pins the three consumers that now read it:
//
//   1. `dispatch_prompt` renders it into the prompt (every harness inherits it,
//      because no harness assembles its own prompt text);
//   2. the CLI warns on it (`packages/cli/test/dispatchCommand.test.ts` — the
//      client half, where the exit-code invariant is asserted);
//   3. `claim_next_ready` returns it (the planner-agent seam).
//
// ⚠️ AND the invariant that makes all three safe: READINESS IS BYTE-IDENTICAL.
// `likely-missing-edge` is a severity, never a gate. Every `readiness` assertion
// below exists to fail loudly if someone "improves" this into a blocker — which
// would falsely stop the three legitimate shapes MOTIR-1969 enumerates, and
// teach authors to write vaguer acceptance criteria to dodge it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `[label](motir:<id>)` reference token — the shipped chip form every card in
 *  this family carries, which is why extraction is a regex and not a language
 *  problem. */
const ref = (label: string, id: string) => `[${label}](motir:${id})`;

/**
 * A card body shaped EXACTLY like the MOTIR-2075 miss this work exists for: the
 * reference sits inside the card's own ACCEPTANCE CRITERIA (so it is being
 * CONSUMED, not merely mentioned), the referenced card is `in_review` (merged
 * nowhere — its substrate lives only on an open PR), and the only edge between
 * them is a `relates_to`, which readiness does not read.
 */
function cardNamingInAcceptanceCriteria(label: string, id: string): string {
  return [
    'Separate the status hues so two adjacent chips are distinguishable.',
    '',
    '## Acceptance criteria',
    '',
    `- ${ref(label, id)} added statusHueSeparation.test.ts; extend it with the new pairs.`,
    '- Every palette passes the ΔE2000 floor.',
  ].join('\n');
}

/** The same reference, in PROSE only — outside the acceptance-criteria section. */
function cardNamingInProse(label: string, id: string): string {
  return [
    `Filed after ${ref(label, id)}, which is the incident record for this defect.`,
    '',
    '## Acceptance criteria',
    '',
    '- The thing works.',
  ].join('\n');
}

async function makeItem(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string | null = null,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      // Typed so the fixture is not UNDER-AUTHORED (MOTIR-5427): a bare card
      // carries that advisory, and these suites assert on the OTHER families.
      type: 'code',
      title,
      descriptionMd,
      ...(parentId ? { parentId } : {}),
    },
    fx.ctx,
  );
}

/** Move an item to `in_review` along the legal path (there is no direct edge). */
async function toInReview(id: string, fx: WorkItemFixture): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(id, 'in_review', fx.ctx);
}

// The REFERENCE family's far ends. `advisories` is a union since MOTIR-2175 and
// three-membered since MOTIR-2903, so the families with no far end are narrowed
// out POSITIVELY rather than by "not shape" — which is what stops a new family
// being mapped for a `referenced` it does not have.
const keys = (advisories: WorkItemValidityAdvisoryDto[]) =>
  advisories.filter(isReferenceAdvisory).map((a) => a.referenced);

describe('buildDispatchProseAdvisories — the single-card resolver', () => {
  it('reports a card whose ACCEPTANCE CRITERIA name a not-done item it has no edge to', async () => {
    // The MOTIR-2075 fixture, reproduced: an AC naming an `in_review` card, with
    // only a `relates_to` between them.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Graphite in_review ramp');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Palette status hues',
      cardNamingInAcceptanceCriteria('MOTIR-2073', substrate.id),
    );
    // No explicit link is written here, and that is the point: `autoRelateWorkItemMentions`
    // ALREADY wrote a `relates_to` on create, from the same reference tokens this
    // advisory scans. That auto-written edge is exactly what made MOTIR-2075 look
    // wired while the ready set saw nothing — the card carries a real link, just
    // not the kind that gates.
    const links = await adminDb.workItemLink.findMany({ where: { fromId: card.id } });
    expect(links.map((l) => l.kind)).toEqual(['relates_to']);

    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(advisories).toEqual([
      {
        item: card.identifier,
        referenced: substrate.identifier,
        referencedStatus: 'in_review',
        severity: 'likely-missing-edge',
      },
    ]);
  });

  it('⚠️ READINESS IS UNTOUCHED — the card is ready, with no open blockers', async () => {
    // The load-bearing assertion of this whole card. `relates_to` is not a gate,
    // and the advisory does not make it one: this item dispatches.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toHaveLength(1);
    // Read through `getIssueDetail` — the SAME `readiness` shape `motir run`
    // gates on before it dispatches (`readiness.ready` / `openBlockers`).
    const { readiness } = await workItemsService.getIssueDetail(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openBlockers).toEqual([]);
  });

  it('says NOTHING once the edge is real — a blocked_by reference is exempt', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: substrate.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // The graph now says what the prose says — which is the fix, so the advisory
    // has nothing left to report. (Readiness now legitimately gates it; that is
    // the EDGE doing its job, not the advisory.)
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('says nothing about a DONE reference — the prose is history, not a dependency', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Landed');
    await toInReview(substrate.id, fx);
    await workItemsService.updateStatus(substrate.id, 'done', fx.ctx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('LANDED', substrate.id),
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('says nothing about its own ANCESTOR — naming your parent is not a dependency', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
      fx.ctx,
    );
    const card = await makeItem(
      fx,
      'Child',
      cardNamingInAcceptanceCriteria('PARENT', parent.id),
      parent.id,
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('carries ONLY the likely-missing-edge tier — a prose mention is not a dispatch warning', async () => {
    // The `advisory` tier fires on any not-done item named ANYWHERE in a body —
    // an incident record, a superseded-by pointer, an out-of-scope note. Useful
    // when a human browses the card; pure noise in front of an agent about to
    // branch. `validate_work_item` still reports both tiers; nothing is lost.
    const fx = await makeWorkItemFixture();
    const record = await makeItem(fx, 'Incident record');
    const card = await makeItem(fx, 'Consumer', cardNamingInProse('RECORD', record.id));

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
    // …and the full-tier surface still sees it, so this is a scope, not a loss.
    const validity = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(keys(validity.advisories)).toEqual([record.identifier]);
    expect(validity.advisories[0]?.severity).toBe('advisory');
  });

  it('reports EVERY unedged reference an AC names, deterministically ordered', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, 'Alpha');
    const b = await makeItem(fx, 'Beta');
    const card = await makeItem(
      fx,
      'Consumer',
      [
        'Body.',
        '',
        '## Acceptance criteria',
        '',
        `- Extends ${ref('A', a.id)} and ${ref('B', b.id)}.`,
      ].join('\n'),
    );
    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(keys(advisories)).toEqual([a.identifier, b.identifier].sort());
  });

  it('a card naming nothing costs no advisory and no crash on a null body', async () => {
    const fx = await makeWorkItemFixture();
    const bare = await makeItem(fx, 'No body at all', null);
    const plain = await makeItem(fx, 'Prose only', 'Just words, no references.');
    expect(await buildDispatchProseAdvisories(bare, fx.ctx)).toEqual([]);
    expect(await buildDispatchProseAdvisories(plain, fx.ctx)).toEqual([]);
  });

  it('reports a counted own-blocker claim only when it disagrees with the graph', async () => {
    const fx = await makeWorkItemFixture();
    const first = await makeItem(fx, 'First blocker');
    const second = await makeItem(fx, 'Second blocker');
    const stale = await makeItem(
      fx,
      'Stale count',
      'The four siblings this card is blocked_by provide the complete substrate.',
    );
    for (const blocker of [first, second]) {
      await workItemsService.linkWorkItems(
        { fromId: stale.id, toId: blocker.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }

    expect(await buildDispatchProseAdvisories(stale, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: stale.identifier,
        severity: 'likely-blocker-count-mismatch',
        claim: 'four siblings this card is blocked_by',
        claimedCount: 4,
        blockerCount: 2,
      },
    ]);

    const accurate = await makeItem(
      fx,
      'Accurate count',
      'The two siblings this card is blocked_by provide the complete substrate.',
    );
    for (const blocker of [first, second]) {
      await workItemsService.linkWorkItems(
        { fromId: accurate.id, toId: blocker.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }
    expect(await buildDispatchProseAdvisories(accurate, fx.ctx)).toEqual([]);
  });
});

describe('dispatch_prompt — the advisories reach the AGENT', () => {
  it('renders the reference, its status, and the verify-before-you-branch instruction', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(keys(dto.advisories)).toEqual([substrate.identifier]);
    expect(dto.prompt).toContain(`${substrate.identifier} (in_review)`);
    expect(dto.prompt).toContain('origin/main');
    expect(dto.prompt).toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('⚠️ dispatches all the same — readiness, workflow mode and status are untouched', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toHaveLength(1);
    expect(dto.workflowMode).toBe('per_item_pr');
    // Still a pure READ: an advisory does not claim, block, or flip anything.
    const after = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(after.status).toBe('todo');
    const { readiness } = await workItemsService.getIssueDetail(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openBlockers).toEqual([]);
  });

  it('a card with none renders no section at all — and the DTO still carries []', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeItem(
      fx,
      'Clean card',
      'Nothing referenced.\n\n## Acceptance criteria\n\n- Works.',
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toEqual([]);
    expect(dto.prompt).not.toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('the TOOL names it in the human summary as well as in the prompt', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain(`${substrate.identifier} (in_review)`);
  });
});

describe('claim_next_ready — the advisories reach the PLANNER AGENT', () => {
  /** Create a sprint holding the given items and START it. */
  async function activeSprintWith(fx: WorkItemFixture, itemIds: string[]): Promise<void> {
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await adminDb.workItem.updateMany({
      where: { id: { in: itemIds } },
      data: { sprintId: sprint.id },
    });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  }

  const structOf = (r: { structuredContent?: unknown }) =>
    r.structuredContent as { item: { key: string } | null; advisories: WorkItemProseAdvisoryDto[] };

  it('returns the claimed card’s advisories, and still claims it', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );
    await activeSprintWith(fx, [card.id]);

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const struct = structOf(res);
    expect(struct.item?.key).toBe(card.identifier);
    expect(keys(struct.advisories)).toEqual([substrate.identifier]);
    // The claim IS the status flip, advisory or not.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('in_progress');
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
  });

  it('⚠️ SELECTION is unchanged — the advisory-carrying card is picked in the same order', async () => {
    // Two ready cards, one carrying an advisory, the other clean. The pick must
    // follow rank alone; if an advisory ever demoted or skipped a card, that
    // would be a gate wearing a warning's clothes.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const flagged = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Flagged but highest',
        priority: 'highest',
        descriptionMd: cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
      },
      fx.ctx,
    );
    const clean = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        type: 'code',
        title: 'Clean but low',
        priority: 'low',
      },
      fx.ctx,
    );
    await activeSprintWith(fx, [flagged.id, clean.id]);

    const first = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(first.item?.key).toBe(flagged.identifier);
    expect(first.advisories).toHaveLength(1);

    const second = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(second.item?.key).toBe(clean.identifier);
    expect(second.advisories).toEqual([]);
  });

  it('carries an EMPTY array on the nothing-to-claim arm too — one shape for the caller', async () => {
    const fx = await makeWorkItemFixture();
    await activeSprintWith(fx, []);
    const struct = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(struct.item).toBeNull();
    expect(struct.advisories).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDERING ADVISORY AT DISPATCH (MOTIR-2175) — gate 14's third axis.
//
// The SHAPE family: a defect in what the card's own acceptance criteria ask for,
// with no second work item involved anywhere in the finding. It is
// dispatch-relevant by construction — the agent about to branch is the one who
// physically cannot discharge a criterion that turns on its own merge — so it
// rides the same never-a-blocker channel the reference family does, and every
// readiness assertion below exists for the same reason as the ones above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MOTIR-2162's body, in the shape that got through: criterion 5 reads on the
 * card's OWN merge, and it names no work item at all — which is why the
 * reference scan could never have caught it. Criterion 5 is quoted from
 * MOTIR-2164's record of the incident.
 */
function cardWithPostMergeCriterion(): string {
  return [
    'Nothing removes a tenant’s code graph — the decision this card owes.',
    '',
    '## Acceptance criteria',
    '',
    '- The ADR gains an offboarding section answering which artifacts are removed.',
    '- The decision names the order and the idempotency requirement.',
    '- The core→ai trigger is pinned as a named seam.',
    '- Every deferral it writes is a card filed in the same action.',
    "- `src/services/codeRepoService.ts`'s header block … is updated to point at the decision " +
      '**once it lands**, so the pointer does not outlive the gap.',
    '- A `docs/`-prefixed branch.',
  ].join('\n');
}

/** Create a card with an explicit work type / executor (the exemption's inputs). */
async function makeTypedItem(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string,
  fields: { type?: WorkItemTypeDto; executor?: ExecutorDto },
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd, ...fields },
    fx.ctx,
  );
}

describe('the ORDERING advisory — a card whose criterion turns on its OWN merge', () => {
  it('MOTIR-2162 REGRESSION: names criterion 5 and the phrase, with no reference in sight', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeItem(fx, 'Offboarding decision', cardWithPostMergeCriterion());

    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-ordering-violation',
        phrase: 'once it lands',
        criterionIndex: 5,
      },
    ]);
  });

  it('fires on a card that names NOTHING — the case the reference scan cannot see', async () => {
    // The load-bearing difference between the two families. This body has no
    // `motir:` token anywhere, so `bodyReferenceSeverities` is empty and the old
    // short-circuit would have returned [] before any scan ran.
    const fx = await makeWorkItemFixture();
    const card = await makeItem(
      fx,
      'Release prep',
      '## Acceptance criteria\n\n- the tag is pushed once this lands',
    );
    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(advisories.map((a) => a.kind)).toEqual(['shape']);
  });

  it('⚠️ READINESS IS UNTOUCHED — byte-identical whether or not it is emitted', async () => {
    // The same invariant the reference family carries, asserted the strict way:
    // two cards identical but for the offending criterion produce the SAME
    // readiness object.
    const fx = await makeWorkItemFixture();
    const flagged = await makeItem(fx, 'Flagged', cardWithPostMergeCriterion());
    const clean = await makeItem(
      fx,
      'Clean',
      cardWithPostMergeCriterion().replace(/ \*\*once it lands\*\*,/, ','),
    );

    expect(await buildDispatchProseAdvisories(flagged, fx.ctx)).toHaveLength(1);
    expect(await buildDispatchProseAdvisories(clean, fx.ctx)).toEqual([]);

    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(flagged.identifier)).toEqual(await readinessOf(clean.identifier));
    expect((await readinessOf(flagged.identifier)).ready).toBe(true);
    expect((await readinessOf(flagged.identifier)).openBlockers).toEqual([]);
  });

  it("EXEMPTS the release trio's CUT leg — a `deploy` card is the shape the rule ASKED for", async () => {
    // Gate 14's own remedy is to move post-merge criteria onto a deploy / human
    // card. Such a card carrying the phrase is CORRECT, not tolerated — so the
    // exemption costs no coverage, and firing here is what would train readers
    // to skip the whole advisory channel.
    const fx = await makeWorkItemFixture();
    const cut = await makeTypedItem(
      fx,
      'Cut the @motir/cli 0.1.1 release',
      [
        'The middle leg of the release trio: push the tag, watch both lanes go green.',
        '',
        '## Acceptance criteria',
        '',
        '- `cli-v0.1.1` is pushed once this lands on `main`.',
        '- Both publish lanes are green and the published image is pullable by digest.',
      ].join('\n'),
      { type: 'deploy', executor: 'human' },
    );
    expect(await buildDispatchProseAdvisories(cut, fx.ctx)).toEqual([]);
  });

  it('exempts a `human` executor on its own, and does NOT exempt a plain code card', async () => {
    const fx = await makeWorkItemFixture();
    const body = '## Acceptance criteria\n\n- verified after release';
    const human = await makeTypedItem(fx, 'Manual step', body, { executor: 'human' });
    const code = await makeTypedItem(fx, 'Code step', body, {
      type: 'code',
      executor: 'coding_agent',
    });
    expect(await buildDispatchProseAdvisories(human, fx.ctx)).toEqual([]);
    expect(await buildDispatchProseAdvisories(code, fx.ctx)).toHaveLength(1);
  });

  it('rides ALONGSIDE a reference advisory, SHAPE first, on one card', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Both defects at once',
      [
        '## Acceptance criteria',
        '',
        `- extends the helper ${ref('SUBSTRATE', substrate.id)} adds.`,
        '- the row is visible on `main`.',
      ].join('\n'),
    );
    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(advisories.map((a) => a.kind)).toEqual(['shape', undefined]);
    expect(keys(advisories)).toEqual([substrate.identifier]);
  });

  it('reaches the AGENT through dispatch_prompt — prompt, DTO and human summary', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeItem(fx, 'Offboarding decision', cardWithPostMergeCriterion());

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toHaveLength(1);
    expect(dto.prompt).toContain("A CRITERION THAT TURNS ON THIS CARD'S OWN MERGE");
    expect(dto.prompt).toContain('acceptance criterion 5 says "once it lands"');
    expect(dto.prompt).toContain('Your boundary ends at PR opened');
    // …and it still dispatches, in the same workflow mode.
    expect(dto.workflowMode).toBe('per_item_pr');

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain('acceptance criterion 5 says "once it lands"');
  });

  it('a clean card renders no ordering section at all', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeItem(
      fx,
      'Clean',
      '## Acceptance criteria\n\n- the endpoint returns 200',
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toEqual([]);
    expect(dto.prompt).not.toContain('OWN MERGE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REPO-STRADDLE ADVISORY (MOTIR-2177) — gate 1's repo column, as a
// CONTRADICTION between two things the card itself asserts.
// ─────────────────────────────────────────────────────────────────────────────

/** Connect a repo to the fixture's workspace — the candidate set the check
 *  resolves path prefixes against, through the SAME registry `targetRepo`
 *  validation reads. */
async function connectRepo(fx: WorkItemFixture, name: string, owner = 'moooon'): Promise<void> {
  const installationId = `inst-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
}

/** Create a card with an explicit `targetRepo` pin. */
async function makePinnedItem(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string,
  targetRepo: string | null,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd, targetRepo },
    fx.ctx,
  );
}

/**
 * MOTIR-2162's shape, verbatim in structure: pinned `motir-core`, with two
 * criteria naming paths in `motir-ai`. `run.md` guard #5 caught this at
 * dispatch — the wrong end of the process for a contradiction the card already
 * carried in two structured fields.
 */
const CARD_STRADDLING_TWO_REPOS = [
  'Nothing removes a tenant’s code graph on disconnect.',
  '',
  '## Acceptance criteria',
  '',
  '- `motir-core/docs/decisions/code-graph-index-fleet.md` gains an offboarding section.',
  '- `motir-ai/src/services/codeRepoService.ts` removes the durable snapshot.',
  '- `motir-ai/tests/codeRepoService.test.ts` covers the removal branch.',
].join('\n');

describe('the REPO-STRADDLE advisory — a criterion discharged outside the card’s repo', () => {
  it('MOTIR-2162 REGRESSION: pinned motir-core, criteria in motir-ai — names the FIRST', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await makePinnedItem(
      fx,
      'Code-graph offboarding',
      CARD_STRADDLING_TWO_REPOS,
      'motir-core',
    );

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-repo-straddle',
        path: 'motir-ai/src/services/codeRepoService.ts',
        repo: 'motir-ai',
        reason: 'contradiction',
        criterionIndex: 2,
      },
    ]);
  });

  it('does NOT fire when every resolvable path is in the PINNED repo', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await makePinnedItem(
      fx,
      'Single-repo card',
      [
        '## Acceptance criteria',
        '',
        '- `motir-core/lib/workItems/proseVsGraph.ts` exports the resolver.',
        '- `docs/decisions/x.md` is untouched (an unresolvable prefix is body text).',
      ].join('\n'),
      'motir-core',
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('UNPINNED with two repos fires as `unpinnable`; with one, nothing', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const two = await makePinnedItem(
      fx,
      'Unpinnable',
      [
        '## Acceptance criteria',
        '',
        '- `motir-core/lib/services/x.ts` submits the job.',
        '- `motir-ai/src/jobs/x.ts` executes it.',
      ].join('\n'),
      null,
    );
    const one = await makePinnedItem(
      fx,
      'Merely unpinned',
      '## Acceptance criteria\n\n- `motir-core/lib/services/x.ts` changes.',
      null,
    );
    expect(await buildDispatchProseAdvisories(two, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: two.identifier,
        severity: 'likely-repo-straddle',
        path: 'motir-ai/src/jobs/x.ts',
        repo: 'motir-ai',
        reason: 'unpinnable',
        criterionIndex: 2,
      },
    ]);
    expect(await buildDispatchProseAdvisories(one, fx.ctx)).toEqual([]);
  });

  it('resolves against the WORKSPACE’s connected set — an unconnected repo is body text', async () => {
    // The candidate set is the repo registry, not a hardcoded list: the SAME
    // body emits nothing in a workspace where `motir-ai` is not connected,
    // because `motir-ai/src/…` then resolves to no repo at all.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const card = await makePinnedItem(
      fx,
      'Code-graph offboarding',
      CARD_STRADDLING_TWO_REPOS,
      'motir-core',
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('⚠️ READINESS IS UNTOUCHED — byte-identical whether or not it is emitted', async () => {
    // The same strict invariant the ordering family carries (MOTIR-2175): two
    // cards identical but for the offending path produce the SAME readiness.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const flagged = await makePinnedItem(fx, 'Flagged', CARD_STRADDLING_TWO_REPOS, 'motir-core');
    const clean = await makePinnedItem(
      fx,
      'Clean',
      CARD_STRADDLING_TWO_REPOS.replaceAll('motir-ai/', 'motir-core/'),
      'motir-core',
    );

    expect(await buildDispatchProseAdvisories(flagged, fx.ctx)).toHaveLength(1);
    expect(await buildDispatchProseAdvisories(clean, fx.ctx)).toEqual([]);

    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(flagged.identifier)).toEqual(await readinessOf(clean.identifier));
    expect((await readinessOf(flagged.identifier)).ready).toBe(true);
    expect((await readinessOf(flagged.identifier)).openBlockers).toEqual([]);
  });

  it('rides ALONGSIDE the ordering advisory on one card, in a stable order', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await makePinnedItem(
      fx,
      'Both shape defects',
      [
        '## Acceptance criteria',
        '',
        '- `motir-ai/src/x.ts` is updated.',
        '- the row is visible on `main`.',
      ].join('\n'),
      'motir-core',
    );
    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    // Two shape findings, ordered by severity (`likely-ordering-violation` <
    // `likely-repo-straddle`) rather than by insertion — the tie-break is
    // stated, not inherited from sort stability.
    expect(advisories.map((a) => a.kind === 'shape' && a.severity)).toEqual([
      'likely-ordering-violation',
      'likely-repo-straddle',
    ]);
  });

  it('reaches the AGENT through dispatch_prompt — prompt, DTO and human summary', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const card = await makePinnedItem(
      fx,
      'Code-graph offboarding',
      CARD_STRADDLING_TWO_REPOS,
      'motir-core',
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toHaveLength(1);
    expect(dto.prompt).toContain('A CRITERION DISCHARGED IN ANOTHER REPO');
    expect(dto.prompt).toContain(
      'acceptance criterion 2 names motir-ai/src/services/codeRepoService.ts',
    );
    expect(dto.prompt).toContain('ONE SUBTASK = ONE REPO = ONE PR');
    // …and it still dispatches, in the same workflow mode.
    expect(dto.workflowMode).toBe('per_item_pr');

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain('names motir-ai/src/services/codeRepoService.ts');
  });

  it('reaches the PLANNER through claim_next_ready — summary text and payload', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    await makePinnedItem(fx, 'Code-graph offboarding', CARD_STRADDLING_TWO_REPOS, 'motir-core');

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker — the claim stands)');
    expect(text).toContain('names motir-ai/src/services/codeRepoService.ts');
    expect(text).toContain('One subtask, one repo, one PR');
    const payload = res.structuredContent as { advisories: WorkItemProseAdvisoryDto[] };
    expect(payload.advisories.map((a) => a.kind === 'shape' && a.severity)).toEqual([
      'likely-repo-straddle',
    ]);
  });
});

describe('THE ESTIMATION GATE advisory — a card whose own sizing says it is more than one run', () => {
  /**
   * The MOTIR-3068 shape, parameterised: a childless `coding_agent` card whose
   * body is entirely CLEAN — no reference token, no post-merge phrase, no
   * repo-qualified path, no file path at all. Every other check in the family is
   * silent on it, which is the point: the four cards that got past this gate did
   * so with nothing else wrong with them.
   */
  async function makeSizedItem(
    fx: WorkItemFixture,
    title: string,
    sizing: { storyPoints?: number | null; estimateMinutes?: number | null },
    fields: { type?: WorkItemTypeDto; executor?: ExecutorDto } = {
      type: 'code',
      executor: 'coding_agent',
    },
    placement: { kind?: 'task' | 'subtask'; parentId?: string } = {},
  ) {
    const { kind = 'task', parentId } = placement;
    return workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind,
        title,
        descriptionMd: '## Acceptance criteria\n\n- the thing is built and covered.',
        ...sizing,
        ...fields,
        ...(parentId ? { parentId } : {}),
      },
      fx.ctx,
    );
  }

  it('MOTIR-3068 REGRESSION: 13 points / 600 minutes, childless, coding_agent — ONE advisory naming both', async () => {
    // The card `motir run MOTIR-3068` claimed. It was `todo`, `ready: true`,
    // `validate_work_item` `valid: true`, and claimable — and the only thing
    // between it and a 101-file pull request was a sentence in its own
    // description asking not to be dispatched (`notes.html` #323).
    const fx = await makeWorkItemFixture();
    const card = await makeSizedItem(fx, 'The faint-ink sweep', {
      storyPoints: 13,
      estimateMinutes: 600,
    });

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-over-gate-sizing',
        threshold: 'both',
        storyPoints: 13,
        estimateMinutes: 600,
      },
    ]);
  });

  it('fires on each ceiling INDEPENDENTLY', async () => {
    const fx = await makeWorkItemFixture();
    const points = await makeSizedItem(fx, 'Points only', {
      storyPoints: 13,
      estimateMinutes: 45,
    });
    const minutes = await makeSizedItem(fx, 'Minutes only', {
      storyPoints: 3,
      estimateMinutes: 90,
    });

    expect(await buildDispatchProseAdvisories(points, fx.ctx)).toMatchObject([
      { severity: 'likely-over-gate-sizing', threshold: 'story_points', storyPoints: 13 },
    ]);
    expect(await buildDispatchProseAdvisories(minutes, fx.ctx)).toMatchObject([
      { severity: 'likely-over-gate-sizing', threshold: 'estimate_minutes', estimateMinutes: 90 },
    ]);
  });

  it('says NOTHING about a right-sized card — the direction that can go quiet', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSizedItem(fx, 'Right-sized', { storyPoints: 3, estimateMinutes: 45 });
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('EXEMPTS a human / manual executor — its minutes are human work', async () => {
    const fx = await makeWorkItemFixture();
    const human = await makeSizedItem(
      fx,
      'Flip the GHCR package to public',
      { storyPoints: 13, estimateMinutes: 600 },
      { type: 'manual', executor: 'human' },
    );
    expect(await buildDispatchProseAdvisories(human, fx.ctx)).toEqual([]);
  });

  it('EXEMPTS a card WITH children, whatever its own columns hold', async () => {
    // POSITION, not kind. The container's own numbers describe a subtree sized
    // by rollup, and the childless child beside it is the one the gate reaches —
    // asserted together so the exemption cannot be read as "the check is off".
    const fx = await makeWorkItemFixture();
    const container = await makeSizedItem(fx, 'Container', {
      storyPoints: 13,
      estimateMinutes: 600,
    });
    const child = await makeSizedItem(
      fx,
      'Its childless child',
      { storyPoints: 13, estimateMinutes: 600 },
      { type: 'code', executor: 'coding_agent' },
      { kind: 'subtask', parentId: container.id },
    );

    expect(await buildDispatchProseAdvisories(container, fx.ctx)).toEqual([]);
    expect(await buildDispatchProseAdvisories(child, fx.ctx)).toHaveLength(1);
  });

  it('⚠️ READINESS IS UNTOUCHED — byte-identical whether or not it is emitted', async () => {
    // The invariant every member of this channel carries, and the one this
    // member most needs: a legitimately large card mid-re-plan must stay
    // claimable, or a missed split is traded for a stuck board.
    const fx = await makeWorkItemFixture();
    const oversized = await makeSizedItem(fx, 'Oversized', {
      storyPoints: 13,
      estimateMinutes: 600,
    });
    const clean = await makeSizedItem(fx, 'Clean', { storyPoints: 3, estimateMinutes: 45 });

    expect(await buildDispatchProseAdvisories(oversized, fx.ctx)).toHaveLength(1);
    expect(await buildDispatchProseAdvisories(clean, fx.ctx)).toEqual([]);

    const readinessOf = async (identifier: string) =>
      (await workItemsService.getIssueDetail(fx.projectId, identifier, fx.ctx)).readiness;
    expect(await readinessOf(oversized.identifier)).toEqual(await readinessOf(clean.identifier));
    expect((await readinessOf(oversized.identifier)).ready).toBe(true);
    expect((await readinessOf(oversized.identifier)).openBlockers).toEqual([]);
  });

  it('reaches the AGENT through dispatch_prompt — prompt, DTO and human summary', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSizedItem(fx, 'Oversized', { storyPoints: 13, estimateMinutes: 600 });

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toMatchObject([{ severity: 'likely-over-gate-sizing' }]);
    expect(dto.prompt).toContain('THIS CARD IS SIZED PAST THE ESTIMATION GATE');
    expect(dto.prompt).toContain('13 story points / 600 estimated minutes');
    // Size never stops a run (MOTIR-5372): the agent builds it and reports the sizing.
    expect(dto.prompt).toContain('build it anyway, and say so in your report');
    expect(dto.prompt).toContain('never a reason to stop');
    expect(dto.prompt).not.toContain('Propose the split and STOP');
    // …and it still dispatches, in the same workflow mode.
    expect(dto.workflowMode).toBe('per_item_pr');

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain('over the estimation gate');
    expect(text).toContain('size never stops a run');
    expect(text).not.toContain('Split it before starting');
  });

  it('reaches the PLANNER through claim_next_ready — the caller with no sizing on its row', async () => {
    // `ReadyItemDispatchDto` carries neither `storyPoints` nor `estimateMinutes`,
    // so this path proves the LAZY read: a check that fired for dispatch_prompt
    // and not for claim_next_ready would be MOTIR-2079's "addressed to nobody"
    // in a new costume.
    const fx = await makeWorkItemFixture();
    const card = await makeSizedItem(fx, 'Oversized', { storyPoints: 13, estimateMinutes: 600 });

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker — the claim stands)');
    expect(text).toContain('over the estimation gate');
    expect(text).toContain('Build it anyway');
    expect(text).not.toContain('SPLIT it rather than');
    const payload = res.structuredContent as {
      item: { key: string } | null;
      advisories: WorkItemProseAdvisoryDto[];
    };
    expect(payload.item?.key).toBe(card.identifier);
    expect(payload.advisories).toMatchObject([
      { kind: 'shape', severity: 'likely-over-gate-sizing', threshold: 'both' },
    ]);
    // The claim still happened — the advisory is not a gate on this path either.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('in_progress');
  });
});

describe('THE DESIGN GATE advisory — a card that draws its own design and then builds it', () => {
  /**
   * MOTIR-3154's criteria set, RECONSTRUCTED — the as-authored text no longer
   * exists. `get_work_item_activity` records a `descriptionMd` edit at
   * 2026-08-19T20:53:52.716Z (that card's re-plan `modify`), and the tenant keeps
   * no prior body; `notes.html` #329 and the `motir run MOTIR-3154` comment both
   * PARAPHRASE criteria 1 / 4 / 5. Rebuilt here from the table in MOTIR-3178's
   * own body, which is its durable source, and SYNTHETIC so it cannot rot when
   * MOTIR-3154 is re-scoped again.
   *
   * Everything else about the body is CLEAN — no reference token, no post-merge
   * phrase, no repo-qualified path — because that is the point: the card the
   * defect was found on had nothing else wrong with it.
   */
  const reconstructedBody = () =>
    [
      '## Acceptance criteria',
      '',
      '1. a `design/ai-planning/` three-file amendment — the accepted and declined node',
      '   treatments, plus an explicit re-decision of what the plan-detail canvas pane',
      '   holds after approve',
      '2. decline no longer deletes the proposal rows',
      '3. approve leaves the pane on the plan rather than handing it to the establish step',
      '4. the plan-detail canvas draws a DECIDED plan — one node per approved add, in',
      '   the treatment the design decides',
      '5. the planning-workspace canvas KEEPS its decided overlay',
    ].join('\n');

  async function makeDesignCard(
    fx: WorkItemFixture,
    title: string,
    descriptionMd: string,
    placement: { kind?: 'task' | 'subtask'; parentId?: string; type?: WorkItemTypeDto } = {},
  ) {
    const { kind = 'task', parentId, type = 'code' } = placement;
    return workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind,
        title,
        descriptionMd,
        type,
        executor: 'coding_agent',
        storyPoints: 5,
        estimateMinutes: 55,
        ...(parentId ? { parentId } : {}),
      },
      fx.ctx,
    );
  }

  it('MOTIR-3154 REGRESSION: one advisory naming BOTH criteria', async () => {
    // The card `motir run MOTIR-3154` was handed. `readiness.ready` was `true`,
    // `openBlockers` `[]`, `validate_work_item` `valid: true` — and criterion 1
    // was the drawing that criteria 4-5 were to be built against, in one pull
    // request, approved by one click (`notes.html` #329; MOTIR-3158).
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 4,
      },
    ]);
  });

  /** A sibling of an arbitrary work TYPE, for the lifted-design arm below. */
  async function makeSibling(fx: WorkItemFixture, title: string, type: WorkItemTypeDto) {
    return workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title, type, executor: 'coding_agent' },
      fx.ctx,
    );
  }

  it('says NOTHING once the design is LIFTED — a blocked_by edge to a `type: design` sibling', async () => {
    // HOLE 1 (MOTIR-3625). `selfBlockingDesignCriteria` is a pure string scan, so
    // the card that DID what this advisory asks — lifted its design into its own
    // card and wired itself to wait for it — still names the mock it consumes and
    // still builds the surface, and read identically to one that never lifted
    // anything. Three of eight cards in one story were reported that way, every
    // one correctly shaped and correctly wired.
    //
    // The remedy is the edge, so the edge is the answer: the check now reads it.
    const fx = await makeWorkItemFixture();
    const design = await makeSibling(fx, 'Draw the plan canvas', 'design');
    const card = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('STILL fires when the blocker is not a DESIGN card — the gate reads the TYPE, not the edge', async () => {
    // The narrowest thing that could have been written instead, and why it would
    // be wrong: *"has any blocked_by edge"* would mute the check for every card
    // that waits on a migration or a service, which is most of them. The lift the
    // advisory asks for is specifically into a `type: design` card, so that is
    // what discharges it.
    const fx = await makeWorkItemFixture();
    const service = await makeSibling(fx, 'The projected-rows service', 'code');
    const card = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: service.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 4,
      },
    ]);
  });

  it('says NOTHING about a card carrying only one of the two roles', async () => {
    const fx = await makeWorkItemFixture();
    const designOnly = await makeDesignCard(
      fx,
      'Draw the plan canvas',
      [
        '## Acceptance criteria',
        '',
        '1. `design/ai-planning/plan-canvas.mock.html` is built from the real design system',
        '2. `design/ai-planning/design-notes.md` names the primitives and the access path',
      ].join('\n'),
    );
    const surfaceOnly = await makeDesignCard(
      fx,
      'Build the plan canvas',
      [
        '## Acceptance criteria',
        '',
        '1. the plan-detail canvas draws one node per approved add',
        '2. the planning-workspace canvas renders the decided overlay',
      ].join('\n'),
    );

    expect(await buildDispatchProseAdvisories(designOnly, fx.ctx)).toEqual([]);
    expect(await buildDispatchProseAdvisories(surfaceOnly, fx.ctx)).toEqual([]);
  });

  it('EXEMPTS a `type: design` card — the TYPE is the third scope test (MOTIR-6245)', async () => {
    // A design card IS the card the LIFT remedy would create. MOTIR-6236's own
    // criteria name panels by number and read as building a surface, so without
    // this the agent it is dispatched to is told to propose a design card for a
    // design card. The same body on a `code` card still reports.
    const fx = await makeWorkItemFixture();
    const design = await makeDesignCard(fx, 'Draw the composer', MOTIR_6236_DESIGN_CARD_CRITERIA, {
      type: 'design',
    });
    const code = await makeDesignCard(fx, 'Build the composer', MOTIR_6236_DESIGN_CARD_CRITERIA);

    expect(
      (await buildDispatchProseAdvisories(design, fx.ctx)).filter(
        (a) => a.severity === 'likely-self-blocking-design',
      ),
    ).toEqual([]);
    expect(await buildDispatchProseAdvisories(code, fx.ctx)).toContainEqual({
      kind: 'shape',
      item: code.identifier,
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 2,
    });
  });

  it('EXEMPTS a `type: test` card — it writes tests and draws nothing (MOTIR-10112)', async () => {
    // The same body that reports on a `code` card is silent on a `test` one: a
    // test card has no design criterion to lift, and its criteria name test
    // doubles constantly.
    const fx = await makeWorkItemFixture();
    const testCard = await makeDesignCard(
      fx,
      'Gate the composer',
      MOTIR_6236_DESIGN_CARD_CRITERIA,
      { type: 'test' },
    );

    expect(
      (await buildDispatchProseAdvisories(testCard, fx.ctx)).filter(
        (a) => a.severity === 'likely-self-blocking-design',
      ),
    ).toEqual([]);
  });

  it('EXEMPTS a card that HOLDS children — and the child count is read, not assumed', async () => {
    // The dispatch path does not carry `hasChildren` on its row shape, so this
    // also pins that the lazy row read actually happens for a card whose PROSE
    // qualifies. Guessing `false` here would report a container.
    const fx = await makeWorkItemFixture();
    const container = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());
    await makeDesignCard(fx, 'A right-shaped child', '## Acceptance criteria\n\n- built.', {
      kind: 'subtask',
      parentId: container.id,
    });

    expect(await buildDispatchProseAdvisories(container, fx.ctx)).toEqual([]);
  });

  it('reaches the AGENT through dispatch_prompt — prompt, DTO and human summary', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toHaveLength(1);
    expect(dto.prompt).toContain('THIS CARD IS ITS OWN DESIGN BLOCKER');
    expect(dto.prompt).toContain('criterion 1 produces a design asset; criterion 4 builds');
    expect(dto.prompt).toContain('The remedy is a LIFT, not a cut');
    // …and it still dispatches, in the same workflow mode.
    expect(dto.workflowMode).toBe('per_item_pr');

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain('its OWN design blocker');
  });

  it('a clean card renders no design-gate section at all', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(
      fx,
      'Right-shaped',
      '## Acceptance criteria\n\n- the service returns the projected rows.',
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toEqual([]);
    expect(dto.prompt).not.toContain('OWN DESIGN BLOCKER');
  });

  it('reaches the CLAIMER through claim_next_ready — and the claim still stands', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'A decided plan on the canvas', reconstructedBody());
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await adminDb.workItem.updateMany({ where: { id: card.id }, data: { sprintId: sprint.id } });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const payload = res.structuredContent as {
      item: { key: string } | null;
      advisories: WorkItemProseAdvisoryDto[];
    };
    expect(payload.item?.key).toBe(card.identifier);
    expect(payload.advisories).toMatchObject([{ severity: 'likely-self-blocking-design' }]);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('its OWN design blocker');

    // The claim happened — the advisory is not a gate on this path either.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('in_progress');
  });
});
