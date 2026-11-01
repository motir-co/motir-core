import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The REFUSAL ALERT BLOCK — design `starter-library` § Colour and shape roles:
 * the shipped row's failure treatment given a tinted box, the hue in the border
 * and the glyph, the copy on `--el-danger-surface-text`. A bold lead says what
 * was refused; the body says why and what to do.
 */
export function StarterAlert({
  title,
  children,
  testId,
}: {
  title: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-danger-surface-text)"
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-(--el-danger-on-surface)"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <b className="font-semibold text-(--el-text-strong)">{title}</b>
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
