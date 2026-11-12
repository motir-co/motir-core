import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  IMAGE_PINS_DIR,
  INDEXER_IMAGE_REF_PATTERN,
  PINNED_PARAMETERS,
  parseImagePins,
} from '@/scripts/aws-deploy/imagePins';

// MOTIR-10986 — the indexer pin's lane. Nothing in motir-core runs on motir-ai's
// `indexer-v*` tag, so `indexer-image-pin.yml` is dispatched (by Publish latest,
// or by a person) with the ECR reference to pin. The deploy's write of the pin is
// pinned in `imagePins.test.ts`; this file pins the lane: it refuses a reference
// the deploy would refuse BEFORE it mints a token, opens one pull request on a
// fixed branch, commits as the CLA signatory, queues the merge, and holds no AWS
// credential.

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
  'timeout-minutes'?: number;
  concurrency?: { group: string; 'cancel-in-progress'?: boolean };
  permissions: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, { type: string; required?: boolean }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const PIN_NAME = 'motir-indexer-image';
const PIN_FILE = `${IMAGE_PINS_DIR}/${PIN_NAME}`;
const SOURCE = readFileSync(join(process.cwd(), '.github/workflows/indexer-image-pin.yml'), 'utf8');
const lane = parse(SOURCE) as Workflow;
const pin = lane.jobs['pin']!;
const step = (predicate: (s: Step) => boolean) => {
  const found = pin.steps.find(predicate);
  expect(found, 'step not found').toBeDefined();
  return found!;
};
const at = (predicate: (s: Step) => boolean) => pin.steps.findIndex(predicate);

const check = step((s) => s.id === 'check');
/** The lane's own reference rule, lifted out of its `[[ =~ ]]` test. */
const LANE_PATTERN = new RegExp(/=~ (\^\S+\$) \]\]/.exec(check.run ?? '')?.[1] ?? '^$');

const DIGEST = 'a'.repeat(64);
const CASES: [string, boolean][] = [
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer@sha256:${DIGEST}`, true],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir-prod/indexer@sha256:${DIGEST}`, true],
  [`944842271421.dkr.ecr.cn-north-1.amazonaws.com.cn/motir/indexer@sha256:${DIGEST}`, true],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/indexer@sha256:${DIGEST}`, true],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer:indexer-0.5.1`, false],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/motir-core@sha256:${DIGEST}`, false],
  [`ghcr.io/motir-co/motir-indexer@sha256:${DIGEST}`, false],
  [`94484227142.dkr.ecr.us-east-1.amazonaws.com/motir/indexer@sha256:${DIGEST}`, false],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer@sha256:${'A'.repeat(64)}`, false],
  [`944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer@sha256:${DIGEST}\nx`, false],
];

describe('indexer-image-pin.yml', () => {
  it('is dispatched only, with the reference required and the version optional', () => {
    expect(Object.keys(lane.on)).toEqual(['workflow_dispatch']);
    expect(lane.on.workflow_dispatch?.inputs).toEqual({
      pin_reference: expect.objectContaining({ type: 'string', required: true }),
      pin_version: expect.objectContaining({ type: 'string', required: false }),
    });
  });

  it('holds no AWS credential and reads only contents', () => {
    expect(lane.permissions).toEqual({ contents: 'read' });
    expect(pin.permissions).toEqual({ contents: 'read' });
    expect(SOURCE).not.toMatch(/id-token|aws-actions|AWS_/);
  });

  it('serialises presses and has a bounded job', () => {
    expect(pin.concurrency).toEqual({ group: 'indexer-image-pin', 'cancel-in-progress': false });
    expect(pin['timeout-minutes']).toBe(10);
  });

  it('accepts exactly the references the deploy accepts', () => {
    for (const [reference, accepted] of CASES) {
      expect(LANE_PATTERN.test(reference), reference).toBe(accepted);
      expect(INDEXER_IMAGE_REF_PATTERN.test(reference), reference).toBe(accepted);
    }
    const [good] = CASES[0]!;
    expect(parseImagePins([{ name: PIN_NAME, content: `${good}\n` }])).toEqual([
      { name: PIN_NAME, value: good },
    ]);
  });

  it('checks the reference and the version before it mints a token', () => {
    expect(at((s) => s.id === 'check')).toBe(0);
    expect(at((s) => !!s.uses?.startsWith('actions/create-github-app-token@'))).toBe(1);
    expect(check.env).toEqual({
      REFERENCE: '${{ inputs.pin_reference }}',
      VERSION: '${{ inputs.pin_version }}',
    });
    expect(check.run).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(check.run).toContain('label=indexer-v${VERSION}');
  });

  it('writes the pin file the deploy reads, on one fixed branch, cut from main', () => {
    expect(PINNED_PARAMETERS[PIN_NAME]).toBe('indexer-image');
    expect(pin.env).toEqual({ PIN_FILE, PIN_BRANCH: 'chore/indexer-image-pin' });
    const checkout = step((s) => !!s.uses?.startsWith('actions/checkout@'));
    expect(checkout.with).toEqual({ ref: 'main', token: '${{ steps.app-token.outputs.token }}' });
    const write = step((s) => s.id === 'write');
    expect(write.run).toContain(`printf '%s\\n' "$REFERENCE" > "$PIN_FILE"`);
    expect(write.run).toContain("echo 'changed=false'");
  });

  it('opens or updates the pull request only when the pin changed, as the CLA signatory', () => {
    const open = step((s) => !!s.run?.includes('gh pr create'));
    expect(open.if).toBe("${{ steps.write.outputs.changed == 'true' }}");
    expect(open.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(open.run).toContain('git push --force origin "HEAD:${PIN_BRANCH}"');
    expect(open.run).toContain('gh pr edit "$existing"');
    expect(open.run).toContain('--base main --head "$PIN_BRANCH"');
    expect(open.run).toContain("--author='Zhu Yue <zhuyue11@gmail.com>'");
    expect(open.run).not.toMatch(/Co-Authored-By/i);
  });

  it('queues the pull request to merge, failing the run when there is none', () => {
    const queue = step((s) => !!s.run?.includes('gh pr merge'));
    expect(at((s) => s === queue)).toBe(pin.steps.length - 1);
    expect(queue.if).toBe("${{ steps.write.outputs.changed == 'true' }}");
    expect(queue.run).toContain('--head "$PIN_BRANCH"');
    expect(queue.run).toContain('--auto');
    expect(queue.run).toContain('exit 1');
  });
});
