import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionsVariableApiError,
  ORG_VARIABLE_VISIBILITY,
  actionsVariableClient,
} from '@/lib/github/actionsVariables';
import { fleetRunnerVariableService } from '@/lib/services/fleetRunnerVariableService';
import {
  MOTIR_ARM64_RUNNER_LABEL,
  MOTIR_RUNNER_ARM64_VARIABLE,
  MOTIR_RUNNER_LABEL,
  MOTIR_RUNNER_VARIABLE,
} from '@/lib/ciFleet/config';
import { AWS_RUNNER_ARM64_AMI_ENV_VAR } from '@/lib/orchestrator';
import { MOTIR_FLEET_RUNNER_LABEL } from '@/lib/ciMetering/runnerRates';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';

// THE WRITER for `vars.MOTIR_RUNNER` (Story MOTIR-1916 · MOTIR-2015) — the wire
// and the service, at the level the establish flow above them cannot reach.
//
// `projectRepoProvisioningService.test.ts` drives this through a real
// establishment and asserts what the ORG ends up holding. This file covers the
// three things that are only visible here:
//
//   1. the WIRE — which body each call sends, and what each refusal shape does.
//      GitHub gives no upsert (create-only POST, update-only PATCH), so the
//      read-then-write branch is the whole correctness of the ensure and every one
//      of its arms is reachable only by driving the client directly.
//   2. the CONTRACT GUARDS — assertions about what NEVER happens: never a second
//      `'motir-runner'` literal, never a repository-scoped write, never a failure
//      that reaches the caller.
//   3. the NEGATIVE the card names — a repo with no variable resolves
//      `ubuntu-latest`, which is what keeps a handed-over repository portable.
//
// No database: neither module has one. The only fake is `fetch`.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '150298786';
const REPO_ROOT = join(__dirname, '..', '..');

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let variablesFake: ActionsVariableFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configure(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
}

beforeEach(() => {
  calls = [];
  variablesFake = createActionsVariableFake(MOTIR_ORG);
  configure();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const variable = variablesFake.handle(call.url, call.method, call.body);
      if (variable) return variable;
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the constants', () => {
  it("the VALUE is the meter's label, aliased — one source, never a second literal", () => {
    // MOTIR-1964: two literals that agree today are not one constant. This is the
    // same assertion `fleetConfig.test.ts` makes for the gate, restated for the
    // WRITE side, where a drift would be the value GitHub actually serves.
    expect(MOTIR_RUNNER_LABEL).toBe(MOTIR_FLEET_RUNNER_LABEL);
  });

  it('the NAME and the VALUE are different strings and are not conflated', () => {
    // The key the workflows read (`vars.MOTIR_RUNNER`) versus the label the runner
    // registers with (`motir-runner`). Swapping them writes a variable no workflow
    // reads, which fails exactly as silently as writing nothing at all.
    expect(MOTIR_RUNNER_VARIABLE).toBe('MOTIR_RUNNER');
    expect(MOTIR_RUNNER_VARIABLE).not.toBe(MOTIR_RUNNER_LABEL);
  });
});

