// MOTIR-5772 — the preview host (MOTIR-5769 §9), table-driven: every case the
// decision names, and every output a DNS name of `[a-z0-9-]` labels.
import { describe, expect, it } from 'vitest';
import {
  COLLISION_SUFFIX_LENGTH,
  DNS_LABEL_MAX,
  choosePreviewHostName,
  disambiguatedPreviewHostName,
  previewHostName,
  repositorySlug,
} from '@/lib/preview/hostName';
import { PreviewHostInvalidError } from '@/lib/preview/errors';

const DOMAIN = 'preview.motir.site';
const RID = 'cmvttubqa0076gkoox7buxdi7';
const LABEL = /^[a-z0-9-]+$/;

function input(over: Partial<Parameters<typeof previewHostName>[0]> = {}) {
  return {
    pullRequestNumber: 12,
    repositoryName: 'acme',
    repositoryId: RID,
    domain: DOMAIN,
    ...over,
  };
}

function expectDnsName(host: string) {
  for (const label of host.split('.')) {
    expect(label, host).toMatch(LABEL);
    expect(label.length, host).toBeLessThanOrEqual(DNS_LABEL_MAX);
    expect(label.startsWith('-') || label.endsWith('-'), host).toBe(false);
  }
}

describe('repositorySlug', () => {
  it.each([
    ['acme', 'acme'],
    ['My.Repo_Name', 'my-repo-name'],
    ['--Weird!!Name--', 'weird-name'],
    ['a  b', 'a-b'],
    ['日本語', ''],
    ['___', ''],
  ])('%j → %j', (name, slug) => {
    expect(repositorySlug(name)).toBe(slug);
  });
});

describe('previewHostName', () => {
  it.each([
    [{}, 'pr-12--acme.preview.motir.site'],
    [{ repositoryName: 'Motir.Core_App' }, 'pr-12--motir-core-app.preview.motir.site'],
    [{ pullRequestNumber: 987654 }, 'pr-987654--acme.preview.motir.site'],
    [{ domain: 'Preview.Example.COM ' }, 'pr-12--acme.preview.example.com'],
    // A name with no letter or digit falls back to the row id's start.
    [
      { repositoryName: '日本語' },
      `pr-12--${RID.slice(0, COLLISION_SUFFIX_LENGTH)}.preview.motir.site`,
    ],
  ])('%j → %s', (over, host) => {
    const out = previewHostName(input(over));
    expect(out).toBe(host);
    expectDnsName(out);
  });

  it('cuts a long repository name so the first label is at most 63 characters', () => {
    const name = 'a-very-long-repository-name-that-goes-on-and-on-well-past-any-dns-limit';
    for (const n of [1, 12, 999_999]) {
      const host = previewHostName(input({ pullRequestNumber: n, repositoryName: name }));
      const label = host.split('.')[0]!;
      expect(label.length).toBeLessThanOrEqual(DNS_LABEL_MAX);
      expect(label.startsWith(`pr-${n}--a-very-long`)).toBe(true);
      expectDnsName(host);
    }
  });

  it('never leaves a hyphen at the cut', () => {
    // The 57th character of the slug — the last that fits — is a hyphen: the cut must not end on it.
    const name = `${'a'.repeat(56)}-bbbbbbbbbb`;
    const label = previewHostName(input({ pullRequestNumber: 1, repositoryName: name })).split(
      '.',
    )[0]!;
    expect(label.endsWith('-')).toBe(false);
    expectDnsName(label);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses pull request number %s',
    (n) => {
      expect(() => previewHostName(input({ pullRequestNumber: n }))).toThrow(
        PreviewHostInvalidError,
      );
    },
  );

  it.each(['', 'preview..motir.site', 'preview_motir.site', '-x.site', `${'a'.repeat(64)}.site`])(
    'refuses domain %j',
    (domain) => {
      expect(() => previewHostName(input({ domain }))).toThrow(PreviewHostInvalidError);
    },
  );
});

describe('collisions', () => {
  it('two repositories that slug the same get distinct hosts', async () => {
    const a = input({ repositoryName: 'Acme.App', repositoryId: 'cmaaaaaa1111' });
    const b = input({ repositoryName: 'acme-app', repositoryId: 'cmbbbbbb2222' });
    expect(previewHostName(a)).toBe(previewHostName(b));
    const held = new Set<string>();
    const isTaken = async (host: string) => held.has(host);
    const first = await choosePreviewHostName(a, isTaken);
    held.add(first);
    const second = await choosePreviewHostName(b, isTaken);
    expect(first).toBe('pr-12--acme-app.preview.motir.site');
    expect(second).toBe('pr-12--acme-app-cmbbbb.preview.motir.site');
    expect(second).not.toBe(first);
    expectDnsName(second);
  });

  it('keeps the disambiguated label within 63 characters on a long name', () => {
    const host = disambiguatedPreviewHostName(
      input({ pullRequestNumber: 123_456, repositoryName: 'x'.repeat(80) }),
    );
    const label = host.split('.')[0]!;
    expect(label.length).toBe(DNS_LABEL_MAX);
    expect(label.endsWith(`-${RID.slice(0, COLLISION_SUFFIX_LENGTH)}`)).toBe(true);
    expectDnsName(host);
  });

  it('refuses a row id with nothing to disambiguate with', () => {
    expect(() => disambiguatedPreviewHostName(input({ repositoryId: '---' }))).toThrow(
      PreviewHostInvalidError,
    );
  });
});
