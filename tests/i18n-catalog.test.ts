import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { locales, type Locale } from '@/lib/i18n/locales';
import { PLATFORM_AUDIT_ACTION_KEYS, isPlatformAuditWrite } from '@/lib/platform/auditActions';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';

// Collect EVERY key path that appears more than once at the same object level in
// the RAW catalog text. `import … from '*.json'` (and `JSON.parse`) silently keep
// only the LAST of duplicate keys, so a second `"aiPlanning": { … }` block
// shadows the first with NO parse error and NO key-set drift — invisible to the
// parity check below. That is exactly what shipped a broken plan-review surface
// (MOTIR-847 added a duplicate top-level `aiPlanning`, shadowing all its keys, so
// every <PlanItemNode> rendered raw i18n keys; MOTIR-1373). Parse the text with a
// reviver-free duplicate detector so the shadow surfaces as a unit failure.
function duplicateKeyPaths(jsonText: string): string[] {
  const dups: string[] = [];
  const stack: { path: string; seen: Set<string> }[] = [{ path: '', seen: new Set() }];
  // A minimal JSON tokenizer: we only need to know, at each `"key":` that is
  // immediately followed by a value in an OBJECT, whether the key repeats at the
  // current nesting level. Track container starts/ends and string keys.
  let i = 0;
  const n = jsonText.length;
  const isObjectStack: boolean[] = [];
  while (i < n) {
    const ch = jsonText[i];
    if (ch === '"') {
      // read a string token
      let j = i + 1;
      let str = '';
      while (j < n) {
        const c = jsonText[j];
        if (c === '\\') {
          str += jsonText[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') break;
        str += c;
        j += 1;
      }
      // is this string a KEY? (next non-space char is ':' and we're in an object)
      let k = j + 1;
      while (k < n && /\s/.test(jsonText[k]!)) k += 1;
      const inObject = isObjectStack[isObjectStack.length - 1];
      if (jsonText[k] === ':' && inObject) {
        const top = stack[stack.length - 1]!;
        const full = top.path ? `${top.path}.${str}` : str;
        if (top.seen.has(str)) dups.push(full);
        else top.seen.add(str);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      isObjectStack.push(true);
      const top = stack[stack.length - 1]!;
      // the path of this new object is whatever key most recently preceded it;
      // approximate via the last seen key at the parent level (good enough for
      // reporting — correctness of detection does not depend on it).
      stack.push({ path: top.path, seen: new Set() });
    } else if (ch === '[') {
      isObjectStack.push(false);
    } else if (ch === '}') {
      isObjectStack.pop();
      stack.pop();
    } else if (ch === ']') {
      isObjectStack.pop();
    }
    i += 1;
  }
  return dups;
}

// Guards the message catalogs against drift: every locale must define EXACTLY
// the same set of (nested) keys as the base `en` catalog — no missing keys (a
// missing-message runtime error in the other locale) and no orphan keys (dead
// translations). next-intl throws on a missing key in dev, so a parity gap would
// surface as a render crash for `zh` users; this turns it into a fast unit
// failure at the catalog level instead.

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

// Like `flatten`, but returns [keyPath, stringValue] pairs so a test can assert
// on the actual rendered copy (not just the key set).
function flattenEntries(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flattenEntries(value as Record<string, unknown>, path);
    }
    return typeof value === 'string' ? [[path, value]] : [];
  });
}

// Every catalogue, read off `locales` rather than imported one by one, so a
// twelfth locale is held by every gate below the moment it is declared
// (Story MOTIR-7730 · MOTIR-7757 widened them from `en` / `zh` to all eleven).
const MESSAGES_DIR = new URL('../messages/', import.meta.url);

function readCatalogue(locale: string): string {
  return readFileSync(new URL(`${locale}.json`, MESSAGES_DIR), 'utf8');
}

const catalogues = Object.fromEntries(
  locales.map((locale) => [locale, JSON.parse(readCatalogue(locale)) as Record<string, unknown>]),
) as Record<Locale, Record<string, unknown>>;

const translatedLocales = locales.filter((locale) => locale !== 'en');

