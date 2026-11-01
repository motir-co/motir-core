import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const fr: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Publier un commentaire Markdown au nom du propriétaire du jeton. Les mentions notifient le Membre nommé.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Enregistrer une leçon pour ce Projet, afin que les prochains Plans le concernant la reçoivent. Ce Projet uniquement.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      "Ajouter des Propositions à un Plan — le clore avec un lot final vide, ou en ajouter à un Plan déjà clos avec `revision: true` ; les ids reviennent dans l'ordre, afin que le lot suivant puisse y rattacher des enfants. Un `modify` peut aussi marquer un élément de travail TERMINÉ comme obsolète ou déprécié, avec une note et des liens supersedes (un `add` nomme les éléments qu'il remplace dans `supersedesRefs`), les refs étant une clé, un id ou une ref `planItem:` ; marquer un élément de travail non terminé est refusé — supprimez-le plutôt.",
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: "Ajouter une étape à la fin de la liste de tâches d'un élément de travail.",
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Ajouter un tour à une conversation de planification, désignée par son session id — ce que vous voulez changer dans le Plan.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      "Retirer en douceur un élément : il quitte l'ensemble prêt et la recherche, et reste entièrement restaurable.",
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      "Mettre un fichier SUR un élément de travail — un document de résultats de recherche, les notes d'une revue — afin qu'un lecteur voie le livrable sur l'élément de travail au lieu de chercher une pull request.",
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      "Reclasser le type d'une feuille lorsqu'il est mal renseigné — de Sous-tâche à Tâche, et inversement.",
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      "Réserver atomiquement la prochaine Sous-tâche prête du Sprint actif : vous l'assigner et la passer à En cours.",
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Réserver atomiquement UN élément de travail nommé et le passer à En cours. Une réservation perdue indique QUI le détient.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      "Reprendre un élément de travail dont la dernière Exécution est morte ou s'est arrêtée à une porte désormais approuvée, comme le fait `motir continue` : sa branche et ses pull requests, pas un nouveau départ.",
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      "Prendre le verrou de réparation d'un élément de travail dont des pull requests échouent, comme le fait `motir fix`. Un seul correcteur à la fois.",
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      "Terminer votre reprise d'un élément de travail en indiquant comment elle s'est passée, afin que la page l'affiche et que l'élément puisse être repris à nouveau.",
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      "Terminer votre réparation d'un élément de travail en indiquant comment elle s'est passée, afin que la page l'affiche et qu'une nouvelle réparation puisse démarrer.",
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      "Terminer votre Exécution d'un élément de travail en indiquant comment elle s'est passée ; une clôture livrée vous enregistre comme l'implémenteur.",
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      "Le graphe de code hébergé autour d'une requête — la propre réponse du planificateur hébergé, paginée, chaque absence étant un état nommé.",
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Les symboles correspondant à un nom dans le graphe de code hébergé — la propre réponse du planificateur hébergé, paginée.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  code_grep: {
    summary:
      'Les lignes correspondant à un texte ou à un motif dans le contenu indexé des fichiers — littéraux de chaîne, commentaires et fichiers qui ne sont pas du code, que la recherche de symboles ne voit pas — la propre réponse du planificateur hébergé, paginée.',
    source:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Clore une branche de session après la fusion de sa pull request : chaque élément enregistré dessus passe à Terminé.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Terminer le Sprint actif.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      "Émettre un PUT présigné de courte durée pour l'enregistrement de recette d'une Story — étape 1 sur 2, car une vidéo est bien plus volumineuse que ce qu'un argument d'outil peut porter. Envoyez les octets directement au stockage, puis enregistrez le pathname.",
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      "Émettre un PUT présigné de courte durée pour un asset de design trop volumineux pour être envoyé en ligne — étape 1 sur 2, car un gros asset dépasse ce qu'un argument d'outil peut porter. Envoyez les octets directement au stockage, puis publiez le pathname. Refuse une capture d'écran, un élément de travail que rien n'attend et un élément de travail de design Terminé.",
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary:
      'Créer un Dossier à la racine ou dans un autre Dossier ; les noms sont uniques à chaque niveau.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Créer une page avec un corps en markdown — à la racine, dans un Dossier ou comme sous-page — et obtenir son id et sa révision.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      "Ouvrir un Plan dans lequel proposer — le conteneur révisable qu'un Agent remplit au lieu d'écrire des éléments.",
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Créer un Sprint planifié sur un Projet, avec un nom, un objectif et une fenêtre planifiée facultatifs.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      "Créer un Epic, une Story, une Tâche, un Bug ou une Sous-tâche sous un parent ou dans un Dossier ; points, Estimation, type, executor, difficulté, dépôt, marque d'obsolescence et langue du contenu en un seul appel.",
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Supprimer définitivement un commentaire que vous avez écrit, avec ses réponses. Seul son auteur peut le supprimer ici.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      "Supprimer un Dossier ; ses Dossiers et éléments de travail remontent d'un niveau, et le résultat liste ce qui a bougé.",
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Supprimer un Sprint planifié ou terminé.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Supprimer définitivement un élément et tout son sous-arbre. Irréversible, et désactivé par défaut.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary: "Supprimer définitivement une étape de la liste de tâches d'un élément de travail.",
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      "Le prompt d'agent de code généré par le serveur pour un élément — le même texte que la CLI remet à un agent.",
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      "Remplacer le corps d'un commentaire que vous avez écrit. Seul son auteur peut le modifier ici.",
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      "Soumettre une expansion par IA d'un élément conteneur. Dépense les crédits du propriétaire ; les Propositions attendent leur approbation.",
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      "La décision qu'une personne a prise sur une porte d'approbation — la note rédigée lorsqu'elle a renvoyé votre travail, son auteur, la date et la version concernée.",
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      'Cet élément de travail est-il toujours ce que son dernier Plan approuvé a approuvé ? Son historique de Plan et le verdict.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      "L'état d'index de chaque dépôt, le résumé du dernier audit de santé du code et la convention de code dérivée — ce que lit le planificateur hébergé.",
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      "La convention de code d'un dépôt en entier, dérivée ou modifiée par une personne, avec sa version – ce que suit une modification dans ce dépôt.",
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      "Le design APPROUVÉ d'un élément de travail de design, avec des liens de courte durée vers ses fichiers — ou lequel des cinq motifs explique qu'il n'y en ait pas.",
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Lire une page en markdown — son titre, son emplacement, sa révision et sa version la plus récente — pour la lire ou la réécrire ; ou lire une version par son numéro.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      "Un Plan avec les Propositions qu'il regroupe : ce que le planificateur a réellement proposé, et pas seulement combien — y compris une marque d'obsolescence proposée (actuelle → proposée, avec sa note) et ses liens supersedes, désignés par clé.",
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      "Ce qu'est devenue une tâche de planification soumise — son état et le nombre de Propositions qu'elle a produites.",
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      "Les prérequis de planification d'un Projet — établi, code connecté, indexé, dépôt défini — et la langue de contenu de son organisation, avant de planifier.",
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      "Un élément en détail — description, statut, parent ou Dossier, enfants, liens de dépendance, un verdict de disponibilité, les erreurs qui lui sont liées, le dernier refus renvoyé à son sujet et l'emplacement de son code pas encore fusionné.",
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
  },
  get_work_item_activity: {
    summary:
      "Une page de la discussion et de l'historique des modifications d'un élément : fils de commentaires et historique, entrelacés.",
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      "Déclarer quel élément de travail une pull request livre — à appeler juste après en avoir ouvert une, une fois par élément de travail livré. L'association est un ENSEMBLE : un second appel AJOUTE au lieu de déplacer, et elle fonctionne avant l'arrivée de toute livraison de webhook.",
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      "Créer un lien entre deux éléments — blocked_by est celui qui retient un élément hors de l'ensemble prêt.",
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Ce sur quoi un élément de travail doit être construit (`blockersOf`), ou une page des designs approuvés du Projet. Aucun lien — prenez-les avec `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      "Tous les Dossiers d'un Projet en une seule lecture — l'id et le chemin de chaque Dossier — pour retrouver un Dossier par son nom.",
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Tous les Projets que ce jeton peut atteindre, chacun avec le projectKey que prennent tous les autres outils.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      "Une VOIE prête d'un Projet, paginée — feuilles (par défaut, jamais un Bug, chacune nommant son conteneur), conteneurs exécutables ou Bugs — dans l'ordre où la vue Prêt les affiche.",
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      "Les Sprints d'un Projet avec leur état, leur objectif, leur fenêtre et le nombre d'éléments, ainsi que les ids que prennent les outils de Sprint.",
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      "Lire la liste de tâches d'un élément de travail : ses étapes dans l'ordre, lesquelles sont terminées, et l'avancement.",
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      "Enregistrer que le travail d'un élément a été intégré — la branche, la pull request et le commit qui l'ont porté.",
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Sortir des éléments de leur Sprint et les remettre dans le Backlog.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      "Replacer un élément — sous un nouveau parent, ou dans ou hors d'un Dossier — en appliquant la matrice type-parent et en refusant un cycle.",
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      "Ajouter des éléments à un Sprint en un seul déplacement atomique, ajoutés dans l'ordre indiqué.",
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary:
      "Déplacer une étape de la liste de tâches d'un élément de travail vers une nouvelle position.",
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      "Le prochain élément d'une voie prête — une feuille (par défaut, jamais un Bug) ou un Bug sous forme de charge utile de dispatch complète, ou le prochain conteneur exécutable pour une Exécution parente. L'appel « que dois-je faire ensuite ».",
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Ouvrir une conversation de planification — par son id, votre plus récente ou une nouvelle — et lire son fil.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      "Enregistrer l'enregistrement envoyé comme reçu de recette de la Story — ce qu'un relecteur regarde et sur quoi repose la porte. Rien d'autre ne le publie, et une publication manquante ressemble exactement à une exécution réussie.",
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      "Publier une page comme décision d'un élément de travail de décision : scelle sa version la plus récente et, sur un élément d'Agent, demande à une personne de l'approuver.",
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      "Mettre le RÉSULTAT de design sur un élément de travail de design — la ou les maquettes et la note de zone sous forme de lien, ce qu'un relecteur ouvre — uniquement lorsqu'un élément de travail ouvert est blocked_by le design. Pas de .png ni de note en ligne : les deux sont refusés, tout comme un élément de travail de design Terminé, qui n'accepte aucune nouvelle version. Chaque asset arrive en ligne en base64, ou sous forme de pathname d'une autorisation create_design_upload lorsqu'il est trop volumineux pour être envoyé.",
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      "Mettre le COMMENT TESTER d'une EXÉCUTION sur sa cible d'Exécution — avant la fin de l'Exécution, et de nouveau lorsqu'un commit ultérieur change une étape : du Markdown riche avec des sections et chaque commande dans un bloc de code délimité (copie en un clic), plus le commit de chaque dépôt vers lequel elle a poussé.",
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      "Le texte d'un fichier, ou les entrées immédiates d'un répertoire, d'un dépôt de l'ensemble du Projet, à une ref — plafonné et limité en lignes comme la lecture du planificateur hébergé, chaque absence étant un résultat nommé.",
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  list_changed_files: {
    summary:
      "Les chemins qu'une branche a modifiés dans un dépôt de l'ensemble du Projet, par rapport à sa branche par défaut ou à une base nommée — plafonné comme la liste du planificateur hébergé, chaque absence étant un résultat nommé.",
    source:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Enregistrer POURQUOI un Plan non approuvé a dû changer — quatre branches, dont deux déposent un bug de planification ; cela ne change rien au Plan.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      "Enregistrer qu'une leçon que vous avez trouvée décrit quelque chose qui vient de mal tourner — que vous la modifiiez ou non.",
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      "Annoncer l'étape que vous allez franchir sur un élément de travail, enregistrer un jalon, ou envoyer un signal de présence pour vos Exécutions ouvertes.",
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      "Signaler l'étape où en est une session de planification (settle, lay, author) ou y mettre fin — un signal d'avancement indicatif sur un Plan en cours de génération.",
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Un exécuteur consigne ce qu’il a construit autrement qu’un plan erroné seulement sur le COMMENT, et les décisions qu’il a prises là où le plan ne disait rien — un commentaire sur l’élément et une trace de l’exécution, avec accusé de réception.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      "Un exécuteur dispatché signale l'élément de travail sur lequel il s'est arrêté comme infaisable — accusé de réception, rien à faire.",
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Rechercher les leçons enregistrées par sens — le corpus partagé et celui de ce Projet — filtrées par type, genre, phase et sujet, avant de planifier ou de construire.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      "Rechercher les éléments d'un Projet avec la même grammaire de filtres que celle qu'écrit le générateur de filtres avancés.",
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      'Cela a-t-il déjà été construit ? Rechercher par SENS plutôt que par sous-chaîne — uniquement des clés, des titres et des scores.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      "Cocher ou décocher une étape de la liste de tâches d'un élément de travail. Cocher la dernière étape ne modifie pas le statut de l'élément de travail.",
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      "L'arborescence complète du Projet en une seule lecture — clé, type, titre, statut, parent, Dossier et marque d'obsolescence de chaque élément, sans boucle de pagination.",
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Démarrer un Sprint planifié, en en faisant le Sprint actif du Projet.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      "Ouvrir votre propre Exécution d'un élément de travail que vous détenez, en indiquant votre harness et votre modèle, afin qu'elle apparaisse dans les Exécutions et sur l'élément de travail.",
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary:
      "Envoyer l'intention accumulée de la conversation au planificateur sous la forme d'un seul ensemble de modifications.",
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      "Maintenir en vie votre reprise d'un élément de travail. Une reprise silencieuse pendant cinq minutes est close et son verrou libéré.",
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      "Maintenir en vie votre réparation d'un élément de travail. Une réparation silencieuse pendant cinq minutes est close et son verrou libéré.",
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Faire passer un élément à un autre statut. Un passage illégal revient en nommant ceux qui sont légaux.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: "Restaurer un élément archivé — l'inverse de archive.",
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Annuler UN SEUL `link_pull_request` — supprimer la livraison enregistrée entre un élément de travail et une pull request. Une livraison est une ligne : relier le bon élément de travail AJOUTE au lieu de corriger ; ceci supprime exactement la paire que vous nommez et laisse toute autre livraison intacte.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Supprimer un lien, à partir de la même relation que celle utilisée pour le créer.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      "Renommer un Dossier, ou le déplacer et le réordonner — l'un ou l'autre par appel, jamais les deux.",
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      "Remplacer tout le corps d'une page par du markdown à la révision que vous avez lue ; une page enregistrée depuis est refusée, pas fusionnée.",
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      "Corriger le titre et le résumé PROPRES d'un Plan — l'en-tête au-dessus de l'arbre — sans toucher à une seule Proposition.",
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      "Remplir une Proposition que vous avez ajoutée — le tour d'approfondissement pendant l'écriture du Plan, ou, avec `revision: true`, une réécriture sur place d'un élément de travail d'un Plan déjà en revue.",
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      "Corriger une Proposition — y compris son parent, ses liens de dépendance et supersedes, sa marque d'obsolescence et sa note, et tout son axe de dépôt (un dépôt, une ligne, un ensemble ou un rôle) — même une fois le Plan en revue ; une marque corrigée est revérifiée, donc en poser une sur un élément de travail non terminé est refusé.",
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Renommer un Sprint, changer son objectif ou ajuster sa fenêtre planifiée.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      "Modifier n'importe quel sous-ensemble des champs d'un élément, y compris le corps d'explication que la création ne peut pas définir.",
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      "Modifier une étape de la liste de tâches d'un élément de travail. Seuls les champs que vous envoyez changent ; null efface un champ facultatif.",
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      "Approuver PRENDRAIT-il ce Plan, est-il réalisable jusqu'au bout, chaque lien est-il sur un seul niveau, et les liens entre parents différents ont-ils leurs liens de parenté ? Les quatre, avant `final: true` — personne d'autre ne le demandera.",
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      "Ce Sprint est-il réalisable jusqu'au bout ? Nomme chaque élément du Sprint encore bloqué par du travail extérieur à celui-ci.",
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      "Cet Epic, cette Story, cette Tâche ou ce Bug est-il réalisable jusqu'au bout, chaque lien est-il sur un seul niveau, et les liens entre parents différents ont-ils leurs liens de parenté ? Nomme ce qui manque.",
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      "Qui est ce jeton : l'utilisateur propriétaire, l'Espace de travail actif et les portées accordées. À appeler en premier.",
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary:
      "Retirer une Proposition d'un Plan, au lieu de demander à un relecteur de décliner l'ensemble.",
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
