import { getMonitorProvider, registeredMonitorProviderIds } from './registry';

// THE MONITOR CONFIGURATION PREFLIGHT (MOTIR-5831) — is the environment a
// registered provider DECLARED it needs actually present on this process?
//
// The fault it exists for: `SENTRY_APP_CLIENT_SECRET` was absent from production
// for SEVEN DAYS after MOTIR-5257's close-out recorded all four values staged and
// read back. Three of its four siblings really were there; the plausible cause is
// a clipboard import losing a line break. Nothing in the deployment could tell.
// `appCredentials()` reads at call time and throws only when called, the start
// route built its install URL from the SLUG alone, so Connect worked and Sentry's
// consent screen rendered normally — and the failure landed inside the grant
// exchange, AFTER a person had approved an install in their own Sentry
// organisation. No startup assertion, no scheduled probe, no deploy step looked.
//
// ⚠️ PRESENCE ONLY, AND THE RULE IS ABSOLUTE. Nothing here reads a value into a
// verdict, a message or a log — not the value, not its length, not a digest of
// it. The only fact that leaves this module is whether a NAME is set, which is
// the only fact needed to distinguish "somebody's import dropped a line" from
// "this deployment does not use that provider". A probe that reported a length
// would be a probe whose output is a secret-adjacent artifact on an operator
// surface, and the one this feeds (the DLQ row) is rendered to a human.
//
// ⚠️ WHY AN ALL-ABSENT PROVIDER IS *NOT* AN ALARM — the decision this module
// makes, stated because the opposite reading is reasonable.
//
// `registeredMonitorProviderIds()` answers with every BUILT-IN provider, not with
// the ones a deployment opted into: `sentry` is registered at import in every
// build, including a self-hosted one that will never connect an error monitor.
// Treating "Sentry's three names are unset" as a fault would dead-letter this job
// every single morning on those deployments, over a state their operator has
// deliberately chosen — and a check that cries wolf is a check somebody silences,
// which is how MOTIR-3606 spent 23 days red with nobody reading it.
//
// So the discriminator is PARTIAL CONFIGURATION, and it is the shape the defect
// actually had: a provider with NONE of its names set is one this deployment does
// not use (`unconfigured`, quiet); a provider with SOME but not all set is one
// somebody meant to configure and did not (`incomplete`, LOUD). Three of four
// present and one missing is exactly the seven-day fixture.
//
// ⚠️ AND THE BLIND SPOT THAT FOLLOWS, carried on the verdict rather than left for
// a reader to derive: a deployment that loses EVERY name for a provider at once
// reads as `unconfigured` here and is not flagged. That case is not silent
// overall — it is the one the START route's refusal covers, where a person
// clicking Connect is turned back before approving anything — but this probe
// cannot see it, and a reader who takes a green verdict for "the monitor is
// configured" will be wrong. Closing it needs a signal for OPT-IN that presence
// alone cannot supply (a stored connection row is the obvious one), which is a
// database read this probe deliberately does not make.

/** What one registered provider's declared environment looks like right now.
 *  NAMES only — see the presence-only rule above. */
export interface MonitorProviderConfigReport {
  /** The registry key the provider is registered under. */
  providerId: string;
  /** The names the provider declares, verbatim from the seam. */
  required: readonly string[];
  /** Which of them are absent from `process.env`, in declaration order. */
  missing: readonly string[];
}

/** What the preflight concluded about this deployment's monitor configuration. */
export type MonitorConfigVerdict =
  /** No registered provider declares anything it needs, or every provider that
   *  does has none of its names set — a deployment that has not opted into an
   *  error monitor. Quiet, and read the `blindSpot` before concluding more. */
  | {
      verdict: 'not_applicable';
      providers: MonitorProviderConfigReport[];
      detail: string;
      blindSpot: string;
    }
  /** Every provider carrying any configuration carries ALL of it. */
  | {
      verdict: 'complete';
      providers: MonitorProviderConfigReport[];
      detail: string;
      blindSpot: string;
    }
  /** DEFINITE: a provider this deployment has partly configured is missing a name
   *  it declared. LOUD — somebody installed these values and one did not land. */
  | {
      verdict: 'incomplete';
      providers: MonitorProviderConfigReport[];
      /** The partly-configured providers, in registration order. */
      offenders: MonitorProviderConfigReport[];
      detail: string;
      blindSpot: string;
    };

