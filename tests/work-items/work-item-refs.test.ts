import { describe, expect, it } from 'vitest';
import {
  WORKITEM_TOKEN_RE,
  WORKITEM_HREF_RE,
  buildWorkItemKeyRe,
  parseWorkItemTokenIds,
  parseWorkItemLinks,
  parseWorkItemKeys,
  parseWorkItemRefs,
  parseWorkItemProseRefs,
  normalizeWorkItemRefs,
  INTRA_PLAN_REF_TOKEN_RE,
  parseIntraPlanRefIds,
  rewriteIntraPlanRefs,
} from '@/lib/mentions/workItemRefs';

// Pure unit tests for the work-item reference parser (Story 5.8 · Subtask
// 5.8.2) — the parallel of the user-mention parser (parse.ts). No DB.

describe('parseWorkItemTokenIds', () => {
  it('is LINEAR on a body of unclosed openers — the MOTIR-4202 reproduction, for both token regexes', () => {
    // The same quadratic scan the mention parser had (CodeQL alerts #2 and #3):
    // `[^\]]*` ran to the end of the string from every `[`. Generous bound —
    // a CI runner is ~20× slower than a dev box — still far under the seconds
    // the defect took.
    const body = '['.repeat(80_000);
    const started = Date.now();
    expect(parseWorkItemTokenIds(body)).toEqual([]);
    expect(parseIntraPlanRefIds(body)).toEqual([]);
    expect(parseWorkItemLinks(body)).toEqual([]); // MOTIR-9007's label-capturing twin
    expect(Date.now() - started).toBeLessThan(500);
    // …and a real token after the noise is still found.
    expect(parseWorkItemTokenIds('[[[MOTIR-1](motir:cltreal)')).toEqual(['cltreal']);
    expect(parseIntraPlanRefIds('[[[Story](motir-ref:planItem:pi_real)')).toEqual(['pi_real']);
  });

  it('extracts the id from a motir: token', () => {
    const ids = parseWorkItemTokenIds('See [MOTIR-805](motir:cltabc123) for the engine.');
    expect(ids).toEqual(['cltabc123']);
  });

  it('dedupes repeated ids in first-seen order', () => {
    const body =
      'Blocks [MOTIR-1](motir:idB) then [MOTIR-2](motir:idA) and again [MOTIR-1](motir:idB).';
    expect(parseWorkItemTokenIds(body)).toEqual(['idB', 'idA']);
  });

  it('ignores malformed near-tokens (no scheme, unclosed bracket)', () => {
    expect(
      parseWorkItemTokenIds('[MOTIR-1](https://x) and [MOTIR-2](motir:) and [a(motir:b)'),
    ).toEqual([]);
  });

  it('returns [] for an empty body', () => {
    expect(parseWorkItemTokenIds('')).toEqual([]);
  });
});

describe('parseWorkItemLinks (MOTIR-9007)', () => {
  it('captures each link as its label and its id', () => {
    expect(
      parseWorkItemLinks('See [MOTIR-7656](motir:cmA) and [the export flow](motir:cmB).'),
    ).toEqual([
      { label: 'MOTIR-7656', id: 'cmA' },
      { label: 'the export flow', id: 'cmB' },
    ]);
  });

  it('dedupes an identical (label, id) pair, but keeps the same id under two labels', () => {
    expect(
      parseWorkItemLinks('[MOTIR-1](motir:a) [MOTIR-1](motir:a) [MOTIR-2](motir:a) [](motir:b)'),
    ).toEqual([
      { label: 'MOTIR-1', id: 'a' },
      { label: 'MOTIR-2', id: 'a' },
      { label: '', id: 'b' },
    ]);
  });

  it('finds the real link after unclosed openers, and ignores malformed and intra-plan tokens', () => {
    expect(parseWorkItemLinks('[[[MOTIR-1](motir:cltreal)')).toEqual([
      { label: 'MOTIR-1', id: 'cltreal' },
    ]);
    expect(
      parseWorkItemLinks('[a](motir:) [b(motir:c) [Story](motir-ref:planItem:pi_1) [d](https://x)'),
    ).toEqual([]);
  });
});

