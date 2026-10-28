import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const nl: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Plaats een Markdown-reactie als de eigenaar van het token. @-mentions notificeren het genoemde Lid.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Leg een les vast voor dit Project, zodat latere Plannen ervoor de les meekrijgen. Alleen dit Project.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      "Voeg Voorstellen toe aan een Plan — sluit het af met een lege laatste batch, of voeg toe aan een Plan dat je al afsloot met `revision: true`; id's komen in volgorde terug, zodat de volgende batch er onderliggende items aan kan hangen. Een `modify` mag ook een AFGEROND werkitem als verouderd of afgeschreven markeren, met een notitie en supersedes-relaties (een `add` noemt de werkitems die hij vervangt in `supersedesRefs`), refs als key, id of `planItem:`-ref; het markeren van een onafgerond werkitem wordt geweigerd — verwijder het in plaats daarvan.",
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: 'Voeg één stap toe aan het einde van de to-dolijst van een werkitem.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Voeg één beurt toe aan een planningsgesprek, benoemd met zijn sessie-id — wat je aan het Plan veranderd wilt zien.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Verwijder een item zacht: het verdwijnt uit de ready-set en de zoekresultaten, en blijft volledig herstelbaar.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Zet een bestand OP een werkitem — een onderzoeksdocument, de notities van een review — zodat een lezer het resultaat op het werkitem ziet in plaats van naar een pull request te zoeken.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Wijzig de soort van een leaf als die verkeerd is ingedeeld — Subtaak naar Taak, en terug.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Claim atomair de volgende ready Subtaak in de actieve Sprint: wijs hem aan jou toe en zet hem op Bezig.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Claim atomair ÉÉN genoemd werkitem en zet het op Bezig. Een verloren claim zegt WIE het heeft.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Neem een werkitem over waarvan de laatste Run is gestorven of gestopt bij een poort die nu is goedgekeurd, zoals `motir continue` doet: zijn branch en pull requests, geen frisse start.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Neem het herstelslot op een werkitem met falende pull requests, zoals `motir fix` doet. Eén fixer tegelijk.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Beëindig je continue van een werkitem met hoe het ging, zodat de pagina het toont en het werkitem opnieuw kan worden voortgezet.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Beëindig je herstel van een werkitem met hoe het ging, zodat de pagina het toont en een nieuw herstel kan beginnen.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Beëindig je Run van een werkitem met hoe het ging; een afgeleverde afsluiting legt jou vast als de implementeerder.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'De gehoste codegraaf rond een zoekopdracht — het eigen antwoord van de gehoste planner, gepagineerd, elke afwezigheid een benoemde status.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Symbolen die bij een naam passen in de gehoste codegraaf — het eigen antwoord van de gehoste planner, gepagineerd.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Sluit een sessie-branch af nadat de PR is gemerged: elk item dat erop is vastgelegd gaat naar Klaar.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Rond de actieve Sprint af.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      'Maak een kortlevende presigned PUT voor de acceptatie-opname van een Story — stap 1 van 2, want een video is veel groter dan een tool-argument kan dragen. Upload de bytes rechtstreeks naar de opslag en registreer daarna de pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Maak een kortlevende presigned PUT voor een ontwerpasset die te groot is om inline te sturen — stap 1 van 2, want een grote asset is meer dan een tool-argument kan dragen. Upload de bytes rechtstreeks naar de opslag en publiceer daarna de pathname. Weigert een screenshot, een werkitem waar niets op wacht en een ontwerp-werkitem dat al Klaar is.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary: 'Maak een Map in de root of in een andere Map; namen zijn uniek per niveau.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Maak een pagina met een markdown-tekst — in de root, in een Map of als subpagina — en krijg zijn id en revisie terug.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Open een Plan om in voor te stellen — de reviewbare container die een Agent vult in plaats van items te schrijven.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Maak een geplande Sprint in een Project, met optioneel een naam, doel en geplande periode.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Maak een Epic, Story, Taak, Bug of Subtaak onder een bovenliggend item of in een Map; punten, Schatting, type, executor, moeilijkheid, repo, veroudering-markering en inhoudstaal in één aanroep.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Verwijder definitief een reactie die je schreef, met de antwoorden erop. Alleen de auteur kan hem hier verwijderen.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Verwijder een Map; de bijbehorende Mappen en werkitems gaan een niveau omhoog, en het resultaat toont wat is verplaatst.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Verwijder een geplande of afgeronde Sprint.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Verwijder een item en zijn hele substructuur definitief. Onomkeerbaar, en standaard uitgeschakeld.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: 'Verwijder definitief één stap van de to-dolijst van een werkitem.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'De door de server gegenereerde prompt voor een coding-agent voor één item — dezelfde tekst die de CLI aan een Agent geeft.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Vervang de tekst van een reactie die je schreef. Alleen de auteur kan hem hier bewerken.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Dien een AI-uitbreiding van één container-item in. Besteedt de credits van de eigenaar; Voorstellen wachten op Goedkeuring.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'De beslissing die een persoon over één goedkeuringspoort nam — de notitie die diegene schreef toen je werk werd teruggestuurd, wie die schreef, wanneer, en bij welke versie.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Is dit werkitem nog wat zijn laatst goedgekeurde Plan goedkeurde? Zijn Plan-geschiedenis en het oordeel.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'Per repository de indexstatus, de samenvatting van de laatste code-health-audit en de afgeleide codeerconventie — wat de gehoste planner leest.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'De codeconventie van één repository in zijn geheel, afgeleid of door een persoon bewerkt, met de versie – wat een wijziging in die repository volgt.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'Het GOEDGEKEURDE ontwerp van één ontwerp-werkitem, met kortlevende links naar de bestanden — of welke van de vijf redenen er is waarom er geen is.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Lees één pagina als markdown — titel, waar hij is opgeslagen, zijn revisie en nieuwste versie — om hem te lezen of terug te schrijven; of lees één versie op nummer.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Een Plan met de Voorstellen die het bundelt: wat de planner daadwerkelijk heeft voorgesteld, niet alleen hoeveel — inclusief een voorgestelde veroudering-markering (huidig → voorgesteld, met de notitie) en de supersedes-relaties, benoemd met hun key.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'Wat er van een ingediende planningstaak is geworden — de status en hoeveel Voorstellen hij opleverde.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'De planningsvoorwaarden van een Project — vastgelegd, code gekoppeld, geïndexeerd, repository ingesteld — en de inhoudstaal van de organisatie, voordat je plant.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Eén item in zijn geheel — beschrijving, status, bovenliggend item of Map, onderliggende items, afhankelijkheidsrelaties, een gereedheidsoordeel, de gekoppelde fouten en de laatste weigering die erop is teruggestuurd.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, and the latest refusal sent back on it.',
  },
  get_work_item_activity: {
    summary:
      'Eén pagina van de discussie en het wijzigingsspoor van een item: reactiedraden en geschiedenis, door elkaar.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Geef aan welk werkitem een pull request oplevert — roep het direct na het openen van een pull request aan, één keer per werkitem dat hij oplevert. De koppeling is een SET, dus een tweede aanroep VOEGT TOE in plaats van te verplaatsen, en het werkt voordat er een webhook-levering is binnengekomen.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Maak een relatie tussen twee items — blocked_by is degene die een item buiten de ready-set houdt.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Waartegen een werkitem moet worden gebouwd (`blockersOf`), of een pagina met de goedgekeurde ontwerpen van het Project. Geen links — haal die uit `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Elke Map van een Project in één leesactie — de id en het pad van elke Map — om een Map op naam te vinden.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Elk Project dat dit token kan bereiken, elk met de projectKey die elke andere tool nodig heeft.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Eén ready-BAAN van een Project, gepagineerd — leaves (standaard, nooit een Bug, elk met zijn container erbij genoemd), uitvoerbare containers, of Bugs — in de volgorde van de Ready-weergave.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      "De Sprints van een Project met status, doel, periode en aantal items, en de id's die de Sprint-tools nodig hebben.",
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Lees de to-dolijst van een werkitem: de stappen op volgorde, welke klaar zijn en de voortgang.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      'Leg vast dat het werk van een item is geland — de branch, de PR en de commit die het droeg.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Verplaats items uit hun Sprint terug naar de Backlog.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Plaats een item elders — onder een nieuw bovenliggend item, of in of uit een Map — met handhaving van de soort-bovenliggend-matrix en weigering van een cyclus.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      'Voeg items in één atomaire verplaatsing aan een Sprint toe, toegevoegd in de opgegeven volgorde.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: 'Verplaats één stap van de to-dolijst van een werkitem naar een nieuwe positie.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'Het volgende item van één ready-baan — een leaf (standaard, nooit een Bug) of een Bug als volledige dispatch-payload, of de volgende uitvoerbare container voor een parent-Run. De aanroep ‘wat doe ik nu’.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Open een planningsgesprek — op id, je meest recente of een nieuw — en lees de thread.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Registreer de geüploade opname als het acceptatiebewijs van de Story — wat een reviewer bekijkt en waar de poort op rust. Niets anders publiceert het, en een ontbrekende publicatie ziet er precies uit als een geslaagde Run.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Publiceer een pagina als de beslissing van een beslissings-werkitem: verzegelt de nieuwste versie en vraagt bij een Agent-werkitem een persoon om die goed te keuren.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Zet het ontwerp-RESULTAAT op een ontwerp-werkitem — de mock(s) en de gebiedsnotitie als link, wat een reviewer opent — alleen wanneer een open werkitem blocked_by het ontwerp is. Geen .png en geen inline notitie: beide worden geweigerd, net als een ontwerp-werkitem dat Klaar is, dat geen nieuwe versie accepteert. Elke asset komt inline als base64, of als de pathname van een create_design_upload-grant wanneer hij te groot is om te sturen.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Zet de HOE TE TESTEN van een RUN op zijn run-doel — voordat de Run eindigt, en opnieuw wanneer een latere commit een stap wijzigt: rich-text Markdown met secties en elk commando in een fenced codeblok (klik-om-te-kopiëren), plus de commit van elke repository waarnaar hij pushte.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'De tekst van één bestand, of de directe items van een map, uit een repository in de set van het Project, bij een ref — begrensd en per regelbereik zoals de leesactie van de gehoste planner, elke afwezigheid een benoemde uitkomst.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Leg vast WAAROM een niet-goedgekeurd Plan moest veranderen — vier takken, waarvan twee een planningsbug aanmaken; het verandert niets aan het Plan.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Leg vast dat een les die je vond beschrijft wat net misging — of je daarnaast ook iets wijzigt of niet.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Meld de stap die je op een werkitem gaat zetten, leg een mijlpaal vast, of stuur een heartbeat voor je open Runs.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Meld de stap waarop een planner-sessie zit (settle, lay, author) of beëindig hem — een adviserend voortgangssignaal op een Plan dat wordt gegenereerd.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Een runner legt vast wat hij anders bouwde dan een plan dat alleen in het HOE niet klopte, en welke beslissingen hij nam waar het plan niets zei — een opmerking op het werkitem en een runregistratie, bevestigd.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Een uitgezonden runner meldt het werkitem waarop hij stopte als niet te bouwen — bevestigd, niets om op te handelen.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Doorzoek vastgelegde lessen op betekenis — het gedeelde corpus en die van dit Project zelf — beperkt op kind, type, phase en subject, voordat je plant of bouwt.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Doorzoek de items van een Project met dezelfde filtergrammatica als de geavanceerde filterbouwer schrijft.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'Is dit al gebouwd? Zoek op BETEKENIS in plaats van op deeltekst — alleen keys, titels en scores.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Vink één stap van de to-dolijst van een werkitem aan of uit. Het aanvinken van de laatste stap wijzigt de status van het werkitem niet.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'De hele boomstructuur van het Project in één leesactie — key, soort, titel, status, bovenliggend item, Map en veroudering-markering van elk item, zonder paginalus.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Start een geplande Sprint en maak hem de actieve Sprint van het Project.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Open je eigen Run van een werkitem dat je vasthoudt, waarbij je je harness en model noemt, zodat die verschijnt bij Runs en op het werkitem.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: 'Stuur de opgebouwde intentie van het gesprek als één wijzigingsset naar de planner.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Houd je continue van een werkitem in leven. Een continue die vijf minuten stil is, wordt gesloten en zijn slot vrijgegeven.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Houd je herstel van een werkitem in leven. Een herstel dat vijf minuten stil is, wordt gesloten en zijn slot vrijgegeven.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Zet een item in een andere status. Een niet-toegestane overgang komt terug met de overgangen die wel toegestaan zijn.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Herstel een gearchiveerd item — het omgekeerde van archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Maak ÉÉN `link_pull_request` ongedaan — verwijder de levering die is vastgelegd tussen een werkitem en een pull request. Een levering is een rij, dus het opnieuw koppelen van het juiste werkitem VOEGT TOE in plaats van te corrigeren; dit verwijdert precies het ene paar dat je noemt en laat elke andere levering met rust.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Verwijder een relatie, gegeven dezelfde relatie die voor het maken is gebruikt.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Hernoem een Map, of verplaats en herorden hem — het een of het ander per aanroep, nooit beide.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Vervang de hele tekst van een pagina door markdown op de revisie die je las; een pagina die sindsdien is opgeslagen wordt geweigerd, niet samengevoegd.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Corrigeer de EIGEN titel en samenvatting van een Plan — de kop boven de boom — zonder één Voorstel aan te raken.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Vul een Voorstel in dat je toevoegde — de deepen-beurt terwijl het Plan wordt geschreven, of, met `revision: true`, een herschrijving van een werkitem in een Plan dat al in review is, ter plekke.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Corrigeer een Voorstel — inclusief zijn bovenliggende item, zijn afhankelijkheids- en supersedes-relaties, zijn veroudering-markering en notitie, en zijn hele repository-as (een repo, een rij, een set of een rol) — zelfs nadat het Plan in review is; een gecorrigeerde markering wordt opnieuw gecontroleerd, dus het instellen ervan op een onafgerond werkitem wordt geweigerd.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Hernoem een Sprint, wijzig zijn doel, of pas zijn geplande periode aan.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Bewerk elke subset van de velden van een item, inclusief de toelichting die create niet kan instellen.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Bewerk één stap van de to-dolijst van een werkitem. Alleen de velden die je stuurt veranderen; null wist een optioneel veld.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      'Zou ‘approve’ dit plan OVERNEMEN, is het afrondbaar, ligt elke relatie op één niveau, en hebben de relaties tussen verschillende bovenliggende items hun bovenliggende relaties? Alle vier, vóór `final: true` — niemand anders vraagt het.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'Is deze Sprint afrondbaar? Noemt elk item in de Sprint dat nog wordt tegengehouden door werk buiten de Sprint.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'Is deze Epic, Story, Taak of Bug afrondbaar, ligt elke relatie op één niveau, en hebben de relaties tussen verschillende bovenliggende items hun bovenliggende relaties? Noemt wat ontbreekt.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Wie dit token is: de eigenaar, de actieve Werkruimte en de verleende scopes. Roep dit eerst aan.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary:
      'Haal één Voorstel van een Plan af, in plaats van een reviewer te vragen het hele Plan af te wijzen.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
