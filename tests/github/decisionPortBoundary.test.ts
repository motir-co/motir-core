import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decisionDocumentHostUrl,
  toDecisionDocumentViewDTO,
} from '@/lib/mappers/decisionDocumentMappers';

// THE DECISION PORT'S SERVER/CLIENT BOUNDARY (Story MOTIR-4907 · Subtask MOTIR-5678). The
// document is read on the SERVER, through the resolver, with the organisation's host
// credential; the browser gets the Markdown and a public page link — never a host API
// address, never a token, and never a module that could fetch either.

const root = resolve(__dirname, '../..');
const codeOf = (path: string) => readFileSync(resolve(root, path), 'utf8');
const importsOf = (code: string) =>
  [...code.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

/** Every module the port's browser half is made of — the item page's block and the
 *  overlay render these, and the overlay is a client island. */
const CLIENT_HALF = [
  'components/github/DecisionDocumentSlot.tsx',
  'components/github/DevelopmentGateFrame.tsx',
  'components/github/DevelopmentSection.tsx',
  'lib/dto/decisionDocument.ts',
];

describe('the port renders data, never sources', () => {
  it.each(CLIENT_HALF)('%s imports no service, repository, host client or resolver', (path) => {
    const offending = importsOf(codeOf(path)).filter(
      (spec) =>
        spec.startsWith('@/lib/services/') ||
        spec.startsWith('@/lib/repositories/') ||
        spec.startsWith('@/lib/github/') ||
        spec === '@/lib/approvalGates/decisionDocumentResolver' ||
        spec === '@/lib/db',
    );
    expect(offending, `${path} imports ${offending.join(', ')}`).toEqual([]);
  });

  it.each(CLIENT_HALF)('%s names no host API address and no credential', (path) => {
    const code = codeOf(path);
    expect(code).not.toMatch(/api\.github\.com/);
    expect(code).not.toMatch(/installation(Token|AccessToken)|GITHUB_(APP|TOKEN)/);
  });
});

describe('toDecisionDocumentViewDTO — what crosses to the browser', () => {
  const identity = {
    resolvable: true as const,
    repo: 'acme/web',
    number: 7,
    path: 'docs/decisions/page-body.md',
    blobSha: 'blob-1',
    headSha: 'head-1',
  };

  it('a resolved document carries its Markdown and a PAGE link at the head it was read at', () => {
    const view = toDecisionDocumentViewDTO(
      {
        identity,
        content: {
          outcome: 'resolved',
          repo: 'acme/web',
          path: identity.path,
          blobSha: 'blob-1',
          markdown: '# Page body',
        },
      },
      {},
    );
    expect(view).toEqual({
      outcome: 'resolved',
      repo: 'acme/web',
      number: 7,
      path: identity.path,
      blobSha: 'blob-1',
      headSha: 'head-1',
      markdown: '# Page body',
      workItemRefs: {},
      hostUrl: 'https://github.com/acme/web/blob/head-1/docs/decisions/page-body.md',
    });
    expect(JSON.stringify(view)).not.toMatch(/api\.github\.com|token/i);
  });

  it('a head the host never named links at the blob instead', () => {
    expect(decisionDocumentHostUrl('acme/web', 'blob-1', 'docs/decisions/a.md')).toBe(
      'https://github.com/acme/web/blob/blob-1/docs/decisions/a.md',
    );
    const view = toDecisionDocumentViewDTO(
      {
        identity: { ...identity, headSha: null },
        content: { outcome: 'unresolvable', reason: 'too_large' },
      },
      {},
    );
    expect(view).toMatchObject({
      outcome: 'unresolvable',
      reason: 'too_large',
      path: identity.path,
      hostUrl: 'https://github.com/acme/web/blob/blob-1/docs/decisions/page-body.md',
    });
  });

  it('an unresolvable CAPTURE names its documents for `several`, and links nowhere', () => {
    expect(
      toDecisionDocumentViewDTO(
        {
          identity: {
            resolvable: false,
            reason: 'several',
            repo: 'acme/web',
            number: 7,
            headSha: 'head-1',
            paths: ['docs/decisions/a.md', 'docs/decisions/b.md'],
          },
          content: { outcome: 'unresolvable', reason: 'several' },
        },
        {},
      ),
    ).toEqual({
      outcome: 'unresolvable',
      reason: 'several',
      repo: 'acme/web',
      number: 7,
      headSha: 'head-1',
      path: null,
      paths: ['docs/decisions/a.md', 'docs/decisions/b.md'],
      hostUrl: null,
    });
  });

  it('nothing captured is no port read at all', () => {
    expect(toDecisionDocumentViewDTO({ identity: null, content: null }, {})).toBeNull();
  });
});
