import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformCredentialsService } from '@/lib/services/platformCredentialsService';
import { CredentialsSection } from './_components/CredentialsSection';

/**
 * THE CONSOLE'S CREDENTIALS PAGE (MOTIR-9408, design MOTIR-11084,
 * `platform-admin/design-notes.md` § _AMENDMENT 2026-11-12 — Credentials_):
 * every credential in `CREDENTIAL_REGISTRY` with its declared expiry, days left
 * and verdict, judged the way `system.daily-health-check` judges it. Every
 * platform staff role reads it; anyone else gets the gate's 404.
 *
 * Read-only and server-rendered: each load is one synchronous `check()` over the
 * registry, so there is no loading state and no poll. No credential value is
 * read or rendered.
 */

export const metadata: Metadata = { title: 'Credentials' };

/** Never cached — every load judges against the current clock. */
export const dynamic = 'force-dynamic';

export default async function AdminCredentialsPage() {
  await requirePlatformStaffPage();
  const t = await getTranslations('platformAdmin.credentials');
  const read = platformCredentialsService.read();

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
      <CredentialsSection read={read} />
    </div>
  );
}
