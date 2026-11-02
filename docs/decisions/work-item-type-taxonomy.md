# ADR: The `WorkItemType` taxonomy + the type→executor default map

- **Status:** Accepted (2026-06-12, confirmed with Yue)
- **Story / Subtask:** 2.7 (Work-item type + executor) · Subtask 2.7.2
- **Supersedes / superseded by:** none
- **Consumed by:** 2.7.3 (schema enum + columns + default helper), 2.7.4 (picker UI),
  2.7.5 (seed-loader mapping), 2.7.6 (filter facet) — and downstream Story 7.6
  (the per-type prompt generator) and the Epic-7 AI dispatch layer.

> This is the first ADR in the repo, so it also sets the convention: a decision
> record is a markdown file under `docs/decisions/`, named for the thing it
> fixes, structured **Status → Context → Decision → Consequences**, with the
> load-bearing facts pinned in explicit tables so downstream code has a single
> authoritative source to implement against.

---

## Context

Two pieces of planning metadata — **what KIND of work** a leaf is (`code` vs
`design` vs `decision` …) and **WHO executes it** (a coding agent vs a human) —
already travel with every plan leaf in `scripts/plan-seed/data/` as
`PlanItem.type` / `PlanItem.executor` (see `scripts/plan-seed/types.ts`: `type`
is a free `string`, `executor` is `'coding_agent' | 'human'`). But the
`work_item` table has nowhere structural to land them, so the seed loader
(`scripts/plan-seed/seed.ts`) currently **stringifies them into the description
prose** ("Type: code", "Executor: coding_agent"). Prose is unqueryable,
unfilterable, and unroutable.

Story 2.7 promotes both to first-class `work_item` fields. This ADR freezes the
**set** those fields range over and the **default mapping** between them, so the
schema (2.7.3), the picker UI (2.7.4), the loader (2.7.5), and the filter facet
(2.7.6) all build against one authoritative definition rather than each
re-stating it — and so Story 7.6's per-type prompt generator can be a **total
function** over a closed enum (a `switch` with no `default` hole).

No application behaviour ships in this subtask. The set it freezes is what makes
the rest of the story buildable.

---

## Decision

### 1. The fixed `WorkItemType` enum (ten members)

`type` is a **FIXED enum** — not free text. Fixed so 7.6's per-type prompt
generator is a total function over it and the 2.7.6 filter facet is a closed
set. It is extensible later **only** by an explicit enum addition + migration,
never by ad-hoc strings.

| Member     | One-line scope (the authoritative gloss for picker labels + 7.6 prompt templates)     |
| ---------- | ------------------------------------------------------------------------------------- |
| `code`     | Application code — features, endpoints, services, schema, migrations.                 |
| `design`   | Visual/interaction design — mockups, design tokens, `design-notes.md`.                |
| `test`     | Automated tests — unit / integration / E2E suites and fixtures.                       |
| `content`  | Copy, docs, and translation — user-facing strings, READMEs, i18n locales.             |
| `research` | Spike / investigation — time-boxed exploration that produces findings, not ship-code. |
| `review`   | QA / acceptance review — verifying a deliverable against its acceptance criteria.     |
| `decision` | A decision record (ADR) — fixing a choice the rest of the work builds against.        |
| `deploy`   | Infrastructure / ops — pipelines, environments, release + rollout mechanics.          |
| `manual`   | Human-only out-of-band work — SaaS / dashboard / secret / DNS / OAuth provisioning.   |
| `chore`    | Maintenance — dependency bumps, renames, lint/format sweeps, housekeeping.            |

Exactly **ten** members, in this canonical order. 2.7.3 declares this enum in
`prisma/schema.prisma` verbatim; 2.7.5's loader validates `PlanItem.type`
against it and **fails loudly** on an unknown string (a plan-module typo is a
seed-time error, never a silently-dropped field — the structural backstop the
prose form never had).

### 2. `type` is DISTINCT from `kind`, and LEAF-ONLY

`kind` (`epic` / `story` / `task` / `subtask` / `bug`) is the **structural
hierarchy** — it governs parenting (the kind-parent grammar). `type` is the
**nature of executable work** and is **orthogonal** to `kind`: it never affects
parenting.

`type` is carried **only on executable leaves** — `task` / `subtask` / `bug`.
Epics and stories are containers, not units of execution, so they have **no
type**. Every epic/story row, and every legacy/pre-2.7 row, is `type = null`.

- The column is therefore simply **nullable**. Leaf-only is a **semantic rule
  the service layer enforces** (`workItemsService` rejects setting
  `type`/`executor` on an epic/story with a typed error) — not a DB constraint a
  single nullable column can express.

### 3. The `executor` enum + the type→executor DEFAULT map

`executor ∈ { coding_agent, human }`. It is **nullable**, set alongside `type`.

When a `type` is first chosen, `executor` is **seeded** from the default map
below — and the seed is **always overridable** at pick time. The map is the
single source `2.7.3`'s `defaultExecutorForType(type): Executor` helper encodes;
neither the picker (2.7.4) nor the loader (2.7.5) re-states it — they call the
helper.

| `type`     | Default `executor` | Routing rationale                                                |
| ---------- | ------------------ | ---------------------------------------------------------------- |
| `code`     | `coding_agent`     | Code is the coding agent's core competency.                      |
| `test`     | `coding_agent`     | Test authoring is coding-agent work.                             |
| `deploy`   | `coding_agent`     | Pipeline/infra-as-code is agent-authorable.                      |
| `manual`   | `human`            | Out-of-band SaaS/dashboard work an agent structurally cannot do. |
| `decision` | `human`            | A judgement call / sign-off a human owns.                        |
| `review`   | `human`            | Acceptance review is a human gate.                               |
| `design`   | `coding_agent`     | Either; default agent (HTML mockups from the design system).     |
| `content`  | `coding_agent`     | Either; default agent (copy/docs/i18n drafting).                 |
| `research` | `coding_agent`     | Either; default agent (spikes), reassignable to a human.         |
| `chore`    | `coding_agent`     | Either; default agent (mechanical maintenance).                  |

Read as the three groups the story header records: **always-agent**
(`code` / `test` / `deploy`), **always-human** (`manual` / `decision` /
`review`), and **either, default agent** (`design` / `content` / `research` /
`chore`). Every one of the ten types has a default — the helper is **total**, so
adding an eleventh enum member without extending the map is a compile/test-time
failure (2.7.7 iterates the full enum), not a silent `default` fall-through.

### 4. The Jira-mirror deviation (Principle #11 — the honest paper trail)

