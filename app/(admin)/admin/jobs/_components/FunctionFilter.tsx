'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { PlatformDlqFunctionDTO } from '@/lib/dto/jobs';
import { jobsHref } from './href';

/** The option value that stands for every function (`?fn=` absent). */
const ALL = '__all__';

/**
 * Function filter — **All functions** with the total waiting, then one option
 * per function the read service returned, each with its waiting count, most
 * waiting first (the service's order). The choice lives in `?fn=`, so it is a
 * navigation, not local state: the server must answer a different list.
 *
 * A `value` that is not among `functions` reads as All functions.
 */
export function FunctionFilter({
  functions,
  total,
  value,
}: {
  functions: PlatformDlqFunctionDTO[];
  total: number;
  value: string | null;
}) {
  const t = useTranslations('platformAdmin');
  const router = useRouter();
  const known = value !== null && functions.some((f) => f.functionId === value);
  const options: ComboboxOption<string>[] = [
    { value: ALL, label: t('jobs.fn.all'), trailing: <Count n={total} /> },
    ...functions.map((f) => ({
      value: f.functionId,
      label: f.functionId,
      trailing: <Count n={f.unreplayed} />,
    })),
  ];
  return (
    <Combobox
      className="w-[20rem] max-w-full"
      label={t('jobs.fn.label')}
      options={options}
      value={known ? value : ALL}
      searchable={false}
      onChange={(next) => {
        router.push(jobsHref({ tab: 'dlq', fn: next === ALL ? undefined : next }));
      }}
    />
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-sans text-xs tabular-nums text-(--el-text-secondary)">{n}</span>;
}
