import { describe, expect, it } from 'vitest';
import {
  canonicalRunsOn,
  commandWords,
  isFingerprintedPath,
  structureDigest,
  workflowFingerprint,
  workflowStructure,
} from '@/lib/ciFleet/workflowFingerprint';

// MOTIR-8870: the digest moves when a runner, a reusable workflow, an action or an
// executable changes, and stays put for the edits that blocked the switch twice.

const CI = '.github/workflows/ci.yml';

function ci(extraSteps = '', runsOn = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}"): string {
  return `
name: CI
on: [push]
jobs:
  test:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: |
          pnpm test
          pnpm coverage:a
${extraSteps}
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: flyctl deploy
`;
}

const fp = (text: string) => workflowFingerprint([{ path: CI, text }]);

describe('commandWords', () => {
  it('takes the first word of each simple command', () => {
    expect(
      commandWords(
        ['set -euo pipefail', 'A=1 B=2 pnpm test && gh pr list | jq .', 'cd x; make -j4'].join(
          '\n',
        ),
      ).sort(),
    ).toEqual(['cd', 'gh', 'jq', 'make', 'pnpm', 'set']);
  });

  it('skips comments, shell keywords and here-document bodies', () => {
    const script = [
      '# gh would be a tool',
      'if [ -f x ]; then',
      '  cat <<EOF',
      'curl is only text here',
      'EOF',
      'fi',
    ].join('\n');
    expect(commandWords(script).sort()).toEqual(['[', 'cat']);
    expect(commandWords('if gh pr view; then make; fi').sort()).toEqual(['gh', 'make']);
  });

  it('joins a backslash continuation into one command', () => {
    expect(commandWords('docker build \\\n  --tag x \\\n  .')).toEqual(['docker']);
  });

  it('sees a command inside $( ) and backticks', () => {
    expect(commandWords('echo "$(gh api x)"').sort()).toEqual(['echo', 'gh']);
  });

  // MOTIR-9126: a quoted jq program is an ARGUMENT, not a pipeline. Splitting it
  // made motir-ai#778's sweep line read as six new executables.
  it('does not split a separator inside single or double quotes', () => {
    const sweep =
      'idle=$(jq --argjson s "$LONG_IDLE_SECONDS" \'[.[] | select(.state == "suspended" and ((.updated_at // "") != "") and ((.updated_at | sub("\\\\.[0-9]+"; "") | fromdateiso8601? // now) < (now - $s)))] | length\' machines.json)';
    expect(commandWords(sweep)).toEqual(['jq']);
    expect(commandWords('echo "a | b; c && d (e)"')).toEqual(['echo']);
    expect(commandWords("awk '{ print $1 }' f | sort -u").sort()).toEqual(['awk', 'sort']);
    expect(commandWords('TITLE="chore(catalog): refresh the snapshot"')).toEqual([]);
    expect(commandWords('MSG="a b" gh pr create')).toEqual(['gh']);
  });

  it('still sees $( ) and backticks inside double quotes, and nothing after them', () => {
    expect(commandWords('echo "x $(gh api y | jq .z) tail"').sort()).toEqual(['echo', 'gh', 'jq']);
    expect(commandWords('echo "x `git rev-parse HEAD` tail"').sort()).toEqual(['echo', 'git']);
    expect(commandWords("echo '$(not run)'")).toEqual(['echo']);
  });

  it('reads a subshell, and a quoted string that spans lines', () => {
    expect(commandWords('(cd x && make) || exit 1').sort()).toEqual(['cd', 'exit', 'make']);
    expect(commandWords("jq '\n  .a | select(.b)\n' f\ncurl x").sort()).toEqual(['curl', 'jq']);
  });
});

