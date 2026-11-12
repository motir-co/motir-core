import { describe, expect, it } from 'vitest';
import {
  commandWords,
  isWorkflowSourcePath,
  parseActionMetadata,
  parseWorkflows,
  scriptCommands,
} from '@/lib/ciFleet/workflowJobs';

// MOTIR-10290: the workflows are read per job, and every `run:` body is read for
// the commands it asks the runner image for. MOTIR-9126's quote-aware reading
// carries over unchanged.

const CI = '.github/workflows/ci.yml';

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

describe('scriptCommands', () => {
  it('names a command a wrapper runs as well as the wrapper', () => {
    expect(commandWords('sudo apt-get update').sort()).toEqual(['apt-get', 'sudo']);
    expect(commandWords('env -i FOO=1 make all').sort()).toEqual(['env', 'make']);
    expect(commandWords('timeout 30s curl -sf x').sort()).toEqual(['curl', 'timeout']);
    expect(commandWords('git ls-files | xargs -0 shellcheck').sort()).toEqual([
      'git',
      'shellcheck',
      'xargs',
    ]);
  });

  it('reads a computed command name as dynamic, never as a tool', () => {
    const read = scriptCommands('"$PYTHON" -m pip install x\n${{ inputs.cli }} run');
    expect(read.commands).toEqual([]);
    expect(read.dynamic).toEqual(['$PYTHON', '${{']);
  });

  it('reads arithmetic as text, and a command inside it as a command', () => {
    const script = [
      'sleep $((attempt * 10))',
      'echo "waited $((attempt * (2 + 1)))"',
      '((attempt++))',
    ].join('\n');
    expect(commandWords(script).sort()).toEqual(['echo', 'sleep']);
    // Arithmetic that runs a command stays with the command reading, which fails
    // closed: `wc` is seen, at the cost of `n` reading as a tool.
    expect(commandWords('echo $((n + $(wc -l < f)))').sort()).toEqual(['echo', 'n', 'wc']);
    // Two nested subshells, not arithmetic: the shell runs both.
    expect(commandWords('( (git a); (gh b) )').sort()).toEqual(['gh', 'git']);
    expect(commandWords('x=$((git a); (gh b))').sort()).toEqual(['gh', 'git']);
    // A substitution with parentheses of its own is not arithmetic either.
    expect(commandWords(`x=$(jq '((.a))' f; (gh b))`).sort()).toEqual(['gh', 'jq']);
  });

  it('reads a command under a runner directory as a path, any other as computed', () => {
    const script = [
      '"$RUNNER_TEMP/actionlint" -color',
      '"${GITHUB_ACTION_PATH}/dist/codecov.sh"',
      '$GITHUB_WORKSPACE/bin/x',
      '"$HOME/bin/y"',
      '"$RUNNER_TEMP"',
      '"/usr/lib/postgresql/${PG_MAJOR}/bin/pg_dump" --version',
      '/opt/$V/bin/$TOOL',
    ].join('\n');
    // An absolute path computed only in its directory is a path, like
    // `/usr/bin/x`; one whose file name is computed stays computed.
    expect(scriptCommands(script)).toMatchObject({
      commands: [],
      dynamic: ['$HOME/bin/y', '$RUNNER_TEMP', '/opt/$V/bin/$TOOL'],
    });
  });

  it('skips paths, the functions a script defines, and redirections', () => {
    const script = [
      'retry() { "$@"; }',
      'function bump { echo up; }',
      'retry curl x',
      'bump',
      './scripts/build.sh',
      '>out.txt echo hi',
    ].join('\n');
    // `retry` runs its arguments through `"$@"`, which no static reading can
    // follow: that is a computed command, so the job is judged unverified.
    expect(scriptCommands(script)).toMatchObject({ commands: ['echo'], dynamic: ['$@'] });
    expect(commandWords('2>/dev/null git x; > f cat; 2> err ls').sort()).toEqual([
      'cat',
      'git',
      'ls',
    ]);
  });

  it('skips loop and case heads, [[ ]] tests and array literals', () => {
    const script = [
      'for f in a b; do cat "$f"; done',
      'case "$x" in',
      '  a|b) echo ab ;;',
      '  *) exit 1 ;;',
      'esac',
      '[[ -n "$x" ]] && make',
      'if [[ "$REF" =~ ^v(.+)$ ]]; then echo "${BASH_REMATCH[1]}"; fi',
      'args+=(--flag value)',
      'list=(one two)',
    ].join('\n');
    expect(scriptCommands(script).commands.sort()).toEqual(['cat', 'echo', 'exit', 'make']);
  });

  it('lists what an install command puts on PATH', () => {
    const script = [
      'pipx install ruff==0.6',
      'cargo install cargo-deny',
      'go install golang.org/x/tools/cmd/goimports@latest',
      'npm i -g @scope/cli@2 typescript opencode-ai@1.18',
      'npm install left-pad',
      'pnpm add -g tsx',
      'yarn global add serve',
      'sudo apt-get install -y shellcheck jq',
      'corepack enable pnpm',
      'pip install not-counted',
    ].join('\n');
    expect(scriptCommands(script).installs).toEqual(
      [
        'cargo-deny',
        'cli',
        'goimports',
        'jq',
        'opencode',
        'opencode-ai',
        'pnpm',
        'pnpx',
        'ruff',
        'serve',
        'shellcheck',
        'tsx',
        'typescript',
      ].sort(),
    );
    expect(scriptCommands('corepack enable').installs).toEqual(['pnpm', 'pnpx', 'yarn', 'yarnpkg']);
    expect(scriptCommands('pipx run ruff').installs).toEqual([]);
    expect(scriptCommands('go build ./...').installs).toEqual([]);
    expect(scriptCommands('yarn add x').installs).toEqual([]);
    expect(scriptCommands('cargo build').installs).toEqual([]);
    expect(scriptCommands('apt-get update').installs).toEqual([]);
    expect(scriptCommands('pnpm install').installs).toEqual([]);
    expect(scriptCommands('corepack prepare').installs).toEqual([]);
  });

  it('reads a here-document body as text and a CRLF script as lines', () => {
    expect(commandWords('cat <<-"END"\n  rm -rf /\n  END\nls').sort()).toEqual(['cat', 'ls']);
    expect(commandWords('a\r\nb').sort()).toEqual(['a', 'b']);
    expect(commandWords('echo "a \\" b"; ls').sort()).toEqual(['echo', 'ls']);
  });
});

