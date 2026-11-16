# The platform planner-findings API

Story MOTIR-11455 · MOTIR-11458. The staff HTTP surface over motir-ai's planner
finding RECORDS: the door the private `motir check plan` skill stores one plan
check through, reads a record or a finding back through, and gives a record its
verdict through. It is a **platform** surface, not part of the tenant API
(`/api/v1`), so it is not in the OpenAPI contract; this document is its contract.
Behind it, core forwards to motir-ai's `/v1/admin/planner-finding-records` and
`/v1/admin/planner-findings/:id` (motir-ai `docs/contract.md`).

## Who may call it

Every route is gated by `requirePlatformStaffForPlannerFindings`
(`lib/platform/plannerFindingsGate.ts`), recorded in
`docs/decisions/platform-staff-auth.md` §2 (the 2026-11-16 amendment). **The
level is set per route**, in the routes table's Level column: each handler passes
its level to the gate as a named constant from `lib/services/plannerFindingsService.ts`,
and the records service re-asserts the same constant, so a route's level is one
argument and one constant. The three reads are **`support`** level, the
console's own read level; every write is **`operator`**.
`tests/platform/plannerFindingsRouteLevels.test.ts`
fails a handler that passes a literal, and a write route below `operator`. A
request is admitted with either:

- **a personal access token** in `Authorization: Bearer motir_pat_…`, whose
  OWNER currently holds the route's level or above. No token permission is consulted. A
  run token, a revoked, expired or unknown token, and a token of a suspended
  organization are all refused; or
- **the staff member's console session** (no `Authorization` header).

Every refusal is the same **`404 { "code": "NOT_FOUND" }`**, as on the ideas
routes. Every call writes a platform audit row in the same transaction as the
motir-ai call, naming the credential in `metadata.credential`
(`{ "kind": "token", "apiTokenId": "…" }` or `{ "kind": "session" }`): reads as
`estate.read`, a create as `planner_finding.record`, a verdict as one
`planner_finding.verdict` per finding it changed (one on the record when it
changed none), a link as `planner_finding.link` and an unlink as
`planner_finding.unlink`, one per change of the record's key set. A motir-ai
error, and a refused or no-op link or unlink, leaves no write row.

Every response carries `Cache-Control: no-store`.

## Routes

