import { describe, expect, it } from 'vitest';

import { InvalidProposalError } from '@/lib/plans/errors';
import {
  assertBodyRefsResolve,
  bodyLinkWarningLine,
  CANONICAL_ITEM_LINK_FORMS,
  findBodyLinkCandidates,
  findMalformedIntraPlanRefs,
  findUnresolvedIntraPlanRefIds,
  judgeBodyLinks,
  type BodyLinkResolution,
} from '@/lib/plans/validateProposedBodyRefs';
import { rewriteIntraPlanRefs } from '@/lib/mentions/workItemRefs';

// Bugs MOTIR-6494 · MOTIR-10104 — the ONE judgement every plan-proposal door
// applies to the item links in a proposal's bodies: found, judged and WARNED,
// never refused. Pure, so pinned here without a database;
// `tests/integration/plans/proposalLinkWarnings.test.ts` and
// `tests/mcp/plan-body-refs.test.ts` prove each door reaches it.

function refusal(run: () => void): InvalidProposalError | null {
  try {
    run();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return err as InvalidProposalError;
  }
}

describe('findMalformedIntraPlanRefs', () => {
  it('finds a `motir-ref:` link without the `planItem:` prefix — the form that shipped dead', () => {
    expect(
      findMalformedIntraPlanRefs('See [the model](motir-ref:cmui7qj5m00rnhvoiruwl7tcd).'),
    ).toEqual(['[the model](motir-ref:cmui7qj5m00rnhvoiruwl7tcd)']);
  });

  it('finds every near-miss the canonical token rejects, once each, in first-seen order', () => {
    const body = [
      '[a](motir-ref:abc)',
      '[b](motir-ref:planitem:abc)',
      '[c](motir-ref:planItem:)',
      '[d](motir-ref:planItem:has space)',
      '[a](motir-ref:abc)',
    ].join(' ');
    expect(findMalformedIntraPlanRefs(body)).toEqual([
      '[a](motir-ref:abc)',
      '[b](motir-ref:planitem:abc)',
      '[c](motir-ref:planItem:)',
      '[d](motir-ref:planItem:has space)',
    ]);
  });

  it('passes the canonical token, an existing-item link, a bare key and plain prose', () => {
    const body =
      '[x](motir-ref:planItem:pi_1-A) [y](motir:cmqfb4dfo001l2d0iq3i0jl6j) MOTIR-12 motir-ref is a word.';
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
  });

  it('agrees with materialize: every link it passes is one `rewriteIntraPlanRefs` rewrites', () => {
    const body = '[x](motir-ref:planItem:abc) and [y](motir-ref:planItem:def)';
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
    const { body: rewritten } = rewriteIntraPlanRefs(
      body,
      new Map([
        ['abc', 'w1'],
        ['def', 'w2'],
      ]),
    );
    expect(rewritten).not.toContain('motir-ref:');
  });

  it('ignores a link inside inline code or a fenced block, which renders as text, not a link', () => {
    const body = [
      'The bare form `[x](motir-ref:<id>)` is refused; so is ``[y](motir-ref:abc)``.',
      '```md',
      '[z](motir-ref:abc)',
      '```',
      '~~~',
      '[w](motir-ref:def)',
      '~~~',
    ].join('\n');
    expect(findMalformedIntraPlanRefs(body)).toEqual([]);
  });

  it('still reads a link after a closed fence, and treats an unclosed backtick as text', () => {
    const body = [
      '```',
      'code',
      '```',
      'then [a](motir-ref:abc)',
      'a ` stray [b](motir-ref:def)',
    ].join('\n');
    expect(findMalformedIntraPlanRefs(body)).toEqual(['[a](motir-ref:abc)', '[b](motir-ref:def)']);
  });
});

