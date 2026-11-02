'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type {
  DnsInstructionDto,
  DomainApplicationDto,
  PublicAddressDto,
} from '@/lib/dto/publicAddresses';
import { ApplicationControl } from './ApplicationControl';
import { ApplicationPicker, NO_APPLICATION } from './ApplicationPicker';

/**
 * THE CUSTOM DOMAINS PANE (Story MOTIR-4533 · MOTIR-9529), built to
 * `design/workspace-address/custom-domains.mock.html` panels 1–12, over the
 * workspace routes (MOTIR-9524) and the failure kinds the sweep writes
 * (MOTIR-9526). Ported from the project room's `CustomDomainsSection`, which it
 * replaces: the same `call` shape and the same tick, on workspace URLs. The
 * application a domain serves — the add dialog's picker, the Application line
 * by name and the Application control — is the delta
 * `custom-domains--application.mock.html` panels A–F (MOTIR-10125).
 *
 * ── ⚠️ THE STATE MAP IS A TOTAL `Record`, AND THAT IS THE POINT ───────────
 *
 * `PublicAddressStatus` has nine values and the design draws four pills. The map
 * names every value — the two subdomain states included, as not-in-list — so a
 * tenth value is a COMPILE error here rather than a row that renders blank.
 *
 * ── ⚠️ THE BANNER BRANCHES ON `failureKind`, NEVER ON `failureReason` ─────
 *
 * The reason is prose for the customer; the kind is the contract. A banner that
 * matched words would change meaning the day the sweep rephrased a sentence.
 */

type DomainStatus = PublicAddressDto['status'];
type PillLabel = 'unverified' | 'pending' | 'issued' | 'failed';

interface StateRow {
  /** The design's pill, or `null` for the two subdomain states. */
  readonly pill: PillLabel | null;
  readonly severity: 'info' | 'success' | 'warning' | 'danger' | null;
}

/** Every value, mapped onto the design's four pills. TOTAL over the enum. */
const STATES: Record<DomainStatus, StateRow> = {
  // The two subdomain states never appear in this list.
  active: { pill: null, severity: null },
  alias: { pill: null, severity: null },

  unverified: { pill: 'unverified', severity: 'warning' },
  verifying: { pill: 'pending', severity: 'info' },
  pending_certificate: { pill: 'pending', severity: 'info' },
  issued: { pill: 'issued', severity: 'success' },
  failed: { pill: 'failed', severity: 'danger' },
  expired: { pill: 'failed', severity: 'danger' },
  revoked: { pill: 'failed', severity: 'danger' },
};

/** How often the pane re-reads while the job still owes a row its next state. */
const TICK_MS = 30_000;

/** The add route's refusals, each with its own sentence (design panel 5). */
type Refusal =
  | { kind: 'tenantBase'; host: string }
  | { kind: 'siteOrigin'; host: string }
  | { kind: 'malformed' }
  | { kind: 'taken'; host: string }
  | { kind: 'cap'; max: number }
  | { kind: 'other' };

/** Read the add route's typed refusal body (codes from `mapCustomDomainError`). */
export function refusalOf(status: number, body: Record<string, unknown>, host: string): Refusal {
  if (body.code === 'NOT_A_CUSTOMER_DOMAIN') {
    return body.reason === 'tenant_base'
      ? { kind: 'tenantBase', host }
      : { kind: 'siteOrigin', host };
  }
  if (body.code === 'INVALID_HOSTNAME') return { kind: 'malformed' };
  if (body.code === 'HOSTNAME_TAKEN') return { kind: 'taken', host };
  if (status === 402 && body.entitlement === 'custom_domains') {
    const detail = body.detail as { limit?: unknown } | undefined;
    return { kind: 'cap', max: typeof detail?.limit === 'number' ? detail.limit : 0 };
  }
  return { kind: 'other' };
}

