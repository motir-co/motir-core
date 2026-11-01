'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, CornerLeftUp, FileQuestionMark } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { formatRunInstant } from '@/lib/runs/runClock';
import {
  AddHowToTestDoor,
  EditHowToTestDoor,
  HowToTestForm,
  useHowToTestWrite,
} from './HowToTestWrite';
import type { HowToTestAuthorDto, HowToTestDto, HowToTestRunDto } from '@/lib/dto/howToTest';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// HOW TO TEST — the approve-to-merge gate's EVIDENCE (Story MOTIR-4906 · Subtask
// MOTIR-5336), built to `design/github/design-notes.md` §20 · Panels 12a–12o.
//
// ⚠️ IT IS A PART OF THE DEVELOPMENT CARD, NEVER A SECTION OF ITS OWN. It renders
// below the pull-request rows under an `h4`, inside the same card, and when the
// approve-and-merge gate awaits it is band 2 of that ONE frame alongside the
// rows. It carries no verb, no gate and no approval (Yue: *"they are the same
// gate, not 2 separated things"*).
//
// WHAT IS WHOSE: How to test is the INSTRUCTIONS (§ 25, MOTIR-5694) — the
// author's `bodyMd`, verbatim, through the ONE Markdown pipeline with copyable
// fences, owned by whoever wrote it. A pull request's facts (its branch, its
// head, its preview, its checks) belong to that pull request's ROW above and are
// never repeated in here.
//
// ⚠️ THE PER-REPOSITORY SUB-BLOCK IS RETIRED (MOTIR-5691). § 20 drew a bordered
// box per repository under the body — In the preview · Locally · What CI proved —
// and § 25 took it out: every fact in it was already on or behind the row one line
// above, and the steps read the same in any environment. Do not bring it back
// here; a later card that wants one of those facts asks for it on the row.
//
// ⚠️ NO STALE LINE (MOTIR-6065). § 25 kept one — *"Written for <sha> — <repo> is
// now at <sha>"* — and it fired on EVERY push, because How to test is written for
// the WORK ITEM, not for a commit: a CI fix moves the head and leaves the steps
// exactly as true. Whether a new commit changed the steps is known only to the
// agent that made it, so its prompt carries the duty to re-publish (the dispatch
// prompt's step 4b and the CLI's fix prompt). Do not bring the line back.
//
// ⚠️ NO URL AT ALL. Each row above keeps its own link-out.
//
// INKS: `--el-text` / `--el-text-secondary` / `--el-text-identifier` only — the
// block renders on the card AND on the frame's `--el-surface` port, where
// `--el-text-muted` measures 4.17:1 and fails AA.

export interface HowToTestBlockProps {
  howToTest: HowToTestDto;
}

/** The part's frame: the soft rule and the column below the rows. */
function Part({ children }: { children: ReactNode }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <div
      role="group"
      aria-label={t('title')}
      data-testid="how-to-test"
      className="mt-4 flex min-w-0 flex-col gap-3 border-t border-(--el-border-soft) pt-4"
    >
      {children}
    </div>
  );
}

function PartHead({ children }: { children?: ReactNode }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h4 className="text-[13px] font-semibold text-(--el-text)">{t('title')}</h4>
      {children}
    </div>
  );
}

const bold = (chunks: ReactNode) => <b className="font-medium text-(--el-text)">{chunks}</b>;

export function HowToTestBlock({ howToTest }: HowToTestBlockProps) {
  const t = useTranslations('github.development.howToTest');
  const state = howToTest.state;
  switch (state) {
    case 'record':
      return howToTest.record ? (
        <RecordPart howToTest={howToTest} />
      ) : (
        <MissingPart owedBy={howToTest.owedBy} />
      );
    case 'record_missing':
      return <MissingPart owedBy={howToTest.owedBy} />;
    case 'tested_via_ancestor':
      return <ChildPointer targetKey={howToTest.runTarget?.key ?? null} />;
    default: {
      // A state this build does not know — the raw value, never a blank.
      const raw: string = state satisfies never;
      return (
        <Part>
          <PartHead />
          <p className="text-[13px] text-(--el-text-secondary)">
            {t('unknownState', { value: String(raw) })}
          </p>
        </Part>
      );
    }
  }
}

/**
 * Panel 12i — no run has written one: a lavender callout at the head of the
 * part, and (13a) the **Add how to test** door under it.
 *
 * ⚠️ THE CALLOUT STAYS when the door is shown (§24, decision 2). A person
 * writing one by hand does not make the run's omission untrue, and the *owed by*
 * line is the only record of which run skipped it.
 */