Motir's primary standard is the mirror product, Jira (decision-authority
rung 1). Splitting `type` from `kind` and adding a separate `executor` axis is a
**deliberate deviation** from Jira, recorded here with its concrete
justification per Principle #11.

**The verified mirror (what Jira actually does):**

- **"Issue type" in Jira IS the kind hierarchy** — epic / story / task /
  sub-task / bug. That hierarchy is the _only_ native type axis: software
  projects ship the standard bug / story / task types plus sub-task, and custom
  issue types still slot into that same `Epic → {story, task, bug} → sub-task`
  shape. (Atlassian Support — _"What are work types?"_ / work-type management.)
- **Routing WHO executes is done through the ASSIGNEE field, not a sub-type.**
  With Rovo you "can add an agent to the assignee field," so an AI agent "shows
  up as an assignee, with the same fields and patterns" a human assignee would.
  (Atlassian Support — _"Collaborate on work items with AI agents."_)
- **Therefore Jira has no native executor sub-type orthogonal to issue-type.**
  The "what kind of work" and "who executes it" signals are both overloaded onto
  existing fields (issue-type = the kind hierarchy; assignee = the router).

> These are **observed** mirror behaviours (per `notes.html` #33: cite what was
> observed in the mirror, never assert from memory). The citations above are the
> surfaces verified; the deviation below is justified against them.

**The deviation and its concrete use case:** Motir separates the two axes —
`type` (what NATURE of work) and `executor` (WHO does it) — because the Epic-7
**AI dispatch layer** needs both as structural, queryable fields:

- it routes by **`type`** to select the right **prompt template** (Story 7.6's
  per-type generator — a total function over the fixed enum); and
- it routes by **`executor`** to decide **coding-agent dispatch vs human
  assignment**.

The kind-as-type + assignee-as-router shape cannot express this without
overloading two fields that already carry other meaning (kind drives parenting;
assignee names a specific person). The split is the load-bearing axis the
AI-native execution layer is built on — exactly the kind of recorded,
concrete-use-case deviation Principle #11 permits, and **not** "richer than the
standard because we can."

---

## Consequences

- **2.7.3** declares `enum WorkItemType` (the ten members, in order) + `enum
Executor` + nullable `work_item.type` / `work_item.executor`, and implements
  `defaultExecutorForType` as a total function matching the §3 table exactly,
  plus the service-layer leaf-only enforcement.
- **2.7.4** (picker UI) and **2.7.5** (seed loader) both seed `executor` by
  calling that single helper — neither re-states the map.
- **2.7.5** stops emitting the "Type:" / "Executor:" prose lines; the structured
  fields become the source of truth, and an unknown `PlanItem.type` aborts the
  seed.
- **2.7.6** registers `type` as a closed-set enum filter facet (`= X` /
  `in (…)` / `is null`); the fixed enum is what makes it a clean equality
  predicate.
- **7.6** keys its per-type prompt generator off this enum, relying on its
  fixedness for the total-function guarantee.
- **Extending the taxonomy** later = an explicit enum addition + migration +
  extending the default map (the total-function test fails until the map covers
  the new member) — never an ad-hoc string.

## References

- `scripts/plan-seed/data/story-2.7.ts` — the Story 2.7 module header (the
  locked taxonomy + the full deviation rationale this ADR records).
- `scripts/plan-seed/types.ts` — `PlanItem.type` (free `string`) /
  `PlanItem.executor` (`'coding_agent' | 'human'`): the plan-side inputs 2.7.5
  maps to the structured fields.
- Atlassian Support — _"What are work types?"_ (issue-type = the kind hierarchy)
  and _"Collaborate on work items with AI agents"_ (agent routing via the
  assignee field) — the cited mirror surfaces.
- Story 7.6 (stub) — the per-type prompt generator whose total-function
  guarantee this fixed enum exists to support.
- `notes.html` mistake #33 (verify the mirror, cite what was observed) and
  Principle #11 (deviate from the mirror only with a recorded concrete
  justification).

---

## Amendment 1 (2026-08-10) — the enum grows to FOURTEEN: `copy`, `translate`, `legal`, `verification` are admitted; `doc` and `spike` are aliases and are NOT

> **Written by Story MOTIR-2622 · Subtask MOTIR-2629.** This is the "explicit
> enum addition" §1 reserved as the ONLY legal way to grow the set. It decides
> the members, their executor defaults, and their place in the canonical order.
> It ships no code — MOTIR-2632 implements the schema/contract half and
> MOTIR-2633 the presentation half, both against this section.
>
> **Numbered 1** — the first amendment to this record. Verified before
> numbering: every one of the 239 remote branches that carries
> `docs/decisions/work-item-type-taxonomy.md` holds the identical blob
> `7c1adf3`, so no sibling branch is racing an Amendment 1 to this ADR.

**Amends §1** (the member list and its canonical order) and **§3** (the
type→executor default map). It re-opens nothing else: §2's leaf-only rule, §4's
Jira-mirror deviation, and the closedness of the enum all stand exactly as
written. In particular the extension procedure is **reaffirmed, not relaxed** —
see "The enum stays closed" below.

### The problem this fixes

`motir-meta`'s `prompts/plan-rules.md` carries the **per-type authoring bar** —
the standing instruction that tells a planner to _"sweep the COMPLETE set"_ of
work types and what each type's card must specify. That bar and this enum have
drifted apart in both directions:

|                                            |                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Taught by the bar AND settable here**    | `code` · `design` · `test` · `content` · `research` · `review` · `decision` · `deploy` · `manual` |
| **Taught by the bar, NOT settable here**   | `doc` · `spike` · `copy` · `translate` · `legal` · `verification`                                 |
| **Settable here, never taught by the bar** | `chore`                                                                                           |

A planner told to sweep the complete set can correctly conclude a story needs a
`translate` card and then have nowhere to file it. The card becomes `content` or
`chore`, and the authoring bar written for translation work never applies to it,
because the card is not that type. Nothing fails visibly; the guidance simply
stops reaching the work.

### The `doc` / `content` and `spike` / `research` questions — answered

Both were flagged as possible duplicates rather than gaps, and **both collapse.**
The evidence is the shape of `plan-rules.md`'s own per-type bar, which gives each
distinct type its own bullet stating what that type's card must specify:

```
- **`doc` / `content`**    — the document / content to produce, its audience, and where it lives.
- **`research` / `spike`** — the question to answer, the written deliverable, and the timebox.
- **`copy`**               — the strings to write, the voice / tone, and the i18n keys.
- **`translate`**          — the locale, the source strings, and the style guide.
- **`legal`**              — the legal artifact (ToS / privacy / license), the requirement it
                             satisfies, and who signs off.
- **`verification`**       — what is verified, and the recipe to verify it.
```

