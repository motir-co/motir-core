import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runValidatePlan } from '@/lib/mcp/tools/validatePlan';
import { runValidateWorkItem } from '@/lib/mcp/tools/validateWorkItem';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { parseSections, type ParsedBody } from '@/lib/workItems/sections/parse';
import type { SectionType } from '@/lib/workItems/sections/registry';
import { renderSections } from '@/lib/workItems/sections/render';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { fixture } from '../../unit/workItems/sections/helpers/sectionFixture';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE, seam 3 — round trip and free text (MOTIR-9023 · Subtask MOTIR-9036).
//
// `descriptionMd` stays ONE free-text body, so two promises have to hold at once:
// `parseSections(renderSections(x)) = x` for what the doors render, and a body a
// person typed is read WITHOUT LOSING TEXT and is NEVER rewritten — not by a plain
// write, a read, a parse or a validation. The corpus under
// `tests/fixtures/sections/corpus/` is hand-written in the shapes the tenant holds
// (not copied from tenant data: motir-core is a public repository).
//
// ⚠️ HOW "NO LINE LOST" IS JUDGED. The parser RESHAPES structured sections
// (`` `k` (en) — Hello `` becomes `{ key, locale, says }`, an option's `cost:` /
// `forecloses:` labels become field names), so a byte-for-byte line comparison would
// fail a correct parse. What is invariant is the TEXT: strip the markup and the
// structural labels from both sides and the multiset of words in the body must equal
// the multiset in the parsed view. That catches a dropped line AND a line counted
// twice, which a "the body contains the line" shortcut would not. Level-2 heading
// lines are structure, not text, and are excluded from the body side.
// ════════════════════════════════════════════════════════════════════════════

// ── Round trip: every cell, through the renderer and the parser ───────────────

const TYPES: SectionType[] = [null, ...WORK_ITEM_TYPES];

describe('parse ∘ render is the identity on the doors’ own output', () => {
  for (const kind of ISSUE_TYPES) {
    for (const type of TYPES) {
      it(`${kind} / ${type ?? 'null'}, with heading-shaped lines inside values`, () => {
        const base = fixture(kind, type);
        const sections = {
          ...base,
          framing: 'Intro.\n## Looks like a heading\nOutro.',
          scopeBoundary: 'Line one.\n### Not a heading either\nLine two.',
        };
        const expected = {
          ...sections,
          ...(sections.contextRefs
            ? {
                contextRefs: sections.contextRefs.map((r) => ({
                  ...r,
                  // The renderer backticks a path ref; the parser returns it bare.
                  ref: r.ref.replace(/^`|`$/g, ''),
                })),
              }
            : {}),
        };
        const body = renderSections(kind, type, sections);
        const parsed = parseSections(body, kind, type);
        expect(parsed.sections).toEqual(expected);
        expect(parsed.missing).toEqual([]);
        expect(parsed.invalid).toEqual([]);
      });
    }
  }
});

// ── The corpus ────────────────────────────────────────────────────────────────

interface CorpusBody {
  name: string;
  kind: IssueType;
  type: SectionType;
  body: string;
}

const CORPUS_DIR = join(__dirname, '../../fixtures/sections/corpus');

function loadCorpus(): CorpusBody[] {
  return readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(CORPUS_DIR, file), 'utf8');
      const match = /^---\nkind: (\w+)\n(?:type: (\w+)\n)?---\n/.exec(raw);
      if (!match) throw new Error(`${file}: no front matter`);
      return {
        name: file.replace(/\.md$/, ''),
        kind: match[1] as IssueType,
        type: (match[2] ?? null) as SectionType,
        body: raw.slice(match[0].length),
      };
    });
}

const CORPUS = loadCorpus();

