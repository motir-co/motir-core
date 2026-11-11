import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { IMAGE_PINS_DIR } from '@/scripts/aws-deploy/imagePins';

// MOTIR-10883: a `runner-v*` release opens the pull request that pins it. Two
// releases (runner-v0.2.5 and v0.2.6) were published and never pinned, because
// the pin was a person copying a digest out of a job summary. Workflow YAML runs
// in no suite, so the properties the lane promises are pinned by reading it.

const WORKFLOWS = join(process.cwd(), '.github/workflows');
const source = readFileSync(join(WORKFLOWS, 'release-runner-image.yml'), 'utf8');

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
const workflow = parse(source) as {
  on: {
    push: { tags: string[] };
    workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown }> };
  };
  jobs: Record<
    string,
    {
      needs?: string[];
      if?: string;
      permissions?: Record<string, string>;
      concurrency?: { group: string; 'cancel-in-progress': boolean };
      steps: Step[];
      outputs?: unknown;
    }
  >;
};
const pin = workflow.jobs['pin']!;
const step = (id: string) => pin.steps.find((s) => s.id === id)!;
const PIN_FILE = `${IMAGE_PINS_DIR}/motir-runner-image`;

describe('the runner image release opens its own pin pull request (MOTIR-10883)', () => {
  it('runs after the publish, on a tag push only — a dry run publishes nothing to pin', () => {
    expect(workflow.on.push.tags).toEqual(['runner-v*']);
    expect(pin.needs).toEqual(['version', 'release']);
    expect(pin.if).toContain('!cancelled()');
    expect(pin.if).toContain("github.event_name == 'push' && needs.release.result == 'success'");
  });

  it('a Publish latest dispatch (MOTIR-10886) pins an already-published digest, building nothing', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs['pin_digest']).toMatchObject({ type: 'string', default: '' });
    expect(inputs['pin_version']).toMatchObject({ type: 'string', default: '' });
    expect(workflow.jobs['version']!.if).toBe('${{ !inputs.pin_digest }}');
    expect(pin.if).toContain("github.event_name == 'workflow_dispatch' && inputs.pin_digest != ''");
    const write = step('write');
    expect(write.env?.['VERSION']).toBe(
      '${{ inputs.pin_version || needs.version.outputs.version }}',
    );
    expect(write.run).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    const queue = pin.steps.find((s) => s.run?.includes('gh pr merge'))!;
    expect(queue.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && steps.write.outputs.changed == 'true' }}",
    );
    expect(queue.run).toContain('--head chore/runner-image-pin');
    expect(queue.run).toContain('--auto');
  });

  it('takes the digest the reusable lane published and pulled back, never a tag', () => {
    const write = step('write');
    expect(write.env?.['DIGEST']).toBe('${{ inputs.pin_digest || needs.release.outputs.digest }}');
    expect(write.env?.['IMAGE']).toBe('ghcr.io/motir-co/motir-ci-runner');
    expect(write.env?.['PIN']).toBe(PIN_FILE);
    expect(write.run).toContain('^sha256:[a-f0-9]{64}$');
    expect(write.run).toContain('ref="${IMAGE}@${DIGEST}"');
    const runnerImage = readFileSync(join(WORKFLOWS, 'runner-image.yml'), 'utf8');
    expect(runnerImage).toContain('IMAGE: ghcr.io/motir-co/motir-ci-runner');
    expect(runnerImage).toContain('value: ${{ jobs.runner-image.outputs.digest }}');
  });

  it('writes the pin on main, not on the tag tree, and opens nothing when it is unchanged', () => {
    const checkout = pin.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.['ref']).toBe('main');
    expect(step('write').run).toContain('git diff --quiet -- "$PIN"');
    const open = pin.steps.find((s) => s.run?.includes('gh pr create'))!;
    expect(open.if).toBe("${{ steps.write.outputs.changed == 'true' }}");
  });

  it('pushes and opens with the App token, so the pull request runs its checks and can merge', () => {
    const token = pin.steps.find((s) => s.uses?.startsWith('actions/create-github-app-token@'))!;
    expect(token.id).toBe('app-token');
    expect(token.with?.['app-id']).toBe('${{ secrets.RELEASE_APP_ID }}');
    const checkout = pin.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.['token']).toBe('${{ steps.app-token.outputs.token }}');
    const open = pin.steps.find((s) => s.run?.includes('gh pr create'))!;
    expect(open.env?.['GH_TOKEN']).toBe('${{ steps.app-token.outputs.token }}');
    expect(pin.permissions).toEqual({ contents: 'read' });
    expect(source).not.toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN/);
  });

  it('keeps ONE pull request: one branch for every release, updated when it is already open', () => {
    const open = pin.steps.find((s) => s.run?.includes('gh pr create'))!;
    expect(open.run).toContain("branch='chore/runner-image-pin'");
    expect(open.run).toContain('git push --force origin "HEAD:${branch}"');
    expect(open.run).toContain('gh pr list --head "$branch" --state open');
    expect(open.run).toContain('gh pr edit "$existing"');
    expect(pin.concurrency).toEqual({ group: 'runner-image-pin', 'cancel-in-progress': false });
  });

  it('commits only the pin, as the CLA signatory, with no co-author', () => {
    const open = pin.steps.find((s) => s.run?.includes('gh pr create'))!;
    expect(open.run).toContain("--author='Zhu Yue <zhuyue11@gmail.com>'");
    expect(open.run).toContain('-- "$PIN"');
    expect(open.env?.['PIN']).toBe(PIN_FILE);
    expect(open.run).not.toMatch(/Co-Authored-By/i);
  });
});
