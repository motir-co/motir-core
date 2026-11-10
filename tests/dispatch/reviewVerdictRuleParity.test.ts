import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_DOOR_VERDICTS } from '@/lib/dto/agentReview';
import {
  assembleReviewPrompt,
  REVIEW_VERDICTS,
  type ReviewPromptInput,
} from '@/lib/dispatch/reviewPromptTemplate';

// ONE VERDICT RULE, TWO TEXTS (MOTIR-10786). Motir's hosted reviewer reads its verdict rule
// from the prompt `assembleReviewPrompt` builds (YOUR VERDICT); a person's own review agent
// reads it from the `motir-review` skill in motir-skills (§ 6, "The verdict rule"). The two
// were aligned once, by hand, when MOTIR-10327 shipped both. This file holds them equal: it
// parses each text into the same structured rule — which checklist statuses and finding
// severities send a card back, which never do, and that the verdict passes otherwise — and
// fails when either text's rule changes without the other.
//
// ── Where the skill text comes from ────────────────────────────────────────────────────
// The skill lives in another repository, so it is read LIVE from motir-skills' default
// branch (the repository is public; no token). Reading it live is the point: a vendored
// copy would only re-check motir-core against itself, and a rule change merged in
// motir-skills alone would never turn anything red. `MOTIR_SKILLS_DIR` (a local
// motir-skills checkout) replaces the fetch, for working offline or before a skills
// change is merged. A failed read FAILS the file — it is never skipped, because a skipped
// parity check is the silent drift this file exists to catch.
//
// ── Two words for one verdict ──────────────────────────────────────────────────────────
// The hosted reviewer answers the gate's words (`pass` / `changes_requested`); the
// user-token door the skill submits through answers `approved` / `changes_requested`, and
// `reviewVerdictService` maps `approved` → `pass`. The parse normalises the door's word to
// the gate's, and the vocabulary test below pins that both word sets are still the ones the
// code accepts.

const SKILL_REPO = 'motir-co/motir-skills';
const SKILL_PATH = 'plugins/motir/skills/motir-review/SKILL.md';
const SKILL_URL = `https://raw.githubusercontent.com/${SKILL_REPO}/main/${SKILL_PATH}`;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

/** The door's wire word → the gate's word, as `reviewVerdictService.gateVerdictOf` maps it. */
const DOOR_TO_GATE_VERDICT = { approved: 'pass', changes_requested: 'changes_requested' } as const;

/** A checklist status or finding severity a verdict rule can name. */
type RuleTerm = 'not_met' | 'cannot_tell' | 'blocker' | 'major' | 'minor' | 'nit';

/** A verdict rule, reduced to what decides a verdict. */
interface VerdictRule {
  /** What sends the card back (`changes_requested`), sorted. */
  sendsBack: RuleTerm[];
  /** What the rule says never sends the card back on its own, sorted. */
  neverSendsBack: RuleTerm[];
  /** Whether the rule passes the card when nothing in `sendsBack` holds. */
  passesOtherwise: boolean;
}

const TERM_PATTERNS: readonly (readonly [RuleTerm, RegExp])[] = [
  ['not_met', /`not[ _]met`/],
  ['cannot_tell', /`cannot[ _]tell`/],
  ['blocker', /\bblockers?\b/i],
  ['major', /\bmajor\b/i],
  ['minor', /\bminor\b/i],
  ['nit', /\bnits?\b/i],
];

const NEVER = /\bnever\b|\bdoes not send\b/i;

function termsIn(sentence: string): RuleTerm[] {
  return TERM_PATTERNS.filter(([, pattern]) => pattern.test(sentence)).map(([term]) => term);
}

/** A verdict word in a sentence, normalised to the gate's word. */
function gateVerdictWord(word: string): string {
  return word in DOOR_TO_GATE_VERDICT
    ? DOOR_TO_GATE_VERDICT[word as keyof typeof DOOR_TO_GATE_VERDICT]
    : word;
}

/**
 * The rule a passage states. Each sentence is one clause: a sentence that says a term
 * NEVER (or does not) send the card back exempts the terms it names; a sentence that
 * names `changes_requested` with "any …", or the passing verdict "only when no …", makes
 * its terms send the card back; and "`pass` — otherwise" (or "`approved` only when …
 * Otherwise `changes_requested`") is the default. Sentences that are none of these are
 * guidance around the rule, and carry no part of it.
 */