/** Strip markup and structural labels; what is left is the TEXT a person wrote. */
function words(text: string): string[] {
  return text
    .replace(/[*`]/g, '')
    .replace(/\b(best if you want|situation|you said|evidence|cost|forecloses):/gi, ' ')
    .replace(/[^\p{L}\p{N}/.]+/gu, ' ')
    .toLowerCase()
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)
    .sort();
}

/** Every string a parsed view carries, except the headings of `otherSections`
 *  (a heading is structure, like the heading lines excluded on the body side). */
function parsedText(parsed: ParsedBody): string {
  const leaves: string[] = [];
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === 'string') leaves.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value))
        if (!(key === undefined && k === 'heading')) walk(v, k);
    }
  };
  for (const [name, value] of Object.entries(parsed.sections)) {
    if (name === 'otherSections') {
      for (const other of value as { heading: string; body: string }[]) leaves.push(other.body);
    } else {
      walk(value, name);
    }
  }
  return leaves.join('\n');
}

const bodyText = (body: string) =>
  body
    .split('\n')
    .filter((line) => !/^##\s/.test(line))
    .join('\n');

describe('the corpus covers every kind and every type', () => {
  it('has at least one body per kind and per type', () => {
    expect(new Set(CORPUS.map((c) => c.kind))).toEqual(new Set(ISSUE_TYPES));
    expect(new Set(CORPUS.filter((c) => c.kind === 'task').map((c) => c.type))).toEqual(
      new Set(WORK_ITEM_TYPES),
    );
    // The shapes the tenant holds.
    const named = CORPUS.map((c) => c.name);
    for (const shape of [
      'plan-authored',
      'pre-amendment-3',
      'verification',
      'headingless',
      'all-gutter',
      'chip-refs',
      'nested-criteria',
      'unknown-heading',
      'duplicate-criteria',
    ]) {
      expect(
        named.some((n) => n.includes(shape)),
        shape,
      ).toBe(true);
    }
  });

  it('keeps the text of every body: the words of the body equal the words of its parsed view', () => {
    for (const { name, kind, type, body } of CORPUS) {
      const parsed = parseSections(body, kind, type);
      expect(words(parsedText(parsed)), name).toEqual(words(bodyText(body)));
    }
  });

  it('parses without a signal what the doors would have rendered, and reads the gutter and the headless body for what they are', () => {
    const byName = (n: string) => CORPUS.find((c) => c.name === n)!;
    const parse = (n: string) => parseSections(byName(n).body, byName(n).kind, byName(n).type);
    expect(parse('task-code-plan-authored').missing).toEqual([]);
    expect(parse('task-code-plan-authored').signals).toEqual([]);
    expect(parse('task-code-pre-amendment-3').missing).toEqual(['scopeBoundary']);
    expect(parse('task-chore-headingless').signals).toEqual(['no-headings']);
    expect(parse('task-code-all-gutter').signals).toContain('quoted-gutter');
    expect(parse('task-code-duplicate-criteria').signals).toContain('duplicate-heading');
    expect(parse('task-code-unknown-heading').sections.otherSections).toEqual([
      expect.objectContaining({ heading: 'Rollout notes' }),
    ]);
  });
});

// ── The corpus through the database ───────────────────────────────────────────

describe('a hand-written body is stored as sent and never rewritten', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
    await adminDb.$disconnect();
  });

  /** The corpus as a committed tree: an epic, a story under it, every other card
   *  under the story (a subtask hangs off the story too, which the matrix allows). */
  async function seedTree(fx: WorkItemFixture) {
    const created = new Map<string, { id: string; identifier: string }>();
    const make = async (entry: CorpusBody, parentId: string | null) => {
      const dto = await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: entry.kind,
          title: entry.name,
          ...(entry.type ? { type: entry.type } : {}),
          descriptionMd: entry.body,
          ...(parentId ? { parentId } : {}),
        },
        fx.ctx,
      );
      created.set(entry.name, { id: dto.id, identifier: dto.identifier });
      return dto;
    };
    const epic = await make(CORPUS.find((c) => c.kind === 'epic')!, null);
    const story = await make(CORPUS.find((c) => c.kind === 'story')!, epic.id);
    for (const entry of CORPUS) {
      if (entry.kind === 'epic' || entry.kind === 'story') continue;
      await make(entry, story.id);
    }
    return { created, epic, story };
  }

  const snapshot = (fx: WorkItemFixture) =>
    adminDb.workItem
      .findMany({
        where: { projectId: fx.projectId },
        select: { id: true, descriptionMd: true, updatedAt: true },
        orderBy: { id: 'asc' },
      })
      .then((rows) => rows.map((r) => [r.id, r.descriptionMd, r.updatedAt.toISOString()]));

  it('stores every body exactly as sent; nothing is refused for its shape', async () => {
    const fx = await makeWorkItemFixture();
    const { created } = await seedTree(fx);
    expect(created.size).toBe(CORPUS.length);
    for (const entry of CORPUS) {
      const row = await adminDb.workItem.findUniqueOrThrow({
        where: { id: created.get(entry.name)!.id },
      });
      expect(row.descriptionMd, entry.name).toBe(entry.body);
    }
  });

  it('every read and validation leaves description_md and updated_at byte-identical, and the parsed view keeps every word', async () => {
    const fx = await makeWorkItemFixture();
    const { created, epic } = await seedTree(fx);

    // A plan that modifies the leaf cards parks them; take the snapshot AFTER, so
    // what is measured is the reads and validations, not the plan's own move.
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Touches the corpus' },
      fx.ctx,
    );
    const modifiable = CORPUS.filter((c) => c.kind !== 'epic' && c.kind !== 'story');
    await plansService.addProposals(
      plan.id,
      modifiable.map((entry) => ({
        op: 'modify' as const,
        workItemId: created.get(entry.name)!.id,
        patch: { title: `${entry.name} (renamed by the plan)` },
      })),
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const before = await snapshot(fx);

    for (const entry of CORPUS) {
      const key = created.get(entry.name)!.identifier;
      const plain = await runGetWorkItem({ key }, fx.ctx);
      expect(plain.structuredContent, entry.name).not.toHaveProperty('parsedSections');
      const asked = await runGetWorkItem({ key, includeSections: true }, fx.ctx);
      const view = (asked.structuredContent as { parsedSections: ParsedBody }).parsedSections;
      expect(words(parsedText(view)), entry.name).toEqual(words(bodyText(entry.body)));
    }
    await runValidateWorkItem({ key: epic.identifier }, fx.ctx);
    await runValidatePlan({ planId: plan.id }, fx.ctx);

    expect(await snapshot(fx)).toEqual(before);
    // Seeding the corpus, a plan over it and two reads per card take ~11.7s on an
    // idle machine on both Postgres 16 and 18, so the suite's 15s budget left no
    // room for a loaded CI shard, where it timed out twice (MOTIR-10221).
  }, 60_000);

  it('validate_work_item names each not-done card’s missing sections exactly as parseSections does, and skips done cards', async () => {
    const fx = await makeWorkItemFixture();
    const { created, epic } = await seedTree(fx);
    const done = ['task-chore-headingless', 'task-code-all-gutter'];
    await adminDb.workItem.updateMany({
      where: { id: { in: done.map((n) => created.get(n)!.id) } },
      data: { status: 'done' },
    });

    const verdict = await runValidateWorkItem({ key: epic.identifier }, fx.ctx);
    const findings = (
      verdict.structuredContent as {
        sectionFindings: { item: string; missing: string[]; invalid: { section: string }[] }[];
      }
    ).sectionFindings;
    const byItem = new Map(findings.map((f) => [f.item, f]));

    for (const entry of CORPUS) {
      const { identifier } = created.get(entry.name)!;
      const parsed = parseSections(entry.body, entry.kind, entry.type);
      const finding = byItem.get(identifier);
      if (done.includes(entry.name)) {
        expect(finding, `${entry.name} is done`).toBeUndefined();
        continue;
      }
      expect(finding?.missing ?? [], entry.name).toEqual(parsed.missing);
      expect(finding?.invalid.map((i) => i.section) ?? [], entry.name).toEqual(
        parsed.invalid.map((i) => i.section),
      );

      // One parse, two surfaces: the read view names the same sections.
      const read = await runGetWorkItem({ key: identifier, includeSections: true }, fx.ctx);
      const view = (read.structuredContent as { parsedSections: ParsedBody }).parsedSections;
      expect(view.missing, entry.name).toEqual(finding?.missing ?? []);
    }
  });

  it('a sparse sections edit on a hand-written proposal keeps every original line, and a refusal names what is missing and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const bodyOf = (name: string) => CORPUS.find((c) => c.name === name)!.body;
    const plan = await plansService.createPlan(fx.projectId, { title: 'Hand written' }, fx.ctx);
    const added = await plansService.addProposals(
      plan.id,
      ['task-chore-headingless', 'task-code-pre-amendment-3'].map((name) => ({
        op: 'add' as const,
        proposedFields: {
          title: name,
          kind: 'task',
          type: name === 'task-chore-headingless' ? 'chore' : 'code',
          descriptionMd: bodyOf(name),
        } as never,
      })),
      fx.ctx,
    );
    const [headlessId, preAmendmentId] = added.appendedItemIds as [string, string];
    const stored = async (id: string) =>
      (
        (await adminDb.planItem.findUniqueOrThrow({ where: { id } })).proposedFields as {
          descriptionMd: string;
        }
      ).descriptionMd;
    const lines = (body: string) =>
      body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    // The heading-less body: a sparse edit is refused until the required sections exist.
    await expect(
      plansService.deepenProposal(
        plan.id,
        headlessId,
        { sections: { assumptions: ['The flag is off everywhere.'] } },
        fx.ctx,
      ),
    ).rejects.toThrow(/scopeBoundary, acceptanceCriteria, contextRefs/);
    expect(await stored(headlessId)).toBe(bodyOf('task-chore-headingless'));

    await plansService.deepenProposal(
      plan.id,
      headlessId,
      {
        sections: {
          scopeBoundary: 'The flag and its branch only.',
          acceptanceCriteria: ['No reference to the flag remains.'],
          contextRefs: [{ ref: 'lib/flags/invoiceBanner.ts', why: 'the flag' }],
        },
      },
      fx.ctx,
    );
    const afterHeadless = await stored(headlessId);
    for (const line of lines(bodyOf('task-chore-headingless')))
      expect(afterHeadless).toContain(line);

    // The pre-AMENDMENT-3 shape: the boundary is the one missing section.
    await expect(
      plansService.deepenProposal(
        plan.id,
        preAmendmentId,
        { sections: { assumptions: ['The switcher already lists projects.'] } },
        fx.ctx,
      ),
    ).rejects.toThrow(/scopeBoundary/);
    expect(await stored(preAmendmentId)).toBe(bodyOf('task-code-pre-amendment-3'));

    await plansService.deepenProposal(
      plan.id,
      preAmendmentId,
      { sections: { scopeBoundary: 'The switcher only.' } },
      fx.ctx,
    );
    const afterPre = await stored(preAmendmentId);
    for (const line of lines(bodyOf('task-code-pre-amendment-3'))) expect(afterPre).toContain(line);
    expect(afterPre).toContain('The switcher only.');
  });
});
