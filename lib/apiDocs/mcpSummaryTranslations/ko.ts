import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const ko: McpSummaryTranslations = {
  add_comment: {
    summary:
      '토큰 소유자 명의로 Markdown 댓글을 게시합니다. 멘션하면 지정된 멤버에게 알림이 갑니다.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      '이 프로젝트에 lesson을 기록하여 이후 이 프로젝트의 계획에 그 lesson이 반영되게 합니다. 이 프로젝트에만 적용됩니다.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      '계획에 제안을 추가합니다 — 빈 final 배치로 닫거나, 이미 닫은 계획에는 `revision: true`로 추가합니다. id가 순서대로 반환되므로 다음 배치에서 그 아래에 하위 항목을 붙일 수 있습니다. `modify`는 완료된 작업 항목을 outdated 또는 deprecated로 표시할 수도 있으며, 메모와 supersedes 엣지를 함께 지정합니다(`add`는 대체하는 작업 항목을 `supersedesRefs`에 지정). ref는 key, id 또는 `planItem:` ref로 쓰며, 완료되지 않은 작업 항목의 표시는 거부되므로 대신 제거하세요.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: '작업 항목의 할 일 목록 끝에 단계 하나를 추가합니다.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary: '세션 id로 지정한 계획 대화에 턴 하나를 추가합니다 — 계획에서 바꾸고 싶은 내용입니다.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      '항목을 소프트 제거합니다: ready 집합과 검색에서 사라지지만 완전히 복원할 수 있습니다.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      '작업 항목에 파일을 붙입니다 — 조사 결과 문서나 리뷰 메모 등 — 읽는 사람이 풀 리퀘스트를 뒤지지 않고 작업 항목에서 바로 결과물을 볼 수 있습니다.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      '리프의 kind가 잘못 분류된 경우 다시 분류합니다 — 하위 작업을 작업으로, 또는 그 반대로 바꿉니다.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      '활성 Sprint에서 다음으로 준비된 하위 작업을 원자적으로 선점합니다: 담당자를 나로 지정하고 진행 중으로 바꿉니다.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      '지정한 작업 항목 하나를 원자적으로 선점하고 진행 중으로 바꿉니다. 선점에 실패하면 누가 보유 중인지 알려 줍니다.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      '마지막 실행이 중단되었거나 이제 승인된 게이트에서 멈춘 작업 항목을 `motir continue`처럼 이어받습니다: 새로 시작하지 않고 기존 브랜치와 풀 리퀘스트를 그대로 사용합니다.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      '실패한 풀 리퀘스트가 있는 작업 항목의 수리 잠금을 `motir fix`처럼 획득합니다. 한 번에 한 명의 수리자만 가능합니다.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      '작업 항목의 이어받기를 결과와 함께 종료하여, 페이지에 그 내용이 표시되고 작업 항목을 다시 이어받을 수 있게 합니다.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      '작업 항목의 수리를 결과와 함께 종료하여, 페이지에 그 내용이 표시되고 새 수리를 시작할 수 있게 합니다.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      '작업 항목의 실행을 결과와 함께 종료합니다. 전달 완료로 종료하면 나를 구현자로 기록합니다.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      '쿼리 주변의 호스팅된 코드 그래프 — 호스팅된 계획자 자신의 답변이며, 페이지 단위로 제공되고 모든 부재는 이름이 있는 state로 표시됩니다.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      '호스팅된 코드 그래프에서 이름이 일치하는 심볼 — 호스팅된 계획자 자신의 답변이며, 페이지 단위로 제공됩니다.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      '풀 리퀘스트가 병합된 후 세션 브랜치를 마무리합니다: 그 브랜치에 기록된 모든 항목이 완료로 이동합니다.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: '활성 Sprint를 완료합니다.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      '스토리의 인수 녹화본을 위한 단기 presigned PUT을 발급합니다 — 2단계 중 1단계이며, 영상은 도구 인자로 전달하기에 너무 크기 때문입니다. 바이트를 저장소에 직접 업로드한 다음 pathname을 등록하세요.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      '인라인으로 보내기에 너무 큰 디자인 에셋을 위한 단기 presigned PUT을 발급합니다 — 2단계 중 1단계이며, 큰 에셋은 도구 인자로 전달할 수 있는 크기를 넘기 때문입니다. 바이트를 저장소에 직접 업로드한 다음 pathname을 게시하세요. 스크린샷, 아무도 기다리지 않는 작업 항목, 완료된 디자인 작업 항목은 거부합니다.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary: '루트 또는 다른 폴더 안에 폴더를 만듭니다. 이름은 각 레벨에서 고유해야 합니다.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'markdown 본문이 있는 페이지를 루트, 폴더 안 또는 하위 페이지로 만들고 그 id와 revision을 받습니다.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      '제안을 담을 계획을 엽니다 — 에이전트가 항목을 직접 작성하는 대신 채워 넣는, 검토 가능한 컨테이너입니다.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary: '프로젝트에 계획된 Sprint를 만듭니다. 이름, 목표, 계획 기간은 선택 사항입니다.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      '부모 아래 또는 폴더 안에 에픽, 스토리, 작업, 버그 또는 하위 작업을 만듭니다. 포인트, 예상 시간, type, executor, difficulty, repo, 폐기 표시, 콘텐츠 언어를 한 번의 호출로 지정할 수 있습니다.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      '내가 작성한 댓글을 답글과 함께 영구 삭제합니다. 여기서는 작성자만 삭제할 수 있습니다.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      '폴더를 삭제합니다. 그 안의 폴더와 작업 항목은 한 단계 위로 이동하며, 결과에 이동된 항목이 나열됩니다.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: '계획된 Sprint 또는 완료된 Sprint를 삭제합니다.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      '항목과 그 전체 하위 트리를 영구 삭제합니다. 되돌릴 수 없으며 기본적으로 꺼져 있습니다.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: '작업 항목의 할 일 목록에서 단계 하나를 영구 삭제합니다.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      '서버가 생성한 항목 하나의 코딩 에이전트 프롬프트 — CLI가 에이전트에게 전달하는 것과 같은 텍스트입니다.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary: '내가 작성한 댓글의 본문을 교체합니다. 여기서는 작성자만 수정할 수 있습니다.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      '컨테이너 항목 하나에 대한 AI 확장을 제출합니다. 소유자의 크레딧을 사용하며, 제안은 승인을 기다립니다.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      '승인 게이트 하나에 대해 사람이 내린 결정 — 작업을 되돌려 보낼 때 남긴 메모, 작성자, 작성 시각, 그리고 대상 버전입니다.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      '이 작업 항목은 마지막으로 승인된 계획이 승인한 모습 그대로인가? 계획 이력과 판정을 알려 줍니다.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      '각 리포지토리의 인덱스 state, 최신 코드 상태 감사 요약, 도출된 코딩 컨벤션 — 호스팅된 계획자가 읽는 내용입니다.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      '저장소 하나의 코딩 규칙 전문 — 파생된 것인지 사람이 편집한 것인지와 버전을 함께 제공. 그 저장소의 변경이 따르는 내용.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      '디자인 작업 항목 하나의 승인된 디자인과 그 파일에 대한 단기 링크 — 없는 경우에는 다섯 가지 이유 중 어느 것인지를 알려 줍니다.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      '페이지 하나를 markdown으로 읽습니다 — 제목, 위치, revision, 최신 버전 — 읽거나 다시 쓰기 위해서이며, 번호로 특정 버전을 읽을 수도 있습니다.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      '계획과 그것이 묶은 제안 — 계획자가 실제로 제안한 내용을 규모뿐 아니라 그대로 보여 주며, 제안된 폐기 표시(현재 → 제안, 메모 포함)와 key로 지정된 supersedes 엣지를 포함합니다.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary: '제출된 계획 작업의 결과 — 그 state와 생성된 제안의 수입니다.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      '프로젝트의 계획 사전 조건 — established, code connected, indexed, repo set — 과 조직의 콘텐츠 언어를 계획하기 전에 확인합니다.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      '항목 하나의 전체 정보 — 설명, 상태, 부모 또는 폴더, 하위 항목, 의존 엣지, 준비 상태 판정, 연결된 오류, 그리고 마지막으로 반환된 거부 내용입니다.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, and the latest refusal sent back on it.',
  },
  get_work_item_activity: {
    summary:
      '항목의 논의 및 변경 이력 한 페이지 — 댓글 스레드와 변경 기록이 시간순으로 섞여 있습니다.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      '풀 리퀘스트가 어느 작업 항목을 전달하는지 선언합니다 — 풀 리퀘스트를 연 직후, 전달하는 작업 항목마다 한 번씩 호출하세요. 연결은 SET이므로 두 번째 호출은 옮기는 것이 아니라 추가하며, 웹훅 전달이 도착하기 전에도 동작합니다.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      '두 항목 사이에 엣지를 만듭니다 — blocked_by가 항목을 ready 집합에서 제외하는 엣지입니다.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      '작업 항목이 무엇을 기준으로 만들어져야 하는지(`blockersOf`), 또는 프로젝트의 승인된 디자인 한 페이지입니다. 링크는 없으며 `get_design`에서 가져오세요.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      '프로젝트의 모든 폴더를 한 번에 읽습니다 — 각 폴더의 id와 경로이며, 이름으로 폴더를 찾을 때 씁니다.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      '이 토큰으로 접근할 수 있는 모든 프로젝트와, 다른 모든 도구가 받는 projectKey를 알려 줍니다.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      '프로젝트의 준비된 LANE 하나를 페이지 단위로 — 리프(기본값, 버그는 제외, 각각 속한 컨테이너 표시), 실행 가능한 컨테이너, 또는 버그를 Ready 보기에 표시되는 순서대로 보여 줍니다.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      '프로젝트의 Sprint와 각각의 상태, 목표, 기간, 작업 항목 수, 그리고 Sprint 도구가 받는 id를 보여 줍니다.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      '작업 항목의 할 일 목록을 읽습니다 — 순서대로 나열된 단계, 완료된 단계, 그리고 진행률입니다.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      '항목의 작업이 반영되었음을 기록합니다 — 브랜치, 풀 리퀘스트, 그리고 그것을 담은 커밋입니다.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: '항목을 Sprint에서 빼서 백로그로 되돌립니다.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      '항목을 다시 배치합니다 — 새 부모 아래로, 또는 폴더 안팎으로 — kind-parent 매트릭스를 지키며 순환은 거부합니다.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary: '항목을 한 번의 원자적 이동으로 Sprint에 추가하며, 지정한 순서대로 뒤에 붙습니다.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: '작업 항목의 할 일 목록에서 단계 하나를 새 위치로 옮깁니다.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      '준비된 lane 하나의 다음 항목 — 리프(기본값, 버그는 제외) 또는 버그를 전체 dispatch 페이로드로, 혹은 부모 실행을 위한 다음 실행 가능한 컨테이너를 반환합니다. “다음에 무엇을 할까” 호출입니다.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      '계획 대화를 엽니다 — id로, 최근 대화로, 또는 새 대화로 — 그리고 그 스레드를 읽습니다.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      '업로드한 녹화본을 스토리의 인수 영수증으로 등록합니다 — 리뷰어가 시청하고 게이트가 의존하는 것입니다. 이 호출 외에는 게시하는 방법이 없으며, 게시가 빠져도 정상적인 실행처럼 보입니다.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      '페이지를 결정 작업 항목의 결정으로 게시합니다: 최신 버전을 확정하고, 에이전트 작업 항목이면 사람에게 승인을 요청합니다.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      '디자인 작업 항목에 디자인 RESULT를 올립니다 — 목업과 영역 노트(링크)로, 리뷰어가 여는 내용입니다 — 열린 작업 항목이 해당 디자인에 blocked_by일 때만 사용합니다. .png와 인라인 노트는 둘 다 거부되며, 새 버전을 받지 않는 완료된 디자인 작업 항목도 거부됩니다. 각 에셋은 base64 인라인으로 보내거나, 너무 커서 보낼 수 없으면 create_design_upload 그랜트의 pathname으로 보냅니다.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      '실행의 HOW TO TEST를 실행 대상에 올립니다 — 실행이 끝나기 전에, 그리고 이후 커밋이 단계를 바꿀 때 다시 올립니다: 섹션이 있는 리치 텍스트 Markdown이며 모든 명령은 펜스 코드 블록(클릭하여 복사)에 넣고, 푸시한 각 리포지토리의 커밋도 포함합니다.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      '프로젝트 세트에 속한 리포지토리의 파일 하나의 텍스트 또는 디렉터리의 바로 아래 항목을 ref 기준으로 읽습니다 — 호스팅된 계획자의 읽기처럼 크기가 제한되고 줄 범위를 지정하며, 모든 부재는 이름이 있는 outcome으로 표시됩니다.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      '승인되지 않은 계획을 왜 바꿔야 했는지 기록합니다 — 네 가지 분기 중 두 가지는 계획 버그를 등록하며, 계획 자체는 전혀 바꾸지 않습니다.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      '찾은 lesson이 방금 잘못된 일을 설명한다고 기록합니다 — 그 lesson을 함께 바꾸는지 여부와 관계없이 기록합니다.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      '작업 항목에서 곧 수행할 단계를 알리거나, 마일스톤을 기록하거나, 열려 있는 실행에 하트비트를 보냅니다.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      '계획자 세션이 진행 중인 단계(settle, lay, author)를 보고하거나 종료합니다 — 생성 중인 계획에 대한 참고용 진행 신호입니다.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'HOW만 잘못된 계획으로 작업 항목을 빌드한 러너가 계획과 다르게 빌드한 내용을 기록합니다 — 작업 항목 댓글과 실행 기록이 남고, 확인됩니다.',
    source:
      'A runner that built a card through a plan wrong only about the HOW records what it built differently — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'dispatch된 러너가 멈춘 작업 항목을 빌드 불가로 보고합니다 — 확인만 되며 따로 조치할 것은 없습니다.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      '기록된 lesson을 의미로 검색합니다 — 공유 코퍼스와 이 프로젝트의 고유 lesson을 대상으로 하며, kind, type, phase, subject로 좁힐 수 있습니다. 계획하거나 만들기 전에 사용하세요.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary: '고급 필터 빌더가 작성하는 것과 같은 필터 문법으로 프로젝트의 항목을 검색합니다.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      '이미 만들어진 적이 있는가? 부분 문자열이 아니라 의미로 검색하며 — key, 제목, 점수만 반환합니다.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      '작업 항목의 할 일 목록에서 단계 하나를 체크하거나 체크 해제합니다. 마지막 단계를 체크해도 작업 항목의 상태는 바뀌지 않습니다.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      '프로젝트 전체의 트리 구조를 한 번에 읽습니다 — 모든 항목의 key, kind, 제목, 상태, 부모, 폴더, 폐기 표시를 페이지 반복 없이 제공합니다.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: '계획된 Sprint를 시작하여 프로젝트의 활성 Sprint로 만듭니다.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      '보유 중인 작업 항목의 자체 실행을 열고 harness와 model을 지정하여, Runs와 작업 항목에 표시되게 합니다.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: '대화에서 쌓인 의도를 하나의 변경 집합으로 계획자에게 보냅니다.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      '작업 항목의 이어받기를 유지합니다. 5분 동안 응답이 없는 이어받기는 종료되고 잠금이 해제됩니다.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      '작업 항목의 수리를 유지합니다. 5분 동안 응답이 없는 수리는 종료되고 잠금이 해제됩니다.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      '항목을 다른 상태로 옮깁니다. 허용되지 않는 이동은 허용되는 이동을 알려 주며 반환됩니다.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: '보관된 항목을 복원합니다 — archive의 반대입니다.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      '`link_pull_request` 하나를 되돌립니다 — 작업 항목과 풀 리퀘스트 사이에 기록된 전달을 제거합니다. 전달은 하나의 행이므로 올바른 작업 항목을 다시 연결하면 수정되는 것이 아니라 추가됩니다. 이 호출은 지정한 정확히 그 한 쌍만 제거하고 다른 전달은 그대로 둡니다.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: '엣지를 만들 때 사용한 것과 같은 관계를 지정하여 엣지를 제거합니다.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      '폴더 이름을 바꾸거나 이동 및 순서 변경을 합니다 — 한 번의 호출에서 둘 중 하나만 가능하며 동시에는 안 됩니다.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      '읽은 revision을 기준으로 페이지의 전체 본문을 markdown으로 교체합니다. 그 사이 저장된 페이지는 병합되지 않고 거부됩니다.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary: '제안은 하나도 건드리지 않고 계획 자체의 제목과 요약 — 트리 위의 제목 — 을 고칩니다.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      '추가해 둔 제안을 채웁니다 — 계획을 작성하는 동안의 deepen 턴이거나, `revision: true`와 함께 쓰면 이미 검토 중인 계획의 작업 항목을 그 자리에서 다시 쓰는 것입니다.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      '제안을 수정합니다 — 부모, 의존 및 supersedes 엣지, 폐기 표시와 메모, 전체 리포지토리 축(repo, 행, 세트 또는 역할)을 포함하며, 계획이 검토 중이어도 가능합니다. 수정된 표시는 다시 검사되므로 완료되지 않은 작업 항목에 설정하면 거부됩니다.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Sprint 이름을 바꾸거나, 목표를 변경하거나, 계획 기간을 조정합니다.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      '생성 시에는 설정할 수 없는 설명 본문을 포함하여 항목 필드의 임의의 부분 집합을 수정합니다.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      '작업 항목의 할 일 목록에서 단계 하나를 수정합니다. 보낸 필드만 바뀌며, null은 선택 필드를 비웁니다.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      '승인이 이 계획을 받아들일 수 있는지, 완료 가능한지, 모든 엣지가 같은 레벨에 있는지, 부모가 다른 엣지에 부모 엣지가 있는지 — 네 가지를 모두 `final: true` 전에 확인합니다. 그 후에는 아무도 묻지 않습니다.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      '이 Sprint는 완료 가능한가? Sprint 밖의 작업에 여전히 막혀 있는 Sprint 내 항목을 모두 알려 줍니다.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      '이 에픽, 스토리, 작업 또는 버그가 완료 가능한지, 모든 엣지가 같은 레벨에 있는지, 부모가 다른 엣지에 부모 엣지가 있는지 확인하고 빠진 것을 알려 줍니다.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      '이 토큰이 누구인지 알려 줍니다: 소유 사용자, 활성 워크스페이스, 부여된 scope입니다. 가장 먼저 호출하세요.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary: '리뷰어에게 계획 전체를 거절해 달라고 요청하는 대신, 제안 하나를 계획에서 뺍니다.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
