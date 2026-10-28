import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031 mechanism; filled by the translation cards).
//
// One entry per tool as `name: { summary, source }`. `source` is the English summary the
// translation was made from, pasted from `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`,
// never retyped: it is how the catalogue knows the translation was made from today's English,
// and a tool whose English changed since is served in English until re-translated. Backticked
// tool and argument names stay identical to the source. Group labels are not translated here —
// they come from the app catalogue's `permissions.*`.
export const es: McpSummaryTranslations = {
  add_comment: {
    summary:
      'Publica un comentario en Markdown como propietario del token. Las menciones notifican al Miembro nombrado.',
    source: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
  },
  add_lesson: {
    summary:
      'Registra una lección para este Proyecto, de modo que los planes posteriores la reciban. Solo para este Proyecto.',
    source:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
  },
  add_plan_items: {
    summary:
      'Añade Propuestas a un Plan: ciérralo con un lote final vacío, o añade a uno que ya cerraste con `revision: true`; los ids vuelven en orden, así que el siguiente lote puede colgar hijos de ellos. Un `modify` también puede marcar un elemento de trabajo TERMINADO como desactualizado u obsoleto, con una nota y aristas supersedes (un `add` nombra los elementos de trabajo que reemplaza en `supersedesRefs`), con refs como clave, id o ref `planItem:`; marcar un elemento de trabajo sin terminar se rechaza: quítalo en su lugar.',
    source:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
  },
  add_work_item_todo: {
    summary: 'Añade un paso al final de la lista de tareas pendientes de un elemento de trabajo.',
    source: 'Append one step to the end of a work item’s to-do list.',
  },
  append_plan_turn: {
    summary:
      'Añade un turno a una conversación de planificación, nombrada por su id de sesión: lo que quieres que cambie en el Plan.',
    source:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
  },
  archive_work_item: {
    summary:
      'Retira un elemento sin borrarlo: sale del conjunto de listos y de la búsqueda, y sigue siendo totalmente restaurable.',
    source: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
  },
  attach_file: {
    summary:
      'Pon un archivo EN un elemento de trabajo (un documento de hallazgos de investigación, las notas de una revisión) para que quien lo lea vea el entregable en el elemento de trabajo en lugar de buscar una pull request.',
    source:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
  },
  change_kind: {
    summary:
      'Reclasifica el tipo de una hoja cuando está mal archivada: de Subtarea a Tarea, y al revés.',
    source: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
  },
  claim_next_ready: {
    summary:
      'Reclama de forma atómica la siguiente Subtarea lista del Sprint activo: te la asigna y la pasa a En curso.',
    source:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
  },
  claim_work_item: {
    summary:
      'Reclama de forma atómica UN elemento de trabajo con nombre y lo pasa a En curso. Una reclamación perdida indica QUIÉN lo tiene.',
    source:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
  },
  claim_work_item_continue: {
    summary:
      'Retoma un elemento de trabajo cuya última Ejecución murió o se detuvo en un control que ahora está aprobado, como hace `motir continue`: su rama y sus pull requests, no un comienzo desde cero.',
    source:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
  },
  claim_work_item_repair: {
    summary:
      'Toma el bloqueo de reparación de un elemento de trabajo con pull requests fallidas, como hace `motir fix`. Un solo reparador a la vez.',
    source:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
  },
  close_work_item_continue: {
    summary:
      'Termina tu continuación de un elemento de trabajo indicando cómo fue, para que la página lo muestre y el elemento pueda continuarse de nuevo.',
    source:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
  },
  close_work_item_repair: {
    summary:
      'Termina tu reparación de un elemento de trabajo indicando cómo fue, para que la página lo muestre y pueda empezar una nueva reparación.',
    source:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
  },
  close_work_item_run: {
    summary:
      'Termina tu Ejecución de un elemento de trabajo indicando cómo fue; un cierre con entrega te registra como implementador.',
    source:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
  },
  code_explore: {
    summary:
      'El grafo de código alojado en torno a una consulta: la respuesta propia del planificador alojado, paginada, con cada ausencia como un estado con nombre.',
    source:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
  },
  code_search: {
    summary:
      'Símbolos que coinciden con un nombre en el grafo de código alojado: la respuesta propia del planificador alojado, paginada.',
    source:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
  },
  complete_session: {
    summary:
      'Cierra una rama de sesión después de que su PR se haya fusionado: todos los elementos registrados en ella pasan a Hecho.',
    source:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
  },
  complete_sprint: { summary: 'Completa el Sprint activo.', source: 'Complete the active sprint.' },
  create_acceptance_upload: {
    summary:
      'Genera un PUT prefirmado de corta duración para la grabación de aceptación de una Historia: paso 1 de 2, porque un video es mucho más grande de lo que cabe en un argumento de herramienta. Sube los bytes directamente al almacén y luego registra el pathname.',
    source:
      'Mint a short-lived presigned PUT for a story’s acceptance recording — step 1 of 2, because a video is far larger than a tool argument can carry. Upload the bytes straight to the store, then register the pathname.',
  },
  create_design_upload: {
    summary:
      'Genera un PUT prefirmado de corta duración para un recurso de diseño demasiado grande para enviarlo en línea: paso 1 de 2, porque un recurso grande no cabe en un argumento de herramienta. Sube los bytes directamente al almacén y luego publica el pathname. Rechaza una captura de pantalla, un elemento de trabajo de diseño que nada espera y un elemento de trabajo de diseño ya Hecho.',
    source:
      'Mint a short-lived presigned PUT for a design asset too large to send inline — step 1 of 2, because a large asset is more than a tool argument can carry. Upload the bytes straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
  },
  create_folder: {
    summary:
      'Crea una Carpeta en la raíz o dentro de otra Carpeta; los nombres son únicos por nivel.',
    source: 'Create a folder at the root or inside another folder; names are unique per level.',
  },
  create_page: {
    summary:
      'Crea una página con un cuerpo en markdown (en la raíz, en una Carpeta o como subpágina) y obtén su id y su revisión.',
    source:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
  },
  create_plan: {
    summary:
      'Abre un Plan en el que proponer: el contenedor revisable que un Agente rellena en lugar de escribir elementos.',
    source:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
  },
  create_sprint: {
    summary:
      'Crea un Sprint planificado en un Proyecto, con nombre, objetivo y ventana planificada opcionales.',
    source: 'Create a planned sprint on a project, with an optional name, goal and planned window.',
  },
  create_work_item: {
    summary:
      'Crea una Épica, Historia, Tarea, Error o Subtarea bajo un padre o en una Carpeta; puntos, Estimación, tipo, ejecutor, dificultad, repositorio, marca de obsolescencia e idioma del contenido en una sola llamada.',
    source:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
  },
  delete_comment: {
    summary:
      'Elimina de forma permanente un comentario que escribiste, con sus respuestas. Aquí solo puede eliminarlo su autor.',
    source:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
  },
  delete_folder: {
    summary:
      'Elimina una Carpeta; sus Carpetas y elementos de trabajo suben un nivel, y el resultado enumera lo que se movió.',
    source: 'Delete a folder; its folders and work items move up, and the result lists what moved.',
  },
  delete_sprint: {
    summary: 'Elimina un Sprint planificado o completado.',
    source: 'Delete a planned or complete sprint.',
  },
  delete_work_item: {
    summary:
      'Elimina de forma permanente un elemento y todo su subárbol. Irreversible y desactivado por defecto.',
    source: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
  },
  delete_work_item_todo: {
    summary:
      'Elimina de forma permanente un paso de la lista de tareas pendientes de un elemento de trabajo.',
    source: 'Permanently delete one step of a work item’s to-do list.',
  },
  dispatch_prompt: {
    summary:
      'El prompt de agente de programación generado por el servidor para un elemento: el mismo texto que la CLI entrega a un Agente.',
    source:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
  },
  edit_comment: {
    summary:
      'Reemplaza el cuerpo de un comentario que escribiste. Aquí solo puede editarlo su autor.',
    source: 'Replace the body of a comment you wrote. Only its author can edit it here.',
  },
  expand_item: {
    summary:
      'Envía una expansión de IA de un elemento contenedor. Gasta los créditos del propietario; las Propuestas esperan aprobación.',
    source:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
  },
  get_approval_gate: {
    summary:
      'La decisión que una persona tomó en un control de aprobación: la nota que escribió al devolver tu trabajo, quién la escribió, cuándo y sobre qué versión.',
    source:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
  },
  get_approved_shape_verdict: {
    summary:
      '¿Sigue este elemento de trabajo siendo lo que aprobó su último Plan aprobado? Su historial de Plan y el veredicto.',
    source:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
  },
  get_code_health: {
    summary:
      'El estado de índice de cada repositorio, el resumen de la última auditoría de salud del código y la convención de código derivada: lo que lee el planificador alojado.',
    source:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
  },
  get_coding_convention: {
    summary:
      'La convención de código de un repositorio completa, derivada o editada por una persona, con su versión: lo que sigue un cambio en ese repositorio.',
    source:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
  },
  get_design: {
    summary:
      'El diseño APROBADO de un elemento de trabajo de diseño, con enlaces de corta duración a sus archivos, o cuál de las cinco razones explica que no haya ninguno.',
    source:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
  },
  get_page: {
    summary:
      'Lee una página como markdown (su título, dónde está archivada, su revisión y su versión más reciente) para leerla o para volver a escribirla; o lee una versión por número.',
    source:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
  },
  get_plan: {
    summary:
      'Un Plan con las Propuestas que agrupa: lo que el planificador propuso en realidad, no solo cuántas, incluida una marca de obsolescencia propuesta (actual → propuesta, con su nota) y sus aristas supersedes, nombradas por clave.',
    source:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note) and its supersedes edges, named by key.',
  },
  get_plan_status: {
    summary:
      'Qué ha sido de un trabajo de planificación enviado: su estado y cuántas Propuestas generó.',
    source:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
  },
  get_project_state: {
    summary:
      'Las condiciones previas de planificación de un Proyecto (establecido, código conectado, indexado, repositorio definido) y el idioma de contenido de su organización, antes de que planifiques.',
    source:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
  },
  get_work_item: {
    summary:
      'Un elemento completo: descripción, estado, padre o Carpeta, hijos, aristas de dependencia, un veredicto de disponibilidad, los Errores vinculados a él y la última denegación que se le devolvió.',
    source:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, and the latest refusal sent back on it.',
  },
  get_work_item_activity: {
    summary:
      'Una página de la conversación y del historial de cambios de un elemento: hilos de comentarios e historial, intercalados.',
    source:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
  },
  link_pull_request: {
    summary:
      'Declara qué elemento de trabajo entrega una pull request: llámala justo después de abrir una, una vez por cada elemento de trabajo que entregue. La asociación es un CONJUNTO, así que una segunda llamada AÑADE en lugar de mover, y funciona antes de que llegue ninguna entrega de webhook.',
    source:
      'Declare which work item a pull request delivers — call it right after opening one, once per work item it delivers. The association is a SET, so a second call ADDS rather than moving, and it works before any webhook delivery has arrived.',
  },
  link_work_items: {
    summary:
      'Crea una arista entre dos elementos: blocked_by es la que mantiene un elemento fuera del conjunto de listos.',
    source:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
  },
  list_designs: {
    summary:
      'Contra qué debe construirse un elemento de trabajo (`blockersOf`), o una página de los diseños aprobados del Proyecto. Sin enlaces: tómalos de `get_design`.',
    source:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
  },
  list_folders: {
    summary:
      'Todas las Carpetas de un Proyecto en una sola lectura, con el id y la ruta de cada una, para encontrar una Carpeta por nombre.',
    source:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
  },
  list_projects: {
    summary:
      'Todos los Proyectos a los que puede acceder este token, cada uno con la projectKey que toman todas las demás herramientas.',
    source: 'Every project this token can reach, each with the projectKey every other tool takes.',
  },
  list_ready: {
    summary:
      'Un CARRIL listo de un Proyecto, paginado (hojas, por defecto y nunca un Error, cada una con su contenedor; contenedores ejecutables; o Errores), en el orden en que lo muestra la vista Listos.',
    source:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
  },
  list_sprints: {
    summary:
      'Los Sprints de un Proyecto con su estado, objetivo, ventana y número de elementos, y los ids que toman las herramientas de Sprint.',
    source:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
  },
  list_work_item_todos: {
    summary:
      'Lee la lista de tareas pendientes de un elemento de trabajo: sus pasos en orden, cuáles están hechos y el progreso.',
    source: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
  },
  mark_integrated: {
    summary:
      'Registra que el trabajo de un elemento se integró: la rama, la PR y el commit que lo llevó.',
    source:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
  },
  move_to_backlog: {
    summary: 'Saca elementos de su Sprint y devuélvelos al Backlog.',
    source: 'Move items out of their sprint and back to the backlog.',
  },
  move_to_parent: {
    summary:
      'Recoloca un elemento (bajo un nuevo padre, o dentro o fuera de una Carpeta), aplicando la matriz de tipo y padre y rechazando un ciclo.',
    source:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
  },
  move_to_sprint: {
    summary:
      'Añade elementos a un Sprint en un único movimiento atómico, agregados en el orden dado.',
    source: 'Add items to a sprint in one atomic move, appended in the order given.',
  },
  move_work_item_todo: {
    summary:
      'Mueve un paso de la lista de tareas pendientes de un elemento de trabajo a una nueva posición.',
    source: 'Move one step of a work item’s to-do list to a new position.',
  },
  next_ready: {
    summary:
      'El siguiente elemento de un carril listo (una hoja, por defecto y nunca un Error, o un Error) como payload de despacho completo, o el siguiente contenedor ejecutable para una Ejecución de padre. La llamada de “qué hago ahora”.',
    source:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
  },
  open_plan_session: {
    summary:
      'Abre una conversación de planificación (por su id, tu más reciente o una nueva) y lee su hilo.',
    source:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
  },
  publish_acceptance_result: {
    summary:
      'Registra la grabación subida como el comprobante de aceptación de la Historia: lo que mira un revisor y en lo que se apoya el control. Nada más lo publica, y una publicación que falta se ve exactamente igual que una Ejecución correcta.',
    source:
      'Register the uploaded recording as the story’s acceptance receipt — the thing a reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish looks exactly like a successful run.',
  },
  publish_decision_page: {
    summary:
      'Publica una página como la decisión de un elemento de trabajo de decisión: sella su versión más reciente y, en un elemento de trabajo de Agente, pide a una persona que la apruebe.',
    source:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
  },
  publish_design_result: {
    summary:
      'Pon el RESULTADO de diseño en un elemento de trabajo de diseño (las maquetas y la nota del área como enlace, lo que abre un revisor), solo cuando un elemento de trabajo abierto está blocked_by del diseño. Sin .png y sin nota en línea: ambos se rechazan, y también un elemento de trabajo de diseño Hecho, que no acepta versiones nuevas. Cada recurso llega en línea como base64, o como el pathname de una concesión de create_design_upload cuando es demasiado grande para enviarlo.',
    source:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
  },
  publish_test_instructions: {
    summary:
      'Pon el CÓMO PROBAR de una EJECUCIÓN en su destino de Ejecución, antes de que la Ejecución termine y de nuevo cuando un commit posterior cambie un paso: Markdown de texto enriquecido con secciones y cada comando en un bloque de código delimitado (clic para copiar), más el commit de cada repositorio al que envió cambios.',
    source:
      'Put a RUN’s HOW TO TEST onto its run target — before the run finishes, and again when a later commit changes a step: rich-text Markdown with sections and every command in a fenced code block (click-to-copy), plus the commit of each repository it pushed to.',
  },
  read_file: {
    summary:
      'El texto de un archivo, o las entradas inmediatas de un directorio, de un repositorio del conjunto del Proyecto, en una ref: con límite y por rangos de líneas como la lectura del planificador alojado, con cada ausencia como un resultado con nombre.',
    source:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
  },
  record_plan_revision_reason: {
    summary:
      'Registra POR QUÉ un Plan sin aprobar tuvo que cambiar: cuatro ramas, dos de las cuales abren un Error de planificación; no cambia nada del Plan.',
    source:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
  },
  reinforce_lesson: {
    summary:
      'Registra que una lección que encontraste describe algo que acaba de salir mal, hayas cambiado algo o no.',
    source:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
  },
  report_action: {
    summary:
      'Indica el paso que vas a dar en un elemento de trabajo, registra un hito o envía un latido de tus Ejecuciones abiertas.',
    source:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
  },
  report_plan_step: {
    summary:
      'Informa del paso en el que está una sesión del planificador (settle, lay, author) o termínala: una señal de progreso orientativa en un Plan que se está generando.',
    source:
      'Report the step a planner session is on (settle, lay, author) or end it — an advisory progress signal on a generating plan.',
  },
  record_run_discrepancy: {
    summary:
      'Un runner registra lo que construyó de otra forma que un plan equivocado solo en el CÓMO, y las decisiones que tomó donde el plan no decía nada: un comentario en el elemento y un registro de la ejecución, con acuse de recibo.',
    source:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
  },
  report_unbuildable_target: {
    summary:
      'Un runner despachado informa del elemento de trabajo en el que se detuvo como imposible de construir: se acusa recibo y no hay nada que hacer.',
    source:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
  },
  search_lessons: {
    summary:
      'Busca por significado las lecciones registradas (el corpus compartido y las propias de este Proyecto), filtradas por tipo, clase, fase y tema, antes de planificar o construir.',
    source:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
  },
  search_work_items: {
    summary:
      'Busca los elementos de un Proyecto con la misma gramática de filtros que escribe el constructor de filtros avanzados.',
    source:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
  },
  search_work_items_semantic: {
    summary:
      '¿Ya se ha construido esto? Busca por SIGNIFICADO en lugar de por subcadena: solo claves, títulos y puntuaciones.',
    source:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
  },
  set_work_item_todo_done: {
    summary:
      'Marca o desmarca un paso de la lista de tareas pendientes de un elemento de trabajo. Marcar el último paso no cambia el estado del elemento de trabajo.',
    source:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
  },
  skeleton: {
    summary:
      'La estructura de árbol de todo el Proyecto en una sola lectura (clave, tipo, título, estado, padre, Carpeta y marca de obsolescencia de cada elemento), sin bucle de paginación.',
    source:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
  },
  start_sprint: {
    summary: 'Inicia un Sprint planificado y lo convierte en el activo del Proyecto.',
    source: "Start a planned sprint, making it the project's active one.",
  },
  start_work_item_run: {
    summary:
      'Abre tu propia Ejecución de un elemento de trabajo que tienes reservado, indicando tu harness y tu modelo, para que aparezca en Ejecuciones y en el elemento de trabajo.',
    source:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
  },
  submit_plan_session: {
    summary:
      'Envía al planificador la intención acumulada de la conversación como un único conjunto de cambios.',
    source: "Send the conversation's accumulated intent to the planner as one change set.",
  },
  touch_work_item_continue: {
    summary:
      'Mantén viva tu continuación de un elemento de trabajo. Una continuación en silencio durante cinco minutos se cierra y su bloqueo se libera.',
    source:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
  },
  touch_work_item_repair: {
    summary:
      'Mantén viva tu reparación de un elemento de trabajo. Una reparación en silencio durante cinco minutos se cierra y su bloqueo se libera.',
    source:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
  },
  transition_status: {
    summary:
      'Mueve un elemento a otro estado. Un movimiento ilegal vuelve indicando cuáles son legales.',
    source:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
  },
  unarchive_work_item: {
    summary: 'Restaura un elemento archivado: la inversa de archive.',
    source: 'Restore an archived item — the inverse of archive.',
  },
  unlink_pull_request: {
    summary:
      'Deshace UN `link_pull_request`: elimina la entrega registrada entre un elemento de trabajo y una pull request. Una entrega es una fila, así que volver a vincular el elemento de trabajo correcto AÑADE en lugar de corregir; esto elimina exactamente el par que nombras y deja intacta cualquier otra entrega.',
    source:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a pull request. A delivery is a row, so re-linking the right work item ADDS rather than corrects; this removes exactly the one pair you name and leaves every other delivery alone.',
  },
  unlink_work_items: {
    summary: 'Elimina una arista, dada la misma relación usada para crearla.',
    source: 'Remove an edge, given the same relationship used to create it.',
  },
  update_folder: {
    summary:
      'Renombra una Carpeta, o muévela y reordénala: una cosa o la otra por llamada, nunca ambas.',
    source: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
  },
  update_page: {
    summary:
      'Reemplaza todo el cuerpo de una página con markdown en la revisión que leíste; una página guardada desde entonces se rechaza, no se fusiona.',
    source:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
  },
  update_plan: {
    summary:
      'Corrige el PROPIO título y resumen de un Plan (el encabezado sobre el árbol) sin tocar ni una sola Propuesta.',
    source:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal.",
  },
  update_plan_item: {
    summary:
      'Rellena una Propuesta que añadiste: el turno de profundización mientras se escribe el Plan o, con `revision: true`, una reescritura de un elemento de trabajo en un Plan que ya está en revisión, en el mismo lugar.',
    source:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
  },
  update_plan_proposal: {
    summary:
      'Corrige una Propuesta, incluidos su padre, sus aristas de dependencia y supersedes, su marca de obsolescencia y su nota, y todo su eje de repositorio (un repo, una fila, un conjunto o un rol), incluso después de que el Plan esté en revisión; una marca corregida se vuelve a comprobar, así que establecer una en un elemento de trabajo sin terminar se rechaza.',
    source:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
  },
  update_sprint: {
    summary: 'Renombra un Sprint, cambia su objetivo o ajusta su ventana planificada.',
    source: 'Rename a sprint, change its goal, or adjust its planned window.',
  },
  update_work_item: {
    summary:
      'Edita cualquier subconjunto de los campos de un elemento, incluido el cuerpo de explicación que create no puede establecer.',
    source:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
  },
  update_work_item_todo: {
    summary:
      'Edita un paso de la lista de tareas pendientes de un elemento de trabajo. Solo cambian los campos que envías; null vacía uno opcional.',
    source:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
  },
  validate_plan: {
    summary:
      '¿ACEPTARÍA la aprobación este Plan, se puede terminar, cada arista está en un solo nivel y sus aristas entre padres distintos tienen sus aristas de padre? Las cuatro comprobaciones, antes de `final: true`: nadie más lo preguntará.',
    source:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
  },
  validate_sprint: {
    summary:
      '¿Se puede terminar este Sprint? Nombra todos los elementos del Sprint que aún dependen de trabajo ajeno a él.',
    source: 'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
  },
  validate_work_item: {
    summary:
      '¿Se puede terminar esta Épica, Historia, Tarea o Error, cada arista está en un solo nivel y sus aristas entre padres distintos tienen sus aristas de padre? Nombra lo que falta.',
    source:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
  },
  whoami: {
    summary:
      'Quién es este token: el usuario propietario, el Espacio de trabajo activo y los permisos concedidos. Llámala primero.',
    source:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
  },
  withdraw_plan_proposal: {
    summary: 'Retira una Propuesta de un Plan, en lugar de pedir a un revisor que rechace todo.',
    source:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
  },
};
