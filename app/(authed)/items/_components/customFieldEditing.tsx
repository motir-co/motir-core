'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { CustomFieldValueDto, CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@motir/design-system';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { setCustomFieldValueAction } from '../[key]/customFieldActions';

// Custom-field EDITING, extracted from `CustomFieldsSection` (MOTIR-2599).
//
// The detail rail fused the five per-type editors, the optimistic override map
// and the commit paths into the component that draws the FieldCards. The
// quick-view peek is the second surface that edits them, and its rail renders a
// denser value grammar, so the two cannot share a component — but they MUST
// share the writes, or one column ends up with two implementations that drift.
//
// So this hook owns the state, the commits and the CONTROLS; each surface keeps
// its own chrome and its own read-mode value rendering (which differ on purpose
// — a bordered card versus a condensed <dl> row).
//
// The commit is OPTIMISTIC and keeps the shipped rule: the picked value shows at
// once via a per-field override, the success response IS the confirmation, and
// nothing calls `router.refresh()` (`bug-inline-status-revert-on-second-edit`).
// A 422 snaps the override back and reopens the editor with the inline error.

const NONE = '__none__';
// Long option sets get the type-ahead filter; a short set opens straight to the
// list (the ParentPicker precedent — custom-fields.mock.html panel 2).
const SEARCHABLE_AT = 8;

/** The 2.4.9-family inline error: hue in the tint background, strong text
 *  (finding #35), announced via role="alert". */
export function CustomFieldErrorBox({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="bg-(--el-tint-rose) text-(--el-text-strong) mt-1.5 rounded-(--radius-control) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs"
    >
      {children}
    </p>
  );
}

export interface CustomFieldEditing {
  /** Fields WITH a value, override-applied. */
  valued: CustomFieldWithValueDto[];
  /** Fields with no value — the surface decides how to reveal them. */
  empty: CustomFieldWithValueDto[];
  editingId: string | null;
  openEditor: (field: CustomFieldWithValueDto) => void;
  closeEditor: () => void;
  /** The shared collapse semantics: free-text commits, pickers just close. */
  onToggle: (field: CustomFieldWithValueDto, isEditing: boolean) => void;
  /** The per-type control for an open field. */
  renderEditor: (field: CustomFieldWithValueDto) => ReactNode;
  isPending: boolean;
  error: string | null;
}