describe('ensureOrgVariable — the wire', () => {
  it('CREATES it when absent, at private visibility, carrying the fleet label', async () => {
    const outcome = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_VARIABLE,
      MOTIR_RUNNER_LABEL,
    );

    expect(outcome).toBe('created');
    const create = variablesFake.writeCalls()[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe(`https://api.github.com/orgs/${MOTIR_ORG}/actions/variables`);
    expect(create.body).toEqual({
      name: MOTIR_RUNNER_VARIABLE,
      value: MOTIR_RUNNER_LABEL,
      visibility: ORG_VARIABLE_VISIBILITY,
    });
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)).toEqual({
      name: MOTIR_RUNNER_VARIABLE,
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });
  });

  it('is UNCHANGED on the second call — one GET, no second write', async () => {
    await actionsVariableClient.ensureOrgVariable(MOTIR_RUNNER_VARIABLE, MOTIR_RUNNER_LABEL);
    const writesAfterFirst = variablesFake.writeCalls().length;

    const outcome = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_VARIABLE,
      MOTIR_RUNNER_LABEL,
    );

    expect(outcome).toBe('unchanged');
    // Every establishment after the first costs a read and nothing else — the
    // reason calling this per establish run is affordable.
    expect(variablesFake.writeCalls()).toHaveLength(writesAfterFirst);
  });

  it('CORRECTS a drifted VALUE with a PATCH — GitHub 404s a POST-shaped retry', async () => {
    variablesFake.seed({
      name: MOTIR_RUNNER_VARIABLE,
      value: 'some-other-runner',
      visibility: 'private',
    });

    const outcome = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_VARIABLE,
      MOTIR_RUNNER_LABEL,
    );

    expect(outcome).toBe('updated');
    const write = variablesFake.writeCalls()[0]!;
    expect(write.method).toBe('PATCH');
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
  });

  it('CORRECTS a drifted VISIBILITY even when the value is already right', async () => {
    // A hand-edited `all` would reach PUBLIC repositories, which the runner groups
    // (`allows_public_repositories: false`) refuse to serve — so their jobs would
    // queue for 24h rather than fall back. Value-only convergence would leave that
    // in place forever.
    variablesFake.seed({
      name: MOTIR_RUNNER_VARIABLE,
      value: MOTIR_RUNNER_LABEL,
      visibility: 'all',
    });

    const outcome = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_VARIABLE,
      MOTIR_RUNNER_LABEL,
    );

    expect(outcome).toBe('updated');
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.visibility).toBe('private');
  });

  it('CONVERGES when it loses the create race — a 409 becomes a PATCH, not an error', async () => {
    // Two establishments running at once both read "absent" and both POST; one gets
    // GitHub's 409. The desired value is a CONSTANT, so the loser has nothing to
    // lose — it must converge on the same bytes, never surface a conflict the caller
    // could not act on anyway. Driven through `create` directly because that is the
    // arm the race reaches: the winner's write lands between the loser's read and
    // its own POST, which is precisely the state seeded here.
    variablesFake.seed({
      name: MOTIR_RUNNER_VARIABLE,
      value: 'written-by-the-racing-caller',
      visibility: 'private',
    });

    const outcome = await actionsVariableClient.create(MOTIR_RUNNER_VARIABLE, MOTIR_RUNNER_LABEL);

    expect(outcome).toBe('updated');
    expect(variablesFake.calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
  });

  it('RESTORES a variable deleted out of band — self-healing, not a one-time bootstrap', async () => {
    await actionsVariableClient.ensureOrgVariable(MOTIR_RUNNER_VARIABLE, MOTIR_RUNNER_LABEL);
    variablesFake.deleteOutOfBand(MOTIR_RUNNER_VARIABLE);

    const outcome = await actionsVariableClient.ensureOrgVariable(
      MOTIR_RUNNER_VARIABLE,
      MOTIR_RUNNER_LABEL,
    );

    expect(outcome).toBe('created');
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
  });

  it('throws the TYPED error on a refusal, carrying the status and never the body', async () => {
    variablesFake.failWith(403, 5);

    await expect(
      actionsVariableClient.ensureOrgVariable(MOTIR_RUNNER_VARIABLE, MOTIR_RUNNER_LABEL),
    ).rejects.toBeInstanceOf(ActionsVariableApiError);
  });

  it('reads a 404 as ABSENT, never as a failure', async () => {
    expect(await actionsVariableClient.getOrgVariable('NOT_SET')).toBeNull();
  });
});

