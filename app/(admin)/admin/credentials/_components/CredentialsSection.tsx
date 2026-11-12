import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Info,
  KeyRound,
  OctagonAlert,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  PlatformCredentialRowDTO,
  PlatformCredentialsDTO,
  PlatformCredentialsOverall,
} from '@/lib/dto/platformCredentials';
import { CREDENTIAL_INVENTORY_HREF } from '@/lib/health/credentialInventory';
import {
  CardHead,
  InsetState,
  MiniStat,
  Mono,
  Sub,
  Td,
  Th,
} from '../../monitoring/_components/FleetSection';

/**
 * THE CREDENTIALS CARD (MOTIR-9408, design MOTIR-11084). A server component that
 * renders what `platformCredentialsService` judged and decides nothing: every
 * verdict, count and day figure arrives in the DTO.
 *
 * ⚠️ NO VALUE, EVER. A row carries a name, an env var NAME, a declared date and
 * the registry's own renewal and source sentences — nothing read from a secret.
 *
 * ⚠️ NO REASSURANCE WITHOUT A JUDGEMENT. The success pill needs at least one
 * judged credential; an empty registry, an all-unset deployment and a read error
 * each say what they are, and the four counts are drawn only beside rows.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.credentials'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

interface Words {
  t: T;
  format: Format;
}

const GLYPH = 'h-3 w-3 shrink-0';

/** HH:MM of an ISO instant, in UTC — the copy says "UTC" beside it. */
export function utcTime(iso: string): string {
  return iso.slice(11, 16);
}