function parseVerdictRule(passage: string): VerdictRule {
  const text = passage.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const sendsBack = new Set<RuleTerm>();
  const neverSendsBack = new Set<RuleTerm>();
  let passesOtherwise = false;
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    const verdicts = [...sentence.matchAll(/`(pass|approved|changes_requested)`/g)].map((m) =>
      gateVerdictWord(m[1]!),
    );
    if (NEVER.test(sentence)) {
      // Only the clauses that themselves say "never" exempt their terms: in "X rows never
      // send a card back, and minor findings never do", each half is read on its own.
      for (const clause of sentence.split(/,\s+(?:and|or)\s+/)) {
        if (NEVER.test(clause)) for (const term of termsIn(clause)) neverSendsBack.add(term);
      }
    } else if (verdicts[0] === 'pass' && /\bonly when\b/i.test(sentence)) {
      for (const term of termsIn(sentence)) sendsBack.add(term);
      passesOtherwise = true;
    } else if (verdicts[0] === 'changes_requested' && /\bany\b/i.test(sentence)) {
      for (const term of termsIn(sentence)) sendsBack.add(term);
    } else if (verdicts[0] === 'pass' && /\botherwise\b/i.test(sentence)) {
      passesOtherwise = true;
    }
  }
  if (sendsBack.size === 0) {
    throw new Error(`no send-back clause could be read from the verdict rule:\n${passage}`);
  }
  return {
    sendsBack: [...sendsBack].sort(),
    neverSendsBack: [...neverSendsBack].sort(),
    passesOtherwise,
  };
}

/** A mutated passage's rule, or `'unreadable'` when the parse refuses it — either one is a
 *  red parity check. */
function ruleOrUnreadable(passage: string): VerdictRule | 'unreadable' {
  try {
    return parseVerdictRule(passage);
  } catch {
    return 'unreadable';
  }
}

/** The verdict rule of the hosted review prompt: the YOUR VERDICT bullets from
 *  `changes_requested` through `pass`. */
function hostedVerdictPassage(prompt: string): string {
  const verdictSection = prompt.slice(prompt.indexOf('YOUR VERDICT'));
  const start = verdictSection.indexOf('- `changes_requested` —');
  const passBullet = verdictSection.indexOf('- `pass` —', start);
  const end = verdictSection.indexOf('\n  - ', passBullet + 1);
  if (prompt.indexOf('YOUR VERDICT') < 0 || start < 0 || passBullet < 0 || end < 0) {
    throw new Error('the hosted review prompt no longer carries its verdict bullets');
  }
  return verdictSection.slice(start, end);
}

/** The verdict rule of the `motir-review` skill: the paragraph that opens "The verdict rule". */
function skillVerdictPassage(skillMd: string): string {
  const start = skillMd.indexOf('**The verdict rule:**');
  const end = skillMd.indexOf('\n\n', start);
  if (start < 0 || end < 0) {
    throw new Error(`${SKILL_PATH} no longer carries a "**The verdict rule:**" paragraph`);
  }
  return skillMd.slice(start, end);
}

async function fetchSkill(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(SKILL_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
  }
  throw new Error(
    `could not read ${SKILL_URL} (${String(lastError)}). Set MOTIR_SKILLS_DIR to a ` +
      'motir-skills checkout to run this file offline.',
  );
}

async function readSkill(): Promise<string> {
  const dir = process.env.MOTIR_SKILLS_DIR;
  return dir ? readFile(path.join(dir, SKILL_PATH), 'utf8') : fetchSkill();
}

const RUN_TARGET: ReviewPromptInput = {
  key: 'ACME-7',
  title: 'Show the widget count in the header',
  projectName: 'Acme',
  descriptionMd: '## Acceptance criteria\n\n- The header renders the count.',
  explanationMd: null,
  howToTestMd: null,
  subjectVersion: 'moooon/acme-web#34@bbb222',
  pullRequests: [
    {
      repository: 'moooon/acme-web',
      number: 34,
      headSha: 'bbb222',
      baseBranch: 'main',
      headBranch: 'subtask/ACME-7-web',
      title: 'The header count',
      url: 'https://github.com/moooon/acme-web/pull/34',
    },
  ],
};

