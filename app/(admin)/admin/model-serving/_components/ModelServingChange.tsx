'use client';

import { useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { ModelServingEntryDTO, ModelServingOfferingDTO } from '@/lib/dto/platformModelServing';
import { setModelServingAction } from '../actions';
import { priceDiff, servingOf, shortDate, usd } from './servingFormat';

/**
 * THE CHANGE DIALOG (MOTIR-11280; design `platform-admin/design-notes.md`
 * § Model serving, Panels 3–5): one option card per provider whose channel
 * serves the model, the original provider first. Picking a provider whose
 * channel is off shows the warning and turns Save into **Save anyway** — the
 * warning is the confirmation step. A failed save keeps the dialog open with
 * the pick; a saved one closes it, toasts, and the action re-reads the page.
 */

/** One option per provider: its first enabled channel, else its first. */
function providerOptions(entry: ModelServingEntryDTO): ModelServingOfferingDTO[] {
  const seen = new Map<string, ModelServingOfferingDTO>();
  for (const o of entry.offerings) {
    const had = seen.get(o.provider);
    if (!had || (!had.enabled && o.enabled)) seen.set(o.provider, o);
  }
  return [...seen.values()];
}

export function ModelServingChange({ entry }: { entry: ModelServingEntryDTO }) {
  const t = useTranslations('platformAdmin.modelServing');
  const locale = useLocale();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { wanted } = servingOf(entry);
  const [picked, setPicked] = useState<string>(wanted);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const options = providerOptions(entry);
  const pickedOption = options.find((o) => o.provider === picked) ?? null;
  const pickedOff = pickedOption !== null && !pickedOption.enabled;
  const fallback =
    options.find((o) => o.provider !== picked && o.enabled && o.isOrigin) ??
    options.find((o) => o.provider !== picked && o.enabled) ??
    null;
  const perMTok = (p: { input: number; output: number | null }) =>
    t('perMTok', { input: usd(p.input, locale), output: usd(p.output, locale) });
  const wantedName = options.find((o) => o.provider === wanted)?.providerName ?? wanted;

  function openDialog() {
    setPicked(wanted);
    setFailed(false);
    setOpen(true);
  }

  function save(provider: string | null) {
    setFailed(false);
    startTransition(async () => {
      const result = await setModelServingAction(entry.model, provider);
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setOpen(false);
      const name =
        options.find((o) => o.provider === (provider ?? entry.originProvider))?.providerName ??
        entry.originName;
      toast({
        variant: 'success',
        title: t('toast.saved', { provider: name, model: entry.modelName }),
        description: t('toast.savedBody'),
      });
    });
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        aria-label={t('changeAria', { model: entry.modelName })}
        onClick={openDialog}
        data-testid={`model-serving-change-${entry.model}`}
      >
        {t('change')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => (next || pending ? undefined : setOpen(false))}
        role="alertdialog"
        size="lg"
        title={t('dialog.title', { model: entry.modelName })}
        description={t('dialog.body', { model: entry.modelName })}
      >
        <Modal.Body className="gap-3">
          <div role="radiogroup" aria-label={t('col.servedBy')} className="flex flex-col gap-3">
            {options.map((o) => {
              const selected = o.provider === picked;
              const diff = priceDiff(o.cost, entry.charged);
              return (
                <label
                  key={o.provider}
                  data-testid={`model-serving-option-${o.provider}`}
                  className={`flex cursor-pointer gap-3 rounded-(--radius-card) border px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) hover:bg-(--el-surface) ${
                    selected
                      ? 'border-(--el-accent) bg-(--el-surface-soft)'
                      : 'border-(--el-border) bg-(--el-page-bg)'
                  }`}
                >
                  <input
                    type="radio"
                    name={`serve-${entry.model}`}
                    value={o.provider}
                    checked={selected}
                    onChange={() => {
                      setFailed(false);
                      setPicked(o.provider);
                    }}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border bg-(--el-page-bg) ${
                      selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                    }`}
                  >
                    {selected ? <span className="h-2 w-2 rounded-full bg-(--el-accent)" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1 font-sans text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-(--el-text)">{o.providerName}</span>
                      {o.isOrigin ? <Pill severity="info">{t('dialog.original')}</Pill> : null}
                      {o.provider === entry.effective ? (
                        <Pill tone="neutral">{t('dialog.current')}</Pill>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-(--el-text-secondary)">
                      <span>{t('dialog.channel', { name: o.channelName })}</span>
                      <span aria-hidden>·</span>
                      <span className="inline-flex items-center gap-1">
                        <span
                          aria-hidden
                          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                            o.enabled ? 'bg-(--el-success)' : 'bg-(--el-border-strong)'
                          }`}
                        />
                        {t(o.enabled ? 'dialog.enabled' : 'dialog.disabled')}
                      </span>
                    </span>
                    {o.cost ? (
                      <span className="text-xs text-(--el-text)">
                        <span className="tabular-nums">
                          {t('dialog.cost', { price: perMTok(o.cost) })}
                        </span>
                        {diff.kind === 'unknown' ? null : (
                          <span className="text-(--el-text-secondary)">
                            {' · '}
                            {diff.kind === 'same'
                              ? t('diff.same')
                              : t(`diff.${diff.kind}`, { input: diff.input, output: diff.output })}
                          </span>
                        )}
                      </span>
                    ) : null}
                    {o.costSource ? (
                      <span className="text-xs text-(--el-text-secondary)">
                        {t('dialog.priceSource', {
                          host: o.costSource.host,
                          date: shortDate(o.costSource.readDate, locale),
                        })}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
          {entry.selected !== null ? (
            <p className="font-sans text-xs text-(--el-text-secondary)">
              <button
                type="button"
                data-testid="model-serving-use-default"
                disabled={pending}
                onClick={() => save(null)}
                className="font-medium text-(--el-link) underline underline-offset-2"
              >
                {t('dialog.resetDefault')}
              </button>{' '}
              {t('dialog.useDefault')}
            </p>
          ) : null}
          {pickedOff && pickedOption ? (
            <div
              role="alert"
              data-testid="model-serving-disabled-warning"
              className="flex gap-3 rounded-(--radius-card) border border-(--el-warning) bg-(--el-tint-peach) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
            >
              <TriangleAlert
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-strong)"
              />
              <div className="flex min-w-0 flex-col gap-1 font-sans text-xs">
                <p className="font-semibold text-(--el-text-strong)">
                  {t('dialog.disabledWarning.title', { provider: pickedOption.providerName })}
                </p>
                <p className="text-(--el-text-strong)">
                  {t('dialog.disabledWarning.body', {
                    channel: pickedOption.channelName,
                    model: entry.modelName,
                    fallback: fallback?.providerName ?? entry.originName,
                    provider: pickedOption.providerName,
                  })}
                </p>
              </div>
            </div>
          ) : null}
          {failed ? (
            <p
              role="alert"
              data-testid="model-serving-save-error"
              className="font-sans text-xs text-(--el-danger-on-surface)"
            >
              {t('error.save', { model: entry.modelName, provider: wantedName })}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer className="flex-col items-stretch gap-3">
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('dialog.footer', {
              input: usd(entry.charged.input, locale),
              output: usd(entry.charged.output, locale),
            })}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              data-testid="model-serving-save"
              onClick={() =>
                save(picked === entry.originProvider && entry.selected === null ? null : picked)
              }
            >
              {pending ? t('dialog.saving') : t(pickedOff ? 'dialog.saveAnyway' : 'dialog.save')}
            </Button>
          </div>
        </Modal.Footer>
      </Modal>
    </>
  );
}
