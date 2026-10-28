'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';

/**
 * THE WORKSPACE SUBDOMAIN CARD (Story MOTIR-3878 · MOTIR-4221) — design panels
 * 1 (unclaimed, with both refusals), 2 (claimed, the alias, the rename confirm)
 * and 8 (read-only). **Panels 10-13 are the RELEASE control** (Story MOTIR-4451
 * · MOTIR-4455), drawn by MOTIR-4453 against a render of this very component.
 *
 * ── ⚠️ RELEASE IS A THIRD ACT, AND IT HAS ITS OWN VERB ────────────────────
 *
 * ADR §8 **Amendment 2**: never-released is a rule about who may take a name
 * NEXT, not about who must keep SERVING it, so a workspace may un-claim its own.
 * `DELETE` on the same route (MOTIR-4454) takes the live label; how long its name
 * is held is §8 Amendment 3's rule, not this component's. It is a separate verb rather than a
 * `PUT { label: null }` because release is not a kind of naming.
 *
 * ── ⚠️ ONE FIELD, TWO ACTS, BECAUSE THE ROUTE IS ONE VERB ─────────────────
 *
 * `PUT /api/workspaces/{id}/public-subdomain` CLAIMS when the workspace has no
 * subdomain and RENAMES when it has one — the route's own note explains that
 * from the customer's side there is one control and which act it performs is a
 * fact about the server's state. So this component has one submit path and two
 * presentations, rather than two paths that could disagree about the payload.
 *
 * ── ⚠️ THE REFUSALS ARE MAPPED FROM CODES, NEVER FROM MESSAGES ────────────
 *
 * The service's errors carry a `code`, and `RESERVED_LABEL` additionally carries
 * a `refusal` DISCRIMINATOR — `reserved` and `bad_grammar` send a customer to
 * completely different next actions, which is exactly why MOTIR-4215 put it on
 * the wire rather than folding both into one sentence. Rendering the server's
 * English `error` string would throw the zh catalogue away and couple the pane
 * to prose; this maps the code and lets the catalogue speak.
 */

/** The refusal discriminator on `RESERVED_LABEL`, mapped to its copy key. */
const REFUSAL_KEY: Record<string, string> = {
  reserved: 'reserved',
  structurally_reserved: 'structurallyReserved',
  too_short: 'tooShort',
  too_long: 'tooLong',
  bad_grammar: 'badGrammar',
};

interface Refusal {
  readonly code?: string;
  readonly refusal?: string;
}

