// Typed errors for the filter domain (Story 6.1 · Subtask 6.1.1). The
// operator registry is TOTAL over an open input space (mistake #29): an
// unknown field id, an unknown operator, a malformed value, or an over-cap
// AST is an explicit, typed rejection — never a silent pass-through into SQL
// and never a generic throw. The route/page layer maps every one of these to
// a 422, matching the `readonly code` convention the workspaces / work-items
// domains established.

export type FilterErrorTag =
  | 'UNKNOWN_FILTER_FIELD'
  | 'UNKNOWN_FILTER_OPERATOR'
  | 'INVALID_FILTER_VALUE'
  | 'FILTER_TOO_LARGE'
  | 'MALFORMED_FILTER';

export abstract class FilterValidationError extends Error {
  abstract readonly tag: FilterErrorTag;
  /** Mirrors `tag` — what the HTTP layer serializes (the house convention). */
  get code(): FilterErrorTag {
    return this.tag;
  }
  /**
   * The 0-based index of the condition the refusal is about, when a caller that
   * validated a whole STORED filter located it (MOTIR-10560: a board's stored
   * filter write, so the create dialog and the settings editor can name
   * "Condition n"). Unset when the failure is the whole filter's, or when no
   * caller looked.
   */
  conditionIndex?: number;
}

/** A condition names a field the registry does not know. */
export class UnknownFilterFieldError extends FilterValidationError {
  readonly tag = 'UNKNOWN_FILTER_FIELD' as const;
  constructor(readonly field: string) {
    super(`Unknown filter field: ${field}`);
  }
}

/** A condition names an operator outside its field's registered set. */
export class UnknownFilterOperatorError extends FilterValidationError {
  readonly tag = 'UNKNOWN_FILTER_OPERATOR' as const;
  constructor(
    readonly field: string,
    readonly operator: string,
  ) {
    super(`Unknown operator for filter field ${field}: ${operator}`);
  }
}

/** A condition's value fails its (field, operator) arity/shape validation. */
export class InvalidFilterValueError extends FilterValidationError {
  readonly tag = 'INVALID_FILTER_VALUE' as const;
  constructor(
    readonly field: string,
    readonly operator: string,
    detail: string,
  ) {
    super(`Invalid value for ${field} ${operator}: ${detail}`);
  }
}

/** The AST exceeds the row cap (the sanity guard the story pins at 20). */
export class FilterTooLargeError extends FilterValidationError {
  readonly tag = 'FILTER_TOO_LARGE' as const;
  constructor(
    readonly rowCount: number,
    readonly cap: number,
  ) {
    super(`Filter has ${rowCount} conditions; the cap is ${cap}`);
  }
}

/** The AST is structurally malformed (not the codec's recoverable decode —
 * this guards direct service/API input that bypassed the codec). */
export class MalformedFilterError extends FilterValidationError {
  readonly tag = 'MALFORMED_FILTER' as const;
  constructor(detail: string) {
    super(`Malformed filter: ${detail}`);
  }
}