export function useCustomFieldEditing({
  workItemId,
  fields,
  members,
}: {
  workItemId: string;
  fields: CustomFieldWithValueDto[];
  members: WorkspaceMemberDTO[];
}): CustomFieldEditing {
  const t = useTranslations('issueViews');
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Per-field optimistic overrides, keyed by field id. A key present here wins
  // over the server prop until a re-read supplies a new prop set.
  const [overrides, setOverrides] = useState<Record<string, CustomFieldValueDto | null>>({});

  const effFields = fields.map((f) =>
    Object.prototype.hasOwnProperty.call(overrides, f.id)
      ? { ...f, value: overrides[f.id] ?? null }
      : f,
  );

  function openEditor(field: CustomFieldWithValueDto) {
    setError(null);
    setDraft(
      field.fieldType === 'text'
        ? (field.value?.text ?? '')
        : field.value?.number != null
          ? String(field.value.number)
          : '',
    );
    setEditingId(field.id);
  }

  function closeEditor() {
    setEditingId(null);
    setError(null);
  }

  function optimisticValue(
    field: CustomFieldWithValueDto,
    next: string | null,
  ): CustomFieldValueDto | null {
    if (next === null) return null;
    const base: CustomFieldValueDto = {
      text: null,
      number: null,
      date: null,
      option: null,
      user: null,
    };
    switch (field.fieldType) {
      case 'text':
        return { ...base, text: next };
      case 'number': {
        const n = Number(next);
        return { ...base, number: Number.isFinite(n) ? n : null };
      }
      case 'date':
        return { ...base, date: next };
      case 'select':
        return { ...base, option: field.options.find((o) => o.id === next) ?? null };
      case 'user': {
        const m = members.find((mm) => mm.userId === next);
        return { ...base, user: m ? { id: m.userId, name: m.name, image: null } : null };
      }
    }
  }

  function commit(field: CustomFieldWithValueDto, next: string | null) {
    setError(null);
    closeEditor();
    setOverrides((o) => ({ ...o, [field.id]: optimisticValue(field, next) }));
    startTransition(async () => {
      const res = await setCustomFieldValueAction({ workItemId, fieldId: field.id, value: next });
      if (!res.ok) {
        setOverrides((o) => {
          const nextOverrides = { ...o };
          delete nextOverrides[field.id];
          return nextOverrides;
        });
        setError(res.error);
        setEditingId(field.id);
      }
    });
  }

  function commitDraft(field: CustomFieldWithValueDto) {
    const current =
      field.fieldType === 'text'
        ? (field.value?.text ?? '')
        : field.value?.number != null
          ? String(field.value.number)
          : '';
    const next = draft.trim();
    if (next === current.trim()) {
      closeEditor();
      return;
    }
    commit(field, next === '' ? null : next);
  }

  function commitDate(field: CustomFieldWithValueDto, next: string | null) {
    const current = field.value?.date ? field.value.date.slice(0, 10) : null;
    if (next === current) {
      closeEditor();
      return;
    }
    commit(field, next);
  }

  function commitPick(field: CustomFieldWithValueDto, picked: string, current: string | null) {
    const next = picked === NONE ? null : picked;
    if (next === current) {
      closeEditor();
      return;
    }
    commit(field, next);
  }

  function renderEditor(field: CustomFieldWithValueDto) {
    switch (field.fieldType) {
      case 'text':
      case 'number':
        return (
          <Input
            aria-label={field.label}
            inputMode={field.fieldType === 'number' ? 'decimal' : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitDraft(field)}
            disabled={isPending}
            autoFocus
            error={error ?? undefined}
            errorVariant="box"
          />
        );
      case 'date':
        return (
          <>
            <DatePicker
              aria-label={field.label}
              value={field.value?.date ? field.value.date.slice(0, 10) : null}
              onChange={(next) => commitDate(field, next)}
              disabled={isPending}
              autoOpen
            />
            {error ? <CustomFieldErrorBox>{error}</CustomFieldErrorBox> : null}
          </>
        );
      case 'select': {
        const currentOption = field.value?.option ?? null;
        // Archived options are excluded from new selection; a CURRENT archived
        // value stays visible on the trigger (via the placeholder slot, with
        // its archived mark) without re-entering the menu.
        const options: ComboboxOption<string>[] = [
          { value: NONE, label: t('none') },
          ...field.options.filter((o) => !o.archived).map((o) => ({ value: o.id, label: o.label })),
        ];
        return (
          <>
            <Combobox
              options={options}
              // A current ARCHIVED value is not in the menu, so it can't be the
              // Combobox `value`; it stays visible on the trigger through the
              // placeholder slot, carrying its archived mark.
              value={currentOption ? (currentOption.archived ? null : currentOption.id) : NONE}
              onChange={(v) => commitPick(field, v, currentOption?.id ?? null)}
              label={field.label}
              placeholder={
                currentOption?.archived
                  ? `${currentOption.label} ${t('customFields.archivedMark')}`
                  : t('customFields.selectOption')
              }
              searchable={options.length - 1 >= SEARCHABLE_AT}
              searchPlaceholder={t('customFields.searchOptions')}
              emptyText={t('customFields.noOptions')}
              disabled={isPending}
              autoOpen
            />
            {error ? <CustomFieldErrorBox>{error}</CustomFieldErrorBox> : null}
          </>
        );
      }
      case 'user': {
        const currentUserId = field.value?.user?.id ?? null;
        const options: ComboboxOption<string>[] = [
          { value: NONE, label: t('none') },
          ...members.map((m) => ({
            value: m.userId,
            label: m.name,
            secondary: m.email,
            keywords: m.email,
          })),
        ];
        return (
          <>
            <Combobox
              options={options}
              value={currentUserId ?? NONE}
              onChange={(v) => commitPick(field, v, currentUserId)}
              label={field.label}
              placeholder={t('customFields.selectMember')}
              searchable
              searchPlaceholder={t('customFields.searchMembers')}
              emptyText={t('customFields.noMembers')}
              disabled={isPending}
              autoOpen
            />
            {error ? <CustomFieldErrorBox>{error}</CustomFieldErrorBox> : null}
          </>
        );
      }
    }
  }

  return {
    valued: effFields.filter((f) => f.value !== null),
    empty: effFields.filter((f) => f.value === null),
    editingId,
    openEditor,
    closeEditor,
    onToggle: (field, isEditing) => {
      if (!isEditing) openEditor(field);
      else if (field.fieldType === 'text' || field.fieldType === 'number') commitDraft(field);
      else closeEditor();
    },
    renderEditor,
    isPending,
    error,
  };
}