describe('parseWorkItemLinks — judged by Markdown structure (bug MOTIR-9825)', () => {
  const token = '[MOTIR-1](motir:cmDead)';

  it('stays linear on a body of unclosed openers that does carry a `motir:` link', () => {
    // The parse is micromark's, linear by design; a quadratic scan of 80k
    // openers would take minutes, so a bound this loose still catches one.
    const started = Date.now();
    expect(parseWorkItemLinks(`${'['.repeat(80_000)}[MOTIR-1](motir:cltreal)`)).toEqual([
      { label: 'MOTIR-1', id: 'cltreal' },
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('finds no link in an inline code span, whatever the backtick run length', () => {
    expect(parseWorkItemLinks(`Quoted: \`${token}\`.`)).toEqual([]);
    expect(parseWorkItemLinks(`Quoted: \`\` a \` and ${token} \`\`.`)).toEqual([]);
  });

  it('finds no link in a fenced or an indented code block', () => {
    expect(parseWorkItemLinks(['```md', token, '```'].join('\n'))).toEqual([]);
    expect(parseWorkItemLinks(['~~~', token, '~~~'].join('\n'))).toEqual([]);
    expect(parseWorkItemLinks(['Para.', '', `    ${token}`].join('\n'))).toEqual([]);
  });

  it('keeps the real link beside a quoted one to the same id', () => {
    expect(parseWorkItemLinks(`Bad: \`${token}\`. Real: ${token}.`)).toEqual([
      { label: 'MOTIR-1', id: 'cmDead' },
    ]);
  });

  it('reads the label a reader sees — markup stripped, a title ignored', () => {
    expect(parseWorkItemLinks('[**MOTIR-2**](motir:cmA) and [`MOTIR-3`](motir:cmB "t")')).toEqual([
      { label: 'MOTIR-2', id: 'cmA' },
      { label: 'MOTIR-3', id: 'cmB' },
    ]);
  });
});

describe('parseWorkItemKeys', () => {
  it('extracts a bare project key', () => {
    expect(parseWorkItemKeys('Depends on MOTIR-11 to ship.', 'MOTIR')).toEqual(['MOTIR-11']);
  });

  it('canonicalises a lower-case prefix and dedupes', () => {
    expect(parseWorkItemKeys('motir-11 and MOTIR-11 and motir-12', 'MOTIR')).toEqual([
      'MOTIR-11',
      'MOTIR-12',
    ]);
  });

  it('only matches THIS project prefix (a foreign key is plain text)', () => {
    expect(parseWorkItemKeys('See OTHER-9 and MOTIR-9', 'MOTIR')).toEqual(['MOTIR-9']);
  });

  it('word-boundaried — does not match a key glued into a longer token', () => {
    expect(parseWorkItemKeys('XMOTIR-9 and MOTIR-9X are not keys', 'MOTIR')).toEqual([]);
  });

  it('escapes a regex-special prefix safely', () => {
    expect(buildWorkItemKeyRe('A.B').test('A.B-3')).toBe(true);
    expect(buildWorkItemKeyRe('A.B').test('AxB-3')).toBe(false);
  });
});

describe('parseWorkItemRefs', () => {
  it('returns both token ids and bare keys, each deduped first-seen', () => {
    const body = 'This [MOTIR-805](motir:cltX) blocks MOTIR-11 and also MOTIR-11 again.';
    expect(parseWorkItemRefs(body, 'MOTIR')).toEqual({ ids: ['cltX'], keys: ['MOTIR-11'] });
  });
});

describe('parseWorkItemProseRefs (bug MOTIR-9825)', () => {
  it('reads keys and token ids from prose, as parseWorkItemRefs does', () => {
    const body = 'This [MOTIR-805](motir:cltX) blocks MOTIR-11 and also MOTIR-11 again.';
    expect(parseWorkItemProseRefs(body, 'MOTIR')).toEqual({ ids: ['cltX'], keys: ['MOTIR-11'] });
  });

  it('reads nothing a code span or code block quotes', () => {
    const body = [
      'Quote `MOTIR-12` and `[MOTIR-13](motir:cltY)` inline.',
      '',
      '```',
      'MOTIR-14 [MOTIR-15](motir:cltZ)',
      '```',
      '',
      '    MOTIR-16',
    ].join('\n');
    expect(parseWorkItemProseRefs(body, 'MOTIR')).toEqual({ ids: [], keys: [] });
    // The raw read-side scan still sees all of them.
    expect(parseWorkItemRefs(body, 'MOTIR').keys).toEqual(['MOTIR-12', 'MOTIR-14', 'MOTIR-16']);
  });

  it('reads a key in a heading, a list and a table cell — prose that chips', () => {
    const body = ['# MOTIR-1', '', '- MOTIR-2', '', '| a |', '| - |', '| MOTIR-3 |'].join('\n');
    expect(parseWorkItemProseRefs(body, 'MOTIR').keys).toEqual(['MOTIR-1', 'MOTIR-2', 'MOTIR-3']);
  });
});

describe('normalizeWorkItemRefs (bug MOTIR-1440)', () => {
  const resolve = new Map([
    ['MOTIR-11', 'idEleven'],
    ['MOTIR-12', 'idTwelve'],
  ]);

  it('rewrites a bare key to the canonical token', () => {
    expect(normalizeWorkItemRefs('Depends on MOTIR-11 to ship.', 'MOTIR', resolve)).toBe(
      'Depends on [MOTIR-11](motir:idEleven) to ship.',
    );
  });

  it('canonicalises a lower-case bare key (label upper-cased)', () => {
    expect(normalizeWorkItemRefs('see motir-11', 'MOTIR', resolve)).toBe(
      'see [MOTIR-11](motir:idEleven)',
    );
  });

  it('leaves an unresolved key as plain text', () => {
    expect(normalizeWorkItemRefs('see MOTIR-999 here', 'MOTIR', resolve)).toBe(
      'see MOTIR-999 here',
    );
  });

  it('leaves an already-explicit token untouched (does not re-wrap its label key)', () => {
    const body = 'cf. [MOTIR-11](motir:idEleven) already.';
    expect(normalizeWorkItemRefs(body, 'MOTIR', resolve)).toBe(body);
  });

  it('is idempotent — normalising the result again is a no-op', () => {
    const once = normalizeWorkItemRefs('blocks MOTIR-11 and MOTIR-12', 'MOTIR', resolve);
    expect(normalizeWorkItemRefs(once, 'MOTIR', resolve)).toBe(once);
  });

  it('rewrites multiple distinct keys, each to its own token', () => {
    expect(normalizeWorkItemRefs('MOTIR-11 then MOTIR-12', 'MOTIR', resolve)).toBe(
      '[MOTIR-11](motir:idEleven) then [MOTIR-12](motir:idTwelve)',
    );
  });

  it('mixes a bare key (rewritten) beside an existing token (kept)', () => {
    expect(normalizeWorkItemRefs('MOTIR-11 and [MOTIR-12](motir:idTwelve)', 'MOTIR', resolve)).toBe(
      '[MOTIR-11](motir:idEleven) and [MOTIR-12](motir:idTwelve)',
    );
  });

  it('does not touch a foreign-project bare key', () => {
    expect(normalizeWorkItemRefs('see OTHER-11', 'MOTIR', resolve)).toBe('see OTHER-11');
  });

  it('returns the text unchanged for an empty resolve map', () => {
    expect(normalizeWorkItemRefs('see MOTIR-11', 'MOTIR', new Map())).toBe('see MOTIR-11');
  });
});

describe('WORKITEM_HREF_RE', () => {
  it('accepts a well-formed motir href and rejects a malformed one', () => {
    expect(WORKITEM_HREF_RE.test('motir:cltabc123')).toBe(true);
    expect(WORKITEM_HREF_RE.test('motir:')).toBe(false);
    expect(WORKITEM_HREF_RE.test('mention:cltabc123')).toBe(false);
  });

  it('WORKITEM_TOKEN_RE carries no lastIndex state across calls', () => {
    const body = '[K](motir:a) [K](motir:b)';
    expect(parseWorkItemTokenIds(body)).toEqual(['a', 'b']);
    expect(parseWorkItemTokenIds(body)).toEqual(['a', 'b']);
    expect(WORKITEM_TOKEN_RE.lastIndex).toBe(0);
  });
});

describe('intra-plan item-link tokens (MOTIR-1418)', () => {
  // planItem id → created work-item id (the map materialize builds).
  const resolve = new Map([
    ['piA', 'wiA'],
    ['piB', 'wiB'],
  ]);

  it('rewrites ONLY the intra-plan token; an existing motir: token + a bare key pass through', () => {
    const body = 'See [A](motir-ref:planItem:piA), [B](motir:wiExisting), and MOTIR-11.';
    const { body: out, unresolved } = rewriteIntraPlanRefs(body, resolve);
    expect(out).toBe('See [A](motir:wiA), [B](motir:wiExisting), and MOTIR-11.');
    expect(unresolved).toEqual([]);
  });

  it('leaves a dangling temp-ref inert and reports its id (never a half-token/crash)', () => {
    const { body, unresolved } = rewriteIntraPlanRefs('[X](motir-ref:planItem:piGone)', resolve);
    expect(body).toBe('[X](motir-ref:planItem:piGone)'); // untouched
    expect(unresolved).toEqual(['piGone']);
  });

  it('preserves the label and rewrites multiple tokens', () => {
    const { body } = rewriteIntraPlanRefs(
      '[the schema](motir-ref:planItem:piA) then [the route](motir-ref:planItem:piB)',
      resolve,
    );
    expect(body).toBe('[the schema](motir:wiA) then [the route](motir:wiB)');
  });

  it('returns the body unchanged when there is no intra-plan token', () => {
    const body = 'plain text, a [k](motir:x) token and MOTIR-11';
    expect(rewriteIntraPlanRefs(body, resolve).body).toBe(body);
    expect(rewriteIntraPlanRefs(body, new Map()).body).toBe(body);
  });

  it('rewrites a `motir:<planItemId>` link to a sibling add like the canonical token (MOTIR-9993)', () => {
    const body =
      'See [A](motir:piA), [B](motir-ref:planItem:piB), [C](motir:wiExisting), [D](motir:neither).';
    const { body: out, unresolved } = rewriteIntraPlanRefs(body, resolve);
    expect(out).toBe(
      'See [A](motir:wiA), [B](motir:wiB), [C](motir:wiExisting), [D](motir:neither).',
    );
    // A `motir:` link naming no proposal is an ordinary item link, never a dangling ref.
    expect(unresolved).toEqual([]);
    // Idempotent: the rewritten body is not rewritten again.
    expect(rewriteIntraPlanRefs(out, resolve).body).toBe(out);
  });

  // The token BOTH planners hand a session beside every sibling proposal
  // (MOTIR-10096) is `[<title>](motir-ref:planItem:<id>)`, with the title's
  // brackets turned into parentheses. A copy of it must rewrite exactly.
  it('rewrites the token a planner hands for a proposal, title label and all (MOTIR-10096)', () => {
    const handed = '[Gate (beta) pairs (service layer): `assertLegal`](motir-ref:planItem:piA)';
    const { body, unresolved } = rewriteIntraPlanRefs(`Hands off to ${handed}.`, resolve);
    expect(body).toBe(
      'Hands off to [Gate (beta) pairs (service layer): `assertLegal`](motir:wiA).',
    );
    expect(unresolved).toEqual([]);
    expect(parseIntraPlanRefIds(handed)).toEqual(['piA']);
  });

  it('a label still carrying a bracket is NOT a token — why the planners hand none', () => {
    const raw = '[Gate [beta] pairs](motir-ref:planItem:piA)';
    expect(rewriteIntraPlanRefs(raw, resolve).body).toBe(raw);
    expect(parseIntraPlanRefIds(raw)).toEqual([]);
  });

  it('parseIntraPlanRefIds returns distinct planItem ids in first-seen order', () => {
    expect(
      parseIntraPlanRefIds(
        '[a](motir-ref:planItem:piA) [a2](motir-ref:planItem:piA) [b](motir-ref:planItem:piB)',
      ),
    ).toEqual(['piA', 'piB']);
  });

  it('INTRA_PLAN_REF_TOKEN_RE carries no lastIndex state across calls', () => {
    const body = '[a](motir-ref:planItem:piA)';
    expect(parseIntraPlanRefIds(body)).toEqual(['piA']);
    expect(parseIntraPlanRefIds(body)).toEqual(['piA']);
    expect(INTRA_PLAN_REF_TOKEN_RE.lastIndex).toBe(0);
  });
});

describe('normalizeWorkItemRefs is Markdown-structure-aware (bug MOTIR-2043)', () => {
  const resolve = new Map([
    ['MOTIR-11', 'idEleven'],
    ['MOTIR-12', 'idTwelve'],
  ]);
  const same = (body: string) => expect(normalizeWorkItemRefs(body, 'MOTIR', resolve)).toBe(body);

  it('leaves a key inside an inline code span literal', () => {
    same('Write `MOTIR-11` to reference it.');
  });

  it('leaves a key inside a multi-backtick code span literal', () => {
    same('A span holding a backtick: ``MOTIR-11 ` still code``.');
  });

  it('leaves a key inside a fenced code block literal', () => {
    same('Before.\n\n```\nconst key = "MOTIR-11";\n```\n\nAfter.');
  });

  it('leaves a key inside an indented code block literal', () => {
    same('Sample:\n\n    grep MOTIR-11 .\n\nDone.');
  });

  it('leaves a key inside a link destination literal', () => {
    same('Open [the item](/items/MOTIR-11) now.');
  });

  it('leaves a key inside a link LABEL literal (never nests a link in a link)', () => {
    same('Open [see MOTIR-11](https://example.test/x) now.');
  });

  it('leaves a key inside a reference-style link label literal', () => {
    same('Open [MOTIR-11][ref] now.\n\n[ref]: https://example.test/x\n');
  });

  it('leaves a key inside an image destination literal', () => {
    same('![a diagram](/img/MOTIR-11.png)');
  });

  it('leaves a key inside a GFM autolink literal URL', () => {
    same('See https://app.motir.test/items/MOTIR-11 for detail.');
  });

  it('leaves a key inside a raw HTML block literal', () => {
    same('<div>\nMOTIR-11\n</div>');
  });

  it('still rewrites a prose key in the SAME body as a protected one', () => {
    expect(
      normalizeWorkItemRefs('Blocks MOTIR-11; the token is `MOTIR-12`.', 'MOTIR', resolve),
    ).toBe('Blocks [MOTIR-11](motir:idEleven); the token is `MOTIR-12`.');
  });

  it('still rewrites a prose key in a heading, list item, quote and table cell', () => {
    expect(
      normalizeWorkItemRefs(
        '# MOTIR-11\n\n- MOTIR-11\n\n> MOTIR-11\n\n| h |\n| --- |\n| MOTIR-11 |\n',
        'MOTIR',
        resolve,
      ),
    ).toBe(
      '# [MOTIR-11](motir:idEleven)\n\n- [MOTIR-11](motir:idEleven)\n\n> [MOTIR-11](motir:idEleven)\n\n| h |\n| --- |\n| [MOTIR-11](motir:idEleven) |\n',
    );
  });

  it('stays idempotent over a body mixing prose, code and links', () => {
    const body =
      'Blocks MOTIR-11, documents `MOTIR-12`, links [x](/items/MOTIR-11) and cites [MOTIR-12](motir:idTwelve).';
    const once = normalizeWorkItemRefs(body, 'MOTIR', resolve);
    expect(once).toBe(
      'Blocks [MOTIR-11](motir:idEleven), documents `MOTIR-12`, links [x](/items/MOTIR-11) and cites [MOTIR-12](motir:idTwelve).',
    );
    expect(normalizeWorkItemRefs(once, 'MOTIR', resolve)).toBe(once);
  });

  it('reproduces the MOTIR-2043 report: a backticked key survives the round-trip', () => {
    // The card's own description: a key deliberately backticked as documentation.
    const body = 'I wrapped it as `MOTIR-11` precisely so it would stay literal text.';
    same(body);
  });
});