describe('message catalogs', () => {
  const enKeys = flatten(en).sort();

  it('ships a catalog per declared locale, and declares every catalog', () => {
    // Top-level files only — `messages/glossary/` and `messages/sources/` hold
    // the translation record, not catalogues.
    const files = readdirSync(MESSAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort();
    expect(files).toEqual([...locales].sort());
  });

  it.each(translatedLocales)(
    '%s has the exact same key set as en (no missing, no orphan keys)',
    (locale) => {
      const keys = flatten(catalogues[locale]).sort();
      const keySet = new Set(keys);
      const enSet = new Set(enKeys);
      const missing = enKeys.filter((k) => !keySet.has(k));
      const orphan = keys.filter((k) => !enSet.has(k));
      expect(missing, `keys missing from ${locale}.json: ${missing.join(', ')}`).toEqual([]);
      expect(orphan, `orphan keys in ${locale}.json: ${orphan.join(', ')}`).toEqual([]);
    },
  );

  // The parity check above parses the JSON, so duplicate keys are already
  // collapsed (last wins) and invisible to it. Detect them on the RAW text so a
  // shadowing duplicate (the MOTIR-1373 cause) fails loudly instead of silently
  // dropping a whole namespace.
  it.each(locales)('%s.json has no duplicate keys at any level', (locale) => {
    const raw = readCatalogue(locale);
    const dups = duplicateKeyPaths(raw);
    expect(dups, `duplicate keys in ${locale}.json: ${dups.join(', ')}`).toEqual([]);
  });
});

// Regression guard for `bug-zh-dashboards-reports-stale-glossary`: the locked zh
// PM glossary BANS `仪表板` for "dashboard" (must be `工作台`) and `问题` for the
// tracked-unit noun "work item" (must be `工作项`). Both had leaked into the
// dashboards/reports copy. Note: `问题` is ALSO legitimate Chinese for "problem"
// in the `出了点问题` / `出现问题` error idioms — those are NOT work items and must
// stay, so the `问题` check is scoped to the `dashboards` namespace, where every
// occurrence denoted a tracked unit (no error idioms live there).
describe('zh glossary (locked terms)', () => {
  const zhEntries = flattenEntries(zh as Record<string, unknown>);

  it('never renders the banned `仪表板`; "dashboard" is always `工作台`', () => {
    const leaks = zhEntries.filter(([, value]) => value.includes('仪表板'));
    expect(
      leaks.map(([path]) => path),
      `banned 仪表板 (use 工作台) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
    // positive anchor: the dashboards landing title is the native term
    expect((zh as { dashboards: { title: string } }).dashboards.title).toBe('工作台');
  });

  it('never uses `问题` for the work-item noun in the dashboards namespace (use `工作项`)', () => {
    const leaks = zhEntries.filter(
      ([path, value]) => path.startsWith('dashboards.') && value.includes('问题'),
    );
    expect(
      leaks.map(([path]) => path),
      `banned work-item 问题 (use 工作项) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
  });
});

// The product's noun for the thing a person plans and an agent works is a WORK
// ITEM. "card" is authoring-voice shorthand for it and had leaked into fifteen
// shipped `en` values and thirteen `zh` twins (MOTIR-3949) — so a reader met two
// nouns for one object with nothing on screen saying they are the same thing.
//
// The word does THREE jobs here and only one of them is the defect, so this is a
// keyed ALLOWLIST rather than a ban: a UI PANEL (a dashboard tile, the `Card`
// primitive) and a PAYMENT CARD are both correct and must survive. The predicate
// is the standalone WORD — `\bcards?\b` — which is what makes it cheap: it
// already excludes every `discard` / `Discarded` / `discardCta` value (19 of
// them in `en`) without an entry, because `discard` offers no left word
// boundary. A new value using "card" for a work item therefore fails here, and a
// new value about billing or a tile fails ONCE, with the fix being one reviewed
// line naming which of the two senses it is.
const CARD_SENSE_ALLOWLIST: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    'orgAdmin.seat.addSub': 'payment card — Stripe bills the seat to the card on file',
    'orgAdmin.seat.pastDueNote': 'payment card — the seat-plan charge failed',
    'billing.pastDue.banner': 'payment card — the AI-plan charge failed',
    'onboarding.landing.heroHint': 'payment card — "no credit card"',
    'billing.plans.upgrade.footnote': 'payment card — the upgrade charges the card on file',
    'billing.plans.upgrade.refusedPayment': 'payment card — the upgrade charge was declined',
    'platformAdmin.monitoring.subtitle': 'UI panel — the six monitoring tiles, each linking out',
    'platformAdmin.tenant.fleet.confirm.reasonHint':
      'UI panel — the tenant page’s Fleet card, which shows the last stop’s reason',
    'platformAdmin.tenant.fleet.error.failedBody':
      'UI panel — the tenant page’s Fleet card, whose counts were re-read',
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
  },
  zh: {
    'platformAdmin.monitoring.subtitle':
      'UI panel — 每张卡片 is a monitoring tile, not a work item',
    'platformAdmin.tenant.fleet.confirm.reasonHint':
      'UI panel — 此卡片 is the tenant page’s Fleet card, not a work item',
    'platformAdmin.tenant.fleet.error.failedBody':
      'UI panel — 此卡片 is the tenant page’s Fleet card, not a work item',
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
  },
};

describe('product noun (a work item is never called a "card")', () => {
  it.each(['en', 'zh'] as const)(
    '%s.json uses "card" only for a panel or a payment card',
    (locale) => {
      const entries = flattenEntries((locale === 'en' ? en : zh) as Record<string, unknown>);
      const allow = CARD_SENSE_ALLOWLIST[locale];
      const leaks = entries.filter(
        ([path, value]) =>
          (/\bcards?\b/i.test(value) || value.includes('卡片')) && !(path in allow),
      );
      expect(
        leaks.map(([path]) => path),
        `"card" is not the product noun — say work item / item (zh: 工作项) at: ` +
          `${leaks.map(([p]) => p).join(', ')}. If a hit is a UI panel or a payment ` +
          `card, add it to CARD_SENSE_ALLOWLIST.${locale} with the sense.`,
      ).toEqual([]);
    },
  );

  it.each(['en', 'zh'] as const)('%s allowlist has no stale entry', (locale) => {
    const entries = new Map(flattenEntries((locale === 'en' ? en : zh) as Record<string, unknown>));
    const stale = Object.keys(CARD_SENSE_ALLOWLIST[locale]).filter((path) => {
      const value = entries.get(path);
      return value === undefined || !(/\bcards?\b/i.test(value) || value.includes('卡片'));
    });
    expect(
      stale,
      `allowlisted keys that no longer say "card": ${stale.join(', ')} — drop them`,
    ).toEqual([]);
  });
});