describe('findMalformedIntraPlanRefs — linear on hostile input (CodeQL js/polynomial-redos)', () => {
  it('scans a body repeating an unclosed `[](motir-ref:` opener in linear time and finds no link', () => {
    // The pre-fix regex (`/\[[^\]\[]*\]\(motir-ref:[^)\n]*\)/g`) re-scanned the
    // rest of the line from every opener: 8.7 s on this 508 KB input on a dev
    // box. The linear scan takes ~15 ms there. The bound is generous (a CI
    // runner under coverage is ~10–20× slower than a dev box) and still well
    // under the defect, so it cannot pass by accident (MOTIR-6511: 2.6 MB
    // against the same bound left ~1.07× headroom on CI and flaked).
    const hostile = '[](motir-ref:'.repeat(40_000);
    const started = performance.now();
    expect(findMalformedIntraPlanRefs(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reads a link whose destination runs over a later opener as one link, as a regex would', () => {
    expect(findMalformedIntraPlanRefs('[a](motir-ref:x [b](motir-ref:y)')).toEqual([
      '[a](motir-ref:x [b](motir-ref:y)',
    ]);
  });
});

describe('findBodyLinkCandidates', () => {
  it('reads each malformed `motir-ref:` link and each `motir:` link, per field, with its label and id', () => {
    expect(
      findBodyLinkCandidates({
        descriptionMd:
          'After [the schema](motir-ref:pi42), [ok](motir-ref:planItem:pi1), ' +
          '[odd](motir-ref:planitem:pi7), [none](motir-ref:<id>) and [card](motir:cm1).',
        explanationMd: 'Because [the schema](motir-ref:pi42).',
      }),
    ).toEqual([
      {
        field: 'descriptionMd',
        link: '[the schema](motir-ref:pi42)',
        label: 'the schema',
        id: 'pi42',
        scheme: 'motir-ref',
      },
      {
        field: 'descriptionMd',
        link: '[odd](motir-ref:planitem:pi7)',
        label: 'odd',
        id: 'pi7',
        scheme: 'motir-ref',
      },
      {
        field: 'descriptionMd',
        link: '[none](motir-ref:<id>)',
        label: 'none',
        id: null,
        scheme: 'motir-ref',
      },
      {
        field: 'descriptionMd',
        link: '[card](motir:cm1)',
        label: 'card',
        id: 'cm1',
        scheme: 'motir',
      },
      {
        field: 'explanationMd',
        link: '[the schema](motir-ref:pi42)',
        label: 'the schema',
        id: 'pi42',
        scheme: 'motir-ref',
      },
    ]);
  });

  it('skips links inside code, a malformed `motir:` destination, and absent or null bodies', () => {
    expect(findBodyLinkCandidates({})).toEqual([]);
    expect(findBodyLinkCandidates({ descriptionMd: null, explanationMd: null })).toEqual([]);
    expect(
      findBodyLinkCandidates({
        descriptionMd:
          'Syntax `[x](motir-ref:abc)` and `[y](motir:cm2)`; [bad](motir:a b); [dup](motir:c3) [dup](motir:c3)',
      }),
    ).toEqual([
      { field: 'descriptionMd', link: '[dup](motir:c3)', label: 'dup', id: 'c3', scheme: 'motir' },
    ]);
  });
});

describe('judgeBodyLinks', () => {
  const known: BodyLinkResolution = {
    thisPlanAddIds: new Set(['pi_here']),
    becameCard: new Map([['pi_old', 'cm_card']]),
    cardIds: new Set(['cm_card', 'cm_other']),
  };
  const judge = (descriptionMd: string) =>
    judgeBodyLinks(findBodyLinkCandidates({ descriptionMd }), known);

  it('corrects a link to THIS plan’s proposal to the canonical token, in either scheme', () => {
    for (const link of ['[x](motir-ref:pi_here)', '[x](motir:pi_here)']) {
      const [w] = judge(link);
      expect(w).toMatchObject({ link, correctedLink: '[x](motir-ref:planItem:pi_here)' });
      expect(w!.canonicalForms).toBeUndefined();
    }
  });

  it('corrects a link to an earlier plan’s proposal to the card it became, in either scheme', () => {
    for (const link of ['[the host card](motir-ref:pi_old)', '[the host card](motir:pi_old)']) {
      expect(judge(link)).toEqual([
        expect.objectContaining({ link, correctedLink: '[the host card](motir:cm_card)' }),
      ]);
    }
    expect(judge('[x](motir-ref:planItem:pi_old)')).toEqual([]); // canonical: not this check's
  });

  it('corrects a card named in the proposal scheme to the card scheme', () => {
    expect(judge('[c](motir-ref:cm_other)')).toEqual([
      expect.objectContaining({ correctedLink: '[c](motir:cm_other)' }),
    ]);
  });

  it('names the canonical forms when nothing resolves, and leaves an ordinary card link alone', () => {
    const [unknown, noId] = judge(
      '[g](motir-ref:pi_gone) [n](motir-ref:<id>) [c](motir:cm_other) [z](motir:nothing)',
    );
    expect(unknown).toMatchObject({
      correctedLink: null,
      canonicalForms: [...CANONICAL_ITEM_LINK_FORMS],
    });
    expect(unknown!.reason).toContain('pi_gone');
    expect(noId).toMatchObject({ link: '[n](motir-ref:<id>)', correctedLink: null });
    expect(noId!.reason).toContain('names no id');
    expect(judge('[c](motir:cm_other) [z](motir:nothing)')).toEqual([]);
  });

  it('prints a warning as one line, with the correction or the canonical forms', () => {
    const [fixed, open] = judge('[x](motir-ref:pi_here) [g](motir-ref:pi_gone)');
    expect(bodyLinkWarningLine(fixed!)).toContain('write `[x](motir-ref:planItem:pi_here)`');
    expect(bodyLinkWarningLine(open!)).toContain(
      'write one of `[label](motir:<workItemId>)` or `[label](motir-ref:planItem:<planItemId>)`',
    );
    expect(bodyLinkWarningLine(open!)).toContain(
      '`descriptionMd` carries `[g](motir-ref:pi_gone)`',
    );
    expect(bodyLinkWarningLine({ ...open!, canonicalForms: undefined })).toContain(
      '`[label](motir:<workItemId>)`',
    );
  });
});

// Bug MOTIR-9175 — a well-formed link whose id names no proposal on the plan.
describe('findUnresolvedIntraPlanRefIds / assertBodyRefsResolve', () => {
  const plan = new Set(['pi_a', 'pi_b']);

  it('returns the ids the plan does not hold, first-seen order, deduplicated', () => {
    expect(
      findUnresolvedIntraPlanRefIds(
        '[a](motir-ref:planItem:pi_a) [x](motir-ref:planItem:pi_x) [y](motir-ref:planItem:pi_y) [x2](motir-ref:planItem:pi_x)',
        plan,
      ),
    ).toEqual(['pi_x', 'pi_y']);
  });

  it('does not check a link inside a fenced block or an inline code span', () => {
    const text =
      'Syntax `[x](motir-ref:planItem:pi_x)`.\n\n```\n[y](motir-ref:planItem:pi_y)\n```\n';
    expect(findUnresolvedIntraPlanRefIds(text, plan)).toEqual([]);
  });

  it('refuses with INVALID_PROPOSAL naming the id and the field, on either body', () => {
    for (const field of ['descriptionMd', 'explanationMd'] as const) {
      const err = refusal(() =>
        assertBodyRefsResolve(
          { [field]: 'See [x](motir-ref:planItem:pi_x).' },
          plan,
          'Proposal "X"',
        ),
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('INVALID_PROPOSAL');
      expect(err!.message).toContain('Proposal "X"');
      expect(err!.message).toContain(field);
      expect(err!.message).toContain('planItem:pi_x');
    }
  });

  it('passes absent bodies and links that resolve', () => {
    expect(refusal(() => assertBodyRefsResolve({}, plan, 'P'))).toBeNull();
    expect(
      refusal(() =>
        assertBodyRefsResolve({ descriptionMd: '[a](motir-ref:planItem:pi_a)' }, plan, 'P'),
      ),
    ).toBeNull();
  });
});
