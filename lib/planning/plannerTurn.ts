// The CONSUMING half of MOTIR-2222's boundary contract (MOTIR-2226): reading the
// planning turn's UTTERANCE off a motir-ai job result.
//
// motir-ai's envelope documents this field as "purely additive; core reads
// results loosely", and that is the posture here — the producer ships ahead of
// the consumer by design, so a job from an older engine (or a kind that emits no
// turn at all: `plan_sprint`, `code_audit`, the discovery conductor) simply has
// nothing to say and yields null. A missing, malformed or empty `turn` is NEVER
// an error: the plan-edit run itself succeeded, its proposals are on the canvas,
// and the worst outcome of an unreadable utterance is a thread with no narration
// — not a failed change.
//
// The one thing this does NOT do is trust the shape. The field crosses a network
// boundary from a separately-deployed service, so every branch is checked before
// it becomes a persisted row: a non-string `message` is dropped, a `question`
// that is not a non-empty string reads as "did not ask" (which merely means the
// rail does not wait for an answer — the safe direction), and both bodies are
// bounded so a runaway generation cannot write an unbounded row.
//
// A question's OPTIONS (MOTIR-11700) are read the same way: `turn.options` is a list
// of `{ id, label, means }` the person clicks, read by `readQuestionOptions` and kept
// only beside a question — a malformed list, or options on a turn that did not ask,
// read as none, so the question is drawn with only the box for the person's words.

import { readQuestionOptions, type QuestionOption } from '@/lib/planning/questionOptions';

/** The shape of `PlanningTurn` (motir-ai `src/llm/planningTurn.ts`) that the
 *  plan-change thread actually consumes: what the planner SAID, and whether it
 *  asked. The `action` / structured `report` are the producer's own concern. */
export interface PlannerUtterance {
  /** The chat utterance — the findings report, plus the question when asking. */
  message: string;
  /** The ONE Gate-2 question, or null when the turn did not ask. */
  question: string | null;
  /** That question's 2 to 4 options (MOTIR-11700), or null when none were readable. */
  options: QuestionOption[] | null;
}

// Bounds applied on READ, not merely trusted from the producer. motir-ai caps its
// own summary at 600 chars, but a bound the consumer does not enforce is a bound
// the consumer does not have — and this text becomes a database row.
export const PLANNER_MESSAGE_MAX_CHARS = 4000;
export const PLANNER_QUESTION_MAX_CHARS = 600;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the planner's utterance off a job result, or null when there is none to
 * read. Total over any input — an arbitrary JSON value is a legitimate argument
 * and answers null rather than throwing.
 *
 * A turn whose `message` is unusable yields null EVEN IF it carried a question:
 * the question is rendered inside the utterance bubble, so a question with no
 * body to render would put the rail into a waiting state the user can see no
 * reason for — worse than staying silent.
 */
export function readPlanningTurn(result: unknown): PlannerUtterance | null {
  if (!isRecord(result)) return null;
  const turn = result['turn'];
  if (!isRecord(turn)) return null;

  const message = boundedString(turn['message'], PLANNER_MESSAGE_MAX_CHARS);
  if (message === null) return null;

  const question = boundedString(turn['question'], PLANNER_QUESTION_MAX_CHARS);
  return { message, question, options: question ? readQuestionOptions(turn['options']) : null };
}
