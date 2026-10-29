import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const de: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Einen Markdown-Kommentar als Token-Eigentümer posten. Erwähnungen benachrichtigen das genannte Mitglied.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Eine Lektion für dieses Projekt aufzeichnen, damit spätere Pläne für dieses Projekt sie berücksichtigen. Nur dieses Projekt.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      'Vorschläge an einen Plan anhängen – schließen Sie ihn mit einem leeren finalen Batch ab, oder ergänzen Sie einen bereits geschlossenen mit `revision: true`; IDs kommen der Reihe nach zurück, sodass der nächste Batch Kinder daran hängen kann. Ein `modify` kann auch ein ABGESCHLOSSENES Arbeitselement als veraltet oder abgekündigt markieren, mit Notiz und supersedes-Kanten (ein `add` nennt die Arbeitselemente, die es ersetzt, in `supersedesRefs`), Referenzen als Schlüssel, ID oder `planItem:`-Referenz; ein unabgeschlossenes Arbeitselement zu markieren wird abgelehnt – entfernen Sie es stattdessen.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: 'Einen Schritt ans Ende der To-do-Liste eines Arbeitselements anhängen.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Einen Beitrag zu einer Planungskonversation hinzufügen, benannt nach ihrer Session-ID – was am Plan geändert werden soll.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Ein Element weich entfernen: Es verlässt die bereite Menge und die Suche und bleibt vollständig wiederherstellbar.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Eine Datei AN ein Arbeitselement legen – ein Dokument mit Rechercheergebnissen, die Notizen zu einem Review –, damit ein Leser das Ergebnis am Arbeitselement sieht, statt nach einem Pull Request suchen zu müssen.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Die Art eines Blatts umklassifizieren, wenn es falsch abgelegt ist – Unteraufgabe zu Aufgabe und zurück.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Die nächste bereite Unteraufgabe im aktiven Sprint atomar beanspruchen: Sie wird Ihnen zugewiesen und auf In Arbeit gesetzt.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Genau EIN benanntes Arbeitselement atomar beanspruchen und auf In Arbeit setzen. Ein verlorener Anspruch nennt, WER es hält.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Ein Arbeitselement übernehmen, dessen letzter Lauf gestorben ist oder an einem inzwischen genehmigten Gate stehen blieb, wie es `motir continue` tut: seinen Branch und seine Pull Requests, kein Neustart.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Die Reparatursperre für ein Arbeitselement mit fehlschlagenden Pull Requests übernehmen, wie es `motir fix` tut. Immer nur ein Reparierender.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Ihr Continue eines Arbeitselements mit dem Ergebnis beenden, damit die Seite es zeigt und das Arbeitselement erneut fortgesetzt werden kann.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Ihre Reparatur eines Arbeitselements mit dem Ergebnis beenden, damit die Seite es zeigt und eine neue Reparatur beginnen kann.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Ihren Lauf eines Arbeitselements mit dem Ergebnis beenden; ein Abschluss mit Lieferung erfasst Sie als Umsetzenden.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'Der gehostete Code-Graph rund um eine Abfrage – die eigene Antwort des gehosteten Planers, seitenweise, jede Abwesenheit ein benannter Zustand.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Symbole, die zu einem Namen im gehosteten Code-Graphen passen – die eigene Antwort des gehosteten Planers, seitenweise.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Einen Session-Branch abschließen, nachdem sein PR gemergt wurde: Jedes darauf erfasste Element wechselt zu Erledigt.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: {
    summary: 'Den aktiven Sprint abschließen.',
    source: 'Complete the active sprint.',
  },
  create_acceptance_upload: {
    summary:
      'Ein kurzlebiges vorsigniertes PUT für die Abnahmeaufzeichnung einer Story erzeugen – Schritt 1 von 2, weil ein Video viel größer ist, als ein Tool-Argument tragen kann. Laden Sie die Bytes direkt in den Speicher hoch und registrieren Sie dann den pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Ein kurzlebiges vorsigniertes PUT für ein Design-Asset erzeugen, das zu groß für die Inline-Übergabe ist – Schritt 1 von 2, weil ein großes Asset mehr ist, als ein Tool-Argument tragen kann. Laden Sie die Bytes direkt in den Speicher hoch und veröffentlichen Sie dann den pathname. Lehnt einen Screenshot, ein Arbeitselement, auf das nichts wartet, und ein erledigtes Design-Arbeitselement ab.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary:
      'Einen Ordner auf der Wurzelebene oder in einem anderen Ordner anlegen; Namen sind pro Ebene eindeutig.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Eine Seite mit einem Markdown-Text anlegen – auf der Wurzelebene, in einem Ordner oder als Unterseite – und ihre ID und Revision erhalten.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Einen Plan öffnen, in den hinein vorgeschlagen wird – der prüfbare Container, den ein Agent füllt, statt Elemente zu schreiben.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Einen geplanten Sprint in einem Projekt anlegen, mit optionalem Namen, Ziel und geplantem Zeitraum.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Einen Epic, eine Story, Aufgabe, einen Bug oder eine Unteraufgabe unter einem übergeordneten Element oder in einem Ordner anlegen; Punkte, Schätzung, Typ, Ausführender, Schwierigkeit, Repository, Veraltet-Markierung und Inhaltssprache in einem Aufruf.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Einen selbst geschriebenen Kommentar samt Antworten endgültig löschen. Nur sein Autor kann ihn hier löschen.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Einen Ordner löschen; seine Ordner und Arbeitselemente rücken nach oben, und das Ergebnis listet auf, was verschoben wurde.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Einen geplanten oder abgeschlossenen Sprint löschen.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Ein Element und seinen gesamten Teilbaum endgültig löschen. Nicht umkehrbar und standardmäßig aus.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: 'Einen Schritt der To-do-Liste eines Arbeitselements endgültig löschen.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'Der vom Server erzeugte Coding-Agent-Prompt für ein Element – derselbe Text, den die CLI einem Agenten übergibt.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Den Text eines selbst geschriebenen Kommentars ersetzen. Nur sein Autor kann ihn hier bearbeiten.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Eine KI-Erweiterung eines Container-Elements einreichen. Verbraucht die Credits des Eigentümers; Vorschläge warten auf Genehmigung.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'Die Entscheidung, die eine Person zu einem Genehmigungs-Gate getroffen hat – die Notiz, die sie beim Zurückgeben Ihrer Arbeit geschrieben hat, wer sie geschrieben hat, wann und zu welcher Version.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Ist dieses Arbeitselement noch das, was sein letzter genehmigter Plan genehmigt hat? Seine Planhistorie und das Urteil.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'Indexzustand jedes Repositorys, Zusammenfassung des letzten Code-Health-Audits und abgeleitete Coding-Konvention – was der gehostete Planer liest.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'Die Coding-Konvention eines Repositorys im Volltext – abgeleitet oder von einer Person bearbeitet, mit ihrer Version – woran sich eine Änderung in diesem Repository hält.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'Das GENEHMIGTE Design eines Design-Arbeitselements mit kurzlebigen Links zu seinen Dateien – oder welcher von fünf Gründen vorliegt, warum es keines gibt.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Eine Seite als Markdown lesen – ihr Titel, wo sie abgelegt ist, ihre Revision und neueste Version –, um sie zu lesen oder zurückzuschreiben; oder eine Version per Nummer lesen.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Ein Plan mit den Vorschlägen, die er bündelt: was der Planer tatsächlich vorgeschlagen hat, nicht nur wie viel – einschließlich einer vorgeschlagenen Veraltet-Markierung (aktuell → vorgeschlagen, mit Notiz) und ihrer supersedes-Kanten, benannt nach Schlüssel.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'Was aus einem eingereichten Planungsauftrag geworden ist – sein Zustand und wie viele Vorschläge er erzeugt hat.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'Die Planungsvoraussetzungen eines Projekts – eingerichtet, Code verbunden, indexiert, Repository gesetzt – und die Inhaltssprache seiner Organisation, bevor Sie planen.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Ein Element vollständig – Beschreibung, Status, übergeordnetes Element oder Ordner, untergeordnete Elemente, Abhängigkeitskanten, ein Bereitschaftsurteil, die damit verknüpften Fehler, die letzte dazu zurückgesendete Ablehnung und wo sein noch nicht gemergter Code liegt.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary:
      'Eine Seite aus der Diskussion und dem Änderungsverlauf eines Elements: Kommentarthreads und Verlauf, ineinander verschränkt.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Angeben, welches Arbeitselement ein Pull Request liefert – rufen Sie es direkt nach dem Öffnen auf, einmal pro Arbeitselement, das er liefert. Die Zuordnung ist eine MENGE, ein zweiter Aufruf ERGÄNZT also, statt zu verschieben, und sie funktioniert, bevor irgendeine Webhook-Zustellung eingetroffen ist.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Eine Kante zwischen zwei Elementen anlegen – blocked_by ist die, die ein Element aus der Menge der bereiten heraushält.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Wogegen ein Arbeitselement gebaut werden soll (`blockersOf`), oder eine Seite der genehmigten Designs des Projekts. Keine Links – diese holen Sie mit `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Alle Ordner eines Projekts in einem Abruf – die ID und der Pfad jedes Ordners –, um einen Ordner anhand seines Namens zu finden.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Alle Projekte, die dieses Token erreichen kann, jeweils mit dem projectKey, den jedes andere Tool erwartet.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Eine bereite SPUR eines Projekts, seitenweise – Blätter (Standard, nie ein Bug, jedes mit Nennung seines Containers), ausführbare Container oder Bugs – in der Reihenfolge, in der die Ready-Ansicht sie zeigt.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'Die Sprints eines Projekts mit Zustand, Ziel, Zeitraum und Anzahl der Elemente sowie den IDs, die die Sprint-Tools erwarten.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Die To-do-Liste eines Arbeitselements lesen: ihre Schritte in Reihenfolge, welche erledigt sind, und den Fortschritt.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      'Festhalten, dass die Arbeit eines Elements gelandet ist – der Branch, der PR und der Commit, die sie getragen haben.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Elemente aus ihrem Sprint heraus zurück ins Backlog verschieben.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Ein Element neu einordnen – unter ein neues übergeordnetes Element oder in einen Ordner hinein bzw. aus ihm heraus – unter Durchsetzung der Art-Eltern-Matrix und Ablehnung eines Zyklus.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      'Elemente in einem atomaren Schritt zu einem Sprint hinzufügen, in der angegebenen Reihenfolge angehängt.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary:
      'Einen Schritt der To-do-Liste eines Arbeitselements an eine neue Position verschieben.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'Das nächste Element einer bereiten Spur – ein Blatt (Standard, nie ein Bug) oder ein Bug als vollständige Dispatch-Nutzlast, oder der nächste ausführbare Container für einen Eltern-Lauf. Der Aufruf für „Was tue ich als Nächstes“.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Eine Planungskonversation öffnen – per ID, Ihre jüngste oder eine neue – und ihren Thread lesen.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Die hochgeladene Aufzeichnung als Abnahmebeleg der Story registrieren – das, was ein Reviewer ansieht und worauf das Gate beruht. Nichts anderes veröffentlicht sie, und eine fehlende Veröffentlichung sieht genau aus wie ein erfolgreicher Lauf.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Eine Seite als Entscheidung eines Entscheidungs-Arbeitselements veröffentlichen: Sie versiegelt dessen neueste Version und bittet bei einem Agent-Arbeitselement eine Person, sie zu genehmigen.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Das DESIGNERGEBNIS auf ein Design-Arbeitselement legen – die Mock(s) und die Bereichsnotiz als Link, was ein Reviewer öffnet – nur wenn ein offenes Arbeitselement von diesem Design blocked_by ist. Kein .png und keine Inline-Notiz: beides wird abgelehnt, ebenso ein erledigtes Design-Arbeitselement, das keine neue Version annimmt. Jedes Asset kommt inline als base64 oder als pathname eines create_design_upload-Grants, wenn es zu groß zum Senden ist.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Die ANLEITUNG ZUM TESTEN eines LAUFS auf sein Laufziel legen – bevor der Lauf endet und erneut, wenn ein späterer Commit einen Schritt ändert: Rich-Text-Markdown mit Abschnitten und jedem Befehl in einem Fenced-Codeblock (Klick zum Kopieren), dazu der Commit jedes Repositorys, in das gepusht wurde.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'Der Text einer Datei oder die direkten Einträge eines Verzeichnisses aus einem Repository in der Repository-Menge des Projekts bei einem ref – begrenzt und zeilenweise wie der Abruf des gehosteten Planers, jede Abwesenheit ein benanntes Ergebnis.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      'Die Pfade, die ein Branch in einem Repository der Repository-Menge des Projekts geändert hat, gegenüber seinem Standard-Branch oder einer benannten Basis – begrenzt wie die Auflistung des gehosteten Planers, jede Abwesenheit ein benanntes Ergebnis.',
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Festhalten, WARUM ein nicht genehmigter Plan geändert werden musste – vier Zweige, von denen zwei einen Planungs-Bug anlegen; am Plan selbst ändert es nichts.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Festhalten, dass eine gefundene Lektion etwas beschreibt, das gerade schiefgelaufen ist – unabhängig davon, ob Sie sie auch ändern.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Den Schritt nennen, den Sie als Nächstes an einem Arbeitselement unternehmen, einen Meilenstein festhalten oder einen Heartbeat für Ihre offenen Läufe senden.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Den Schritt melden, bei dem eine Planer-Session steht (settle, lay, author), oder sie beenden – ein beratendes Fortschrittssignal für einen Plan in Erzeugung.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Ein Runner hält fest, was er anders gebaut hat als ein nur im WIE falscher Plan, und welche Entscheidungen er traf, wo der Plan schwieg – ein Kommentar am Element und ein Laufeintrag, bestätigt.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Ein ausgesendeter Runner meldet das Arbeitselement, bei dem er gestoppt hat, als nicht baubar – bestätigt, nichts zu tun.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Aufgezeichnete Lektionen nach Bedeutung durchsuchen – das gemeinsame Korpus und die des eigenen Projekts –, eingegrenzt nach Art, Typ, Phase und Thema, bevor Sie planen oder bauen.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Elemente eines Projekts mit derselben Filtergrammatik durchsuchen, die der erweiterte Filter-Builder schreibt.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'Wurde das schon gebaut? Suche nach BEDEUTUNG statt nach Teilzeichenfolge – nur Schlüssel, Titel und Scores.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Einen Schritt der To-do-Liste eines Arbeitselements abhaken oder die Markierung entfernen. Das Abhaken des letzten Schritts ändert den Status des Arbeitselements nicht.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'Die Baumstruktur des ganzen Projekts in einem Abruf – Schlüssel, Art, Titel, Status, übergeordnetes Element, Ordner und Veraltet-Markierung jedes Elements, ohne Seitenschleife.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Einen geplanten Sprint starten und ihn zum aktiven Sprint des Projekts machen.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Ihren eigenen Lauf eines Arbeitselements öffnen, das Sie halten, unter Nennung von Harness und Modell, damit er unter Läufe und am Arbeitselement erscheint.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary:
      'Die angesammelte Absicht der Konversation als einen Änderungssatz an den Planer senden.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Ihr Continue eines Arbeitselements am Leben halten. Ein Continue, das fünf Minuten stumm bleibt, wird geschlossen und seine Sperre freigegeben.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Ihre Reparatur eines Arbeitselements am Leben halten. Eine Reparatur, die fünf Minuten stumm bleibt, wird geschlossen und ihre Sperre freigegeben.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Ein Element in einen anderen Status überführen. Ein unzulässiger Übergang kommt mit den zulässigen zurück.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Ein archiviertes Element wiederherstellen – die Umkehrung von archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'EINEN `link_pull_request` rückgängig machen – die zwischen einem Arbeitselement und einem Pull Request erfasste Lieferung entfernen. Eine Lieferung ist eine Zeile, erneutes Verknüpfen des richtigen Arbeitselements ERGÄNZT also, statt zu korrigieren; dies entfernt genau das eine Paar, das Sie nennen, und lässt jede andere Lieferung unberührt.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Eine Kante entfernen, angegeben mit derselben Beziehung, mit der sie angelegt wurde.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Einen Ordner umbenennen oder verschieben und umsortieren – pro Aufruf das eine oder das andere, nie beides.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Den gesamten Text einer Seite mit Markdown ersetzen, bezogen auf die gelesene Revision; eine seither gespeicherte Seite wird abgelehnt, nicht zusammengeführt.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Titel und Zusammenfassung des Plans SELBST korrigieren – die Überschrift über dem Baum –, ohne einen einzigen Vorschlag anzutasten.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Einen angehängten Vorschlag ausfüllen – der Vertiefungsschritt, während der Plan geschrieben wird, oder mit `revision: true` eine direkte Neufassung eines Arbeitselements in einem Plan, der sich bereits in Prüfung befindet.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Einen Vorschlag korrigieren – einschließlich seines übergeordneten Elements, seiner Abhängigkeits- und supersedes-Kanten, seiner Veraltet-Markierung samt Notiz und seiner gesamten Repository-Achse (ein Repository, eine Zeile, eine Menge oder eine Rolle) – auch nachdem der Plan in Prüfung ist; eine korrigierte Markierung wird erneut geprüft, das Setzen einer solchen auf einem unabgeschlossenen Arbeitselement wird also abgelehnt.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Einen Sprint umbenennen, sein Ziel ändern oder seinen geplanten Zeitraum anpassen.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Eine beliebige Teilmenge der Felder eines Elements bearbeiten, einschließlich des Erklärungstexts, den das Anlegen nicht setzen kann.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Einen Schritt der To-do-Liste eines Arbeitselements bearbeiten. Nur die Felder, die Sie senden, ändern sich; null leert ein optionales.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      'Würde die Genehmigung diesen Plan ÜBERNEHMEN, ist er abschließbar, liegt jede Kante auf einer Ebene und haben seine Kanten über Eltern hinweg ihre Eltern-Kanten? Alle vier Prüfungen vor `final: true` – niemand sonst fragt danach.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'Ist dieser Sprint abschließbar? Nennt jedes Element im Sprint, das noch durch Arbeit außerhalb blockiert wird.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'Ist dieser Epic, diese Story, Aufgabe oder dieser Bug abschließbar, liegt jede Kante auf einer Ebene und haben seine Kanten über Eltern hinweg ihre Eltern-Kanten? Nennt, was fehlt.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Wer dieses Token ist: der besitzende Benutzer, der aktive Arbeitsbereich und die gewährten Scopes. Rufen Sie es zuerst auf.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary:
      'Einen Vorschlag aus einem Plan nehmen, statt einen Reviewer zu bitten, das Ganze abzulehnen.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
