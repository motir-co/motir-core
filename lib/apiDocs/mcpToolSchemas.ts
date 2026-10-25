// ⚠️ GENERATED — DO NOT EDIT. Run `pnpm generate:mcp-tool-schemas`.
//
// Every MCP tool's `inputSchema` (Story MOTIR-3875 · Subtask MOTIR-4389), and
// its `title` and `annotations` (Story MOTIR-6974 · Subtask MOTIR-7002) —
// three values, exactly as `tools/list` serves them. Written by
// `scripts/generateMcpToolSchemas.ts` from a live handshake against
// `buildMcpServer`, and pinned byte-for-byte against a fresh one by
// `tests/mcp/tool-schema-truth.test.ts` — so this file cannot drift from the
// server, and a hand edit is red rather than published.
//
// ── Why the schemas are copied HERE at all ──────────────────────────────────
// `lib/apiDocs/mcp.ts` is a LEAF: it imports `lib/mcp/toolPermissions.ts` and
// nothing else from `lib/mcp/`, so that the anonymous
// `GET /api/docs/mcp-tools.json` handler does not pull the tool registry, the
// services and Prisma behind it. The schemas and titles live inside
// `registerTool(...)` calls that only the registry can reach, and the hints are
// what the registration seam injects there. This module is the seam: a value the
// registry produced, in a file that imports nothing at runtime.
//
// Each map is TOTAL over the tool set by TYPE — a tool added to the registry
// forces a `TOOL_PERMISSIONS` entry, which makes this annotation incomplete and
// this file a compile error until it is regenerated.

