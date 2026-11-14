// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { join } from 'node:path';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { locales } from '@/lib/i18n/locales';

// MOTIR-6855 (Bug MOTIR-6776 · design MOTIR-6854) — the three error boundaries.
//
// What is asserted, per boundary: the drawn copy renders; Retry calls
// `retry` (not `reset`, which would re-render the failed server segment
// from the same client state); the caught error is reported to Sentry EXACTLY
// ONCE per error instance, tagged with its digest; the reference line shows the
// digest and disappears when there is none; only the shell-less states offer
// "Go to Motir". Plus the two seams state 3 needs because it has no `next-intl`
// provider: its static copy equals the catalogs, and it picks its locale from
// `NEXT_LOCALE`.
//
// MOTIR-11243: an error thrown in the BROWSER has no digest, so the reference is
// the Sentry event ID of the boundary's report; a digest still wins when there
// is one; and with Sentry off there is no reference at all. That the event the
// ID names actually reaches Sentry is `tests/monitoring/caught-error-event.test.ts`.

const sentry = vi.hoisted(() => {
  const scope = { setTags: vi.fn(), addEventProcessor: vi.fn() };
  return {
    scope,
    captureException: vi.fn<(error: unknown) => string>(),
    isEnabled: vi.fn<() => boolean>(),
    withScope: vi.fn((callback: (s: typeof scope) => unknown) => callback(scope)),
  };
});
vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  isEnabled: sentry.isEnabled,
  withScope: sentry.withScope,
}));
const { captureException } = sentry;

/** The tags the boundary's report was captured with, call by call. */
function reportedTags(): unknown[] {
  return sentry.scope.setTags.mock.calls.map(([tags]) => tags);
}

import AuthedError from '@/app/(authed)/error';
import AppError from '@/app/error';
import { GlobalErrorContent, useGlobalErrorLocale } from '@/components/errors/GlobalErrorContent';
import { GLOBAL_ERROR_COPY } from '@/components/errors/serverErrorCopy';
import { ErrorReference } from '@/components/errors/ErrorReference';
import { ErrorState } from '@motir/design-system';

function digestError(digest?: string): Error & { digest?: string } {
  const error = new Error('An error occurred in the Server Components render.') as Error & {
    digest?: string;
  };
  if (digest) error.digest = digest;
  return error;
}