// A key whose NAME contains a `.` is not a naming preference — it is an
// UNRESOLVABLE key. next-intl reserves `.` for nesting, so it walks
// `platformAdmin.users.log.action.user.suspend` as six segments and never finds
// the five-segment literal the catalog actually holds; it also refuses such keys
// outright at provider construction (`INVALID_KEY`). The parity check above is
// structurally blind to this: `flatten` joins segments with `.`, so a literal
// `"user.suspend"` and a nested `user: { suspend }` flatten to the SAME path —
// both locales carried the same broken key, parity held, and the surface
// rendered raw key paths (MOTIR-3686, shipped by MOTIR-1167).
describe('catalog keys are resolvable (no `.` inside a key name)', () => {
  it.each(locales)('%s.json has no key containing a `.`', (locale) => {
    const messages = catalogues[locale];
    const dotted: string[] = [];
    const walk = (node: Record<string, unknown>, path: string[]) => {
      for (const [key, value] of Object.entries(node)) {
        if (key.includes('.')) dotted.push([...path, key].join(' → '));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, [...path, key]);
        }
      }
    };
    walk(messages, []);
    expect(
      dotted,
      `keys containing "." in ${locale}.json (next-intl reads "." as nesting, so these never resolve): ${dotted.join(', ')}`,
    ).toEqual([]);
  });
});

// The specific consequence the rule above prevents, asserted at the call site
// that suffers it. `/admin/users/[userId]` renders each audit row as
// `t(`users.log.action.${row.action}`)`, and `platformSupportService` filters
// that log to the OPERATOR WRITES — `isPlatformAuditWrite(action)` (the explicit
// `kind`, since MOTIR-749). So the population that must carry a label is exactly the WRITE members of
// `PLATFORM_AUDIT_ACTIONS`, and it GROWS: Story 10.3's governance actions each
// add one. Deriving the expected set from the vocabulary rather than listing it
// here is what makes a fourth support action unable to ship unlabelled.
describe('platform support-action labels resolve for every operator write', () => {
  const operatorWrites = PLATFORM_AUDIT_ACTION_KEYS.filter((action) =>
    isPlatformAuditWrite(action),
  );

  it('has at least one operator write to check (the derivation is not vacuous)', () => {
    expect(operatorWrites.length).toBeGreaterThan(0);
  });

  it.each(locales)('%s labels every operator write in the support log', (locale) => {
    const messages = catalogues[locale];
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: messages as Parameters<typeof createTranslator>[0]['messages'],
      namespace: 'platformAdmin',
      onError: (error) => errors.push(`${error.code}: ${error.message}`),
      getMessageFallback: ({ key }) => `MISSING:${key}`,
    });

    // The two locale JSONs have different inferred types, so `messages` is
    // widened to a plain record above and next-intl can no longer type the key.
    // The lookup itself is byte-for-byte the page's: `users.log.action.` + the
    // raw action value, dots and all.
    const translate = t as unknown as (key: string) => string;
    const unresolved = operatorWrites.filter((action) =>
      translate(`users.log.action.${action}`).startsWith('MISSING:'),
    );

    expect(
      unresolved,
      `${locale}.json has no resolvable label for: ${unresolved.join(', ')} (add it under platformAdmin.users.log.action, nested so the lookup path matches)`,
    ).toEqual([]);
    expect(errors, `next-intl rejected the catalog: ${errors.join(' | ')}`).toEqual([]);
  });
});

