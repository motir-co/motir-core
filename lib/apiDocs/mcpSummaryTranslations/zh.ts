import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const zh: McpSummaryTranslations = {
  add_comment: {
    summary: '以令牌所有者的身份发表一条 Markdown 评论。提及（Mention）会通知被点名的成员。',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary: '为本项目记录一条经验，使之后为它生成的计划都能参考这条经验。仅限本项目。',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      '向计划追加提案：用空的最终批次结束它，或用 `revision: true` 向已关闭的计划继续添加；id 按顺序返回，因此下一批可以把子项挂到它们之下。`modify` 还可以把已完成（FINISHED）的工作项标记为过时或已弃用，附带备注和 supersedes 边（`add` 在 `supersedesRefs` 中指明它所取代的工作项），引用可以是 key、id 或 `planItem:` 引用；标记未完成的工作项会被拒绝，请改为将其移除。',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: '在工作项的待办清单末尾追加一个步骤。',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary: '向规划对话追加一轮，由其会话 id 指明：即你希望对计划做出的修改。',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary: '软移除一个工作项：它离开就绪集合和搜索结果，并且仍可完整恢复。',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      '把文件放到（ON）工作项上，例如研究结论文档或评审备注，让读者直接在工作项上看到交付物，而不必去翻找拉取请求。',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary: '当叶子工作项的 kind 归错类时重新分类：子任务改为任务，反之亦然。',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary: '原子地认领当前 Sprint 中下一个就绪的子任务：指派给你，并将其切换为进行中。',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary: '原子地认领一个指定的工作项，并将其切换为进行中。认领失败时会说明是谁持有它。',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      '接手一个工作项：其上次运行已中断，或停在了现已批准的关口，做法同 `motir continue`，沿用其分支和拉取请求，而不是重新开始。',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary: '为存在失败拉取请求的工作项获取修复锁，做法同 `motir fix`。同一时间只有一个修复者。',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary: '结束你对一个工作项的接续，并记录结果，使页面显示出来，且该工作项可以再次被接续。',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary: '结束你对一个工作项的修复，并记录结果，使页面显示出来，且可以开始新的修复。',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary: '结束你对一个工作项的运行并记录结果；已交付的结束会把你记为实现者。',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      '围绕一次查询的托管代码图：托管规划器自己的回答，分页返回，每种缺失都是一个有名称的状态。',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary: '托管代码图中与名称匹配的符号：托管规划器自己的回答，分页返回。',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  code_grep: {
    summary:
      '在已索引的文件内容中与文本或模式匹配的行——包括符号搜索看不到的字符串字面量、注释和非代码文件——托管规划器自身的回答，分页返回。',
    source:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary: '在会话分支的拉取请求合并之后收尾：记录在该分支上的每个工作项都转为已完成。',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: '完成当前的 Sprint。', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      '为故事的验收录像生成一个短时效的预签名 PUT，这是两步中的第 1 步，因为视频远大于工具参数能承载的大小。先把字节直接上传到存储，再登记 pathname。',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      '为过大而无法内联发送的设计资源生成一个短时效的预签名 PUT，这是两步中的第 1 步，因为大型资源超出了工具参数能承载的大小。先把字节直接上传到存储，再发布 pathname。截图、没有任何事项在等待的设计工作项，以及已完成的设计工作项都会被拒绝。',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary: '在根层级或另一个文件夹内创建文件夹；名称在同一层级内唯一。',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      '创建带 markdown 正文的页面，可放在根层级、文件夹中或作为子页面，并返回其 id 和修订版本。',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary: '打开一个用于提出提案的计划：智能体填充的可评审容器，取代直接编写工作项。',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary: '在项目上创建一个计划中的 Sprint，可选名称、目标和计划时间窗口。',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      '在父级之下或文件夹中创建篇章、故事、任务、缺陷或子任务；points、estimate、type、executor、difficulty、repo、过时标记和内容语言一次调用即可设置。',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary: '永久删除你自己写的评论及其回复。在这里只有评论作者可以删除。',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary: '删除一个文件夹；其中的文件夹和工作项上移一层，结果会列出移动了哪些。',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: '删除一个计划中或已完成的 Sprint。',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary: '永久删除一个工作项及其整个子树。不可撤销，且默认关闭。',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: '永久删除工作项待办清单中的一个步骤。',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary: '服务端为一个工作项生成的编码智能体提示词，与 CLI 交给智能体的文本相同。',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary: '替换你自己写的评论的正文。在这里只有评论作者可以编辑。',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary: '提交对一个容器工作项的 AI 展开。会消耗所有者的额度；提案等待批准。',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      '某人对一个审批关口做出的决定：退回你的工作时写下的备注、撰写者、时间，以及针对的版本。',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary: '这个工作项是否仍是其最近一次已批准的计划所批准的样子？返回它的计划历史和判定。',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      '每个 repository 的索引状态、最新的代码健康审计摘要和推导出的编码约定，即托管规划器读取的内容。',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      '某个仓库的完整编码规范：由代码推导或由人工编辑，并附版本号，即该仓库中的改动应遵循的内容。',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      '一个设计工作项的已批准设计，附带指向其文件的短时效链接；若没有，则说明五种原因中的哪一种。',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      '以 markdown 读取一个页面：标题、所在位置、修订版本和最新版本，用于阅读或写回；也可按编号读取某个版本。',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      '一个计划及其打包的提案：规划器实际提出的内容，而不只是数量，包括提议的过时标记（current → proposed，附备注）及其 supersedes 边，以 key 指明。',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary: '已提交的规划任务的结果：其状态，以及产出了多少个提案。',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      '一个项目的规划前置条件：是否已建立、代码是否已连接、是否已索引、repo 是否已设置，以及其组织的内容语言，供规划之前查看。',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      '完整读取一个工作项：描述、状态、父级或文件夹、子项、依赖边、就绪判定、与之关联的错误、最近一次针对它退回的拒绝，以及它尚未合并的代码所在的位置。',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary: '一个工作项的讨论与变更轨迹的一页：评论线程与历史记录交错排列。',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      '声明一个拉取请求交付的是哪个工作项：打开拉取请求后立即调用，它交付的每个工作项各调用一次。这种关联是一个集合（SET），所以再次调用是添加（ADDS）而不是移动，并且在任何 webhook 投递到达之前就可使用。',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary: '在两个工作项之间创建一条边；blocked_by 是会把工作项挡在就绪集合之外的那一种。',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      '某个工作项应当依据哪些设计来构建（`blockersOf`），或项目已批准设计的一页。不含链接，链接请从 `get_design` 获取。',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary: '一次读取返回项目的所有文件夹，包含每个文件夹的 id 及其路径，用于按名称查找文件夹。',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary: '此令牌能访问的所有项目，每个项目都附带其他所有工具所需的 projectKey。',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      '项目的一条就绪通道（LANE），分页返回：叶子工作项（默认，不含缺陷，每项注明其容器）、可运行的容器，或缺陷，顺序与 Ready 视图一致。',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary: '项目的 Sprint，含状态、目标、时间窗口和工作项数量，以及各 Sprint 工具所需的 id。',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary: '读取一个工作项的待办清单：按顺序列出各步骤、哪些已完成，以及进度。',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary: '记录某个工作项的成果已经落地：承载它的分支、拉取请求和提交。',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: '把工作项移出其 Sprint，放回待办列表。',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      '重新安置一个工作项：放到新的父级之下，或移入、移出文件夹，同时强制执行 kind 与父级的矩阵并拒绝形成环。',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary: '一次原子操作把工作项加入某个 Sprint，按给定顺序追加。',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: '把工作项待办清单中的一个步骤移到新的位置。',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      '一条就绪通道的下一个工作项：叶子工作项（默认，不含缺陷）或缺陷，以完整的 dispatch 载荷返回；或为父级运行返回下一个可运行的容器。即“接下来做什么”的调用。',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary: '打开一个规划对话，可通过其 id、你最近的一个或新建一个，并读取其线程。',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      '把已上传的录像登记为故事的验收凭据，即评审者观看、验收关口所依据的内容。没有其他途径可以发布它，而缺少发布看起来与一次成功的运行完全一样。',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      '把一个页面发布为决策工作项的决定：封存其最新版本，若是智能体的工作项，则请一位成员批准它。',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      '把设计结果（RESULT）放到设计工作项上，包括 mock、以及作为链接的区域备注，也就是评审者打开的内容，仅在有未完成的工作项被该设计 blocked_by 时才可使用。不接受 .png 和内联备注，两者都会被拒绝，已完成的设计工作项也会被拒绝，它不再接受新版本。每个资源要么以 base64 内联传入，要么在过大无法发送时，以 create_design_upload 授权的 pathname 传入。',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      '把一次运行的测试方法（HOW TO TEST）放到其运行目标上，在运行结束之前发布，之后若有新提交改变了某个步骤则再次发布：带章节的富文本 Markdown，每条命令都放在围栏代码块中（点击即可复制），外加它所推送的每个 repository 的提交。',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      '读取项目 repository 集合中某个仓库在指定 ref 下的一个文件的文本或一个目录的直接条目，与托管规划器的读取一样有长度上限并按行范围读取，每种缺失都是一个有名称的结果。',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      '列出项目 repository 集合中某个仓库里一个分支相对其默认分支或指定基准所改动的路径，与托管规划器的列表一样有上限，每种缺失都是一个有名称的结果。',
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      '记录未批准的计划为何（WHY）必须修改：共四个分支，其中两个会提交规划缺陷；它不会对计划做任何改动。',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary: '记录你找到的某条经验描述了刚刚出错的情况，无论你是否同时修改了它。',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary: '说明你即将在工作项上采取的步骤、记录一个里程碑，或为你打开的运行发送心跳。',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      '报告规划器会话所处的步骤（settle、lay、author）或结束它：针对正在生成的计划的辅助性进度信号。',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      '运行器记录它与仅在“如何做”上有误的计划不同的做法，以及在计划未作规定之处所做的决定：一条工作项评论加一条运行记录，并予确认。',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary: '已派发的运行器报告它停下的那个工作项无法构建：仅作确认，无需任何处理。',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      '按含义搜索已记录的经验（共享语料与本项目自己的语料），可按 kind、type、phase 和 subject 缩小范围，在规划或构建之前使用。',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary: '使用与高级筛选构建器所写相同的筛选语法，搜索项目的工作项。',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary: '这个功能是否已经构建过？按含义（MEANING）而非子串搜索，只返回 key、标题和得分。',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary: '勾选或取消勾选工作项待办清单中的一个步骤。勾选最后一个步骤不会改变工作项的状态。',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      '一次读取返回整个项目的树形结构：每个工作项的 key、kind、标题、状态、父级、文件夹和过时标记，无需分页循环。',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: '启动一个计划中的 Sprint，使其成为项目的当前 Sprint。',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      '为你持有的工作项开启你自己的运行，注明你的 harness 和 model，使其显示在 Runs 和该工作项上。',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: '把对话累积的意图作为一个变更集发送给规划器。',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary: '让你对一个工作项的接续保持活跃。静默五分钟的接续会被关闭，其锁随之释放。',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary: '让你对一个工作项的修复保持活跃。静默五分钟的修复会被关闭，其锁随之释放。',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary: '把工作项转到另一个状态。非法的转换会返回错误，并列出合法的那些。',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: '恢复已归档的工作项，是 archive 的逆操作。',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      '撤销一次 `link_pull_request`：移除工作项与拉取请求之间记录的交付关系。交付关系是一行记录，所以重新关联正确的工作项是添加（ADDS）而不是纠正；此操作只移除你指明的那一对，其他所有交付关系保持不变。',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: '移除一条边，需给出创建它时使用的同一种关系。',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary: '重命名文件夹，或移动并重新排序，每次调用二选一，不能同时进行。',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      '以你读取时的修订版本，用 markdown 替换页面的整个正文；此后已被保存过的页面会被拒绝，而不是合并。',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary: '修正计划自己（OWN）的标题和摘要，即树上方的标题，而不改动任何一个提案。',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      '补全你追加的提案：计划编写期间的深化轮次，或配合 `revision: true`，就地重写已在评审中的计划里的某个工作项。',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      '修正一个提案，包括其父级、依赖边和 supersedes 边、过时标记及备注，以及它完整的 repository 轴（一个 repo、一行、一个集合或一个角色），即使计划已在评审中也可以；修正后的标记会被重新检查，因此在未完成的工作项上设置标记会被拒绝。',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: '重命名 Sprint、修改其目标，或调整其计划时间窗口。',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary: '编辑工作项的任意字段子集，包括 create 无法设置的说明正文。',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary: '编辑工作项待办清单中的一个步骤。只有你发送的字段会改变；null 会清除可选字段。',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      '批准是否会采纳此计划、它能否完成、每条边是否都在同一层级，以及其跨父级的边是否具备各自的父级边？在 `final: true` 之前四项全部检查，之后没有别人会再问。',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary: '此 Sprint 能否完成？列出所有仍受 Sprint 之外工作限制的 Sprint 内工作项。',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      '此篇章、故事、任务或缺陷能否完成，每条边是否都在同一层级，其跨父级的边是否具备各自的父级边？列出缺少的部分。',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary: '此令牌是谁的：所属用户、当前工作区，以及已授予的权限范围。请先调用它。',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary: '把一个提案从计划中撤下，而不是请评审者拒绝整个计划。',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
