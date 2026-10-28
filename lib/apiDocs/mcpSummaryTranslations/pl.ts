import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const pl: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Opublikuj komentarz w Markdown jako właściciel tokenu. Wzmianki powiadamiają wskazanego Członka.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Zapisz lekcję dla tego Projektu, aby późniejsze Plany dla niego uwzględniały tę lekcję. Tylko ten Projekt.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      'Dołącz propozycje do Planu — zamknij go pustą końcową partią albo dodaj do już zamkniętego za pomocą `revision: true`; id wracają po kolei, więc następna partia może podpiąć pod nie elementy podrzędne. `modify` może też oznaczyć ZAKOŃCZONY element roboczy jako nieaktualny lub wycofany, z notatką i krawędziami supersedes (`add` wymienia zastępowane elementy w `supersedesRefs`), z odwołaniami jako klucz, id albo ref `planItem:`; oznaczenie niezakończonego elementu jest odrzucane — usuń go zamiast tego.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: 'Dołącz jeden krok na końcu listy zadań do zrobienia elementu roboczego.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Dodaj jedną turę do rozmowy planistycznej, wskazanej przez jej id sesji — co chcesz zmienić w Planie.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Miękko usuń element: znika ze zbioru gotowych i z wyszukiwania, a nadal można go w pełni przywrócić.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Umieść plik NA elemencie roboczym — dokument z wynikami badań, notatki z przeglądu — aby czytelnik widział rezultat na elemencie roboczym, zamiast szukać pull requesta.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Zmień rodzaj liścia, gdy został błędnie zakwalifikowany — z Podzadania na Zadanie i z powrotem.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Atomowo przejmij następne gotowe Podzadanie w aktywnym Sprincie: przypisz je do siebie i przełącz na W toku.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Atomowo przejmij JEDEN wskazany element roboczy i przełącz go na W toku. Przegrane przejęcie podaje, KTO go trzyma.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Przejmij element roboczy, którego ostatnie Uruchomienie zginęło albo zatrzymało się na bramce, która jest już zatwierdzona, tak jak robi to `motir continue`: jego gałąź i pull requesty, a nie nowy start.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Weź blokadę naprawy elementu roboczego z nieprzechodzącymi pull requestami, tak jak robi to `motir fix`. Jeden naprawiający naraz.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Zakończ swoją kontynuację elementu roboczego z informacją, jak poszło, aby strona to pokazała, a element można było kontynuować ponownie.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Zakończ swoją naprawę elementu roboczego z informacją, jak poszła, aby strona to pokazała i można było rozpocząć nową naprawę.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Zakończ swoje Uruchomienie elementu roboczego z informacją, jak poszło; zamknięcie z dostarczeniem zapisuje cię jako osobę wdrażającą.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'Hostowany graf kodu wokół zapytania — własna odpowiedź hostowanego planisty, stronicowana, każda nieobecność jako nazwany stan.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Symbole pasujące do nazwy w hostowanym grafie kodu — własna odpowiedź hostowanego planisty, stronicowana.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Zamknij gałąź sesji po scaleniu jej PR: każdy zapisany na niej element przechodzi do Gotowe.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Ukończ aktywny Sprint.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      'Wygeneruj krótkotrwały presigned PUT dla nagrania akceptacyjnego Historii — krok 1 z 2, ponieważ wideo jest znacznie większe, niż zmieści argument narzędzia. Prześlij bajty prosto do magazynu, a potem zarejestruj pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Wygeneruj krótkotrwały presigned PUT dla zasobu projektu zbyt dużego, by wysłać go inline — krok 1 z 2, ponieważ duży zasób jest większy, niż zmieści argument narzędzia. Prześlij bajty prosto do magazynu, a potem opublikuj pathname. Odmawia dla zrzutu ekranu, dla elementu roboczego z projektem, na który nic nie czeka, i dla elementu z projektem w stanie Gotowe.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary:
      'Utwórz folder w korzeniu lub wewnątrz innego folderu; nazwy są unikalne na każdym poziomie.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Utwórz stronę z treścią w markdown — w korzeniu, w folderze lub jako podstronę — i otrzymaj jej id i rewizję.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Otwórz Plan, do którego będziesz składać propozycje — kontener do przeglądu, który agent wypełnia zamiast pisać elementy.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Utwórz zaplanowany Sprint w Projekcie, z opcjonalną nazwą, celem i planowanym oknem czasowym.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Utwórz Epik, Historię, Zadanie, Błąd lub Podzadanie pod elementem nadrzędnym albo w folderze; punkty, oszacowanie, typ, executor, trudność, repozytorium, oznaczenie przestarzałości i język treści w jednym wywołaniu.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Trwale usuń napisany przez ciebie komentarz wraz z odpowiedziami. Tutaj usunąć go może tylko jego Autor.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Usuń folder; jego foldery i elementy robocze przenoszą się wyżej, a wynik wymienia, co zostało przeniesione.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Usuń zaplanowany lub ukończony Sprint.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Trwale usuń element wraz z całym jego poddrzewem. Nieodwracalne i domyślnie wyłączone.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: 'Trwale usuń jeden krok z listy zadań do zrobienia elementu roboczego.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'Wygenerowany przez serwer prompt dla agenta kodującego dotyczący jednego elementu — ten sam tekst, który CLI przekazuje agentowi.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Zastąp treść napisanego przez ciebie komentarza. Tutaj edytować go może tylko jego Autor.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Prześlij rozwinięcie AI jednego elementu-kontenera. Zużywa kredyty właściciela; propozycje czekają na zatwierdzenie.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'Decyzja, którą osoba podjęła w jednej bramce zatwierdzenia — notatka, którą napisała, odsyłając twoją pracę, kto ją napisał, kiedy i dla której wersji.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Czy ten element roboczy nadal jest tym, co zatwierdził jego ostatni zatwierdzony Plan? Jego historia planów i werdykt.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'Stan indeksu każdego repozytorium, podsumowanie ostatniego audytu kondycji kodu i wyprowadzona konwencja kodowania — to, co czyta hostowany planista.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'Pełna konwencja kodowania jednego repozytorium – wyprowadzona lub zredagowana przez osobę, z numerem wersji – to, czego trzyma się zmiana w tym repozytorium.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'ZATWIERDZONY projekt jednego elementu roboczego z projektem, z krótkotrwałymi linkami do jego plików — albo informacja, który z pięciu powodów sprawia, że go nie ma.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Odczytaj jedną stronę jako markdown — jej tytuł, gdzie jest zapisana, jej rewizję i najnowszą wersję — aby ją przeczytać lub zapisać z powrotem; albo odczytaj jedną wersję według numeru.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Plan wraz z propozycjami, które obejmuje: co planista faktycznie zaproponował, a nie tylko ile — w tym proponowane oznaczenie jako przestarzałe (bieżące → proponowane, z notatką) oraz jego krawędzie supersedes, nazwane kluczami.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'Co się stało ze zleconym zadaniem planowania — jego stan i ile propozycji wytworzyło.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'Warunki wstępne planowania w Projekcie — ustanowiony, kod podłączony, zaindeksowany, repozytorium ustawione — oraz język treści organizacji, zanim zaczniesz planować.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Jeden element w całości — opis, status, element nadrzędny lub folder, elementy podrzędne, krawędzie zależności, werdykt gotowości, powiązane z nim błędy i ostatnie odrzucenie odesłane w jego sprawie.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, and the latest refusal sent back on it.',
  },
  get_work_item_activity: {
    summary:
      'Jedna strona dyskusji i śladu zmian elementu: wątki komentarzy i historia, przeplatane.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Zadeklaruj, który element roboczy dostarcza pull request — wywołaj to zaraz po jego otwarciu, raz dla każdego dostarczanego elementu roboczego. Powiązanie jest ZBIOREM, więc drugie wywołanie DODAJE, a nie przenosi, i działa, zanim nadejdzie jakakolwiek dostawa webhooka.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Utwórz krawędź między dwoma elementami — blocked_by to ta, która wyklucza element ze zbioru gotowych.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Względem czego ma być zbudowany element roboczy (`blockersOf`) albo strona zatwierdzonych projektów Projektu. Bez linków — weź je z `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Wszystkie foldery Projektu w jednym odczycie — id każdego folderu i jego ścieżka — aby znaleźć folder po nazwie.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Wszystkie Projekty, do których ma dostęp ten token, każdy z projectKey, którego wymagają wszystkie pozostałe narzędzia.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Jedna ŚCIEŻKA gotowych elementów Projektu, ze stronicowaniem — liście (domyślnie, nigdy Błąd, każdy z nazwą swojego kontenera), kontenery gotowe do uruchomienia albo Błędy — w kolejności, w jakiej pokazuje je widok „Gotowe do pracy”.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'Sprinty Projektu ze stanem, celem, oknem czasowym i liczbą elementów oraz id, których wymagają narzędzia Sprintów.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Odczytaj listę zadań do zrobienia elementu roboczego: jego kroki po kolei, które są wykonane, i postęp.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary: 'Zapisz, że praca nad elementem wylądowała — gałąź, PR i commit, które ją przeniosły.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Przenieś elementy ze Sprintu z powrotem do Backlogu.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Umieść element w nowym miejscu — pod nowym elementem nadrzędnym albo do folderu lub z folderu — z wymuszeniem macierzy rodzaj–element nadrzędny i odmową utworzenia cyklu.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary: 'Dodaj elementy do Sprintu jednym atomowym ruchem, dołączone w podanej kolejności.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary: 'Przenieś jeden krok z listy zadań do zrobienia elementu roboczego na nową pozycję.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'Następny element jednej gotowej ścieżki — liść (domyślnie, nigdy Błąd) albo Błąd jako pełny ładunek dispatch, albo następny kontener gotowy do uruchomienia dla Uruchomienia elementu nadrzędnego. Wywołanie „co robić dalej”.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Otwórz rozmowę planistyczną — po jej id, swoją ostatnią albo nową — i odczytaj jej wątek.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Zarejestruj przesłane nagranie jako pokwitowanie akceptacji Historii — to, co ogląda recenzent i na czym opiera się bramka. Nic innego tego nie publikuje, a brak publikacji wygląda dokładnie jak udane uruchomienie.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Opublikuj stronę jako decyzję elementu decyzyjnego: pieczętuje jej najnowszą wersję i, w elemencie agenta, prosi osobę o jej zatwierdzenie.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Umieść WYNIK projektu na elemencie roboczym z projektem — mocki i notatkę o obszarze jako link, czyli to, co otwiera recenzent — tylko gdy otwarty element roboczy jest blocked_by tym projektem. Bez .png i bez notatki inline: oba są odrzucane, podobnie jak element z projektem w stanie Gotowe, który nie przyjmuje nowych wersji. Każdy zasób przychodzi inline jako base64 albo jako pathname grantu z create_design_upload, gdy jest zbyt duży do wysłania.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Umieść JAK PRZETESTOWAĆ dla URUCHOMIENIA na jego celu uruchomienia — zanim Uruchomienie się skończy, i ponownie, gdy późniejszy commit zmienia krok: sformatowany Markdown z sekcjami i każdym poleceniem w ogrodzonym bloku kodu (kopiowanie jednym kliknięciem), plus commit każdego repozytorium, do którego wypchnięto zmiany.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'Tekst jednego pliku lub bezpośrednie wpisy katalogu z repozytorium ze zbioru Projektu, w danym ref — z limitem i zakresem linii jak odczyt hostowanego planisty, każda nieobecność jako nazwany wynik.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Zapisz, DLACZEGO niezatwierdzony Plan musiał się zmienić — cztery gałęzie, z których dwie zgłaszają błąd planowania; nie zmienia niczego w Planie.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Zapisz, że znaleziona przez ciebie lekcja opisuje coś, co właśnie poszło źle — niezależnie od tego, czy równocześnie ją zmieniasz.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Powiedz, jaki krok zaraz wykonasz na elemencie roboczym, zapisz kamień milowy albo wyślij heartbeat dla swoich otwartych Uruchomień.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Zgłoś krok, na którym jest sesja planisty (settle, lay, author), albo ją zakończ — doradczy sygnał postępu na generowanym Planie.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Runner zapisuje, co zbudował inaczej niż według planu błędnego tylko co do JAK, oraz decyzje podjęte tam, gdzie plan milczał — komentarz do elementu i wpis przebiegu, przyjęte do wiadomości.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Wysłany runner zgłasza element roboczy, na którym się zatrzymał, jako niemożliwy do zbudowania — przyjęte do wiadomości, nie ma nic do zrobienia.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Przeszukaj zapisane lekcje według znaczenia — wspólny korpus i własne lekcje tego Projektu — zawężone według rodzaju, typu, fazy i tematu, zanim zaczniesz planować lub budować.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Przeszukaj elementy Projektu tą samą gramatyką filtrów, którą zapisuje zaawansowany kreator filtrów.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'Czy to już zostało zbudowane? Szukaj po ZNACZENIU, a nie po podciągu — tylko klucze, tytuły i wyniki.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Zaznacz lub odznacz jeden krok z listy zadań do zrobienia elementu roboczego. Zaznaczenie ostatniego kroku nie zmienia statusu elementu roboczego.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'Struktura drzewa całego Projektu w jednym odczycie — klucz, rodzaj, tytuł, status, element nadrzędny, folder i oznaczenie przestarzałości każdego elementu, bez pętli stronicowania.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Rozpocznij zaplanowany Sprint, czyniąc go aktywnym w Projekcie.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Otwórz własne Uruchomienie trzymanego przez ciebie elementu roboczego, podając swój harness i model, aby było widoczne w Uruchomieniach i na elemencie roboczym.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary: 'Wyślij zgromadzoną intencję rozmowy do planisty jako jeden zestaw zmian.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Podtrzymaj swoją kontynuację elementu roboczego. Kontynuacja milcząca przez pięć minut jest zamykana, a jej blokada zwalniana.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Podtrzymaj swoją naprawę elementu roboczego. Naprawa milcząca przez pięć minut jest zamykana, a jej blokada zwalniana.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Przenieś element do innego statusu. Niedozwolone przejście wraca z wymienieniem tych, które są dozwolone.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Przywróć zarchiwizowany element — odwrotność archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Cofnij JEDNO `link_pull_request` — usuń dostawę zapisaną między elementem roboczym a pull requestem. Dostawa to wiersz, więc ponowne powiązanie właściwego elementu roboczego DODAJE, a nie poprawia; to usuwa dokładnie tę jedną wskazaną parę i nie rusza żadnej innej dostawy.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Usuń krawędź, podając tę samą relację, której użyto do jej utworzenia.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Zmień nazwę folderu albo go przenieś i zmień kolejność — jedno albo drugie w jednym wywołaniu, nigdy oba naraz.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Zastąp całą treść strony markdownem w odczytanej przez ciebie rewizji; strona zapisana w międzyczasie jest odrzucana, a nie scalana.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Popraw WŁASNY tytuł i podsumowanie Planu — nagłówek nad drzewem — nie dotykając żadnej propozycji.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Uzupełnij dołączoną przez ciebie propozycję — tura pogłębiania, gdy Plan jest pisany, albo, z `revision: true`, przepisanie w miejscu elementu roboczego w Planie będącym już w przeglądzie.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Popraw propozycję — w tym jej element nadrzędny, jej krawędzie zależności i supersedes, jej oznaczenie przestarzałości i notatkę oraz całą jej oś repozytoriów (repo, wiersz, zbiór lub rola) — nawet gdy Plan jest już w przeglądzie; poprawione oznaczenie jest sprawdzane ponownie, więc ustawienie go na niezakończonym elemencie roboczym jest odrzucane.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Zmień nazwę Sprintu, jego cel albo dostosuj jego planowane okno czasowe.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Edytuj dowolny podzbiór pól elementu, w tym treść wyjaśnienia, której create nie potrafi ustawić.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Edytuj jeden krok z listy zadań do zrobienia elementu roboczego. Zmieniają się tylko wysłane pola; null czyści pole opcjonalne.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      'Czy zatwierdzenie PRZYJMIE ten plan, czy da się go ukończyć, czy każda krawędź leży na jednym poziomie i czy jego krawędzie między elementami nadrzędnymi mają swoje krawędzie nadrzędne? Wszystkie cztery, przed `final: true` — nikt inny o to nie zapyta.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      'Czy ten Sprint da się ukończyć? Wymienia każdy element w Sprincie, który nadal jest wstrzymywany przez pracę spoza niego.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      'Czy ten Epik, Historię, Zadanie lub Błąd da się ukończyć, czy każda krawędź leży na jednym poziomie i czy jego krawędzie między elementami nadrzędnymi mają swoje krawędzie nadrzędne? Wymienia, czego brakuje.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Kim jest właściciel tego tokenu: użytkownik będący właścicielem, aktywny Obszar roboczy i nadane zakresy uprawnień. Wywołaj to jako pierwsze.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary: 'Zdejmij jedną propozycję z Planu, zamiast prosić recenzenta o odrzucenie całości.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