describe('fleetRunnerVariableService', () => {
  it('ensures the org variable holds the fleet label', async () => {
    const result = await fleetRunnerVariableService.ensureForFleet();

    expect(result).toEqual({
      outcome: 'ensured',
      result: 'created',
      arm64: { outcome: 'not_ready' },
    });
    expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
  });

  it('is NOT_CONFIGURED on a deployment that never provisions — no GitHub call at all', async () => {
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');

    const result = await fleetRunnerVariableService.ensureForFleet();

    expect(result).toEqual({ outcome: 'not_configured' });
    expect(variablesFake.calls).toHaveLength(0);
  });

  it('reports ENSURE_FAILED on a refusal instead of throwing at its caller', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    variablesFake.failWith(403, 5);

    const result = await fleetRunnerVariableService.ensureForFleet();

    expect(result).toMatchObject({ outcome: 'ensure_failed' });
  });

  describe('the arm64 variable (MOTIR-11786)', () => {
    it('with an arm64 runner AMI pinned, ensures BOTH variables', async () => {
      vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, 'ami-0a1b2c3d4e5f60718');

      const result = await fleetRunnerVariableService.ensureForFleet();

      expect(result).toEqual({
        outcome: 'ensured',
        result: 'created',
        arm64: { outcome: 'ensured', result: 'created' },
      });
      expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
      expect(variablesFake.variables.get(MOTIR_RUNNER_ARM64_VARIABLE)?.value).toBe(
        MOTIR_ARM64_RUNNER_LABEL,
      );
    });

    it('with none pinned, ensures only MOTIR_RUNNER and reports arm64 not_ready', async () => {
      vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');

      const result = await fleetRunnerVariableService.ensureForFleet();

      expect(result).toMatchObject({ outcome: 'ensured', arm64: { outcome: 'not_ready' } });
      expect(variablesFake.variables.has(MOTIR_RUNNER_ARM64_VARIABLE)).toBe(false);
      expect(variablesFake.calls.some((c) => c.url.includes(MOTIR_RUNNER_ARM64_VARIABLE))).toBe(
        false,
      );
    });

    it('an arm64 refusal reports arm64 ensure_failed and leaves the x86 outcome ensured', async () => {
      vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, 'ami-0a1b2c3d4e5f60718');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const real = actionsVariableClient.ensureOrgVariable.bind(actionsVariableClient);
      vi.spyOn(actionsVariableClient, 'ensureOrgVariable').mockImplementation(
        async (name, value, target) => {
          if (name === MOTIR_RUNNER_ARM64_VARIABLE) {
            throw new ActionsVariableApiError(403, 'refused');
          }
          return real(name, value, target);
        },
      );

      const result = await fleetRunnerVariableService.ensureForFleet();

      expect(result).toMatchObject({
        outcome: 'ensured',
        result: 'created',
        arm64: { outcome: 'ensure_failed' },
      });
      expect(variablesFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
    });

    it('an x86 refusal still tries the arm64 write, and the method never throws', async () => {
      vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, 'ami-0a1b2c3d4e5f60718');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const real = actionsVariableClient.ensureOrgVariable.bind(actionsVariableClient);
      vi.spyOn(actionsVariableClient, 'ensureOrgVariable').mockImplementation(
        async (name, value, target) => {
          if (name === MOTIR_RUNNER_VARIABLE) throw new Error('boom');
          return real(name, value, target);
        },
      );

      const result = await fleetRunnerVariableService.ensureForFleet();

      expect(result).toMatchObject({
        outcome: 'ensure_failed',
        detail: 'boom',
        arm64: { outcome: 'ensured', result: 'created' },
      });
    });
  });

  it('ensureQuietly swallows even an UNEXPECTED throw — it can never fail an establishment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(actionsVariableClient, 'ensureOrgVariable').mockRejectedValue(
      new Error('boom — not a modelled outcome'),
    );

    // A created repository cannot be rolled back (ADR §4.2), so nothing about the
    // fleet may turn a settled row into a failed one.
    await expect(fleetRunnerVariableService.ensureQuietly()).resolves.toBeUndefined();
  });
});

