// THE OPTIONS OF A QUESTION PUT TO A PERSON (MOTIR-11700) — the consuming half.
//
// motir-ai gives every question it puts to a person 2 to 4 options as data, each
// `{ id, label, means }` with ids it assigned itself (`o1`…`o4`). They arrive on a
// planning turn (`turn.options`) and on a mid-run pause (`options`), and they are
// drawn as choices the person clicks beside a box for their own words. The answer
// then travels back as WHICH option was picked — never as free text the planner has
// to read back into one of its own options — or marked as the person's own words.
//
// Read LOOSELY, like every field off the AI boundary (`plannerTurn.ts`): a missing
// or malformed list is "no options", which is how a question from an engine that
// predates them is drawn — a question with only the box. Never an error.

/** One option of a question, as the person is shown it and as their pick travels back. */
export interface QuestionOption {
  /** Assigned by motir-ai, in order: `o1` … `o4`. */
  id: string;
  /** The words on the button. */
  label: string;
  /** One line on what follows if the person picks it. */
  means: string;
}

export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 4;
/** Bounds applied on READ (the producer caps at 120 / 400; this text becomes a row). */
export const QUESTION_OPTION_ID_MAX_CHARS = 16;
export const QUESTION_OPTION_LABEL_MAX_CHARS = 120;
export const QUESTION_OPTION_MEANS_MAX_CHARS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** ONE option, or null when it is not a well-formed one. */
export function readQuestionOption(raw: unknown): QuestionOption | null {
  if (!isRecord(raw)) return null;
  const id = bounded(raw['id'], QUESTION_OPTION_ID_MAX_CHARS);
  const label = bounded(raw['label'], QUESTION_OPTION_LABEL_MAX_CHARS);
  const means = bounded(raw['means'], QUESTION_OPTION_MEANS_MAX_CHARS);
  return id && label && means ? { id, label, means } : null;
}

/**
 * A question's options off any value — the AI boundary's or a stored column — or null
 * when there are none to draw. Malformed entries and repeated ids are dropped; more
 * than the maximum keeps the first four; fewer than the minimum reads as none.
 */
export function readQuestionOptions(raw: unknown): QuestionOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const option = readQuestionOption(entry);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(option);
    if (out.length === QUESTION_OPTIONS_MAX) break;
  }
  return out.length >= QUESTION_OPTIONS_MIN ? out : null;
}

/** The option `id` names among `options`, or null — the pick a person's click claims. */
export function findQuestionOption(
  options: readonly QuestionOption[] | null,
  id: string | null | undefined,
): QuestionOption | null {
  if (!options || !id) return null;
  return options.find((o) => o.id === id) ?? null;
}

/** A plain JSON copy of one option, the shape every column stores. */
export function questionOptionJson(option: QuestionOption): {
  id: string;
  label: string;
  means: string;
} {
  return { id: option.id, label: option.label, means: option.means };
}

/**
 * The words an ANSWER is read as by the planner (MOTIR-11700). A picked option is
 * named WITH what it means, so the planner acts on the option it offered rather than
 * re-reading a label; an answer typed instead of picking one, to a question that
 * offered options, says so, so it is read as the person's instruction rather than as
 * one of the options. Any other turn is its text verbatim.
 */
export function answerTextFor(turn: {
  body: string;
  answerOption?: QuestionOption | null;
  ownWords?: boolean;
}): string {
  if (turn.answerOption) {
    return `I picked your option "${turn.answerOption.label}" (${turn.answerOption.id}): ${turn.answerOption.means}`;
  }
  if (turn.ownWords) return `In my own words, none of your options: ${turn.body}`;
  return turn.body;
}

/** The words a planner turn that ASKED is read back as: its body, then the options it offered. */
export function askedTextFor(turn: {
  body: string;
  questionOptions?: QuestionOption[] | null;
}): string {
  if (!turn.questionOptions || turn.questionOptions.length === 0) return turn.body;
  const lines = turn.questionOptions.map((o) => `  • ${o.label} (${o.id}) — ${o.means}`);
  return `${turn.body}\n\nThe options I offered:\n${lines.join('\n')}`;
}

/** The fields of a thread turn the option helpers read — a row or a DTO alike. */
export interface OptionTurn {
  role: string;
  body: string;
  question?: string | null;
  questionOptions?: unknown;
  isAnswer?: boolean;
  answerOption?: unknown;
}

/**
 * The options of the question the thread WAITS on — its latest planner turn, when no
 * person's turn came after it — or null. The scan `pendingQuestion` makes, over rows
 * or DTOs, so the server resolves a pick against exactly what the rail drew.
 */
export function waitingQuestionOptions(turns: readonly OptionTurn[]): QuestionOption[] | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.role === 'user') return null;
    if (turn.role === 'assistant') {
      return turn.question ? readQuestionOptions(turn.questionOptions) : null;
    }
  }
  return null;
}

/**
 * Each turn's text as the PLANNER reads it back (MOTIR-11700), in order: a planner
 * turn that asked carries the options it offered; an answer says which option it
 * picked, with what it means, or — when the question offered options and none was
 * picked — that it is the person's own words. Every other turn is its body.
 */
export function plannerReadTexts(turns: readonly OptionTurn[]): string[] {
  return turns.map((turn, index) => {
    if (turn.role === 'assistant') {
      return askedTextFor({
        body: turn.body,
        questionOptions: turn.question ? readQuestionOptions(turn.questionOptions) : null,
      });
    }
    if (turn.role !== 'user' || !turn.isAnswer) return turn.body;
    const answerOption = readQuestionOption(turn.answerOption);
    const offered = waitingQuestionOptions(turns.slice(0, index));
    return answerTextFor({ body: turn.body, answerOption, ownWords: !answerOption && !!offered });
  });
}
