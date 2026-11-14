'use client';

import { ErrorState } from '@motir/design-system';
import { ErrorReference } from './ErrorReference';
import type { ServerErrorCopy } from './serverErrorCopy';

// The server-error page's body, shared by all three boundaries (MOTIR-6855 ·
// design MOTIR-6854, `design/shell/server-error.mock.html`).
//
// It composes the design system's `ErrorState` DIRECTLY rather than the
// `@/components/ui/ErrorState` shim, because that shim reads `common.retry`
// through `useTranslations` and state 3 (`app/global-error.tsx`) renders with no
// `next-intl` provider at all. Every label arrives as a prop instead.
//
// `showHome` is states 2 and 3: with no shell around the page, it owes a door
// of its own. State 1 draws none — the rail and top bar ARE the way out.

export interface ServerErrorViewProps {
  copy: ServerErrorCopy;
  /**
   * What the reader quotes to support: the error's `digest` when the server
   * rendered it, else the Sentry event ID of the browser's report
   * (MOTIR-11243). Absent ⇒ no reference line.
   */
  reference?: string;
  onRetry: () => void;
  retryPending: boolean;
  showHome: boolean;
}

export function ServerErrorView({
  copy,
  reference,
  onRetry,
  retryPending,
  showHome,
}: ServerErrorViewProps) {
  return (
    <div className="flex w-full max-w-[30rem] flex-col items-center gap-(--spacing-sm)">
      <ErrorState
        className="w-full"
        title={copy.title}
        description={copy.body}
        retry={onRetry}
        retryLabel={copy.retry}
        retryPending={retryPending}
        retryPendingLabel={copy.retrying}
      />
      {showHome ? (
        // A DOCUMENT navigation, not a client one: the layout above this page
        // is what failed, so the way out reloads it rather than reusing it.
        // `/` then sends a signed-in reader to their landing and anyone else
        // to `/sign-in` (`app/page.tsx`).
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a
          href="/"
          className="text-(--el-link) font-sans text-sm underline underline-offset-2 hover:text-(--el-link-pressed)"
        >
          {copy.home}
        </a>
      ) : null}
      {reference ? (
        <ErrorReference
          reference={reference}
          label={copy.reference}
          copyLabel={copy.copyReference}
          copiedLabel={copy.copied}
        />
      ) : null}
    </div>
  );
}
