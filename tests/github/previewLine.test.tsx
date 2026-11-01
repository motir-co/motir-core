// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { PreviewLine, previewRowState } from '@/components/github/PreviewLine';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto, LinkedPullRequestPreviewDto } from '@/lib/dto/github';

// THE PREVIEW LINE on a pull request's row (Story MOTIR-5766 · MOTIR-10099; design
// `design/github/github--pr-row-preview.mock.html`, `design-notes.md` § 31,
// Panels P1–P8). A pure render of the DTO: the word per state, the reason on a
// failed preview, the host as a link only when it is ready, and nothing at all
// when the pull request has no preview.

afterEach(cleanup);

const HOST = 'pr-41--acme-svc.preview.motir.site';

function preview(over: Partial<LinkedPullRequestPreviewDto> = {}): LinkedPullRequestPreviewDto {
  return { state: 'ready', host: HOST, failureReason: null, url: `https://${HOST}`, ...over };
}

const line = () => screen.getByTestId('pr-row-preview');

describe('previewRowState', () => {
  it('is total over any string', () => {
    expect(previewRowState('building')).toMatchObject({ word: 'building', link: false });
    expect(previewRowState('starting')).toMatchObject({ word: 'building', link: false });
    expect(previewRowState('ready')).toMatchObject({ word: 'ready', link: true });
    expect(previewRowState('failed')).toMatchObject({ word: 'failed', link: false });
    expect(previewRowState('closed')).toMatchObject({ word: 'closed', link: false });
    expect(previewRowState('paused')).toMatchObject({ word: 'unknown', link: false });
    expect(previewRowState('')).toMatchObject({ word: 'unknown', link: false });
  });

  it('gives building and starting the same glyph, and each other state its own', () => {
    const glyphs = ['building', 'ready', 'failed', 'closed', 'paused'].map(
      (s) => previewRowState(s).glyph,
    );
    expect(new Set(glyphs).size).toBe(5);
    expect(previewRowState('starting').glyph).toBe(previewRowState('building').glyph);
  });
});

describe('PreviewLine', () => {
  it('draws nothing for a pull request with no preview', () => {
    const { container } = render(<PreviewLine preview={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('a ready preview names itself and links its host in a new tab', () => {
    render(<PreviewLine preview={preview()} />);
    expect(line().dataset.previewState).toBe('ready');
    expect(line().textContent).toBe(`Preview ready ${HOST}`);
    const link = within(line()).getByRole('link', { name: HOST });
    expect(link.getAttribute('href')).toBe(`https://${HOST}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.className).toContain('text-(--el-link)');
  });

  it.each([
    ['building', 'Preview building'],
    ['starting', 'Preview building'],
    ['closed', 'Preview closed'],
    ['failed', 'Preview failed'],
  ])('%s draws “%s” and no link', (state, text) => {
    render(<PreviewLine preview={preview({ state })} />);
    expect(line().dataset.previewState).toBe(state);
    expect(line().textContent).toBe(text);
    expect(within(line()).queryByRole('link')).toBeNull();
  });

  it('a state this build does not know draws its own raw word', () => {
    render(<PreviewLine preview={preview({ state: 'paused' })} />);
    expect(line().textContent).toBe('Preview paused');
    expect(within(line()).queryByRole('link')).toBeNull();
  });

  it('a failed preview shows a stored reason verbatim, in the secondary ink', () => {
    const reason = 'Fly answered 422: machine size not available in ams.';
    render(<PreviewLine preview={preview({ state: 'failed', failureReason: reason })} />);
    expect(line().textContent).toBe(`Preview failed · ${reason}`);
    const tone = within(line()).getByText(reason);
    expect(tone.className).toBe('text-(--el-text-secondary)');
  });

  it('a reason the lifecycle wrote from a template reads in the viewer’s language', () => {
    const stored = 'The preview did not pass its health check within 5 minutes.';
    render(<PreviewLine preview={preview({ state: 'failed', failureReason: stored })} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    const zhReason = (zhMessages.previewGate.failed.reason.healthTimeout as string).replace(
      '{minutes}',
      '5',
    );
    expect(line().textContent).toBe(`预览失败 · ${zhReason}`);
    expect(line().textContent).not.toContain('health check');
  });

  it('draws the zh words', () => {
    render(<PreviewLine preview={preview()} />, { locale: 'zh', messages: zhMessages });
    expect(line().textContent).toBe(`预览已就绪 ${HOST}`);
  });

  it('carries no muted ink — it fails AA on the row’s surface', () => {
    render(<PreviewLine preview={preview({ state: 'failed', failureReason: 'x' })} />);
    expect(line().outerHTML).not.toContain('--el-text-muted');
    expect(line().outerHTML).not.toContain('--el-text-faint');
  });
});

describe('the row draws the line under its meta line', () => {
  function pr(n: number, p: LinkedPullRequestPreviewDto | null): LinkedPullRequestDto {
    return {
      id: `pr-${n}`,
      title: `Change ${n}`,
      repo: 'acme/svc',
      number: n,
      state: 'open',
      ci: 'passing',
      headSha: null,
      url: `https://github.com/acme/svc/pull/${n}`,
      githubReview: null,
      preview: p,
      baseRef: 'main',
      conflicted: false,
    };
  }

  it('only the row with a preview carries one, after its meta line', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[pr(41, preview()), pr(42, null)]}
        itemIdentifier="ACME-1"
      />,
    );
    const lines = screen.getAllByTestId('pr-row-preview');
    expect(lines).toHaveLength(1);
    const meta = screen.getByText(/acme\/svc · #41/);
    expect(meta.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lines[0]!.parentElement).toBe(meta.parentElement);
  });
});
