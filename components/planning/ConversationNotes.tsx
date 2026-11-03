'use client';

import { useTranslations } from 'next-intl';

import type { ConversationNoteDto } from '@/lib/dto/conversationNote';

/**
 * WHAT A CONVERSATION JOB SAID WHILE IT WORKED (MOTIR-10235) — a Grill me read or
 * an answering session, in the session's own words, drawn in the rail the way the
 * planner's narration is (`PlanNarration`, design `design/ai-chat/design-notes.md`
 * § "⭐ Planner narration in the chat panel", MOTIR-8061): the soft surface, the
 * ruled list, earlier sentences on `--el-text-secondary` and, while the job runs,
 * the latest one on `--el-text`. A conversation job has no step words, so there
 * is no group head: one job's notes are one list.
 *
 * Built only from the STORED notes (`session.notes`), so they are there again
 * after the person leaves and comes back.
 *
 * ⚠️ QUIET IN THE LOG, as the planning notes are: `aria-live="off"`, so a sentence
 * is never spoken as it lands. ⚠️ AS WRITTEN: a note is shown as stored, never
 * through `t()`, with `dir="auto"` and no `lang`.
 */
export interface ConversationNotesProps {
  notes: readonly ConversationNoteDto[];
  /** The job is still working: its latest note is the line it is on now. */
  live: boolean;
}

export function ConversationNotes({ notes, live }: ConversationNotesProps) {
  const tc = useTranslations('planningWorkspace.conversation');
  if (notes.length === 0) return null;
  return (
    <div
      data-testid="conversation-notes"
      data-live={live ? 'true' : 'false'}
      aria-live="off"
      aria-busy={live}
      className="ml-9 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-xs"
    >
      <ol
        aria-label={tc('narration.label')}
        className="flex flex-col gap-1 border-l border-(--el-border-strong) pl-2.5"
      >
        {notes.map((note, i) => (
          <li
            // Notes are append-only and never reordered, so the position is stable.
            key={i}
            dir="auto"
            data-testid="conversation-note"
            className={`leading-relaxed wrap-anywhere ${
              live && i === notes.length - 1 ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
            }`}
          >
            {note.body}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The notes one job wrote, in the order they were written. */
export function notesOfJob(
  notes: readonly ConversationNoteDto[] | undefined,
  jobId: string | null | undefined,
): ConversationNoteDto[] {
  if (!notes || !jobId) return [];
  return notes.filter((n) => n.jobId === jobId);
}

/**
 * The notes of a job that produced no reply and is no longer running: a read a Stop
 * superseded, or an answer that settled silent. No reply turn will ever draw them, so
 * the turn that submitted the job does, and they are not lost.
 */
export function notesOfUnansweredJob(
  notes: readonly ConversationNoteDto[] | undefined,
  jobId: string | null | undefined,
  answeredJobs: ReadonlySet<string | null>,
  liveJobId: string | null | undefined,
): ConversationNoteDto[] {
  if (!jobId || answeredJobs.has(jobId) || jobId === liveJobId) return [];
  return notesOfJob(notes, jobId);
}
