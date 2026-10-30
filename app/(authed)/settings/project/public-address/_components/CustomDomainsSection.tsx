'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { DnsInstructionDto, PublicAddressDto } from '@/lib/dto/publicAddresses';

/**
 * THE CUSTOMER-DOMAIN LIST (Story MOTIR-3878 · MOTIR-4229) — design panels 3,
 * 3b, 4, 5, 6, 7 and 9, over MOTIR-4216's lifecycle routes, showing what
 * MOTIR-4219's job last wrote.
 *
 * ── ⚠️ THE STATE MAP IS A TOTAL `Record`, AND THAT IS THE POINT ───────────
 *
 * `PublicAddressStatus` has nine values. Two of them belong to the SUBDOMAIN and
 * never appear in this list, and the map says so rather than omitting them — an
 * omission is indistinguishable from an oversight, and the enum growing a tenth
 * value must be a COMPILE error here rather than a row that renders blank. The
 * design draws all nine for the same reason.
 *
 * ── ⚠️ THE HUE IS NEVER THE MEANING ──────────────────────────────────────
 *
 * `failed`, `expired` and `revoked` all take the rose tint. Three states sharing
 * one tone is deliberate (the asset's own note): they are told apart by their
 * words and by the action beside them, and a reader who sees only the hue learns
 * "something is wrong", which is true of all three.
 */

type DomainStatus = PublicAddressDto['status'];
type RowAction = 'showDns' | 'checkAgain' | 'requestAgain' | 'remove';

interface StateRow {
  /** The `Pill` variant. `severity` covers every tone this list needs. */
  readonly severity: 'info' | 'success' | 'warning' | 'danger' | null;
  /** Actions offered BESIDE the row, in the order the design draws them. */
  readonly actions: readonly RowAction[];
  /** Whether this value can appear in the CUSTOMER-DOMAIN list at all. */
  readonly inList: boolean;
}

/**
 * Every value, with the tone and the actions the design's panel 5 draws.
 * TOTAL over the enum — see the note above.
 */
const STATES: Record<DomainStatus, StateRow> = {
  // The two subdomain states. They are the other card's, and they are named here
  // so the map is total rather than merely long enough.
  active: { severity: 'success', actions: [], inList: false },
  alias: { severity: null, actions: [], inList: false },

  unverified: { severity: 'warning', actions: ['showDns', 'checkAgain', 'remove'], inList: true },
  verifying: { severity: 'info', actions: ['checkAgain', 'remove'], inList: true },
  pending_certificate: { severity: 'info', actions: ['checkAgain', 'remove'], inList: true },
  issued: { severity: 'success', actions: ['remove'], inList: true },
  failed: { severity: 'danger', actions: ['showDns', 'checkAgain', 'remove'], inList: true },
  expired: { severity: 'danger', actions: ['showDns', 'checkAgain', 'remove'], inList: true },
  revoked: { severity: 'danger', actions: ['requestAgain', 'remove'], inList: true },
};

/** The statuses whose next state is written by the JOB rather than by a click. */
const PENDING: ReadonlySet<DomainStatus> = new Set<DomainStatus>([
  'verifying',
  'pending_certificate',
]);

/** How often the pane re-reads while the job still owes it a state change. */
const TICK_MS = 30_000;