describe('workflowFingerprint', () => {
  it('is stable for the same files in any order of keys and files', () => {
    const a = workflowFingerprint([
      { path: CI, text: ci() },
      {
        path: '.github/workflows/b.yml',
        text: 'jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ls\n',
      },
    ]);
    const b = workflowFingerprint([
      {
        path: '.github/workflows/b.yml',
        text: 'jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ls\n',
      },
      { path: CI, text: ci() },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not move for a new step that uses only tools the repository already uses', () => {
    const added = `      - name: Coverage (graph-scaling)
        if: \${{ !cancelled() }}
        run: pnpm coverage:graph-scaling
      - uses: pnpm/action-setup@v4
      - run: pnpm exec tsx scripts/x.ts snapshot`;
    expect(fp(ci(added))).toBe(fp(ci()));
  });

  it('does not move for an action version bump, a comment or a changed argument', () => {
    const bumped = ci()
      .replace('checkout@v4', 'checkout@v6')
      .replace('--frozen-lockfile', '--prefer-offline');
    expect(fp(`# note\n${bumped}`)).toBe(fp(ci()));
  });

  it('moves when a job changes its runner', () => {
    expect(fp(ci('', 'ubuntu-latest'))).not.toBe(fp(ci()));
  });

  // MOTIR-10211: motir-infra#7 added a `verify` job on the seam with the actions
  // and executables `deploy` already used, and the per-job key moved the digest.
  it('does not move for a job added on a runner and with tools the repository already uses', () => {
    expect(
      fp(`${ci()}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n`),
    ).toBe(fp(ci()));
    const seam = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";
    expect(
      fp(`${ci()}  verify:\n    runs-on: ${seam}\n    steps:\n      - uses: actions/checkout@v4\n`),
    ).toBe(fp(ci()));
  });

  it('moves for a job added on a runner the repository does not use yet', () => {
    expect(
      fp(`${ci()}  mac:\n    runs-on: macos-latest\n    steps:\n      - run: pnpm lint\n`),
    ).not.toBe(fp(ci()));
  });

  it('moves when the last job on a runner is removed — it fails closed', () => {
    expect(fp(ci().replace(/ {2}deploy:[\s\S]*$/, ''))).not.toBe(fp(ci()));
  });

  it('moves for a new executable', () => {
    expect(fp(ci('      - run: gh pr comment 1'))).not.toBe(fp(ci()));
  });

  it('moves for a new action', () => {
    expect(fp(ci('      - uses: docker/setup-qemu-action@v3'))).not.toBe(fp(ci()));
  });

  it('moves for a new shell', () => {
    expect(fp(ci('      - run: print(1)\n        shell: python3 {0}'))).not.toBe(fp(ci()));
  });

  it('does not read a non-shell body as commands, so editing it does not move', () => {
    const py = (body: string) => ci(`      - run: ${body}\n        shell: python3 {0}`);
    expect(fp(py('print(1) | x'))).toBe(fp(py('import json; json.dumps(2)')));
    expect(fp(ci('      - run: gh x\n        shell: bash'))).not.toBe(fp(ci()));
  });

  it('moves when a reusable workflow is called', () => {
    const called = `${ci()}  image:\n    uses: ./.github/workflows/image.yml\n`;
    expect(fp(called)).not.toBe(fp(ci()));
  });

  it('reads a local composite action, and ignores every other file', () => {
    const action = '.github/actions/x/action.yml';
    const base = [{ path: CI, text: ci() }];
    const withAction = (run: string) => [
      ...base,
      {
        path: action,
        text: `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`,
      },
    ];
    expect(workflowFingerprint(withAction('gh api x'))).not.toBe(
      workflowFingerprint(withAction('ls')),
    );
    expect(workflowFingerprint([...base, { path: 'README.md', text: 'gh' }])).toBe(
      workflowFingerprint(base),
    );
  });

  it('throws on invalid YAML rather than calling it unchanged', () => {
    expect(() => fp('jobs: [unclosed')).toThrow();
  });
});

describe('isFingerprintedPath / workflowStructure', () => {
  it('names the workflow files and composite actions only', () => {
    expect(isFingerprintedPath('.github/workflows/ci.yml')).toBe(true);
    expect(isFingerprintedPath('.github/workflows/ci.yaml')).toBe(true);
    expect(isFingerprintedPath('.github/actions/pnpm/action.yml')).toBe(true);
    expect(isFingerprintedPath('.github/workflows/nested/x.yml')).toBe(false);
    expect(isFingerprintedPath('.github/dependabot.yml')).toBe(false);
  });

  it('records runner and reusable call per job, and the repository-wide sets', () => {
    const s = workflowStructure([
      { path: CI, text: ci(`      - run: print(1)\n        shell: python3 {0}`) },
    ]);
    expect(s.jobs[`${CI}#deploy`]).toEqual({ runsOn: 'ubuntu-latest', calls: null });
    expect(s.actions).toEqual(['actions/checkout', 'pnpm/action-setup']);
    expect(s.commands).toContain('flyctl');
    expect(s.shells).toEqual(['python3 {0}']);
  });

  it('records the distinct runners and reusable calls repository-wide', () => {
    const s = workflowStructure([
      {
        path: CI,
        text: `${ci()}  again:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ls\n  image:\n    uses: ./.github/workflows/image.yml@main\n`,
      },
    ]);
    expect(s.runners).toEqual([
      canonicalRunsOn("${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}"),
      canonicalRunsOn('ubuntu-latest'),
    ]);
    // A caller job contributes its call, never a runner of its own.
    expect(s.calls).toEqual(['./.github/workflows/image.yml']);
    expect(s.jobs[`${CI}#image`]).toEqual({ runsOn: null, calls: './.github/workflows/image.yml' });
  });

  it('spells a runner the same way whatever its key order, and a missing one as null', () => {
    expect(canonicalRunsOn({ labels: ['x'], group: 'g' })).toBe(
      canonicalRunsOn({ group: 'g', labels: ['x'] }),
    );
    expect(canonicalRunsOn(undefined)).toBe('null');
  });

  // ⚠️ A CHANGE TO THE DIGEST'S INPUTS IS A CHANGE TO EVERY RECORDED FINGERPRINT.
  // This literal is the digest of a fixed workflow: when it has to change, every
  // `structureFingerprint` in `lib/ciFleet/fleetJobInventory.json` must be
  // recomputed at its entry's sha in the same change (MOTIR-10211), or each entry
  // reads `inventory_stale` the moment its repository's workflows next move.
  it('pins the digest of a fixed workflow, so an input change cannot ship unnoticed', () => {
    const s = workflowStructure([{ path: CI, text: ci() }]);
    expect(structureDigest(s)).toBe(fp(ci()));
    expect(fp(ci())).toBe('4ed232b1b99bf1534215b65cb20ba52aba2116574a9d7b3a02107a3e9df9a360');
  });
});