// ── Work-item TYPE labels are a closed, single-word vocabulary (MOTIR-4249) ───
//
// The fifteen type labels are single words BY CONSTRUCTION (the grammar frozen
// in docs/decisions/work-item-type-taxonomy.md §1b), and that is exactly what
// makes them collide: `Legal`, `Copy`, `Manual`, `Design`, `Review`, `Content`
// are also ordinary UI nouns and verbs. The shipped defect was `shell.nav.legal`
// = "Legal" — the terms/privacy DOCUMENTS — sitting in the rail while
// `labels.workItemType.legal` = "Legal" named a kind of WORK. The `zh` catalog
// had already resolved the ambiguity (`法务` for the work, `法律条款` for the
// documents); English never had that forcing function and carried one word for
// both. MOTIR-4237 moved the rail row into the Help menu as `shell.help.legal` =
// "Legal documents" / `法律文件`, so the pair is gone. These guards keep it gone.
//
// TWO tiers, because the two populations are not the same risk:
//
//  A. THE SHELL IS A HARD BAN, no allowlist. The shell is the app CHROME — nav
//     rows, menus, breadcrumbs — the one place a label renders with NOTHING
//     around it to fix its sense. A rail row reading "Legal" among Boards /
//     Reports / Settings reads as a DESTINATION, which is the whole defect. An
//     allowlist here would be a way to re-ship it with a note attached.
//  B. EVERYWHERE ELSE IS A RATCHET with a written disposition per key. A type
//     label reused inside a `FieldCard label={…}`, or as a button verb on a
//     surface that renders no type chip at all, is disambiguated by its frame.
//     Eight `en` keys and six `zh` keys ship that way today; each carries its
//     reason below, and a ninth fails here until someone writes one.
//
// The label set is derived from `WORK_ITEM_TYPES` rather than listed, so a
// fifteenth enum member is covered the moment its label lands — and a type whose
// label goes MISSING fails the vacuity check instead of silently shrinking the
// population this guards.
const TYPE_LABEL_COLLISION_ALLOWLIST: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    // The clipboard VERB. A different part of speech from the `copy` type
    // (copywriting work, `文案` in zh — which is why zh never collides here), on
    // four surfaces that render no work-item type chip.
    'apiDocs.codeCopy': 'clipboard verb — copies a code sample on the API docs page',
    'codeHealth.deepen.copy': 'clipboard verb — copies the deepen audit prompt',
    'github.development.howToTest.code.copy':
      'clipboard verb — copies a How to test command block (MOTIR-5336)',
    'publicProjects.copyFeed': 'clipboard verb — copies the public feed URL',
    'settings.apiTokens.created.copy': 'clipboard verb — copies the new API token',
    'settings.workspaceAddress.review':
      'button verb — opens the dated confirm for a workspace rename (MOTIR-9514)',
    'settings.public.copy': 'clipboard verb — copies the public project URL',
    'settings.production.address.copy': 'clipboard verb — copies the production address',
    // Named inside an explicit frame on a surface with no type chip.
    'codeHealth.convention.defaultRepo':
      'repo fallback name on Code health — the card header where a repoKey would sit',
    'onboarding.generation.designLabel':
      'field label "Design: <summary>" in the onboarding baseline card — pre-generation, no tree yet',
    // The ONE key that shares a surface with the type chip, and the reason it is
    // still not the `shell.nav.legal` shape: BOTH chips render inside the same
    // `FieldCard label={…}` primitive on the item detail rail — "Type: Manual"
    // (CoreFieldsPanel.tsx) versus "Planning: Manual" (ProvenanceSection.tsx) —
    // and the provenance chip's sibling values (Native · MCP · API · Hosted ·
    // BYOK) all name an ORIGIN, which fixes the sense the way the type set's own
    // siblings fix the other one. The nav row had no such frame. Weakest member
    // of this list: `zh` does NOT disambiguate it (`手动` both), so if a reader
    // is ever seen to trip on it the remedy is a design-owned relabel of the
    // provenance chip (design/work-items/provenance.mock.html draws it), not a
    // change to the closed type-label set.
    // The disclosure VERB on the Approvals tab's row — a different part of
    // speech from the `review` TYPE (review WORK), exactly as the clipboard
    // `copy` entries above are from the `copy` type. The row it sits in renders
    // no work-item type chip at all: its cells are the GATE kind, the card's
    // identifier and title, and how long it has waited. The sibling
    // `kind.decision_approval` was NOT allowlisted — it is RENAMED to "Decision
    // approval", which matches its own siblings (`Pull-request approval`,
    // `Pull-request merge`) and needs no note to be unambiguous.
    'workbench.approvals.review':
      'disclosure verb on the Approvals row — opens the approval frame; the row renders no type chip',
    // The same verb on a To resume gate line (MOTIR-7712; design § 35.4) — the viewer's
    // own decision door, a primary button beside the gate's KIND chip and its state pill.
    'workbench.toResume.review':
      'disclosure verb on a To resume gate line — opens the approval overlay; the line names the gate kind, not a type',
    'issueViews.provenanceSourceManual':
      'provenance ORIGIN chip on the item detail rail — framed by FieldCard label "Planning"/"Implementation"',
    // The machine-translation VERB (Story MOTIR-7735 · MOTIR-8122; design MOTIR-8112) —
    // a different part of speech from the `translate` TYPE (localisation WORK), as
    // the clipboard `copy` entries are from `copy`. It is the one button in the
    // bar labelled "Translation" under the title, with "into {language}" beside it.
    'itemTranslation.translate':
      'button verb in the item translation bar — "Translate" + "into {language}" beside it',

    // The approval frame's BAND-1 KIND for a decision gate (MOTIR-5678; design
    // `design/github` §27). The same sense as the type — it names the DECISION card's
    // own question — and it sits in the frame's kind slot beside *Design result* and
    // *Pull requests*, which fixes it as a gate kind rather than a type chip.
    'approvalGate.decision.kindLabel':
      "band-1 gate KIND in the approval frame — the decision card's own question (§27)",
    // THE CHOICE GATE (Story MOTIR-4914 · MOTIR-5891/5896). The gate kind and the type
    // share a word ON PURPOSE: a `decision_choice` gate is only ever raised on a
    // `type: choice` card, so the gate IS the card's own question — the decision
    // kind's precedent above, one member over. Each sits in a gate-kind slot.
    'approvalGate.choice.kindLabel':
      "band-1 gate KIND in the approval frame — the choice card's own question",
    'workbench.approvals.kind.decision_choice':
      "Approvals row / overlay KIND for the choice gate — the choice card's own question",
    'approvalGate.statusHeld.decisionNoun.decision_choice':
      "the held-status sentence's decision NOUN — names the choice card's own question",
    // MOTIR-5954: a `decision_confirmation` gate is only ever raised on a `type: decision`
    // card, so *decision* IS the card's own type — the same disposition as the choice's.
    'approvalGate.statusHeld.decisionNoun.decision_confirmation':
      "the held-status sentence's decision NOUN — names the decision card's own question",
    // MOTIR-5960: the confirm port's section title and its first eyebrow sit ON a
    // `type: decision` card and name that card's own content (design § THE CONFIRM PORT).
    'approvalGate.decisionConfirm.sectionTitle':
      "item-page section title — the decision card's own decision",
    'approvalGate.decisionConfirm.eyebrow.decision':
      "the port's first eyebrow — the decision card's own `## Decision` section",
  },
  zh: {
    // `验证` is the verification TYPE noun and also the ordinary button verb; en
    // splits these (Verify / Validate) and zh does not. All three are buttons on
    // surfaces that render no type chip.
    'auth.twoFactor.verify': 'button verb — submits the 2FA code',
    'settings.publicAddress.domains.addModal.verify': 'button verb — checks the domain DNS record',
    'roadmap.canvas.origin.validate': 'button verb — validates the canvas origin',
    // `翻译` is the `translate` TYPE noun and also the machine-translation verb and
    // its group's name (MOTIR-8122): the bar under the item title, read as one
    // control beside "译为{language}".
    'itemTranslation.translate':
      'button verb in the item translation bar — translates this item, beside its target language',
    'itemTranslation.groupLabel':
      'the translation bar’s accessible group name — names the control, not a work item type',
    // The en twins above, same reasons.
    'codeHealth.convention.defaultRepo': 'repo fallback name on Code health',
    'onboarding.generation.designLabel': 'field label in the onboarding baseline card',
    'issueViews.provenanceSourceManual': 'provenance ORIGIN chip, framed by its FieldCard label',

    'approvalGate.decision.kindLabel': 'band-1 gate KIND in the approval frame (§27)',
    'approvalGate.choice.kindLabel': 'band-1 gate KIND — the choice card’s own question',
    'workbench.approvals.kind.decision_choice': 'Approvals row / overlay KIND for the choice gate',
    'approvalGate.statusHeld.decisionNoun.decision_choice': 'held-status decision NOUN',
    'approvalGate.statusHeld.decisionNoun.decision_confirmation': 'held-status decision NOUN',
    'approvalGate.decisionConfirm.sectionTitle':
      'item-page section title — the card’s own decision',
    'approvalGate.decisionConfirm.eyebrow.decision':
      'the port’s first eyebrow — the card’s own section',
    // zh `选择` is both the type noun and the verb *choose*; this is band 3's commit
    // verb before an option is picked, on the frame whose band 1 already names the kind.
    'approvalGate.choice.verb.chooseEmpty': 'band-3 VERB *choose*, before an option is picked',
  },
};