let nextEventId = 0;
beforeEach(() => {
  captureException.mockReset();
  captureException.mockImplementation(() => `evt${(nextEventId += 1)}`);
  sentry.isEnabled.mockReset();
  sentry.isEnabled.mockReturnValue(true);
  sentry.scope.setTags.mockReset();
  sentry.scope.addEventProcessor.mockReset();
});
afterEach(() => {
  cleanup();
  document.cookie = 'NEXT_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('app/(authed)/error.tsx — state 1, a page failed inside the shell', () => {
  it('renders the page copy, retries through the retry prop, and draws no second door', () => {
    const retry = vi.fn();
    renderWithIntl(<AuthedError error={digestError('3a91f0c2')} retry={retry} />);

    expect(screen.getByRole('alert').textContent).toMatch(enMessages.errors.serverError.pageTitle);
    expect(screen.queryByRole('link', { name: enMessages.errors.notFound.homeAction })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: enMessages.common.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('reports the caught error to Sentry once, tagged with its digest, across re-renders', () => {
    const error = digestError('3a91f0c2');
    const { rerender } = renderWithIntl(<AuthedError error={error} retry={vi.fn()} />);
    rerender(<AuthedError error={error} retry={vi.fn()} />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error);
    expect(reportedTags()).toEqual([
      { boundary: 'error-boundary:authed-page', digest: '3a91f0c2' },
    ]);
  });

  it('reports a retry that failed again as a NEW failure with its new reference', () => {
    const { rerender } = renderWithIntl(
      <AuthedError error={digestError('3a91f0c2')} retry={vi.fn()} />,
    );
    rerender(<AuthedError error={digestError('b07e4d19')} retry={vi.fn()} />);

    expect(captureException).toHaveBeenCalledTimes(2);
    expect(screen.getByText('b07e4d19')).toBeTruthy();
    expect(screen.queryByText('3a91f0c2')).toBeNull();
  });

  it('shows the Sentry event ID as the reference for a browser error with no digest', () => {
    captureException.mockReturnValueOnce('9f2c4e1ab3d84c6f8e0a7b5d2c1f3e4a');
    renderWithIntl(<AuthedError error={digestError()} retry={vi.fn()} />);

    expect(screen.getByText(enMessages.errors.serverError.reference)).toBeTruthy();
    expect(screen.getByText('9f2c4e1ab3d84c6f8e0a7b5d2c1f3e4a')).toBeTruthy();
    expect(reportedTags()).toEqual([{ boundary: 'error-boundary:authed-page' }]);
  });

  it('keeps showing the digest for a server error, not the event ID', () => {
    captureException.mockReturnValueOnce('9f2c4e1ab3d84c6f8e0a7b5d2c1f3e4a');
    renderWithIntl(<AuthedError error={digestError('3a91f0c2')} retry={vi.fn()} />);

    expect(screen.getByText('3a91f0c2')).toBeTruthy();
    expect(screen.queryByText('9f2c4e1ab3d84c6f8e0a7b5d2c1f3e4a')).toBeNull();
  });

  it('shows no reference line when Sentry is off and the error carries no digest', () => {
    sentry.isEnabled.mockReturnValue(false);
    renderWithIntl(<AuthedError error={digestError()} retry={vi.fn()} />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(enMessages.errors.serverError.reference)).toBeNull();
  });

  it('copies the event ID from the reference line of a browser error', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    captureException.mockReturnValueOnce('0b7d2e9c41a64f3c9d8e1f2a3b4c5d6e');
    renderWithIntl(<AuthedError error={digestError()} retry={vi.fn()} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: enMessages.errors.serverError.copyReference }),
      );
    });
    expect(writeText).toHaveBeenCalledWith('0b7d2e9c41a64f3c9d8e1f2a3b4c5d6e');
  });
});