/** The boundary this probe cannot see, carried on every arm (the sentence saying
 *  what was NOT measured travels with the one saying what was — the discipline
 *  MOTIR-5027's rebuild-streak probe set, retired with the index fleet in
 *  MOTIR-12037). */
export const MONITOR_CONFIG_BLIND_SPOT =
  'This probe reads NAME PRESENCE on the running process and infers opt-in from ' +
  'PARTIAL configuration, so a provider that lost EVERY declared name at once reads ' +
  'as never-configured here and is not flagged. That case surfaces instead at the ' +
  'OAuth start route, which refuses before a person approves an install. It also ' +
  'says nothing about whether a present value is CORRECT — only that the name is set.';

/** Is this name present, and non-empty? An empty string is an unset value that
 *  survived an import, which is precisely the failure mode in scope. */
function isPresent(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Read every REGISTERED provider's declared environment off this process.
 *
 * Never throws and never returns a value — every arm of
 * {@link MonitorConfigVerdict} is an answer, and the CALLER decides which arms
 * are loud (the discipline every probe in `system.daily-health-check` keeps).
 *
 * ⚠️ IT ASKS THE REGISTRY, NEVER AN IMPLEMENTATION. A literal list of one
 * provider's names here would be the second home the seam exists to prevent, and
 * it would also miss the E2E switch that re-registers the fake under `sentry`
 * (`tests/monitors/monitorBoundaries.test.ts` holds that boundary for every
 * consumer).
 */
export function verifyMonitorProviderConfig(): MonitorConfigVerdict {
  const providers: MonitorProviderConfigReport[] = registeredMonitorProviderIds().map(
    (providerId) => {
      const required = getMonitorProvider(providerId).requiredEnv;
      return { providerId, required, missing: required.filter((name) => !isPresent(name)) };
    },
  );

  const offenders = providers.filter(
    (p) => p.missing.length > 0 && p.missing.length < p.required.length,
  );
  if (offenders.length > 0) {
    const detail = offenders
      .map(
        (p) => `${p.providerId} is missing ${p.missing.join(', ')} (of ${p.required.join(', ')})`,
      )
      .join('; ');
    return {
      verdict: 'incomplete',
      providers,
      offenders,
      detail,
      blindSpot: MONITOR_CONFIG_BLIND_SPOT,
    };
  }

  const configured = providers.filter((p) => p.required.length > 0 && p.missing.length === 0);
  if (configured.length === 0) {
    return {
      verdict: 'not_applicable',
      providers,
      detail:
        'No registered monitor provider is configured on this deployment — nothing to assert.',
      blindSpot: MONITOR_CONFIG_BLIND_SPOT,
    };
  }
  return {
    verdict: 'complete',
    providers,
    detail: `${configured.map((p) => p.providerId).join(', ')} carries every name it declares.`,
    blindSpot: MONITOR_CONFIG_BLIND_SPOT,
  };
}

/**
 * The names ONE provider declares and is missing — what the OAuth start route
 * asks before it mints a nonce or redirects anybody anywhere.
 *
 * Separate from {@link verifyMonitorProviderConfig} because the two answer
 * different questions: the probe asks about the DEPLOYMENT and is deliberately
 * quiet about a provider nobody configured, while this asks about the ONE
 * provider a person is at this moment trying to connect — where an all-absent
 * declaration is the most definite refusal there is.
 */
export function missingProviderEnv(providerId: string): string[] {
  return getMonitorProvider(providerId).requiredEnv.filter((name) => !isPresent(name));
}