export function CustomDomainsPane({
  workspaceId,
  baseDomain,
  workspaceHost,
  addresses,
  applications,
  canManage,
  maxDomains,
  loadFailed,
}: {
  workspaceId: string;
  /** The tenant base domain, for the "that is a Motir address" refusal. */
  baseDomain: string;
  /** The workspace's own `motir.site` host, which the upsell names; null if unclaimed. */
  workspaceHost: string | null;
  addresses: readonly PublicAddressDto[];
  /** The workspace's applications, which the picker offers and the rows name. */
  applications: readonly DomainApplicationDto[];
  /** The workspace address gate every write asserts (`roleMayManageAddress`). */
  canManage: boolean;
  /** The tier's cap; `null` = no cap, `0` = not on this plan. */
  maxDomains: number | null;
  loadFailed: boolean;
}) {
  const t = useTranslations('settings.customDomains');
  const { toast } = useToast();
  const router = useRouter();

  // ⚠️ SEEDED FROM PROPS, AND RE-SEEDED WHEN THEY CHANGE. A write updates this
  // list from its own response at once, and `router.refresh()` then hands the
  // server's list back down — which wins, because the server is the record.
  const [rows, setRows] = useState<readonly PublicAddressDto[]>(addresses);
  const [seed, setSeed] = useState(addresses);
  if (seed !== addresses) {
    setSeed(addresses);
    setRows(addresses);
  }

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PublicAddressDto | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  // One sequence number per row, so a slow Re-check cannot overwrite the answer
  // of a later one.
  const seq = useRef(new Map<string, number>());

  const domains = rows.filter((a) => STATES[a.status].pill !== null);
  const pending = domains.some((a) => STATES[a.status].pill === 'pending');

  // ⚠️ THE TICK EXISTS BECAUSE THE NEXT STATE IS NOT OURS TO WRITE: a pending
  // row ends when the job sees the platform issue. It STOPS when nothing is
  // pending, so a settled pane costs nothing.
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => router.refresh(), TICK_MS);
    return () => window.clearInterval(id);
  }, [pending, router]);

  function base(path = ''): string {
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/custom-domains${path}`;
  }

  async function add(hostname: string, applicationId: string | null): Promise<Refusal | null> {
    try {
      const res = await fetch(base(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname, applicationId }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return refusalOf(res.status, body, hostname);
      setRows((current) => [...current, body as unknown as PublicAddressDto]);
      router.refresh();
      return null;
    } catch {
      return { kind: 'other' };
    }
  }

  async function check(address: PublicAddressDto): Promise<void> {
    const mine = (seq.current.get(address.id) ?? 0) + 1;
    seq.current.set(address.id, mine);
    setChecking((s) => new Set(s).add(address.id));
    try {
      const res = await fetch(base(`/${encodeURIComponent(address.id)}/verify`), {
        method: 'POST',
      });
      if (!res.ok) {
        toast({ variant: 'error', title: t('error') });
        return;
      }
      const dto = (await res.json()) as PublicAddressDto;
      if (seq.current.get(address.id) !== mine) return;
      setRows((current) => current.map((r) => (r.id === dto.id ? dto : r)));
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('error') });
    } finally {
      if (seq.current.get(address.id) === mine) {
        setChecking((s) => {
          const next = new Set(s);
          next.delete(address.id);
          return next;
        });
      }
    }
  }

  async function bind(address: PublicAddressDto, applicationId: string | null): Promise<boolean> {
    try {
      const res = await fetch(base(`/${encodeURIComponent(address.id)}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicationId }),
      });
      if (!res.ok) return false;
      const dto = (await res.json()) as PublicAddressDto;
      setRows((current) => current.map((r) => (r.id === dto.id ? dto : r)));
      router.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async function remove(address: PublicAddressDto): Promise<boolean> {
    try {
      const res = await fetch(base(`/${encodeURIComponent(address.id)}`), { method: 'DELETE' });
      if (!res.ok) return false;
      setRows((current) => current.filter((r) => r.id !== address.id));
      toast({
        variant: 'success',
        title: t('remove.toast', { host: address.hostname }),
        description: t('remove.toastBody'),
      });
      router.refresh();
      return true;
    } catch {
      return false;
    }
  }

  if (loadFailed) {
    return (
      <Card className="p-(--spacing-card-padding)">
        <ErrorState title={t('loadError')} retry={() => router.refresh()} />
      </Card>
    );
  }

  const notOnPlan = maxDomains === 0;
  const atCap = maxDomains !== null && maxDomains > 0 && domains.length >= maxDomains;

  return (
    <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
      {canManage ? null : (
        <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('readOnly')}</p>
      )}

      {canManage && notOnPlan ? (
        <div
          data-testid="custom-domains-upsell"
          className="flex flex-col gap-2 rounded-(--radius-card) border-l-2 border-(--el-accent) bg-(--el-tint-lavender) p-(--spacing-card-padding)"
        >
          <span className="font-sans text-sm font-semibold text-(--el-text-strong)">
            {t('upsell.title')}
          </span>
          <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
            {t('upsell.body', { host: workspaceHost ?? baseDomain })}
          </span>
          <div>
            <Link
              href="/settings/organization/billing"
              className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x-sm) font-sans text-sm font-medium text-(--el-accent-text) hover:bg-(--el-accent-pressed)"
            >
              {t('upsell.cta')}
            </Link>
          </div>
        </div>
      ) : null}

      {canManage && !notOnPlan ? (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button variant="primary" size="sm" disabled={atCap} onClick={() => setAdding(true)}>
            {t('add')}
          </Button>
          {atCap ? (
            <span className="font-sans text-[12px] text-(--el-text-secondary)">
              <strong className="text-(--el-text-strong)">
                {t('cap', { used: domains.length, max: maxDomains })}
              </strong>{' '}
              ·{' '}
              <Link
                href="/settings/organization/billing"
                className="text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('upsell.cta')}
              </Link>
            </span>
          ) : null}
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
              applications={applications}
              canManage={canManage}
              checking={checking.has(address.id)}
              onCheck={() => void check(address)}
              onBind={(applicationId) => bind(address, applicationId)}
              onRemove={() => setRemoving(address)}
            />
          ))}
        </ul>
      )}

      <AddDomainModal
        open={adding}
        baseDomain={baseDomain}
        applications={applications}
        onOpenChange={setAdding}
        onSubmit={add}
      />

      <RemoveConfirm
        address={removing}
        onClose={() => setRemoving(null)}
        onConfirm={async (address) => {
          const ok = await remove(address);
          if (ok) setRemoving(null);
          return ok;
        }}
      />
    </Card>
  );
}