describe('app/error.tsx — state 2, the signed-in shell failed', () => {
  it('renders the app copy, the digest, and Go to Motir as a document link to /', () => {
    const retry = vi.fn();
    renderWithIntl(<AppError error={digestError('3a91f0c2')} retry={retry} />);

    expect(screen.getByRole('alert').textContent).toMatch(enMessages.errors.serverError.appTitle);
    expect(
      screen
        .getByRole('link', { name: enMessages.errors.notFound.homeAction })
        .getAttribute('href'),
    ).toBe('/');
    expect(screen.getByText('3a91f0c2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: enMessages.common.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(reportedTags()).toEqual([{ boundary: 'error-boundary:app', digest: '3a91f0c2' }]);
  });

  it('shows the Sentry event ID when the shell failed in the browser', () => {
    captureException.mockReturnValueOnce('5e6f7a8b9c0d4e1f8a2b3c4d5e6f7a8b');
    renderWithIntl(<AppError error={digestError()} retry={vi.fn()} />);
    expect(screen.getByText('5e6f7a8b9c0d4e1f8a2b3c4d5e6f7a8b')).toBeTruthy();
  });

  it('renders in zh from the zh catalog', () => {
    renderWithIntl(<AppError error={digestError('3a91f0c2')} retry={vi.fn()} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByRole('alert').textContent).toMatch(zhMessages.errors.serverError.appTitle);
    expect(screen.getByRole('button', { name: zhMessages.common.retry })).toBeTruthy();
  });
});

describe('app/global-error.tsx — state 3, the root failed (no next-intl provider)', () => {
  it('renders with NO intl provider, reports once, and offers Go to Motir', () => {
    const retry = vi.fn();
    render(<GlobalErrorContent error={digestError('3a91f0c2')} retry={retry} locale="en" />);

    expect(screen.getByRole('alert').textContent).toMatch(GLOBAL_ERROR_COPY.en.title);
    expect(screen.getByRole('link', { name: GLOBAL_ERROR_COPY.en.home }).getAttribute('href')).toBe(
      '/',
    );
    fireEvent.click(screen.getByRole('button', { name: GLOBAL_ERROR_COPY.en.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(reportedTags()).toEqual([{ boundary: 'error-boundary:global', digest: '3a91f0c2' }]);
  });

  // The 2026-11-13 22:11 page: a script that failed to load after a deploy took
  // the root down in the browser, and the page promised a reference it never drew.
  it('shows the Sentry event ID for a browser error with no digest, and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    captureException.mockReturnValueOnce('c3d4e5f60718493a8b7c6d5e4f3a2b1c');
    const chunkError = new Error(
      'Failed to load chunk /_next/static/chunks/0u6a5fatitug2.js from module 41',
    );
    chunkError.name = 'ChunkLoadError';
    render(<GlobalErrorContent error={chunkError} retry={vi.fn()} locale="en" />);

    expect(screen.getByText(GLOBAL_ERROR_COPY.en.reference)).toBeTruthy();
    expect(screen.getByText('c3d4e5f60718493a8b7c6d5e4f3a2b1c')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: GLOBAL_ERROR_COPY.en.copyReference }));
    });
    expect(writeText).toHaveBeenCalledWith('c3d4e5f60718493a8b7c6d5e4f3a2b1c');
  });

  it('server-renders no event-ID reference: the report, and its ID, exist only after commit', () => {
    const html = renderToString(
      <GlobalErrorContent error={digestError()} retry={vi.fn()} locale="en" />,
    );
    expect(html).toContain(GLOBAL_ERROR_COPY.en.title);
    expect(html).not.toContain(GLOBAL_ERROR_COPY.en.reference);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('picks zh from the NEXT_LOCALE cookie and en otherwise', () => {
    function Probe() {
      return <span data-testid="locale">{useGlobalErrorLocale()}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('locale').textContent).toMatch(/^(en|zh)$/);
    unmount();

    document.cookie = 'NEXT_LOCALE=zh';
    render(<Probe />);
    expect(screen.getByTestId('locale').textContent).toMatch('zh');
  });

  // MOTIR-7757: with no cookie the browser's WHOLE preference list is matched the
  // way the server's step 3 matches Accept-Language, so a regional variant lands
  // on its base language instead of falling through to English.
  it('matches the browser preference list when there is no cookie (pt-BR → pt)', () => {
    const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR', 'en']);
    try {
      function Probe() {
        return <span data-testid="locale">{useGlobalErrorLocale()}</span>;
      }
      render(<Probe />);
      expect(screen.getByTestId('locale').textContent).toBe('pt');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps its static copy equal to the catalogs, key for key, in every locale', () => {
    for (const locale of locales) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
      ) as {
        common: { retry: string };
        errors: {
          notFound: { homeAction: string };
          serverError: Record<
            'appTitle' | 'appBody' | 'retrying' | 'reference' | 'copyReference' | 'copied',
            string
          >;
        };
      };
      const s = messages.errors.serverError;
      expect(GLOBAL_ERROR_COPY[locale]).toEqual({
        title: s.appTitle,
        body: s.appBody,
        retry: messages.common.retry,
        retrying: s.retrying,
        home: messages.errors.notFound.homeAction,
        reference: s.reference,
        copyReference: s.copyReference,
        copied: s.copied,
      });
    }
  });
});

describe('the pieces the boundaries compose', () => {
  it('ErrorState retryPending puts the retry button in its loading state with the pending label', () => {
    render(
      <ErrorState
        title="t"
        retry={vi.fn()}
        retryLabel="Try again"
        retryPending
        retryPendingLabel="Trying again…"
      />,
    );
    const button = screen.getByRole('button', { name: 'Trying again…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('ErrorReference copies the digest and confirms with a status', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <ErrorReference
        reference="3a91f0c2"
        label="Reference"
        copyLabel="Copy reference"
        copiedLabel="Copied"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    });
    expect(writeText).toHaveBeenCalledWith('3a91f0c2');
    expect(screen.getByRole('status').textContent).toMatch('Copied');
  });
});