const TYPE_LABEL_NAMESPACE = 'labels.workItemType.';

describe('work-item type labels do not silently name something else', () => {
  const catalogs = catalogues;

  function typeLabels(locale: Locale): Map<string, string> {
    const entries = new Map(flattenEntries(catalogs[locale]));
    return new Map(
      WORK_ITEM_TYPES.map((type) => [type, entries.get(`${TYPE_LABEL_NAMESPACE}${type}`)!]),
    );
  }

  it.each(locales)('%s labels all fifteen types (the derivation is real)', (locale) => {
    const labels = typeLabels(locale);
    const unlabelled = [...labels].filter(([, value]) => !value).map(([type]) => type);
    expect(
      unlabelled,
      `${locale}.json has no ${TYPE_LABEL_NAMESPACE}* label for: ${unlabelled.join(', ')}`,
    ).toEqual([]);
    expect(labels.size).toBe(WORK_ITEM_TYPES.length);
  });

  // A. THE HARD BAN. No allowlist, deliberately — see the header above. It needs
  // no judgement, so it holds every catalogue (MOTIR-7757); tier B below stays
  // `en` / `zh` by decision — each of its entries is a reader's written judgement
  // that a frame disambiguates a word, and only a reader of the language can
  // make it.
  it.each(locales)('%s: no shell.* label reuses a type label', (locale) => {
    const labels = new Set([...typeLabels(locale).values()].map((v) => v.trim().toLowerCase()));
    const leaks = flattenEntries(catalogs[locale]).filter(
      ([path, value]) => path.startsWith('shell.') && labels.has(value.trim().toLowerCase()),
    );
    expect(
      leaks.map(([path, value]) => `${path} = ${value}`),
      `a shell (chrome) label renders a bare work-item TYPE label, which is the ` +
        `MOTIR-4249 defect — the rail teaches one sense and the chip means another. ` +
        `Give the shell row a two-word label (e.g. "Legal documents"): `,
    ).toEqual([]);
  });

  // B. THE RATCHET. Everywhere else, with a written disposition per key.
  it.each(['en', 'zh'] as const)('%s: every other reuse carries a disposition', (locale) => {
    const labels = new Map(
      [...typeLabels(locale)].map(([type, value]) => [value.trim().toLowerCase(), type]),
    );
    const allow = TYPE_LABEL_COLLISION_ALLOWLIST[locale];
    const leaks = flattenEntries(catalogs[locale]).filter(
      ([path, value]) =>
        !path.startsWith(TYPE_LABEL_NAMESPACE) &&
        labels.has(value.trim().toLowerCase()) &&
        !(path in allow),
    );
    expect(
      leaks.map(([path, value]) => `${path} = ${value}`),
      `these keys render a bare work-item TYPE label for something else. If the ` +
        `sense is fixed by the surrounding frame (a FieldCard label, a button on a ` +
        `surface with no type chip), add the key to ` +
        `TYPE_LABEL_COLLISION_ALLOWLIST.${locale} WITH the reason; otherwise rename it: `,
    ).toEqual([]);
  });

  it.each(['en', 'zh'] as const)('%s allowlist has no stale entry', (locale) => {
    const entries = new Map(flattenEntries(catalogs[locale]));
    const labels = new Set([...typeLabels(locale).values()].map((v) => v.trim().toLowerCase()));
    const stale = Object.keys(TYPE_LABEL_COLLISION_ALLOWLIST[locale]).filter((path) => {
      const value = entries.get(path);
      return value === undefined || !labels.has(value.trim().toLowerCase());
    });
    expect(
      stale,
      `allowlisted keys that no longer collide with a type label: ${stale.join(', ')} — drop them`,
    ).toEqual([]);
  });

  // The specific pair the card is about, asserted by value rather than by the
  // rules above, so a reader meeting this file sees what was actually wrong.
  it('`Legal` names the work TYPE and nothing else in en', () => {
    const legal = flattenEntries(en).filter(([, value]) => value.trim() === 'Legal');
    expect(legal.map(([path]) => path)).toEqual([`${TYPE_LABEL_NAMESPACE}legal`]);
  });

  it('zh keeps the split English had to be given: 法务 (the work) vs 法律文件 (the documents)', () => {
    const zhEntries = new Map(flattenEntries(zh as Record<string, unknown>));
    expect(zhEntries.get(`${TYPE_LABEL_NAMESPACE}legal`)).toBe('法务');
    expect(zhEntries.get('shell.help.legal')).toBe('法律文件');
    expect(zhEntries.get(`${TYPE_LABEL_NAMESPACE}legal`)).not.toBe(
      zhEntries.get('shell.help.legal'),
    );
  });
});

