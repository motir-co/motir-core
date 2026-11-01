import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const ja: McpSummaryTranslations = {
  add_comment: {
    summary:
      'トークンの所有者として Markdown のコメントを投稿します。メンションすると、指名されたメンバーに通知されます。',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'このプロジェクトにレッスンを記録し、以降の計画にそのレッスンが渡されるようにします。このプロジェクトのみが対象です。',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      '計画に提案を追加します。空の最終バッチで閉じるか、`revision: true` で、すでに閉じた計画に追加します。id は順番に返されるので、次のバッチでその下に子を付けられます。`modify` は、完了済みの作業項目を、メモと supersedes エッジ付きで陳腐化または非推奨としてマークすることもできます(`add` は置き換える作業項目を `supersedesRefs` で指定します)。参照にはキー、id、または `planItem:` 参照を使います。未完了の作業項目へのマークは拒否されるので、代わりに削除してください。',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: '作業項目の ToDo リストの末尾に手順を1つ追加します。',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      '計画の会話に、セッション id を指定して1ターンを追加します。計画に対して変更したいことを書きます。',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary: '項目をソフト削除します。準備完了の集合と検索から外れますが、完全に復元できます。',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      '調査結果のドキュメントやレビューのメモなどのファイルを作業項目に添付します。読む人はプルリクエストを探し回らずに、成果物を作業項目上で確認できます。',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'リーフの種別が誤って登録されている場合に分類し直します。サブタスクからタスクへ、またその逆です。',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'アクティブな Sprint で次に準備完了のサブタスクをアトミックに確保します。あなたに割り当て、進行中に切り替えます。',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      '指名した作業項目を1つだけアトミックに確保し、進行中に切り替えます。確保に失敗した場合は、誰が保持しているかが返されます。',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      '前回の実行が途中で終了した、または承認済みになったゲートで停止した作業項目を、`motir continue` と同様に引き継ぎます。新規開始ではなく、そのブランチとプルリクエストを引き継ぎます。',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      '失敗しているプルリクエストを持つ作業項目の修復ロックを、`motir fix` と同様に取得します。修復できるのは一度に1人です。',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      '作業項目の引き継ぎを、その結果とともに終了します。これにより、ページに結果が表示され、作業項目を再び引き継げるようになります。',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      '作業項目の修復を、その結果とともに終了します。これにより、ページに結果が表示され、新しい修復を開始できるようになります。',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      '作業項目の実行を、その結果とともに終了します。納品済みとして終了すると、あなたが実装者として記録されます。',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'クエリ周辺のホスト型コードグラフ。ホスト型計画者自身の回答をページ分けして返し、見つからない場合もすべて名前付きの状態で示されます。',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'ホスト型コードグラフ内で、名前に一致するシンボル。ホスト型計画者自身の回答をページ分けして返します。',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  code_grep: {
    summary:
      'インデックス済みのファイル内容のうち、テキストまたはパターンに一致する行。シンボル検索では見えない文字列リテラル、コメント、コード以外のファイルも含みます。ホスト型計画者自身の回答をページ分けして返します。',
    source:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'プルリクエストのマージ後にセッションブランチを締めます。そのブランチに記録されたすべての項目が完了に移ります。',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: {
    summary: 'アクティブな Sprint を完了します。',
    source: 'Complete the active sprint.',
  },
  create_acceptance_upload: {
    summary:
      'ストーリーの受け入れ録画用に、短時間有効な署名付き PUT を発行します。2ステップのうちの1つ目で、動画はツールの引数に載せられるサイズをはるかに超えるためです。バイト列をストアに直接アップロードしてから、パス名を登録します。',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'インラインで送るには大きすぎるデザインアセット用に、短時間有効な署名付き PUT を発行します。2ステップのうちの1つ目で、大きなアセットはツールの引数に載せられるサイズを超えるためです。バイト列をストアに直接アップロードしてから、パス名を公開します。スクリーンショット、待っている項目がないデザイン作業項目、完了済みのデザイン作業項目は拒否されます。',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary: 'ルート、または別のフォルダーの中にフォルダーを作成します。名前は階層ごとに一意です。',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'markdown の本文を持つページを、ルート、フォルダー内、またはサブページとして作成し、その id とリビジョンを受け取ります。',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      '提案を入れる計画を開きます。エージェントが項目を直接書く代わりに埋める、レビュー可能なコンテナです。',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary: 'プロジェクトに計画中の Sprint を作成します。名前、ゴール、計画期間は任意です。',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      '親の下、またはフォルダー内に、エピック、ストーリー、タスク、バグ、サブタスクを作成します。ポイント、見積もり、タイプ、executor、難易度、リポジトリ、陳腐化マーク、コンテンツ言語を1回の呼び出しで指定できます。',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      '自分が書いたコメントを、返信ごと完全に削除します。ここで削除できるのは投稿者本人だけです。',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'フォルダーを削除します。その中のフォルダーと作業項目は1つ上に移り、結果には移動したものが一覧されます。',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: '計画中または完了済みの Sprint を削除します。',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary: '項目とそのサブツリー全体を完全に削除します。元に戻せず、デフォルトでは無効です。',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: '作業項目の ToDo リストの手順を1つ完全に削除します。',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      '1つの項目に対してサーバーが生成するコーディングエージェント用プロンプト。CLI がエージェントに渡すものと同じテキストです。',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary: '自分が書いたコメントの本文を置き換えます。ここで編集できるのは投稿者本人だけです。',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      '1つのコンテナ項目の AI による展開を送信します。所有者のクレジットを消費し、提案は承認待ちになります。',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      '1つの承認ゲートに対して人が下した判断。作業を差し戻したときに書いたメモ、書いた人、日時、対象のバージョンを返します。',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'この作業項目は、最後に承認された計画が承認した内容のままか。その計画の履歴と判定を返します。',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      '各リポジトリのインデックス状態、最新のコードヘルス監査の要約、導出されたコーディング規約。ホスト型計画者が読むものです。',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      '1つのリポジトリのコーディング規約の全文。導出されたものか人が編集したものかと、そのバージョンを示す。そのリポジトリでの変更が従う内容。',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      '1つのデザイン作業項目の承認済みデザインと、そのファイルへの短時間有効なリンク。承認済みデザインがない場合は、5つの理由のどれに当たるかを返します。',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      '1つのページを markdown として読み取ります。タイトル、置かれている場所、リビジョン、最新バージョンを含み、読むため、または書き戻すために使います。番号を指定して特定のバージョンを読むこともできます。',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      '計画と、それに含まれる提案。計画者が実際に何を提案したかを返し、件数だけではありません。提案された陳腐化マーク(現在 → 提案、メモ付き)と、キーで指定された supersedes エッジも含みます。',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary: '送信済みの計画ジョブがどうなったか。その状態と、生成された提案の数を返します。',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'プロジェクトの計画の前提条件(確立済みか、コードが接続されているか、インデックス済みか、リポジトリが設定されているか)と、その組織のコンテンツ言語。計画する前に確認します。',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      '1つの項目の全体像。説明、ステータス、親またはフォルダー、子、依存エッジ、準備完了の判定、紐づくエラー、最新の差し戻し内容、そして未マージのコードがどこにあるかを返します。',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary:
      '項目のディスカッションと変更履歴の1ページ分。コメントのスレッドと履歴が交互に並びます。',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'プルリクエストがどの作業項目を納品するかを宣言します。プルリクエストを開いた直後に、納品する作業項目ごとに1回ずつ呼び出してください。関連づけは SET なので、2回目の呼び出しは移動ではなく追加になり、webhook の配信が届く前でも機能します。',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      '2つの項目の間にエッジを作成します。blocked_by は、項目を準備完了の集合から外すエッジです。',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      '作業項目が何に基づいて作られるべきか(`blockersOf`)、またはプロジェクトの承認済みデザインの1ページ分。リンクは含まれないので、`get_design` から取得してください。',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'プロジェクトの全フォルダーを1回の読み取りで返します。各フォルダーの id とパスを含み、名前からフォルダーを探すのに使います。',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'このトークンでアクセスできる全プロジェクト。各プロジェクトに、他のすべてのツールが受け取る projectKey が付きます。',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'プロジェクトの準備完了レーンを1つ、ページ分けして返します。対象はリーフ(デフォルト。バグは含まず、それぞれが所属するコンテナを示す)、実行可能なコンテナ、またはバグのいずれかで、Ready ビューと同じ順序です。',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'プロジェクトの Sprint を、状態、ゴール、期間、作業項目数とともに返します。Sprint 系ツールが受け取る id も含みます。',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      '作業項目の ToDo リストを読み取ります。手順を順番に、どれが完了しているか、進捗を返します。',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      '項目の作業が取り込まれたことを記録します。それを運んだブランチ、PR、コミットを含みます。',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: '項目を Sprint から外し、バックログに戻します。',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      '項目の位置を変更します。新しい親の下へ、またはフォルダーの内外へ移動し、種別と親のマトリクスを適用して、循環は拒否します。',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      '項目を1回のアトミックな移動で Sprint に追加します。指定した順序で末尾に追加されます。',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: '作業項目の ToDo リストの手順を1つ、新しい位置に移動します。',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      '準備完了レーンの次の項目。リーフ(デフォルト。バグは含まない)またはバグを完全なディスパッチペイロードとして、あるいは親の実行用に次の実行可能なコンテナを返します。「次に何をするか」を知るための呼び出しです。',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      '計画の会話を開き、そのスレッドを読み取ります。id で指定するか、最近のものを開くか、新規に開きます。',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'アップロードした録画を、ストーリーの受け入れレシートとして登録します。レビュアーが視聴し、ゲートの拠り所となるものです。ほかに公開する手段はなく、公開されていなければ成功した実行とまったく同じに見えます。',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'ページを決定作業項目の決定として公開します。最新バージョンを確定し、エージェントの作業項目の場合は人に承認を求めます。',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'デザイン作業項目にデザイン結果を載せます。モック、およびレビュアーが開くリンクとしての領域ノートが対象で、開いている作業項目がそのデザインで blocked_by になっている場合に限ります。.png とインラインのノートはどちらも拒否され、新しいバージョンを受け付けない完了済みのデザイン作業項目も拒否されます。各アセットは base64 のインラインで渡すか、大きすぎて送れない場合は create_design_upload の許可で得たパス名として渡します。',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      '実行の HOW TO TEST を、その実行対象に載せます。実行が終わる前に載せ、後のコミットで手順が変わったときにも再度載せます。内容はセクション付きのリッチテキスト Markdown で、すべてのコマンドはフェンス付きコードブロック(クリックでコピー)に入れ、プッシュ先の各リポジトリのコミットも含めます。',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'プロジェクトの集合に含まれるリポジトリから、ref を指定して1ファイルのテキスト、またはディレクトリの直下のエントリを読みます。ホスト型計画者の読み取りと同様に上限と行範囲があり、見つからない場合もすべて名前付きの結果で示されます。',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      'プロジェクトの集合に含まれるリポジトリで、あるブランチが既定ブランチまたは指定したベースに対して変更したパスを一覧します。ホスト型計画者の一覧と同様に上限があり、見つからない場合もすべて名前付きの結果で示されます。',
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      '未承認の計画をなぜ変更しなければならなかったかを記録します。4つの分岐があり、うち2つは計画バグを起票します。計画自体には何も変更を加えません。',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      '見つけたレッスンが、たった今うまくいかなかったことを表していると記録します。あなたが変更するかどうかは問いません。',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      '作業項目で次に行う手順を伝える、マイルストーンを記録する、または開いている実行のハートビートを送ります。',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      '計画者セッションが今いる手順(settle、lay、author)を報告する、またはそれを終了します。生成中の計画に対する、助言的な進捗シグナルです。',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'ランナーが、HOW だけが誤っている計画と異なる形で実装した内容と、計画が何も定めていなかった点で下した判断を記録します。作業項目へのコメントと実行記録が残り、受理されます。',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'ディスパッチされたランナーが、停止した作業項目を実装不可として報告します。受理されるだけで、対応すべきことはありません。',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      '記録されたレッスンを意味で検索します。共有コーパスとこのプロジェクト固有のものが対象で、種別、タイプ、フェーズ、対象で絞り込めます。計画や実装の前に使います。',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      '詳細フィルタービルダーが書き出すものと同じフィルター文法で、プロジェクトの項目を検索します。',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'これはすでに作られていないか。部分文字列ではなく意味で検索し、キー、タイトル、スコアだけを返します。',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      '作業項目の ToDo リストの手順を1つ、完了にする、または完了を外します。最後の手順を完了にしても、作業項目のステータスは変わりません。',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'プロジェクト全体のツリー構造を1回の読み取りで返します。全項目のキー、種別、タイトル、ステータス、親、フォルダー、陳腐化マークを含み、ページ送りのループは不要です。',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: '計画中の Sprint を開始し、プロジェクトのアクティブな Sprint にします。',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      '保持している作業項目について自分の実行を開始します。ハーネスとモデルを指定すると、Runs と作業項目に表示されます。',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: '会話で蓄積された意図を、1つの変更セットとして計画者に送ります。',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      '作業項目の引き継ぎを維持します。5分間応答のない引き継ぎは終了され、ロックが解放されます。',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary: '作業項目の修復を維持します。5分間応答のない修復は終了され、ロックが解放されます。',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary: '項目を別のステータスに移します。不正な移動は、有効な移動先を示して返されます。',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'アーカイブした項目を復元します。archive の逆の操作です。',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      '`link_pull_request` を1件だけ取り消します。作業項目とプルリクエストの間に記録された納品を削除します。納品は1行のレコードなので、正しい作業項目を再リンクしても訂正にはならず追加になります。これは指定した1組だけを削除し、ほかの納品には手を付けません。',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'エッジを削除します。作成時に使ったのと同じ関係を指定します。',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'フォルダーの名前を変更する、または移動して並べ替えます。1回の呼び出しでどちらか一方のみで、両方はできません。',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      '読み取ったリビジョンを基準に、ページの本文全体を markdown で置き換えます。その後に保存されたページはマージされず、拒否されます。',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary: '計画自身のタイトルと要約(ツリーの上の見出し)を、提案には一切触れずに修正します。',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      '追加した提案を埋めます。計画が書かれている間の deepen ターンとして使うか、`revision: true` を付けて、すでにレビュー中の計画にある作業項目をその場で書き直します。',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      '提案を修正します。その親、依存および supersedes エッジ、陳腐化マークとメモ、リポジトリ軸全体(リポジトリ、行、集合、ロール)も含み、計画がレビュー中になった後でも可能です。修正されたマークは再チェックされるので、未完了の作業項目に設定すると拒否されます。',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Sprint の名前の変更、ゴールの変更、計画期間の調整を行います。',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary: '項目の任意のフィールドを編集します。create では設定できない説明本文も含みます。',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      '作業項目の ToDo リストの手順を1つ編集します。送信したフィールドだけが変わり、null を指定すると任意のフィールドがクリアされます。',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      '承認する場合にこの計画を受け入れられるか、完了可能か、すべてのエッジが同じ階層にあるか、親をまたぐエッジに親のエッジがあるか。`final: true` の前にこの4つすべてを確認します。他に確認する人はいません。',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'この Sprint は完了可能か。Sprint 外の作業にまだ止められている Sprint 内の項目をすべて挙げます。',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'このエピック、ストーリー、タスク、バグは完了可能か、すべてのエッジが同じ階層にあるか、親をまたぐエッジに親のエッジがあるか。足りないものを挙げます。',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'このトークンが誰のものか。所有ユーザー、アクティブなワークスペース、付与されたスコープを返します。最初に呼び出してください。',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary: 'レビュアーに計画全体の却下を求める代わりに、提案を1つ計画から外します。',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