export function CustomDomainsSection({
  workspaceId,
  canManage,
  addresses,
}: {
  /** The workspace the domains belong to — the routes are workspace-scoped. */
  workspaceId: string;
  /**
   * Whether the viewer may add, verify and remove — the workspace ADDRESS gate
   * (an owner or admin), the same gate every write route asserts. The page
   * computes it from the viewer's workspace role; a project's own access keys
   * no longer decide anything here, because the domain belongs to the
   * workspace, not to the project.
   */
  canManage: boolean;
  addresses: readonly PublicAddressDto[];
}) {
  const t = useTranslations('settings.publicAddress.domains');
  const { toast } = useToast();
  const router = useRouter();

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PublicAddressDto | null>(null);
  const [showDnsFor, setShowDnsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capped, setCapped] = useState(false);

  const domains = addresses.filter((a) => STATES[a.status].inList);
  const pending = domains.some((a) => PENDING.has(a.status));

  // ⚠️ THE TICK EXISTS BECAUSE THE NEXT STATE IS NOT OURS TO WRITE. `verifying`
  // and `pending_certificate` end when MOTIR-4219's job sees the platform change
  // its mind — no click of the customer's produces it. Without this the pane
  // shows "Issuing…" until somebody reloads, which reads as a stuck product.
  // It STOPS when nothing is pending, so a settled pane costs nothing.
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => router.refresh(), TICK_MS);
    return () => window.clearInterval(id);
  }, [pending, router]);

  async function call(path: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/custom-domains${path}`,
        {
          method,
          ...(body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        },
      );
      if (!res.ok) {
        const refusal = (await res.json().catch(() => ({}))) as { entitlement?: string };
        // The cap refusal is the upgrade prompt's TRIGGER — see the note on the
        // prompt below for why the button is not pre-disabled instead.
        if (res.status === 402 && refusal.entitlement === 'custom_domains') {
          setCapped(true);
          setAdding(false);
          return false;
        }
        toast({ variant: 'error', title: t('error') });
        return false;
      }
      router.refresh();
      return true;
    } catch {
      toast({ variant: 'error', title: t('error') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      header={
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
            <p className="font-sans text-xs text-(--el-text-muted)">{t('subtitle')}</p>
          </div>
          {canManage ? (
            <Button variant="primary" size="md" onClick={() => setAdding(true)}>
              {t('add')}
            </Button>
          ) : null}
        </div>
      }
    >
      {/* ⚠️ THE UPGRADE PROMPT IS TRIGGERED BY THE REFUSAL, NOT BY A TIER READ,
          AND THAT IS A DELIBERATE DEPARTURE FROM THE CARD. The card asks for
          *Add a domain* to be pre-disabled when the tier allows zero.
          `entitlementsService.assertCanAddCustomDomain` records the opposite
          decision in terms: "`free: 0` means this refuses the FIRST domain
          rather than the sixth, which is deliberate — it makes
          `EntitlementExceededError('custom_domains', …)` the upgrade prompt's
          trigger INSTEAD OF an empty state the pane special-cases." Pre-disabling
          would need the pane to read the tier and re-derive the cap, which is the
          second copy of a billing rule that note exists to prevent. The free-tier
          reader still meets panel 3b's callout — one click earlier than a reload,
          and without this component knowing what a plan is. */}
      {capped ? (
        <div className="mb-4 flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-tint-lavender) p-(--spacing-card-padding)">
          <span className="font-sans text-sm font-semibold text-(--el-text-strong)">
            {t('upgrade.title')}
          </span>
          <span className="font-sans text-xs leading-[1.6] text-(--el-text-strong)">
            {t('upgrade.body')}
          </span>
          <Link
            href="/settings/organization/billing"
            className="mt-1 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('upgrade.cta')}
          </Link>
        </div>
      ) : null}

      {domains.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.body')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {domains.map((address) => (
            <DomainRow
              key={address.id}
              address={address}
              canManage={canManage}
              busy={busy}
              dnsOpen={showDnsFor === address.id}
              onToggleDns={() =>
                setShowDnsFor((current) => (current === address.id ? null : address.id))
              }
              onCheck={() => void call(`/${address.id}/verify`, 'POST')}
              onRemove={() => setRemoving(address)}
            />
          ))}
        </ul>
      )}

      <AddDomainModal
        open={adding}
        busy={busy}
        onOpenChange={setAdding}
        onSubmit={(hostname) => call('', 'POST', { hostname })}
      />

      <Modal
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t('removeModal.title', { hostname: removing.hostname }) : ''}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x-16) py-(--spacing-card-padding-12)">
            <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
              {t('removeModal.warningTitle')}
            </span>
            <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
              {t('removeModal.warningBody', { hostname: removing?.hostname ?? '' })}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => setRemoving(null)}>
              {t('removeModal.cancel')}
            </Button>
            <Button
              variant="danger"
              size="md"
              loading={busy}
              onClick={async () => {
                if (removing && (await call(`/${removing.id}`, 'DELETE'))) {
                  setRemoving(null);
                }
              }}
            >
              {t('removeModal.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function DomainRow({
  address,
  canManage,
  busy,
  dnsOpen,
  onToggleDns,
  onCheck,
  onRemove,
}: {
  address: PublicAddressDto;
  canManage: boolean;
  busy: boolean;
  dnsOpen: boolean;
  onToggleDns: () => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('settings.publicAddress.domains');
  const state = STATES[address.status];
  const label = t(`state.${address.status}.label`);

  const handler: Record<RowAction, () => void> = {
    showDns: onToggleDns,
    checkAgain: onCheck,
    requestAgain: onCheck,
    remove: onRemove,
  };

  return (
    <li
      data-status={address.status}
      className="flex flex-col gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">
          {address.hostname}
        </span>
        {state.severity ? <Pill severity={state.severity}>{label}</Pill> : <Pill>{label}</Pill>}
      </div>

      <p className="font-sans text-[12px] leading-[1.6] text-(--el-text-secondary)">
        {t(`state.${address.status}.hint`)}
        {/* ⚠️ `failureReason` IS RENDERED, never summarised away. A failure with
            no reason is not actionable, which is why MOTIR-4209 stores it and
            MOTIR-4219 writes it. */}
        {address.failureReason ? ` ${address.failureReason}` : ''}
      </p>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {state.actions.map((action) => (
            <ActionButton
              key={action}
              action={action}
              label={t(`action.${action}`)}
              disabled={busy}
              onClick={handler[action]}
            />
          ))}
        </div>
      ) : null}

      {dnsOpen ? <DnsTable verification={address.verification} dns={address.dns} /> : null}
    </li>
  );
}

function ActionButton({
  action,
  label,
  disabled,
  onClick,
}: {
  action: RowAction;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={action === 'remove' ? 'ghost' : 'secondary'}
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** Panel 4's instruction block — the records the customer has to create. */
function DnsTable({
  verification,
  dns,
}: {
  verification: PublicAddressDto['verification'];
  dns: readonly DnsInstructionDto[];
}) {
  const t = useTranslations('settings.publicAddress.domains');
  // ⚠️ `dns` ALREADY CONTAINS THE OWNERSHIP RECORD. `customDomainService`'s
  // mapper pushes `verification` into the array and also exposes it on its own
  // field, so concatenating the two rendered the same TXT TWICE — a customer
  // reading "create these two records" and seeing one record listed twice would
  // reasonably create it twice, or go looking for the difference. Found by the
  // acceptance walk (MOTIR-4225); `verification` survives here only as the
  // fallback for a payload that carries the token and an empty array.
  const rows: DnsInstructionDto[] = dns.length
    ? [...dns]
    : verification
      ? [{ type: 'TXT' as const, ...verification }]
      : [];
  if (rows.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-2">
      <p className="font-sans text-[12px] font-semibold text-(--el-text)">
        {t('addModal.recordsHeading', { count: rows.length })}
      </p>
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="font-sans text-[11px] text-(--el-text-secondary)">
            <th className="w-[16%] pb-1 font-medium">{t('addModal.type')}</th>
            <th className="w-[30%] pb-1 font-medium">{t('addModal.name')}</th>
            <th className="pb-1 font-medium">{t('addModal.value')}</th>
            <th className="w-[10%]" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.type}-${row.name}-${row.value}`} className="align-top">
              <td className="py-1 font-mono text-[12px] text-(--el-text)">{row.type}</td>
              <td className="py-1 pr-2 font-mono text-[12px] break-all text-(--el-text)">
                {row.name}
              </td>
              <td className="py-1 pr-2 font-mono text-[12px] break-all text-(--el-text)">
                {row.value}
              </td>
              <td className="py-1">
                <CopyValue value={row.value} label={t('action.copy')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Why an apex is pinned to addresses and a subdomain is not — the asset's
          panel 4 note, which is RFC 1034 §3.6.2 in the customer's words. */}
      {rows.some((r) => r.type === 'A' || r.type === 'AAAA') ? (
        <p className="font-sans text-[12px] leading-[1.6] text-(--el-text-secondary)">
          {t('addModal.apexNote')}
        </p>
      ) : null}
    </div>
  );
}

function AddDomainModal({
  open,
  busy,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (hostname: string) => Promise<boolean>;
}) {
  const t = useTranslations('settings.publicAddress.domains');
  const [hostname, setHostname] = useState('');

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('addModal.title')}>
      <div className="flex flex-col gap-4">
        <Input
          label={t('addModal.label')}
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          helperText={t('addModal.helper')}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
            {t('addModal.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={busy}
            disabled={hostname.trim() === ''}
            onClick={async () => {
              // ⚠️ THE MODAL CLOSES AND THE ROW APPEARS `unverified`. The design's
              // *I'll do this later* is not a third button here: closing IS that
              // exit, and the records stay reachable from the row's *Show DNS
              // records* for ever. A second control that did the same thing would
              // imply the two differ.
              if (await onSubmit(hostname.trim())) {
                setHostname('');
                onOpenChange(false);
              }
            }}
          >
            {t('addModal.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  const t = useTranslations('settings.publicAddress.domains');
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => toast({ variant: 'success', title: t('action.copied') }));
      }}
      className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
