import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const pt: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Publique um comentário em Markdown como o proprietário do token. As menções notificam o Membro nomeado.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Registre uma lição para este Projeto, para que os Planos futuros dele recebam a lição. Somente este Projeto.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      'Acrescente Propostas a um Plano — feche-o com um lote final vazio, ou acrescente a um que você já fechou com `revision: true`; os ids voltam em ordem, para que o próximo lote possa pendurar filhos neles. Um `modify` também pode marcar um item de trabalho CONCLUÍDO como desatualizado ou obsoleto, com uma nota e arestas supersedes (um `add` nomeia os itens de trabalho que substitui em `supersedesRefs`), refs como uma chave, um id ou uma ref `planItem:`; marcar um item de trabalho não concluído é recusado — remova-o em vez disso.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: 'Acrescente um passo ao final da lista de tarefas de um item de trabalho.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Adicione um turno a uma conversa de planejamento, nomeada pelo seu session id — o que você quer mudar no Plano.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Remova um item de forma suave: ele sai do conjunto de prontos e da busca, e continua totalmente restaurável.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Coloque um arquivo NO item de trabalho — um documento de resultados de pesquisa, as notas de uma revisão — para que o leitor veja o entregável no item de trabalho em vez de procurar um pull request.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Reclassifique o kind de uma folha quando ele estiver arquivado errado — subtask para task, e vice-versa.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Reivindique atomicamente a próxima Subtarefa pronta na Sprint ativa: atribua-a a você e mude-a para Em andamento.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Reivindique atomicamente UM item de trabalho nomeado e mude-o para Em andamento. Uma reivindicação perdida diz QUEM o detém.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Assuma um item de trabalho cuja última Execução morreu ou parou em um gate que agora está aprovado, como faz `motir continue`: sua branch e seus pull requests, não um começo do zero.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Assuma o lock de reparo de um item de trabalho com pull requests falhando, como faz `motir fix`. Um corretor por vez.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Encerre sua continuação de um item de trabalho dizendo como foi, para que a página a mostre e o item de trabalho possa ser continuado de novo.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Encerre seu reparo de um item de trabalho dizendo como foi, para que a página o mostre e um novo reparo possa começar.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Encerre sua Execução de um item de trabalho dizendo como foi; um encerramento entregue registra você como o implementador.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'O grafo de código hospedado em torno de uma consulta — a própria resposta do planejador hospedado, paginada, toda ausência um estado nomeado.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Símbolos que correspondem a um nome no grafo de código hospedado — a própria resposta do planejador hospedado, paginada.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  code_grep: {
    summary:
      'Linhas que correspondem a um texto ou padrão no conteúdo indexado dos arquivos — literais de string, comentários e arquivos que não são código, que a busca de símbolos não vê — a própria resposta do planejador hospedado, paginada.',
    source:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Encerre uma branch de sessão depois que seu PR foi mesclado: todo item registrado nela passa para Concluído.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Conclua a Sprint ativa.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      'Gere um PUT pré-assinado de curta duração para a gravação de aceitação de uma História — passo 1 de 2, porque um vídeo é muito maior do que um argumento de ferramenta consegue carregar. Envie os bytes direto para o armazenamento e depois registre o pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Gere um PUT pré-assinado de curta duração para um asset de design grande demais para ser enviado inline — passo 1 de 2, porque um asset grande é mais do que um argumento de ferramenta consegue carregar. Envie os bytes direto para o armazenamento e depois publique o pathname. Recusa uma captura de tela, um item de trabalho pelo qual nada espera e um item de trabalho de design concluído.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary: 'Crie uma Pasta na raiz ou dentro de outra Pasta; os nomes são únicos por nível.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Crie uma página com um corpo em markdown — na raiz, em uma Pasta ou como subpágina — e receba seu id e revisão.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Abra um Plano para propor nele — o contêiner revisável que um Agente preenche em vez de escrever itens.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Crie uma Sprint planejada em um Projeto, com nome, meta e janela planejada opcionais.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Crie um epic, story, task, bug ou subtask sob um pai ou em uma Pasta; pontos, Estimativa, type, executor, difficulty, repositório, marca de obsolescência e idioma do conteúdo em uma só chamada.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Exclua permanentemente um comentário que você escreveu, com suas respostas. Somente o autor pode excluí-lo aqui.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Exclua uma Pasta; suas Pastas e itens de trabalho sobem um nível, e o resultado lista o que foi movido.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Exclua uma Sprint planejada ou concluída.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Exclua permanentemente um item e toda a sua subárvore. Irreversível e desativado por padrão.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: 'Exclua permanentemente um passo da lista de tarefas de um item de trabalho.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'O prompt de agente de código gerado pelo servidor para um item — o mesmo texto que a CLI entrega a um agente.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Substitua o corpo de um comentário que você escreveu. Somente o autor pode editá-lo aqui.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Envie uma expansão por IA de um item contêiner. Gasta os créditos do proprietário; as Propostas aguardam Aprovação.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'A decisão que uma pessoa tomou em um gate de aprovação — a nota que ela escreveu ao devolver seu trabalho, quem a escreveu, quando e em qual versão.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Este item de trabalho ainda é o que seu último Plano aprovado aprovou? Seu histórico de Planos e o veredito.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'O estado de índice de cada repositório, o resumo da última auditoria de saúde do código e a convenção de código derivada — o que o planejador hospedado lê.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'A convenção de código de um repositório na íntegra, derivada ou editada por uma pessoa, com a sua versão: o que uma alteração nesse repositório segue.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'O design APROVADO de um item de trabalho de design, com links de curta duração para seus arquivos — ou qual dos cinco motivos explica por que não há nenhum.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Leia uma página como markdown — seu título, onde ela está arquivada, sua revisão e a versão mais recente — para lê-la ou para gravá-la de volta; ou leia uma versão pelo número.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Um plano com as propostas que ele reúne: o que o planejador de fato propôs, não apenas quantas — incluindo uma marca de obsolescência proposta (current → proposed, com sua nota) e suas arestas supersedes, nomeadas por chave.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'O que aconteceu com um job de planejamento enviado — seu estado e quantas propostas ele produziu.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'As pré-condições de planejamento de um Projeto — estabelecido, código conectado, indexado, repositório definido — e o idioma de conteúdo da organização, antes de você planejar.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Um item completo — descrição, status, pai ou Pasta, filhos, arestas de dependência, um veredito de prontidão, os erros vinculados a ele, a última recusa enviada de volta sobre ele e onde está o seu código ainda não mesclado.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary:
      'Uma página da discussão e do histórico de alterações de um item: threads de comentários e histórico, intercalados.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Declare qual item de trabalho um pull request entrega — chame-a logo depois de abrir um, uma vez por item de trabalho que ele entrega. A associação é um CONJUNTO, então uma segunda chamada ACRESCENTA em vez de mover, e funciona antes de qualquer entrega de webhook ter chegado.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Crie uma aresta entre dois itens — blocked_by é a que mantém um item fora do conjunto de prontos.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Contra o que um item de trabalho deve ser construído (`blockersOf`), ou uma página dos designs aprovados do Projeto. Sem links — obtenha-os com `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Todas as Pastas de um Projeto em uma só leitura — o id e o caminho de cada Pasta — para encontrar uma Pasta pelo nome.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Todo Projeto que este token consegue acessar, cada um com o projectKey que todas as outras ferramentas recebem.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Uma FAIXA de prontos de um Projeto, paginada — folhas (padrão, nunca um Bug, cada uma nomeando seu contêiner), contêineres executáveis ou Bugs — na ordem em que a visão Ready as mostra.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'As Sprints de um Projeto com estado, meta, janela e contagem de itens, e os ids que as ferramentas de Sprint recebem.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Leia a lista de tarefas de um item de trabalho: seus passos em ordem, quais estão concluídos e o progresso.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary: 'Registre que o trabalho de um item chegou — a branch, o PR e o commit que o levou.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Mova itens para fora de sua Sprint e de volta ao Backlog.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Reposicione um item — sob um novo pai, ou para dentro ou para fora de uma Pasta — aplicando a matriz de tipo e pai e recusando um ciclo.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      'Adicione itens a uma Sprint em um único movimento atômico, acrescentados na ordem informada.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: 'Mova um passo da lista de tarefas de um item de trabalho para uma nova posição.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'O próximo item de uma faixa de prontos — uma folha (padrão, nunca um Bug) ou um Bug como payload de despacho completo, ou o próximo contêiner executável para uma Execução de pai. A chamada “o que faço a seguir”.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Abra uma conversa de planejamento — pelo seu id, a sua mais recente ou uma nova — e leia sua thread.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Registre a gravação enviada como o recibo de aceitação da História — o que um revisor assiste e em que o gate se apoia. Nada mais o publica, e uma publicação ausente parece exatamente uma Execução bem-sucedida.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Publique uma página como a decisão de um item de trabalho de decisão: sela sua versão mais recente e, em um item de trabalho de Agente, pede a uma pessoa que a aprove.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Coloque o RESULTADO de design em um item de trabalho de design — o(s) mock(s) e a nota da área como um link, o que um revisor abre — somente quando um item de trabalho aberto está blocked_by o design. Nenhum .png e nenhuma nota inline: ambos são recusados, e também um item de trabalho de design concluído, que não aceita nova versão. Cada asset chega inline em base64, ou como o pathname de uma concessão de create_design_upload quando é grande demais para enviar.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Coloque o COMO TESTAR de uma EXECUÇÃO em seu alvo de execução — antes de a Execução terminar, e de novo quando um commit posterior mudar um passo: Markdown de texto rico com seções e todo comando em um bloco de código delimitado (clique para copiar), mais o commit de cada repositório para o qual ela fez push.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'O texto de um arquivo, ou as entradas imediatas de um diretório, de um repositório do conjunto do Projeto, em um ref — limitado e com intervalo de linhas como a leitura do planejador hospedado, toda ausência um resultado nomeado.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      'Os caminhos que um branch alterou em um repositório do conjunto do Projeto, em relação ao seu branch padrão ou a uma base indicada — limitado como a listagem do planejador hospedado, toda ausência um resultado nomeado.',
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Registre POR QUE um Plano não aprovado teve de mudar — quatro ramos, dois dos quais registram um bug de planejamento; não muda nada no Plano.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Registre que uma lição que você encontrou descreve algo que acabou de dar errado — quer você também a altere ou não.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Diga o passo que você está prestes a dar em um item de trabalho, registre um marco ou envie um heartbeat para suas Execuções abertas.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Informe o passo em que uma sessão do planejador está (settle, lay, author) ou encerre-a — um sinal de progresso consultivo em um Plano em geração.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Um runner registra o que construiu de forma diferente de um plano errado apenas no COMO, e as decisões que tomou onde o plano não dizia nada — um comentário no item e um registro da execução, reconhecido.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Um runner despachado informa que o item de trabalho em que parou não pode ser construído — reconhecido, nada a fazer.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Pesquise lições registradas por significado — o corpus compartilhado e o do próprio Projeto — filtradas por kind, type, phase e subject, antes de planejar ou construir.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Pesquise os itens de um Projeto com a mesma gramática de filtro que o construtor de filtros avançados escreve.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'Isso já foi construído? Pesquise por SIGNIFICADO em vez de por trecho de texto — apenas chaves, títulos e pontuações.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Marque ou desmarque um passo da lista de tarefas de um item de trabalho. Marcar o último passo não altera o status do item de trabalho.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'A estrutura de árvore do Projeto inteiro em uma só leitura — chave, tipo, título, status, pai, Pasta e marca de obsolescência de cada item, sem loop de paginação.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Inicie uma Sprint planejada, tornando-a a ativa do Projeto.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Abra sua própria Execução de um item de trabalho que você detém, nomeando seu harness e modelo, para que apareça em Execuções e no item de trabalho.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary:
      'Envie a intenção acumulada da conversa ao planejador como um único conjunto de mudanças.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Mantenha viva sua continuação de um item de trabalho. Uma continuação em silêncio por cinco minutos é encerrada e seu lock é liberado.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Mantenha vivo seu reparo de um item de trabalho. Um reparo em silêncio por cinco minutos é encerrado e seu lock é liberado.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Mova um item para outro status. Um movimento ilegal volta nomeando os que são legais.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Restaure um item arquivado — o inverso de archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Desfaça UM `link_pull_request` — remova a entrega registrada entre um item de trabalho e um pull request. Uma entrega é uma linha, então vincular de novo o item de trabalho certo ACRESCENTA em vez de corrigir; isto remove exatamente o par que você nomear e deixa toda outra entrega intacta.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Remova uma aresta, dada a mesma relação usada para criá-la.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Renomeie uma Pasta, ou mova-a e reordene-a — uma coisa ou outra por chamada, nunca ambas.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Substitua o corpo inteiro de uma página por markdown na revisão que você leu; uma página salva depois é recusada, não mesclada.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Corrija o PRÓPRIO título e resumo de um Plano — o cabeçalho acima da árvore — sem tocar em nenhuma Proposta.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Preencha uma Proposta que você acrescentou — o turno de aprofundamento enquanto o Plano está sendo escrito ou, com `revision: true`, uma reescrita de um item de trabalho em um Plano já em revisão, no lugar.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Corrija uma Proposta — incluindo seu pai, suas arestas de dependência e supersedes, sua marca de obsolescência e nota, e todo o seu eixo de repositório (um repo, uma linha, um conjunto ou um papel) — mesmo depois de o Plano estar em revisão; uma marca corrigida é verificada de novo, então defini-la em um item de trabalho não concluído é recusado.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Renomeie uma Sprint, mude sua meta ou ajuste sua janela planejada.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Edite qualquer subconjunto dos campos de um item, incluindo o corpo da explicação que a criação não consegue definir.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Edite um passo da lista de tarefas de um item de trabalho. Só os campos que você enviar mudam; null limpa um opcional.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      'A aprovação ACEITARIA este Plano, ele é finalizável, toda aresta está em um só nível e as arestas entre pais diferentes têm suas arestas de pai? Todas as quatro, antes de `final: true` — ninguém mais vai perguntar.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'Esta Sprint é finalizável? Nomeia todo item da Sprint que ainda é barrado por trabalho fora dela.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'Este epic, story, task ou bug é finalizável, toda aresta está em um só nível e as arestas entre pais diferentes têm suas arestas de pai? Nomeia o que está faltando.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Quem é este token: o usuário proprietário, o Espaço de trabalho ativo e os escopos concedidos. Chame-o primeiro.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary:
      'Retire uma Proposta de um Plano, em vez de pedir a um revisor que recuse o conjunto inteiro.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
