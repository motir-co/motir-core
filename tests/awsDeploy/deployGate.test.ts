import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The check an AWS deploy runs before it rolls (MOTIR-10436), driven as the real
// script against a stand-in `aws` and `git`.

const SCRIPT = join(process.cwd(), 'scripts/aws-deploy/deploy-gate.sh');
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

let dir: string;
let output: string;

function stub(name: string, body: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Answers each `describe-stacks` with the next status, repeating the last. */
function stacks(...statuses: string[]): void {
  writeFileSync(join(dir, 'statuses'), `${statuses.join('\n')}\n`);
  stub(
    'aws',
    `echo "$*" >> "${dir}/aws-calls"
s="$(head -n 1 "${dir}/statuses")"
[ "$(wc -l < "${dir}/statuses")" -gt 1 ] && sed -i.bak 1d "${dir}/statuses"
echo "$s"`,
  );
}

/** Answers each `git ls-remote` with the next commit, repeating the last. */
function main(...shas: string[]): void {
  writeFileSync(join(dir, 'heads'), `${shas.join('\n')}\n`);
  stub(
    'git',
    `h="$(head -n 1 "${dir}/heads")"
[ "$(wc -l < "${dir}/heads")" -gt 1 ] && sed -i.bak 1d "${dir}/heads"
printf '%s\\trefs/heads/main\\n' "$h"`,
  );
}

function gate(env: Record<string, string> = {}): { log: string; deploy: string; calls: number } {
  const log = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
      GITHUB_OUTPUT: output,
      GITHUB_SHA: SHA,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_RUN_ATTEMPT: '1',
      DEPLOY_STACKS: 'one two',
      DEPLOY_GATE_POLL_SECONDS: '0',
      ...env,
    },
  });
  let calls = 0;
  try {
    calls = readFileSync(join(dir, 'aws-calls'), 'utf8').trim().split('\n').length;
  } catch {
    // no call was made
  }
  return { log, deploy: readFileSync(output, 'utf8').trim(), calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
  output = join(dir, 'output');
  writeFileSync(output, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('main has moved on', () => {
  beforeEach(() => stacks('UPDATE_COMPLETE'));

  it('deploys when its commit is main newest', () => {
    main(SHA);
    expect(gate().deploy).toBe('deploy=true');
  });

  it('stands down on a first attempt of a push, naming the newer commit', () => {
    main(NEWER);
    const { deploy, log } = gate();
    expect(deploy).toBe('deploy=false');
    expect(log).toContain(`::notice::${SHA} is no longer main's newest commit (${NEWER})`);
  });

  it('still deploys a re-run, with a warning', () => {
    main(NEWER);
    const { deploy, log } = gate({ GITHUB_RUN_ATTEMPT: '2' });
    expect(deploy).toBe('deploy=true');
    expect(log).toContain('::warning::deploying');
  });

  it('still deploys a manual dispatch, with a warning', () => {
    main(NEWER);
    const { deploy, log } = gate({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect(deploy).toBe('deploy=true');
    expect(log).toContain('::warning::deploying');
  });

  it('warns and deploys when it cannot read main', () => {
    stub('git', 'exit 128');
    const { deploy, log } = gate();
    expect(deploy).toBe('deploy=true');
    expect(log).toContain("::warning::could not read main's newest commit");
  });
});

describe('a stack update is running', () => {
  beforeEach(() => main(SHA));

  it('waits until every stack has settled, then deploys', () => {
    stacks(
      'UPDATE_IN_PROGRESS',
      'UPDATE_COMPLETE',
      'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
      'UPDATE_COMPLETE',
    );
    const { deploy, log, calls } = gate();
    expect(deploy).toBe('deploy=true');
    expect(log).toContain('waiting for a stack update to finish: one=UPDATE_IN_PROGRESS');
    expect(calls).toBe(6);
  });

  it('does not wait when nothing is running', () => {
    stacks('UPDATE_COMPLETE');
    const { log, calls } = gate();
    expect(log).not.toContain('waiting');
    expect(calls).toBe(2);
  });

  it('gives up at its bound, warns and deploys', () => {
    stacks('UPDATE_IN_PROGRESS');
    const { deploy, log } = gate({ DEPLOY_GATE_WAIT_SECONDS: '0' });
    expect(deploy).toBe('deploy=true');
    expect(log).toContain('::warning::still busy after 0s, deploying anyway');
  });

  it('warns and deploys when a stack cannot be read', () => {
    stub('aws', 'echo "AccessDenied" >&2; exit 254');
    const { deploy, log } = gate();
    expect(deploy).toBe('deploy=true');
    expect(log).toContain('::warning::could not read stack one, not waiting for it: AccessDenied');
  });

  it('stands down before waiting, so it does not hold the deploy lock for nothing', () => {
    stacks('UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE');
    main(NEWER);
    const { deploy, log, calls } = gate();
    expect(deploy).toBe('deploy=false');
    expect(log).not.toContain('waiting');
    expect(calls).toBe(0);
  });

  it('re-reads main after the wait, so a merge during it counts', () => {
    stacks('UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE');
    main(SHA, NEWER);
    const { deploy, log } = gate();
    expect(deploy).toBe('deploy=false');
    expect(log).toContain('waiting for a stack update to finish');
    expect(log).toContain(`(${NEWER})`);
  });
});
