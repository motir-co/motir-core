'use client';

import { useTransition } from 'react';
import { ServerErrorView } from '@/components/errors/ServerErrorView';
import { useServerErrorCopy } from '@/components/errors/useServerErrorCopy';
import { useReportCaughtError } from '@/lib/monitoring/reportCaughtError';

// STATE 1 of the server-error page (MOTIR-6855 · design MOTIR-6854,
// `design/shell/server-error.mock.html` panels 1 / 1a / 1b): a PAGE under
// `(authed)` threw during its render, and the shell around it survived.
//
// ⚠️ THIS FILE DOES NOT CATCH `app/(authed)/layout.tsx`. A segment's boundary
// wraps its CHILDREN, never its own layout — so a throw in the shell itself (the
// P2028 stall of Bug MOTIR-6776, at `layout.tsx`'s `listProjects` read) falls
// through to `app/error.tsx`, one segment up.
//
// Retry is the boundary's `retry` prop (`unstable_retry` before Next 16.3),
// not `reset`: `reset()` only clears the boundary and
// re-renders its children from what the client already holds, so a SERVER
// render failure would throw again unchanged. `retry` refreshes the
// router and resets inside one transition (`next/dist/client/components/
// error-boundary.js`) — it re-fetches the segment, which is the point of trying
// again. Wrapping it in our own transition is what gives the button its pending
// state (design panel 1a) for as long as that re-fetch takes.
//
// `notFound()` and `redirect()` never reach here: Next re-throws its own router
// errors past an error boundary (`getDerivedStateFromError`), so a missing work
// item still 404s through `app/(authed)/not-found.tsx`.

export default function AuthedError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const eventId = useReportCaughtError(error, 'authed-page');
  const copy = useServerErrorCopy('page');
  const [retryPending, startRetry] = useTransition();

  return (
    <div className="flex w-full justify-center px-(--spacing-lg) py-(--spacing-2xl)">
      <ServerErrorView
        copy={copy}
        reference={error.digest ?? eventId}
        onRetry={() => startRetry(() => retry())}
        retryPending={retryPending}
        showHome={false}
      />
    </div>
  );
}
