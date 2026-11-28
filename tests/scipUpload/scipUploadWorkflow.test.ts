import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CODEGRAPH_REPOSITORY_ID_VARIABLE,
  CODEGRAPH_UPLOAD_URL_VARIABLE,
  SCIP_UPLOAD_TOKEN_SECRET,
} from '@/lib/codeGraph/scipUploadActionsNames';

// The reusable SCIP upload workflow (Story MOTIR-12262 · MOTIR-12341). Workflow YAML
// is neither type-checked nor executed by any suite, so its shape is pinned here by
// reading the file: called only, the secret it needs, its inputs, the Actions names
// Motir installs on a hosted repository, and that the one thing it runs is the script
// `scipUploadScript.test.ts` drives.

const source = readFileSync(join(process.cwd(), '.github/workflows/scip-upload.yml'), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
}
const workflow = parse(source) as {
  on: Record<
    string,
    {
      inputs: Record<string, { required?: boolean; default?: unknown; type: string }>;
      secrets: Record<string, { required: boolean }>;
    }
  >;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { 'runs-on': string; 'timeout-minutes': number; if?: string; steps: Step[] }
  >;
};
const call = workflow.on['workflow_call']!;
const job = workflow.jobs['upload']!;
const steps = job.steps;
const runStep = steps.find((s) => s.run !== undefined)!;

describe('the reusable SCIP upload workflow', () => {
  it('is triggered only by workflow_call', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
  });

  it('requires the upload token secret, named as Motir installs it', () => {
    expect(call.secrets).toEqual({
      [SCIP_UPLOAD_TOKEN_SECRET]: expect.objectContaining({ required: true }),
    });
  });

  it('takes exactly the inputs the recipe documents, two of them required', () => {
    expect(Object.keys(call.inputs).sort()).toEqual(
      [
        'indexer',
        'index-command',
        'root',
        'file',
        'node-version',
        'go-version',
        'wait-seconds',
        'repository-id',
        'upload-url',
      ].sort(),
    );
    expect(call.inputs['indexer']!.required).toBe(true);
    expect(call.inputs['index-command']!.required).toBe(true);
    expect(call.inputs['root']!.default).toBe('.');
    expect(call.inputs['file']!.default).toBe('index.scip');
    expect(call.inputs['wait-seconds']).toMatchObject({ type: 'number', default: 1800 });
  });

  it('reads the repository id and host from the variables unless an input overrides them', () => {
    expect(runStep.env!['MOTIR_CODEGRAPH_REPOSITORY_ID']).toBe(
      `\${{ inputs.repository-id || vars.${CODEGRAPH_REPOSITORY_ID_VARIABLE} }}`,
    );
    expect(runStep.env!['MOTIR_CODEGRAPH_UPLOAD_URL']).toBe(
      `\${{ inputs.upload-url || vars.${CODEGRAPH_UPLOAD_URL_VARIABLE} }}`,
    );
    expect(runStep.env!['MOTIR_SCIP_UPLOAD_TOKEN']).toBe(
      `\${{ secrets.${SCIP_UPLOAD_TOKEN_SECRET} }}`,
    );
  });

  it('runs the script, checked out from motir-core at this workflow file’s own commit', () => {
    expect(runStep.run).toBe('bash .motir-scip-upload/scripts/scip-upload/scip-upload.sh');
    const script = steps.find((s) => s.with?.['path'] === '.motir-scip-upload')!;
    expect(script.uses).toMatch(/^actions\/checkout@/);
    expect(script.with).toMatchObject({
      repository: '${{ job.workflow_repository }}',
      ref: '${{ job.workflow_sha }}',
      'persist-credentials': false,
    });
    expect(steps.indexOf(script)).toBeLessThan(steps.indexOf(runStep));
  });

  it('maps the run into the script’s environment and lets the script decide to skip', () => {
    expect(runStep.env).toMatchObject({
      MOTIR_SCIP_COMMIT: '${{ github.sha }}',
      MOTIR_SCIP_EVENT: '${{ github.event_name }}',
      MOTIR_SCIP_DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
      MOTIR_SCIP_INDEXER: '${{ inputs.indexer }}',
      MOTIR_SCIP_INDEX_COMMAND: '${{ inputs.index-command }}',
      MOTIR_SCIP_ROOT: '${{ inputs.root }}',
      MOTIR_SCIP_FILE: '${{ inputs.file }}',
      MOTIR_SCIP_WAIT_SECONDS: '${{ inputs.wait-seconds }}',
    });
    expect(runStep.env!['MOTIR_SCIP_BRANCH']).toContain('github.ref_name');
    // No job-level `if`: a skipped run still prints why.
    expect(job.if).toBeUndefined();
  });

  it('sets up a toolchain only when asked', () => {
    expect(steps.find((s) => s.uses?.startsWith('actions/setup-node@'))!.if).toBe(
      "${{ inputs.node-version != '' }}",
    );
    expect(steps.find((s) => s.uses?.startsWith('actions/setup-go@'))!.if).toBe(
      "${{ inputs.go-version != '' }}",
    );
  });

  it('never echoes the secret, and passes it only to the script step', () => {
    for (const step of steps) {
      expect(step.run ?? '').not.toContain('secrets.');
      if (step !== runStep) expect(JSON.stringify(step)).not.toContain('secrets.');
    }
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('runs on the runner seam with a bounded job', () => {
    expect(job['runs-on']).toBe("${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}");
    expect(job['timeout-minutes']).toBeGreaterThan(1800 / 60);
  });
});
