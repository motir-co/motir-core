'use client';

import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { ModelRow, ModelText, Th, toOptions } from '@/components/ai/PlatformModelRow';
import type { RunModelDefaultKey } from '@/lib/ai/types';
import type {
  PlatformRunModelDefaultOptionDTO,
  PlatformRunModelDefaultRowDTO,
  PlatformRunModelDefaultsDTO,
} from '@/lib/dto/platformRunModelDefaults';
import { setRunModelDefaultAction } from '../actions';

/**
 * The RUN-SIDE DEFAULTS card — design `org-admin/design-notes.md` § The console's
 * per-function default rows (`console--function-defaults.mock.html`), card
 * MOTIR-10844. Under the run-model list on the Hosted-run models page, because
 * its pickers choose from that list.
 *
 * Six rows — Review agent, Design run, Agent run · Trivial / Low / Medium / High —
 * each through the shared console row (`PlatformModelRow`): a superadmin picks or
 * clears (the picker's first option, Inherits) through the confirm-with-reason
 * dialog; every other staff role reads the value as text. The stored values,
 * chips and last-changed lines are server props re-read after a save.
 */

type RowKind = 'review' | 'design' | 'level';

const kindOf = (key: RunModelDefaultKey): RowKind =>
  key === 'review' || key === 'design' ? key : 'level';

export function RunModelDefaults({ defaults }: { defaults: PlatformRunModelDefaultsDTO }) {
  const t = useTranslations('platformAdmin.runModels.defaults');
  const tShared = useTranslations('platformAdmin.aiPlanning');
  const options = toOptions(defaults.options);

  return (
    <>
      <Card
        data-testid="run-side-defaults"
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
              >
                <Cloud className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('title')}</h2>
                <p className="font-sans text-xs text-(--el-text-secondary)">{t('subtitle')}</p>
              </div>
            </div>
            <Pill tone="neutral">{t('count')}</Pill>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse font-sans text-sm">
            <thead>
              <tr className="border-b border-(--el-border) text-left">
                <Th>{t('col.function')}</Th>
                <Th>{tShared('col.model')}</Th>
                <Th>{tShared('col.lastChanged')}</Th>
                {defaults.canEdit ? <Th>{tShared('col.action')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {defaults.rows.map((row) => (
                <RunModelDefaultRow
                  key={row.key}
                  row={row}
                  offered={defaults.options}
                  options={options}
                  canEdit={defaults.canEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {defaults.canEdit ? null : (
        <p
          data-testid="run-side-defaults-read-only"
          className="font-sans text-xs text-(--el-text-secondary)"
        >
          {tShared('readOnly')}
        </p>
      )}
    </>
  );
}

/** The picker value that stands for a default stored as null. */
const INHERITS = '__inherits__';

function RunModelDefaultRow({
  row,
  offered,
  options,
  canEdit,
}: {
  row: PlatformRunModelDefaultRowDTO;
  offered: PlatformRunModelDefaultOptionDTO[];
  options: ComboboxOption<string>[];
  canEdit: boolean;
}) {
  const t = useTranslations('platformAdmin.runModels.defaults');
  const kind = kindOf(row.key);
  const name = t(`row.${row.key}.name`);
  const inherits =
    kind === 'design'
      ? t('inherits.design')
      : row.inheritsModel
        ? t(`inherits.${kind}With`, { model: row.inheritsModel })
        : t(`inherits.${kind}`);
  const rowOptions: ComboboxOption<string>[] = [
    { value: INHERITS, label: inherits, group: t('defaultGroup') },
    ...options,
  ];
  const labelOf = (value: string) => (value === INHERITS ? inherits : value);
  const provider = row.model ? (offered.find((m) => m.id === row.model)?.provider ?? null) : null;
  return (
    <ModelRow
      testId={`function-default-row-${row.key}`}
      name={name}
      desc={t(`row.${row.key}.desc`)}
      stored={row.model ?? INHERITS}
      labelOf={labelOf}
      readOnly={
        row.model ? (
          <ModelText model={row.model} provider={provider} />
        ) : (
          <span className="text-xs text-(--el-text)">{inherits}</span>
        )
      }
      pickerAria={t('pickerAria', { name })}
      options={rowOptions}
      canEdit={canEdit}
      chips={
        row.withdrawn ? (
          <div className="flex flex-col items-start gap-1" data-testid="run-side-withdrawn">
            <Pill severity="warning">{t('withdrawn.chip')}</Pill>
            <p role="note" className="font-sans text-xs text-(--el-text-secondary)">
              {t(canEdit ? 'withdrawn.body' : 'withdrawn.bodyReadOnly', {
                name,
                what: t(`fallsBack.${kind}`),
              })}
            </p>
          </div>
        ) : null
      }
      changed={row}
      neverChanged={kind === 'level' ? t('changed.seededFromEnv') : t('changed.neverSet')}
      pickerFoot={t('pickerFoot')}
      refused={(model) => t('refused', { model })}
      confirmTitle={t('confirmTitle', { name })}
      confirmBody={(from, to) => t(`confirmBody.${kind}`, { from, to })}
      saved={(label) => ({
        title: t('savedTitle', { name }),
        description: t(`savedBody.${kind}`, { model: label }),
      })}
      unchanged={(label) => t('unchanged', { name, model: label })}
      save={(value, reason) =>
        setRunModelDefaultAction(row.key, value === INHERITS ? null : value, reason)
      }
    />
  );
}
