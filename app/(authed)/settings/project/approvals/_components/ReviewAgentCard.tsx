'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import type { PrMergeModeValue } from '@/lib/dto/projects';
import type { ApprovalGateSettingsDTO } from '@/lib/dto/approvalGateSettings';

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
// THE REVIEW GATE AND BOT POSTING (Story MOTIR-11941 · Subtask MOTIR-11946), built to
// `design/github/review-path--person-starts.mock.html` Panels 1, 1b, 1c and
// `design/github/design-notes.md` § 33.1, which amends § 32.7. The card is the *Review*
// setting: a gate on approve-and-merge that a person starts from the item — nothing reviews
// by itself, so there is no *Who reviews* choice and no AI-credits note here (that note is
// the Motir-agent door's). *Post agent reviews on pull requests* is kept as shipped (MOTIR-
// 10337). Each control PATCHes ITS OWN field alone and takes the server's value from the
// response; each carries a monotonic sequence ref, so an older response never lands over a
// newer write. While any write is in flight every control is disabled. The exclusion above
// reads `enabled` alone.
//
// NO read-only state: the room is manage-only (design notes § ⭐ Approvals §6),
// so whoever renders this card may change it — as its two siblings.

export const REVIEW_AGENT_ANCHOR = 'review-agent';

export interface ReviewAgentCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
  /** Whether Motir's bot posts verdicts on the pull requests (on by default). */
  initialBotPostsEnabled?: boolean;
  /** The project's CURRENT merge mode on this page — `auto` makes the switch unavailable. */
  prMergeMode: PrMergeModeValue;
  /** Told every value the switch shows (optimistic, reconciled, put back). */
  onEnabledChange?: (enabled: boolean) => void;
}

type ReviewAgentState = 'on' | 'off' | 'unavailable';
type SettingsPatch = Partial<
  Pick<ApprovalGateSettingsDTO, 'reviewAgentEnabled' | 'reviewBotPostsEnabled'>
>;

export function ReviewAgentCard({
  projectKey,
  initialEnabled,
  initialBotPostsEnabled = true,
  prMergeMode,
  onEnabledChange,
}: ReviewAgentCardProps) {
  const t = useTranslations('approvals.reviewAgent');
  const { toast } = useToast();
  const [enabled, setEnabledState] = useState(initialEnabled);
  const [botPosts, setBotPosts] = useState(initialBotPostsEnabled);
  const [enabledPending, startEnabled] = useTransition();
  const [botPending, startBot] = useTransition();
  // One monotonic sequence per control: only the LATEST write of a control may
  // apply its response or put its value back.
  const enabledSeq = useRef(0);
  const botSeq = useRef(0);
  const isPending = enabledPending || botPending;
  const state: ReviewAgentState = prMergeMode === 'auto' ? 'unavailable' : enabled ? 'on' : 'off';
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

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

  function toggleBotPosts(next: boolean) {
    write(botSeq, startBot, setBotPosts, botPosts, next, { reviewBotPostsEnabled: next }, (s) =>
      Boolean(s.reviewBotPostsEnabled),
    );
  }

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
        state === 'on' ? (
          <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('offNote')}
          </span>
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