describe('isWorkflowSourcePath', () => {
  it('takes workflow files and local action metadata only', () => {
    expect(isWorkflowSourcePath('.github/workflows/ci.yml')).toBe(true);
    expect(isWorkflowSourcePath('.github/workflows/ci.yaml')).toBe(true);
    expect(isWorkflowSourcePath('.github/actions/setup/action.yml')).toBe(true);
    expect(isWorkflowSourcePath('.github/workflows/nested/ci.yml')).toBe(false);
    expect(isWorkflowSourcePath('.github/dependabot.yml')).toBe(false);
    expect(isWorkflowSourcePath('.github/actions/setup/README.md')).toBe(false);
  });
});

describe('parseActionMetadata', () => {
  it("reads the kind of action, and a composite action's steps", () => {
    expect(parseActionMetadata("runs:\n  using: 'node20'\n  main: x.js")).toEqual({
      using: 'node',
      steps: [],
    });
    expect(parseActionMetadata('runs:\n  using: docker\n  image: Dockerfile').using).toBe('docker');
    expect(parseActionMetadata('runs:\n  using: something-new').using).toBe('unknown');
    expect(parseActionMetadata('name: no runs').using).toBe('unknown');
    const composite = parseActionMetadata(
      [
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/setup-node@v4',
        '      with: { node-version: 22 }',
        '    - run: pnpm i',
        '      shell: bash',
        '    - name: neither',
        '    - just a string',
      ].join('\n'),
    );
    expect(composite).toEqual({
      using: 'composite',
      steps: [
        { kind: 'uses', uses: 'actions/setup-node@v4', with: { 'node-version': 22 } },
        { kind: 'run', shell: 'bash', script: 'pnpm i' },
      ],
    });
  });

  it('throws on text that is not YAML', () => {
    expect(() => parseActionMetadata('runs: [unclosed')).toThrow();
  });
});

describe('parseWorkflows', () => {
  it('reads every job with its runner, call, container, services and steps', () => {
    const text = [
      'on: [push]',
      'defaults:',
      '  run:',
      '    shell: sh',
      'jobs:',
      '  test:',
      "    runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}",
      '    container: node:22',
      '    services:',
      '      db: { image: postgres }',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: make',
      '      - run: python -c 1',
      '        shell: python',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '    defaults: { run: { shell: pwsh } }',
      '    steps:',
      '      - run: Write-Host hi',
      '  call:',
      '    uses: ./.github/workflows/reuse.yml',
      '  odd: not-a-job',
    ].join('\n');
    const set = parseWorkflows([
      { path: CI, text },
      { path: 'README.md', text: 'not read' },
    ]);
    expect(set.invalid).toEqual([]);
    expect(set.jobs).toEqual([
      {
        workflow: CI,
        jobId: 'test',
        runsOn: "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}",
        calls: null,
        container: true,
        services: true,
        steps: [
          { kind: 'uses', uses: 'actions/checkout@v4', with: {} },
          { kind: 'run', shell: 'sh', script: 'make' },
          { kind: 'run', shell: 'python', script: 'python -c 1' },
        ],
      },
      {
        workflow: CI,
        jobId: 'lint',
        runsOn: 'ubuntu-latest',
        calls: null,
        container: false,
        services: false,
        steps: [{ kind: 'run', shell: 'pwsh', script: 'Write-Host hi' }],
      },
      {
        workflow: CI,
        jobId: 'call',
        runsOn: null,
        calls: './.github/workflows/reuse.yml',
        container: false,
        services: false,
        steps: [],
      },
    ]);
  });

  it('keys local actions by directory and lists a file that is not YAML', () => {
    const set = parseWorkflows([
      { path: '.github/actions/setup/action.yml', text: 'runs:\n  using: node20' },
      { path: '.github/workflows/bad.yml', text: 'jobs: [unclosed' },
      { path: '.github/workflows/empty.yml', text: 'name: nothing' },
    ]);
    expect([...set.localActions.entries()]).toEqual([
      ['.github/actions/setup', { using: 'node', steps: [] }],
    ]);
    expect(set.invalid).toEqual(['.github/workflows/bad.yml']);
    expect(set.jobs).toEqual([]);
  });
});