import type { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import type { McpToolHints, McpToolInputSchema } from './mcpToolSchema';

/** Tool name → the draft-07 JSON Schema of its arguments. */
export const MCP_TOOL_INPUT_SCHEMAS: Record<keyof typeof TOOL_PERMISSIONS, McpToolInputSchema> = {
  add_comment: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description: 'The comment body (Markdown). Mention a member with @[name](userId).',
      },
    },
    required: ['key', 'body'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  add_lesson: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description:
          'The takeaway, in one line — the thing a planner should do differently, not a headline for an incident. "Pin the target repository on every card that ships code" is a lesson; "Repository problems in the billing epic" is a label for one.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description:
          'What goes wrong, stated so it is recognisable the NEXT time rather than recounted from the last. Describe the situation and the failure, not the specific work items it happened to involve.',
      },
      why: {
        type: 'string',
        minLength: 1,
        description:
          'Why it matters — the cost of getting it wrong. This is the one field that may carry the specifics of your own case (what it cost, when, on which work), because it is what justifies the rule rather than what a future plan is matched against.',
      },
      howToApply: {
        type: 'string',
        minLength: 1,
        description:
          'The actionable rule, addressed to a future planner in the second person: "Before sealing a card that ships code, set its target repository." Not a restatement of the body — if this field reads like the body, the lesson has no rule in it.',
      },
      mistakeType: {
        type: 'string',
        enum: ['onboarding_planning', 'regular_planning', 'planning_craft'],
        default: 'regular_planning',
        description:
          'Which kind of planning this lesson is for: "regular_planning" (planning an existing project — the usual answer), "onboarding_planning" (drafting a project\'s first tree), or "planning_craft" (how to plan well, whatever is being planned).',
      },
      kinds: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['project', 'onboarding', 'epic', 'story', 'task', 'bug', 'subtask'],
        },
        description:
          'WHICH LEVEL this lesson is about — a work-item KIND, or "project" / "onboarding" for a mistake made laying a project\'s top level ("onboarding" when that plan is carved from the direction docs) — and one of the three axes that decide when a future plan is shown it. A mistake made LAYING a level is filed under the level laid under, not the kind of its children. LEAVING IT OUT MEANS "every kind" — occasionally right, and usually the reason a lesson turns up in plans it has nothing to do with. Say what you mean on each axis rather than skipping it.',
      },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'code',
            'design',
            'test',
            'content',
            'copy',
            'translate',
            'research',
            'review',
            'verification',
            'decision',
            'choice',
            'deploy',
            'manual',
            'legal',
            'chore',
          ],
        },
        description:
          'WHICH WORK TYPES this lesson is about (code, design, test, …). Leaving it out means "every type". Under-claiming is as wrong as over-claiming: a lesson typed only "code" stops reaching the chore work it also applies to.',
      },
      phases: {
        type: 'array',
        items: { type: 'string', enum: ['lay', 'author'] },
        description:
          'WHICH PLANNING PHASE this lesson is about: "lay" (laying a level\'s children — shape, edges, coverage) or "author" (writing one card\'s body — criteria, sizing, claims). Leaving it out means both. The retired spellings "skeleton" and "deepen" are still accepted and read as "lay" and "author"; they are removed in a later release.',
      },
      subject: {
        type: 'string',
        description:
          'WHICH SUBJECT MATTER this lesson is about — the FOURTH routing axis, mirroring the rule-pack selector\'s fourth coordinate so the two corpora stay reachable by one question. Leaving it out means "every subject", and that is the right answer far more often than the vocabulary suggests: a WRONG subject is worse than none, because it makes the lesson unreachable from every card it actually applies to, while an untagged one still reaches all of them. ⚠️ SCALAR, unlike the three axes above — a lesson carries ONE subject or none, never a list, and a payload sending several is REFUSED rather than coerced (a card wanting two subjects is a SPLIT signal, so a lesson captured from one cannot inherit a multiplicity its source never had). A lesson that genuinely applies across subjects carries NONE — it is more general than either, which is what omitting this says. MEMBERSHIP IS NOT VALIDATED: the vocabulary is the rule-pack file set, so a well-formed unrecognised member is accepted and simply never matches a subject-narrowed query. Shape only: a lowercase slug.',
      },
      sourceRef: {
        type: 'string',
        description:
          'Where this lesson came from — a work-item key, a runbook name, a ticket. Also the idempotency key: adding the same lesson again with the same sourceRef returns the existing one instead of a duplicate.',
      },
    },
    required: ['projectKey', 'title', 'body', 'why', 'howToApply'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  add_plan_items: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'modify', 'remove'],
              description: 'add a new item, modify one, or remove one.',
            },
            workItemId: {
              type: 'string',
              description: '`modify` / `remove` only: the existing target work item’s id.',
            },
            proposedFields: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  minLength: 1,
                  description: 'The proposed item’s title. Required on an `add`.',
                },
                kind: {
                  type: 'string',
                  enum: ['epic', 'story', 'task', 'bug', 'subtask'],
                  description:
                    'The proposed kind. Defaults to `task` (a standalone leaf) when omitted.',
                },
                descriptionMd: { type: 'string', description: 'Markdown body — WHAT to do.' },
                sections: {
                  type: 'object',
                  additionalProperties: {},
                  description:
                    'OPTIONAL. The card’s sections as named values, instead of composing headings inside `descriptionMd`: the door checks them against the section set for the proposal’s kind × type, refuses a missing, unknown or invalid section BY NAME with INVALID_PROPOSAL, writes the headings itself and stores ONLY the rendered `descriptionMd` — `sections` itself is never stored. Never send it together with `descriptionMd` (refused, naming both). The section sets, their shapes and which are required are served by `get_section_sets`. On an EDIT it is sparse at the section key: the stored body is read back into its sections first, a section you omit is kept, an explicit `null` clears one, and a list REPLACES the list. Omit it to keep sending a plain `descriptionMd` exactly as before.',
                },
                explanationMd: { type: 'string', description: 'Markdown body — WHY it matters.' },
                type: {
                  type: 'string',
                  enum: [
                    'code',
                    'design',
                    'test',
                    'content',
                    'copy',
                    'translate',
                    'research',
                    'review',
                    'verification',
                    'decision',
                    'choice',
                    'deploy',
                    'manual',
                    'legal',
                    'chore',
                  ],
                  description:
                    'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum, so anything else is refused here rather than 500ing at approve.',
                },
                priority: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                executor: { type: 'string', enum: ['coding_agent', 'human'] },
                storyPoints: {
                  type: 'number',
                  description:
                    'Agile sizing. Validated at the boundary exactly as the create path validates it.',
                },
                estimateMinutes: { type: 'integer', description: 'Estimated minutes of work.' },
                difficulty: {
                  type: 'string',
                  enum: ['trivial', 'low', 'medium', 'high'],
                  description:
                    'How hard the work is to REASON about, not how big it is (that is `storyPoints` / `estimateMinutes`): "trivial", "low", "medium", "high", easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped. Omit it to leave the proposal without one.',
                },
                targetRepo: {
                  type: 'string',
                  description:
                    'WHICH REPO the item ships in — validated against the project’s set at approve.',
                },
                targetRepos: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'EVERY repository this item ships in, ORDERED — the first element is the PRIMARY dispatch routes to, and the item does not complete until every one of them has a merged pull request. Bare names or the `owner/name` form, validated against the PROJECT’s repository domain at approve by the same resolver `create_work_item` uses. MUTUALLY EXCLUSIVE with `targetRepo` and `targetRepositories` — one field, three spellings — and supplying two is rejected here rather than silently resolved. `[]` is the empty set.',
                },
                targetRepositories: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The same axis as `targetRepos`, as the project’s repository ROW IDS, ORDERED. Prefer it when you have the ids: a reference survives a rename and can name one of two rows that share a role, which a name cannot. Mutually exclusive with the two fields above.',
                },
                targetRepositoryRef: {
                  type: 'string',
                  description:
                    'The singular `project_repository` ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) — the reference-native spelling for the proposal that ships in ONE repository named by row. It is the only pin that can name one of two rows sharing a role. MUTUALLY EXCLUSIVE with the other repository spellings on the same proposal.',
                },
                targetRepoRole: {
                  type: 'string',
                  description: 'The PORTABLE repo pin — a role of the project’s repository set.',
                },
                todos: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: {
                        type: 'string',
                        description:
                          'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                      },
                      notesMd: {
                        type: ['string', 'null'],
                        description:
                          'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                      },
                      commandText: {
                        type: ['string', 'null'],
                        description:
                          'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                      },
                      executor: {
                        anyOf: [
                          { type: 'string', enum: ['coding_agent', 'human'] },
                          { type: 'null' },
                        ],
                        description:
                          'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                      },
                    },
                    required: ['text'],
                    additionalProperties: false,
                  },
                  description:
                    'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children.',
                },
                subject: {
                  type: 'string',
                  description:
                    'WHICH SUBJECT MATTER to compose this leaf’s rule packs from — the FOURTH selector coordinate, `pack(phase, kind, type, subject)`. DERIVE IT AT `lay`, beside `type`, so the coordinate is written BEFORE an authoring pass composes its prompt: a value written afterwards is a default rather than a selector. OMIT IT when no member clearly fits — a wrong member composes rules whose situation cannot occur for this card while looking deliberate, and omission is the right answer far more often than the vocabulary suggests. A leaf has ONE subject: wanting two is a SPLIT signal, exactly as wanting two repositories is. MEMBERSHIP IS NOT VALIDATED HERE — the vocabulary is the rule-pack file set, so a well-formed unrecognised member is accepted and refused one hop later by the rule-pack resolver. Shape only: a lowercase slug of at most 32 characters. Legal on EVERY kind — a container carries one too.',
                },
              },
              required: ['title'],
              additionalProperties: false,
              description: 'The proposed item’s fields. Required on an `add`, ignored otherwise.',
            },
            patch: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Re-title the target.' },
                descriptionMd: {
                  type: ['string', 'null'],
                  description: 'Markdown body — WHAT to do. An explicit `null` clears it.',
                },
                explanationMd: {
                  type: ['string', 'null'],
                  description:
                    'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a re-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you rewrite it, and a stale WHY is worse than a null one.',
                },
                priority: {
                  anyOf: [
                    { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                    { type: 'null' },
                  ],
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                      enum: [
                        'code',
                        'design',
                        'test',
                        'content',
                        'copy',
                        'translate',
                        'research',
                        'review',
                        'verification',
                        'decision',
                        'choice',
                        'deploy',
                        'manual',
                        'legal',
                        'chore',
                      ],
                    },
                    { type: 'null' },
                  ],
                  description:
                    'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An explicit `null` clears it.',
                },
                kind: {
                  type: 'string',
                  enum: ['story', 'task', 'bug', 'subtask'],
                  description:
                    'RE-KIND the target — the plan door’s `change_kind` (never `epic`). Judged against the PROJECTED tree: the parent must admit the new kind, the new kind must admit every child the target keeps, and re-kinding a leaf into a `story` must clear its leaf fields in the same patch (`type: null`, `difficulty: null`) or it is refused by name. The executor is not a patch key: a re-kind to a container clears it at approve.',
                },
                storyPoints: {
                  type: ['number', 'null'],
                  description: 'Re-scope the agile sizing. An explicit `null` clears it.',
                },
                estimateMinutes: {
                  anyOf: [{ type: 'integer' }, { type: 'null' }],
                  description: 'Re-scope the time estimate. An explicit `null` clears it.',
                },
                difficulty: {
                  anyOf: [
                    { type: 'string', enum: ['trivial', 'low', 'medium', 'high'] },
                    { type: 'null' },
                  ],
                  description:
                    'Re-judge the target’s difficulty. How hard the work is to REASON about, not how big it is (that is `storyPoints` / `estimateMinutes`): "trivial", "low", "medium", "high", easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped. Judged on the target’s MERGED kind. An explicit `null` clears it.',
                },
                todos: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          text: {
                            type: 'string',
                            description:
                              'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                          },
                          notesMd: {
                            type: ['string', 'null'],
                            description:
                              'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                          },
                          commandText: {
                            type: ['string', 'null'],
                            description:
                              'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                          },
                          executor: {
                            anyOf: [
                              { type: 'string', enum: ['coding_agent', 'human'] },
                              { type: 'null' },
                            ],
                            description:
                              'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                          },
                        },
                        required: ['text'],
                        additionalProperties: false,
                      },
                    },
                    { type: 'null' },
                  ],
                  description:
                    'REPLACE the target’s ordered steps (its to-do list). Approve makes the list exactly this array, in order, none ticked, and DELETES every existing row — ticked ones included; the review and `get_plan` show how many steps that drops and how many were ticked. Omit the key to leave the list alone; `[]` or `null` clears it. Leaf kinds only (judged on the target’s MERGED kind). Not a mark key: a `modify` of a done or cancelled card that carries it is refused.',
                },
                targetRepo: {
                  type: ['string', 'null'],
                  description: 'RE-PIN which repo the item ships in. An explicit `null` unpins it.',
                },
                targetRepos: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'RE-PIN the target’s WHOLE repository set, ordered, first element primary. Omit the key to leave it alone; `[]` unpins the card entirely. Mutually exclusive with `targetRepo` and `targetRepositories` on the same patch.',
                },
                targetRepositories: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'The same re-pin, as the project’s repository ROW IDS. Mutually exclusive with the two fields above.',
                },
                targetRepositoryRef: {
                  type: ['string', 'null'],
                  description:
                    'RE-PIN the target’s repo ROW (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) — the `modify` mirror of the `add` path’s row pin, for the re-plan that moves work to a specific row the role cannot name. An explicit `null` unpins it.',
                },
                targetRepoRole: {
                  type: ['string', 'null'],
                  description: 'RE-PIN the portable repo role. An explicit `null` unpins it.',
                },
                parentRef: {
                  type: ['string', 'null'],
                  description:
                    'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. Omit the key to leave the parent where it is. It may also be a `planItem:<id>` ref naming an `add` ALREADY on this plan (from an earlier call), to move an existing card under a card this plan creates; approve creates the `add` first, then moves the card. The move is checked against the tree the plan would produce — the kind-parent matrix, no cycle (never under a proposal this plan creates BELOW the card), the depth cap, and a refusal to hang new work under a FINISHED parent. Or `folder:<folderId>` to FILE the target into a folder of this project instead of under a work item — any kind may be filed, `subtask` included, and an unknown folder or another project’s is refused at the append.',
                },
                blockedByAdd: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs. Each joins the target to an item on the SAME LEVEL — the same depth below their nearest common ancestor — under any parent; a cross-level edge is refused `cross_level`. An epic is blocked only by another epic.',
                },
                blockedByRemove: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
                },
                obsolescence: {
                  anyOf: [{ type: 'string', enum: ['outdated', 'deprecated'] }, { type: 'null' }],
                  description:
                    'MARK the target as no longer TRUE OF THE CODE: "outdated" or "deprecated" — "outdated" when the text no longer describes what shipped (the capability lives on in another shape), "deprecated" when it was retired or overturned on purpose. An explicit `null` clears it; omit it to leave the mark alone. A value outside the enum is refused INVALID_PROPOSAL. A plan may SET a mark only on a FINISHED target — one whose status is in the `done` category (`done`, `cancelled`, or a custom done status). On a to-do or in-progress target it is refused with INVALID_PROPOSAL: "a plan may mark only a finished work item; <KEY> is at <status>. A work item nobody will finish is removed — send `{ op: \'remove\', workItemId, reason }` instead." (at the append, at `update_plan_proposal`, and again at approve, where `validate_plan` reports it). Clearing a mark (`null`) is legal on any target. A MARK-ONLY `modify` — a patch carrying nothing but `obsolescence`, `obsolescenceNoteMd` and the four supersedes lists — is the ONE change a plan may make to a `done` or `cancelled` card; approve writes it and leaves the card’s status alone. Add any other key and the target is refused PLAN_TARGET_IMMUTABLE. Marking is never archiving: the card stays in the tree, and a `remove` never marks anything.',
                },
                obsolescenceNoteMd: {
                  type: ['string', 'null'],
                  description:
                    'The Markdown note saying WHY the target is marked — what changed and what to read instead. Independent of `obsolescence` (clearing the mark keeps the note); an explicit `null` clears it. A mark key: legal in a mark-only `modify` of a `done` / `cancelled` card.',
                },
                supersedesAdd: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'On the NEWER card: the target REPLACES each listed card. Each entry names an OLDER card; approve writes one `supersedes` link from the target to it. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. Unioned with an earlier `modify` of the same card; the same ref in `supersedesRemove` cancels it. A mark key.',
                },
                supersedesRemove: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'On the NEWER card: DELETE the `supersedes` link from the target to each listed (older) card at approve; a link that does not exist is a no-op. Same ref forms as `supersedesAdd`. A mark key.',
                },
                supersededByAdd: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'On the OLD card: `supersededByAdd` names the card that REPLACES it. Each entry names a NEWER card; approve writes one `supersedes` link from it to the target — the same row the newer card’s `supersedesAdd` would write, so spelling one edge from both ends lands one link. This is the list a mark on a done card usually needs beside `obsolescence`. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. A mark key.',
                },
                supersededByRemove: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'On the OLD card: DELETE the `supersedes` link from each listed (newer) card to the target at approve; a link that does not exist is a no-op. Same ref forms as `supersededByAdd`. A mark key.',
                },
              },
              additionalProperties: true,
              description:
                '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone approves the plan in Motir.',
            },
            parentRef: {
              type: 'string',
              description:
                'Where the proposed item hangs, in any of THREE forms: a work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a real work-item id; or `planItem:<id>` naming another `add` in THIS plan — an id this tool returned in `planItemIds` on an earlier call. A key is resolved to its id when the proposal is appended, so the three are interchangeable; a key that names no work item in this workspace is refused HERE, not at approve. OR, instead of a work-item parent, `folder:<folderId>` FILES the item into a folder of this project: it is then a root, any kind may be filed (`subtask` included), and an unknown folder or another project’s is refused HERE.',
            },
            blockedByRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Dependency edges, in the same three forms as `parentRef`: work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs into this plan. A `folder:<id>` ref is refused here — a folder is a placement, it blocks nothing. An edge joins two items on the SAME LEVEL — the same depth below their nearest common ancestor, a folder adding none — and may cross parents; one between two levels is refused `INVALID_PLAN_REF_GRAPH` / `cross_level`. An epic is blocked only by another epic — an edge with an epic at either end is cross-level unless both ends are epics.',
            },
            supersedesRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                '`add` only: the OLDER cards the created card REPLACES. Approve writes one `supersedes` link from the new card to each. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. Refused on a `modify` (it spells its edges on the patch: `supersedesAdd` / `supersededByAdd`) and on a `remove`. This does NOT mark the older card — to mark it `outdated`, send a mark-only `modify` of it with `supersededByAdd: ["planItem:<this add>"]` in a LATER call.',
            },
            baseRevision: {
              type: 'string',
              description:
                '`modify` / `remove` only: the target revision the change was computed against.',
            },
            reason: {
              type: 'string',
              description:
                '`remove` ONLY: WHY the card is being removed — shown to the reviewer beside the removal and written into the archived card’s history at approve. Trimmed, then 1–2000 characters. Refused on an `add` or a `modify`, and refused when blank; omit it to send none.',
            },
          },
          required: ['op'],
          additionalProperties: false,
        },
        description:
          'The batch to append, in the order you want their ids back. MAY be empty — but ONLY together with `final: true`, which is how a titles-first pass CLOSES a plan it has finished writing.',
      },
      final: {
        type: 'boolean',
        description:
          'Set true on the LAST batch to close the plan (`generating` → `planned`), which is what puts it in front of a person for review. After that, an append needs `revision: true`. Send it with an EMPTY `proposals` array to close a plan you have nothing left to append to.',
      },
      revision: {
        type: 'boolean',
        description:
          'Set true to append to a plan you have ALREADY closed — a plan that is `planned` and in the review queue. Without it such an append is refused. The plan does NOT re-open: it is `planned` before, during and after, and the append is recorded on its timeline with the harness and model that made it, so the reviewer can see a card arrived after they started reading. It cannot be combined with `final` (the plan is already closed) and requires at least one proposal (there is nothing else it could mean). On a `generating` plan it is unnecessary and simply does nothing. `approved` and `declined` stay frozen.',
      },
    },
    required: ['planId', 'proposals'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  add_work_item_todo: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      text: {
        type: 'string',
        minLength: 1,
        description:
          'The step — ONE operation, in plain text (not Markdown), at most 200 characters. A longer step is two steps, and is refused rather than truncated.',
      },
      notesMd: {
        type: 'string',
        description:
          'Optional instructions for this one step, in Markdown, at most 2000 characters — the how, where `text` is the what.',
      },
      commandText: {
        type: 'string',
        description:
          'Optional command this step runs, at most 500 characters. Rendered with a copy button on the work item page.',
      },
      executor: {
        type: 'string',
        enum: ['coding_agent', 'human'],
        description:
          'Who this step is for: "human" or "coding_agent". Declarative — it authorizes nothing. Omitted ⇒ the card’s own executor, or "human" when the card has none.',
      },
      language: {
        type: 'string',
        enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
        description:
          "Optional: the language every text field this call writes is in — one of en, zh, ja, ko, de, fr, es, it, nl, pl, pt. Omit it to record the organisation's content language.",
      },
      languages: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
          notes: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
        },
        additionalProperties: false,
        description:
          'Optional: the language of each text field this call writes (text, notes), winning over `language` for that field.',
      },
    },
    required: ['key', 'text'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  append_plan_turn: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET describes what the conversation is about — order and duplicates do not matter.',
      },
      sessionId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. The `id` of the planning session to address — the `id` that `open_plan_session`, `append_plan_turn` and `submit_plan_session` return. Pass it on every later call to keep talking to the SAME conversation. Omit it to use your own recent session for this scope (active in the last 2 hours), or to start a new one.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description: 'What to say in this turn — what you want changed about the plan.',
      },
    },
    required: ['projectKey', 'body'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  archive_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
      action: {
        type: 'string',
        enum: ['archive', 'restore'],
        description:
          '`archive` (the default) archives the page with its live sub-pages; `restore` brings an archived page back, with the sub-pages that left with it.',
      },
    },
    required: ['projectKey', 'pageId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  archive_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  attach_file: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      filename: {
        type: 'string',
        minLength: 1,
        description: 'The file name as a reader should see it, e.g. "findings.md" or "triage.png".',
      },
      contentType: {
        type: 'string',
        minLength: 1,
        description:
          'The file’s media type, e.g. "image/png" or "text/markdown". Must be on the upload allowlist; "text/html" is deliberately refused (415) — an HTML design mock has its own publisher.',
      },
      contentBase64: {
        type: 'string',
        minLength: 1,
        description: 'The file’s bytes, base64-encoded.',
      },
    },
    required: ['key', 'filename', 'contentType', 'contentBase64'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  change_kind: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      kind: {
        type: 'string',
        enum: ['story', 'task', 'bug', 'subtask'],
        description:
          "The new work item kind. Must keep the kind-parent matrix legal for both the item's current parent AND all of its children. (This is the hierarchy KIND, NOT the work type — use update_work_item to change type/executor/difficulty.)",
      },
    },
    required: ['key', 'kind'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_next_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_work_item_continue: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_work_item_repair: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  close_work_item_continue: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      runId: {
        type: 'string',
        minLength: 1,
        description:
          'The continue run’s id — the `runId` `claim_work_item_continue` answered. Only your own run on this work item is accepted.',
      },
      outcome: {
        type: 'string',
        enum: [
          'drained',
          'completed',
          'max',
          'halted',
          'interrupted',
          'replanned',
          'gated',
          'abandoned',
        ],
        description:
          'How the continue ended — the stop reasons the REST close accepts, and the ones `motir continue` closes with: "completed" (the work is delivered), "drained" (a parent continue ran out of ready cards), "max" (it stopped at its card limit), "halted" (you stopped on something you could not get past), "interrupted" (the person stopped you), "replanned" (the card went to Planning), "gated" (it stopped at an approval gate) or "abandoned".',
      },
    },
    required: ['key', 'runId', 'outcome'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  close_work_item_repair: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      runId: {
        type: 'string',
        minLength: 1,
        description:
          'The repair run’s id — the `runId` `claim_work_item_repair` answered. Only your own run on this work item is accepted.',
      },
      outcome: {
        type: 'string',
        enum: ['green', 'gave_up', 'halted', 'interrupted'],
        description:
          'How the repair ended: "green" (the checks pass), "gave_up" (you spent your attempts), "halted" (you stopped on something you could not get past) or "interrupted" (the person stopped you).',
      },
    },
    required: ['key', 'runId', 'outcome'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  close_work_item_run: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The card you started the run on (e.g. "ACME-7") — the same key `start_work_item_run` took.',
      },
      runId: {
        type: 'string',
        minLength: 1,
        description: 'The run’s id — the `runId` `start_work_item_run` answered.',
      },
      outcome: {
        type: 'string',
        enum: ['drained', 'completed', 'max', 'halted', 'interrupted', 'replanned', 'gated'],
        description:
          'How the run ended: "completed" (the work is delivered), "drained" (a parent run finished every child it could), "max" (it stopped at a card limit), "halted" (you stopped on something you could not get past), "interrupted" (the person stopped you), "replanned" (the card went to Planning) or "gated" (the remaining work waits on an approval gate — a design, decision, choice, confirmation or manual card not yet decided; Motir records which gates held the run, and a stop at such a gate is never "halted").',
      },
    },
    required: ['key', 'runId', 'outcome'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  code_explore: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'What to look for: a symbol, a concept, or a few words naming the code you want.',
      },
      repo: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. Limit the read to ONE repository in the project’s set — its bare name ("motir-core") or `owner/name`, case-insensitively. Omit to read every indexed repository in the set.',
      },
      cursor: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. Fetch the NEXT PAGE of an earlier result: pass the `cursor` printed on that result’s page line, exactly as printed, with the same other arguments. Omit for page 1.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  code_search: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'What to look for: a symbol, a concept, or a few words naming the code you want.',
      },
      repo: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. Limit the read to ONE repository in the project’s set — its bare name ("motir-core") or `owner/name`, case-insensitively. Omit to read every indexed repository in the set.',
      },
      cursor: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. Fetch the NEXT PAGE of an earlier result: pass the `cursor` printed on that result’s page line, exactly as printed, with the same other arguments. Omit for page 1.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'OPTIONAL. The page size — how many symbols to return per page.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  complete_session: {
    type: 'object',
    properties: {
      sessionBranch: {
        type: 'string',
        minLength: 1,
        description: 'The session/integration branch name, e.g. "session/ACME-42-run".',
      },
      implementationSource: {
        type: 'string',
        enum: ['byok', 'manual'],
        description:
          'Optional self-reported implementation source: "byok" (an agent on your own machine) or "manual" (a human, no agent). Defaults to "byok" when a harness/model is reported. "hosted" is not accepted here (that is trusted/metered).',
      },
      implementationHarness: {
        type: 'string',
        description:
          'Optional self-reported implementation harness (e.g. "opencode", "Claude Code").',
      },
      implementationModel: {
        type: 'string',
        description: 'Optional self-reported implementation model (e.g. "claude", "deepseek").',
      },
    },
    required: ['sessionBranch'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  complete_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      carryOverTo: {
        anyOf: [
          { type: 'string', const: 'backlog' },
          {
            type: 'object',
            properties: { sprintId: { type: 'string', minLength: 1 } },
            required: ['sprintId'],
            additionalProperties: false,
          },
        ],
        description:
          'REQUIRED disposition for unfinished items: "backlog" (move them to the backlog) or { "sprintId": "<id>" } to move them into another PLANNED sprint in the same project. Done items always stay on the completed sprint.',
      },
    },
    required: ['sprintId', 'carryOverTo'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_acceptance_upload: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      hasTrace: {
        type: 'boolean',
        description:
          'True to ALSO mint a grant for the Playwright trace (a dev diagnostic beside the video). Defaults to false — mint it only if you actually captured one.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_design_upload: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['mock', 'image', 'note_file'],
              description:
                'What this file IS: "mock" for a `*.mock.html` (one or more), "note_file" for the area’s `design-notes.md` (exactly one). "image" is RETIRED and refused — a design result carries no screenshot.',
            },
            sourcePath: {
              type: 'string',
              minLength: 1,
              description:
                'The path the file has IN THE REPOSITORY, e.g. "design/ai-chat/planning-workspace.mock.html". Its basename is carried into the minted key, so a grant stays recognisable.',
            },
            contentType: {
              type: 'string',
              minLength: 1,
              description:
                'The media type you will PUT — "text/html" for a mock, "text/markdown" for the note file. The grant is BOUND to it: a PUT sending anything else is refused by the store.',
            },
          },
          required: ['kind', 'sourcePath', 'contentType'],
          additionalProperties: false,
        },
        minItems: 1,
        description:
          'The files you are about to upload — one grant is minted per entry, in this order.',
      },
      withinParentKey: {
        type: 'string',
        description:
          'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts the target is one of that container’s children, and is not stored.',
      },
    },
    required: ['key', 'files'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_folder: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the folders belong to (e.g. "ACME").',
      },
      name: {
        type: 'string',
        description: 'The new folder’s name. Unique among the folders at its level.',
      },
      parentFolderId: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'The folder to create it inside (an id from `list_folders`). Omit or pass null to create it at the project root.',
      },
    },
    required: ['projectKey', 'name'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      title: {
        type: 'string',
        description: 'The page’s title. Omit for an untitled page; rename it in the editor later.',
      },
      markdown: {
        type: 'string',
        description: 'The page’s body as markdown. Omit for an empty page.',
      },
      parent: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            minLength: 1,
            description: '`root`, `folder` (an id from `list_folders`) or `page` (a page id).',
          },
          id: {
            type: 'string',
            minLength: 1,
            description: 'The folder or page id. Required unless `kind` is `root`.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
        description:
          'Where to file the page: `{ "kind": "root" }`, `{ "kind": "folder", "id": … }` or `{ "kind": "page", "id": … }` for a sub-page. Omit to file it at the project root.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_plan: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Optional short label for the plan — what it is proposing, in a line.',
      },
      summary: {
        type: 'string',
        minLength: 1,
        description:
          'Optional longer summary (Markdown) of what this plan proposes and why, shown to the reviewer above the tree. Not write-once: `update_plan` corrects it — and the title — after the fact, on a `generating` or `planned` plan, without touching a proposal.',
      },
      plannedWithHarness: {
        type: 'string',
        minLength: 1,
        description:
          'Optional: the harness/tool you are running as (e.g. "Claude Code", "Codex"). Shown to the person reviewing this plan, so they can see it was written by an agent rather than generated by Motir.',
      },
      plannedWithModel: {
        type: 'string',
        minLength: 1,
        description:
          'Optional: the model you are running (e.g. "claude-opus-5"). Shown beside the harness.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_sprint: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      name: {
        type: 'string',
        description: 'Optional sprint name; defaults to "Sprint <n>" (the next sequence).',
      },
      goal: { type: 'string', description: 'Optional sprint goal.' },
      startDate: {
        type: 'string',
        description:
          'Optional planned start (ISO-8601). A planned sprint activates on start_sprint.',
      },
      endDate: {
        type: 'string',
        description: 'Optional planned end (ISO-8601); must be ≥ startDate.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_work_item: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the item is created in — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description:
          'The work item kind. Use "epic" (no parentKey) to create a top-level capability area; "bug" under a story/epic to log a defect (the bug-logging protocol).',
      },
      title: { type: 'string', minLength: 1, description: 'The work item title (one line).' },
      parentKey: {
        type: 'string',
        description:
          'Optional parent work item identifier (e.g. "ACME-3") — must be a kind-legal, same-project parent. Mutually exclusive with folderId.',
      },
      folderId: {
        type: 'string',
        minLength: 1,
        description:
          "Optional: the id of a folder (as `list_folders` returns it) to FILE the new item into — the other placement beside parentKey, which it may not be combined with (PLACEMENT_CONFLICT). A filed item is a root, so any kind may be filed, a subtask included. The folder must be in this project: an unknown id is FOLDER_NOT_FOUND, another project's is CROSS_PROJECT_FOLDER.",
      },
      descriptionMd: { type: 'string', description: 'Optional Markdown description body.' },
      sections: {
        type: 'object',
        additionalProperties: {},
        description:
          'OPTIONAL. The item’s sections as named values (framing, acceptanceCriteria, scopeBoundary, …), instead of composing headings inside `descriptionMd`: the door checks them against the section set for the item’s kind × type, refuses a missing, unknown or invalid section BY NAME with INVALID_SECTIONS, writes the headings itself and stores ONLY the rendered `descriptionMd` — `sections` is never stored. Never send it together with `descriptionMd` (SECTIONS_AND_DESCRIPTION_CONFLICT). The section sets, their shapes and which are required are served by `get_section_sets`. On an UPDATE it is sparse at the section key: the stored body is read back into its sections first, a section you omit is kept, an explicit `null` clears one, and a list REPLACES the list; it is judged on the item’s type AFTER this write. Omit it to keep sending a plain `descriptionMd` exactly as before.',
      },
      language: {
        type: 'string',
        enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
        description:
          "Optional: the language every text field this call writes is in — one of en, zh, ja, ko, de, fr, es, it, nl, pl, pt. Omit it to record the organisation's content language.",
      },
      languages: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
          description: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
        },
        additionalProperties: false,
        description:
          'Optional: the language of each text field this call writes (title, description), winning over `language` for that field.',
      },
      priority: {
        type: 'string',
        enum: ['lowest', 'low', 'medium', 'high', 'highest'],
        description: 'Optional priority (lowest…highest); omit for the project default.',
      },
      storyPoints: {
        anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
        description:
          'Optional story-point estimate (the agile sizing number, distinct from a time estimate). A non-negative number ≤ 9999.99 with at most two decimal places; omit (or null) to leave it unestimated.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description:
          'Optional estimated minutes of work (the TIME estimate, distinct from story points); omit (or null) to leave it unestimated.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
              'code',
              'design',
              'test',
              'content',
              'copy',
              'translate',
              'research',
              'review',
              'verification',
              'decision',
              'choice',
              'deploy',
              'manual',
              'legal',
              'chore',
            ],
          },
          { type: 'null' },
        ],
        description:
          'Optional work type (code, design, test, …) — leaf items (task / bug / subtask) only; rejected on a story. Setting a type seeds the executor from the type default unless an explicit executor is also given. Omit (or null) to leave it untyped.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'Optional executor ("coding_agent" or "human") — leaf items only; overrides the type default when supplied. Omit (or null) to take the type default (or leave it unset when no type is given).',
      },
      difficulty: {
        anyOf: [{ type: 'string', enum: ['trivial', 'low', 'medium', 'high'] }, { type: 'null' }],
        description:
          'Optional difficulty — how hard the work is to REASON about, not how big it is: "trivial", "low", "medium" or "high". Leaf items (task / bug / subtask) only; a non-null value on an epic or story is refused (DIFFICULTY_NOT_ALLOWED_ON_KIND). Omit (or null) to leave it unset.',
      },
      obsolescence: {
        anyOf: [{ type: 'string', enum: ['outdated', 'deprecated'] }, { type: 'null' }],
        description:
          'Mark the item as no longer TRUE OF THE CODE: "outdated" (the text no longer describes what shipped; the capability lives on in another shape) or "deprecated" (retired or overturned on purpose — do not build on it). Settable on ANY kind, but ONLY on a FINISHED item — one whose status is in the done category (`done`, `cancelled`, or a custom done-category status); on any other status it is refused (OBSOLESCENCE_REQUIRES_FINISHED) — archive an item nobody will finish instead. A marked item stays finished: moving it out of the done category, or adding a child under it, is refused (MARKED_CARD_CANNOT_REOPEN) until the mark is cleared. null clears it, always. Link the replacing item with link_work_items `supersedes`. A value outside the enum is refused (INVALID_OBSOLESCENCE). Informational: no read hides or re-orders a marked item.',
      },
      obsolescenceNoteMd: {
        type: ['string', 'null'],
        description:
          'Markdown note saying WHY the item is marked (what changed, what to read instead); null clears it. Independent of `obsolescence`: clearing the mark keeps the note.',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          'Optional: WHICH REPO this item ships in — the bare repo name (e.g. "motir-core") or the "owner/name" form. Must name one of the PROJECT\'s repositories — a row of its repository set, including one not created yet. A repository connected to the workspace but not linked to this project is rejected, as is an unknown name. This is what routes the CLI to the right checkout at dispatch (one subtask = one repo = one PR). Omit (or null) to leave it unpinned — dispatch then falls back to the project\'s single established repository, or reports no repo when the project has none or several.',
      },
      targetRepos: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional: EVERY repository this item ships in, ORDERED — bare repo names (e.g. ["motir-core", "motir-ai"]) or the "owner/name" form. The FIRST element is the PRIMARY: the one dispatch routes the CLI to. The rest record where the item\'s other work lands, and the item does not complete until EVERY repository on the list has a pull request merged onto that repository\'s own default branch. Each element is validated against the project\'s repository domain; duplicates collapse, blank elements are dropped, and one unknown element rejects the whole write. Use it for a card that legitimately spans repositories — ONE SUBTASK is still ONE REPO, so this is for a story or a task, not a subtask. `[]` is the empty set. MUTUALLY EXCLUSIVE with targetRepo, which IS this list\'s first element: supplying both is rejected rather than silently resolved.',
      },
      targetRepositories: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Optional: EVERY repository this item ships in, as REFERENCES to the project's repository ROWS — their ids, ORDERED, the FIRST being the PRIMARY the CLI is dispatched into. Prefer this over targetRepos when you have the ids: a reference survives the repository being renamed, and it can name one of two rows that share a role, which a name cannot. The names you read back are what these resolve to. An id outside THIS item's project is rejected (the error lists the project's rows as \"id (name)\"); duplicates collapse; `[]` is the empty set. MUTUALLY EXCLUSIVE with BOTH targetRepo and targetRepos — they are the same field in three forms, so supplying two is rejected rather than silently resolved.",
      },
      plannedWithHarness: {
        type: 'string',
        description:
          'Optional: the harness/tool this item was planned with (e.g. "Claude Code", "Codex"). Recorded as self-reported planning provenance alongside the server-set source "mcp"; omit to leave it unrecorded.',
      },
      plannedWithModel: {
        type: 'string',
        description:
          'Optional: the LLM this item was planned with (e.g. "claude-opus-4-8", "deepseek-chat"). Recorded as self-reported planning provenance; omit to leave it unrecorded.',
      },
    },
    required: ['projectKey', 'kind', 'title'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_comment: {
    type: 'object',
    properties: {
      commentId: {
        type: 'string',
        minLength: 1,
        description:
          'The comment id — the `id` `add_comment` returned, or a comment row’s `id` from `get_work_item_activity`.',
      },
    },
    required: ['commentId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_folder: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the folders belong to (e.g. "ACME").',
      },
      folderId: {
        type: 'string',
        minLength: 1,
        description: 'The folder id (as returned by `list_folders`).',
      },
    },
    required: ['projectKey', 'folderId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_work_item_todo: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      todoId: {
        type: 'string',
        minLength: 1,
        description:
          'The step’s id, as `list_work_item_todos` or `add_work_item_todo` returned it. A step on another work item is refused as not found.',
      },
    },
    required: ['key', 'todoId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  dispatch_prompt: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      sessionBranch: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._\\-/]*$',
        description:
          'Optional session branch to FALL BACK to when this item carries no lineage of its own — the unattended-run seed (`motir auto`). It never overrides: an item whose dependencies are already integrated, or that is itself integrated, keeps that branch, so a caller cannot redirect a live lineage.',
      },
      findingsPolicy: {
        type: 'string',
        description:
          'Optional comma-separated list of the capabilities this run switches OFF for the agent — one or more of: log-bug, replan. Omitted renders the COMPLETE outcome protocol, which is what every caller wanting to read the real contract should do. An unrecognised capability is refused, never ignored.',
      },
      continueFrom: {
        type: 'string',
        description:
          'Optional id of a DEAD dispatch run this prompt continues — the `deadRun.id` `claim_work_item_continue` returned. The prompt then says how that run ended and where its work stands. A run that is unknown, still running or succeeded is refused with CONTINUE_FROM_INVALID, never ignored.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  edit_comment: {
    type: 'object',
    properties: {
      commentId: {
        type: 'string',
        minLength: 1,
        description:
          'The comment id — the `id` `add_comment` returned, or a comment row’s `id` from `get_work_item_activity`.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description: 'The new comment body (Markdown). Mention a member with @[name](userId).',
      },
    },
    required: ['commentId', 'body'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  expand_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_approval_gate: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item the gate hangs off — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive. The card whose approval you are asking about, not the gate id (gates have no public ids to address).',
      },
      kind: {
        type: 'string',
        enum: [
          'decision_approval',
          'design_result',
          'acceptance_result',
          'pull_request_approval',
          'decision_choice',
          'decision_confirmation',
          'plan_approval',
          'pull_request_merge',
          'manual_work',
        ],
        description:
          'Which decision to read. `decision_approval` is the gate on a `type: decision` card you authored; `design_result` the one your published design raised; `acceptance_result` a story run’s receipt; `pull_request_approval` the approve-and-merge question over a run’s whole delivery set; `decision_choice` and `decision_confirmation` the two decision kinds a person answers directly. `plan_approval` belongs to a PLAN rather than to a card, so no card has one. `pull_request_merge` is built and withdrawn — only historical rows exist. `manual_work` is a manual card a run reached, waiting on a person to do the work and mark it done.',
      },
    },
    required: ['key', 'kind'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_approved_shape_verdict: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      childKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 49,
        description:
          "OPTIONAL — the keys of `key`'s CHILDREN you want a verdict on too (at most 49), typically the ones a parent-run found wrong. Each must be a direct child of `key`: one that is not is REFUSED with `APPROVED_SHAPE_NOT_A_CHILD` naming it, never silently dropped or answered.",
      },
      historyCursor: {
        type: 'string',
        minLength: 1,
        description:
          "OPTIONAL — the `planHistory.nextCursor` a previous call returned, for the next page of the card's plan history. The verdict does not depend on it: it is always computed over the WHOLE history.",
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_code_health: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_coding_convention: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      repo: {
        type: 'string',
        minLength: 1,
        description:
          'The repository whose convention to read — one in this project’s set, by its bare name ("motir-core") or as `owner/name`, case-insensitively. `get_code_health` and `get_project_state` list the set.',
      },
    },
    required: ['projectKey', 'repo'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_design: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The DESIGN CARD\'s identifier — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive. Not the key of the card that waits on the design: for that, call `list_designs` with `blockersOf`.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
      version: {
        type: 'integer',
        exclusiveMinimum: 0,
        description:
          'A version NUMBER (from the page’s history). Returns that version’s markdown, number, author, `savedAt`, and whether it is `sealed` (published for a decision) or `frozen` (approved). Omit to read the current body.',
      },
    },
    required: ['projectKey', 'pageId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_plan: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'The plan id — as returned by an `expand_item` submit, by `get_plan_status`, or shown on the plan in Motir.',
      },
      includeSections: {
        type: 'boolean',
        description:
          'OPTIONAL, default false. When true the tool also parses the free-text body into the registry’s sections for the card’s kind × type and returns the result as `parsedSections` beside the body: `{ sections, found, missing, invalid, signals }` — the sections found, the required ones missing BY NAME, the ones that could not be read into their shape, and the parser’s signals (`no-headings`, `quoted-gutter`, …). The body is returned unchanged and nothing is stored; a body with no headings is answered, never refused.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_plan_status: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description: 'The plan id an `expand_item` submit returned. Pass this OR `jobId`.',
      },
      jobId: {
        type: 'string',
        minLength: 1,
        description: 'The job id an `expand_item` submit returned. Pass this OR `planId`.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_project_state: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_section_sets: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Only this kind’s sets: epic, story, task, subtask or bug. Omit for every kind.',
      },
      type: {
        type: 'string',
        description:
          'Only this type’s sets (code, design, decision, test, …), one cell per kind (a story and an epic have one set whatever the type). Omit for every type.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive — or the work item\'s internal id, the form a plan names a committed card by (`parentRef`, `blockedByRefs`, `workItemId`). With `planId`, this may instead be a `planItem:<id>` temp-ref naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
      includeSections: {
        type: 'boolean',
        description:
          'OPTIONAL, default false. When true the tool also parses the free-text body into the registry’s sections for the card’s kind × type and returns the result as `parsedSections` beside the body: `{ sections, found, missing, invalid, signals }` — the sections found, the required ones missing BY NAME, the ones that could not be read into their shape, and the parser’s signals (`no-headings`, `quoted-gutter`, …). The body is returned unchanged and nothing is stored; a body with no headings is answered, never refused.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_work_item_activity: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      view: {
        type: 'string',
        enum: ['all', 'comments', 'history'],
        description:
          'Which stream to read: "all" (default) — comments and history interleaved in timestamp order; "comments" — comment threads with their replies; "history" — the change trail only.',
      },
      cursor: {
        type: 'string',
        description:
          "Opaque continuation token from a previous call's nextCursor. Echo it back verbatim; never construct or parse one.",
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description:
          'Page-walk direction. Omit for each view\'s shipped default ("desc" — newest first — for "all" and "history"; "asc" for "comments", the Jira default sort).',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  hold_plan_revision: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The id of the plan you are revising.' },
      action: {
        type: 'string',
        enum: ['start', 'renew', 'end'],
        description:
          "`start` before the revision's first write, `renew` every few minutes while it runs, and `end` when it finishes, however it finishes.",
      },
      harness: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description:
          'The agent harness you are running in, as its makers name it (e.g. "Claude Code") — what a refused Approve names as holding the plan.',
      },
      model: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'The model you are running on, by its id. Omit it when you do not know it.',
      },
    },
    required: ['planId', 'action'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  link_pull_request: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      repository: {
        type: 'string',
        description:
          'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). Give this WITH `number`, or give `url` instead — not neither.',
      },
      number: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'The pull-request number, e.g. 2291. Give this with `repository`.',
      },
      url: {
        type: 'string',
        description:
          'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291" — the line `gh pr create` prints, so it can be passed through verbatim. An alternative to `repository` + `number`, never a supplement: if both are given they must agree.',
      },
      headRef: {
        type: 'string',
        minLength: 1,
        description:
          'The branch the pull request is FROM, e.g. "subtask/ACME-7-widget". Used only when no webhook delivery has arrived yet and this call is what creates the row; once a delivery has landed, the delivery is authoritative and this is ignored.',
      },
      baseRef: {
        type: 'string',
        minLength: 1,
        description:
          'The branch the pull request TARGETS, e.g. "main". Same rule as `headRef`: it seeds the row when there is none, and a later delivery overwrites it.',
      },
      title: {
        type: 'string',
        description:
          'The pull request’s title, for the row this call may have to create. Optional — the first webhook delivery supplies the real one either way.',
      },
    },
    required: ['key', 'headRef', 'baseRef'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  link_work_items: {
    type: 'object',
    properties: {
      fromKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      toKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      relationship: {
        type: 'string',
        enum: [
          'blocked_by',
          'blocks',
          'relates_to',
          'duplicates',
          'clones',
          'supersedes',
          'superseded_by',
        ],
        description:
          'The relationship FROM the first item TO the second, read "fromKey <relationship> toKey": "blocked_by" (fromKey is blocked by toKey — the dependency edge that holds fromKey out of the ready set), "blocks" (the inverse — fromKey blocks toKey), "relates_to", "duplicates", "clones", "supersedes" (fromKey is the NEWER work item that replaces toKey), or "superseded_by" (the inverse — fromKey is the OLDER item, replaced by toKey). The supersedes pair is one stored edge read from either end; it gates nothing.',
      },
    },
    required: ['fromKey', 'toKey', 'relationship'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_designs: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      blockersOf: {
        type: 'string',
        minLength: 1,
        description:
          'A work item key (e.g. "ACME-7"). When given, the answer is ONE VERDICT PER DESIGN CARD that work item is `blocked_by` — the designs it is supposed to be built against — instead of a page of the project’s designs. The other filters do not apply.',
      },
      pathPrefix: {
        type: 'string',
        minLength: 1,
        description:
          'Return only designs holding a file whose repository path starts with this prefix — how a delta mock’s amended BASE is found (e.g. `design/work-items/`). Ignored with `blockersOf`. ⚠️ A filtered page can be SHORT — even empty — while more pages remain: keep paging until `nextCursor` is null before concluding nothing matches.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'A case-insensitive substring of the design card’s TITLE. Ignored with `blockersOf`.',
      },
      cursor: {
        type: 'string',
        minLength: 1,
        description:
          'Opaque page cursor from a previous call’s `nextCursor`. Ignored with `blockersOf`. A SHORT page with a non-null cursor is normal when `pathPrefix` or `query` is set, so keep paging until it is null.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Page size (1–100, default 25). Ignored with `blockersOf`.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_folders: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the folders belong to (e.g. "ACME").',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_projects: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      lane: {
        type: 'string',
        enum: ['leaf', 'container', 'bug'],
        description:
          'Which ready lane: "leaf" (default) — ready leaves that are not bug work, each naming its runnable container; "container" — runnable containers (a story, task or bug whose children are all leaves) holding a ready leaf, i.e. what a parent run takes; "bug" — a ready bug or a ready subtask of one. Rows come grouped by container, a group ranked by its best member.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description: 'Restrict to these work item kinds; omit for any.',
      },
      priority: {
        type: 'array',
        items: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
        description: 'Restrict to these priorities; omit for any.',
      },
      assigneeId: {
        type: ['string', 'null'],
        description:
          'A user id to filter by; null or "unassigned" for the unassigned bucket; omit for any.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque page cursor from a previous call’s nextCursor.',
      },
      limit: {
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: 200,
        description: 'Page size (1–200, default 50).',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_sprints: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_work_item_todos: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  mark_integrated: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      sessionBranch: {
        type: 'string',
        minLength: 1,
        description: 'The session/integration branch name, e.g. "session/ACME-42-run".',
      },
      implementationSource: {
        type: 'string',
        enum: ['byok', 'manual'],
        description:
          'Optional self-reported implementation source: "byok" (an agent on your own machine) or "manual" (a human, no agent). Defaults to "byok" when a harness/model is reported. "hosted" is not accepted here (that is trusted/metered).',
      },
      implementationHarness: {
        type: 'string',
        description:
          'Optional self-reported implementation harness (e.g. "opencode", "Claude Code").',
      },
      implementationModel: {
        type: 'string',
        description: 'Optional self-reported implementation model (e.g. "claude", "deepseek").',
      },
    },
    required: ['key', 'sessionBranch'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
      parent: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            minLength: 1,
            description: '`root`, `folder` (an id from `list_folders`) or `page` (a page id).',
          },
          id: {
            type: 'string',
            minLength: 1,
            description: 'The folder or page id. Required unless `kind` is `root`.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
        description:
          'Where the page goes: `{ "kind": "root" }`, `{ "kind": "folder", "id" }` (an id from `list_folders`) or `{ "kind": "page", "id" }` to nest it under another page.',
      },
      beforeId: {
        type: 'string',
        minLength: 1,
        description:
          'A page at the destination the moved page lands right AFTER. Omit both neighbours to place it last (or keep its place when the parent does not change).',
      },
      afterId: {
        type: 'string',
        minLength: 1,
        description: 'A page at the destination the moved page lands right BEFORE.',
      },
    },
    required: ['projectKey', 'pageId', 'parent'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_backlog: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Work item identifiers to move to the backlog, e.g. ["ACME-7", "ACME-8"].',
      },
    },
    required: ['keys'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_parent: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      parentKey: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'The NEW parent work item identifier (e.g. "ACME-3") — must be a kind-legal, same-project parent, and may not be the item itself or one of its descendants. Pass null to promote the item to a top-level root (allowed only for kinds that may live at the top level; a filed item keeps its folder). Give EXACTLY ONE of parentKey and folderId.',
      },
      folderId: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          "The id of a folder (as `list_folders` returns it) to FILE the item into, or null to take it OUT of its folder to the top level. Filing clears the work-item parent; the item's own children travel with it. Give EXACTLY ONE of parentKey and folderId. An unknown folder is FOLDER_NOT_FOUND, another project's CROSS_PROJECT_FOLDER.",
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_sprint: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Work item identifiers to move, e.g. ["ACME-7", "ACME-8"].',
      },
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
    },
    required: ['keys', 'sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_work_item_todo: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      todoId: {
        type: 'string',
        minLength: 1,
        description:
          'The step’s id, as `list_work_item_todos` or `add_work_item_todo` returned it. A step on another work item is refused as not found.',
      },
      toIndex: {
        type: 'integer',
        description:
          'Where the step goes: its 0-based position in the list as it reads AFTER the move (0 is first). Read against the current list, not the one you last listed; an index past either end is clamped to that end.',
      },
    },
    required: ['key', 'todoId', 'toIndex'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  next_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      lane: {
        type: 'string',
        enum: ['leaf', 'container', 'bug'],
        description:
          'Which ready lane: "leaf" (default) — ready leaves that are not bug work, each naming its runnable container; "container" — runnable containers (a story, task or bug whose children are all leaves) holding a ready leaf, i.e. what a parent run takes; "bug" — a ready bug or a ready subtask of one. Rows come grouped by container, a group ranked by its best member.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description: 'Restrict to these work item kinds; omit for any.',
      },
      priority: {
        type: 'array',
        items: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
        description: 'Restrict to these priorities; omit for any.',
      },
      assigneeId: {
        type: ['string', 'null'],
        description:
          'A user id to filter by; null or "unassigned" for the unassigned bucket; omit for any.',
      },
      excludeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Work item ids already dispatched this loop — skip them.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  open_plan_session: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET describes what the conversation is about — order and duplicates do not matter.',
      },
      sessionId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. The `id` of the planning session to address — the `id` that `open_plan_session`, `append_plan_turn` and `submit_plan_session` return. Pass it on every later call to keep talking to the SAME conversation. Omit it to use your own recent session for this scope (active in the last 2 hours), or to start a new one.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_acceptance_result: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      videoPathname: {
        type: 'string',
        minLength: 1,
        description:
          'The `pathname` of the video grant you uploaded to, exactly as it was returned.',
      },
      tracePathname: {
        type: 'string',
        description: 'The trace grant’s `pathname`, when one was minted and uploaded to.',
      },
      chapters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              description:
                'The step this marker jumps to, in the reviewer’s words (e.g. "Open the item").',
            },
            tSeconds: {
              type: 'number',
              minimum: 0,
              description: 'Offset into the recording, in seconds, where that step begins.',
            },
          },
          required: ['label', 'tSeconds'],
          additionalProperties: false,
        },
        description:
          'The chapter markers, from the run’s `chapters.json` — what the reviewer scrubs by. A receipt with none is watchable but not navigable, so send them when the spec wrote them.',
      },
      commitSha: {
        type: 'string',
        description:
          'The commit the run recorded at, as 7 to 64 HEX characters — a full object id or an abbreviation of it, never a branch name or "HEAD". Surrounding whitespace and upper-case hex are accepted and stored normalised; anything else is refused naming this field. ALSO THE IDEMPOTENCY KEY: re-publishing the same commit + producedByKey returns the existing receipt instead of superseding it — which is why it is stored canonical, so two spellings of one commit are one key. The format is checked; whether the commit EXISTS is not.',
      },
      producedByKey: {
        type: 'string',
        description: 'The E2E work item that produced the recording, e.g. "ACME-7".',
      },
    },
    required: ['key', 'videoPathname'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_decision_page: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
    },
    required: ['key', 'pageId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_design_result: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      assets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['mock', 'image', 'note_file'],
              description:
                'What this file IS: "mock" for a `*.mock.html` (one or more), "note_file" for the area’s `design-notes.md` (exactly one). "image" is RETIRED and refused — a design result carries no screenshot.',
            },
            sourcePath: {
              type: 'string',
              minLength: 1,
              description:
                'The path the file has IN THE REPOSITORY, e.g. "design/work-items/detail.mock.html". The repository stays the source of truth; this records where the published copy came from.',
            },
            contentType: {
              type: 'string',
              minLength: 1,
              description:
                'The file’s media type — "text/html" for a mock, "text/markdown" for the note file. Anything else is refused: this is the ONE path on which "text/html" is accepted at all. Required with `contentBase64`; omit it with `pathname`, where the STORE’s own answer is authoritative.',
            },
            contentBase64: {
              type: 'string',
              minLength: 1,
              description:
                'The file’s bytes, base64-encoded — the INLINE path, for a small asset. Send this OR `pathname`, never both and never neither.',
            },
            pathname: {
              type: 'string',
              minLength: 1,
              description:
                'The `pathname` of a `create_design_upload` grant you have already PUT this file to — the path for an asset too large to travel as a tool argument. Send this OR `contentBase64`.',
            },
          },
          required: ['kind', 'sourcePath'],
          additionalProperties: false,
        },
        minItems: 1,
        description:
          'The files to publish: one or more mocks (for a change to an existing design, the NEW delta mock(s) only) and exactly one "note_file". Each entry carries EITHER `contentBase64` (the bytes inline, for a small asset) OR the `pathname` of a `create_design_upload` grant you have already PUT to. One publish uses one of the two forms for ALL its assets.',
      },
      noteMd: {
        type: 'string',
        description:
          'RETIRED — do not send it. A design result no longer carries the note inline: publish the notes file as the one "note_file" asset and the result links to it. Present only so a caller still sending it is refused by name (DESIGN_EVIDENCE_NOTE_MD_RETIRED) rather than silently ignored.',
      },
      commitSha: {
        type: 'string',
        description:
          'The commit the assets were published from, as 7 to 64 HEX characters — a full object id or an abbreviation of it, never a branch name or "HEAD". Surrounding whitespace and upper-case hex are accepted and stored normalised; anything else is refused naming this field. ALSO THE IDEMPOTENCY KEY: re-publishing the same commit + producedByKey returns the existing result instead of superseding it — which is why it is stored canonical, so two spellings of one commit are one key and a reviewer mid-review does not lose the version they were answering about. The format is checked; whether the commit EXISTS is not.',
      },
      producedByKey: {
        type: 'string',
        description: 'The work item whose pull request produced this result, e.g. "ACME-7".',
      },
      withinParentKey: {
        type: 'string',
        description:
          'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts the target is one of that container’s children, and is not stored.',
      },
    },
    required: ['key', 'assets'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_test_instructions: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The RUN TARGET — the work item the run was launched against (e.g. "ACME-7"): the story for a story or scoped run, the card itself for a single-card run. Case-insensitive.',
      },
      bodyMd: {
        type: 'string',
        description:
          'How to test this run, as Markdown. Use SECTIONS — e.g. "## Precondition" (the sign-in, role or data the surface needs), "## Locally" (setup after checking out the branch: install, migrate, seed, run) and "## Click-path" (what to open, click and expect to SEE) when the run creates or changes a rendered surface; otherwise say why there is none. Put EVERY command in its own fenced code block — the page renders each with a click-to-copy control. Do NOT include the branch fetch: Motir composes it from each pull request. At most 32 KiB.',
      },
      repos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            repo: {
              type: 'string',
              minLength: 1,
              description:
                'The repository — its name ("web") or "owner/name" ("acme/web"). It must be one of the work item’s project repositories, and appear once.',
            },
            commitSha: {
              type: 'string',
              minLength: 1,
              description: 'The head commit the run pushed to this repository.',
            },
          },
          required: ['repo', 'commitSha'],
          additionalProperties: false,
        },
        description:
          'One entry per repository the run pushed to, at most 8, each with its pushed head commit. Optional only because a PERSON writing from the form names no repository; SEND ONE PER REPOSITORY YOU PUSHED TO — your record is the evidence for the delivery set a person approves.',
      },
      previewPath: {
        type: 'string',
        description:
          'The path to open on the preview deployment, starting with "/" — e.g. "/items/ACME-7". A path, never a URL: Motir joins it onto the preview the host reported. At most 500 characters.',
      },
    },
    required: ['key', 'bodyMd'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  read_file: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      repo: {
        type: 'string',
        minLength: 1,
        description:
          'The repository to read from — one in this project’s set, by its bare name ("motir-core") or as `owner/name`, case-insensitively. `get_code_health` and `get_project_state` list the set.',
      },
      path: {
        type: 'string',
        minLength: 1,
        description:
          'The file path RELATIVE TO THE REPOSITORY ROOT, e.g. "lib/git/provider.ts". Not a URL, not an absolute path, and never containing "..".',
      },
      ref: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. The branch, tag or commit to read at. Omit for the repository’s default branch — the MERGED code. To read a card’s UNMERGED code, pass the branch its pull request is on.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'OPTIONAL, 1-based and inclusive. Read from this line.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description:
          'OPTIONAL, 1-based and inclusive. Read up to this line. Omit with `startLine` set to read to the end of the file.',
      },
    },
    required: ['projectKey', 'repo', 'path'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  record_plan_revision_reason: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      branch: {
        type: 'string',
        enum: ['new_ask', 'different_solution', 'rule_gap', 'rule_not_followed'],
        description:
          'WHY this plan has to change. `new_ask` — the person now wants something the conversation that settled the plan never raised. `different_solution` — the plan answered what was asked and they prefer another answer. `rule_gap` — the plan missed a check and NO planning rule asks for it; its fix is a new rule. `rule_not_followed` — a rule requires the check and this pass did not apply it. The first two are about the person and file NO planning bug; the last two are about the planner and each file exactly one.',
      },
      evidenceMd: {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
        description:
          'WHY you chose that branch, in Markdown — required on every branch. For `new_ask` / `different_solution`, quote the turn that raised the thing or say that none did. For the two rule branches, quote the rule SEARCH: choosing between them, and ruling both out, is a search and not a judgement, and a gap asserted without one is an unverified negative.',
      },
      planningBugKey: {
        type: 'string',
        minLength: 1,
        description:
          'The planning bug you filed, by its key (`MOTIR-123`) — REQUIRED on `rule_gap` and `rule_not_followed`, and REFUSED on the other two. File it first with `create_work_item` into the project’s `Planning bugs` folder, then pass its key here so the classification points at the record it produced.',
      },
    },
    required: ['planId', 'branch', 'evidenceMd'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  record_run_discrepancy: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The card you built through (e.g. "ACME-7") — on a parent run, the CHILD you were working.',
      },
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            planAsked: {
              type: 'string',
              description: 'What the plan asked for — the route it laid out.',
            },
            built: {
              type: 'string',
              description: 'What you built instead — the route you actually took.',
            },
            why: {
              type: 'string',
              description:
                'Why the plan could not be built as written. If the point describes something that is STILL BROKEN after the card is done, file it as a bug and cite its key here.',
            },
          },
          required: ['planAsked', 'built', 'why'],
          additionalProperties: false,
        },
        description:
          'Every discrepancy you found, in ONE call — 1–20 points, each field 1–2000 characters once trimmed.',
      },
    },
    required: ['key', 'points'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  reinforce_lesson: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      lessonId: {
        type: 'string',
        minLength: 1,
        description:
          'The lesson this occurrence matched — the `id` `search_lessons` returns for each ranked row. Take it from that result; do not construct one.',
      },
      occurrenceRef: {
        type: 'string',
        minLength: 1,
        description:
          'YOUR identifier for the EVENT that just happened — the work item you are running (`MOTIR-123`), or the bug you filed for it. It is what makes this idempotent: the same event recorded twice counts once. It names the occurrence, NOT the lesson.',
      },
    },
    required: ['projectKey', 'lessonId', 'occurrenceRef'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  rename_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
      title: {
        type: 'string',
        description: 'The page’s new title. An empty string makes it untitled.',
      },
    },
    required: ['projectKey', 'pageId', 'title'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  report_action: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The card the step is on (e.g. "ACME-7") — the card you started the run on, or one of its children in a parent run. Required with `action` or `events`; omit everything for a heartbeat only.',
      },
      action: {
        type: 'string',
        description:
          'The step you are ABOUT to take, in one line of at most 500 characters — e.g. "Running the targeted tests for the run service". Never a transcript, a diff, file contents, a prompt or a secret.',
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              minLength: 1,
              description:
                'The milestone: "checkout_ready" (your branch is checked out — put `{ branch }` in `data`), "delivery_linked" (a pull request is linked — `{ url }`), "leg_verdict" or "card_settled". Any other kind comes back in `refused`.',
            },
            data: {
              type: 'object',
              additionalProperties: {},
              description: 'The milestone’s facts, e.g. `{ "branch": "subtask/ACME-7-fix" }`.',
            },
            disposition: {
              type: 'string',
              enum: [
                'queued',
                'running',
                'integrated',
                'implemented',
                'failed',
                'replanned',
                'skipped',
                'not_reached',
              ],
              description:
                'The leg’s new disposition, when the milestone settles it (e.g. "implemented").',
            },
            skipReason: {
              type: 'string',
              enum: [
                'needs_planning',
                'needs_human',
                'claim_refused',
                'blocked_in_scope',
                'integrated_dep',
                'replan_submitted',
                'checkout_unavailable',
              ],
              description: 'Why the leg was skipped, with a "skipped" disposition.',
            },
            sessionBranch: {
              type: 'string',
              minLength: 1,
              description: 'The session/integration branch name, e.g. "session/ACME-42-run".',
            },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        maxItems: 20,
        description: 'Milestones to record before the step, on the leg of `key`.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  report_plan_step: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      sessionKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'A stable name for the planner SESSION reporting the step (at most 128 characters) — one per concurrently running session, so several sessions of one parallel level each hold their own step. A second report under the same key REPLACES that session’s step.',
      },
      step: {
        type: 'string',
        enum: ['settle', 'lay', 'author', 'end'],
        description:
          'The step the session is starting: `settle` (settling the brief — never a target), `lay` (laying the children of `target`, or the project’s top level with no target), `author` (writing `target`, or an item not on the plan yet with no target), or `end` (the session finished — clears its step; never a target). A step report also records the words a person reads at the head of that session’s narration. Send exactly one of `step` or `narration`.',
      },
      narration: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Instead of `step`: one or more plain-language sentences saying what the session is doing and why, appended in order to the plan’s kept narration under `sessionKey` (at most 20 per call; whitespace is collapsed and a sentence longer than 240 characters is cut with an ellipsis). Refused with PLAN_STEP_INVALID when sent with `step` or `target`, when a sentence is empty, or when the session has not reported `settle`, `lay` or `author` yet. Nothing is recorded on a refusal.',
      },
      target: {
        type: 'string',
        minLength: 1,
        description:
          'What the step works on: a `planItem:<id>` ref naming an `add` on THIS plan, or a committed work item in the plan’s project by its KEY (`MOTIR-123`) or id. Leave it out on `lay` for the project’s top level and on `author` for an item not yet on the plan. Refused on `settle` and `end`.',
      },
    },
    required: ['planId', 'sessionKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  report_unbuildable_target: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKey: {
        type: 'string',
        minLength: 1,
        description:
          'The card you stopped on — the one you were dispatched to build (e.g. "ACME-7"). Case-insensitive.',
      },
      reason: {
        type: 'string',
        description:
          'Why the card cannot be built — the SAME text as the comment you left on it (1–4000 characters once trimmed). Describe what is wrong with the CARD.',
      },
    },
    required: ['projectKey', 'targetKey', 'reason'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_lessons: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'Your question, in TAKEAWAY register — the action you are about to take and the SHAPE of what could go wrong, in the words a lesson would be written in: "counting a population from a working tree instead of a ref". NOT the card\'s title ("board filter at scale"), which queries the wrong register and ranks by accident. This text is what decides which lessons arrive, so it is worth a sentence rather than a phrase. A card with more than one distinct risk deserves more than one search: one call returns a handful, and one query cannot rank for three different failure shapes.',
      },
      kinds: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['project', 'onboarding', 'epic', 'story', 'task', 'bug', 'subtask'],
        },
        description:
          'The LEVEL this search is about: the work-item KIND you are writing or laying under, or "project" / "onboarding" when laying a project\'s top level ("onboarding" for a first plan carved from the direction docs). Laying a level narrows on the target you lay under, not the kind of its children. Omitting it leaves the axis UNCONSTRAINED, which is often right — a lesson tagged with no kind reaches every query either way.',
      },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'code',
            'design',
            'test',
            'content',
            'copy',
            'translate',
            'research',
            'review',
            'verification',
            'decision',
            'choice',
            'deploy',
            'manual',
            'legal',
            'chore',
          ],
        },
        description:
          'The work TYPE(s) this search is about (code, design, test, …). Omitting it leaves the axis unconstrained.',
      },
      phases: {
        type: 'array',
        items: { type: 'string', enum: ['lay', 'author'] },
        description:
          'Which part of a card you are writing: "lay" (laying a level\'s children — shape, edges, coverage) or "author" (writing a body — criteria, sizing, claims). The retired spellings "skeleton" and "deepen" are still accepted and read as "lay" and "author"; they are removed in a later release. The coordinate only you can supply.',
      },
      subject: {
        type: 'string',
        minLength: 1,
        description:
          'WHICH SUBJECT MATTER this search is about — the FOURTH routing axis, the same one `add_lesson` records a lesson against (`data`, `jobs`, `llm`, `mcp`, …). SCALAR: one subject or none, never a list, because a lesson has one. Narrowing on it returns the lessons carrying that subject AND the lessons carrying none — an untagged lesson is MORE general than either subject, so it still reaches every query. Omitting it leaves the axis unconstrained. MEMBERSHIP IS NOT VALIDATED, exactly as on the write side: an unrecognised value is accepted and simply matches no subject-tagged row, so a typo narrows to the untagged lessons rather than erroring.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'How many lessons to return, nearest first. Default 8.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_pages: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      q: {
        type: 'string',
        description:
          'The words to find in a page’s title or body (at most 200 characters). An empty query is refused PAGE_SEARCH_QUERY_EMPTY — a search never lists every page.',
      },
      cursor: {
        type: 'string',
        minLength: 1,
        description:
          'The `nextCursor` a previous `search_pages` call returned, to read the next hits.',
      },
    },
    required: ['projectKey', 'q'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_work_items: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      filter: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            description: 'Envelope version — must be "v1" (the only supported version).',
          },
          combinator: {
            type: 'string',
            enum: ['and', 'or'],
            description: 'Match all (and) or match any (or) of the rows.',
          },
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  description:
                    'Field id: a built-in (kind, status, ciState, fixReason, priority, type, difficulty, obsolescence, assignee, reporter, sprint, text, created, updated, due, storyPoints, estimate), a label/component (lbl, cmp), a folder (folder — matches the item’s own folder, else its root ancestor’s, including folders inside the chosen ones), or a custom field (cf:<fieldId>).',
                },
                operator: {
                  type: 'string',
                  enum: [
                    'is_any_of',
                    'is_none_of',
                    'is_empty',
                    'is_not_empty',
                    'contains',
                    'not_contains',
                    'eq',
                    'ne',
                    'lt',
                    'lte',
                    'gt',
                    'gte',
                    'on_or_before',
                    'on_or_after',
                    'between',
                    'in_last_days',
                    'in_next_days',
                  ],
                  description: 'The operator (must be in the field’s set).',
                },
                value: {
                  anyOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'null' },
                  ],
                  description:
                    'Value by operator arity: a string list for is_any_of/is_none_of (and a [from,to] pair for between), a string for contains/not_contains and single dates (YYYY-MM-DD), a number for comparisons and in_last_days/in_next_days, or null for is_empty/is_not_empty.',
                },
              },
              required: ['field', 'operator', 'value'],
              additionalProperties: false,
            },
            maxItems: 20,
            description: 'The filter rows (up to 20). An empty list matches the whole project.',
          },
        },
        required: ['version', 'combinator', 'conditions'],
        additionalProperties: false,
        description:
          'A versioned FilterAST envelope — the SAME shape the /items ?filter= URL and saved filters carry. Omit to search the whole project.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque page cursor from a previous call’s nextCursor.',
      },
      limit: {
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: 50,
        description: 'Page size (1–50, default 50; the List’s server cap).',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_work_items_semantic: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'What you are looking for, in your own words — a phrase or a sentence, NOT a keyword. Motir embeds it for you: there is no model to pick and no vector to supply. Describe the CAPABILITY ("cards remember which columns are collapsed"), not a term you hope somebody used.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Candidates to return; 1–50, default 10.',
      },
      minScore: {
        type: 'number',
        minimum: -1,
        maximum: 1,
        description:
          'Optional cosine-similarity floor in [-1, 1]. NO default, deliberately (ADR Amendment 1): a spurious candidate costs one keyed read, a suppressed one costs a duplicate branch of the plan. Filter here only when you know what you asked.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  set_work_item_todo_done: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      todoId: {
        type: 'string',
        minLength: 1,
        description:
          'The step’s id, as `list_work_item_todos` or `add_work_item_todo` returned it. A step on another work item is refused as not found.',
      },
      done: { type: 'boolean', description: 'true ticks the step; false unticks it.' },
    },
    required: ['key', 'todoId', 'done'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  skeleton: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        description:
          'Maximum rows to return; default (and maximum) 5000 — the whole tree. Pass a smaller number for a cheap peek. The response always reports `total`, `returned` and `truncated`, so a bounded answer is never mistaken for a whole one.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  start_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      name: { type: 'string', description: 'Optional rename on start.' },
      goal: {
        type: ['string', 'null'],
        description: 'Optional goal edit on start; null clears it, omit to leave unchanged.',
      },
      startDate: { type: 'string', description: 'Optional start (ISO-8601); defaults to now.' },
      endDate: {
        type: 'string',
        description: 'Optional planned end (ISO-8601); must be ≥ startDate.',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  start_work_item_run: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      harness: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description:
          'The agent harness you are running in, as its makers name it — e.g. "Claude Code", "Codex", "Kimi CLI". Say what you are, honestly; it is what the run and the card record.',
      },
      model: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'The model you are running on, by its id (e.g. "gpt-5-codex"). Omit it when you do not know it rather than guessing.',
      },
    },
    required: ['key', 'harness'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  submit_plan_session: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET describes what the conversation is about — order and duplicates do not matter.',
      },
      sessionId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL. The `id` of the planning session to address — the `id` that `open_plan_session`, `append_plan_turn` and `submit_plan_session` return. Pass it on every later call to keep talking to the SAME conversation. Omit it to use your own recent session for this scope (active in the last 2 hours), or to start a new one.',
      },
      requirement: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. Who this is for, and what becomes possible that is not possible today.',
          },
          behaviour: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. The observable rules — input → result, and the states that are not the happy path.',
          },
          scopeEdge: {
            type: 'string',
            description:
              'What is deliberately NOT included. May be "" — which says you considered it and there is none, a different answer from never having asked.',
          },
          constraints: {
            type: 'string',
            description:
              'What BINDS the shape and is already decided. May be "" (see `scopeEdge`).',
          },
          acceptance: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. How somebody will know it is done, as an observation rather than a test name.',
          },
          assumptions: {
            anyOf: [
              {
                type: 'array',
                items: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        id: {
                          type: 'string',
                          description:
                            'A stable id for this recommendation. Assigned (`r<position>`) when omitted.',
                        },
                        text: { type: 'string' },
                      },
                      required: ['text'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              { type: 'string' },
            ],
            description:
              'What you concluded that nobody confirmed, as a LIST — one entry per recommendation, each a self-contained sentence (a bare string, or `{ id?, text }` when you want to name it). Each one can then be confirmed or overturned on its own. [] or "" says you concluded nothing (see `scopeEdge`). A single string is accepted and is read as ONE recommendation — it is never split.',
          },
        },
        additionalProperties: false,
        description:
          'OPTIONAL. WHAT you want built, as six named fields instead of prose — the planner reads this INSTEAD of asking you what is wrong. Supply as much as you actually know: nothing here is validated, and a partial requirement submits fine. Three fields (`outcome`, `behaviour`, `acceptance`) must be present and non-empty for the planner to treat the requirement as settled; short of that it simply opens the conversation, which is the same thing it does when you omit this argument entirely.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  touch_work_item_continue: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      runId: {
        type: 'string',
        minLength: 1,
        description:
          'The continue run’s id — the `runId` `claim_work_item_continue` answered. Only your own run on this work item is accepted.',
      },
    },
    required: ['key', 'runId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  touch_work_item_repair: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      runId: {
        type: 'string',
        minLength: 1,
        description:
          'The repair run’s id — the `runId` `claim_work_item_repair` answered. Only your own run on this work item is accepted.',
      },
    },
    required: ['key', 'runId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  transition_status: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      status: {
        type: 'string',
        minLength: 1,
        description:
          'The target status — its key (e.g. "in_progress") or display name (e.g. "In progress").',
      },
    },
    required: ['key', 'status'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unarchive_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unlink_pull_request: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      repository: {
        type: 'string',
        description:
          'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). Give this WITH `number`, or give `url` instead — not neither.',
      },
      number: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'The pull-request number, e.g. 2291. Give this with `repository`.',
      },
      url: {
        type: 'string',
        description:
          'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291". An alternative to `repository` + `number`, never a supplement: if both are given they must agree.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unlink_work_items: {
    type: 'object',
    properties: {
      fromKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      toKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      relationship: {
        type: 'string',
        enum: [
          'blocked_by',
          'blocks',
          'relates_to',
          'duplicates',
          'clones',
          'supersedes',
          'superseded_by',
        ],
        description:
          'The relationship FROM the first item TO the second, read "fromKey <relationship> toKey": "blocked_by" (fromKey is blocked by toKey — the dependency edge that holds fromKey out of the ready set), "blocks" (the inverse — fromKey blocks toKey), "relates_to", "duplicates", "clones", "supersedes" (fromKey is the NEWER work item that replaces toKey), or "superseded_by" (the inverse — fromKey is the OLDER item, replaced by toKey). The supersedes pair is one stored edge read from either end; it gates nothing.',
      },
    },
    required: ['fromKey', 'toKey', 'relationship'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_folder: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the folders belong to (e.g. "ACME").',
      },
      folderId: {
        type: 'string',
        minLength: 1,
        description: 'The folder id (as returned by `list_folders`).',
      },
      name: {
        type: 'string',
        description: 'RENAME: the folder’s new name. Do not combine with a placement.',
      },
      parentFolderId: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'PLACE: the folder to move it into (an id from `list_folders`), or null for the project root. Omit to keep its current parent and only reorder it. Do not combine with `name`.',
      },
      beforeId: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description: 'PLACE: the sibling folder this one should sort AFTER.',
      },
      afterId: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description: 'PLACE: the sibling folder this one should sort BEFORE.',
      },
    },
    required: ['projectKey', 'folderId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_page: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description: 'The project key the page belongs to (e.g. "ACME").',
      },
      pageId: {
        type: 'string',
        minLength: 1,
        description: 'The page id — the `<id>` in the page’s address `/pages/<id>`.',
      },
      markdown: {
        type: 'string',
        description:
          'The page’s WHOLE new body as markdown. It replaces the body; it is not appended.',
      },
      revision: {
        type: 'integer',
        minimum: 1,
        description:
          'The `revision` your `get_page` (or `create_page`) returned. A page saved since is refused PAGE_REVISION_CONFLICT and nothing is written.',
      },
    },
    required: ['projectKey', 'pageId', 'markdown', 'revision'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      title: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          "The plan's own short label — what it is proposing, in a line. `null` clears it. Omit it to leave it exactly as it is.",
      },
      summary: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'The longer summary (Markdown) shown to the reviewer above the tree — the sentence they read before any card. `null` clears it. Omit it to leave it exactly as it is.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan_item: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to deepen — one of the ids `add_plan_items` returned in `planItemIds`, in the order you sent them.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Replace the proposed title. Cannot be blanked — a proposal needs a title.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description: 'Replace the proposed kind.',
      },
      descriptionMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.',
      },
      sections: {
        type: 'object',
        additionalProperties: {},
        description:
          'OPTIONAL. The card’s sections as named values, instead of composing headings inside `descriptionMd`: the door checks them against the section set for the proposal’s kind × type, refuses a missing, unknown or invalid section BY NAME with INVALID_PROPOSAL, writes the headings itself and stores ONLY the rendered `descriptionMd` — `sections` itself is never stored. Never send it together with `descriptionMd` (refused, naming both). The section sets, their shapes and which are required are served by `get_section_sets`. On an EDIT it is sparse at the section key: the stored body is read back into its sections first, a section you omit is kept, an explicit `null` clears one, and a list REPLACES the list. Omit it to keep sending a plain `descriptionMd` exactly as before.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
              'code',
              'design',
              'test',
              'content',
              'copy',
              'translate',
              'research',
              'review',
              'verification',
              'decision',
              'choice',
              'deploy',
              'manual',
              'legal',
              'chore',
            ],
          },
          { type: 'null' },
        ],
        description:
          'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` clears it.',
      },
      priority: {
        anyOf: [
          { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
          { type: 'null' },
        ],
        description: 'Priority; `null` clears it.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does NOT derive an executor from the type, so a proposal that never carried one materializes unassigned. `null` clears it.',
      },
      storyPoints: {
        type: ['number', 'null'],
        description:
          'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description: 'Estimated minutes of work; `null` clears it.',
      },
      difficulty: {
        anyOf: [{ type: 'string', enum: ['trivial', 'low', 'medium', 'high'] }, { type: 'null' }],
        description:
          'How hard the work is to REASON about, not how big it is (that is `storyPoints` / `estimateMinutes`): "trivial", "low", "medium", "high", easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped. Judged on the MERGED kind. Send `null` to clear it; omit to leave it as it is.',
      },
      todos: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description:
                    'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                },
                notesMd: {
                  type: ['string', 'null'],
                  description:
                    'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                },
                commandText: {
                  type: ['string', 'null'],
                  description:
                    'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                },
                executor: {
                  anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
                  description:
                    'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
        description:
          'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children. REPLACES the list whole — a list has no sparse edit — so send the set you want; `[]` or `null` clears it, and omitting it leaves the proposal’s list alone.',
      },
      revision: {
        type: 'boolean',
        description:
          'Set true to edit a proposal on a plan you have ALREADY closed — a plan that is `planned` and in front of a reviewer. Without it such an edit is refused. The plan does NOT re-open: it is `planned` before, during and after, and the edit is recorded on its timeline with the harness and model that made it. This is how a card’s WORDS are corrected on a landed plan — the same card, same id and edges — rather than by withdrawing it and appending a copy. On a `generating` plan it is unnecessary and changes nothing. `approved` and `declined` stay frozen.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan_proposal: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to correct — one of the ids `add_plan_items` returned in `planItemIds`, in the order you sent them.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Replace the proposed title. Cannot be blanked — a proposal needs a title.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description: 'Replace the proposed kind.',
      },
      descriptionMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.',
      },
      sections: {
        type: 'object',
        additionalProperties: {},
        description:
          'OPTIONAL. The card’s sections as named values, instead of composing headings inside `descriptionMd`: the door checks them against the section set for the proposal’s kind × type, refuses a missing, unknown or invalid section BY NAME with INVALID_PROPOSAL, writes the headings itself and stores ONLY the rendered `descriptionMd` — `sections` itself is never stored. Never send it together with `descriptionMd` (refused, naming both). The section sets, their shapes and which are required are served by `get_section_sets`. On an EDIT it is sparse at the section key: the stored body is read back into its sections first, a section you omit is kept, an explicit `null` clears one, and a list REPLACES the list. Omit it to keep sending a plain `descriptionMd` exactly as before.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
              'code',
              'design',
              'test',
              'content',
              'copy',
              'translate',
              'research',
              'review',
              'verification',
              'decision',
              'choice',
              'deploy',
              'manual',
              'legal',
              'chore',
            ],
          },
          { type: 'null' },
        ],
        description:
          'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` clears it.',
      },
      priority: {
        anyOf: [
          { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
          { type: 'null' },
        ],
        description: 'Priority; `null` clears it.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does NOT derive an executor from the type, so a proposal that never carried one materializes unassigned. `null` clears it.',
      },
      storyPoints: {
        type: ['number', 'null'],
        description:
          'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description: 'Estimated minutes of work; `null` clears it.',
      },
      difficulty: {
        anyOf: [{ type: 'string', enum: ['trivial', 'low', 'medium', 'high'] }, { type: 'null' }],
        description:
          'How hard the work is to REASON about, not how big it is (that is `storyPoints` / `estimateMinutes`): "trivial", "low", "medium", "high", easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped. Judged on the MERGED kind. Send `null` to clear it; omit to leave it as it is.',
      },
      todos: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description:
                    'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                },
                notesMd: {
                  type: ['string', 'null'],
                  description:
                    'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                },
                commandText: {
                  type: ['string', 'null'],
                  description:
                    'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                },
                executor: {
                  anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
                  description:
                    'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
        description:
          'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children. REPLACES the list whole — a list has no sparse edit — so send the set you want; `[]` or `null` clears it, and omitting it leaves the proposal’s list alone.',
      },
      parentRef: {
        type: ['string', 'null'],
        description:
          '`add` only: re-parent the proposal. A work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming another `add` on THIS plan; `folder:<folderId>` to file it into a folder of this project instead; `null` makes it top-level. Re-validated by the same checks the append runs, so a key or a ref naming nothing is refused here rather than at approve — and a ref to the proposal ITSELF is refused too.',
      },
      blockedByRefs: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'A work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a real work-item id; or a `planItem:<id>` ref naming another `add` on THIS plan. A key is resolved to its id by this call, exactly as `add_plan_items` resolves one, so the three are interchangeable (MOTIR-3934).',
        },
        description:
          'REPLACES the dependency edges wholesale — a list has no sparse edit, so send the set you want and `[]` to clear it. Same ref rules and same re-validation as `parentRef`.',
      },
      supersedesRefs: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'A work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a real work-item id; or a `planItem:<id>` ref naming another `add` on THIS plan. A key is resolved to its id by this call, exactly as `add_plan_items` resolves one, so the three are interchangeable (MOTIR-3934).',
        },
        description:
          'REPLACES an `add`’s supersedes set wholesale — send the set you want, `[]` to clear it. `add` only: the OLDER cards the created card REPLACES. Approve writes one `supersedes` link from the new card to each. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. Refused on a `modify` (it spells its edges on the patch: `supersedesAdd` / `supersededByAdd`) and on a `remove`. This does NOT mark the older card — to mark it `outdated`, send a mark-only `modify` of it with `supersededByAdd: ["planItem:<this add>"]` in a LATER call. To change a `modify`’s supersedes edges, replace its `patch` instead.',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin WHICH REPO this proposal ships in, validated against the project’s repository set (a repository connected to the workspace but not linked to the project is rejected); `null` unpins it.',
      },
      targetRepos: {
        type: 'array',
        items: { type: 'string' },
        description:
          '`add` only: REPLACE this proposal’s repository set with these ordered names; `[]` unpins it. ⚠️ The repository axis is REPLACED rather than merged — correcting one of `targetRepo` / `targetRepos` / `targetRepositories` CLEARS the other two, because they are one field in three spellings and a proposal carrying two would be a contradiction approve had to guess at.',
      },
      targetRepositories: {
        type: 'array',
        items: { type: 'string' },
        description:
          '`add` only: the same replacement, as the project’s repository ROW IDS. Clears the other two spellings, for the reason above.',
      },
      targetRepositoryRef: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin the SINGULAR ROW-ID half of the pin (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) — the one spelling that names one of two rows sharing a role. `null` unpins it. Clears the other spellings, for the reason above.',
      },
      targetRepoRole: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin the PORTABLE half of the pin — a ROLE of the project’s repository set, validated against the closed role vocabulary rather than the project’s rows; `null` unpins it. This is the pin an ONBOARDING plan actually carries, because its repositories do not exist yet.',
      },
      subject: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin the SUBJECT coordinate — which rule packs an authoring pass composes for this leaf. An explicit `null` unpins it. Correctable here and NOT on the deepen turn, deliberately: a subject says where the card sits in the RULE CORPUS rather than what it says, so it is settled at the `lay` beside `type` and the repo pin. Re-validated by the same shape and container checks the append runs; membership is not checked here in either door.',
      },
      patch: {
        anyOf: [
          {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Re-title the target.' },
              descriptionMd: {
                type: ['string', 'null'],
                description: 'Markdown body — WHAT to do. An explicit `null` clears it.',
              },
              explanationMd: {
                type: ['string', 'null'],
                description:
                  'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a re-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you rewrite it, and a stale WHY is worse than a null one.',
              },
              priority: {
                anyOf: [
                  { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                  { type: 'null' },
                ],
              },
              type: {
                anyOf: [
                  {
                    type: 'string',
                    enum: [
                      'code',
                      'design',
                      'test',
                      'content',
                      'copy',
                      'translate',
                      'research',
                      'review',
                      'verification',
                      'decision',
                      'choice',
                      'deploy',
                      'manual',
                      'legal',
                      'chore',
                    ],
                  },
                  { type: 'null' },
                ],
                description:
                  'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An explicit `null` clears it.',
              },
              kind: {
                type: 'string',
                enum: ['story', 'task', 'bug', 'subtask'],
                description:
                  'RE-KIND the target — the plan door’s `change_kind` (never `epic`). Judged against the PROJECTED tree: the parent must admit the new kind, the new kind must admit every child the target keeps, and re-kinding a leaf into a `story` must clear its leaf fields in the same patch (`type: null`, `difficulty: null`) or it is refused by name. The executor is not a patch key: a re-kind to a container clears it at approve.',
              },
              storyPoints: {
                type: ['number', 'null'],
                description: 'Re-scope the agile sizing. An explicit `null` clears it.',
              },
              estimateMinutes: {
                anyOf: [{ type: 'integer' }, { type: 'null' }],
                description: 'Re-scope the time estimate. An explicit `null` clears it.',
              },
              difficulty: {
                anyOf: [
                  { type: 'string', enum: ['trivial', 'low', 'medium', 'high'] },
                  { type: 'null' },
                ],
                description:
                  'Re-judge the target’s difficulty. How hard the work is to REASON about, not how big it is (that is `storyPoints` / `estimateMinutes`): "trivial", "low", "medium", "high", easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped. Judged on the target’s MERGED kind. An explicit `null` clears it.',
              },
              todos: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        text: {
                          type: 'string',
                          description:
                            'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                        },
                        notesMd: {
                          type: ['string', 'null'],
                          description:
                            'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                        },
                        commandText: {
                          type: ['string', 'null'],
                          description:
                            'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                        },
                        executor: {
                          anyOf: [
                            { type: 'string', enum: ['coding_agent', 'human'] },
                            { type: 'null' },
                          ],
                          description:
                            'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                        },
                      },
                      required: ['text'],
                      additionalProperties: false,
                    },
                  },
                  { type: 'null' },
                ],
                description:
                  'REPLACE the target’s ordered steps (its to-do list). Approve makes the list exactly this array, in order, none ticked, and DELETES every existing row — ticked ones included; the review and `get_plan` show how many steps that drops and how many were ticked. Omit the key to leave the list alone; `[]` or `null` clears it. Leaf kinds only (judged on the target’s MERGED kind). Not a mark key: a `modify` of a done or cancelled card that carries it is refused.',
              },
              targetRepo: {
                type: ['string', 'null'],
                description: 'RE-PIN which repo the item ships in. An explicit `null` unpins it.',
              },
              targetRepos: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'RE-PIN the target’s WHOLE repository set, ordered, first element primary. Omit the key to leave it alone; `[]` unpins the card entirely. Mutually exclusive with `targetRepo` and `targetRepositories` on the same patch.',
              },
              targetRepositories: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'The same re-pin, as the project’s repository ROW IDS. Mutually exclusive with the two fields above.',
              },
              targetRepositoryRef: {
                type: ['string', 'null'],
                description:
                  'RE-PIN the target’s repo ROW (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) — the `modify` mirror of the `add` path’s row pin, for the re-plan that moves work to a specific row the role cannot name. An explicit `null` unpins it.',
              },
              targetRepoRole: {
                type: ['string', 'null'],
                description: 'RE-PIN the portable repo role. An explicit `null` unpins it.',
              },
              parentRef: {
                type: ['string', 'null'],
                description:
                  'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. Omit the key to leave the parent where it is. It may also be a `planItem:<id>` ref naming an `add` ALREADY on this plan (from an earlier call), to move an existing card under a card this plan creates; approve creates the `add` first, then moves the card. The move is checked against the tree the plan would produce — the kind-parent matrix, no cycle (never under a proposal this plan creates BELOW the card), the depth cap, and a refusal to hang new work under a FINISHED parent. Or `folder:<folderId>` to FILE the target into a folder of this project instead of under a work item — any kind may be filed, `subtask` included, and an unknown folder or another project’s is refused at the append.',
              },
              blockedByAdd: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs. Each joins the target to an item on the SAME LEVEL — the same depth below their nearest common ancestor — under any parent; a cross-level edge is refused `cross_level`. An epic is blocked only by another epic.',
              },
              blockedByRemove: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
              },
              obsolescence: {
                anyOf: [{ type: 'string', enum: ['outdated', 'deprecated'] }, { type: 'null' }],
                description:
                  'MARK the target as no longer TRUE OF THE CODE: "outdated" or "deprecated" — "outdated" when the text no longer describes what shipped (the capability lives on in another shape), "deprecated" when it was retired or overturned on purpose. An explicit `null` clears it; omit it to leave the mark alone. A value outside the enum is refused INVALID_PROPOSAL. A plan may SET a mark only on a FINISHED target — one whose status is in the `done` category (`done`, `cancelled`, or a custom done status). On a to-do or in-progress target it is refused with INVALID_PROPOSAL: "a plan may mark only a finished work item; <KEY> is at <status>. A work item nobody will finish is removed — send `{ op: \'remove\', workItemId, reason }` instead." (at the append, at `update_plan_proposal`, and again at approve, where `validate_plan` reports it). Clearing a mark (`null`) is legal on any target. A MARK-ONLY `modify` — a patch carrying nothing but `obsolescence`, `obsolescenceNoteMd` and the four supersedes lists — is the ONE change a plan may make to a `done` or `cancelled` card; approve writes it and leaves the card’s status alone. Add any other key and the target is refused PLAN_TARGET_IMMUTABLE. Marking is never archiving: the card stays in the tree, and a `remove` never marks anything.',
              },
              obsolescenceNoteMd: {
                type: ['string', 'null'],
                description:
                  'The Markdown note saying WHY the target is marked — what changed and what to read instead. Independent of `obsolescence` (clearing the mark keeps the note); an explicit `null` clears it. A mark key: legal in a mark-only `modify` of a `done` / `cancelled` card.',
              },
              supersedesAdd: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'On the NEWER card: the target REPLACES each listed card. Each entry names an OLDER card; approve writes one `supersedes` link from the target to it. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. Unioned with an earlier `modify` of the same card; the same ref in `supersedesRemove` cancels it. A mark key.',
              },
              supersedesRemove: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'On the NEWER card: DELETE the `supersedes` link from the target to each listed (older) card at approve; a link that does not exist is a no-op. Same ref forms as `supersedesAdd`. A mark key.',
              },
              supersededByAdd: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'On the OLD card: `supersededByAdd` names the card that REPLACES it. Each entry names a NEWER card; approve writes one `supersedes` link from it to the target — the same row the newer card’s `supersedesAdd` would write, so spelling one edge from both ends lands one link. This is the list a mark on a done card usually needs beside `obsolescence`. Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be marked superseded by a card this plan creates. A key is resolved to its id here, and one that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind. A mark key.',
              },
              supersededByRemove: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'On the OLD card: DELETE the `supersedes` link from each listed (newer) card to the target at approve; a link that does not exist is a no-op. Same ref forms as `supersededByAdd`. A mark key.',
              },
            },
            additionalProperties: true,
            description:
              '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone approves the plan in Motir.',
          },
          { type: 'null' },
        ],
        description:
          '`modify` only: REPLACES that proposal’s patch. This is the op no door could touch at all before — and the one that carries a dependency edit, so it is usually what a mistyped `planItem:` ref is sitting on. It is also how a `modify`’s MARK is corrected: the replacement patch’s `obsolescence`, `obsolescenceNoteMd` and four supersedes lists are re-checked exactly as the append checks them, including the finished-target rule.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      name: { type: 'string', description: 'New name (omit to leave unchanged).' },
      goal: {
        type: ['string', 'null'],
        description: 'New goal; null clears it, omit to leave unchanged.',
      },
      startDate: {
        type: ['string', 'null'],
        description: 'New planned start (ISO-8601); null clears it, omit to leave unchanged.',
      },
      endDate: {
        type: ['string', 'null'],
        description:
          'New planned end (ISO-8601, ≥ startDate); null clears it, omit to leave unchanged.',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      title: { type: 'string', minLength: 1, description: 'New title (one line).' },
      descriptionMd: {
        type: ['string', 'null'],
        description: 'New Markdown description body; null clears it.',
      },
      sections: {
        type: 'object',
        additionalProperties: {},
        description:
          'OPTIONAL. The item’s sections as named values (framing, acceptanceCriteria, scopeBoundary, …), instead of composing headings inside `descriptionMd`: the door checks them against the section set for the item’s kind × type, refuses a missing, unknown or invalid section BY NAME with INVALID_SECTIONS, writes the headings itself and stores ONLY the rendered `descriptionMd` — `sections` is never stored. Never send it together with `descriptionMd` (SECTIONS_AND_DESCRIPTION_CONFLICT). The section sets, their shapes and which are required are served by `get_section_sets`. On an UPDATE it is sparse at the section key: the stored body is read back into its sections first, a section you omit is kept, an explicit `null` clears one, and a list REPLACES the list; it is judged on the item’s type AFTER this write. Omit it to keep sending a plain `descriptionMd` exactly as before.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description: 'New Markdown explanation body (the "why"); null clears it.',
      },
      language: {
        type: 'string',
        enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
        description:
          "Optional: the language every text field this call writes is in — one of en, zh, ja, ko, de, fr, es, it, nl, pl, pt. Omit it to record the organisation's content language.",
      },
      languages: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
          description: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
          explanation: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
        },
        additionalProperties: false,
        description:
          'Optional: the language of each text field this call writes (title, description, explanation), winning over `language` for that field.',
      },
      priority: {
        type: 'string',
        enum: ['lowest', 'low', 'medium', 'high', 'highest'],
        description: 'New priority (lowest…highest).',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
              'code',
              'design',
              'test',
              'content',
              'copy',
              'translate',
              'research',
              'review',
              'verification',
              'decision',
              'choice',
              'deploy',
              'manual',
              'legal',
              'chore',
            ],
          },
          { type: 'null' },
        ],
        description:
          'New work type (code, design, test, …) — leaf items only; null clears it. Setting a type the first time seeds the executor from the type default.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'Who executes the work ("coding_agent" or "human") — leaf items only; null clears it.',
      },
      difficulty: {
        anyOf: [{ type: 'string', enum: ['trivial', 'low', 'medium', 'high'] }, { type: 'null' }],
        description:
          'How hard the work is to REASON about, not how big it is: "trivial", "low", "medium" or "high" — leaf items only; null clears it. A non-null value on an epic or story is refused (DIFFICULTY_NOT_ALLOWED_ON_KIND), and so is changing the kind of a leaf that carries one to a container without clearing it in the same call.',
      },
      obsolescence: {
        anyOf: [{ type: 'string', enum: ['outdated', 'deprecated'] }, { type: 'null' }],
        description:
          'Mark the item as no longer TRUE OF THE CODE: "outdated" (the text no longer describes what shipped; the capability lives on in another shape) or "deprecated" (retired or overturned on purpose — do not build on it). Settable on ANY kind, but ONLY on a FINISHED item — one whose status is in the done category (`done`, `cancelled`, or a custom done-category status); on any other status it is refused (OBSOLESCENCE_REQUIRES_FINISHED) — archive an item nobody will finish instead. A marked item stays finished: moving it out of the done category, or adding a child under it, is refused (MARKED_CARD_CANNOT_REOPEN) until the mark is cleared. null clears it, always. Link the replacing item with link_work_items `supersedes`. A value outside the enum is refused (INVALID_OBSOLESCENCE). Informational: no read hides or re-orders a marked item.',
      },
      obsolescenceNoteMd: {
        type: ['string', 'null'],
        description:
          'Markdown note saying WHY the item is marked (what changed, what to read instead); null clears it. Independent of `obsolescence`: clearing the mark keeps the note.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description: 'Estimated minutes of work; null clears it.',
      },
      storyPoints: {
        anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
        description:
          'Story-point estimate (the agile sizing number, distinct from the time estimate above): a non-negative number ≤ 9999.99 with at most two decimal places. null clears it.',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          'WHICH REPO this item ships in — the bare repo name (e.g. "motir-core") or the "owner/name" form; must name one of the PROJECT\'s repositories — a row of its repository set, including one not created yet. A repository connected to the workspace but not linked to this project is rejected. Routes the CLI to the right checkout at dispatch (one subtask = one repo = one PR). null clears the pin.',
      },
      targetRepos: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replace the repository SET wholesale — EVERY repository this item ships in, ORDERED, the FIRST element being the PRIMARY the CLI is dispatched into. The item does not complete until every repository on the list has a pull request merged onto that repository's own default branch, so use it for a card that legitimately spans repositories (a story or a task — ONE SUBTASK is still ONE REPO). Same validation as create; `[]` clears the set. MUTUALLY EXCLUSIVE with targetRepo, which IS this list's first element: supplying both is rejected rather than silently resolved.",
      },
      targetRepositories: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replace the repository set wholesale, as REFERENCES to the project's repository ROWS — their ids, ORDERED, the FIRST being the PRIMARY the CLI is dispatched into. Prefer this over targetRepos when you have the ids: a reference survives a rename and can name one of two rows sharing a role. Same validation as create; `[]` clears the set. MUTUALLY EXCLUSIVE with BOTH targetRepo and targetRepos.",
      },
      assigneeId: {
        type: ['string', 'null'],
        description: 'New assignee user id (must be a workspace member); null unassigns.',
      },
      dueDate: {
        type: ['string', 'null'],
        description: 'Due date as an ISO-8601 string; null clears it.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_work_item_todo: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      todoId: {
        type: 'string',
        minLength: 1,
        description:
          'The step’s id, as `list_work_item_todos` or `add_work_item_todo` returned it. A step on another work item is refused as not found.',
      },
      text: {
        type: 'string',
        minLength: 1,
        description:
          'The step’s new text — ONE operation, in plain text, at most 200 characters. Omitted ⇒ unchanged.',
      },
      notesMd: {
        type: ['string', 'null'],
        description:
          'New instructions for the step, in Markdown, at most 2000 characters. Omitted ⇒ unchanged; null clears them.',
      },
      commandText: {
        type: ['string', 'null'],
        description:
          'New command for the step, at most 500 characters. Omitted ⇒ unchanged; null clears it.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'Who the step is for: "human" or "coding_agent". Omitted ⇒ unchanged; null clears it.',
      },
      language: {
        type: 'string',
        enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
        description:
          "Optional: the language every text field this call writes is in — one of en, zh, ja, ko, de, fr, es, it, nl, pl, pt. Omit it to record the organisation's content language.",
      },
      languages: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
          notes: {
            type: 'string',
            enum: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'],
          },
        },
        additionalProperties: false,
        description:
          'Optional: the language of each text field this call writes (text, notes), winning over `language` for that field.',
      },
    },
    required: ['key', 'todoId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_plan: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description: 'The plan id `create_plan` returned (or the id shown on the plan in Motir).',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_sprint: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. REQUIRED unless `planId` is given, which names its own project.',
      },
      sprintId: {
        type: 'string',
        minLength: 1,
        description:
          'The sprint to validate; omit to validate the project’s ACTIVE sprint. Not accepted with `planId` — a projected verdict is always about the ACTIVE sprint.',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item to validate — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  whoami: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  withdraw_plan_proposal: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to take off the plan — one of the ids `add_plan_items` returned.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

/** Tool name → the human `title` the tool registers (guarded to 1–64 characters at the seam). */
export const MCP_TOOL_TITLES: Record<keyof typeof TOOL_PERMISSIONS, string> = {
  add_comment: 'Add comment',
  add_lesson: 'Add lesson',
  add_plan_items: 'Append proposals to a plan',
  add_work_item_todo: 'Add a to-do step',
  append_plan_turn: 'Add a planning turn',
  archive_page: 'Archive page',
  archive_work_item: 'Archive work item',
  attach_file: 'Attach file',
  change_kind: 'Change work item kind',
  claim_next_ready: 'Claim next ready work item',
  claim_work_item: 'Claim a work item',
  claim_work_item_continue: 'Continue a dead run’s work item',
  claim_work_item_repair: 'Claim a red work item’s repair',
  close_work_item_continue: 'Close a continue',
  close_work_item_repair: 'Close a repair',
  close_work_item_run: 'Close your run of a work item',
  code_explore: 'Explore the code graph',
  code_search: 'Search the code graph',
  complete_session: 'Complete session',
  complete_sprint: 'Complete sprint',
  create_acceptance_upload: 'Create acceptance upload',
  create_design_upload: 'Create design upload',
  create_folder: 'Create folder',
  create_page: 'Create page',
  create_plan: 'Open a plan to propose into',
  create_sprint: 'Create sprint',
  create_work_item: 'Create work item',
  delete_comment: 'Delete comment',
  delete_folder: 'Delete folder',
  delete_sprint: 'Delete sprint',
  delete_work_item: 'Delete work item',
  delete_work_item_todo: 'Delete a to-do step',
  dispatch_prompt: 'Dispatch prompt',
  edit_comment: 'Edit comment',
  expand_item: 'Expand work item',
  get_approval_gate: 'Get approval gate',
  get_approved_shape_verdict: 'Is this card still what its plan approved?',
  get_code_health: 'Get code health',
  get_coding_convention: 'Get coding convention',
  get_design: 'Get design',
  get_page: 'Get page',
  get_plan: 'Read plan proposals',
  get_plan_status: 'Plan status',
  get_project_state: 'Get project state',
  get_section_sets: 'Get section sets',
  get_work_item: 'Get work item',
  get_work_item_activity: 'Get work item activity',
  hold_plan_revision: 'Hold a plan while you revise it',
  link_pull_request: 'Link pull request',
  link_work_items: 'Link work items',
  list_designs: 'List designs',
  list_folders: 'List folders',
  list_projects: 'List projects',
  list_ready: 'List ready work items',
  list_sprints: 'List sprints',
  list_work_item_todos: 'List a work item’s to-do list',
  mark_integrated: 'Mark integrated',
  move_page: 'Move page',
  move_to_backlog: 'Move work items to backlog',
  move_to_parent: 'Move work item to a new parent',
  move_to_sprint: 'Move work items to sprint',
  move_work_item_todo: 'Move a to-do step',
  next_ready: 'Next ready work item',
  open_plan_session: 'Open plan conversation',
  publish_acceptance_result: 'Publish acceptance result',
  publish_decision_page: 'Publish decision page',
  publish_design_result: 'Publish design result',
  publish_test_instructions: 'Publish How to test',
  read_file: 'Read a file',
  record_plan_revision_reason: 'Record WHY a plan had to change',
  record_run_discrepancy: 'Record what you built differently from the plan',
  reinforce_lesson: 'Reinforce a lesson',
  rename_page: 'Rename page',
  report_action: 'Report your next step',
  report_plan_step: 'Report the step a planner session is on',
  report_unbuildable_target: 'Report a card you cannot build',
  search_lessons: 'Search lessons by meaning',
  search_pages: 'Search pages',
  search_work_items: 'Search work items',
  search_work_items_semantic: 'Search work items by meaning',
  set_work_item_todo_done: 'Tick or untick a to-do step',
  skeleton: 'Project skeleton',
  start_sprint: 'Start sprint',
  start_work_item_run: 'Start your run of a work item',
  submit_plan_session: 'Submit plan conversation',
  touch_work_item_continue: 'Keep a continue alive',
  touch_work_item_repair: 'Keep a repair alive',
  transition_status: 'Transition status',
  unarchive_work_item: 'Unarchive work item',
  unlink_pull_request: 'Unlink pull request',
  unlink_work_items: 'Unlink work items',
  update_folder: 'Update folder',
  update_page: 'Update page',
  update_plan: "Correct a plan's own title and summary",
  update_plan_item: 'Deepen a proposal you appended',
  update_plan_proposal: 'Correct a proposal, including its structure',
  update_sprint: 'Update sprint',
  update_work_item: 'Update work item',
  update_work_item_todo: 'Edit a to-do step',
  validate_plan: 'Validate a plan before anybody reviews it',
  validate_sprint: 'Validate sprint finishability',
  validate_work_item: 'Validate work-item finishability',
  whoami: 'Who am I',
  withdraw_plan_proposal: 'Take a proposal off a plan',
};

/** Tool name → the `annotations` the registration seam injects: the tool’s `title` plus its hints from `TOOL_ANNOTATIONS`. */
export const MCP_TOOL_ANNOTATIONS: Record<keyof typeof TOOL_PERMISSIONS, McpToolHints> = {
  add_comment: {
    title: 'Add comment',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  add_lesson: {
    title: 'Add lesson',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  add_plan_items: {
    title: 'Append proposals to a plan',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  add_work_item_todo: {
    title: 'Add a to-do step',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  append_plan_turn: {
    title: 'Add a planning turn',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  archive_page: {
    title: 'Archive page',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  archive_work_item: {
    title: 'Archive work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  attach_file: {
    title: 'Attach file',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  change_kind: {
    title: 'Change work item kind',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  claim_next_ready: {
    title: 'Claim next ready work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  claim_work_item: {
    title: 'Claim a work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  claim_work_item_continue: {
    title: 'Continue a dead run’s work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  claim_work_item_repair: {
    title: 'Claim a red work item’s repair',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  close_work_item_continue: {
    title: 'Close a continue',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  close_work_item_repair: {
    title: 'Close a repair',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  close_work_item_run: {
    title: 'Close your run of a work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  code_explore: { title: 'Explore the code graph', readOnlyHint: true, openWorldHint: false },
  code_search: { title: 'Search the code graph', readOnlyHint: true, openWorldHint: false },
  complete_session: {
    title: 'Complete session',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  complete_sprint: {
    title: 'Complete sprint',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_acceptance_upload: {
    title: 'Create acceptance upload',
    readOnlyHint: true,
    openWorldHint: false,
  },
  create_design_upload: { title: 'Create design upload', readOnlyHint: true, openWorldHint: false },
  create_folder: {
    title: 'Create folder',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_page: {
    title: 'Create page',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_plan: {
    title: 'Open a plan to propose into',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_sprint: {
    title: 'Create sprint',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_work_item: {
    title: 'Create work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  delete_comment: {
    title: 'Delete comment',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_folder: {
    title: 'Delete folder',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_sprint: {
    title: 'Delete sprint',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_work_item: {
    title: 'Delete work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_work_item_todo: {
    title: 'Delete a to-do step',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  dispatch_prompt: { title: 'Dispatch prompt', readOnlyHint: true, openWorldHint: false },
  edit_comment: {
    title: 'Edit comment',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  expand_item: {
    title: 'Expand work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  get_approval_gate: { title: 'Get approval gate', readOnlyHint: true, openWorldHint: false },
  get_approved_shape_verdict: {
    title: 'Is this card still what its plan approved?',
    readOnlyHint: true,
    openWorldHint: false,
  },
  get_code_health: { title: 'Get code health', readOnlyHint: true, openWorldHint: false },
  get_coding_convention: {
    title: 'Get coding convention',
    readOnlyHint: true,
    openWorldHint: false,
  },
  get_design: { title: 'Get design', readOnlyHint: true, openWorldHint: false },
  get_page: { title: 'Get page', readOnlyHint: true, openWorldHint: false },
  get_plan: { title: 'Read plan proposals', readOnlyHint: true, openWorldHint: false },
  get_plan_status: { title: 'Plan status', readOnlyHint: true, openWorldHint: false },
  get_project_state: { title: 'Get project state', readOnlyHint: true, openWorldHint: false },
  get_section_sets: { title: 'Get section sets', readOnlyHint: true, openWorldHint: false },
  get_work_item: { title: 'Get work item', readOnlyHint: true, openWorldHint: false },
  get_work_item_activity: {
    title: 'Get work item activity',
    readOnlyHint: true,
    openWorldHint: false,
  },
  hold_plan_revision: {
    title: 'Hold a plan while you revise it',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  link_pull_request: {
    title: 'Link pull request',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  link_work_items: {
    title: 'Link work items',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_designs: { title: 'List designs', readOnlyHint: true, openWorldHint: false },
  list_folders: { title: 'List folders', readOnlyHint: true, openWorldHint: false },
  list_projects: { title: 'List projects', readOnlyHint: true, openWorldHint: false },
  list_ready: { title: 'List ready work items', readOnlyHint: true, openWorldHint: false },
  list_sprints: { title: 'List sprints', readOnlyHint: true, openWorldHint: false },
  list_work_item_todos: {
    title: 'List a work item’s to-do list',
    readOnlyHint: true,
    openWorldHint: false,
  },
  mark_integrated: {
    title: 'Mark integrated',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  move_page: {
    title: 'Move page',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  move_to_backlog: {
    title: 'Move work items to backlog',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  move_to_parent: {
    title: 'Move work item to a new parent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  move_to_sprint: {
    title: 'Move work items to sprint',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  move_work_item_todo: {
    title: 'Move a to-do step',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  next_ready: { title: 'Next ready work item', readOnlyHint: true, openWorldHint: false },
  open_plan_session: {
    title: 'Open plan conversation',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  publish_acceptance_result: {
    title: 'Publish acceptance result',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  publish_decision_page: {
    title: 'Publish decision page',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  publish_design_result: {
    title: 'Publish design result',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  publish_test_instructions: {
    title: 'Publish How to test',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  read_file: { title: 'Read a file', readOnlyHint: true, openWorldHint: true },
  record_plan_revision_reason: {
    title: 'Record WHY a plan had to change',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  record_run_discrepancy: {
    title: 'Record what you built differently from the plan',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  reinforce_lesson: {
    title: 'Reinforce a lesson',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  rename_page: {
    title: 'Rename page',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  report_action: {
    title: 'Report your next step',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  report_plan_step: {
    title: 'Report the step a planner session is on',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  report_unbuildable_target: {
    title: 'Report a card you cannot build',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  search_lessons: {
    title: 'Search lessons by meaning',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  search_pages: { title: 'Search pages', readOnlyHint: true, openWorldHint: false },
  search_work_items: { title: 'Search work items', readOnlyHint: true, openWorldHint: false },
  search_work_items_semantic: {
    title: 'Search work items by meaning',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  set_work_item_todo_done: {
    title: 'Tick or untick a to-do step',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  skeleton: { title: 'Project skeleton', readOnlyHint: true, openWorldHint: false },
  start_sprint: {
    title: 'Start sprint',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  start_work_item_run: {
    title: 'Start your run of a work item',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  submit_plan_session: {
    title: 'Submit plan conversation',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  touch_work_item_continue: {
    title: 'Keep a continue alive',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  touch_work_item_repair: {
    title: 'Keep a repair alive',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  transition_status: {
    title: 'Transition status',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  unarchive_work_item: {
    title: 'Unarchive work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  unlink_pull_request: {
    title: 'Unlink pull request',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  unlink_work_items: {
    title: 'Unlink work items',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_folder: {
    title: 'Update folder',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_page: {
    title: 'Update page',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_plan: {
    title: "Correct a plan's own title and summary",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_plan_item: {
    title: 'Deepen a proposal you appended',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_plan_proposal: {
    title: 'Correct a proposal, including its structure',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_sprint: {
    title: 'Update sprint',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_work_item: {
    title: 'Update work item',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_work_item_todo: {
    title: 'Edit a to-do step',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  validate_plan: {
    title: 'Validate a plan before anybody reviews it',
    readOnlyHint: true,
    openWorldHint: false,
  },
  validate_sprint: {
    title: 'Validate sprint finishability',
    readOnlyHint: true,
    openWorldHint: false,
  },
  validate_work_item: {
    title: 'Validate work-item finishability',
    readOnlyHint: true,
    openWorldHint: false,
  },
  whoami: { title: 'Who am I', readOnlyHint: true, openWorldHint: false },
  withdraw_plan_proposal: {
    title: 'Take a proposal off a plan',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};
