'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Info, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import type { PrMergeModeValue } from '@/lib/dto/projects';
import {
  REVIEW_AGENT_SOURCES,
  type ApprovalGateSettingsDTO,
  type ReviewAgentSourceValue,
} from '@/lib/dto/approvalGateSettings';

// The REVIEW-AGENT switch (Story MOTIR-1626 · Subtask MOTIR-6823), built to
// `design/projects/approvals--review-agent.mock.html` (MOTIR-6816) panels 1–6 and
// `design-notes.md` § "Approvals — the Review agent switch". Composed exactly as
// `AcceptanceVideoGateCard` (optimistic switch, put back on failure, the room's
// toasts), with the `Bot` glyph in the title the way `PrMergeModeCard` carries
// `GitMerge`. A pure client consumer of `PATCH /api/projects/[key]/approval-gates`
// (`{ reviewAgentEnabled }`).
//
// ⚠️ THE EXCLUSION (`docs/decisions/approval-gates.md` §12.2a · panel 2a). A review
// stands in front of a person's approval, and a project that merges automatically
// asks nobody — so in an `auto` project the card reads UNAVAILABLE and its switch
// is off and disabled, whatever the stored flag says. The name and the switch read
// ONE derived `state`, so they cannot disagree. The server refuses the same write
// (409 `REVIEW_AGENT_NEEDS_MANUAL_MERGE`), which a stale page meets as the refused
// state. `prMergeMode` is the page's CURRENT value, lifted by
// `MergeModeAndReviewAgentCards`, so choosing a mode above re-renders this card.
//
// ⚠️ INK. Title and state name `--el-text`; description, gloss and footer lines
// `--el-text-secondary` — never `--el-text-muted` (fails AA on these surfaces).
//
// THE SOURCE CHOICE AND BOT POSTING (Story MOTIR-10327 · Subtask MOTIR-10337),
// built to `design/projects/approvals--review-path.mock.html` S2–S7 and
// `design/github/design-notes.md` §32.7. *Who reviews* — Motir's hosted agent (the
// default) or the person's own agent through `motir review` — is shown only while
// the switch is on, in `PrMergeModeCard`'s radio-card grammar; *Post agent reviews
// on pull requests* is always shown, on by default. The shipped billing note shows
// only with the hosted source, and not while the switch is off (S2). Each control
// PATCHes ITS OWN field alone and takes the server's value from the response; each
// carries a monotonic sequence ref, so an older response never lands over a newer
// write. While any write is in flight every control is disabled (S7). The exclusion
// above reads `enabled` alone, never the source (S6).
//
// NO read-only state: the room is manage-only (design notes § ⭐ Approvals §6),
// so whoever renders this card may change it — as its two siblings.

export const REVIEW_AGENT_ANCHOR = 'review-agent';

export interface ReviewAgentCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
  /** The stored source (`hosted` when the project never chose one). */
  initialSource?: ReviewAgentSourceValue;
  /** Whether Motir's bot posts verdicts on the pull requests (on by default). */
  initialBotPostsEnabled?: boolean;
  /** The project's CURRENT merge mode on this page — `auto` makes the switch unavailable. */
  prMergeMode: PrMergeModeValue;
  /** Told every value the switch shows (optimistic, reconciled, put back). */
  onEnabledChange?: (enabled: boolean) => void;
}

type ReviewAgentState = 'on' | 'off' | 'unavailable';
type SettingsPatch = Partial<
  Pick<
    ApprovalGateSettingsDTO,
    'reviewAgentEnabled' | 'reviewAgentSource' | 'reviewBotPostsEnabled'
  >
>;

const SOURCE_ICON: Record<ReviewAgentSourceValue, LucideIcon> = {
  hosted: Bot,
  own: SquareTerminal,
};
const SOURCE_TINT: Record<ReviewAgentSourceValue, string> = {
  hosted: 'bg-(--el-tint-lavender)',
  own: 'bg-(--el-tint-sky)',
};

