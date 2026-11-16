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
`docs/decisions/platform-staff-auth.md` §2 (the 2026-11-16 amendment). Every
route is **operator** level. A request is admitted with either:

- **a personal access token** in `Authorization: Bearer motir_pat_…`, whose
  OWNER currently holds `operator` or above. No token permission is consulted. A
  run token, a revoked, expired or unknown token, and a token of a suspended
  organization are all refused; or
- **the staff member's console session** (no `Authorization` header).

Every refusal is the same **`404 { "code": "NOT_FOUND" }`**, as on the ideas
routes. Every call writes a platform audit row in the same transaction as the
motir-ai call, naming the credential in `metadata.credential`
(`{ "kind": "token", "apiTokenId": "…" }` or `{ "kind": "session" }`): reads as
`estate.read`, a create as `planner_finding.record`, a verdict as one
`planner_finding.verdict` per finding it changed (one on the record when it
changed none). A motir-ai error leaves no row.

Every response carries `Cache-Control: no-store`.

## Routes

| Method & path                                              | Body / query                                                                                                   | Success                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /api/platform/planner-findings/{findingId}`           | —                                                                                                              | `200 Finding` (with its `recordId`)                       |
| `GET /api/platform/planner-findings/records`               | `?verdictState=open\|attributed&planner=&source=&planId=&createdFrom=&createdTo=&cursor=&limit=` (limit 1–100) | `200 { records: RecordSummary[], nextCursor, retention }` |
| `GET /api/platform/planner-findings/records/{id}`          | —                                                                                                              | `200 { record: Record, findings: Finding[] }`             |
| `POST /api/platform/planner-findings/records`              | `CreateRecord`                                                                                                 | `201 { record: Record, findings: Finding[] }`             |
| `POST /api/platform/planner-findings/records/{id}/verdict` | `{ verdicts: Verdict[], replace? }`                                                                            | `200 { record, findings, audit: VerdictAudit[] }`         |

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
  ]
}
```

- **The tenant comes from core, never the body.** A `planId` that names a stored
  plan gives the record its organisation, workspace and project, and the plan's
  session, source job, title and author model (a body value fills only what the
  plan lacks; the body's title and model win).
- **When no plan resolves** — the plan was deleted, or no `planId` was sent —
  `projectKey` names the project instead, resolved in `workspaceId`, else in the
  workspace the token was minted in, under the same tenant rules as the
  `record_planner_finding` tool (membership and `ai:plan`). A console session must
  send `workspaceId`. Without a `planId` the record is stored under the text
  `(no plan id given)`.
- `source` is always `check_plan`; 1–100 findings, all stored or none.

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
| 409    | `{ code: "CONFLICT", detail }`                             | the record already has a verdict and `replace` is not `true`             |
| 503    | `{ code: "UPSTREAM_UNAVAILABLE" }`                         | motir-ai cannot answer                                                   |
