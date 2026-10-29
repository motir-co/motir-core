import { type ReactNode } from 'react';
import { Check, CircleX, ExternalLink, Info, RotateCw } from 'lucide-react';
import { BrandMark } from '@/components/brand/BrandMark';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';

// The PREVIEW-HOST frame (Story MOTIR-5766 · Subtask MOTIR-5779; design
// `design/preview/preview-gate.mock.html` Panels 4–8, `design-notes.md` "The
// chrome, and why it has no app navigation"). Motir's, on a tenant's address:
// a brand bar with the lockup and a Preview tag, ONE card, one primary action,
// and a footer naming the address. No app navigation — the host carries no
// Motir session — and no form field, ever: a Motir shell holding a password box
// on a foreign address is the shape a phishing page takes.

export function PreviewGateFrame({
  tag,
  brand,
  footer,
  children,
}: {
  tag: string;
  brand: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-(--el-surface) pb-10">
      <header className="flex w-full items-center gap-2 border-b border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding) py-(--spacing-card-padding-12) text-(--el-text)">
        <BrandMark size={24} label={brand} />
        <Pill tone="private" className="ml-1">
          {tag}
        </Pill>
      </header>
      <main
        data-surface="card"
        className="flex w-[calc(100%-2.5rem)] max-w-[30rem] flex-col gap-4 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) shadow-(--shadow-card)"
      >
        {children}
      </main>
      <footer className="w-[calc(100%-2.5rem)] max-w-[30rem] text-center font-sans text-xs leading-relaxed text-(--el-text-secondary)">
        {footer}
      </footer>
    </div>
  );
}

/** The address in the footer — an inline code chip. */
export function PreviewHostChip({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-[11.5px] break-all text-(--el-code-text)">
      {children}
    </code>
  );
}

export type PreviewPillKind = 'building' | 'failed' | 'quiet';

/** The card's head: the state pill, the heading and the body copy. */
export function PreviewGateHead({
  pill,
  pillKind,
  title,
  children,
}: {
  pill: string;
  pillKind: PreviewPillKind;
  title: string;
  children?: ReactNode;
}) {
  const icon =
    pillKind === 'failed' ? (
      <CircleX className="h-3 w-3" aria-hidden />
    ) : pillKind === 'quiet' ? (
      <Info className="h-3 w-3" aria-hidden />
    ) : (
      <RotateCw className="h-3 w-3" aria-hidden />
    );
  return (
    <div className="flex flex-col gap-2.5">
      {pillKind === 'quiet' ? (
        <Pill tone="archived" className="gap-1 self-start">
          {icon}
          {pill}
        </Pill>
      ) : (
        <Pill severity={pillKind === 'failed' ? 'danger' : 'warning'} className="gap-1 self-start">
          {icon}
          {pill}
        </Pill>
      )}
      <h1 className="font-serif text-2xl leading-tight font-semibold text-(--el-text)">{title}</h1>
      {children ? (
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">{children}</p>
      ) : null}
    </div>
  );
}

/** Building → Starting → Ready, the current one marked `aria-current`. */
export function PreviewGateSteps({
  label,
  steps,
  current,
}: {
  label: string;
  steps: readonly string[];
  current: number;
}) {
  return (
    <ol aria-label={label} className="flex flex-col gap-2.5">
      {steps.map((step, index) => {
        const done = index < current;
        const now = index === current;
        return (
          <li
            key={step}
            aria-current={now ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2.5 font-sans text-sm',
              done || now ? 'text-(--el-text)' : 'text-(--el-text-secondary)',
              now && 'font-semibold',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-2',
                done && 'border-(--el-success) bg-(--el-success) text-(--el-text-inverted)',
                now && 'border-(--el-warning) border-t-transparent',
                !done && !now && 'border-(--el-border-strong)',
              )}
            >
              {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
            </span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}

/** The refresh line under the steps. */
export function PreviewGateRefresh({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
      <RotateCw className="h-3 w-3 flex-none" aria-hidden />
      {children}
    </p>
  );
}

/** What the preview is OF: the work item and the pull request. */
export function PreviewGateFacts({
  rows,
}: {
  rows: readonly { label: string; value: ReactNode; key?: string }[];
}) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 font-sans text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-(--el-text-secondary)">{row.label}</dt>
          <dd className="min-w-0 text-(--el-text)">
            {row.key ? (
              <span className="mr-1.5 font-mono text-xs text-(--el-text-secondary)">{row.key}</span>
            ) : null}
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The reason callout: the hue in the BORDER and the GLYPH, the words on
 * `--el-text` (CLAUDE.md's danger rule — never `--el-danger-text`, which is the
 * ink for a danger FILL). `neutral` is Panel 6b's: the preview is fine, the
 * request is what the gate cannot carry.
 */
export function PreviewGateCallout({
  title,
  tone,
  children,
}: {
  title?: string;
  tone: 'danger' | 'neutral';
  children: ReactNode;
}) {
  const Glyph = tone === 'danger' ? CircleX : Info;
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2.5 rounded-(--radius-card) border border-l-4 bg-(--el-page-bg) p-(--spacing-card-padding-12)',
        tone === 'danger' ? 'border-(--el-danger)' : 'border-(--el-border-strong)',
      )}
    >
      <Glyph
        aria-hidden
        className={cn(
          'mt-0.5 h-4 w-4 flex-none',
          tone === 'danger' ? 'text-(--el-danger)' : 'text-(--el-text-secondary)',
        )}
      />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? (
          <span className="font-sans text-xs font-semibold text-(--el-text)">{title}</span>
        ) : null}
        <span className="font-sans text-sm leading-normal break-words text-(--el-text)">
          {children}
        </span>
      </div>
    </div>
  );
}

/** The one primary action — a link styled as the primary Button. */
export function PreviewGateAction({
  href,
  external = false,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a href={href} className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'self-start')}>
      {children}
      {external ? <ExternalLink className="h-4 w-4" aria-hidden /> : null}
    </a>
  );
}