/** Every `.ts` file under `dir`, recursively — the dependency-guard idiom the
 *  fleet's other boundary test (`orchestratorPortBoundary`) uses. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('contract guards — what must NEVER happen', () => {
  const writeSites = [
    'lib/github/actionsVariables.ts',
    'lib/services/fleetRunnerVariableService.ts',
  ] as const;

  it('the fleet label appears as a LITERAL at no write site — it is imported', () => {
    // The card's criterion, made mechanical. MOTIR-1964 is what a second literal
    // already cost once; a literal HERE would be the value GitHub serves to
    // workflows, so editing it alone would stop the fleet booting while every job
    // still reported green.
    for (const site of writeSites) {
      const source = readFileSync(join(REPO_ROOT, site), 'utf8');
      // Strip the comment prose, which legitimately NAMES the label when explaining
      // why it must not be re-declared — the guard is about executable code.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${site} re-declares the fleet label`).not.toContain(MOTIR_RUNNER_LABEL);
    }
  });

  it('mutation check — the literal guard actually detects a re-declaration', () => {
    // A guard that cannot fail is not a guard. This proves the stripping above does
    // not swallow a real literal in code.
    const planted = `const label = '${MOTIR_RUNNER_LABEL}';\n// a comment naming ${MOTIR_RUNNER_LABEL}\n`;
    const code = planted.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain(MOTIR_RUNNER_LABEL);
  });

  it('there is NO repository-scoped variable writer anywhere in lib/', () => {
    // The property MOTIR-711's handover rests on: an ORG variable stops resolving
    // when the repo leaves the org, so there is no unset to remember. A repository
    // variable would travel WITH the repo and take PRECEDENCE, leaving a handed-over
    // repo asking for a runner nobody will boot — every job queued for 24 hours.
    // The capability is absent by construction so it cannot be reintroduced by a
    // careless call site.
    const source = readFileSync(join(REPO_ROOT, 'lib/github/actionsVariables.ts'), 'utf8');
    // Every variables URL the module forms goes through the ONE org base helper...
    expect(source).toContain('/orgs/${encodeURIComponent(org)}/actions/variables');
    // ...and `/repos/` appears nowhere in it, so no repo-scoped URL can be built.
    expect(source).not.toContain('/repos/');

    // And nothing ELSE in lib/ has grown a repository-variable write behind its
    // back — the guard is about the capability, not about one file.
    const offenders = tsFilesUnder(join(REPO_ROOT, 'lib')).filter((file) =>
      /repos\/[^\n]*actions\/variables/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the CI stub keeps the fallback expression, so an unset variable is ubuntu-latest', () => {
    // The NEGATIVE the card asks for. GitHub resolves an unset variable to the empty
    // string and `''` is falsy in an expression (§N, verified against the contexts +
    // expressions references), so `||` yields `ubuntu-latest`. What this asserts is
    // the half that lives in THIS repo: that the seam is still written that way. A
    // repo Motir hands over has no MOTIR_RUNNER — org variables do not travel — so
    // this expression is the whole of its portability.
    const source = readFileSync(join(REPO_ROOT, 'lib/github/repoProvisioning.ts'), 'utf8');
    expect(source).toContain("runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}");
    expect(source).toContain(`vars.${MOTIR_RUNNER_VARIABLE}`);
  });
});

describe('fleetRunnerVariableService in the tenant’s assigned GitHub org (MOTIR-8966)', () => {
  it('ensures the fleet label in the TARGET org, through its installation', async () => {
    const HOST_ORG = 'motir-host-a';
    const hostFake = createActionsVariableFake(HOST_ORG);
    const fallbackGitHub = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        return hostFake.handle(String(url), method, body) ?? fallbackGitHub(url, init);
      }),
    );

    const result = await fleetRunnerVariableService.ensureForFleet({
      org: HOST_ORG,
      installationId: '7788',
      role: 'provisioning',
    });

    expect(result).toEqual({
      outcome: 'ensured',
      result: 'created',
      arm64: { outcome: 'not_ready' },
    });
    expect(hostFake.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
    expect(variablesFake.calls).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('/app/installations/7788/access_tokens'))).toBe(true);
  });
});