/** A declared ISO date (`YYYY-MM-DD`) in the viewer's locale, read at 00:00 UTC. */
function dateWords(isoDate: string, format: Format): string {
  return format.dateTime(new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function mono(chunks: ReactNode) {
  return <code className="font-mono text-xs text-(--el-text-identifier)">{chunks}</code>;
}

export async function CredentialsSection({ read: dto }: { read: PlatformCredentialsDTO }) {
  const t = await getTranslations('platformAdmin.credentials');
  const format = await getFormatter();
  const w: Words = { t, format };
  const at = { time: utcTime(dto.checkedAt), date: dateWords(dto.checkedAt, format) };

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p
          data-testid="credentials-checked-at"
          className="flex items-center gap-1 font-sans text-xs text-(--el-text-secondary)"
        >
          <RefreshCw aria-hidden className={GLYPH} />
          {dto.status === 'failed' ? t('checkFailedAt', at) : t('checkedAt', at)}
        </p>
      </div>
      <Card
        data-testid="credentials-card"
        header={
          <CardHead
            icon={<KeyRound className="h-4 w-4" />}
            title={t('card.title')}
            subtitle={t('card.subtitle')}
            pills={<OverallPill overall={dto.status === 'failed' ? null : dto.overall} t={t} />}
          />
        }
      >
        <div className="flex flex-col gap-4">
          {dto.status === 'failed' ? (
            <InsetState
              icon={<TriangleAlert className="h-5 w-5" />}
              title={t('error.title')}
              tone="error"
            >
              {t.rich('error.body', { message: dto.message, mono })}
            </InsetState>
          ) : dto.rows.length === 0 ? (
            <InsetState icon={<KeyRound className="h-5 w-5" />} title={t('empty.title')}>
              {t.rich('empty.body', { mono })}
            </InsetState>
          ) : (
            <>
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                data-testid="credentials-counts"
              >
                <MiniStat value={format.number(dto.counts.expired)} label={t('count.expired')} />
                <MiniStat
                  value={format.number(dto.counts.expiring)}
                  label={t('count.expiring')}
                  sub={t('count.expiringSub')}
                />
                <MiniStat
                  value={format.number(dto.counts.notSet)}
                  label={t('count.notSet')}
                  sub={t('count.notSetSub')}
                />
                <MiniStat value={format.number(dto.counts.healthy)} label={t('count.healthy')} />
              </div>
              <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
                <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                {t('rule')}
              </p>
              <CredentialsTable rows={dto.rows} w={w} />
              <CredentialsList rows={dto.rows} w={w} />
            </>
          )}
          <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
            <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {t.rich('footer', {
                link: (chunks) => (
                  <Link
                    href={CREDENTIAL_INVENTORY_HREF}
                    className="text-(--el-link) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </p>
        </div>
      </Card>
    </>
  );
}

// ── The overall pill ─────────────────────────────────────────────────────────

function OverallPill({ overall, t }: { overall: PlatformCredentialsOverall | null; t: T }) {
  switch (overall) {
    case null:
      return (
        <Pill tone="awaiting" aria-label={t('overall.notCheckedLabel')} data-overall="notChecked">
          <CircleHelp aria-hidden className={GLYPH} />
          {t('overall.notChecked')}
        </Pill>
      );
    case 'expired':
      return (
        <Pill severity="danger" data-overall="expired">
          <OctagonAlert aria-hidden className={GLYPH} />
          {t('overall.expired')}
        </Pill>
      );
    case 'expiring':
      return (
        <Pill severity="warning" data-overall="expiring">
          <TriangleAlert aria-hidden className={GLYPH} />
          {t('overall.expiring')}
        </Pill>
      );
    case 'ok':
      return (
        <Pill severity="success" data-overall="ok">
          <CircleCheck aria-hidden className={GLYPH} />
          {t('overall.ok')}
        </Pill>
      );
    case 'noneSet':
      return (
        <Pill tone="neutral" data-overall="noneSet">
          <CircleMinus aria-hidden className={GLYPH} />
          {t('overall.noneSet')}
        </Pill>
      );
    default:
      return (
        <Pill tone="neutral" data-overall="empty">
          <CircleMinus aria-hidden className={GLYPH} />
          {t('overall.empty')}
        </Pill>
      );
  }
}

// ── Per-row cells, shared by the table and the phone list ─────────────────────

function rowRail(row: PlatformCredentialRowDTO): boolean | 'warning' {
  if (row.state === 'expired') return true;
  if (row.state === 'expiring') return 'warning';
  return false;
}

function VerdictPill({ row, t }: { row: PlatformCredentialRowDTO; t: T }) {
  switch (row.state) {
    case 'expired':
      return (
        <Pill severity="danger" data-verdict="expired">
          <OctagonAlert aria-hidden className={GLYPH} />
          {t('verdict.expired')}
        </Pill>
      );
    case 'expiring':
      return (
        <Pill severity="warning" data-verdict="expiring">
          <TriangleAlert aria-hidden className={GLYPH} />
          {t('verdict.expiring')}
        </Pill>
      );
    case 'notSet':
      return (
        <Pill tone="neutral" data-verdict="notSet">
          <CircleMinus aria-hidden className={GLYPH} />
          {t('verdict.notSet')}
        </Pill>
      );
    default:
      return (
        <Pill severity="success" data-verdict="healthy">
          <CircleCheck aria-hidden className={GLYPH} />
          {t('verdict.healthy')}
        </Pill>
      );
  }
}

function CredentialName({ row }: { row: PlatformCredentialRowDTO }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-(--el-text)">{row.name}</span>
      <Mono>{row.envVar}</Mono>
    </span>
  );
}

function ExpiresCell({ row, w }: { row: PlatformCredentialRowDTO; w: Words }) {
  return (
    <span>
      <span className="whitespace-nowrap text-(--el-text)">
        {dateWords(row.expiresAt, w.format)}
      </span>
      <span className="mt-0.5 block">
        <Mono>{row.expiresAt}</Mono>
      </span>
    </span>
  );
}

function DaysCell({ row, w }: { row: PlatformCredentialRowDTO; w: Words }) {
  const { t, format } = w;
  const days = row.daysRemaining ?? 0;
  switch (row.state) {
    case 'notSet':
      return (
        <span>
          <span className="italic text-(--el-text-secondary)">{t('days.notChecked')}</span>
          <Sub>{t('days.notSetHere')}</Sub>
        </span>
      );
    case 'expired':
      return (
        <span>
          <span className="font-medium text-(--el-text)">
            {t('days.expired', { days: Math.abs(days) })}
          </span>
          <Sub>{t('days.stillSet')}</Sub>
        </span>
      );
    case 'expiring':
      return (
        <span>
          <span className="font-medium text-(--el-text)">{t('days.expiring', { days })}</span>
          <Sub>{t('days.insideLead', { lead: row.leadTimeDays })}</Sub>
        </span>
      );
    default:
      return (
        <span>
          <span className="text-(--el-text)">{t('days.healthy', { days })}</span>
          <Sub>{t('days.warnsFrom', { date: dateWords(row.warnsFrom, format) })}</Sub>
        </span>
      );
  }
}

const CARD_KEY = /\b(MOTIR-\d+)\b/g;

/**
 * A registry sentence as TEXT: backtick spans become inline code, and every
 * Motir card key outside them a link to the card. Never parsed as HTML.
 */
export function RegistryText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Fragment key={i}>{mono(part)}</Fragment>
        ) : (
          <Fragment key={i}>
            {part.split(CARD_KEY).map((piece, j) =>
              j % 2 === 1 ? (
                <Link
                  key={j}
                  href={`/items/${piece}`}
                  className="font-mono text-(--el-link) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                >
                  {piece}
                </Link>
              ) : (
                piece
              ),
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

function RenewalCell({ row, t }: { row: PlatformCredentialRowDTO; t: T }) {
  return (
    <span className="block min-w-[20rem] text-xs leading-relaxed text-(--el-text-secondary)">
      <span className="block">
        <RegistryText text={row.renewal} />
      </span>
      <span className="mt-1 block">
        <span className="font-medium">{t('source')}</span> · <RegistryText text={row.source} />
      </span>
    </span>
  );
}

// ── The table (≥ sm) ─────────────────────────────────────────────────────────

function CredentialsTable({ rows, w }: { rows: PlatformCredentialRowDTO[]; w: Words }) {
  const { t } = w;
  return (
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[52rem] border-collapse font-sans text-sm">
        <caption className="sr-only">{t('table.caption')}</caption>
        <thead className="border-b border-(--el-border)">
          <tr>
            <Th scope="col">{t('col.credential')}</Th>
            <Th scope="col">{t('col.expires')}</Th>
            <Th scope="col" numeric>
              {t('col.daysLeft')}
            </Th>
            <Th scope="col">{t('col.verdict')}</Th>
            <Th scope="col">{t('col.renewal')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.envVar}
              data-credential={row.envVar}
              data-state={row.state}
              className="border-b border-(--el-border-soft)"
            >
              <Td rail={rowRail(row)}>
                <CredentialName row={row} />
              </Td>
              <Td>
                <ExpiresCell row={row} w={w} />
              </Td>
              <Td numeric className="tabular-nums whitespace-nowrap">
                <DaysCell row={row} w={w} />
              </Td>
              <Td className="whitespace-nowrap">
                <VerdictPill row={row} t={t} />
              </Td>
              <Td>
                <RenewalCell row={row} t={t} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── The phone list (< sm) ────────────────────────────────────────────────────

function railClass(rail: boolean | 'warning'): string {
  return rail === 'warning'
    ? 'border-l-[3px] border-l-(--el-warning) pl-3'
    : rail
      ? 'border-l-[3px] border-l-(--el-danger) pl-3'
      : '';
}

function Pair({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function CredentialsList({ rows, w }: { rows: PlatformCredentialRowDTO[]; w: Words }) {
  const { t } = w;
  return (
    <ul aria-label={t('phone.listLabel')} className="flex flex-col sm:hidden">
      {rows.map((row) => (
        <li
          key={row.envVar}
          data-credential={row.envVar}
          className={`flex flex-col gap-2 border-b border-(--el-border-soft) py-3 ${railClass(rowRail(row))}`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 break-words">
              <CredentialName row={row} />
            </span>
            <span className="shrink-0">
              <VerdictPill row={row} t={t} />
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 [&_*]:whitespace-normal">
            <Pair label={t('col.expires')}>
              <ExpiresCell row={row} w={w} />
            </Pair>
            <Pair label={t('col.daysLeft')}>
              <DaysCell row={row} w={w} />
            </Pair>
            <Pair label={t('phone.renewal')} wide>
              <span className="text-xs leading-relaxed text-(--el-text-secondary)">
                <RegistryText text={row.renewal} />
              </span>
            </Pair>
            <Pair label={t('phone.source')} wide>
              <span className="text-xs leading-relaxed text-(--el-text-secondary)">
                <RegistryText text={row.source} />
              </span>
            </Pair>
          </dl>
        </li>
      ))}
    </ul>
  );
}
