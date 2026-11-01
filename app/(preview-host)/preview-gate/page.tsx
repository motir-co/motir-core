import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  PreviewGateAction,
  PreviewGateCallout,
  PreviewGateFacts,
  PreviewGateFrame,
  PreviewGateHead,
  PreviewGateRefresh,
  PreviewGateSteps,
  PreviewHostChip,
} from '@/components/preview/PreviewGateFrame';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { knownFailureReason } from '@/lib/preview/failureReason';
import {
  GATE_COOKIE,
  gateSigningKey,
  isUnsupportedKind,
  previewHostOf,
  verifyGatePass,
} from '@/lib/preview/gate';
import { previewGateService, type PreviewGateView } from '@/lib/services/previewGateService';

// THE PREVIEW HOST's own pages (Story MOTIR-5766 · Subtask MOTIR-5779; design
// `design/preview/preview-gate.mock.html` Panels 4–8 and 6b). `proxy.ts` REWRITES
// every preview-host request it does not forward to this route, so the address
// bar keeps the path the viewer asked for.
//
// ⚠️ NOTHING HERE TRUSTS THE REWRITE. The page re-derives the host from the Host
// header and the viewer's standing from the gate cookie, so a direct request to
// `/preview-gate` on app.motir.co is a 404, and a viewer without a valid,
// host-bound cookie — a refused admission among them — sees Not found, which
// says nothing a stranger could not already know.
//
// Building and Starting refresh every 10 seconds with a `<meta>` refresh (no
// script): once the row is ready the proxy forwards the same address to the
// application instead of rewriting it here.

export const dynamic = 'force-dynamic';

const REFRESH_SECONDS = 10;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The host this request is for, and whether its viewer was let in. */
async function standing(): Promise<{ host: string; admitted: boolean }> {
  const host = previewHostOf((await headers()).get('host'));
  if (!host) notFound();
  const pass = verifyGatePass((await cookies()).get(GATE_COOKIE)?.value, host, gateSigningKey());
  return { host, admitted: pass !== null };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const t = await getTranslations('previewGate');
  const { host, admitted } = await standing();
  const view = admitted ? await previewGateService.view(host) : null;
  if (!view) return { title: t('notFound.title'), robots: { index: false } };
  if (isUnsupportedKind(first((await searchParams).unsupported))) {
    return { title: t('unsupported.title'), robots: { index: false } };
  }
  const title = {
    building: t('building.title'),
    starting: t('starting.title'),
    ready: t('starting.title'),
    failed: t('failed.title'),
    closed: t('closed.title'),
  }[view.state];
  return { title, robots: { index: false } };
}

export default async function PreviewGatePage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations('previewGate');
  const { host, admitted } = await standing();
  const view = admitted ? await previewGateService.view(host) : null;
  const unsupported = first((await searchParams).unsupported);

  const footer = t.rich('frame.footer', {
    host,
    chip: (chunks) => <PreviewHostChip>{chunks}</PreviewHostChip>,
  });

  return (
    <PreviewGateFrame tag={t('frame.tag')} brand={t('frame.brand')} footer={footer}>
      {view === null ? (
        <NotFound t={t} />
      ) : isUnsupportedKind(unsupported) ? (
        <>
          <PreviewGateHead
            pill={t('unsupported.pill')}
            pillKind="quiet"
            title={t('unsupported.title')}
          />
          <PreviewGateCallout tone="neutral">{t(`unsupported.${unsupported}`)}</PreviewGateCallout>
          <Facts t={t} view={view} />
          <PrimaryAction t={t} view={view} />
        </>
      ) : view.state === 'failed' ? (
        <Failed t={t} view={view} />
      ) : view.state === 'closed' ? (
        <Closed t={t} view={view} />
      ) : (
        <Building t={t} view={view} />
      )}
    </PreviewGateFrame>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'previewGate'>>>;

function Facts({ t, view }: { t: T; view: PreviewGateView }) {
  const rows = [
    ...(view.workItem
      ? [{ label: t('facts.workItem'), key: view.workItem.identifier, value: view.workItem.title }]
      : []),
    {
      label: t('facts.pullRequest'),
      value: t('facts.pullRequestValue', { repo: view.repository, n: view.pullRequestNumber }),
    },
  ];
  return <PreviewGateFacts rows={rows} />;
}

/** The work item when one is linked; the pull request on GitHub otherwise. */
function PrimaryAction({ t, view }: { t: T; view: PreviewGateView }) {
  return view.workItem ? (
    <PreviewGateAction href={view.workItem.url} external>
      {t('action.openWorkItem', { key: view.workItem.identifier })}
    </PreviewGateAction>
  ) : (
    <PreviewGateAction href={view.pullRequestUrl} external>
      {t('action.openPullRequest', { n: view.pullRequestNumber })}
    </PreviewGateAction>
  );
}

function Building({ t, view }: { t: T; view: PreviewGateView }) {
  // `ready` reaches here only when the release reported no address yet — the
  // viewer still waits, on the Starting step.
  const starting = view.state !== 'building';
  return (
    <>
      <meta httpEquiv="refresh" content={String(REFRESH_SECONDS)} />
      <PreviewGateHead
        pill={starting ? t('starting.pill') : t('building.pill')}
        pillKind="building"
        title={starting ? t('starting.title') : t('building.title')}
      >
        {starting ? t('starting.body') : t('building.body')}
      </PreviewGateHead>
      <PreviewGateSteps
        label={t('steps.label')}
        steps={[t('steps.build'), t('steps.start'), t('steps.ready')]}
        current={starting ? 1 : 0}
      />
      <PreviewGateRefresh>{t('building.refresh')}</PreviewGateRefresh>
      <Facts t={t} view={view} />
      <PrimaryAction t={t} view={view} />
    </>
  );
}

function Failed({ t, view }: { t: T; view: PreviewGateView }) {
  const stored = view.failureReason;
  const known = stored ? knownFailureReason(stored) : null;
  const reason = known
    ? t(`failed.reason.${known.key}`, known.values)
    : (stored ?? t('failed.reason.fallback'));
  return (
    <>
      <PreviewGateHead pill={t('failed.pill')} pillKind="failed" title={t('failed.title')}>
        {t('failed.body')}
      </PreviewGateHead>
      <PreviewGateCallout tone="danger" title={t('failed.reasonTitle')}>
        {reason}
      </PreviewGateCallout>
      <Facts t={t} view={view} />
      <PrimaryAction t={t} view={view} />
      {view.workItem ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('failed.checks')}</p>
      ) : null}
    </>
  );
}

function Closed({ t, view }: { t: T; view: PreviewGateView }) {
  const reason = view.closedReason ?? 'unknown';
  return (
    <>
      <PreviewGateHead pill={t('closed.pill')} pillKind="quiet" title={t('closed.title')}>
        {t(`closed.${reason}`, { n: view.pullRequestNumber })}
      </PreviewGateHead>
      <Facts t={t} view={view} />
      <PrimaryAction t={t} view={view} />
    </>
  );
}

/** Closed's layout with nothing it cannot know: no work item, no pull request. */
function NotFound({ t }: { t: T }) {
  return (
    <>
      <PreviewGateHead pill={t('notFound.pill')} pillKind="quiet" title={t('notFound.title')}>
        {t('notFound.body')}
      </PreviewGateHead>
      <PreviewGateAction href={resolveBaseUrlTrimmed()}>{t('notFound.home')}</PreviewGateAction>
    </>
  );
}