export function PublicSubdomainCard({
  workspaceId,
  baseDomain,
  projectIdentifier,
  publicSiteHost,
  fallbackAddress,
  subdomain,
  canManage,
}: {
  workspaceId: string;
  /** `motir.site` — the suffix the field shows and the preview is built from. */
  baseDomain: string;
  /** Only ever used to draw the live preview's example path. */
  projectIdentifier: string;
  /**
   * `motir.co` — the public site's HOST, and `motir.co/p/PROD` the address this
   * project falls back to once nothing is claimed (ADR §7's default-primary
   * table, first row).
   *
   * ⚠️ PASSED IN, NOT DERIVED HERE. The origin is `MOTIR_PUBLIC_SITE_URL`, which
   * is server configuration; a client component that guessed it would print a
   * different address than the one the product actually emits — on the single
   * sentence whose job is to tell a customer where their projects are about to
   * go.
   */
  publicSiteHost: string;
  fallbackAddress: string;
  subdomain: PublicSubdomainDto | null;
  /**
   * The WORKSPACE role's answer, not the project permission the rail row is
   * gated on — see the page's note. `false` renders panel 8: every address
   * visible, every control ABSENT rather than disabled.
   */
  canManage: boolean;
}) {
  const t = useTranslations('settings.publicAddress');
  const { toast } = useToast();
  const router = useRouter();

  const [label, setLabel] = useState(subdomain?.label ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const preview = `${label || 'acme'}.${baseDomain}/${projectIdentifier}`;

  /**
   * The hostname a release takes. A workspace holds one name and no aliases
   * (§8 Amendment 3), so this is the live label alone.
   */
  const releasedHostnames: ReadonlyArray<{ hostname: string; live: boolean }> = subdomain
    ? [{ hostname: subdomain.hostname, live: true }]
    : [];

  async function submit(next: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Refusal;
        setError(messageFor(body));
        return;
      }
      setRenaming(false);
      toast({ variant: 'success', title: t('subdomain.title') });
      // ⚠️ REFRESH RATHER THAN PATCH LOCAL STATE. A claim produces a DTO whose
      // fields are derived server-side, so re-reading is the only way the pane
      // and the store agree.
      router.refresh();
    } catch {
      setError(t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  function messageFor(body: Refusal): string {
    if (body.code === 'RESERVED_LABEL') {
      const key = REFUSAL_KEY[body.refusal ?? ''];
      return key ? t(`error.${key}`, { label }) : t('error.generic');
    }
    if (body.code === 'HOSTNAME_TAKEN') return t('error.taken', { label });
    if (body.code === 'SUBDOMAIN_FORBIDDEN') return t('error.forbidden');
    return t('error.generic');
  }

  /**
   * RELEASE the subdomain — the live label and every alias, gone for ever.
   *
   * ⚠️ `SUBDOMAIN_NOT_FOUND` IS NOT AN ERROR TO RENDER. It means this tab is
   * looking at a subdomain somebody else already released, so the honest
   * response is to show the customer the CURRENT state rather than a complaint
   * about one that no longer exists — the same reasoning as the success path,
   * which is why both refresh. It is also a DIFFERENT code from the rename
   * path's `NO_SUBDOMAIN_CLAIMED` (MOTIR-4454), and mapping it to that one's
   * copy would tell a customer their rename failed.
   */
  async function release(): Promise<void> {
    setSaving(true);
    setReleaseError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Refusal;
        if (body.code !== 'SUBDOMAIN_NOT_FOUND') {
          setReleaseError(
            body.code === 'SUBDOMAIN_FORBIDDEN' ? t('error.forbidden') : t('error.generic'),
          );
          return;
        }
      }
      setReleasing(false);
      // ⚠️ AND CLEAR THE FIELD, WHICH `router.refresh()` CANNOT DO — the
      // page-state contract's case 3, met exactly. `label` is a CLIENT island's
      // state seeded by `useState(subdomain?.label ?? '')`, and that initializer
      // runs ONCE at mount: the refresh below re-runs the server read and hands
      // down `subdomain: null`, but the local `label` keeps the released value.
      // The unclaimed pane then renders its claim field PRE-FILLED with the one
      // label that can never be claimed again, and its live preview promising an
      // address the next click refuses as taken. Found by the E2E walk
      // (MOTIR-4457); no component test sees it, because none of them remounts.
      setLabel('');
      setError(null);
      // ⚠️ REFRESH, NEVER PATCH — the same rule the claim path's comment states.
      router.refresh();
    } catch {
      setReleaseError(t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
      <header className="flex flex-col gap-1">
        <h2 className="font-sans text-[15px] font-semibold text-(--el-text)">
          {t('subdomain.title')}
        </h2>
        <p className="font-sans text-[13px] text-(--el-text-secondary)">
          {canManage ? t('subdomain.subtitle') : t('subdomain.readOnly')}
        </p>
      </header>

      {subdomain ? (
        <ClaimedRows
          subdomain={subdomain}
          projectIdentifier={projectIdentifier}
          canManage={canManage}
          onRename={() => {
            setLabel(subdomain.label);
            setError(null);
            setRenaming(true);
          }}
          onRelease={() => {
            setReleaseError(null);
            setReleasing(true);
          }}
        />
      ) : canManage ? (
        <div className="flex flex-col gap-4">
          <Input
            label={t('subdomain.label')}
            value={label}
            // ⚠️ THE REFUSAL IS CLEARED ON EDIT, and that is not tidiness. The
            // `Input` renders `error` INSTEAD of `helperText`, so a refusal that
            // survived typing would take the LIVE PREVIEW away — the customer
            // would fix the label and still be looking at the old complaint,
            // with no sight of the address they are about to own. Caught by the
            // acceptance walk (MOTIR-4225), which is the only test that types
            // twice.
            onChange={(e) => {
              setLabel(e.target.value);
              if (error) setError(null);
            }}
            addonEnd={
              <span className="font-mono text-[13px] text-(--el-text-secondary)">
                .{baseDomain}
              </span>
            }
            helperText={t('subdomain.helper', { preview })}
            error={error ?? undefined}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="md"
              loading={saving}
              disabled={label.trim() === ''}
              onClick={() => void submit(label.trim())}
            >
              {t('subdomain.claim')}
            </Button>
            <span className="font-sans text-[12px] text-(--el-text-secondary)">
              {t('subdomain.claimable')}
            </span>
          </div>
        </div>
      ) : (
        <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('subdomain.none')}</p>
      )}

      {/* The rename confirm — panel 2's right stage. It carries the ADR §8
          decision in the customer's words. The dated hold and the 30-day limit
          (§8 Amendment 3) are the workspace-settings control's (MOTIR-9514). */}
      <Modal
        open={renaming}
        onOpenChange={(open) => {
          setRenaming(open);
          if (!open) setError(null);
        }}
        title={t('rename.title')}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t('subdomain.label')}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (error) setError(null);
            }}
            addonEnd={
              <span className="font-mono text-[13px] text-(--el-text-secondary)">
                .{baseDomain}
              </span>
            }
            error={error ?? undefined}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-col gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x-16) py-(--spacing-card-padding-12)">
            <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
              {t('rename.warningTitle')}
            </span>
            <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
              {t('rename.warningBody', { old: subdomain?.hostname ?? '' })}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => setRenaming(false)}>
              {t('rename.cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={saving}
              disabled={label.trim() === '' || label.trim() === subdomain?.label}
              onClick={() => void submit(label.trim())}
            >
              {t('rename.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* The RELEASE confirm — design panels 10-13. A SIBLING of the domain
          remove confirm above it in `CustomDomainsSection`, not a new dialect:
          the archive-confirm grammar of a plain first line, the consequence in a
          rose callout, the reversibility last. Three things it does that the
          domain confirm does not, each because the asset requires it. */}
      <Modal
        open={releasing}
        onOpenChange={(open) => {
          setReleasing(open);
          if (!open) setReleaseError(null);
        }}
        title={t('release.title', { hostname: subdomain?.hostname ?? '' })}
      >
        {/* modal-scroll-container: measured 1280x700, tallest = a release after two renames: three hostnames listed, the warning with the cap sentence, the fallback line, panel 545px */}
        <div className="flex flex-col gap-4">
          <p className="font-sans text-[13px] text-(--el-text)">
            {t('release.lead', { count: releasedHostnames.length })}
          </p>

          {/* ⚠️ LISTED, NEVER SUMMARISED. A workspace that renamed twice gives up
              three names in one click, and somebody who forgot a rename from
              months ago will not think of the old name as theirs to lose until
              it is gone. `and any previous addresses` is the sentence this list
              exists instead of. */}
          <div className="flex flex-col gap-2">
            {releasedHostnames.map(({ hostname, live }) => (
              <ReleasedRow key={hostname} host={hostname} live={live} />
            ))}
          </div>

          <div className="flex flex-col gap-1.5 rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x-16) py-(--spacing-card-padding-12)">
            <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
              {t('release.warningTitle', { count: releasedHostnames.length })}
            </span>
            <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
              {t('release.warningBody')}
            </span>
          </div>

          {/* The UPSIDE, last. Release is almost always performed BY somebody who
              wants their projects back on the public site, and a confirm that
              describes only destruction makes the correct action feel like a
              mistake. */}
          <p className="font-sans text-[13px] text-(--el-text-secondary)">
            {t('release.fallback', { url: fallbackAddress, site: publicSiteHost })}
          </p>

          {releaseError ? (
            <p
              role="alert"
              className="font-sans text-[13px] font-medium text-(--el-danger-on-surface)"
            >
              {releaseError}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => setReleasing(false)}>
              {t('release.cancel')}
            </Button>
            <Button variant="danger" size="md" loading={saving} onClick={() => void release()}>
              {t('release.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** Panel 2's left stage, and panel 8's whole body — the addresses as rows. */
function ClaimedRows({
  subdomain,
  projectIdentifier,
  canManage,
  onRename,
  onRelease,
}: {
  subdomain: PublicSubdomainDto;
  projectIdentifier: string;
  canManage: boolean;
  onRename: () => void;
  onRelease: () => void;
}) {
  const t = useTranslations('settings.publicAddress');
  const { toast } = useToast();
  const live = `${subdomain.hostname}/${projectIdentifier}`;

  return (
    <div className="flex flex-col gap-2">
      <AddressRow
        host={live}
        pill={<Pill severity="success">{t('subdomain.active')}</Pill>}
        actions={
          <>
            <CopyButton
              value={`https://${live}`}
              label={t('subdomain.copy')}
              onCopied={() => toast({ variant: 'success', title: t('subdomain.copied') })}
            />
            <a
              href={subdomain.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t('subdomain.open')}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          </>
        }
      />

      {canManage ? (
        /* ⚠️ REMOVE JOINS THE RIGHT-HAND GROUP, beside Rename rather than at
           the opposite edge, so the two read as one pair of actions on the row.
           And Remove sits LEFT of Rename so the pointer travelling to the
           ordinary action never passes over the destructive one (design panel
           10). `ghost` is the weight `CustomDomainsSection` already gives its own
           Remove — one product, one weight for one act — and the danger colour
           belongs in the confirm, not on the trigger. */
        <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onRelease}>
              {t('release.remove')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onRename}>
              {t('subdomain.rename')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A hostname the confirm is about to release — the address row, WRAPPING.
 *
 * ⚠️ NOT {@link AddressRow}, and the difference is one class. That row
 * `truncate`s, and is right to: on the CARD a hostname is a LABEL for a row a
 * reader can copy, open or scroll to. **In the confirm the hostname IS the
 * message** — it is the thing being given up for ever, and a name a person
 * cannot finish reading is a name they cannot decide about. `break-words`
 * (`overflow-wrap: anywhere`) is what makes a 63-character label with no hyphen
 * in it legible at 390 px instead of ending in an ellipsis (design panel 13).
 *
 * Reusing `AddressRow` here is the path of least resistance: it compiles, it
 * renders, and it silently truncates the one string this modal exists to show.
 */
function ReleasedRow({ host, live }: { host: string; live: boolean }) {
  const t = useTranslations('settings.publicAddress');
  return (
    <div className="flex min-h-(--height-control) items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8)">
      <span className="min-w-0 flex-1 font-mono text-[13px] break-words text-(--el-text)">
        {host}
      </span>
      {live ? (
        <Pill severity="success">{t('subdomain.active')}</Pill>
      ) : (
        <Pill status="planned">
          <span className="hidden sm:inline">{t('subdomain.alias')}</span>
          <span className="sm:hidden">{t('subdomain.aliasShort')}</span>
        </Pill>
      )}
    </div>
  );
}

function AddressRow({
  host,
  pill,
  actions,
}: {
  host: string;
  pill: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-(--height-control) items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8)">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">{host}</span>
      {pill}
      {actions}
    </div>
  );
}

function CopyButton({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  onCopied: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(onCopied);
      }}
      className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
    >
      <Copy className="h-4 w-4" aria-hidden />
    </button>
  );
}
