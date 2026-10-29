import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const it: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Pubblica un commento in Markdown come proprietario del token. Le menzioni notificano il Membro indicato.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Registra una lezione per questo Progetto, in modo che i Piani successivi la ricevano. Solo questo Progetto.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      'Aggiungi Proposte a un Piano: chiudilo con un batch finale vuoto, oppure aggiungi a uno che hai già chiuso con `revision: true`; gli id tornano in ordine, così il batch successivo può appendervi dei figli. Un `modify` può anche contrassegnare un elemento di lavoro COMPLETATO come obsoleto o deprecato, con una nota e archi supersedes (un `add` indica gli elementi di lavoro che sostituisce in `supersedesRefs`), con ref come chiave, id o ref `planItem:`; contrassegnare un elemento di lavoro non completato viene rifiutato: rimuovilo invece.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary:
      'Aggiungi un passaggio in fondo all’elenco delle cose da fare di un elemento di lavoro.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Aggiungi un turno a una conversazione di pianificazione, indicata dal suo session id: che cosa vuoi cambiare nel Piano.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Rimuovi un elemento in modo reversibile: esce dall’insieme dei pronti e dalla ricerca, e resta completamente ripristinabile.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Metti un file SU un elemento di lavoro, come un documento con i risultati di una ricerca o le note di una revisione, così chi legge vede il risultato consegnato sull’elemento di lavoro invece di cercare una pull request.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Riclassifica il kind di una foglia quando è archiviata in modo errato: da Sottoattività ad Attività, e viceversa.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Prendi in carico in modo atomico la prossima Sottoattività pronta nello Sprint attivo: te la assegna e la porta a In corso.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Prendi in carico in modo atomico UN elemento di lavoro indicato e portalo a In corso. Se la presa in carico fallisce, ti dice CHI lo detiene.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Riprendi un elemento di lavoro la cui ultima Esecuzione è morta o si è fermata a un gate che ora è approvato, come fa `motir continue`: il suo branch e le sue pull request, non un nuovo inizio.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Prendi il lock di riparazione su un elemento di lavoro con pull request in errore, come fa `motir fix`. Un solo riparatore alla volta.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Termina la tua ripresa di un elemento di lavoro indicando com’è andata, così la pagina la mostra e l’elemento può essere ripreso di nuovo.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Termina la tua riparazione di un elemento di lavoro indicando com’è andata, così la pagina la mostra e può iniziare una nuova riparazione.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Termina la tua Esecuzione di un elemento di lavoro indicando com’è andata; una chiusura con consegna ti registra come implementatore.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'Il grafo del codice ospitato attorno a una query: la risposta del planner ospitato stesso, paginata, con ogni assenza come stato nominato.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'I simboli che corrispondono a un nome nel grafo del codice ospitato: la risposta del planner ospitato stesso, paginata.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  code_grep: {
    summary:
      'Le righe che corrispondono a un testo o a un pattern nei contenuti indicizzati dei file (letterali stringa, commenti e file che non sono codice, che la ricerca dei simboli non vede): la risposta del planner ospitato stesso, paginata.',
    source:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Chiudi un branch di sessione dopo il merge della sua PR: ogni elemento registrato su di esso passa a Completato.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Completa lo Sprint attivo.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      'Genera un PUT presigned di breve durata per la registrazione di accettazione di una Storia, passaggio 1 di 2, perché un video è molto più grande di quanto un argomento di tool possa contenere. Carica i byte direttamente nello store, poi registra il pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Genera un PUT presigned di breve durata per un asset di design troppo grande per essere inviato inline, passaggio 1 di 2, perché un asset grande supera ciò che un argomento di tool può contenere. Carica i byte direttamente nello store, poi pubblica il pathname. Rifiuta uno screenshot, un elemento di lavoro di design che nessuno sta aspettando e un elemento di lavoro di design completato.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary:
      'Crea una Cartella alla radice o dentro un’altra Cartella; i nomi sono univoci per livello.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Crea una pagina con un corpo in markdown, alla radice, in una Cartella o come sottopagina, e ottieni il suo id e la sua revisione.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Apri un Piano in cui proporre: il contenitore revisionabile che un Agente riempie invece di scrivere elementi.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Crea uno Sprint pianificato in un Progetto, con nome, obiettivo e finestra pianificata facoltativi.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Crea un Epic, una Storia, un’Attività, un Bug o una Sottoattività sotto un genitore o in una Cartella; punti, Stima, type, executor, difficulty, repo, contrassegno di obsolescenza e lingua dei contenuti in una sola chiamata.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Elimina definitivamente un commento che hai scritto, con le sue risposte. Qui solo il suo autore può eliminarlo.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Elimina una Cartella; le sue Cartelle e i suoi elementi di lavoro salgono di livello e il risultato elenca che cosa è stato spostato.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Elimina uno Sprint pianificato o completato.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Elimina definitivamente un elemento e tutto il suo sottoalbero. Irreversibile e disattivato per impostazione predefinita.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary:
      'Elimina definitivamente un passaggio dell’elenco delle cose da fare di un elemento di lavoro.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'Il prompt per l’agente di codifica generato dal server per un elemento, lo stesso testo che la CLI consegna a un Agente.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Sostituisci il corpo di un commento che hai scritto. Qui solo il suo autore può modificarlo.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Invia un’espansione AI di un elemento contenitore. Spende i crediti del proprietario; le Proposte attendono l’Approvazione.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'La decisione presa da una persona su un gate di Approvazione: la nota che ha scritto quando ha rimandato indietro il tuo lavoro, chi l’ha scritta, quando e su quale versione.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Questo elemento di lavoro è ancora ciò che il suo ultimo Piano approvato ha approvato? La sua cronologia dei Piani e il verdetto.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'Lo stato dell’indice di ogni repository, il riepilogo dell’ultimo audit di salute del codice e la convenzione di codifica derivata: ciò che legge il planner ospitato.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'La convenzione di codice di un repository per intero, derivata o modificata da una persona, con la sua versione: ciò che una modifica in quel repository deve seguire.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'Il design APPROVATO di un elemento di lavoro di design, con link di breve durata ai suoi file, oppure quale dei cinque motivi spiega perché non ce n’è uno.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Leggi una pagina come markdown (titolo, dove è archiviata, revisione e versione più recente) per leggerla o per riscriverla; oppure leggi una versione per numero.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Un Piano con le Proposte che raggruppa: ciò che il planner ha effettivamente proposto, non solo quante, incluso un contrassegno di obsolescenza proposto (attuale → proposto, con la sua nota) e i suoi archi supersedes, indicati per chiave.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'Che cosa ne è stato di un job di pianificazione inviato: il suo stato e quante Proposte ha prodotto.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'Le precondizioni di pianificazione di un Progetto (stabilito, codice collegato, indicizzato, repository impostato) e la lingua dei contenuti della sua organizzazione, prima di pianificare.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Un elemento per intero: descrizione, stato, genitore o Cartella, figli, archi di dipendenza, un verdetto di prontezza, gli errori collegati, l’ultimo rifiuto rimandato indietro su di esso e dove si trova il suo codice non ancora unito.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary:
      'Una pagina della discussione e della cronologia delle modifiche di un elemento: thread di commenti e storico, intercalati.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Dichiara quale elemento di lavoro consegna una pull request: chiamalo subito dopo averne aperta una, una volta per ogni elemento di lavoro che consegna. L’associazione è un INSIEME, quindi una seconda chiamata AGGIUNGE anziché spostare, e funziona prima che sia arrivata qualsiasi consegna di webhook.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Crea un arco tra due elementi: blocked_by è quello che tiene un elemento fuori dall’insieme degli elementi pronti.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Ciò su cui deve essere costruito un elemento di lavoro (`blockersOf`), oppure una pagina dei design approvati del Progetto. Nessun link: ottienili da `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Tutte le Cartelle di un Progetto in una sola lettura, con l’id e il percorso di ciascuna, per trovare una Cartella per nome.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Tutti i Progetti raggiungibili con questo token, ciascuno con il projectKey che ogni altro tool richiede.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Una CORSIA pronta di un Progetto, paginata: foglie (predefinito, mai un Bug, ciascuna con il proprio contenitore), contenitori eseguibili oppure Bug, nell’ordine in cui li mostra la vista Pronti.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'Gli Sprint di un Progetto con stato, obiettivo, finestra e numero di elementi, e gli id richiesti dai tool degli Sprint.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Leggi l’elenco delle cose da fare di un elemento di lavoro: i suoi passaggi in ordine, quali sono completati e lo stato di avanzamento.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      'Registra che il lavoro di un elemento è arrivato a destinazione: il branch, la PR e il commit che lo hanno portato.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Sposta gli elementi fuori dal loro Sprint e di nuovo nel Backlog.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Ricolloca un elemento, sotto un nuovo genitore oppure dentro o fuori da una Cartella, applicando la matrice tipo-genitore e rifiutando un ciclo.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      'Aggiungi elementi a uno Sprint in un unico spostamento atomico, accodati nell’ordine indicato.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary:
      'Sposta un passaggio dell’elenco delle cose da fare di un elemento di lavoro in una nuova posizione.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'Il prossimo elemento di una corsia pronta: una foglia (predefinito, mai un Bug) o un Bug come payload di dispatch completo, oppure il prossimo contenitore eseguibile per un’Esecuzione genitore. La chiamata «che cosa faccio adesso».',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Apri una conversazione di pianificazione, tramite il suo id, la tua più recente o una nuova, e leggi il suo thread.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Registra la registrazione caricata come ricevuta di accettazione della Storia: ciò che un revisore guarda e su cui poggia il gate. Nient’altro la pubblica, e una pubblicazione mancante appare esattamente come un’esecuzione riuscita.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Pubblica una pagina come decisione di un elemento di lavoro di decisione: sigilla la sua versione più recente e, su un elemento di un Agente, chiede a una persona di approvarla.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Metti il RISULTATO del design su un elemento di lavoro di design (i mock e la nota dell’area come link, ciò che apre un revisore) solo quando un elemento di lavoro aperto è blocked_by il design. Niente .png e nessuna nota inline: entrambi vengono rifiutati, così come un elemento di lavoro di design completato, che non accetta nuove versioni. Ogni asset arriva inline come base64, oppure come pathname di una concessione di create_design_upload quando è troppo grande per essere inviato.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Metti il COME TESTARE di un’ESECUZIONE sul suo target di esecuzione, prima che l’Esecuzione termini e di nuovo quando un commit successivo cambia un passaggio: Markdown con formattazione, sezioni e ogni comando in un blocco di codice delimitato (copia con un clic), più il commit di ogni repository in cui ha fatto push.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'Il testo di un file, o le voci immediate di una directory, di un repository dell’insieme del Progetto, a un ref, con limiti di dimensione e intervalli di righe come la lettura del planner ospitato, con ogni assenza come esito nominato.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      'I percorsi che un branch ha modificato in un repository dell’insieme del Progetto, rispetto al suo branch predefinito o a una base indicata, con limiti come l’elenco del planner ospitato, con ogni assenza come esito nominato.',
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Registra PERCHÉ un Piano non approvato ha dovuto cambiare: quattro rami, due dei quali aprono un Bug di pianificazione; non cambia nulla del Piano.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Registra che una lezione che hai trovato descrive qualcosa che è appena andato storto, indipendentemente dal fatto che tu lo modifichi o no.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Comunica il passaggio che stai per compiere su un elemento di lavoro, registra una pietra miliare o invia un heartbeat per le tue Esecuzioni aperte.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Segnala il passaggio in cui si trova una sessione del planner (settle, lay, author) oppure terminala: un segnale di avanzamento indicativo su un Piano in generazione.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Un runner registra ciò che ha costruito diversamente da un piano sbagliato solo sul COME, e le decisioni prese dove il piano taceva: un commento sull’elemento e un record dell’esecuzione, con presa d’atto.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Un runner inviato segnala l’elemento di lavoro su cui si è fermato come non costruibile: preso atto, non c’è nulla da fare.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Cerca per significato le lezioni registrate, sia il corpus condiviso sia quelle di questo Progetto, filtrate per kind, type, phase e subject, prima di pianificare o costruire.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Cerca gli elementi di un Progetto con la stessa grammatica di filtro che scrive il generatore di filtri avanzati.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'È già stato costruito? Cerca per SIGNIFICATO anziché per sottostringa: solo chiavi, titoli e punteggi.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Spunta o rimuovi la spunta da un passaggio dell’elenco delle cose da fare di un elemento di lavoro. Spuntare l’ultimo passaggio non cambia lo stato dell’elemento di lavoro.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'La struttura ad albero dell’intero Progetto in una sola lettura: chiave, tipo, titolo, stato, genitore, Cartella e contrassegno di obsolescenza di ogni elemento, senza ciclo di paginazione.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Avvia uno Sprint pianificato, rendendolo quello attivo del Progetto.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Apri la tua Esecuzione di un elemento di lavoro che detieni, indicando il tuo harness e il modello, così compare in Esecuzioni e sull’elemento di lavoro.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: 'Invia al planner l’intento accumulato della conversazione come un unico change set.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Mantieni attiva la tua ripresa di un elemento di lavoro. Una ripresa silenziosa per cinque minuti viene chiusa e il suo lock rilasciato.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Mantieni attiva la tua riparazione di un elemento di lavoro. Una riparazione silenziosa per cinque minuti viene chiusa e il suo lock rilasciato.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Sposta un elemento a un altro stato. Una transizione non valida torna indietro indicando quelle valide.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Ripristina un elemento archiviato: l’inverso di archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Annulla UN solo `link_pull_request`: rimuovi la consegna registrata tra un elemento di lavoro e una pull request. Una consegna è una riga, quindi ricollegare l’elemento di lavoro giusto AGGIUNGE anziché correggere; questo rimuove esattamente la coppia che indichi e lascia intatte tutte le altre consegne.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Rimuovi un arco, data la stessa relazione usata per crearlo.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Rinomina una Cartella, oppure spostala e riordinala: l’una o l’altra cosa per chiamata, mai entrambe.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Sostituisci l’intero corpo di una pagina con markdown alla revisione che hai letto; una pagina salvata nel frattempo viene rifiutata, non unita.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Correggi il titolo e il riepilogo del Piano stesso, l’intestazione sopra l’albero, senza toccare nemmeno una Proposta.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Compila una Proposta che hai aggiunto: il turno di approfondimento mentre il Piano viene scritto oppure, con `revision: true`, la riscrittura sul posto di un elemento di lavoro in un Piano già in revisione.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Correggi una Proposta, inclusi il suo genitore, i suoi archi di dipendenza e supersedes, il suo contrassegno di obsolescenza e la nota, e l’intero asse del repository (un repo, una riga, un insieme o un ruolo), anche dopo che il Piano è in revisione; un contrassegno corretto viene ricontrollato, quindi impostarne uno su un elemento di lavoro non completato viene rifiutato.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Rinomina uno Sprint, cambia il suo obiettivo o modifica la sua finestra pianificata.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Modifica un sottoinsieme qualsiasi dei campi di un elemento, incluso il corpo della spiegazione che la creazione non può impostare.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Modifica un passaggio dell’elenco delle cose da fare di un elemento di lavoro. Cambiano solo i campi che invii; null cancella un campo facoltativo.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      'L’approvazione PRENDEREBBE questo Piano, è completabile, ogni arco è su un solo livello e i suoi archi tra genitori diversi hanno i loro archi genitore? Tutti e quattro i controlli, prima di `final: true`: nessun altro li farà.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'Questo Sprint è completabile? Indica ogni elemento dello Sprint ancora vincolato da lavoro esterno ad esso.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'Questo Epic, Storia, Attività o Bug è completabile, ogni arco è su un solo livello e i suoi archi tra genitori diversi hanno i loro archi genitore? Indica che cosa manca.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Chi è questo token: l’utente proprietario, l’Area di lavoro attiva e gli scope concessi. Chiamalo per primo.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary:
      'Togli una Proposta da un Piano, invece di chiedere a un revisore di rifiutare l’intero Piano.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
