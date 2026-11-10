'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { PlatformRunModelEntryDTO, PlatformRunModelListDTO } from '@/lib/dto/platformRunModel';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { addRunModelAction, removeRunModelAction, type RunModelActionResult } from '../actions';

/**
 * The HOSTED-RUN MODEL LIST card — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-04 (Model lists) Panels 5–9 and 12, card MOTIR-7528.
 *
 * Which models a hosted run may use, for every project. The rows and the
 * addable set are server-rendered props and the actions `revalidatePath` the
 * page, so a write re-reads both (`CLAUDE.md`'s page-state contract, its
 * simplest branch). This island owns only what is not stored: an open dialog,
 * its draft, and the last refusal.
 *
 * ⚠️ The missing controls are presentation. A `support` / `operator` reader
 * gets plain rows (Panel 8); the action and the service both re-gate at
 * `superadmin`.
 */

export interface RunModelListProps {
  list: PlatformRunModelListDTO;
}

type Translator = ReturnType<typeof useTranslations<'platformAdmin'>>;

const LEVEL_ORDER: readonly WorkItemDifficultyDto[] = ['trivial', 'low', 'medium', 'high'];

export function RunModelList({ list }: RunModelListProps) {
  const t = useTranslations('platformAdmin');
  // The models this tab added. "Added just now by you" holds while listed.
  const [addedHere, setAddedHere] = useState<string[]>([]);
  const empty = list.entries.length === 0;

  return (
    <>
      <Card
        data-testid="run-model-list"
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
              >
                <Bot className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('runModels.card.title')}
                </h2>
                <p className="font-sans text-xs text-(--el-text-secondary)">
                  {t('runModels.card.subtitle')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone="neutral">{t('modelLists.count', { n: list.entries.length })}</Pill>
              {list.canEdit && !empty ? (
                <AddRunModel
                  addable={list.addable}
                  onAdded={(m) => setAddedHere((prev) => [...prev, m])}
                />
              ) : null}
            </div>
          </div>
        }
      >
        {empty ? (
          // Panel 9: before first use, or after every unused model was removed.
          <EmptyState
            data-testid="run-model-list-empty"
            icon={<Bot className="h-5 w-5" />}
            title={t('runModels.empty.title')}
            description={
              list.canEdit ? t('runModels.empty.body') : t('runModels.empty.bodyReadOnly')
            }
            action={
              list.canEdit ? (
                <AddRunModel
                  addable={list.addable}
                  onAdded={(m) => setAddedHere((prev) => [...prev, m])}
                />
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('modelLists.col.model')}</Th>
                  <Th>{t('modelLists.col.offered')}</Th>
                  <Th>{t('modelLists.col.inUse')}</Th>
                  <Th>{t('modelLists.col.added')}</Th>
                  {list.canEdit ? (
                    <Th>
                      <span className="sr-only">{t('modelLists.col.action')}</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => (
                  <RunModelRow
                    key={entry.model}
                    entry={entry}
                    canEdit={list.canEdit}
                    addedHere={addedHere.includes(entry.model)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {list.canEdit ? null : (
        <p
          data-testid="run-model-list-read-only"
          className="font-sans text-xs text-(--el-text-secondary)"
        >
          {t('modelLists.readOnly')}
        </p>
      )}
    </>
  );
}

function RunModelRow({
  entry,
  canEdit,
  addedHere,
}: {
  entry: PlatformRunModelEntryDTO;
  canEdit: boolean;
  addedHere: boolean;
}) {
  const t = useTranslations('platformAdmin');
  const format = useFormatter();
  const [refusal, setRefusal] = useState<string | null>(null);

  const addedLine = addedHere
    ? t('modelLists.added.justNowByYou')
    : entry.seeded
      ? t('modelLists.added.seeded')
      : entry.addedBy
        ? t('modelLists.added.by', {
            when: formatWhen(format, entry.createdAt),
            who: entry.addedBy,
          })
        : t('modelLists.added.byUnknown', { when: formatWhen(format, entry.createdAt) });
  const inUse = entry.platformDefaultLevels.length > 0 || entry.projects.length > 0;

  return (
    <tr
      data-testid={`run-model-list-row-${entry.model}`}
      className="border-b border-(--el-border-soft) last:border-b-0"
    >
      <Td>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-(--el-text)">{entry.model}</span>
          <span className="text-xs text-(--el-text-identifier)">
            {entry.provider ?? t('modelLists.notInCatalog')}
          </span>
          {refusal ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {refusal}
            </p>
          ) : null}
        </div>
      </Td>
      <Td>
        {entry.offered ? (
          <Pill severity="success">{t('modelLists.offered')}</Pill>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Pill severity="warning">{t('modelLists.notOffered')}</Pill>
            <p className="max-w-[18rem] font-sans text-xs text-(--el-text-secondary)">
              {t('runModels.notOffered')}
            </p>
          </div>
        )}
      </Td>
      <Td className="text-xs text-(--el-text-secondary)">
        <div className="flex flex-col gap-0.5">
          {entry.platformDefaultLevels.length > 0 ? (
            <span className="text-(--el-text-strong)">
              {t('runModels.inUse.platformDefault', {
                levels: levelList(t, entry.platformDefaultLevels),
              })}
            </span>
          ) : null}
          {entry.projects.length > 0 ? (
            <span
              className="text-(--el-text-strong)"
              title={entry.projects.map((p) => `${p.projectName} (${p.projectKey})`).join(', ')}
            >
              {t('runModels.inUse.projects', { n: entry.projects.length })}
            </span>
          ) : null}
          {inUse ? null : <span>{t('modelLists.inUse.nothing')}</span>}
        </div>
      </Td>
      <Td className="text-xs text-(--el-text-secondary)">{addedLine}</Td>
      {canEdit ? (
        <Td>
          <RemoveRunModel model={entry.model} onRefused={setRefusal} />
        </Td>
      ) : null}
    </tr>
  );
}

function AddRunModel({
  addable,
  onAdded,
}: {
  addable: PlatformRunModelListDTO['addable'];
  onAdded: (model: string) => void;
}) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const modelId = useId();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setModel(null);
    setReason('');
    setRefusal(null);
  }

  function submit() {
    const why = reason.trim();
    if (!model || !why) return;
    const id = model;
    startTransition(async () => {
      const result = await addRunModelAction(id, why);
      if (result.ok) {
        onAdded(id);
        close();
        toast({ variant: 'success', title: t('runModels.added', { model: id }) });
        return;
      }
      // Panel 6: the dialog stays open with the reason; nothing was added.
      setRefusal(addRefusalText(t, result, id));
    });
  }

  const options = addable.map((m) => ({ value: m.id, label: m.id, group: m.provider }));

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Plus className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
      >
        {t('modelLists.add')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('runModels.add.title')}
        description={t('runModels.add.body')}
        size="md"
      >
        <Modal.Body className="gap-4">
          {options.length === 0 ? (
            <p
              data-testid="run-model-add-nothing"
              className="font-sans text-sm text-(--el-text-secondary)"
            >
              {t('runModels.add.nothing')}
            </p>
          ) : (
            <Combobox
              id={modelId}
              label={t('runModels.add.modelLabel')}
              placeholder={t('runModels.add.placeholder')}
              options={options}
              value={model}
              onChange={(value) => {
                setRefusal(null);
                setModel(value);
              }}
              footer={
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {t('runModels.add.pickerFoot')}
                </span>
              }
            />
          )}
          <Input
            id={reasonId}
            label={t('modelLists.reasonLabel')}
            placeholder={t('modelLists.reasonPlaceholder')}
            helperText={t('modelLists.reasonHint')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={280}
          />
          {refusal ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {refusal}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('modelLists.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            disabled={!model || reason.trim().length === 0}
          >
            {t('runModels.add.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

function RemoveRunModel({
  model,
  onRefused,
}: {
  model: string;
  onRefused: (text: string | null) => void;
}) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setReason('');
  }

  function submit() {
    const why = reason.trim();
    if (!why) return;
    startTransition(async () => {
      const result = await removeRunModelAction(model, why);
      close();
      if (result.ok) {
        onRefused(null);
        toast({ variant: 'success', title: t('runModels.removed', { model }) });
        return;
      }
      // Panel 7b: the refusal sits on the row it is about.
      onRefused(removeRefusalText(t, result, model));
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t('modelLists.removeAria', { model })}
        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={() => {
          onRefused(null);
          setOpen(true);
        }}
      >
        {t('modelLists.remove')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('runModels.remove.title', { model })}
        description={t('runModels.remove.body')}
        size="md"
      >
        <Modal.Body className="gap-4">
          <Input
            id={reasonId}
            label={t('modelLists.reasonLabel')}
            placeholder={t('modelLists.reasonPlaceholder')}
            helperText={t('modelLists.reasonHint')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('modelLists.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            loading={isPending}
            disabled={reason.trim().length === 0}
          >
            {t('runModels.remove.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

type Refusal = Extract<RunModelActionResult, { ok: false }>;

function commonRefusalText(t: Translator, result: Refusal): string {
  switch (result.code) {
    case 'REASON_REQUIRED':
      return t('modelLists.error.reasonRequired');
    case 'NOT_PERMITTED':
      return t('modelLists.error.notPermitted');
    case 'UNAVAILABLE':
      return t('modelLists.error.unavailable');
    default:
      return t('modelLists.error.failed');
  }
}

function addRefusalText(t: Translator, result: Refusal, model: string): string {
  if (result.code === 'NOT_OFFERED') return t('runModels.add.notOffered', { model });
  if (result.code === 'ALREADY_LISTED') return t('runModels.add.alreadyListed', { model });
  return commonRefusalText(t, result);
}

function removeRefusalText(t: Translator, result: Refusal, model: string): string {
  if (result.code === 'IN_USE') {
    const platformDefaultClause =
      (result.platformLevels.length > 0
        ? t('runModels.remove.inUseParts.platformDefault', {
            levels: levelList(t, result.platformLevels),
          })
        : '') +
      // MOTIR-10844: the review-agent and design-run defaults guard it too.
      (result.platformRoles.includes('review')
        ? t('runModels.remove.inUseParts.platformReview')
        : '') +
      (result.platformRoles.includes('design')
        ? t('runModels.remove.inUseParts.platformDesign')
        : '');
    const projectsClause =
      result.projects.length > 0
        ? t('runModels.remove.inUseParts.projects', {
            n: result.projects.length,
            list: result.projects
              .map((p) =>
                t('runModels.remove.inUseParts.projectEntry', {
                  name: p.projectName,
                  key: p.projectKey,
                  levels: levelList(t, p.levels),
                }),
              )
              .join('; '),
          })
        : '';
    return t('runModels.remove.inUse', { model, platformDefaultClause, projectsClause });
  }
  if (result.code === 'NOT_LISTED') return t('runModels.remove.notListed', { model });
  return commonRefusalText(t, result);
}

function levelList(t: Translator, levels: readonly WorkItemDifficultyDto[]): string {
  return LEVEL_ORDER.filter((l) => levels.includes(l))
    .map((l) => t(`runModels.level.${l}`))
    .join(', ');
}

function formatWhen(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
