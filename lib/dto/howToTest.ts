import type { WorkItemRefMap } from '@/lib/dto/workItems';

// Wire DTOs for the HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333).
//
// HOW TO TEST is per RUN, on the RUN TARGET (`docs/decisions/approval-gates.md`
// §9's 2026-09-13 amendment). The read answers for ONE item: its current
// record — the rich-text body its author wrote — and its earlier versions. The
// PINNED shape is `design/github/design-notes.md` § 25's Fields-read table
// (MOTIR-5694), less the stale pairs MOTIR-6065 retired.
//
// ⚠️ NO PER-REPOSITORY FACTS. The preview, the fetch line and the checks this
// read used to derive per repository were RETIRED with the sub-block that drew
// them (§ 25; MOTIR-5691): they are the pull request's facts, and its row one
// line above carries or links to every one of them. Do not reintroduce them
// here — a later card that wants one asks for it ON THE ROW.

/** A dispatch run, as the block names it. */
export interface HowToTestRunDto {
  runId: string;
  label: string;
}

/**
 * WHO wrote a record (Story MOTIR-5450 · Subtask MOTIR-5454).
 *
 * `approval-gates.md` §9's 2026-09-17 amendment, point 1: TWO AUTHOR KINDS, ONE
 * RECORD, ONE WRITER. A record written by a dispatch run is a `run` author; one
 * written by a person from the item page is a `person` author. They are the same
 * row in the same table, written by the same `testInstructionsService.publish`,
 * and the block renders them identically apart from this line.
 *
 * `userId` is NULL when the publisher's account was deleted — `published_by_id`
 * is `SetNull`, like every audit stamp on the row — and the label is then the
 * product's standing string for an attribution whose referent is gone. It is
 * never blank: a missing author reads as a removed member, not as nobody.
 */
export type HowToTestAuthorDto =
  | { kind: 'run'; runId: string; label: string }
  | { kind: 'person'; userId: string | null; label: string };

/** The current record — what is ONE for the run target. */
export interface HowToTestRecordDto {
  id: string;
  /**
   * WHO wrote it — a run or a person. Always present.
   *
   * ⚠️ IT REPLACED a `run: HowToTestRunDto | null` field, DELETED by MOTIR-5455.
   * `run` could name a dispatch run and nothing else, so a person's record read
   * as `null` there — indistinguishable from an agent record whose run was
   * pruned. MOTIR-5454 added `author` and kept `run` alive so the block would
   * not break mid-story; this is where it dies. Do not reintroduce it: the
   * question it answered is `author.kind === 'run'`.
   */
  author: HowToTestAuthorDto;
  createdAt: string;
  /** The rich-text How to test, as its author wrote it. */
  bodyMd: string;
  /** The chips of every `[KEY](motir:<id>)` in `bodyMd`, resolved for the reader
   *  (bug MOTIR-10023) — `{}` when it links nothing. */
  workItemRefs: WorkItemRefMap;
  previewPath: string | null;
}

/** An earlier record, for the "Earlier versions" disclosure. */
export interface HowToTestHistoryEntryDto {
  recordId: string;
  /** WHO wrote it — a run or a person. Always present. See the record's note. */
  author: HowToTestAuthorDto;
  createdAt: string;
}

export interface HowToTestDto {
  /**
   * `record` — this item is a run target with a current record.
   * `record_missing` — no run has written one here (and no ancestor carries one).
   * `tested_via_ancestor` — this item has none, and its nearest ancestor that
   * does is `runTarget` (a child of a container run).
   */
  state: 'record' | 'record_missing' | 'tested_via_ancestor';
  /** The ancestor holding the record, for `tested_via_ancestor`; null otherwise. */
  runTarget: { key: string } | null;
  /** The latest run that targeted or carried this item, for `record_missing`. */
  owedBy: HowToTestRunDto | null;
  record: HowToTestRecordDto | null;
  // ⚠️ NO `stale` (MOTIR-6065). It named each section whose pull request had
  // moved past the commit the record was written for, and fired on every push:
  // How to test is written for the work item, not for a commit. The agent that
  // pushes is told to re-publish when its commits change the steps.
  /** Earlier runs' records, newest first (the current one excluded). */
  history: HowToTestHistoryEntryDto[];
}