function DomainRow({
  address,
  applications,
  canManage,
  checking,
  onCheck,
  onBind,
  onRemove,
}: {
  address: PublicAddressDto;
  applications: readonly DomainApplicationDto[];
  canManage: boolean;
  checking: boolean;
  onCheck: () => void;
  onBind: (applicationId: string | null) => Promise<boolean>;
  onRemove: () => void;
}) {
  const t = useTranslations('settings.customDomains');
  const format = useFormatter();
  const state = STATES[address.status];
  const [dnsOpen, setDnsOpen] = useState(false);
  // `role="alert"` only when the status CHANGES to a failure while the pane is
  // open — a failure already there on load is read, not announced.
  const [firstStatus] = useState(address.status);
  const becameFailed = state.pill === 'failed' && firstStatus !== address.status;

  const pointing = address.dns.filter((r) => r.type !== 'TXT');
  const txt: DnsInstructionDto[] = address.dns.filter((r) => r.type === 'TXT');
  if (txt.length === 0 && address.verification) {
    txt.push({ type: 'TXT', ...address.verification });
  }
  const issuanceFailure =
    state.pill === 'failed' &&
    address.failureKind !== 'txt_lost' &&
    address.failureKind !== 'pointing_lost';

  return (
    <li
      data-status={address.status}
      className="flex min-h-(--height-control) flex-col gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      <div className="flex flex-wrap items-center gap-2">
        {state.pill === 'issued' ? (
          <a
            href={`https://${address.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {address.hostname}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">
            {address.hostname}
          </span>
        )}
        <Pill severity={state.severity}>{t(`status.${state.pill!}`)}</Pill>
      </div>

      {state.pill === 'unverified' ? (
        <>
          <DnsTable rows={[...pointing, ...txt]} />
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={checking}
                disabled={checking}
                onClick={onCheck}
              >
                {checking ? t('action.checking') : t('action.checkNow')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRemove}>
                {t('action.remove')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {state.pill === 'pending' ? (
        <>
          <p className="font-sans text-[12px] leading-[1.6] text-(--el-text-secondary)">
            {t('pending')}
          </p>
          <DnsTable rows={pointing} />
          {canManage ? (
            <div>
              <Button variant="ghost" size="sm" onClick={onRemove}>
                {t('action.remove')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {state.pill === 'issued' ? (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ApplicationLine address={address} applications={applications} />
            {canManage ? (
              <ApplicationControl address={address} applications={applications} onSave={onBind} />
            ) : null}
          </div>
          {/* The date is the platform's, as the sweep last read it; a reading
              that carried none drops the clause rather than inventing one. */}
          <p className="font-sans text-[12px] text-(--el-text-secondary)">
            {address.certificateExpiresAt
              ? t('certUntil', {
                  date: format.dateTime(new Date(address.certificateExpiresAt), {
                    dateStyle: 'medium',
                  }),
                })
              : t('cert')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDnsOpen((o) => !o)}>
              {dnsOpen ? t('action.hideDns') : t('action.showDns')}
            </Button>
            {canManage ? (
              <Button variant="ghost" size="sm" onClick={onRemove}>
                {t('action.remove')}
              </Button>
            ) : null}
          </div>
          {dnsOpen ? <DnsTable rows={[...pointing, ...txt]} /> : null}
        </>
      ) : null}

      {state.pill === 'failed' ? (
        <div
          role={becameFailed ? 'alert' : undefined}
          data-failure={issuanceFailure ? 'issuance' : address.failureKind}
          className="flex flex-col gap-2 rounded-(--radius-control) border-l-2 border-(--el-danger) bg-(--el-tint-rose) px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
        >
          {address.failureKind === 'txt_lost' ? (
            <>
              <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
                {t('fail.txt')}
              </span>
              <span className="font-sans text-[13px] text-(--el-text-strong)">
                {t('fail.txtBody')}
              </span>
              <DnsTable rows={txt} onTint />
            </>
          ) : address.failureKind === 'pointing_lost' ? (
            <>
              <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
                {t('fail.pointing', { host: address.hostname })}
              </span>
              {address.failureReason ? (
                <span className="font-sans text-[13px] text-(--el-text-strong)">
                  {address.failureReason}
                </span>
              ) : null}
              <span className="font-sans text-[13px] text-(--el-text-strong)">
                {t('fail.pointingBody')}
              </span>
              <DnsTable rows={pointing} onTint />
            </>
          ) : (
            <>
              <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
                {t('fail.issuance')}
              </span>
              <span className="font-sans text-[13px] text-(--el-text-strong)">
                {t('fail.issuanceBody')}{' '}
                {/* ⚠️ The platform's reason, VERBATIM — a failure with no reason
                    is not actionable. */}
                <span className="font-mono">{address.failureReason}</span>
              </span>
            </>
          )}
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={checking}
                disabled={checking}
                onClick={onCheck}
              >
                {checking
                  ? t('action.checking')
                  : issuanceFailure
                    ? t('action.retry')
                    : t('action.recheck')}
              </Button>
              <Button variant="ghost" size="sm" disabled={checking} onClick={onRemove}>
                {t('action.remove')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Application line (delta panels B, E): a sentence, not a badge. Bound
 * names the application; unbound promises nothing about serving later; an id
 * the workspace no longer lists says so, and never reads as unbound.
 */
function ApplicationLine({
  address,
  applications,
}: {
  address: PublicAddressDto;
  applications: readonly DomainApplicationDto[];
}) {
  const t = useTranslations('settings.customDomains');
  const bound = address.applicationId
    ? applications.find((a) => a.id === address.applicationId)
    : undefined;
  return (
    <p
      data-application={bound ? 'bound' : address.applicationId ? 'gone' : 'none'}
      className="min-w-0 flex-1 font-sans text-[13px] break-words text-(--el-text)"
    >
      {bound
        ? t.rich('app.serves', {
            app: bound.name,
            slug: bound.slug,
            b: (chunks) => <strong className="font-semibold">{chunks}</strong>,
            code: (chunks) => (
              <span className="font-mono text-(--el-text-identifier)">{chunks}</span>
            ),
          })
        : address.applicationId
          ? t('app.gone')
          : t('app.none')}
    </p>
  );
}

/** The records the customer creates (design panels 6–7). */
function DnsTable({
  rows,
  onTint = false,
}: {
  rows: readonly DnsInstructionDto[];
  onTint?: boolean;
}) {
  const t = useTranslations('settings.customDomains');
  if (rows.length === 0) return null;
  const ink = onTint ? 'text-(--el-text-strong)' : 'text-(--el-text)';
  const label = onTint ? 'text-(--el-text-strong)' : 'text-(--el-text-secondary)';
  return (
    <div className="flex flex-col gap-2">
      {onTint ? null : (
        <p className="font-sans text-[12px] font-semibold text-(--el-text)">
          {t('records.heading', { count: rows.length })}
        </p>
      )}
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className={`font-sans text-[11px] ${label}`}>
            <th className="w-[16%] pb-1 font-medium">{t('records.type')}</th>
            <th className="w-[30%] pb-1 font-medium">{t('records.name')}</th>
            <th className="pb-1 font-medium">{t('records.value')}</th>
            <th className="w-[12%]" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.type}-${row.name}-${row.value}`} className="align-top">
              <td className={`py-1 font-mono text-[12px] ${ink}`}>{row.type}</td>
              <td className={`py-1 pr-2 font-mono text-[12px] break-all ${ink}`}>{row.name}</td>
              <td className={`py-1 pr-2 font-mono text-[12px] break-all ${ink}`}>{row.value}</td>
              <td className="py-1">
                <CopyValue value={row.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!onTint && rows.some((r) => r.type === 'A' || r.type === 'AAAA') ? (
        <p className="font-sans text-[12px] leading-[1.6] text-(--el-text-secondary)">
          {t('records.apexNote')}
        </p>
      ) : null}
    </div>
  );
}

function CopyValue({ value }: { value: string }) {
  const t = useTranslations('settings.customDomains');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? t('action.copied') : t('action.copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
      className="inline-flex h-(--height-control-28) items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x-6) font-sans text-[12px] text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden />
      <span aria-live="polite">{copied ? t('action.copied') : t('action.copy')}</span>
    </button>
  );
}

function AddDomainModal({
  open,
  baseDomain,
  applications,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  baseDomain: string;
  applications: readonly DomainApplicationDto[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (hostname: string, applicationId: string | null) => Promise<Refusal | null>;
}) {
  const t = useTranslations('settings.customDomains');
  // One application: preselected. Several: nothing, so the owner chooses. None:
  // the picker is absent and the domain is added naming none.
  const preselect = applications.length === 1 ? applications[0]!.id : null;
  const [hostname, setHostname] = useState('');
  const [application, setApplication] = useState<string | null>(preselect);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const message = (r: Refusal): string => {
    switch (r.kind) {
      case 'tenantBase':
        return t('refuse.tenantBase', { host: r.host, base: baseDomain });
      case 'siteOrigin':
        return t('refuse.siteOrigin', { host: r.host });
      case 'malformed':
        return t('refuse.malformed');
      case 'taken':
        return t('refuse.taken', { host: r.host });
      case 'cap':
        return t('refuse.cap', { max: r.max });
      case 'other':
        return t('error');
    }
  };

  function close(next: boolean) {
    if (!next) {
      setHostname('');
      setApplication(preselect);
      setRefusal(null);
    }
    onOpenChange(next);
  }

  return (
    <Modal open={open} onOpenChange={close} title={t('dialog.title')}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Modal.Body className="gap-4">
          <Input
            label={t('dialog.label')}
            value={hostname}
            onChange={(e) => {
              setHostname(e.target.value);
              setRefusal(null);
            }}
            helperText={refusal ? undefined : t('dialog.helper')}
            error={refusal ? message(refusal) : undefined}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
          {applications.length === 0 ? (
            <p className="font-sans text-[13px] leading-[1.6] text-(--el-text-secondary)">
              {t('dialog.noApps')}
            </p>
          ) : (
            <ApplicationPicker
              applications={applications}
              value={application}
              onChange={setApplication}
              disabled={busy}
            />
          )}
        </Modal.Body>
        <Modal.Footer className="shrink-0">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => close(false)}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={
              hostname.trim() === '' ||
              refusal !== null ||
              (applications.length > 0 && application === null)
            }
            onClick={async () => {
              setBusy(true);
              const refused = await onSubmit(
                hostname.trim(),
                application === null || application === NO_APPLICATION ? null : application,
              );
              setBusy(false);
              // A refusal keeps the dialog open with its own sentence under the
              // field; success closes it and the row appears Unverified.
              if (refused) setRefusal(refused);
              else close(false);
            }}
          >
            {t('add')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}

function RemoveConfirm({
  address,
  onClose,
  onConfirm,
}: {
  address: PublicAddressDto | null;
  onClose: () => void;
  onConfirm: (address: PublicAddressDto) => Promise<boolean>;
}) {
  const t = useTranslations('settings.customDomains');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  function close() {
    if (busy) return;
    setFailed(false);
    onClose();
  }

  return (
    <Modal
      open={address !== null}
      onOpenChange={(open) => !open && close()}
      title={address ? t('remove.title', { host: address.hostname }) : ''}
    >
      <div className="flex flex-col gap-4">
        <p className="font-sans text-[13px] leading-[1.6] text-(--el-text-secondary)">
          {t('remove.body')}
        </p>
        {failed ? (
          <p role="alert" className="font-sans text-[13px] text-(--el-danger-on-surface)">
            {t('remove.error')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={async () => {
              if (!address) return;
              setBusy(true);
              const ok = await onConfirm(address);
              setBusy(false);
              setFailed(!ok);
            }}
          >
            {busy ? t('remove.removing') : failed ? t('action.retry') : t('remove.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
