import { describe, expect, it } from 'vitest';
import { motirDestinations, replaceMotirDestinations } from '@/lib/markdown/proseRanges';
import { canonicalWorkItemKey, WORKITEM_KEY_TARGET_RE } from '@/lib/mentions/workItemRefs';
import { unresolvedItemLinksNotice } from '@/lib/mcp/tools/pageItemLinks';

// The `motir:` destination walker a page markdown save rewrites through (bug
// MOTIR-11281): a link written `[MOTIR-9730](motir:MOTIR-9730)` puts a card's KEY
// where its id belongs. Pure string work, no DB.

const toId = (target: string) => (target === 'MOTIR-1' ? 'cid1' : null);

describe('motirDestinations', () => {
  it('finds links and image embeds, with their labels and targets, in source order', () => {
    expect(motirDestinations('See [**A**](motir:MOTIR-1) and\n\n![B](motir:cabc)')).toEqual([
      { kind: 'link', label: 'A', target: 'MOTIR-1' },
      { kind: 'image', label: 'B', target: 'cabc' },
    ]);
  });

  it('finds an image nested in a link in source order', () => {
    expect(motirDestinations('[![in](motir:inner)](motir:outer)').map((d) => d.target)).toEqual([
      'inner',
      'outer',
    ]);
  });

  it('ignores code, other schemes and a body without `motir:`', () => {
    expect(motirDestinations('`[a](motir:X-1)`\n\n```\n[b](motir:X-2)\n```')).toEqual([]);
    expect(motirDestinations('[a](https://x.test) [p](motir-page:abc)')).toEqual([]);
    expect(motirDestinations('nothing here')).toEqual([]);
  });

  it('reports a malformed `motir:` destination too', () => {
    expect(motirDestinations('[req](motir:page:abc)')).toEqual([
      { kind: 'link', label: 'req', target: 'page:abc' },
    ]);
  });
});

describe('replaceMotirDestinations', () => {
  it('rewrites only the destination, leaving label, title and prose verbatim', () => {
    expect(
      replaceMotirDestinations('MOTIR-1 [MOTIR-1](motir:MOTIR-1 "t") `motir:MOTIR-1`', toId),
    ).toBe('MOTIR-1 [MOTIR-1](motir:cid1 "t") `motir:MOTIR-1`');
  });

  it('rewrites an embed and every occurrence, and leaves a null answer as written', () => {
    expect(
      replaceMotirDestinations(
        '![K](motir:MOTIR-1)\n\n[a](motir:MOTIR-1) [b](motir:MOTIR-2)',
        toId,
      ),
    ).toBe('![K](motir:cid1)\n\n[a](motir:cid1) [b](motir:MOTIR-2)');
  });

  it('returns a body with nothing to rewrite byte-identical', () => {
    const body = '# T\n\n[x](motir:cid1) plain';
    expect(replaceMotirDestinations(body, (t) => t)).toBe(body);
    expect(replaceMotirDestinations('no links', toId)).toBe('no links');
  });

  it('skips a reference-style link, whose destination is not inside the span', () => {
    const body = '[a][r]\n\n[r]: motir:MOTIR-1';
    expect(replaceMotirDestinations(body, toId)).toBe(body);
  });
});

describe('canonicalWorkItemKey', () => {
  it('canonicalises a key-shaped payload and refuses an id', () => {
    expect(canonicalWorkItemKey('MOTIR-9730')).toBe('MOTIR-9730');
    expect(canonicalWorkItemKey('motir-0042')).toBe('MOTIR-42');
    expect(canonicalWorkItemKey('cmvprl64o01dthmu1zmsofh3j')).toBeNull();
    expect(canonicalWorkItemKey('4937bb40-921d-4739-9293-5a4bfd7e9a12')).toBeNull();
    expect(canonicalWorkItemKey('9-1')).toBeNull();
    expect(WORKITEM_KEY_TARGET_RE.test('A1-0')).toBe(true);
  });
});

describe('unresolvedItemLinksNotice', () => {
  it('is empty when every link resolved, and names each dead link otherwise', () => {
    expect(unresolvedItemLinksNotice([])).toBe('');
    const notice = unresolvedItemLinksNotice([
      { link: '[A](motir:gone)', label: 'A', target: 'gone' },
      { link: '![B](motir:X-9)', label: 'B', target: 'X-9' },
    ]);
    expect(notice).toContain('2 work-item link(s)');
    expect(notice).toContain('[A](motir:gone), ![B](motir:X-9)');
  });
});
