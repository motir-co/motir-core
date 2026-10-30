// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';

// THE /code REPOSITORIES ROW FOR A REPOSITORY REFUSED FOR SIZE (Story MOTIR-7092 ·
// MOTIR-7132), against the approved design: design/code-context §17 and
// `code-context--graph-too-large.mock.html` (MOTIR-7126).
//
// Rendered with the REAL catalogues in both locales rather than key echoes, because
// what this card ships is copy: the size and the limit in the design's format, the
// `codegraph.json` suggestion, "contact Motir", and the precedence over the generic
// "not updating" line.

const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'zh' }));

// The catalogue goes in as `AbstractIntlMessages`: the namespace is chosen at
// runtime (`as never`), so a typed catalogue checks nothing here — it only makes
// next-intl compute every key path in all ~600 KB of it.
vi.mock('next-intl/server', () => ({
  getLocale: async () => locale.current,
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: locale.current,
      messages: (locale.current === 'zh'
        ? zhMessages
        : enMessages) as unknown as AbstractIntlMessages,
      namespace: namespace as never,
    }),
}));

import { CodeRepositories } from '@/app/(authed)/code/_components/CodeRepositories';
import { renderToHtml } from '../helpers/serverPageHarness';

const GIB = 1024 ** 3;

function repo(overrides: Partial<CodeContextRepoDTO> = {}): CodeContextRepoDTO {
  return {
    repoRef: 'moooon/web',
    provider: 'github',
    indexState: 'stale',
    indexedAt: null,
    commitsBehind: 1,
    indexedSha: null,
    defaultHead: null,
    refreshFailing: true,
    graphTooLarge: { sizeBytes: 1_503_238_553, capBytes: GIB },
    ...overrides,
  };
}

/** The visible text of the rendered list, tags stripped and entities decoded. */
async function textFor(repos: CodeContextRepoDTO[]): Promise<string> {
  const html = await renderToHtml(await CodeRepositories({ repos }));
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

afterEach(() => {
  locale.current = 'en';
});

describe('a repository refused for size', () => {
  it('state 1 · stale: the title with both sizes, the last-graph sentence and the remedy', async () => {
    const text = await textFor([repo()]);

    expect(text).toContain(
      'The last index was refused: the code graph was 1.4 GiB, and the supported maximum is 1 GiB.',
    );
    expect(text).toContain('Motir keeps planning against the last code graph it indexed.');
    expect(text).toContain('codegraph.json');
    expect(text).toContain('"exclude": ["tests/", "fixtures/"]');
    expect(text).toContain('or contact Motir.');
    expect(text).toContain('Stale');
    expect(text).toContain('1 commit behind');
  });

  it('⚠️ REPLACES "This index is not updating." — the row carries one warning, once', async () => {
    const text = await textFor([repo({ refreshFailing: true })]);

    expect(text).not.toContain('This index is not updating.');
    expect(text.match(/The last index was refused/g)).toHaveLength(1);
  });

  it('renders `codegraph.json` and the example as <code>, from the catalogue', async () => {
    const html = await renderToHtml(await CodeRepositories({ repos: [repo()] }));
    expect(html).toMatch(
      /<code class="font-mono text-xs text-\(--el-text\)">codegraph\.json<\/code>/,
    );
    expect(html).toContain('lucide-triangle-alert');
  });

  it('state 2 · N commits behind: the drift line stays beside the pill', async () => {
    const text = await textFor([repo({ commitsBehind: 312 })]);
    expect(text).toContain('312 commits behind');
    expect(text).toContain('The last index was refused');
  });

  it('state 3 · never indexed: no sentence about a last graph', async () => {
    const text = await textFor([
      repo({ indexState: 'never', commitsBehind: null, refreshFailing: true }),
    ]);

    expect(text).toContain('The last index was refused');
    expect(text).toContain('codegraph.json');
    expect(text).not.toContain('Motir keeps planning against the last code graph it indexed.');
  });

  it('state 4 · indexing: the block STAYS while a re-index is in progress', async () => {
    const text = await textFor([
      repo({ indexState: 'indexing', commitsBehind: null, refreshFailing: false }),
    ]);
    expect(text).toContain('The last index was refused');
    expect(text).toContain('Motir keeps planning against the last code graph it indexed.');
  });

  it('state 5 · recovered: graphTooLarge null renders the row exactly as before', async () => {
    const healthy = await textFor([
      repo({
        indexState: 'indexed',
        commitsBehind: null,
        refreshFailing: false,
        graphTooLarge: null,
      }),
    ]);
    expect(healthy).not.toContain('The last index was refused');
    expect(healthy).toContain('Indexed');

    // And a failing refresh with no refusal keeps the shipped line.
    const failing = await textFor([repo({ graphTooLarge: null })]);
    expect(failing).toContain('This index is not updating.');
    expect(failing).not.toContain('The last index was refused');
  });

  it('a staging cap renders in the same format — 976.5 KiB', async () => {
    const text = await textFor([
      repo({ graphTooLarge: { sizeBytes: 2_000_000, capBytes: 1_000_000 } }),
    ]);
    expect(text).toContain('the code graph was 1.9 MiB, and the supported maximum is 976.5 KiB.');
  });

  it('state 6 · Chinese: every new key renders from zh.json', async () => {
    locale.current = 'zh';
    const text = await textFor([repo()]);

    expect(text).toContain('上一次建立索引被拒绝：代码图大小为 1.4 GiB，而支持的上限为 1 GiB。');
    expect(text).toContain('Motir 会继续基于上一次成功建立索引的代码图进行规划。');
    expect(text).toContain('codegraph.json');
    expect(text).toContain('或联系 Motir。');
    expect(text).not.toContain('该索引没有在更新。');
  });
});

describe('the catalogues', () => {
  it('carry the same refusedForSize keys in both locales', () => {
    const en = enMessages.code.repositories.refusedForSize;
    const zh = zhMessages.code.repositories.refusedForSize;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).sort()).toEqual(['lastGraph', 'remedy', 'title']);
  });

  it('promise no time — §10.1 holds for the refusal copy too', () => {
    const copy = JSON.stringify([
      enMessages.code.repositories.refusedForSize,
      zhMessages.code.repositories.refusedForSize,
    ]).toLowerCase();
    for (const word of ['shortly', 'soon', 'retry', 'check back', 'will resolve']) {
      expect(copy).not.toContain(word);
    }
  });
});