const hostedPassage = hostedVerdictPassage(assembleReviewPrompt(RUN_TARGET).prompt);

describe('the hosted reviewer and the motir-review skill state ONE verdict rule', () => {
  let skillPassage: string;

  beforeAll(async () => {
    skillPassage = skillVerdictPassage(await readSkill());
  }, 60_000);

  it('the two texts parse to the same rule', () => {
    const hosted = parseVerdictRule(hostedPassage);
    const skill = parseVerdictRule(skillPassage);
    expect(
      skill,
      'The verdict rule in lib/dispatch/reviewPromptTemplate.ts (YOUR VERDICT) and in ' +
        `${SKILL_REPO}:${SKILL_PATH} (§ 6, "The verdict rule") disagree. Change both texts ` +
        'together, so the hosted reviewer and a person’s own review agent answer the same ' +
        'question.',
    ).toEqual(hosted);
  });

  it('each text states a whole rule: something sends the card back, and the card passes otherwise', () => {
    for (const passage of [hostedPassage, skillPassage]) {
      const rule = parseVerdictRule(passage);
      expect(rule.sendsBack).toContain('not_met');
      expect(rule.passesOtherwise).toBe(true);
      // A term cannot both send the card back and never send it back.
      expect(rule.sendsBack.filter((term) => rule.neverSendsBack.includes(term))).toEqual([]);
    }
  });

  it('the verdict words each text uses are the ones its door accepts', () => {
    expect(Object.keys(DOOR_TO_GATE_VERDICT).sort()).toEqual([...REVIEW_DOOR_VERDICTS].sort());
    expect([...new Set(Object.values(DOOR_TO_GATE_VERDICT))].sort()).toEqual(
      [...REVIEW_VERDICTS].sort(),
    );
    const words = (passage: string) =>
      [...passage.matchAll(/`(pass|approved|changes_requested)`/g)].map((m) => m[1]);
    expect(
      words(hostedPassage).every((w) => (REVIEW_VERDICTS as readonly string[]).includes(w!)),
    ).toBe(true);
    expect(
      words(skillPassage).every((w) => (REVIEW_DOOR_VERDICTS as readonly string[]).includes(w!)),
    ).toBe(true);
  });

  // FAIL FOR THE RIGHT REASON: each change is one a person could make to the skill alone,
  // and each must move its rule away from the hosted one.
  it.each([
    ['major findings stop sending the card back', 'no blocker or major', 'no blocker'],
    [
      'cannot-tell rows start sending it back',
      '`cannot_tell` rows alone never send',
      '`cannot_tell` rows send',
    ],
    [
      'nits drop out of the never clause',
      'minor findings and nits never do',
      'minor findings never do',
    ],
    ['the passing verdict loses its "only when"', '`approved` only when', '`approved` when'],
  ])('a skill-only change is caught: %s', (_name, from, to) => {
    const flat = skillPassage.replace(/\*\*/g, '').replace(/\s+/g, ' ');
    expect(flat).toContain(from);
    expect(ruleOrUnreadable(flat.replace(from, to))).not.toEqual(parseVerdictRule(hostedPassage));
  });
});

describe('parseVerdictRule — a hosted-only change is caught', () => {
  const flat = hostedPassage.replace(/\s+/g, ' ');

  it.each([
    ['major findings stop sending the card back', 'blocker or major', 'blocker'],
    [
      'cannot-tell rows start sending it back',
      'A `cannot tell` row alone does not send the card back',
      'A `cannot tell` row sends the card back',
    ],
    ['nits drop out of the never clause', 'Minor findings and nits never', 'Minor findings never'],
    ['the pass default is dropped', '`pass` — otherwise.', 'Then stop.'],
  ])('%s', (_name, from, to) => {
    expect(flat).toContain(from);
    expect(ruleOrUnreadable(flat.replace(from, to))).not.toEqual(parseVerdictRule(hostedPassage));
  });

  it('a passage with no send-back clause is refused, never read as an empty rule', () => {
    expect(() => parseVerdictRule('Submit one verdict.')).toThrow(/no send-back clause/);
  });

  it('a text that lost its verdict passage is refused by name', () => {
    expect(() => hostedVerdictPassage('no verdict here')).toThrow(/verdict bullets/);
    expect(() => skillVerdictPassage('# motir-review\n')).toThrow(/The verdict rule/);
  });
});