`doc` and `spike` are the only two names in the taught set that **share a bullet
with an existing member**. They have no authoring bar of their own, because they
are not a different kind of work — they are a second name for one. `copy`,
`translate`, `legal` and `verification` each carry their own bar, specifying
their own deliverable: that is what a distinct member looks like.

The enum's own §1 glosses agree, and settle the two cases differently:

- **`spike` ≡ `research` — a SYNONYM.** §1's gloss for `research` reads
  _"Spike / investigation — time-boxed exploration that produces findings, not
  ship-code."_ The word `spike` appears in the definition of the member itself.
  There is nothing to add. **`spike` is declared an alias of `research` and is
  NOT admitted.**
- **`doc` ⊂ `content` — a BUNDLE, and the bundle is being unpacked.** §1's gloss
  for `content` reads _"Copy, docs, and translation — user-facing strings,
  READMEs, i18n locales."_ That is three things under one name, and two of them
  (`copy`, `translate`) ARE being admitted as members with their own bars. So the
  question is not "is `doc` a duplicate of `content`" but "what does `content`
  mean once `copy` and `translate` are lifted out of it." The answer that keeps
  the set unambiguous is that **`content` retains the documentary half and
  `doc` is its alias** — `content` is the member, `doc` is the word the playbook
  uses for it. Admitting both would create two picker entries a person choosing
  between them could only guess at, which is worse than the gap it closes.

Consequently `content`'s gloss is **narrowed** (below) to say what it now means,
and a **precedence rule** is recorded so the general member never competes with
the specific ones.

**The final admitted count is FOUR, and the enum lands at FOURTEEN, not sixteen.**
The story that raised this (MOTIR-2622) was authored expecting six additions and
sixteen members; the two collapses above are exactly the outcome its own
acceptance criterion anticipated, and the story's criteria are amended to fourteen
on the record.

### 1a. The four admitted members

Each gets the same treatment §1 gives the original ten: a one-line authoritative
gloss, plus the boundary against its nearest neighbour — the sentence that tells
a planner which of the two to pick.