// ── The glossary's banned words are a HARD gate (Story MOTIR-7730 · MOTIR-7757) ──
//
// `messages/glossary/<l>.json` records, per term, the words that language must
// NOT use for it — for "work item", that language's words for "issue" and
// "card". The catalogue script (`scripts/i18n/`) reported them as merge-time
// warnings; this gate makes a hit fail. A hit that is legitimately another sense
// — a PAYMENT card, a UI PANEL (the glossary's `allowedSenses`) — is listed in
// `BANNED_WORD_ALLOWLIST` with that sense, and the list is asserted tight.
//
// Matching is case-insensitive. Latin-script locales match the WORD (Unicode
// letter/number boundaries, so `Karte` does not hit `Kartei`); `zh` / `ja` / `ko`
// have no word spaces and match a substring.
interface GlossaryTerm {
  translation: string;
  banned?: string[];
}

function glossaryBans(locale: Locale): { term: string; word: string }[] {
  const file = new URL(`glossary/${locale}.json`, MESSAGES_DIR);
  if (!existsSync(file)) return [];
  const { terms } = JSON.parse(readFileSync(file, 'utf8')) as {
    terms: Record<string, GlossaryTerm>;
  };
  return Object.entries(terms).flatMap(([term, entry]) =>
    (entry.banned ?? []).map((word) => ({ term, word })),
  );
}

const UNSPACED_SCRIPTS: readonly Locale[] = ['zh', 'ja', 'ko'];

function containsBannedWord(locale: Locale, value: string, word: string): boolean {
  if (UNSPACED_SCRIPTS.includes(locale)) return value.toLowerCase().includes(word.toLowerCase());
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(value);
}

