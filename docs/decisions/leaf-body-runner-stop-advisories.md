# The runner's mechanical stops on a leaf's body are plan-time advisories, never gates

**Status:** accepted · **MOTIR-10380** (Story MOTIR-10350, Epic MOTIR-10347)

## Context

The runner stops on a card it cannot build as written. Some of those stops need
no judgement at all: a leaf whose description is empty gives an agent nothing to
build, and a leaf whose body enumerates no acceptance criterion gives it no way
to know it is done. `validate_plan` could not see either on a card that was
typed or sized. The one check that reads missing criteria, `under-authored`
(`docs/decisions/under-authored-shape-family.md`), fires only when the criteria
AND `storyPoints`, `estimateMinutes`, `type` and `executor` are all absent, so a
`code` leaf at 3 points with an empty body passed clean and reached the runner.

These are the cheapest defects a plan carries, because a reading of the card
finds them. Finding them at plan time, before any review session spends a model
call, is what the epic's mechanical step is for.

## Decision

**1. Two new shape severities, read off the body alone.** `leafNoDescription`
and `leafNoCriteria` in `lib/workItems/proseVsGraph.ts`:

- `leaf-no-description` — the description is null or blank.
- `leaf-no-criteria` — the body is not blank and has no enumerated criterion
  under `## Acceptance criteria`; `criteria` is `no-heading` when the heading is
  absent and `no-criterion` when it is there with nothing under it. The body is
  parsed with the same section parse `under-authored` uses, so the two words
  mean exactly what they mean there.

Points, estimate, type and executor are NOT read. Sizing or typing a card does
not give it a body. A blank body is reported once, as no description, never also
as missing criteria: the remedy for both is "write the body", and two findings
would ask for it twice.

**2. A null check, so it is mechanised.** Every input is an absent body or an
absent list item. There is no threshold and no wording to judge, which is the
same reason the under-authored family is mechanised and the sizing advisory
`CORPUS-MAINTENANCE.md` rejected is not.

**3. Advisory only, and only on the plan reads.** The builder's `runnerStops`
option is off by default and `planValidityService` alone turns it on, so the two
projected reads (`validate_plan`, and `validate_work_item` with a `planId`)
report them, while `validate_work_item` without a plan, the dispatch prompt and
`claim_next_ready` return byte-identical payloads. Nothing in `valid` or
readiness moves. A card is routinely saved mid-authoring, and a gate would make
the tracker unusable as a scratchpad (the under-authored record's argument); the
plan read is where a planner seals cards, so that is where the finding belongs.

**4. The exemptions — `isLeafBodyCheckExempt`, one predicate for the family.**
The runner does not stop on these cards for an empty body or missing criteria:

- **A card with children.** Its body is its subtree's; the runner builds the
  children, never the container's own body.
- **A container kind (epic, story).** The same reason before the children are
  laid: a childless story waiting for its children is not a leaf.
- **`type: design`.** Its deliverable is a mock and a note file judged at the
  design gate, not code criteria a pull request discharges.
- **`executor: human`.** A person does the work and confirms it on its gate; no
  runner reads the body.

**5. The `runnerStop` field and the `RUNNER_STOP_SEVERITIES` tuple.** Each
runner-stop advisory carries the literal `runnerStop: true`, and its severity is
a member of the exported `RUNNER_STOP_SEVERITIES` (`lib/dto/workItems.ts`). A
reader such as the hosted planner's repair pass keys on that field, never on a
criterion index, because the body members have none. No pre-existing advisory
carries the field, so their payloads are unchanged. A runner stop added to the
family adds its severity to the tuple and carries the field.

**6. The accepted overlap with `under-authored`.** A bare, typeless, unsized leaf
with no criteria fires both `under-authored` and the runner-stop member
(`leaf-no-description` for a blank body, `leaf-no-criteria` otherwise). That is
accepted rather than suppressed: `under-authored`'s payload and firing conditions
are fixed for the clients that read it today, and the runner-stop member is the
one a repair pass keys on.

## Consequences

- A typed and sized leaf with an empty body or no criteria is reported at plan
  time, with no model call.
- The v1 dispatch advisory union gains one member (contract `1.78.0`); the
  dispatch path does not emit it today.
- The hosted planner reads `runnerStop` to hand these to its repair pass
  (MOTIR-10382, in motir-ai).

## What this does NOT decide

- Whether a description or a criterion is good. It reads presence only.
- Whether a card should be split or sized differently.
- Anything about readiness, dispatch or a save: none of them refuses on these.
- The two-repository runner stop, which is its own member of the family.