| Member         | Authoritative gloss                                                                                                                                 | Nearest neighbour, and the boundary                                                                                                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy`         | Product-facing WORDS — UI strings, labels, empty states, error messages, marketing body copy, and their i18n keys.                                  | vs `content`: `copy` is the words rendered **inside the product**, reviewed against the design and tone. `content` is documentation **about** the system. If it lands in `messages/*.json` or a component string, it is `copy`.                                                                                                                                   |
| `translate`    | A LOCALE twin of existing copy — moving already-authored strings into another language against a style guide.                                       | vs `copy`: `translate` authors **no new meaning**; the source strings already exist. New `en` wording is `copy`; its `zh` twin is `translate`.                                                                                                                                                                                                                    |
| `legal`        | A legal artifact — terms of service, privacy policy, licence, DPA — and the requirement it satisfies.                                               | vs `content`/`decision`: a `legal` work item produces a document that **binds the company** and needs a human signatory. A decision **about** legal posture with no artifact is `decision`.                                                                                                                                                                       |
| `verification` | Establishing that a stated FACT is true, and producing the evidence — a precondition, a published artifact, a config value, a claim on a work item. | vs `review`: `review` judges a finished **deliverable** against its acceptance criteria and ends in a person's sign-off. `verification` checks a **claim** and ends in evidence (a pull, a grep, a command's output). vs `test`: a `test` work item ships automated tests that run in CI; a `verification` work item runs a check once and records what it found. |

**`content` is narrowed, and the specific beats the general.** With `copy` and
`translate` lifted out, §1's `content` gloss is amended to:

> `content` — Documentation and authored long-form material: `README`s, guides,
> runbooks, API documentation, help articles, seeded example/demo content.
> (`doc` is an alias of this member, not a member of its own.)

and the precedence rule that removes the remaining ambiguity:

> **When a card fits `copy`, `translate` or `legal`, one of those wins over
> `content`.** `content` is the residual member — it names authored material that
> is not product strings, not a locale twin, and not a binding legal artifact.

This narrowing is a **definition change, not a data change**. Per MOTIR-2622's
scope boundary there is **no backfill**: existing `content` rows keep their type,
and some of them describe work that would be filed as `copy` today. That is
accepted and recorded here so a later reader does not mistake the mixed history
for a broken rule.

### 1b. The canonical order of the fourteen

§1's order is load-bearing — it is what pickers, legends, filter menus and the
7.6 prompt generator iterate. The four newcomers are **inserted beside their
nearest neighbours**, and the original ten keep their existing relative order
exactly, so no downstream list is reshuffled by this amendment:

| #   | Member             | Group            |
| --- | ------------------ | ---------------- |
| 1   | `code`             | Build            |
| 2   | `design`           | Build            |
| 3   | `test`             | Build            |
| 4   | `content`          | Author           |
| 5   | **`copy`**         | Author           |
| 6   | **`translate`**    | Author           |
| 7   | `research`         | Investigate      |
| 8   | `review`           | Investigate      |
| 9   | **`verification`** | Investigate      |
| 10  | `decision`         | Govern & operate |
| 11  | `deploy`           | Govern & operate |
| 12  | `manual`           | Govern & operate |
| 13  | **`legal`**        | Govern & operate |
| 14  | `chore`            | Govern & operate |

As one list, for downstream code to be read against verbatim:

```
code · design · test · content · copy · translate · research · review ·
verification · decision · deploy · manual · legal · chore
```

**The four GROUPS are a consequence of the order, not a second ordering.** Each
group is a contiguous run, so a picker may render section headings without
reordering anything, and a picker that ignores them still shows the canonical
sequence. Whether the grouping is _drawn_ is MOTIR-2631's decision, taken by
measuring the menu — it is offered here, not mandated.

### 3a. The type→executor defaults for the four

Extending §3's map. The three groups §3 defines are unchanged; each newcomer
joins one of them.

| `type`         | Default `executor` | Group                 | Routing rationale                                                                                                                                       |
| -------------- | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy`         | `coding_agent`     | either, default agent | Drafting product strings against a design and a tone is agent work; a human rewrite is a reassignment, not the norm.                                    |
| `translate`    | `coding_agent`     | either, default agent | The source strings already exist and the register is written down; this project's `zh` catalogue is produced this way today.                            |
| `verification` | `coding_agent`     | either, default agent | Verification is executing a recipe and recording evidence — pulling an artifact, grepping shipped code, reading a platform API.                         |
| **`legal`**    | **`human`**        | **always-human**      | A binding artifact needs a signatory. An agent may draft, but the default must not route a card that ends in a signature to something that cannot sign. |

`legal` is the one where the default carries real cost, and it is deliberately
the conservative choice: a wrong `human` default costs one reassignment, while a
wrong `coding_agent` default surfaces as a stalled card mid-run, which is the
failure mode §3's map exists to prevent.

`defaultExecutorForType` therefore stays **total** over fourteen, and the
`Record<WorkItemTypeDto, ExecutorDto>` typing keeps a fifteenth member a compile
error until its default lands — the guarantee §3 was built for, unchanged.

### `chore` has no authoring bar — recorded, and owned

The drift runs both ways. `chore` has been settable since 2.7.3 and
`plan-rules.md` has **never** taught it: it appears in no bullet of the per-type
bar. It is also the type this project reaches for most often on its own
planning-bug cards, so the most-used type is the one with no guidance attached.

**MOTIR-2630 owns writing that bar**, and this amendment hands it three items
rather than one:

1. Write the missing **`chore`** authoring bar.
2. Re-express **`doc`** in the bar as an alias of `content`, not a separate
   sweep entry — the collapse decided above.
3. Re-express **`spike`** in the bar as an alias of `research`, likewise.

Items 2 and 3 are this amendment's consequence for that card: the bar currently
lists both names as sweep entries, which is what made them look like gaps.

### The enum stays closed

Reaffirmed without change. `type` remains a **fixed enum**, not free text, for
the reason §1 gave: 7.6's per-type prompt generator must be a total function and
the filter facet must be a closed set. **The extension procedure is unchanged and
is exactly the one this amendment followed** — an explicit amendment to this ADR,
then an enum addition plus migration, then the consumer sweep below. Never an
ad-hoc string.

One consequence worth naming, because it is the same defect one repo over:
`motir-ai`'s `propose_node` declares `type` as a free `string` with no
enumeration, so the hosted generator can propose a type no work item can carry.
That is out of MOTIR-2622's scope (a different repository) and belongs to the
`motir-ai` story; it is recorded here so the closedness of this enum is not
mistaken for closedness at every producer.

### Consequences — the full consumer sweep

Adding a member touches more than the schema. Enumerated here so the
implementation cards read one list instead of re-deriving it, in the repo's
layering order:

| Layer                       | What moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Card       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Schema                      | `prisma/schema.prisma`'s `WorkItemType` enum + an **additive** migration. No column change, no backfill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | MOTIR-2632 |
| Domain                      | `lib/issues/executorDefaults.ts` — `WORK_ITEM_TYPES` in the §1b order, and `DEFAULT_EXECUTOR_BY_TYPE` extended per §3a so the helper stays total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | MOTIR-2632 |
| DTO                         | `WorkItemTypeDto` in `lib/dto/workItems.ts`, and the `lib/dto/{ai,ready,quickView}.ts` re-exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | MOTIR-2632 |
| Filter grammar              | `lib/filters/registry.ts`'s `type` facet, whose `valueWhitelist` reads `WORK_ITEM_TYPES` — it should follow with no edit; that must be **verified**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | MOTIR-2632 |
| Published contracts         | `lib/mcp/tools/{createWorkItem,updateWorkItem}.ts`, `lib/api/v1/{workItems,ready}/schema.ts`, and the CLI's generated `packages/cli/src/api/schema.d.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MOTIR-2632 |
| Seed                        | `scripts/plan-seed/mapItem.ts`, which validates a plan leaf's type against the enum and fails loudly on an unknown string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | MOTIR-2632 |
| Presentation metadata       | `lib/issues/workItemTypeMeta.ts` — a lucide glyph + an `--el-type-*` hue per member. It is a total `Record`, so **the build fails until it covers the new members**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | MOTIR-2633 |
| Tokens                      | `packages/design-system/theme.css` — the Tier-3 `--el-type-*` tokens (the design system was extracted; **not** `app/globals.css`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | MOTIR-2633 |
| i18n                        | `messages/en.json` **and** `messages/zh.json` — a label per member, each with its `zh` twin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | MOTIR-2633 |
| Surfaces                    | `components/issues/WorkItemType{Picker,Chip,Icon}.tsx` and every surface that renders the set (list column, board card, roadmap node, quick view, filter bar).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | MOTIR-2633 |
| Design                      | The picker/chip/legend redrawn for fourteen, measured across `design/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | MOTIR-2631 |
| The playbook                | `chore`'s bar; `doc` and `spike` re-expressed as aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MOTIR-2630 |
| Hosted planner (`motir-ai`) | `motir-ai` `src/llm/planningRulePacks.ts`'s `PLAN_ALL_SUBTASK_TYPES_AND_COMPOSITION` — a segment of `SHARED_PLANNING_RULES`, the corpus handed verbatim to the hosted planner. The set is **prose in a template literal, in a second repository**, so **no compile-time guard reaches it** (the compiler sees a string; `workItemTypeMeta.ts`'s total `Record` above fails a build in THIS repo only). It drifted for eight days after this amendment landed. That repo holds a **second, typed** copy that DID track it — `src/llm/workItemTypes.ts`'s `WORK_ITEM_TYPES` — so `motir-ai` carries **two** copies of §1b's list and only one is compiler-checked. | MOTIR-2972 |

The compile-time guard in the presentation map means MOTIR-2632 cannot land
without touching MOTIR-2633's file. That is the guard working as designed; the
resolution is the minimum needed to build, labelled as placeholder in that PR.

### References added by this amendment

- `motir-meta` `prompts/plan-rules.md` — the per-type authoring bar quoted
  above; the source of the taught set and the evidence for both collapses.
- MOTIR-2622 (the story), MOTIR-2629 (this amendment), MOTIR-2631 (design),
  MOTIR-2632 (enum + contracts), MOTIR-2633 (presentation), MOTIR-2630 (the
  playbook's missing bars).

---

## Amendment 2 (2026-09-03) — the `verification` and `legal` glosses say **work item**, not "card"

> **Written by MOTIR-4298**, under epic MOTIR-3937. It changes WORDING only: no
> member is admitted or removed, no executor default moves, no boundary between
> two members shifts. §1's ten, §1a's four, §1b's canonical order, §2's
> leaf-only rule, §3/§3a's default map, §4's Jira deviation and the closedness
> of the enum all stand exactly as written.
>
> **Numbered 2** — verified before numbering: no open pull request in this
> repository touches `docs/decisions/work-item-type-taxonomy.md`, and
> `origin/main` carries Amendment 1 only, so no sibling is racing an
> Amendment 2 to this ADR.

**Amends §1a** — two rows of the four-admitted-members table, in three fields:

| Row            | Field                | Was                                                        | Now                                                                  |
| -------------- | -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `verification` | Authoritative gloss  | … a config value, a claim on a **card**.                   | … a config value, a claim on a **work item**.                        |
| `verification` | Boundary (vs `test`) | a `test` **card** ships … a `verification` **card** runs … | a `test` **work item** ships … a `verification` **work item** runs … |
| `legal`        | Boundary             | a `legal` **card** produces a document that binds …        | a `legal` **work item** produces a document that binds …             |

**Why an ADR amendment for four words.** "card" is authoring-voice shorthand.
The product's noun for a tracked unit is **work item**, and `plan-rules/core.md`
already forbids emitting the shorthand into a work item's own copy — but this
ADR's §1a table is not ordinary documentation prose. It is **mirrored verbatim**
into `motir-ai` `src/llm/workItemTypes.ts`'s `WORK_ITEM_TYPE_GLOSSES`, which
`THE_TYPE_VOCABULARY` (tag `core`) interpolates into **every legal planning
cell** — so these four words are composed into the text a planning model is
actually handed, on every turn, and they taught it the banned word. That is the
discriminator, and it is why this amendment is narrow: the ADR's OTHER uses of
"card" — in Context, in Consequences, in the §1c precedence note at the blockquote
below §1a — are authoring voice that reaches no composed prompt, and are
deliberately left alone.

**The mirror moves in the same change, and it is a two-repository contract.**
`motir-ai` cannot import, read or reach this file, so it substitutes a drift
guard for a build-time import: `tests/workItemTypeVocabulary.test.ts` holds an
INDEPENDENTLY TYPED transcription of the table above (`ADR_SCOPE` /
`ADR_BOUNDARY`) and asserts `WORK_ITEM_TYPE_GLOSSES` matches it verbatim.

> ⚠️ **Amending only the mirror would have SILENCED that guard rather than
> satisfied it.** Rewording `workItemTypes.ts` plus its local transcription,
> leaving this document saying "card", makes the two agree with each other and
> disagree with the authority they exist to mirror — manufacturing the exact
> drift the guard was built to catch. **This document is therefore the first
> edit, and the mirror follows it.** MOTIR-4298 was filed and halted for
> precisely this reason rather than taking the four-sentence sweep.

### References added by this amendment

- `motir-ai` `src/llm/workItemTypes.ts` — `WORK_ITEM_TYPE_GLOSSES`, the mirror.
- `motir-ai` `tests/workItemTypeVocabulary.test.ts` — `ADR_SCOPE` /
  `ADR_BOUNDARY`, the transcription that pins the mirror to this table.
- `motir-ai` `tests/cardTerminologyGuard.test.ts` — THE GUARD (MOTIR-4288) that
  found this, and whose `KNOWN_UPSTREAM_STRAGGLERS` exemption MOTIR-4298 removes.
- MOTIR-4201 (the parent sweep), MOTIR-4288 (the guard), MOTIR-4298 (this).

---

## Amendment 3 (2026-09-21) — `choice` is admitted as the FIFTEENTH member, and `decision` stops meaning two things

> **Written by Story MOTIR-4914 · Subtask MOTIR-5886.** This is the explicit
> enum addition §1 reserves as the only legal way to grow the set. It decides
> the member, its gloss, its place in the canonical order and its executor
> default, and it restates `decision`'s gloss so the two words stop overlapping.
> It ships no code, no migration and no rule pack: each mirror named in the
> consumer sweep below is its own subtask, `blocked_by` this one.
>
> **Numbered 3** — verified before numbering: `origin/main` (`c4c62a837`)
> carries Amendments 1 and 2 only, and no open pull request in this repository
> touches `docs/decisions/work-item-type-taxonomy.md`
> (`gh pr list --state open --json files`), so no sibling is racing an
> Amendment 3 to this ADR.

**Amends §1** (the `decision` gloss, and a new `choice` row), **§1b** (the
canonical order, restated in full), **§3** (the `decision` executor rationale)
and **§3a** (a new `choice` row), and reconciles one sentence of **§1a** (the
`legal` boundary). §2's leaf-only rule, §4's Jira-mirror deviation, and the
closedness of the enum stand exactly as written.

### The problem this fixes

`decision` has been defined twice, and the two definitions disagree
(MOTIR-4155):

- **§1** says a `decision` IS an artifact — _"A decision record (ADR) — fixing a
  choice the rest of the work builds against."_
- **§3**'s rationale (_"A judgement call / sign-off a human owns"_) and
  **§1a**'s `legal` boundary (_"A decision **about** legal posture with no
  artifact is `decision`"_) say it is the JUDGEMENT, with no artifact at all.

Those are two different acts with two different actors. In the first, the
decision has already been made — by the planner with a person in the
conversation (Amendment 4 removed the agent that researched it) — and what is
left is to write it down so a person can accept it. In the second, nobody has
decided: the planner correctly declined to choose between options that are all
correct, and a person has to PICK one. The approval gates ADR already gives the second act its own
gate kind (`decision_choice`), and until this amendment there was no type it
could key on — so it was keyed on `type: decision` with a human executor, the
same pair that also means _"accept this written record."_

### 1c. The fifteenth member — `choice`

| Member   | Authoritative gloss                                                                                                                                                                                                                          | Nearest neighbour, and the boundary                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choice` | A question the planner correctly declined to decide — two or more options, each with its WHY and what it is best for, and a person PICKS one. It has no artifact but the pick, and it always decides FOLLOW-UP work that is not yet planned. | vs `decision`: a `decision` was made in the conversation and its run writes it up for a person to ACCEPT; a `choice` is undecided and a person PICKS among its options. A question still open when planning ends is a `choice`, never a `decision` for its run to research. _(Amendment 4)_ |

**Kind.** Leaf-only, like every type (§2). The shape a planner lays is a
**`task` under an epic, laid in the place a story would have taken** — the
placement rule MOTIR-4915 shipped (`motir-meta`
`prompts/plan-rules/kind-container.md`, and its twin in `motir-ai`'s
`SHARED_PLANNING_RULES`). That rule is the reason every `choice` decides
follow-up work: a `choice` may not sit inside the scope a person asked to have
planned — there, the planner decides — so what it governs is, by construction,
not yet laid.

**Its body STRUCTURE is not `decision`'s.** A `decision` states a decision and
its consequences; a `choice` states a question, WHY it is a choice — which of
the three situations `kind-container.md`'s choice rule names brought it back —
its options with each option's WHY and what it is best for, and what the pick
gates. The canonical structure, and what the
gate does with a body that deviates from it, are the approval gates ADR's to
fix (its `decision_choice` amendment, MOTIR-5887). The per-type authoring bar
that teaches a planner to write that structure is the `type-choice` pack
(MOTIR-5889 in `motir-meta`, MOTIR-5892 in `motir-ai`).

### 1d. `decision` is restated as the DECIDED RECORD

§1's `decision` gloss is amended to:

> `decision` — A decision the conversation already made — the planner with the
> person, in planning — recorded so a person can accept it; its run writes it up
> and never re-opens it. An open question is a `choice`.

_(Restated by Amendment 4, which records the wording it replaced and why.)_

And the two sentences that described the artifact-free judgement are
reconciled with it:

- **§3's rationale for `decision` → `human`** was _"A judgement call / sign-off a
  human owns."_ It now reads: _"Accepting a written decision is a person's
  sign-off."_ The default executor does not move — `decision` stays in the
  **always-human** group — because accepting a decided record is still a
  person's act. What moved is which act: the PICK among undecided options is
  `choice` (§1c), not `decision`.
- **§1a's `legal` boundary** said _"A decision **about** legal posture with no
  artifact is `decision`."_ It now reads: _"A decision **about** legal posture
  that has been made is `decision`; one still to be picked among options is
  `choice`."_ A `legal` work item still produces a document that binds the
  company and needs a signatory; that half of the boundary is unchanged.

**This settles the §1 half of MOTIR-4155 — and only that half.** MOTIR-4155
also asks whether §1a's enumeration of what `content` is should be replaced by
the question _"has this already been accepted by somebody?"_ That `content` half
is **NOT decided here**; it stays on MOTIR-4155. Silence about it in this
amendment is not a decision about it.

### 1e. The canonical order of the fifteen

`choice` joins the **Govern** group, **immediately after `decision`**, the
member it was split from. The other fourteen keep their relative order exactly,
so no downstream list is reshuffled, and the four groups stay contiguous runs
(`lib/issues/workItemTypeMeta.ts`'s `WORK_ITEM_TYPE_GROUP` reads them as runs):

| #   | Member         | Group            |
| --- | -------------- | ---------------- |
| 1   | `code`         | Build            |
| 2   | `design`       | Build            |
| 3   | `test`         | Build            |
| 4   | `content`      | Author           |
| 5   | `copy`         | Author           |
| 6   | `translate`    | Author           |
| 7   | `research`     | Investigate      |
| 8   | `review`       | Investigate      |
| 9   | `verification` | Investigate      |
| 10  | `decision`     | Govern & operate |
| 11  | **`choice`**   | Govern & operate |
| 12  | `deploy`       | Govern & operate |
| 13  | `manual`       | Govern & operate |
| 14  | `legal`        | Govern & operate |
| 15  | `chore`        | Govern & operate |

As one list, for downstream code to be read against verbatim:

```
code · design · test · content · copy · translate · research · review ·
verification · decision · choice · deploy · manual · legal · chore
```

**The migration anchors on the same position** —
`ALTER TYPE "work_item_type" ADD VALUE 'choice' AFTER 'decision'` — for the
reason Amendment 1's migration
(`prisma/migrations/20260810220000_work_item_type_admit_four`) used explicit
anchors: an unanchored `ADD VALUE` appends, and Postgres's enum order would then
disagree with the datamodel order this list fixes. The same anchor applies to
`motir-ai`'s own `LessonWorkType` enum, which mirrors this set.

### 3b. The executor default for `choice`

| `type`       | Default `executor` | Group            | Routing rationale                                                                                                       |
| ------------ | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **`choice`** | **`human`**        | **always-human** | A pick among options is a person's by definition. There is no `coding_agent` arm: nothing is left to research or write. |

`defaultExecutorForType` stays **total** over fifteen, and the
`Record<WorkItemTypeDto, ExecutorDto>` typing keeps a sixteenth member a compile
error until its default lands — the guarantee §3 was built for, unchanged.

### Consequences — the consumer sweep for `choice`

**Enumerated from two searches, run on each repository's `origin/main`**, per
the lesson that a sweep over a vocabulary's SYMBOL finds its callers and only a
search over its member VALUES finds a surface holding its own copy. The list
this subtask was handed is where the survey started; the table is what the two
commands returned, and every hit is either a row or a named exclusion below.

```sh
# refs: motir-core c4c62a837 · motir-ai 4fbd2be · motir-meta 185a41d
# 1 — the SYMBOL (the callers, and the typed homes)
git grep -l -w -E 'WorkItemType|WorkItemTypeDto|WorkItemTypeName|WORK_ITEM_TYPES|WORK_ITEM_TYPE_GLOSSES|WORK_ITEM_TYPE_GROUP|DEFAULT_EXECUTOR_BY_TYPE|defaultExecutorForType|LessonWorkType|LESSON_TYPES' origin/main -- . ':!prisma/migrations'
#     → motir-core 90 files · motir-ai 27 · motir-meta 2
# 2 — the member VALUES (the private copies)
git grep -l -E "['\"\`]chore['\"\`]" origin/main -- . ':!prisma/migrations'
#     → motir-core 24 files · motir-ai 20 · motir-meta 19
# 2b — the files that ENUMERATE the set (≥ 8 of the 14 members as quoted
#      literals or table cells), to separate a home from a mention
#     → 20 · 16 · 12, listed per row below
# 2c — the unquoted spellings a quoted search cannot see
git grep -n -E '^enum (WorkItemType|LessonWorkType)|el-type-chore|type-chore' origin/main
```

Most symbol hits are **importers** — they read the type or the constant and
follow a new member with no edit (`lib/filters/registry.ts`'s facet reads
`WORK_ITEM_TYPES`; `motir-ai` `src/llm/treeGeneration.ts` interpolates
`WORK_ITEM_TYPES` into `propose_node`'s schema and error text). They are not
rows. A row is a file that **states the set itself**.

#### `motir-core`

| Layer                 | Home                                                                                                                                                                     | What moves                                                                                                                          | Owner                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Schema                | `prisma/schema.prisma` `enum WorkItemType` + a new additive migration                                                                                                    | `choice` after `decision`; `ADD VALUE 'choice' AFTER 'decision'`. No column change, no backfill                                     | MOTIR-5890                      |
| Domain                | `lib/issues/executorDefaults.ts` — `WORK_ITEM_TYPES`, `DEFAULT_EXECUTOR_BY_TYPE`                                                                                         | the §1e order; `choice → human`                                                                                                     | MOTIR-5890                      |
| DTO                   | `lib/dto/workItems.ts` — `WorkItemTypeDto`                                                                                                                               | the member                                                                                                                          | MOTIR-5890                      |
| Published contracts   | `lib/api/v1/workItems/schema.ts` · `lib/api/v1/ready/schema.ts`                                                                                                          | the enum in both schemas                                                                                                            | MOTIR-5890                      |
| Generated contracts   | `lib/apiDocs/mcpToolSchemas.ts` (`pnpm generate:mcp-tool-schemas`) · `packages/cli/src/api/schema.d.ts` + `packages/cli/src/api/validators.js` (`pnpm generate:cli-api`) | regenerated, never hand-edited                                                                                                      | MOTIR-5890                      |
| Dispatch              | `lib/dispatch/promptTemplate.ts` — `WHAT_TO_DO: Record<WorkItemTypeDto, …>` and `branchPrefix`                                                                           | a `choice` entry (total `Record`, so the build fails until it exists). A `choice` is never dispatched to an agent; its steps say so | MOTIR-5890                      |
| Seed                  | `scripts/plan-seed/mapItem.ts`                                                                                                                                           | accepts `choice`; still fails loudly on an unknown string                                                                           | MOTIR-5890                      |
| Presentation metadata | `lib/issues/workItemTypeMeta.ts` — glyph, `--el-type-*` hue, `WORK_ITEM_TYPE_GROUP`                                                                                      | `choice` in the `govern` run, directly after `decision` (total `Record`)                                                            | MOTIR-5890, drawn by MOTIR-5888 |
| Tokens                | `packages/design-system/theme.css` — the Tier-3 `--el-type-*` block                                                                                                      | `--el-type-choice`, value named by the design                                                                                       | MOTIR-5890, drawn by MOTIR-5888 |
| i18n                  | `messages/en.json` · `messages/zh.json`                                                                                                                                  | a label per locale                                                                                                                  | MOTIR-5890                      |
| Lesson axis mirror    | `lib/mcp/tools/addLesson.ts` · `lib/mcp/tools/searchLessons.ts` — `LESSON_TYPES`                                                                                         | the member, after `motir-ai`'s `LessonWorkType` has it                                                                              | MOTIR-5894                      |
| Design record         | `design/work-items/design-notes.md` (the type-executor section) · a delta of `design/work-items/type-executor-picker.mock.html`                                          | the `choice` chip drawn in the Govern group                                                                                         | MOTIR-5888                      |
| Guards                | `tests/integration/work-items/work-item-type-story-gate.test.ts` · `tests/issues/executorDefaults.test.ts`                                                               | the story gate covers `choice` with no edit (it iterates `WORK_ITEM_TYPES`); the executor-default suite gains its row               | MOTIR-5890 / MOTIR-5898         |

#### `motir-ai`

| Layer       | Home                                                                                                                                                                                                   | What moves                                                                  | Owner                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------- |
| Vocabulary  | `src/llm/workItemTypes.ts` — `WORK_ITEM_TYPES`, `WORK_ITEM_TYPE_GLOSSES`                                                                                                                               | the member, and its gloss **verbatim from §1c** (and `decision`'s from §1d) | MOTIR-5892              |
| Rule packs  | `src/llm/planningRulePacks.ts` — the `type-*` pack table                                                                                                                                               | a `type-choice` pack, in the same words as `motir-meta`'s                   | MOTIR-5892              |
| Lesson axis | `prisma/schema.prisma` `enum LessonWorkType` + migration (`ADD VALUE 'choice' AFTER 'decision'`) · `src/app.ts` `LESSON_TYPES` · `src/jobs/plannerInputs.ts` `LESSON_TYPES` · `src/llm/lessonTools.ts` | the member in the enum and all three hand-listed mirrors                    | MOTIR-5892              |
| Baselines   | `tests/fixtures/sharedPlanningRules.baseline.txt` and the frozen corpora that carry the type set                                                                                                       | regenerated by their own scripts                                            | MOTIR-5892              |
| Guards      | `tests/workItemTypeVocabulary.test.ts` (`ADR_SCOPE` / `ADR_BOUNDARY`) · `tests/lessonRoutingAxes.test.ts` · `tests/planningRulePacks.test.ts`                                                          | the transcription of §1c / §1d; the axis at fifteen                         | MOTIR-5892 / MOTIR-5895 |

#### `motir-meta`

| Layer     | Home                                                                                                   | What moves                                                      | Owner      |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------- |
| Rule pack | `prompts/plan-rules/type-choice.md` (new)                                                              | the options authoring bar                                       | MOTIR-5889 |
| Routing   | `prompts/plan-rules/split.py` · `DECISION.numbers.py` · `COMPRESSION.measure.py` · `SELECTOR.check.py` | `type = choice` → `type-choice`                                 | MOTIR-5889 |
| Placement | `prompts/plan-rules/kind-container.md` — the MOTIR-4915 unit                                           | one clause naming the shape it lays: a `task` of `type: choice` | MOTIR-5889 |
| Generated | `prompts/plan-rules/MANIFEST.md` · `MIRROR.md`                                                         | regenerated / new rows                                          | MOTIR-5889 |

#### Hits that are NOT homes, each with its reason

- **Every `design/**/_.mock.html`inline token block** carrying`--el-type-_`(the 2c search returns ~80 mocks). A mock is a record of the moment it was
drawn and is never edited (the delta-mock rule in`CLAUDE.md`); only the new
delta MOTIR-5888 draws carries `--el-type-choice`.
- **`motir-ai` `src/seed/lessons.base.ts`** — its hits are lesson rows' own
  `types` axis values, not a statement of the set.
- **`motir-meta` `prompts/plan-rules/CLASSIFICATION.build.py`** — its
  `SETTABLE` list is the pre-split MEASUREMENT of the corpus and is frozen by
  design; MOTIR-5889 leaves it untouched and says so.
- **`scripts/plan-seed/data/story-2.7.ts`**, the frozen bootstrap seed, and the
  two test files that assert Amendment 1's history
  (`tests/integration/work-items/work-item-type-admitted-four.test.ts`,
  `tests/integration/plan-seed/loader-mapping.test.ts`) — records of an earlier
  set, not homes of the current one.
- **`docs/mcp.md`, `CLAUDE.md` and `docs/decisions/public-follow-and-changelog.md`**
  in `motir-core`, and **`CLAUDE.md`** in `motir-ai` — prose that mentions
  members (Conventional Commits' `chore`, one member named in passing), not an
  enumeration. `motir-ai` `docs/contract.md` names the set as _"the fourteen
  work types"_; that sentence moves to fifteen with MOTIR-5892.

### The guards that hold the mirrors to this text

- **`motir-core` `tests/integration/work-items/work-item-type-story-gate.test.ts`**
  — parameterised over `WORK_ITEM_TYPES` rather than a fixed list, it asserts
  that seven of the homes above (the Prisma enum, the ordered list, the DTO
  union, the executor map, the presentation map and group, the colour token,
  both message catalogues) stay in step for EVERY member. It needs no edit to
  cover `choice`: it goes red at whichever of those homes the admission
  forgets. The generated contracts, the dispatch map and the seed are outside
  its seven and are held by their own compile-time totality or suites.
- **`motir-ai` `tests/workItemTypeVocabulary.test.ts`** — holds an
  independently typed transcription of this ADR's glosses and asserts
  `WORK_ITEM_TYPE_GLOSSES` matches it verbatim. **This document is therefore
  the first edit**, exactly as Amendment 2 records: amending the mirror first
  would make the two copies agree with each other and disagree with the
  authority.

### References added by this amendment

- MOTIR-4914 (the story), MOTIR-5886 (this amendment), MOTIR-5887 (the
  `decision_choice` gate amendment in `approval-gates.md`), MOTIR-5888 (the
  design), MOTIR-5889 (the `motir-meta` pack), MOTIR-5890 (the type in this
  repository), MOTIR-5892 (the `motir-ai` vocabulary), MOTIR-5894 (the lesson
  axis mirror).
- MOTIR-4155 — `decision` defined twice; its §1 half is settled here, its
  `content` half is not.
- MOTIR-4915 — where a `choice` is laid.

---

## Amendment 4 (2026-11-02) — a `decision` is made in the conversation and written up by its run; it is never researched

> **Written by MOTIR-10207**, found while running MOTIR-10206. It changes
> WORDING only: no member is admitted or removed, no executor default moves,
> and §1e's canonical order, §2's leaf-only rule, §3/§3a/§3b's default map, §4's
> Jira deviation and the closedness of the enum all stand exactly as written.
>
> **Numbered 4** — verified before numbering: `origin/main` (`9947bd1`) carries
> Amendments 1, 2 and 3 only, and MOTIR-10206's open pull request (#3910), the
> one in-flight change about `decision` work items, does not touch this file.

**Amends §1c** (the `choice` boundary) **and §1d** (the `decision` gloss). Both
are edited in place above, each marked _(Amendment 4)_, so a reader of §1c or
§1d reads the wording in force. The table below is the record of what they
said before.

### The problem this fixes

Amendment 3 told the two acts apart correctly — a `decision` is already made
and a person ACCEPTS it, a `choice` is undecided and a person PICKS — but it
kept two phrases from the shape it was splitting:

- §1d said a decision is made _"by the agent researching it, or by the planner
  with the person in conversation"_. That leaves a `decision` work item room to
  hold an open question for its run to research and answer.
- §1c's boundary said _"If a recommendation exists, it is a `decision`"_. That
  makes a recommendation — an agent's proposal on an open question — the thing
  that turns a question into a decision.

MOTIR-10206 settled the rule in both planners' corpora and in motir-core's
`decision` section set: planning is where decisions are made, by the planner
with the person in the conversation, and a `decision` work item is the WRITE-UP
of one such decision. Its run writes it up so the person can confirm the planner
understood them; it does not research, weigh or propose. A question the
conversation has not settled is never laid as a `decision`: either it is a
`choice` a person picks, or it goes back to the conversation. This ADR's two
phrases were the last statement of the old shape, and `motir-ai`'s
`WORK_ITEM_TYPE_GLOSSES` carries them verbatim into the hosted planner's type
vocabulary.

### What changes

| Section | Field             | Was                                                                                                                                                                                                                                | Now                                                                                                                                                                                                                                                                         |
| ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1d     | `decision` gloss  | A decision already made — by the agent researching it, or by the planner with the person in conversation — written down so a person can accept it.                                                                                 | A decision the conversation already made — the planner with the person, in planning — recorded so a person can accept it; its run writes it up and never re-opens it. An open question is a `choice`.                                                                       |
| §1c     | `choice` boundary | vs `decision`: a `decision` is already decided and is written down for a person to ACCEPT; … If a recommendation exists, it is a `decision`. If the work item's body is a set of options with no recommendation, it is a `choice`. | vs `decision`: a `decision` was made in the conversation and its run writes it up for a person to ACCEPT; a `choice` is undecided and a person PICKS among its options. A question still open when planning ends is a `choice`, never a `decision` for its run to research. |

`choice`'s own gloss in §1c (_"A question the planner correctly declined to
decide — … a person PICKS one."_) is unchanged: it already says the question is
open and the person decides it.

**What tells the two apart now is whether the conversation decided it, not
whether a recommendation exists.** A `choice` still carries no recommendation
(the `type-choice` packs say _a person picks; nothing is recommended_), but the
absence of one is a property of a `choice`, not its test.

**§3's executor rationale stands** (_"Accepting a written decision is a
person's sign-off."_), and so does the default `decision → human`. Which
executor a planner LAYS a `decision` with, and which gate each executor raises,
are the planning corpora's and the approval gates ADR's to say, not this
taxonomy's.

### Consequences

- **`motir-ai` `src/llm/workItemTypes.ts` `WORK_ITEM_TYPE_GLOSSES`** — the
  `decision` scope and the `choice` boundary take the new wording verbatim, and
  `tests/workItemTypeVocabulary.test.ts`'s independent transcription
  (`ADR_SCOPE` / `ADR_BOUNDARY`) and `tests/choiceTypeStoryGate.test.ts` move
  with them. `tests/fixtures/sharedPlanningRules.baseline.txt` is regenerated by
  its script. MOTIR-10207.
- **`motir-meta` `prompts/_shared.md`** — the data model's `type` line is
  plan.py's type vocabulary (`plan.py` composes it into every session). It
  becomes the fifteen-member list with the `decision` and `choice` glosses
  carried verbatim. MOTIR-10207.
- **This document is the first edit**, as Amendments 2 and 3 record: the mirror
  is held to this text, never the reverse.

### References added by this amendment

- MOTIR-10207 (this amendment), MOTIR-10206 (a `decision` work item is the
  write-up of a decision made in planning).
