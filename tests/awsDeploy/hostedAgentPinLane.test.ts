import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  HOSTED_AGENT_IMAGE_REPOSITORY,
  HOSTED_AGENT_PIN_FILE,
  HOSTED_AGENT_PIN_PATTERN,
  hostedAgentImageSecretName,
  parseHostedAgentPin,
} from '@/scripts/aws-deploy/hostedAgentPin';

// MOTIR-10882 — the hosted-agent image pin moves with `main`. The deploy's write
// is pinned in `awsDeploy.test.ts` and its workflow step in `workflow.test.ts`;
// this file pins the other half: the image lane opens the bump pull request
// after every publish, that pull request has a check that proves the pinned
// image, and the pin file is outside the lane's trigger so a bump cannot loop.

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  outputs?: Record<string, string>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { paths?: string[]; branches?: string[] }>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const WORKFLOWS = join(process.cwd(), '.github/workflows');
const load = (file: string) => parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
const lane = load('hosted-agent-image.yml');
/** The deploy's pin pattern as a bash `[[ =~ ]]` writes it: anchored, `/` unescaped. */
const BASH_PATTERN = HOSTED_AGENT_PIN_PATTERN.source.replaceAll('\\/', '/');
const check = load('hosted-agent-pin.yml');

describe('the pin file', () => {
  it('is checked in, one line, naming the public hosted-agent repository by digest', () => {
    const text = readFileSync(HOSTED_AGENT_PIN_FILE, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseHostedAgentPin(text).startsWith(`${HOSTED_AGENT_IMAGE_REPOSITORY}@sha256:`)).toBe(
      true,
    );
  });

  it('accepts a pin with or without its trailing newline, and nothing else', () => {
    const pin = `${HOSTED_AGENT_IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}`;
    expect(parseHostedAgentPin(pin)).toBe(pin);
    expect(parseHostedAgentPin(`${pin}\n`)).toBe(pin);
    expect(() => parseHostedAgentPin(`${pin}\n\n`)).toThrow(/exactly one line, not 2/);
    expect(() => parseHostedAgentPin(` ${pin}`)).toThrow(/must name/);
    expect(() => parseHostedAgentPin(`${pin.toUpperCase()}`)).toThrow(/must name/);
    expect(HOSTED_AGENT_PIN_PATTERN.test(`${HOSTED_AGENT_IMAGE_REPOSITORY}:main`)).toBe(false);
  });

  it("names the secret motir-infra's manifest creates for MOTIR_HOSTED_AGENT_IMAGE", () => {
    expect(hostedAgentImageSecretName('motir')).toBe('motir/core/motir-hosted-agent-image');
  });

  it("is outside the image lane's trigger, so merging a bump publishes nothing", () => {
    for (const event of ['push', 'pull_request'] as const) {
      const paths = lane.on[event]?.paths ?? [];
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        const prefix = path.replace(/\*\*$/, '');
        expect(HOSTED_AGENT_PIN_FILE.startsWith(prefix) && prefix !== path).toBe(false);
        expect(path).not.toBe(HOSTED_AGENT_PIN_FILE);
      }
    }
  });
});

describe("the image lane's pin job", () => {
  const build = lane.jobs['hosted-agent-image']!;
  const pin = lane.jobs['pin']!;
  const step = (predicate: (s: Step) => boolean) => {
    const found = pin.steps.find(predicate);
    expect(found, 'step not found').toBeDefined();
    return found!;
  };

  it('takes the digest the publish step reported', () => {
    expect(build.outputs).toEqual({ digest: '${{ steps.push.outputs.digest }}' });
    expect(build.steps.some((s) => s.id === 'push')).toBe(true);
  });

  it('runs after the build-and-publish job, on a push to main only', () => {
    expect(pin.needs).toBe('hosted-agent-image');
    expect(pin.if).toBe("${{ github.event_name == 'push' }}");
    expect(lane.on.push?.branches).toEqual(['main']);
  });

  it('writes the pin file the deploy reads, on one fixed branch', () => {
    expect(pin.env).toEqual({
      PIN_FILE: HOSTED_AGENT_PIN_FILE,
      PIN_BRANCH: 'chore/hosted-agent-image-pin',
    });
    const write = step((s) => s.id === 'write');
    expect(write.env?.REFERENCE).toBe(
      '${{ env.IMAGE }}@${{ needs.hosted-agent-image.outputs.digest }}',
    );
    expect(lane.env?.IMAGE).toBe(HOSTED_AGENT_IMAGE_REPOSITORY);
    expect(write.run).toContain(`printf '%s\\n' "$REFERENCE" > "$PIN_FILE"`);
    // The same rule the deploy applies, so the lane never writes a pin the deploy refuses.
    expect(write.run).toContain(BASH_PATTERN);
    expect(write.run).toContain("echo 'changed=false'");
  });

  it('opens the pull request with the App token, cut from main, only when the pin changed', () => {
    expect(pin.permissions).toEqual({ contents: 'read' });
    const token = step((s) => !!s.uses?.startsWith('actions/create-github-app-token@'));
    expect(token.id).toBe('app-token');
    const checkout = step((s) => !!s.uses?.startsWith('actions/checkout@'));
    expect(checkout.with).toEqual({ token: '${{ steps.app-token.outputs.token }}', ref: 'main' });
    const open = step((s) => !!s.run?.includes('gh pr create'));
    expect(open.if).toBe("${{ steps.write.outputs.changed == 'true' }}");
    expect(open.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(open.run).toContain('git push --force origin "HEAD:${PIN_BRANCH}"');
    expect(open.run).toContain('gh pr edit "$existing"');
    expect(open.run).toContain('--base main --head "$PIN_BRANCH"');
  });

  it('commits as the CLA signatory, with no co-author trailer', () => {
    const open = step((s) => !!s.run?.includes('gh pr create'));
    expect(open.run).toContain("--author='Zhu Yue <zhuyue11@gmail.com>'");
    expect(open.run).not.toMatch(/Co-Authored-By/i);
  });
});

describe("the pin pull request's own check", () => {
  const job = check.jobs['hosted-agent-pin']!;
  const run = job.steps.map((s) => s.run ?? '').join('\n');

  it('runs on a pull request that changes the pin file', () => {
    expect(check.on.pull_request?.paths).toContain(HOSTED_AGENT_PIN_FILE);
    expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('checks the pin is one line of the pinnable shape', () => {
    expect(run).toContain('grep -c \'\' "$file"');
    expect(run).toContain(BASH_PATTERN);
  });

  it('pulls the pinned image with an empty Docker config, as an agent-runner VM would', () => {
    expect(run).toContain('DOCKER_CONFIG="$(mktemp -d)" docker pull "$IMAGE"');
  });

  it("runs the image lane's smoke test and provider probe against the pinned image", () => {
    const against = job.steps.filter(
      (s) => s.env?.MOTIR_HOSTED_AGENT_IMAGE === '${{ steps.pin.outputs.image }}',
    );
    expect(against.map((s) => s.run)).toEqual([
      'pnpm --filter @motir/cli exec vitest run sandbox/hosted/smoke.test.ts',
      'pnpm --filter @motir/cli exec vitest run sandbox/hosted/providerProbe.test.ts',
    ]);
  });
});
