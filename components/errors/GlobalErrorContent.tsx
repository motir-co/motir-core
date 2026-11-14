'use client';

import { useSyncExternalStore, useTransition } from 'react';
import { matchAcceptLanguage } from '@/lib/i18n/acceptLanguage';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { useReportCaughtError } from '@/lib/monitoring/reportCaughtError';
import { ServerErrorView } from './ServerErrorView';
import { GLOBAL_ERROR_COPY } from './serverErrorCopy';

// STATE 3's page body (MOTIR-6855 · design MOTIR-6854, panel 3): the root layout
// itself threw, so `app/global-error.tsx` renders in its place and wraps this in
// its own `<html>` / `<body>`. Kept apart from that file so it can be rendered
// and tested like any component — a test cannot mount a second `<html>`.
//
// No `next-intl` provider exists here (it lived in the layout that failed), so
// the locale is read the way `i18n/request.ts` resolves it for a signed-out
// request: the `NEXT_LOCALE` cookie, then the browser's WHOLE preference list
// through the same `matchAcceptLanguage` the server's step 3 uses (so `pt-BR`
// and `zh-TW` land where the server would put them), falling back to `en`.
// There is no session read here — the layout that would have held it failed.
// The server
// render answers `en`; the client corrects it on hydration without a mismatch
// (that is what `useSyncExternalStore`'s server snapshot is for).

function readLocale(): Locale {
  const cookie = document.cookie
    .split('; ')
    .find((pair) => pair.startsWith('NEXT_LOCALE='))
    ?.slice('NEXT_LOCALE='.length);
  if (isLocale(cookie)) return cookie;
  const preferred = navigator.languages?.length
    ? navigator.languages.join(',')
    : navigator.language;
  return matchAcceptLanguage(preferred) ?? defaultLocale;
}

const subscribe = () => () => {};

export function useGlobalErrorLocale(): Locale {
  return useSyncExternalStore(subscribe, readLocale, () => defaultLocale);
}

export function GlobalErrorContent({
  error,
  retry,
  locale,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  locale: Locale;
}) {
  const eventId = useReportCaughtError(error, 'global');
  const [retryPending, startRetry] = useTransition();

  return (
    <main className="mx-auto flex min-h-dvh max-w-[48rem] flex-col items-center justify-center px-(--spacing-lg) py-(--spacing-2xl)">
      <ServerErrorView
        copy={GLOBAL_ERROR_COPY[locale]}
        reference={error.digest ?? eventId}
        onRetry={() => startRetry(() => retry())}
        retryPending={retryPending}
        showHome
      />
    </main>
  );
}