function MissingPart({ owedBy }: { owedBy: HowToTestRunDto | null }) {
  const t = useTranslations('github.development.howToTest');
  return (
    <Part>
      <PartHead />
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-callout-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] leading-normal text-(--el-callout-text)"
      >
        <FileQuestionMark className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <b className="font-semibold">{t('missing.title')}</b>{' '}
          {owedBy ? t('missing.owedByRun', { run: owedBy.label }) : t('missing.noRun')}
        </span>
      </div>
      <AddHowToTestDoor />
      <HowToTestForm />
    </Part>
  );
}

/** Panel 12m — a child of a container run: ONE line, the target BY KEY. */
function ChildPointer({ targetKey }: { targetKey: string | null }) {
  const routes = useReaderRoutes();
  const t = useTranslations('github.development.howToTest');
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--el-border-soft) pt-3 text-[13px] text-(--el-text-secondary)">
      <CornerLeftUp className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span>
        {t.rich('child.pointer', {
          key: targetKey ?? '',
          link: (chunks) =>
            targetKey ? (
              <Link
                href={routes.item(targetKey)}
                className="font-mono text-[12.5px] text-(--el-link) underline"
              >
                {chunks}
              </Link>
            ) : (
              <span className="font-mono text-[12.5px]">{chunks}</span>
            ),
        })}
      </span>
    </div>
  );
}

function RecordPart({ howToTest }: HowToTestBlockProps) {
  const record = howToTest.record!;
  const write = useHowToTestWrite();

  // Panel 13b: the form takes the part's body. The head stays — it is the part's
  // name, not the record's — and the author line and Edit go with the record
  // they describe.
  if (write?.open) {
    return (
      <Part>
        <PartHead />
        <HowToTestForm />
      </Part>
    );
  }

  return (
    <Part>
      <PartHead>
        <AuthorLine author={record.author} createdAt={record.createdAt} />
        <EditHowToTestDoor />
      </PartHead>

      {record.bodyMd.trim() ? (
        <MarkdownView
          value={record.bodyMd}
          workItemRefs={record.workItemRefs}
          copyableCode
          // `motir-how-to-test` scales the agent's `##` sections down to sub-headings
          // of the card — in `markdown-editor.css`, because the unlayered prose
          // rules there would beat a layered utility here.
          className="motir-how-to-test min-w-0"
        />
      ) : null}

      <EarlierVersions history={howToTest.history} />
    </Part>
  );
}

/**
 * *Written by …* — the ONE line that differs between the two author kinds
 * (§24's Fields-read table; MOTIR-5454 put `author` on the read for this).
 *
 * `run` renders the run's label exactly as §20 drew it; `person` renders the
 * display name. A deleted publisher's label is the product's standing string for
 * an attribution whose referent is gone — never blank, which is why this can be
 * drawn with no empty-author state.
 */
function AuthorLine({ author, createdAt }: { author: HowToTestAuthorDto; createdAt: string }) {
  const t = useTranslations('github.development.howToTest');
  const locale = useLocale();
  return (
    <span className="text-xs text-(--el-text-secondary)">
      {author.kind === 'run'
        ? t.rich('writtenBy', {
            run: author.label,
            time: formatRunInstant(createdAt, locale),
            b: bold,
          })
        : t.rich('writtenByPerson', {
            name: author.label,
            time: formatRunInstant(createdAt, locale),
            b: bold,
          })}
    </span>
  );
}

/** Panel 12j — a collapsed disclosure at the foot of the part. */
/**
 * Panel 13f — *Earlier versions (n)*. The string REPLACES the shipped
 * *Earlier runs (n)* rather than paralleling it (§24, decision 9): once a person
 * can write one, *runs* is the wrong noun for the list, and two strings for one
 * disclosure is how two author kinds start to look like two features.
 */
function EarlierVersions({ history }: { history: HowToTestDto['history'] }) {
  const t = useTranslations('github.development.howToTest');
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-(--radius-control) p-(--spacing-control-x-4) text-left text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        {t('earlier.versions', { count: history.length })}
      </button>
      {open ? (
        <ul className="mt-1 flex list-none flex-col gap-1 pl-6">
          {history.map((entry) => (
            <li key={entry.recordId} className="text-xs text-(--el-text-secondary)">
              {/* Both author kinds, in one list, drawn the same way — the record
                  is one thing with two authors, not two things (13f). */}
              <AuthorLine author={entry.author} createdAt={entry.createdAt} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