// Every entry is a hit in another SENSE, dispositioned when the gate turned on
// (MOTIR-7757): a payment card, a UI panel, a browser tab, a notification,
// French `demande` (a request, market demand), and in `zh` the ordinary
// `问题` (a problem — and the imported tracker's or Sentry's own "issue").
const BANNED_WORD_ALLOWLIST: Partial<Record<Locale, Record<string, string>>> = {
  zh: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'device.errors.unexpected': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planReview.actionError': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'errors.serverError.pageBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'errors.serverError.appBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'email.automationRuleFailed.autoDisabled':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'auth.somethingWentWrong': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'auth.twoFactor.errors.generic': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'shell.aiCallout.actions.ask.description':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'comments.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'activity.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'attachments.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.members.errorUnexpected': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.workflow.toast.genericError':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.board.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.customFields.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.components.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.access.errorGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.codeAccess.failedBanner': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.account.data.export.failed.headline':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.account.twoFactor.errors.generic':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.profile.email.modal.errors.generic':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.connectedApps.revokeError.body':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.apiTokens.createModal.errorGeneric':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.apiTokens.revokeConfirm.errorGeneric':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.gitAccounts.noInstallation.body':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'settings.bugs.pageDescription': "a Sentry issue — the monitor's own noun",
    'boards.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.sprintsErrorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.startSprintFlow.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.deleteSprintFlow.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.renameSprintFlow.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.editSprintDatesFlow.errorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'backlog.createSprintErrorDescription':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'savedFilters.edit.errorGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'savedFilters.changeOwnerDialog.errorGeneric':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'savedFilters.deleteDialog.errorGeneric':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'savedFilters.save.errorGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'notifications.error.body': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'orgAdmin.transfer.errorGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'orgAdmin.states.errorDescription': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'orgAdmin.delete.errorGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'orgAdmin.cancel.error': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'triage.toast.error': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'triage.widget.heading': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'publicProjects.submitErrorBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'publicProjects.faqTitle': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'publicProjects.editErrGeneric': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'workItemActions.archiveErrorBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'aiUsage.summary.searchUnavailable': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'billing.ci.pausedBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'billing.agents.unavailable': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'billing.search.unavailable': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'onboarding.chat.composerPlaceholder':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'github.development.fix.rearm': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.refusalSeed.askAcceptanceRemedy':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.conversation.composerPlaceholderReplan':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.conversation.correctToAsk':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.conversation.debug.ungrounded':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.handoff.stepDiscovery':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'planningWorkspace.routing.refusalMessage':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'codeHealth.errorLoadMore': 'a code-health finding (a problem in the code), not a work item',
    'codeHealth.audit.findingsTotal':
      'a code-health finding (a problem in the code), not a work item',
    'codeHealth.audit.findingsCount':
      'a code-health finding (a problem in the code), not a work item',
    'codeHealth.audit.noFindings': 'a code-health finding (a problem in the code), not a work item',
    'codeHealth.audit.loadMore': 'a code-health finding (a problem in the code), not a work item',
    'import.connect.body': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.connect.scopeAll':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.connect.csv.dropzoneHint':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.connect.csv.idColumnLabel':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.connect.reachable':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.connect.reachableUnknown':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.map.rowType': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.map.unresolved': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.preview.empty': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.preview.emptyBody':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.preview.rerunTitle':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.preview.confirm':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.run.importing': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.run.completeTitle':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.run.partialTitle':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.run.partialBody':
      "an issue in the SOURCE tracker being imported — that tool's own noun",
    'import.errors.generic': "an issue in the SOURCE tracker being imported — that tool's own noun",
    'onboardingMigrate.rail.discoveryStep':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    // MOTIR-8254: the "A few questions" step the rail names — a question asked.
    'onboardingMigrate.questions.heading': 'a question asked — 几个问题, not a work item',
    'onboardingMigrate.questions.body': 'a question asked — 几个问题, not a work item',
    'onboardingMigrate.questions.progress': 'a question asked — 第 n 个问题, not a work item',
    'designResult.frameFailedBody': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'workbench.approvals.subjectGone.manual_work':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.users.action.error.FAILED':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.monitoring.subtitle': 'UI panel — a tile on the page, not a work item',
    'platformAdmin.monitoring.signal.errors.degradedDetail':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.monitoring.signal.errors.linkOut':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.monitoring.indexAllowance.subtitle':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.aiPlanning.confirm.reasonHint':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.lessons.refused.failed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.usage.unavailable.description':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.ops.error.FAILED': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.tenant.fleet.confirm.reasonHint':
      'UI panel — a tile on the page, not a work item',
    'platformAdmin.tenant.fleet.error.failedBody': 'UI panel — a tile on the page, not a work item',
    'platformAdmin.modelLists.error.failed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'platformAdmin.ideas.refused.failed': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'workItemTodos.errors.generic': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'myAgents.panel.chat.error': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.port': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.republished':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.withdrawn':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.head_moved':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.member_closed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.member_drafted':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.conflict':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.set_changed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.pulled_back':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.ci_failed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.ci_rerunning':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.plan_stale':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.plan_discarded':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.queue_failed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.subject_gone':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.no_longer_manual':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.closed_without_decision':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.not_ready':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.replanned':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.cause.unknown':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.causeByKind.decision_approval.head_moved':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.withdrawn.causeByKind.manual_work.pulled_back':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.refusal.superseded.title':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.refusal.superseded.staleTab':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.port':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portSet':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portMerged':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portClosed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portDrafted':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portConflict':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portConflictNoBase':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.pullRequestApproval.withdrawn.portQueueFailed':
      'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalGate.choice.question': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvalOverlay.withdrawn.conflict': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'approvals.reviewAgent.desc': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'monitoring.description': "a Sentry issue — the monitor's own noun",
    'monitoring.error.body': "a Sentry issue — the monitor's own noun",
    'monitoring.empty.body': "a Sentry issue — the monitor's own noun",
    'monitoring.degraded.consequence': "a Sentry issue — the monitor's own noun",
    'monitoring.section.hint': "a Sentry issue — the monitor's own noun",
    'monitoring.unbound.body': "a Sentry issue — the monitor's own noun",
    'monitoring.row.level.helper': "a Sentry issue — the monitor's own noun",
    'monitoring.row.sync.resolve.label': "a Sentry issue — the monitor's own noun",
    'monitoring.row.sync.resolve.hint': "a Sentry issue — the monitor's own noun",
    'monitoring.row.sync.resolveFailed': "a Sentry issue — the monitor's own noun",
    'monitoring.confirm.one.body': "a Sentry issue — the monitor's own noun",
    'monitoring.banner.connected.body': "a Sentry issue — the monitor's own noun",
    'monitoring.picker.subtitle': "a Sentry issue — the monitor's own noun",
    'oauthConsent.refused.next': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
    'oauthConsent.errors.unexpected': 'problem — 出了问题 / 有问题 / 遇到问题, not a work item',
  },
  ja: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'orgAdmin.seat.addSub': 'payment card — the card on file Stripe charges',
    'orgAdmin.seat.pastDueNote': 'payment card — the card on file Stripe charges',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
    'onboarding.landing.heroHint': 'payment card — the card on file Stripe charges',
  },
  ko: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'orgAdmin.seat.addSub': 'payment card — the card on file Stripe charges',
    'orgAdmin.seat.pastDueNote': 'payment card — the card on file Stripe charges',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
    'onboarding.landing.heroHint': 'payment card — the card on file Stripe charges',
  },
  de: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
  },
  fr: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'orgAdmin.seat.addSub': 'payment card — the card on file Stripe charges',
    'orgAdmin.seat.pastDueNote': 'payment card — the card on file Stripe charges',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
    'onboarding.landing.heroHint': 'payment card — the card on file Stripe charges',
    'onboarding.landing.optional.demandDesc': 'market demand — not a work item',
    'onboarding.chat.proveDemandLabel': 'market demand — not a work item',
    'onboarding.chat.replies.proveDemand': 'market demand — not a work item',
    'onboarding.chat.canvas.stations.validation.subtitle': 'market demand — not a work item',
    'onboarding.chat.validate.body': 'market demand — not a work item',
    'import.connect.connectHint': 'to ask / a request (ordinary verb or noun) — not a work item',
    'repositoryTakeover.reinstallDetail':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'repositoryTakeover.costTransferDetail':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'apiDocs.sandboxLede': 'to ask / a request (ordinary verb or noun) — not a work item',
    'workbench.toResume.next.changes_requested':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'platformAdmin.users.confirm.reasonHint':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'myAgents.profileLine.claude': 'to ask / a request (ordinary verb or noun) — not a work item',
    'myAgents.profileLine.codex': 'to ask / a request (ordinary verb or noun) — not a work item',
    'myAgents.profileLine.kimi': 'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalGate.acceptanceResult.verdict.replan.consequence':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalGate.acceptanceResult.refusal.noRerun':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalGate.choice.consequence.picked':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalGate.reason.required': 'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalOverlay.subjectGone.design_result':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalOverlay.subjectGone.acceptance_result':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalOverlay.subjectGone.pull_request_approval':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalOverlay.subjectGone.plan_approval':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvalOverlay.subjectGone.agent_review':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'approvals.reviewAgent.desc': 'to ask / a request (ordinary verb or noun) — not a work item',
    'approvals.reviewAgent.onWhat': 'to ask / a request (ordinary verb or noun) — not a work item',
    'monitoring.banner.state_error.body':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'visitor.requestedFeatures.featureRequest':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'visitor.requestedFeatures.emptyBody':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'oauthConsent.heading.refused': 'to ask / a request (ordinary verb or noun) — not a work item',
    'oauthConsent.refused.reason.expired':
      'to ask / a request (ordinary verb or noun) — not a work item',
    'oauthConsent.signIn.foot': 'to ask / a request (ordinary verb or noun) — not a work item',
  },
  es: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'orgAdmin.seat.addSub': 'payment card — the card on file Stripe charges',
    'orgAdmin.seat.pastDueNote': 'payment card — the card on file Stripe charges',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
    'onboarding.landing.heroHint': 'payment card — the card on file Stripe charges',
  },
  it: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'settings.workspaceAddress.row.open': 'browser tab — "open in a new tab"',
    'workbench.group.count': 'UI tab — a Workbench tab, "on this tab" (MOTIR-8016)',
    'workbench.group.context': 'UI tab — a Workbench tab, "not on this tab" (MOTIR-8016)',
  },
  nl: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'settings.account.notifications.helper': 'a notification — the notification sense of "melding"',
    'notifications.summary.genericNoKey': 'a notification — the notification sense of "melding"',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
  },
  pt: {
    'pages.editor.toolbar.embedWorkItemLabel':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemTip':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.menu':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.toCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.remove':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'orgAdmin.seat.addSub': 'payment card — the card on file Stripe charges',
    'orgAdmin.seat.pastDueNote': 'payment card — the card on file Stripe charges',
    'billing.pastDue.banner': 'payment card — the card on file Stripe charges',
    'onboarding.landing.heroHint': 'payment card — the card on file Stripe charges',
    'platformAdmin.monitoring.subtitle': 'UI panel — each monitoring tile, not a work item',
  },
  pl: {
    'pages.editor.toolbar.embedWorkItemInCode':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
    'pages.embed.insertCard':
      'UI panel — the embedded work-item card is the block that DISPLAYS the item, not the item itself (MOTIR-9179)',
  },
};

