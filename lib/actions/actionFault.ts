import * as Sentry from '@sentry/nextjs';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import { SERVER_ACTION_CONTEXT } from '@/lib/monitoring/expectedDomainErrors';

// The catch-all arm of a Server Action that answers a RESULT, never a throw
// (MOTIR-10972).
//
// An action that maps its typed refusals into a discriminated result and turns
// everything else into a generic `FAILED` swallows the fault twice over: no
// throw reaches `onRequestError`, and a log line without the error says only
// that something failed. The fleet switch failed exactly that way in
// production — two `FAILED` answers, a log line naming the pair, no error and
// no Sentry event — so the cause could not be read anywhere.
//
// So the arm logs the error beside the action's context, and reports it to
// Sentry at `error` with the same context under SERVER_ACTION_CONTEXT, which
// `dropExpectedDomainErrors` always keeps. The person still sees the action's
// generic answer; the result carries no error text.
//
// ⚠️ THE ERROR'S TEXT IS SCRUBBED FIRST. These actions talk to GitHub with an
// installation token, and an error raised underneath them is text nobody here
// wrote. Its name and code are kept as they are; its message and stack pass
// through `scrubSecrets`, in the log line and in the Sentry event alike.
//
// NEVER THROWS: a failing report must not turn the action's answer into a 500.

/** The error as it may be logged: its name, its code when it has one, and its
 *  message with every credential-shaped run redacted. */
export interface ActionFaultDetail {
  name: string;
  code: string | null;
  message: string;
}

function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

/** {@link ActionFaultDetail} for anything thrown, an `Error` or not. */
export function actionFaultDetail(err: unknown): ActionFaultDetail {
  if (err instanceof Error) {
    return { name: err.name, code: codeOf(err), message: scrubSecrets(err.message) };
  }
  return { name: typeof err, code: null, message: scrubSecrets(String(err)) };
}

/** A copy of `err` safe to send: the same name and code, scrubbed message and stack. */
function scrubbedError(err: unknown, detail: ActionFaultDetail): Error {
  const safe = new Error(detail.message);
  safe.name = detail.name;
  safe.stack = err instanceof Error && err.stack ? scrubSecrets(err.stack) : undefined;
  return safe;
}

/**
 * Log and report a fault an action converts to its generic failure answer.
 *
 * @param err      what the action caught.
 * @param logLine  the action's constant log message.
 * @param action   the action's name — the Sentry tag that groups its faults.
 * @param context  what the action was asked to do (ids and the direction, never
 *                 a reason or a token).
 */
export function reportActionFault(
  err: unknown,
  logLine: string,
  action: string,
  context: Record<string, string | number | boolean | null>,
): void {
  const detail = actionFaultDetail(err);
  console.error(logLine, { ...context, error: detail });
  try {
    Sentry.withScope((scope) => {
      scope.setLevel('error');
      scope.setTag('action_fault', action);
      if (detail.code) scope.setTag('error_code', detail.code);
      scope.setContext(SERVER_ACTION_CONTEXT, { action, ...context });
      Sentry.captureException(scrubbedError(err, detail));
    });
  } catch {
    // Swallowed on purpose — see the header. The log line above already holds it.
  }
}
