'use client';

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { DomainApplicationDto } from '@/lib/dto/publicAddresses';

/** The picker's value for "No application yet" — never an application id (cuids). */
export const NO_APPLICATION = 'none';

/**
 * THE APPLICATION PICKER (MOTIR-9529), built to
 * `design/workspace-address/custom-domains--application.mock.html` panels A and
 * C: the shipped Combobox, one row per application of the workspace (its name,
 * its slug beside it), then `No application yet`.
 *
 * It owns no read and so no loading or failed state: the applications arrive
 * with the rest of the pane, and a workspace with none is the caller's
 * absent-picker line, not an empty listbox.
 */
export function ApplicationPicker({
  applications,
  value,
  onChange,
  disabled = false,
}: {
  applications: readonly DomainApplicationDto[];
  /** An application id, `NO_APPLICATION`, or `null` for nothing chosen yet. */
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('settings.customDomains');
  const options: ComboboxOption<string>[] = [
    ...applications.map((a) => ({
      value: a.id,
      label: a.name,
      secondary: a.slug,
      keywords: a.slug,
    })),
    // Last, after every application. The shipped Combobox has no separator row,
    // and a blank group header would be an empty heading to a screen reader.
    { value: NO_APPLICATION, label: t('dialog.appNone') },
  ];
  return (
    <div className="flex flex-col gap-1">
      {/* The Combobox carries the same label as its accessible name. */}
      <span aria-hidden className="font-sans text-sm font-medium text-(--el-text)">
        {t('dialog.appLabel')}
      </span>
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        label={t('dialog.appLabel')}
        placeholder={t('dialog.appChoose')}
        disabled={disabled}
      />
      <span className="font-sans text-[12px] text-(--el-text-secondary)">
        {t('dialog.appHelper')}
      </span>
    </div>
  );
}