export function ReviewAgentCard({
  projectKey,
  initialEnabled,
  initialSource = 'hosted',
  initialBotPostsEnabled = true,
  prMergeMode,
  onEnabledChange,
}: ReviewAgentCardProps) {
  const t = useTranslations('approvals.reviewAgent');
  const { toast } = useToast();
  const [enabled, setEnabledState] = useState(initialEnabled);
  const [source, setSource] = useState<ReviewAgentSourceValue>(initialSource);
  const [botPosts, setBotPosts] = useState(initialBotPostsEnabled);
  const [enabledPending, startEnabled] = useTransition();
  const [sourcePending, startSource] = useTransition();
  const [botPending, startBot] = useTransition();
  // One monotonic sequence per control: only the LATEST write of a control may
  // apply its response or put its value back.
  const enabledSeq = useRef(0);
  const sourceSeq = useRef(0);
  const botSeq = useRef(0);
  const isPending = enabledPending || sourcePending || botPending;
  const state: ReviewAgentState = prMergeMode === 'auto' ? 'unavailable' : enabled ? 'on' : 'off';
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;
  const emphasis = (chunks: ReactNode) => (
    <b className="font-semibold text-(--el-text)">{chunks}</b>
  );
  const cmd = (chunks: ReactNode) => <code className="font-mono">{chunks}</code>;

  function setEnabled(next: boolean) {
    setEnabledState(next);
    onEnabledChange?.(next);
  }

  /** PATCH one field; resolve the server's settings, or throw. */
  async function patch(body: SettingsPatch): Promise<ApprovalGateSettingsDTO> {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/approval-gates`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
    return (await res.json()) as ApprovalGateSettingsDTO;
  }

  /**
   * The room's optimistic write for ONE control: show `next`, PATCH it alone, take
   * the server's value, or put `previous` back with the error toast. A response
   * whose sequence is no longer the control's latest is dropped.
   */
  function write<V>(
    seq: { current: number },
    start: (fn: () => Promise<void>) => void,
    apply: (value: V) => void,
    previous: V,
    next: V,
    body: SettingsPatch,
    pick: (settings: ApprovalGateSettingsDTO) => V,
  ) {
    const mine = ++seq.current;
    apply(next);
    start(async () => {
      try {
        const settings = await patch(body);
        if (mine !== seq.current) return;
        apply(pick(settings));
        toast({ variant: 'success', title: t('saved') });
      } catch {
        if (mine !== seq.current) return;
        apply(previous);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  function toggle(next: boolean) {
    write(enabledSeq, startEnabled, setEnabled, enabled, next, { reviewAgentEnabled: next }, (s) =>
      Boolean(s.reviewAgentEnabled),
    );
  }

  function chooseSource(next: ReviewAgentSourceValue) {
    if (next === source) return;
    write(
      sourceSeq,
      startSource,
      setSource,
      source,
      next,
      { reviewAgentSource: next },
      (s) => s.reviewAgentSource,
    );
  }

  function toggleBotPosts(next: boolean) {
    write(botSeq, startBot, setBotPosts, botPosts, next, { reviewBotPostsEnabled: next }, (s) =>
      Boolean(s.reviewBotPostsEnabled),
    );
  }

  const showBilling = source === 'hosted' && state !== 'off';

  return (
    <Card
      // The Development frame's settings door (MOTIR-6817) lands here, as
      // `#merge-mode` and `#acceptance-video` are landed on.
      id={REVIEW_AGENT_ANCHOR}
      className="scroll-mt-6"
      header={
        <div>
          <h2 className="flex items-center gap-2 font-sans text-base font-semibold text-(--el-text)">
            <Bot className="size-4" aria-hidden />
            {t('title')}
          </h2>
          <p className="text-(--el-text-secondary) font-sans text-sm">
            {t.rich('desc', { strong })}
          </p>
        </div>
      }
      footer={
        showBilling || state === 'on' ? (
          <div className="flex flex-col items-start gap-1.5">
            {showBilling ? (
              <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('billingNote')}
              </span>
            ) : null}
            {state === 'on' ? (
              <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
                <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('offNote')}
              </span>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">{t(state)}</span>
            <span className="text-(--el-text-secondary) font-sans text-xs">
              {t.rich(`${state}What`, { strong })}
            </span>
          </span>
          <Switch
            checked={state === 'on'}
            onCheckedChange={toggle}
            disabled={state === 'unavailable' || isPending}
            aria-label={t('title')}
          />
        </div>
        {state === 'on' ? (
          <div className="flex flex-col gap-2 border-t border-(--el-border-soft) pt-3">
            <span
              id={`${REVIEW_AGENT_ANCHOR}-source`}
              className="font-sans text-sm font-medium text-(--el-text)"
            >
              {t('source.label')}
            </span>
            <div
              role="radiogroup"
              aria-labelledby={`${REVIEW_AGENT_ANCHOR}-source`}
              className="flex flex-col gap-2"
            >
              {REVIEW_AGENT_SOURCES.map((value) => {
                const Icon = SOURCE_ICON[value];
                const selected = source === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={isPending}
                    onClick={() => chooseSource(value)}
                    className={`focus-visible:ring-(--focus-ring-color) enabled:hover:border-(--el-border-strong) flex items-center gap-3 rounded-(--radius-card) border bg-(--el-page-bg) p-(--spacing-card-padding-12) text-left focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default ${
                      selected ? 'border-(--el-text)' : 'border-(--el-border)'
                    }`}
                  >
                    <span
                      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-strong) ${SOURCE_TINT[value]}`}
                      aria-hidden
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="font-sans text-sm font-medium text-(--el-text)">
                        {t(`source.${value}`)}
                      </span>
                      <span className="text-(--el-text-secondary) font-sans text-xs">
                        {t.rich(`source.${value}What`, { strong: emphasis, cmd })}
                      </span>
                    </span>
                    <span
                      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                        selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                      }`}
                      aria-hidden
                    >
                      {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4 border-t border-(--el-border-soft) pt-3">
          <span className="flex flex-col gap-0.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('posting.title')}
            </span>
            <span className="text-(--el-text-secondary) font-sans text-xs">
              {t(botPosts ? 'posting.on' : 'posting.off')}
            </span>
          </span>
          <Switch
            checked={botPosts}
            onCheckedChange={toggleBotPosts}
            disabled={isPending}
            aria-label={t('posting.title')}
          />
        </div>
      </div>
    </Card>
  );
}
