import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';
import { AddressRow } from '../../../workspace/public-address/_components/AddressRow';

// THE WORKSPACE ADDRESS, ECHOED (Story MOTIR-4528 · MOTIR-9515), built to
// `design/projects/public-address--workspace-echo.mock.html` panels A–C.
//
// A subdomain is a property of the WORKSPACE (ADR §3), so its control lives in
// workspace settings (MOTIR-9514). Project settings keeps a READ-ONLY echo — the
// same for every role — and a link to the control. It replaced
// `PublicSubdomainCard`, whose claim field, Rename and Remove belonged to the
// old per-project, alias-keeping rules.
//
// ⚠️ IT SHOWS THE WORKSPACE HOST, NOT A PROJECT PATH UNDER IT. The address
// decision (MOTIR-9790) moved public projects to `motir.co/p/<KEY>` and gives the
// workspace host to the default application, so `acme.motir.site/ROADMAP` is not
// this project's address any more.

export const WORKSPACE_ADDRESS_PATH = '/settings/workspace/public-address';

export async function PublicAddressEcho({
  subdomain,
  projectAddress,
  projectUrl,
}: {
  subdomain: PublicSubdomainDto | null;
  /** `motir.co/p/ROADMAP` — the project's own public address, read not followed. */
  projectAddress: string;
  projectUrl: string;
}) {
  const t = await getTranslations('settings.workspaceAddress');

  return (
    <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
      <header className="flex flex-col gap-1">
        <h2 className="font-sans text-[15px] font-semibold text-(--el-text)">{t('echo.title')}</h2>
        <p className="font-sans text-[13px] text-(--el-text-secondary)">
          {subdomain ? t('echo.claimedSub') : t('echo.noneSub')}
        </p>
      </header>

      {subdomain ? (
        <>
          <AddressRow host={subdomain.hostname} url={subdomain.url} />
          <p className="font-sans text-[13px] break-words text-(--el-text-secondary)">
            {t('echo.projectPage', { url: projectAddress })}
          </p>
        </>
      ) : (
        <AddressRow host={projectAddress} url={projectUrl} />
      )}

      <Link
        href={WORKSPACE_ADDRESS_PATH}
        className="self-start font-sans text-sm font-medium text-(--el-link) hover:underline"
      >
        {subdomain ? t('echo.change') : t('echo.claim')}
      </Link>
    </Card>
  );
}
