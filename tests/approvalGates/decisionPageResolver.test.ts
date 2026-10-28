import { describe, expect, it } from 'vitest';
import {
  contentFromPage,
  pageDecisionResolver,
  repoFileDecisionResolver,
  type DecisionDocumentReadContext,
} from '@/lib/approvalGates/decisionDocumentResolver';
import type {
  PageDecisionIdentity,
  RepoFileDecisionIdentity,
} from '@/lib/approvalGates/decisionSubject';
import { toDecisionDocumentViewDTO } from '@/lib/mappers/decisionDocumentMappers';

// THE PAGE RESOLVER AND ITS DTO, as pure functions (Story MOTIR-5761 · MOTIR-7433 /
// MOTIR-7436). Each resolver refuses the other's identity, a gone version is
// `gone_at_head`, a read that knows only the text falls back on every optional field,
// and the DTO derives the page's links and the changed-since notice.

const ctx = {} as DecisionDocumentReadContext;

const PAGE: PageDecisionIdentity = {
  source: 'page',
  resolvable: true,
  pageId: 'page-1',
  versionId: 'version-3',
  versionNumber: 3,
  title: 'How a page stores its body',
};

const FILE: RepoFileDecisionIdentity = {
  resolvable: true,
  repo: 'acme/web',
  number: 12,
  path: 'docs/decisions/x.md',
  blobSha: 'b1',
  headSha: 'h1',
};

describe('each resolver refuses the other’s identity', () => {
  it('the file resolver answers a page with unreadable, without reading', async () => {
    let reads = 0;
    const resolver = repoFileDecisionResolver(async () => {
      reads += 1;
      throw new Error('never read');
    });
    expect(await resolver.resolve(PAGE, ctx)).toEqual({
      outcome: 'unresolvable',
      reason: 'unreadable',
    });
    expect(reads).toBe(0);
  });

  it('the page resolver answers a file with unreadable, without reading', async () => {
    let reads = 0;
    const resolver = pageDecisionResolver(async () => {
      reads += 1;
      return null;
    });
    expect(await resolver.resolve(FILE, ctx)).toEqual({
      outcome: 'unresolvable',
      reason: 'unreadable',
    });
    expect(reads).toBe(0);
  });
});

describe('the page resolver', () => {
  it('reads the identity’s version, and a gone version is gone_at_head', async () => {
    const asked: string[] = [];
    const resolver = pageDecisionResolver(async (_ctx, versionId) => {
      asked.push(versionId);
      return null;
    });
    expect(await resolver.resolve(PAGE, ctx)).toEqual({
      outcome: 'unresolvable',
      reason: 'gone_at_head',
    });
    expect(asked).toEqual(['version-3']);
  });

  it('a read that knows only the text falls back on every optional field', () => {
    expect(contentFromPage(PAGE, { markdown: 'Body.' })).toEqual({
      outcome: 'page',
      pageId: 'page-1',
      versionId: 'version-3',
      versionNumber: 3,
      title: 'How a page stores its body',
      markdown: 'Body.',
      authorName: null,
      savedAt: null,
      frozen: false,
      latestVersionNumber: null,
    });
  });

  it('carries the author, the save time, the freeze and the newest version through', async () => {
    const resolver = pageDecisionResolver(async () => ({
      markdown: 'Body.',
      authorName: 'Mara S.',
      savedAt: '2026-09-18T10:00:00.000Z',
      frozen: true,
      latestVersionNumber: 5,
    }));
    expect(await resolver.resolve(PAGE, ctx)).toMatchObject({
      outcome: 'page',
      authorName: 'Mara S.',
      savedAt: '2026-09-18T10:00:00.000Z',
      frozen: true,
      latestVersionNumber: 5,
    });
  });
});

describe('the DTO over a page', () => {
  const content = (latestVersionNumber: number | null) =>
    contentFromPage(PAGE, {
      markdown: 'Body.',
      latestVersionNumber,
    });

  it('links the page, the version and the compare view', () => {
    expect(toDecisionDocumentViewDTO({ identity: PAGE, content: content(3) }, {})).toMatchObject({
      outcome: 'page',
      pageUrl: '/pages/page-1',
      versionUrl: '/pages/page-1?version=3',
      compareUrl: '/pages/page-1?history=open&version=3',
      changedSince: false,
    });
  });

  it('says the page changed since only when a newer version exists', () => {
    expect(toDecisionDocumentViewDTO({ identity: PAGE, content: content(4) }, {})).toMatchObject({
      changedSince: true,
    });
    expect(toDecisionDocumentViewDTO({ identity: PAGE, content: content(null) }, {})).toMatchObject(
      {
        changedSince: false,
      },
    );
  });

  it('an unreadable version keeps its reason and links the page', () => {
    expect(
      toDecisionDocumentViewDTO(
        {
          identity: PAGE,
          content: { outcome: 'unresolvable', reason: 'gone_at_head' },
        },
        {},
      ),
    ).toEqual({
      outcome: 'unresolvable',
      reason: 'gone_at_head',
      repo: '',
      number: 0,
      headSha: null,
      path: null,
      paths: [],
      hostUrl: '/pages/page-1',
    });
  });

  it('a file’s content under a page identity is unreadable, never a file view', () => {
    expect(
      toDecisionDocumentViewDTO(
        {
          identity: PAGE,
          content: {
            outcome: 'resolved',
            repo: 'acme/web',
            path: 'docs/decisions/x.md',
            blobSha: 'b1',
            markdown: 'File.',
          },
        },
        {},
      ),
    ).toMatchObject({ outcome: 'unresolvable', reason: 'unreadable', hostUrl: '/pages/page-1' });
  });
});