describe('glossary banned words (hard gate)', () => {
  const glossaryLocales = locales.filter((locale) => glossaryBans(locale).length > 0);

  function hits(locale: Locale): { path: string; word: string }[] {
    const bans = glossaryBans(locale);
    return flattenEntries(catalogues[locale]).flatMap(([path, value]) =>
      bans
        .filter(({ word }) => containsBannedWord(locale, value, word))
        .map(({ word }) => ({ path, word })),
    );
  }

  it('reads a glossary with banned words for every translated locale', () => {
    expect(glossaryLocales).toEqual(translatedLocales);
  });

  it.each(glossaryLocales)('%s.json uses no banned glossary word', (locale) => {
    const allow = BANNED_WORD_ALLOWLIST[locale] ?? {};
    const leaks = hits(locale).filter(({ path }) => !(path in allow));
    expect(
      leaks.map(({ path, word }) => `${path} (${word})`),
      `banned glossary words in ${locale}.json — use the glossary's translation ` +
        `(messages/glossary/${locale}.json), or, if the hit is a payment card or a ` +
        `UI panel, list it in BANNED_WORD_ALLOWLIST.${locale} with the sense: `,
    ).toEqual([]);
  });

  it.each(glossaryLocales)('%s allowlist has no stale entry', (locale) => {
    const hitPaths = new Set(hits(locale).map(({ path }) => path));
    const stale = Object.keys(BANNED_WORD_ALLOWLIST[locale] ?? {}).filter(
      (path) => !hitPaths.has(path),
    );
    expect(
      stale,
      `allowlisted keys that no longer hold a banned word: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
