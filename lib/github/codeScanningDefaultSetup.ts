import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// THE CODEQL DEFAULT-SETUP RUNNER boundary (MOTIR-10289) — the one module that
// reads and moves which runner a repository's CodeQL default setup asks for.
//
// The fleet switch (`fleetOrgCiSettingService`) moves Motir's private CI by the
// org's `MOTIR_RUNNER` variable, and every workflow FILE reads it. CodeQL's
// default setup has no workflow file: GitHub generates its `Analyze` jobs from a
// per-repository setting (`runner_type` / `runner_label`), which never reads a
// variable. A repository left on `labeled` + `motir-runner` keeps booting fleet
// machines with the switch off, so the switch carries this setting too.
//
// A LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense: services import it,
// routes never do. It authenticates through `resolveOrgAuth()` with the SAME org
// target the variable is written with, so the setting and the variable can never
// be moved through two different installations.
//
// ⚠️ THE PERMISSION IS REPOSITORY `Administration`: read for the GET, write for
// the PATCH (GitHub's "Permissions required for GitHub Apps", Administration
// section). It is distinct from `Variables`, which the readiness verdict checks.
//
// ⚠️ ONLY THE RUNNER IS EVER WRITTEN. The PATCH body carries `runner_type` (and
// `runner_label` for `labeled`) and nothing else, so a repository's languages,
// query suite and threat model are never touched, and a repository whose default
// setup is not configured is never configured by this module: the caller writes
// only to a repository it read as `configured`.

const GITHUB_API = 'https://api.github.com';

/** GitHub refused or was unreachable while reading or moving a default setup.
 *  Carries the status and a short detail, never the raw body. */
export class CodeScanningDefaultSetupApiError extends Error {
  readonly code = 'CODE_SCANNING_DEFAULT_SETUP_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    /** GitHub's own `message`, cut to 200 characters; '' when it sent none. */
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while managing a CodeQL default setup (${detail}).`
        : `GitHub refused a CodeQL default-setup call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'CodeScanningDefaultSetupApiError';
  }
}

/**
 * GitHub's 422 for a `labeled` runner no registered runner carries: "Code
 * scanning default setup can only be enabled if a runner with the specified
 * label is assigned to this repository." The fleet registers a single-use
 * runner only while a job runs, so an idle fleet answers this to every move
 * onto it — a state of the fleet, not a refusal of the setting.
 */
export function isNoRunnerWithLabelRefusal(err: unknown): boolean {
  return (
    err instanceof CodeScanningDefaultSetupApiError &&
    err.status === 422 &&
    /runner with the specified label/i.test(err.detail)
  );
}

/** Which runner a default setup's jobs request. */
export type DefaultSetupRunner = { type: 'standard' } | { type: 'labeled'; label: string };

/** A repository's CodeQL default setup, as far as the fleet cares.
 *  `unavailable` = code scanning is not available on the repository (GitHub's
 *  403 for "Advanced Security is not enabled"), so it has no default setup and
 *  nothing can request a runner for it. */
export type DefaultSetup =
  | { state: 'configured'; runner: DefaultSetupRunner }
  | { state: 'not-configured' }
  | { state: 'unavailable' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await res.json());
  } catch {
    return null;
  }
}

function errorDetail(body: Record<string, unknown> | null): string {
  const message = body?.['message'];
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

/** GitHub's documented 403 for a repository without code scanning. A 403 for a
 *  missing App permission ("Resource not accessible by integration") is NOT this,
 *  and stays an error: reading it as "no default setup" would let OFF skip a
 *  repository that still requests the fleet. */
function isCodeScanningUnavailable(status: number, detail: string): boolean {
  return status === 403 && /advanced security|code security/i.test(detail);
}

function endpoint(owner: string, name: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/code-scanning/default-setup`;
}

async function request(
  url: string,
  init: { method: string; token: string; body?: string },
): Promise<Response> {
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (err) {
    throw new CodeScanningDefaultSetupApiError(
      null,
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

/** GitHub's default-setup JSON → {@link DefaultSetup}; null when it is not one. */
function toDefaultSetup(body: Record<string, unknown> | null): DefaultSetup | null {
  const state = body?.['state'];
  if (state === 'not-configured') return { state: 'not-configured' };
  if (state !== 'configured') return null;
  const label = body?.['runner_label'];
  return body?.['runner_type'] === 'labeled' && typeof label === 'string' && label.length > 0
    ? { state: 'configured', runner: { type: 'labeled', label } }
    : { state: 'configured', runner: { type: 'standard' } };
}

/** True when the runner requests exactly `label`. */
export function runnerRequests(runner: DefaultSetupRunner, label: string): boolean {
  return runner.type === 'labeled' && runner.label === label;
}

export const codeScanningDefaultSetupClient = {
  /**
   * Read one repository's default setup. A `runner_type` of `null` or anything
   * that is not `labeled` with a label reads as `standard` — GitHub's own
   * default, and what a job then runs on.
   */
  async get(owner: string, name: string, target?: GithubOrgTarget): Promise<DefaultSetup> {
    const { token } = await resolveOrgAuth(target);
    const res = await request(endpoint(owner, name), { method: 'GET', token });
    const body = await readJson(res);
    if (!res.ok) {
      const detail = errorDetail(body);
      if (isCodeScanningUnavailable(res.status, detail)) return { state: 'unavailable' };
      throw new CodeScanningDefaultSetupApiError(res.status, detail);
    }
    const setup = toDefaultSetup(body);
    if (!setup) {
      throw new CodeScanningDefaultSetupApiError(
        res.status,
        'default-setup read returned an unexpected shape',
      );
    }
    return setup;
  },

  /**
   * Move a CONFIGURED repository's default setup onto `runner`. GitHub answers
   * 200 (applied) or 202 (applied, with a validation run queued); both are a
   * success. Any other answer throws, carrying its status.
   */
  async setRunner(
    owner: string,
    name: string,
    runner: DefaultSetupRunner,
    target?: GithubOrgTarget,
  ): Promise<void> {
    const { token } = await resolveOrgAuth(target);
    const payload =
      runner.type === 'labeled'
        ? { runner_type: 'labeled', runner_label: runner.label }
        : { runner_type: 'standard' };
    const res = await request(endpoint(owner, name), {
      method: 'PATCH',
      token,
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    throw new CodeScanningDefaultSetupApiError(res.status, errorDetail(await readJson(res)));
  },
};
