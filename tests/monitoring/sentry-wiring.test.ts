import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MONITORING_TUNNEL_ROUTE } from '@/lib/monitoring/config';
import {
  dropExpectedDomainErrors,
  findExpectedDomainError,
  isExpectedDomainError,
} from '@/lib/monitoring/expectedDomainErrors';
import { ApiV1Error, DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { RATE_LIMIT_EXCLUDED_PATHS } from '@/lib/rateLimit/guard';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';

// Error monitoring, wired end to end (Subtask 8.5.6 / MOTIR-1162).
//
// Everything this card ships is CONFIGURATION, and configuration is the thing
// that fails silently: an unset build argument, a `next.config` key the bundler
// never reads, a tunnel path in two files that drift apart. None of those is
// visible from a green build — which is why the assertions below are about
// wiring rather than behaviour, read straight out of the files that carry it.

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const awsDeploy = readFileSync(join(ROOT, '.github', 'workflows', 'aws-deploy.yml'), 'utf8');
const nextConfigSource = readFileSync(join(ROOT, 'next.config.ts'), 'utf8');

/**
 * The release lane's image build — `aws-deploy.yml`'s build step, comments
 * dropped so prose can neither satisfy nor trip a check. The Fly `deploy` job
 * these assertions used to read was deleted by MOTIR-10935; `aws-deploy.yml` is
 * Motir's one deploy lane and builds the same Dockerfile.
 */
function releaseBuild(): string {
  const code = awsDeploy
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const start = code.indexOf('- name: Build and push the image');
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start);
  const next = /\n {6}- (?:name|uses|run):/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/** The release build's `secrets:` block alone — the lines indented under it. */
function buildSecrets(): string {
  const block = /^( *)secrets: \|\n((?:\1 {2}.*\n)*)/m.exec(releaseBuild());
  expect(block, 'the release build declares secrets').not.toBeNull();
  return block![2]!;
}

interface Step {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}
const deploySteps = (parse(awsDeploy) as { jobs: { 'aws-deploy': { steps: Step[] } } }).jobs[
  'aws-deploy'
].steps;

/** One step of the release job, by name. */
function awsStep(name: string): Step {
  const step = deploySteps.find((s) => s.name === name);
  expect(step, `aws-deploy.yml has a step named "${name}"`).toBeDefined();
  return step!;
}

/**
 * Runs a step's script the way the runner does (`bash -e`), with only the
 * environment given — the secrets the step maps in, set or empty — and an
 * optional directory put first on PATH for stubbed commands.
 */
function runStep(step: Step, env: Record<string, string>, binDir?: string) {
  const summary = join(mkdtempSync(join(tmpdir(), 'aws-deploy-step-')), 'summary.md');
  const result = spawnSync('bash', ['-e', '-c', step.run!], {
    env: {
      NODE_ENV: 'test',
      PATH: binDir ? `${binDir}:${process.env['PATH']}` : process.env['PATH'],
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, summary };
}

const MONITORING_SECRETS = [
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
] as const;
const ALL_SET = Object.fromEntries(MONITORING_SECRETS.map((n) => [n, `value-of-${n}`]));

/** The release build's `build-args:` block alone — the lines indented under it. */
function buildArgs(): string {
  const block = /^( *)build-args: \|\n((?:\1 {2}.*\n)*)/m.exec(releaseBuild());
  expect(block, 'the release build declares build-args').not.toBeNull();
  // Non-vacuity: the block read is the real one, which carries the release sha.
  expect(block![2]).toContain('MOTIR_RELEASE=');
  return block![2]!;
}

describe('the tunnel route is ONE value, agreed on by both files that name it', () => {
  it('is excluded from rate limiting', () => {
    // Subtask 8.5.9 added `/monitoring` to the exclusion list BEFORE this card
    // existed, naming it in the comment — which is the right thing to do and
    // also exactly how two copies of a path start drifting. This is the
    // assertion that keeps them one value: rename the tunnel and this fails
    // rather than the exclusion quietly stopping to apply.
    expect(RATE_LIMIT_EXCLUDED_PATHS).toContain(MONITORING_TUNNEL_ROUTE);
  });

  it('is what `next.config.ts` hands to `withSentryConfig`', () => {
    // The tunnel is a Next REWRITE, so nothing in `app/api/**` implements it and
    // no route test can reach it. The wiring is the only thing there is to
    // assert, and asserting it on the CONSTANT rather than on the string is what
    // makes the exclusion above meaningful.
    expect(nextConfigSource).toContain('tunnelRoute: MONITORING_TUNNEL_ROUTE');
  });

  it('is not behind the auth proxy — a browser reporting an error may be signed out', () => {
    // The card asks for the tunnel to be added to "any CSP/route allowlist".
    // There is no Content-Security-Policy in this repo (nothing sets the header),
    // so the only gate that could swallow it is `proxy.ts`'s matcher — which
    // redirects a cookie-less request to `/sign-in`. An error report from a
    // signed-out visitor is exactly the report you most want, so this asserts the
    // ABSENCE rather than leaving it to be noticed when one goes missing.
    const proxySource = readFileSync(join(ROOT, 'proxy.ts'), 'utf8');
    const matcher = /matcher:\s*\[([^\]]*)\]/.exec(proxySource)?.[1] ?? '';
    expect(matcher).not.toBe('');
    expect(matcher).not.toContain(MONITORING_TUNNEL_ROUTE);
  });

  it('is a path, not a host or a full URL', () => {
    expect(MONITORING_TUNNEL_ROUTE.startsWith('/')).toBe(true);
    expect(MONITORING_TUNNEL_ROUTE).not.toContain('://');
  });
});

describe('the BUILD-ARGUMENT seam exists, because a NEXT_PUBLIC_* value cannot be a runtime secret', () => {
  it('the Dockerfile declares an ARG for every build-time monitoring value', () => {
    // `Dockerfile` on `origin/main` declared ZERO ARGs before this card — the
    // fact MOTIR-1161 recorded and the reason the browser half could not have
    // been configured at all. A regression here does not error: it produces a
    // client bundle with an empty DSN that reports nothing, for ever.
    for (const arg of [
      'NEXT_PUBLIC_SENTRY_DSN',
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
      'MOTIR_RELEASE',
      'SENTRY_ORG',
      'SENTRY_PROJECT',
    ]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=`, 'm'));
      expect(dockerfile).toMatch(new RegExp(`${arg}=\\$${arg}`));
    }
  });

  it('every ARG defaults to empty, so a build with no arguments still succeeds', () => {
    // The self-host path: `docker build` with no `--build-arg` must produce a
    // working image with monitoring off, not a build failure and not a hardcoded
    // vendor value.
    const args = [...dockerfile.matchAll(/^ARG (\w+)=(.*)$/gm)];
    expect(args.length).toBeGreaterThanOrEqual(5);
    for (const [, name, value] of args) expect([name, value]).toEqual([name, '""']);
  });

  it('the release build passes the browser DSN, and the RELEASE is the commit SHA', () => {
    const build = releaseBuild();
    expect(build).toMatch(
      /^\s*NEXT_PUBLIC_SENTRY_DSN=\$\{\{ secrets\.NEXT_PUBLIC_SENTRY_DSN \}\}$/m,
    );
    expect(build).toMatch(/^\s*MOTIR_RELEASE=\$\{\{ github\.sha \}\}$/m);
  });

  it('passes the Sentry org and project, which turn the source-map upload on', () => {
    // `next.config.ts` hands `withSentryConfig` these and the token; with any of
    // them missing the upload is a no-op that errors nowhere (MOTIR-11059).
    expect(buildArgs()).toMatch(/^\s*SENTRY_ORG=\$\{\{ secrets\.SENTRY_ORG \}\}$/m);
    expect(buildArgs()).toMatch(/^\s*SENTRY_PROJECT=\$\{\{ secrets\.SENTRY_PROJECT \}\}$/m);
  });

  it('carries the AUTH TOKEN as a BuildKit SECRET, the id the Dockerfile mounts', () => {
    expect(buildSecrets()).toMatch(
      /^\s*SENTRY_AUTH_TOKEN=\$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}$/m,
    );
  });

  it('never carries the AUTH TOKEN as a build argument', () => {
    // A build argument is recorded in the build's own metadata. The distinction
    // is the whole reason the token is the one value that does not appear in the
    // ARG block above: the Dockerfile reads it only as a BuildKit secret.
    expect(buildArgs()).not.toContain('SENTRY_AUTH_TOKEN');
    expect(dockerfile).toContain('--mount=type=secret,id=SENTRY_AUTH_TOKEN');
    expect(dockerfile).not.toMatch(/^ARG SENTRY_AUTH_TOKEN/m);
  });
});

describe('the release lane refuses to ship an unmonitored release (MOTIR-11059)', () => {
  const guard = () => awsStep('Assert the monitoring build-time secrets are present');

  it('maps every monitoring secret into the guard from the repository secrets', () => {
    for (const name of MONITORING_SECRETS) {
      expect(guard().env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  it('passes when all four are set', () => {
    const { status, out } = runStep(guard(), ALL_SET);
    expect(out).toContain('all four monitoring build-time secrets are present');
    expect(status).toBe(0);
  });

  it.each(MONITORING_SECRETS)('refuses, naming it, when %s is empty', (name) => {
    // An unset secret degrades monitoring silently — an empty DSN builds a
    // bundle that reports nothing, an empty token ships unreadable stack traces.
    const { status, out } = runStep(guard(), { ...ALL_SET, [name]: '' });
    expect(status).toBe(1);
    expect(out).toContain(`::error::Missing monitoring secret(s): ${name} `);
  });

  it('names every missing secret at once', () => {
    const { status, out } = runStep(guard(), {});
    expect(status).toBe(1);
    expect(out).toContain(`Missing monitoring secret(s): ${MONITORING_SECRETS.join(' ')} `);
  });
});

describe('the release lane proves the source-map upload RAN (MOTIR-11059)', () => {
  // The card's own warning: `outputFileTracingExcludes` is a live example of a
  // `next.config` key this build never reads (MOTIR-2403), so "configured" is
  // not evidence. The release existing in Sentry is, because the SDK's
  // Turbopack path creates it inside the same after-compile hook that uploads
  // the maps.
  const check = () => awsStep('Assert Sentry received this release');

  /** A `curl` stand-in that records its arguments and answers `code`. */
  function fakeCurl(code: string, exit = 0): { bin: string; argsFile: string } {
    const bin = mkdtempSync(join(tmpdir(), 'fake-curl-'));
    const argsFile = join(bin, 'args');
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n` +
        `out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n` +
        `[ -n "$out" ] && echo '{"version":"sha"}' > "$out"\nprintf '%s' ${code}\nexit ${exit}\n`,
    );
    chmodSync(join(bin, 'curl'), 0o755);
    return { bin, argsFile };
  }

  it('reads the token, org and project from the repository secrets', () => {
    for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      expect(check().env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  it('asks Sentry for the release named after this commit, with the token, and passes on 200', () => {
    const { bin, argsFile } = fakeCurl('200');
    const { status, out, summary } = runStep(check(), ALL_SET, bin);
    expect(status).toBe(0);
    const args = readFileSync(argsFile, 'utf8');
    expect(args).toContain(
      `https://sentry.io/api/0/projects/value-of-SENTRY_ORG/value-of-SENTRY_PROJECT/releases/${'a'.repeat(40)}/`,
    );
    expect(args).toContain('Authorization: Bearer value-of-SENTRY_AUTH_TOKEN');
    expect(out).toContain('→ HTTP 200');
    expect(readFileSync(summary, 'utf8')).toContain(`Sentry release: \`${'a'.repeat(40)}\``);
  });

  it.each(['404', '401'])('turns the run red when Sentry answers %s', (code) => {
    const { bin } = fakeCurl(code);
    const { status, out } = runStep(check(), ALL_SET, bin);
    expect(status).toBe(1);
    expect(out).toContain(`::error::Sentry has no release named ${'a'.repeat(40)}`);
  });

  it('turns the run red, rather than erroring out unexplained, when Sentry cannot be reached', () => {
    const { bin } = fakeCurl('000', 7);
    const { status, out } = runStep(check(), ALL_SET, bin);
    expect(status).toBe(1);
    expect(out).toContain('→ HTTP 000');
    expect(out).toContain('::error::Sentry has no release named');
  });
});

describe("the source-map uploader's CLI binary is present without its postinstall", () => {
  it('resolves to a file on disk', () => {
    // `pnpm-workspace.yaml` sets `'@sentry/cli': false`, so its postinstall does
    // not run. That is correct — the script is a CDN FALLBACK that exits 0 the
    // moment the per-platform optional package resolves — but the failure mode
    // if it ever stops being correct is SILENT: no binary means source maps do
    // not upload, and a deploy with unreadable stack traces looks exactly like a
    // healthy one. `@sentry/bundler-plugin-core` even ships a
    // `sentryCliBinaryExists()` helper for this, whose comment says post-install
    // scripts "may not always run".
    //
    // Resolved the way the upload path resolves it — from the plugin's own
    // module — rather than from this test's directory, so a hoisting change
    // cannot make it pass against a copy the uploader never sees.
    const fromNextSdk = createRequire(require.resolve('@sentry/nextjs/package.json'));
    const fromPluginCore = createRequire(fromNextSdk.resolve('@sentry/bundler-plugin-core'));
    const SentryCli = fromPluginCore('@sentry/cli') as { getPath(): string };

    const binary = SentryCli.getPath();
    expect(binary).toContain('sentry-cli');
    expect(existsSync(binary), `sentry-cli is not at ${binary}`).toBe(true);
  });
});

describe('expected typed domain 4xx are not reported as errors', () => {
  it('drops a domain error the API answers with a 4xx', () => {
    const err = Object.assign(new Error('no such work item'), {
      code: 'WORK_ITEM_NOT_FOUND',
    });
    expect(DOMAIN_ERROR_STATUS['WORK_ITEM_NOT_FOUND']).toBe(404);
    expect(isExpectedDomainError(err)).toBe(true);
    expect(dropExpectedDomainErrors({} as ErrorEvent, { originalException: err })).toBeNull();
  });

  it('drops an `ApiV1Error` carrying a 4xx status', () => {
    expect(isExpectedDomainError(new ApiV1Error('RATE_LIMITED', 429, 'slow down'))).toBe(true);
  });

  it('KEEPS a domain error the API answers with a 5xx', () => {
    // The filter that would have been wrong: "in the map ⇒ drop". That map also
    // carries 503 rows, and a dependency being down is the thing you most want
    // to be paged about.
    const fiveHundreds = Object.entries(DOMAIN_ERROR_STATUS).filter(([, s]) => s >= 500);
    expect(fiveHundreds.length).toBeGreaterThan(0);
    for (const [code] of fiveHundreds) {
      const err = Object.assign(new Error('upstream down'), { code });
      expect(isExpectedDomainError(err)).toBe(false);
    }
  });

  it('KEEPS a real fault, and one wearing the same shape', () => {
    expect(isExpectedDomainError(new Error('boom'))).toBe(false);
    // `code: 'ECONNREFUSED'` is exactly the shape a naive heuristic would have
    // matched on. It is not in the vocabulary, so it is a fault.
    expect(
      isExpectedDomainError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })),
    ).toBe(false);
  });

  it('sees a domain error re-thrown as the CAUSE of something generic', () => {
    const inner = Object.assign(new Error('not a member'), { code: 'NOT_A_MEMBER' });
    const outer = new Error('handler failed', { cause: inner });
    expect(isExpectedDomainError(outer)).toBe(true);
  });

  it('returns the event untouched when it is kept', () => {
    const event = { event_id: 'abc' } as ErrorEvent;
    const hint: EventHint = { originalException: new Error('boom') };
    expect(dropExpectedDomainErrors(event, hint)).toBe(event);
  });

  // MOTIR-6147: a Server Action answers a thrown refusal with a 500, never a
  // 4xx, so dropping it hid every action failure in production.
  it('KEEPS a domain 4xx that escaped a Server Action (Next routeType action)', () => {
    const err = Object.assign(new Error('no access'), { code: 'PROJECT_ACCESS_DENIED' });
    expect(isExpectedDomainError(err)).toBe(true);
    const event = { contexts: { nextjs: { route_type: 'action' } } } as unknown as ErrorEvent;
    expect(dropExpectedDomainErrors(event, { originalException: err })).toBe(event);
  });

  it('KEEPS a converted refusal an action reported under the server_action context', () => {
    const err = Object.assign(new Error('no access'), { code: 'PROJECT_ACCESS_DENIED' });
    const event = {
      contexts: { server_action: { action: 'updateIssueAction', code: 'PROJECT_ACCESS_DENIED' } },
    } as unknown as ErrorEvent;
    expect(dropExpectedDomainErrors(event, { originalException: err })).toBe(event);
  });

  it('still drops a domain 4xx from a page render or a route handler', () => {
    const err = Object.assign(new Error('no such work item'), { code: 'WORK_ITEM_NOT_FOUND' });
    for (const routeType of ['render', 'route']) {
      const event = { contexts: { nextjs: { route_type: routeType } } } as unknown as ErrorEvent;
      expect(dropExpectedDomainErrors(event, { originalException: err })).toBeNull();
    }
  });

  it('finds the refusal code and message through a cause chain', () => {
    const inner = Object.assign(new Error('not a member'), { code: 'NOT_A_MEMBER' });
    expect(findExpectedDomainError(new Error('wrapped', { cause: inner }))).toEqual({
      code: 'NOT_A_MEMBER',
      message: 'not a member',
    });
    expect(findExpectedDomainError(new Error('boom'))).toBeNull();
  });

  it('terminates on a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(isExpectedDomainError(err)).toBe(false);
  });
});

describe('the resolved Next config actually carries the tunnel (MOTIR-1162)', () => {
  it('registers a rewrite at the tunnel path, forwarding to Sentry ingest', async () => {
    // The strongest cheap assertion available: `tunnelRoute` is an OPTION until
    // `withSentryConfig` turns it into a rewrite, and an option that silently
    // stops taking effect is precisely this card's stated risk (the inert
    // `outputFileTracingExcludes` one file over). Resolving the real config and
    // asking it for its rewrites is the difference between "we passed the
    // option" and "the route exists".
    const { default: config } = (await import('../../next.config')) as {
      default: { rewrites?: () => Promise<unknown> };
    };
    expect(typeof config.rewrites).toBe('function');

    const rewrites = (await config.rewrites!()) as { source: string; destination: string }[];
    const tunnel = rewrites.filter((r) => r.source.startsWith(MONITORING_TUNNEL_ROUTE));

    // Two: one for the region-qualified ingest host and one for the bare one.
    expect(tunnel.length).toBeGreaterThanOrEqual(1);
    for (const rule of tunnel) expect(rule.destination).toContain('ingest');
  });
});
