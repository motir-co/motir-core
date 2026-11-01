import { useFormatter, useTranslations } from 'next-intl';
import { Cloud, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Pill } from '@/components/ui/Pill';
import {
  SEED_REGISTRY_ANY,
  type SeedRegistryConsoleRowDto,
  type SeedRegistryEntryDto,
} from '@/lib/dto/seedRegistry';
import { HOSTING_SIZES, HOSTING_USE_CASES } from '@/lib/hosting/vocabulary';
import { RetireStarterButton } from './RetireStarter';

/**
 * The STARTER LIBRARY table — design `starter-library` §2.4. One row per entry,
 * newest first: what it is (label and key), what it seeds (role · stack), what
 * it serves (uses, sizes), where it deploys, its status, and where it came from.
 *
 * A retired row is quieted with `--el-surface-soft`; the entry promoted just now
 * is tinted `--el-tint-yellow` for this visit (§3.5). A role's default carries no
 * Retire action — retiring it is a decision, not an operator action — and says
 * whose default it is instead.
 */

const ICON = 'size-3.5 shrink-0';

/** A promoted entry's ref, shortened the way Git shows a commit. */
const SHORT_SHA = 7;

export function StarterTable({
  rows,
  promoted,
}: {
  rows: SeedRegistryConsoleRowDto[];
  promoted?: string;
}) {
  const t = useTranslations('platformAdmin.starters');
  const ts = useTranslations('repositorySet.seed');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const b = (chunks: ReactNode) => (
    <b className="font-semibold text-(--el-text-strong)">{chunks}</b>
  );
  const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;

  const serves = (entry: SeedRegistryEntryDto) => {
    const uses =
      entry.useCases.length === HOSTING_USE_CASES.length
        ? [t('everyUse')]
        : entry.useCases.map((use) => ts(`use.${use}`));
    const sizes =
      entry.sizes.length === HOSTING_SIZES.length
        ? [t('everySize')]
        : entry.sizes.map((size) => ts(`size.${size}`));
    return (
      <div className="flex flex-col gap-1">
        {[uses, sizes].map((chips, i) =>
          chips.length > 0 ? (
            <span key={i} className="flex flex-wrap gap-1">
              {chips.map((chip) => (
                <Pill key={chip} tone="neutral">
                  {chip}
                </Pill>
              ))}
            </span>
          ) : null,
        )}
      </div>
    );
  };

  const provenance = (row: SeedRegistryConsoleRowDto) => {
    const { entry } = row;
    const who = row.promotedByEmail ?? t('provenance.removedAccount');
    const lines: ReactNode[] = [];
    if (entry.promotedFrom === null || entry.promotedAt === null) {
      lines.push(t('provenance.shipped'));
    } else {
      const values = {
        email: who,
        date: date(entry.promotedAt),
        repo: row.promotedFromRepo ?? '',
        ref: (entry.promotedRef ?? '').slice(0, SHORT_SHA),
        b,
        mono,
      };
      lines.push(
        row.promotedFromRepo !== null
          ? t.rich('provenance.promoted', values)
          : t.rich('provenance.promotedNoRepo', values),
      );
    }
    if (row.retirement !== null) {
      lines.push(
        t.rich('provenance.retired', {
          email: row.retirement.byEmail ?? t('provenance.removedAccount'),
          date: date(row.retirement.at),
          reason: row.retirement.reason ?? '',
          b,
        }),
      );
    }
    return (
      <div className="flex flex-col gap-1 text-xs text-(--el-text-secondary)">
        {lines.map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </div>
    );
  };

  const action = (row: SeedRegistryConsoleRowDto) => {
    const { entry } = row;
    if (row.isDefault) {
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-(--el-text-secondary)">
          <Lock className={ICON} aria-hidden="true" />
          {entry.role === SEED_REGISTRY_ANY
            ? t('defaultForEveryRole')
            : t('defaultForRole', { role: entry.role })}
        </span>
      );
    }
    if (entry.status !== 'active') return null;
    return <RetireStarterButton entryKey={entry.key} label={entry.label} role={entry.role} />;
  };

  return (
    <div className="overflow-x-auto">
      <table data-testid="starters-table" className="w-full border-collapse font-sans text-sm">
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <Th>{t('col.starter')}</Th>
            <Th>{t('col.roleStack')}</Th>
            <Th>{t('col.serves')}</Th>
            <Th>{t('col.hosting')}</Th>
            <Th>{t('col.status')}</Th>
            <Th>{t('col.provenance')}</Th>
            <th className="w-px">
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { entry } = row;
            const fresh = entry.key === promoted;
            const retired = entry.status === 'retired';
            return (
              <tr
                key={entry.key}
                data-testid={`starter-row-${entry.key}`}
                data-fresh={fresh || undefined}
                className={`border-b border-(--el-border-soft) last:border-b-0 ${
                  fresh ? 'bg-(--el-tint-yellow)' : retired ? 'bg-(--el-surface-soft)' : ''
                }`}
              >
                <Td className="min-w-[12rem]">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-(--el-text)">{entry.label}</span>
                    <code className="font-mono text-xs text-(--el-text-identifier)">
                      {entry.key}
                    </code>
                    {entry.legacyKeys.length > 0 ? (
                      <span className="text-xs text-(--el-text-secondary)">
                        {t('alsoAnswersTo', {
                          keys: format.list(entry.legacyKeys, { type: 'conjunction' }),
                        })}
                      </span>
                    ) : null}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-(--el-text)">
                  {entry.role === SEED_REGISTRY_ANY
                    ? t('anyRoleAnyStack')
                    : t('roleStack', { role: entry.role, stack: entry.stack })}
                </Td>
                <Td>{serves(entry)}</Td>
                <Td>
                  {entry.hostingTargets.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {entry.hostingTargets.map((target) => (
                        <Pill
                          key={target}
                          className="gap-1 border-transparent bg-(--el-tint-sky) text-(--el-text-strong)"
                        >
                          <Cloud className={ICON} aria-hidden="true" />
                          {ts(`target.${target}`)}
                        </Pill>
                      ))}
                    </span>
                  ) : (
                    <span className="text-xs text-(--el-text-secondary)">{t('notDeployed')}</span>
                  )}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {retired ? (
                      <Pill className="border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)">
                        {t('status.retired')}
                      </Pill>
                    ) : (
                      <Pill className="border-transparent bg-(--el-tint-mint) text-(--el-text-strong)">
                        {t('status.active')}
                      </Pill>
                    )}
                    {row.isDefault ? (
                      <Pill className="border-transparent bg-(--el-tint-yellow) text-(--el-text-strong)">
                        {ts('default')}
                      </Pill>
                    ) : null}
                  </span>
                </Td>
                <Td className="min-w-[14rem]">{provenance(row)}</Td>
                <Td className="text-right">{action(row)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
