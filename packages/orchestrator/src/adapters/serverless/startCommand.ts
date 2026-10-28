// THE START SHAPE THE SERVERLESS TARGET RUNS (MOTIR-9974). A manifest's
// `startCommand` is one string; a Lambda image command is an argv array, run
// with no shell. This one tokenizer both turns the string into that argv and
// decides whether the string is a shape Lambda can run, so a command the
// preflight accepts is always one the function configuration can carry.
//
// Accepted: one foreground command with plain arguments, optionally quoted with
// single or double quotes. Refused: anything that needs a shell (control
// operators, redirections, substitutions), a leading `NAME=value`, and a
// background or detach launcher — the way a resident process is written. A
// command that needs a shell is a script in the image, started by its path.

export type ParsedStartCommand = { readonly argv: string[] } | { readonly refused: string };

/** Operators a shell would interpret, longest first so `&&` wins over `&`. */
const OPERATORS = ['&&', '||', '$(', ';', '|', '&', '<', '>', '`'] as const;

/** Launchers that detach or background the process they start. */
const DETACHERS = new Set(['nohup', 'setsid', 'disown']);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function operatorAt(text: string, i: number): string | null {
  return OPERATORS.find((op) => text.startsWith(op, i)) ?? null;
}

function foreground(found: string): string {
  return `contains "${found}": a start command must be one foreground command`;
}

export function parseStartCommand(text: string): ParsedStartCommand {
  if (!text.trim()) return { refused: 'is empty' };
  const argv: string[] = [];
  let current: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current = (current ?? '') + ch;
      continue;
    }
    if (quote === '"') {
      // A double-quoted string is still expanded by a shell.
      const op = text.startsWith('$(', i) ? '$(' : ch === '`' ? '`' : null;
      if (op) return { refused: foreground(op) };
      if (ch === '"') quote = null;
      else if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        i += 1;
        current = (current ?? '') + text[i]!;
      } else current = (current ?? '') + ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== null) argv.push(current);
      current = null;
      continue;
    }
    const op = operatorAt(text, i);
    if (op) return { refused: foreground(op) };
    if (ch === "'" || ch === '"') {
      quote = ch;
      current ??= '';
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) i += 1;
    current = (current ?? '') + text[i]!;
  }
  if (quote) return { refused: `has an unbalanced ${quote === '"' ? 'double' : 'single'} quote` };
  if (current !== null) argv.push(current);
  if (!argv[0]) return { refused: 'names no program' };

  const assignment = ASSIGNMENT.exec(argv[0]);
  if (assignment) {
    // The name only: the value may be a secret.
    return {
      refused: `begins with an environment assignment (${assignment[1]}=…): set it as an environment variable`,
    };
  }
  if (DETACHERS.has(argv[0])) {
    return { refused: `starts with "${argv[0]}": a start command must run in the foreground` };
  }
  return { argv };
}