| Method & path                                                   | Body / query                                                                                                   | Success                                                   | Level                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/platform/planner-findings/{findingId}`                | —                                                                                                              | `200 Finding` (with its `recordId`)                       | `support` (`PLANNER_FINDING_RECORDS_READ_LEVEL`) |
| `GET /api/platform/planner-findings/records`                    | `?verdictState=open\|attributed&planner=&source=&planId=&createdFrom=&createdTo=&cursor=&limit=` (limit 1–100) | `200 { records: RecordSummary[], nextCursor, retention }` | `support` (`PLANNER_FINDING_RECORDS_READ_LEVEL`) |
| `GET /api/platform/planner-findings/records/{id}`               | —                                                                                                              | `200 { record: Record, findings: Finding[] }`             | `support` (`PLANNER_FINDING_RECORDS_READ_LEVEL`) |
| `POST /api/platform/planner-findings/records`                   | `CreateRecord`                                                                                                 | `201 { record: Record, findings: Finding[] }`             | `operator` (`PLANNER_FINDING_RECORDS_LEVEL`)     |
| `POST /api/platform/planner-findings/records/{id}/verdict`      | `{ verdicts: Verdict[], replace? }`                                                                            | `200 { record, findings, audit: VerdictAudit[] }`         | `operator` (`PLANNER_FINDING_RECORDS_LEVEL`)     |
| `POST /api/platform/planner-findings/records/{id}/links`        | `{ key }`                                                                                                      | `200 { record: Record, changed: true }`                   | `operator` (`PLANNER_FINDING_RECORDS_LEVEL`)     |
| `POST /api/platform/planner-findings/records/{id}/links/remove` | `{ key }`                                                                                                      | `200 { record: Record, changed }`                         | `operator` (`PLANNER_FINDING_RECORDS_LEVEL`)     |

The answers are motir-ai's own shapes, unchanged: `Record`, `RecordSummary`
(`Record` + `findingCount` + `attributedCount`), `Finding` and `VerdictAudit` are
the ones motir-ai's contract documents.

### `CreateRecord`

```json
{
  "planId": "a core plan id (optional)",
  "projectKey": "MOTIR (needed when planId names no stored plan)",
  "workspaceId": "where projectKey is resolved (optional with a token)",
  "planner": "hosted | plan_py",
  "planSessionId": "…",
  "jobId": "…",
  "planTitle": "…",
  "authorModel": "…",
  "baseline": { "branch": "main", "commit": "abc123" },
  "findings": [
    {
      "site": "…",
      "prediction": "STOPS | SETTLES | THRU",
      "whatHappened": "…",
      "evidence": "…",
      "outcome": "fixed | reported | fix_failed",
      "cardRef": "…",
      "authorSessionKey": "…",
      "correction": "…",
      "rule": "path:line",
      "defectClass": "…",
      "attribution": "code | corpus | model | unattributed",
      "why": "…",
      "hostedCell": "…",
      "planpyCell": "…",
      "fixDirection": "…"
    }
  ],
  "runThroughAnswer": "THRU | STOPS (optional)",
  "runThroughStopCards": ["MOTIR-12", "planItem:…"]
}
```

- **The tenant comes from core, never the body.** A `planId` that names a stored
  plan gives the record its organisation, workspace and project, and the plan's
  session, source job, title and author model (a body value fills only what the
  plan lacks; the body's title and model win).
- **When no plan resolves** — the plan was deleted, or no `planId` was sent —
  `projectKey` names the project instead, resolved in `workspaceId`, else in the
  workspace the token was minted in: the staff member must be a member of that
  project holding `ai:plan` (`PLANNER_FINDING_RECORD_PROJECT_PERMISSION`). A console session must
  send `workspaceId`. Without a `planId` the record is stored under the text
  `(no plan id given)`.
- `source` is always `check_plan`; 1–100 findings, all stored or none.
- **The check's run-through answer** (MOTIR-11511) is optional and passed through
  as sent: `runThroughAnswer` is `THRU` or `STOPS` only
  (`PLANNER_FINDING_RUN_THROUGH_ANSWERS`; `SETTLES` is refused), and
  `runThroughStopCards` is 0–100 non-empty card refs, a work-item key or a
  plan-item ref, whose format core does not check. Core never derives, defaults
  or repairs the answer, and a verdict cannot change it.

### The record's run-through fields

Every `Record` — on the create, the list rows, the read and the verdict — carries
`runThroughAnswer` and `runThroughStopCards`. A record stored without an answer
answers `runThroughAnswer: null` (and `runThroughStopCards: []`) rather than
raising; `null` is the only reading of "no answer recorded". What the two fields
mean is motir-ai's: see the record DTO in its `docs/contract.md`.

### Links — a record's planning bugs

`{ key }` is one work-item key, 1–64 characters, trimmed and upper-cased. A link
or unlink is refused unless the record already has its verdict. Core resolves the
key to a work item in the RECORD's own project (never the caller's), so a key from
another project or tenant reads as no work item, and motir-ai stores it as text in
the record's `linkedBugKeys`. An unlink of a key the record no longer carries
answers the record as it stands with `changed: false` and writes nothing, so two
staff members removing one key never collide. Linking creates, edits or moves no
work item, and is independent of a finding's own triage bug key.

### `Verdict`

`{ findingId, attribution: "code | corpus | model | unattributed", why, hostedCell?, planpyCell?, fixDirection? }`
— one per finding of the record, each exactly once. `replace: true` overwrites a
record that already has a verdict.

## Errors

| Status | Body                                                       | When                                                                     |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| 400    | `{ code: "INVALID_REQUEST", issues: [{ path, message }] }` | malformed JSON or shape; a create naming neither a stored plan nor a key |
| 400    | `{ code: "UPSTREAM_REJECTED", detail }`                    | motir-ai refused the content (a missing finding, an empty `why`, …)      |
| 404    | `{ code: "NOT_FOUND" }`                                    | every gate refusal                                                       |
| 404    | `{ code: "PROJECT_NOT_FOUND" }`                            | a `projectKey` the staff member cannot record in                         |
| 404    | `{ code: "PLANNER_FINDING_NOT_FOUND", findingId }`         | an unknown finding                                                       |
| 404    | `{ code: "PLANNER_FINDING_RECORD_NOT_FOUND", recordId }`   | an unknown record                                                        |
| 400    | `{ code: "LINK_REFUSED", reason: "not_a_work_item" }`      | a link key naming no work item in the record's project                   |
| 409    | `{ code: "CONFLICT", detail }`                             | the record already has a verdict and `replace` is not `true`             |
| 409    | `{ code: "LINK_REFUSED", reason: "already_linked" }`       | a link key already in the record's set                                   |
| 409    | `{ code: "LINK_REFUSED", reason: "record_open" }`          | a link or unlink on a record with no verdict yet                         |
| 503    | `{ code: "UPSTREAM_UNAVAILABLE" }`                         | motir-ai cannot answer                                                   |
