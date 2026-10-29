import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { getSession } from '@/lib/auth';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import { PREVIEW_ACCESS_PATH } from '@/lib/preview/gate';
import { previewGateService } from '@/lib/services/previewGateService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { cn } from '@/lib/utils/cn';
import { SwitchAccountButton } from './_components/SwitchAccountButton';

// `/preview-access` — the preview gate's door on app.motir.co (Story MOTIR-5766 ·
// Subtask MOTIR-5779, MOTIR-5769 §9; design `design/preview/preview-gate.mock.html`
// Panels 1–3).
//
// A preview host sends every viewer without a gate cookie here with `host` and
// `return`. Signing in happens HERE, on Motir's real domain, never on the
// preview's:
//
//   signed out              → the shipped sign-in, which returns here (Panel 1)
//   held for 2FA enrolment  → the enrolment screen, which returns here
//   holds `project:browse`  → no page: a single-use admission and a redirect to
//                             the preview host, in the same response (Panel 2)
//   anyone else             → Refused (Panel 3) — and so is a host that is not a
//                             preview's, so the page reveals nothing
//
// `return` is never followed here: it is carried to the preview host inside the
// admission's URL, where `safeReturnPath` resolves it against that host only.

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('previewGate');
  return { title: t('refused.metaTitle'), robots: { index: false } };
}

export default async function PreviewAccessPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const host = first(params.host);
  const returnPath = first(params.return) || '/';
  const self = `${PREVIEW_ACCESS_PATH}?${new URLSearchParams({ host, return: returnPath }).toString()}`;

  const session = await getSession();
  if (!session) redirect(`/sign-in?${new URLSearchParams({ next: self }).toString()}`);

  // The 2FA hold applies here as on every signed-in surface: a held person is
  // not let into anything. This group is exempt from the layout-level gate
  // (`tests/navigation/two-factor-gate-coverage.test.ts`), so the page asks, and
  // sends the person back HERE once enrolled.
  if (!session.impersonation) {
    const requirement = await twoFactorPolicyService.resolveRequirement(session.user.id);
    if (requirement.required && !requirement.compliant) {
      redirect(`${TWO_FACTOR_REQUIRED_PATH}?${new URLSearchParams({ next: self }).toString()}`);
    }
  }

  const result = await previewGateService.admit({ userId: session.user.id, host, returnPath });
  if (result.admitted) redirect(result.url);

  const t = await getTranslations('previewGate');
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Pill severity="info" className="gap-1 self-start">
          <Lock className="h-3 w-3" aria-hidden />
          {t('refused.pill')}
        </Pill>
        <h1 className="font-serif text-3xl leading-tight font-semibold tracking-tight text-(--el-text)">
          {t('refused.title')}
        </h1>
        <p className="font-sans text-base text-(--el-text-secondary)">{t('refused.body')}</p>
      </header>
      <div className="flex flex-col gap-3">
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t.rich('refused.signedInAs', {
            email: session.user.email,
            strong: (chunks) => (
              <strong className="font-semibold text-(--el-text)">{chunks}</strong>
            ),
          })}
        </p>
        <Link href="/" className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-full')}>
          {t('refused.home')}
        </Link>
      </div>
      <footer className="flex flex-col items-start gap-2 border-t border-(--el-border) pt-(--spacing-md)">
        <SwitchAccountButton label={t('refused.switch')} next={self} />
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {t('refused.switchHint')}
        </span>
      </footer>
    </section>
  );
}
