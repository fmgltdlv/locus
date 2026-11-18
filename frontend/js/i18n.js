// Lightweight app localization. This first pass localizes map-facing UI chrome and common dynamic labels.
(function () {
    const SUPPORTED_LANGUAGES = ['en', 'es'];
    const STORAGE_KEY = 'preferredLanguage';

    const es = {
        'Locus': 'Locus',
        'About Locus': 'Acerca de Locus',
        'Locus Map View': 'Vista de mapa de Locus',
        'Notice': 'Aviso',
        'Close': 'Cerrar',
        'Cancel': 'Cancelar',
        'Save': 'Guardar',
        'Save Changes': 'Guardar cambios',
        'Loading...': 'Cargando...',
        'Loading…': 'Cargando...',
        'Menu': 'Menú',
        'Profile': 'Perfil',
        'Settings': 'Configuración',
        'About': 'Acerca de',
        'User Guide': 'Guía del usuario',
        'Close about': 'Cerrar acerca de',
        'Locus is a shared workspace for excavation tickets and map-based field work: one place to organize locates, photos, layers, and 811 responses between the office and the crew.':
            'Locus es un espacio compartido para tickets de excavación y trabajo de campo en el mapa: un solo lugar para organizar localizaciones, fotos, capas y respuestas 811 entre la oficina y el equipo.',
        'Locus is shaped by real field workflows and ongoing input from crews, locators, and partners who use it every day. Thank you to everyone who shares feedback and helps improve the tool for the wider community.':
            'Locus se forma con flujos de trabajo reales de campo y la aportación continua de equipos, localizadores y socios que lo usan cada día. Gracias a quienes comparten comentarios y ayudan a mejorar la herramienta para toda la comunidad.',
        'Interactive maps are powered by Leaflet, an open-source JavaScript library for mobile-friendly maps. Basemap and imagery credits also appear in the map attribution control.':
            'Los mapas interactivos usan Leaflet, una biblioteca JavaScript de código abierto para mapas móviles. Los créditos de mapas base e imágenes también aparecen en el control de atribución del mapa.',
        'Interactive maps are powered by ':
            'Los mapas interactivos usan ',
        ', an open-source JavaScript library for mobile-friendly maps. Basemap and imagery credits also appear in the map attribution control.':
            ', una biblioteca JavaScript de código abierto para mapas móviles. Los créditos de mapas base e imágenes también aparecen en el control de atribución del mapa.',
        'Getting Started': 'Primeros pasos',
        'Choose a topic to learn how to use Locus. Tap Back anytime to return to this list.':
            'Elija un tema para aprender a usar Locus. Pulse Atrás en cualquier momento para volver a esta lista.',
        'All topics': 'Todos los temas',
        'Org menu, Ticket Hub, Data Hub, and the map':
            'Menú de organización, Centro de tickets, Centro de datos y el mapa',
        'Map & Organization': 'Mapa y organización',
        'Switch orgs, select tickets, filters, and layers':
            'Cambiar organizaciones, seleccionar tickets, filtros y capas',
        'Ticket Hub': 'Centro de tickets',
        'Search, sync, assign, create, and bulk actions':
            'Buscar, sincronizar, asignar, crear y acciones masivas',
        'Projects': 'Proyectos',
        'Group tickets by job name and track compliance':
            'Agrupar tickets por nombre de trabajo y seguir el cumplimiento',
        'Ticket Details': 'Detalles del ticket',
        'Details, Responses, Photos & Events, and Notes':
            'Detalles, Respuestas, Fotos y eventos, y Notas',
        'Ticket Statuses and Colors': 'Estados y colores de tickets',
        'Ready, Not Ready, Review Required, and more':
            'Listo, No listo, Revisión requerida y más',
        'Data Hub': 'Centro de datos',
        'Annotations, layers, photos, documents, and events':
            'Anotaciones, capas, fotos, documentos y eventos',
        'Photos & Map Layers': 'Fotos y capas del mapa',
        'Ticket photos, overlays, and aerial imagery':
            'Fotos de tickets, superposiciones e imágenes aéreas',
        'Profile, language, map defaults, and ticket prefs':
            'Perfil, idioma, valores predeterminados del mapa y preferencias de tickets',
        'Public Data': 'Datos públicos',
        'Search shared tickets and imagery in the map view':
            'Buscar tickets e imágenes compartidos en la vista del mapa',
        'Offline Use': 'Uso sin conexión',
        'What stays available when the connection drops':
            'Qué sigue disponible cuando se pierde la conexión',
        'Troubleshooting': 'Solución de problemas',
        'Stale data, sync, imagery, and common fixes':
            'Datos desactualizados, sincronización, imágenes y soluciones comunes',
        'Locus is map-first: after you sign in, you work from the full-screen map rather than a permanent sidebar.':
            'Locus prioriza el mapa: después de iniciar sesión, trabaja desde el mapa a pantalla completa en lugar de una barra lateral permanente.',
        'Organization menu': 'Menú de organización',
        'Ticket Hub (top-left)': 'Centro de tickets (arriba a la izquierda)',
        'Data Hub (top-left)': 'Centro de datos (arriba a la izquierda)',
        'Status filter bar (desktop)': 'Barra de filtros de estado (escritorio)',
        'Sync': 'Sincronizar',
        'Import': 'Importar',
        'Assign': 'Asignar',
        'Details': 'Detalles',
        'Responses': 'Respuestas',
        'Notes': 'Notas',
        'Layers': 'Capas',
        '— Use the radial org control on the map to switch which company or Public Data view you are working in. Switching orgs reloads tickets and map data for that org.':
            '— Use el control radial de organización en el mapa para cambiar la empresa o la vista de Datos públicos. Al cambiar de organización se recargan los tickets y los datos del mapa de esa organización.',
        '— Open the ticket list to search, filter, sync, assign work, manage projects, and open ticket details.':
            '— Abra la lista de tickets para buscar, filtrar, sincronizar, asignar trabajo, gestionar proyectos y abrir detalles.',
        '— Manage annotations, data layers, photos, documents, and events.':
            '— Gestione anotaciones, capas de datos, fotos, documentos y eventos.',
        '— Tap a ticket bubble or polygon to open its detail panel. On desktop, the status filter bar shows per-status counts and filters what appears on the map.':
            '— Toque una burbuja o polígono de ticket para abrir su panel de detalle. En escritorio, la barra de filtros de estado muestra conteos y filtra lo que aparece en el mapa.',
        'Account menu': 'Menú de cuenta',
        '— Open Settings, About (this guide), Admin (if allowed), or log out.':
            '— Abra Configuración, Acerca de (esta guía), Administración (si está permitido) o cierre sesión.',
        '— Open Settings, User Guide, Admin (if allowed), or log out.':
            '— Abra Configuración, Guía del usuario, Administración (si está permitido) o cierre sesión.',
        'Tech users may see a simpler map-focused experience (Ticket Hub and some filters can be hidden) so they can focus on assigned field work.':
            'Los usuarios técnicos pueden ver una experiencia más simple centrada en el mapa (el Centro de tickets y algunos filtros pueden ocultarse) para enfocarse en el trabajo de campo asignado.',
        'The map is the main workspace. Ticket markers cluster at wider zooms; at closer zoom levels, ticket boundaries appear when geometry is available.':
            'El mapa es el espacio de trabajo principal. Los marcadores se agrupan con menos zoom; con más zoom aparecen los límites del ticket cuando hay geometría.',
        'Select a ticket': 'Seleccionar un ticket',
        '— Click a polygon or 811 bubble to highlight it and open the detail panel (same tabs as Ticket Hub detail).':
            '— Haga clic en un polígono o burbuja 811 para resaltarlo y abrir el panel de detalle (las mismas pestañas que el detalle del Centro de tickets).',
        'Status filter bar': 'Barra de filtros de estado',
        '— Click a status count to show or hide tickets of that status on the map. Counts mirror Ticket Hub stats.':
            '— Haga clic en un conteo de estado para mostrar u ocultar tickets de ese estado en el mapa. Los conteos reflejan las estadísticas del Centro de tickets.',
        'Layer panel': 'Panel de capas',
        '— Switch basemaps and toggle overlays such as Tickets, Drone Maps, and Photos.':
            '— Cambie mapas base y active o desactive superposiciones como Tickets, Mapas de drones y Fotos.',
        'Address search': 'Búsqueda de dirección',
        '— Jump the map to an address or use current location when the browser allows it.':
            '— Lleve el mapa a una dirección o use la ubicación actual cuando el navegador lo permita.',
        'Org switch': 'Cambio de organización',
        '— Changing organization closes open ticket panels and reloads that org’s tickets so you do not keep looking at another company’s data.':
            '— Al cambiar de organización se cierran los paneles de tickets abiertos y se recargan los tickets de esa organización para no seguir viendo datos de otra empresa.',
        'Ticket Hub is the place to manage your org’s tickets in a list, with search, filters, stats, and detail view.':
            'El Centro de tickets es donde gestiona los tickets de su organización en una lista, con búsqueda, filtros, estadísticas y vista de detalle.',
        'Tickets tab': 'Pestaña Tickets',
        '— Browse, search, and filter tickets. Open a row to see full detail beside (or below on mobile) the list.':
            '— Explore, busque y filtre tickets. Abra una fila para ver el detalle completo junto a (o debajo en móvil) la lista.',
        'Projects tab': 'Pestaña Proyectos',
        '— Group tickets by job name and manage shared compliance (see Projects).':
            '— Agrupe tickets por nombre de trabajo y gestione el cumplimiento compartido (vea Proyectos).',
        '— The refresh control runs an external list sync (recent days, extending when overdue). You can start another sync after the current one finishes; it only blocks while a sync is already running.':
            '— El control de actualizar ejecuta una sincronización de lista externa (días recientes, ampliándose si está atrasada). Puede iniciar otra sincronización cuando termine la actual; solo se bloquea mientras ya hay una en curso.',
        '— Bring tickets in from an external source when your role allows it.':
            '— Traiga tickets desde una fuente externa cuando su rol lo permita.',
        '— When enabled for your org, create a ticket (map polygon wizard) or a new project. Create and renew features may be limited to org admins and may be turned on per environment.':
            '— Cuando esté habilitado para su organización, cree un ticket (asistente de polígono en el mapa) o un proyecto nuevo. Crear y renovar pueden limitarse a administradores de la organización y activarse por entorno.',
        '— Create a new project when your role allows it. Creating tickets, renewals, remarks, amendments, and related USAN submits is limited to company admins when those features are enabled for your org — Org Users and Techs cannot create or renew tickets.':
            '— Cree un proyecto nuevo cuando su rol lo permita. Crear tickets, renovaciones, observaciones, enmiendas y envíos USAN relacionados está limitado a administradores de la empresa cuando esas funciones están habilitadas — los usuarios de la organización y los técnicos no pueden crear ni renovar tickets.',
        'Create project': 'Crear proyecto',
        '— Create a new project when your role allows it.':
            '— Cree un proyecto nuevo cuando su rol lo permita.',
        'Create & renew': 'Crear y renovar',
        'Only company admins can create tickets, renew, remark, amend, or submit related USAN actions when those features are enabled for your org. Org Users and Techs cannot create or renew tickets.':
            'Solo los administradores de la empresa pueden crear tickets, renovar, agregar observaciones, enmendar o enviar acciones USAN relacionadas cuando esas funciones están habilitadas. Los usuarios de la organización y los técnicos no pueden crear ni renovar tickets.',
        'Only company admins and managers can create tickets, renew, remark, amend, or submit related USAN actions when those features are enabled for your org. Operators and Techs cannot create or renew tickets.':
            'Solo los administradores y gerentes de la empresa pueden crear tickets, renovar, agregar observaciones, enmendar o enviar acciones USAN relacionadas cuando esas funciones están habilitadas. Los operadores y técnicos no pueden crear ni renovar tickets.',
        'USAN ticket writes': 'Escrituras de tickets USAN',
        'Only company admins can create, renew, remark, amend, or submit related USAN ticket actions when those features are enabled. Org Users and Techs cannot.':
            'Solo los administradores de la empresa pueden crear, renovar, agregar observaciones, enmendar o enviar acciones USAN relacionadas cuando esas funciones están habilitadas. Los usuarios de la organización y los técnicos no pueden.',
        'Only company admins and managers can create, renew, remark, amend, or submit related USAN ticket actions when those features are enabled. Operators and Techs cannot.':
            'Solo los administradores y gerentes de la empresa pueden crear, renovar, agregar observaciones, enmendar o enviar acciones USAN relacionadas cuando esas funciones están habilitadas. Los operadores y técnicos no pueden.',
        'Search guide': 'Buscar en la guía',
        'Filter topics': 'Filtrar temas',
        'Search topics…': 'Buscar temas…',
        'Type to narrow the list…': 'Escriba para acotar la lista…',
        'No topics match your search.': 'Ningún tema coincide con su búsqueda.',
        'Roles & Permissions': 'Roles y permisos',
        'User, Admin, and Tech roles in your company':
            'Roles de Usuario, Administrador y Técnico en su empresa',
        'Operator, Manager, Admin, and Tech roles in your company':
            'Roles de Operador, Gerente, Administrador y Técnico en su empresa',
        'Your role is set per company (organization). It controls what you can see and do in that org. Your role for the current company is shown under Settings → Profile. Switching companies can change which role applies.':
            'Su rol se define por empresa (organización). Controla lo que puede ver y hacer en esa organización. Su rol en la empresa actual aparece en Configuración → Perfil. Cambiar de empresa puede cambiar el rol que aplica.',
        '— Day-to-day ticket work for that company (import, sync, assignees, and notes) when enabled. Cannot create, renew, remark, amend, or submit related USAN ticket actions — those are for company admins when enabled. Can add and edit company data (photos, annotations, events, layers) but cannot delete data. Can change who is assigned to a project.':
            '— Trabajo diario con tickets de esa empresa (importar, sincronizar, asignados y notas) cuando esté habilitado. No puede crear, renovar, agregar observaciones, enmendar ni enviar acciones USAN relacionadas — eso corresponde a administradores de la empresa cuando esté habilitado. Puede agregar y editar datos de la empresa (fotos, anotaciones, eventos, capas), pero no eliminarlos. Puede cambiar quién está asignado a un proyecto.',
        '— Day-to-day ticket work for that company (import, sync, assignees, and notes) when enabled. Cannot create, renew, remark, amend, or submit related USAN ticket actions — those are for company admins and managers when enabled. Can add and edit company data (photos, annotations, events, layers) but cannot delete data. Can change who is assigned to a project.':
            '— Trabajo diario con tickets de esa empresa (importar, sincronizar, asignados y notas) cuando esté habilitado. No puede crear, renovar, agregar observaciones, enmendar ni enviar acciones USAN relacionadas — eso corresponde a administradores y gerentes de la empresa cuando esté habilitado. Puede agregar y editar datos de la empresa (fotos, anotaciones, eventos, capas), pero no eliminarlos. Puede cambiar quién está asignado a un proyecto.',
        '— Office/lead role: when create/renew features are enabled for the org, can create tickets, renew, remark, amend, and related USAN submits. Can edit and delete company data. Cannot access the Admin Panel or manage users and org settings.':
            '— Rol de oficina/líder: cuando crear/renovar está habilitado para la organización, puede crear tickets, renovar, agregar observaciones, enmendar y enviar acciones USAN relacionadas. Puede editar y eliminar datos de la empresa. No puede acceder al Panel de administración ni gestionar usuarios y configuración de la organización.',
        '— Company admin: manage users and settings, assign tickets and projects, and set other members to User, Admin, or Tech. When create/renew features are enabled for the org, admins can create tickets, renew, remark, amend, and related USAN submits. Can edit and delete company data.':
            '— Administrador de la empresa: gestiona usuarios y configuración, asigna tickets y proyectos, y define a otros miembros como Usuario, Administrador o Técnico. Cuando crear/renovar está habilitado para la organización, los administradores pueden crear tickets, renovar, agregar observaciones, enmendar y enviar acciones USAN relacionadas. Puede editar y eliminar datos de la empresa.',
        '— Company admin: manage users and settings, assign tickets and projects, and set other members to Operator, Manager, Admin, or Tech. When create/renew features are enabled for the org, admins can create tickets, renew, remark, amend, and related USAN submits. Can edit and delete company data.':
            '— Administrador de la empresa: gestiona usuarios y configuración, asigna tickets y proyectos, y define a otros miembros como Operador, Gerente, Administrador o Técnico. Cuando crear/renovar está habilitado para la organización, los administradores pueden crear tickets, renovar, agregar observaciones, enmendar y enviar acciones USAN relacionadas. Puede editar y eliminar datos de la empresa.',
        '— Field role: sees only tickets assigned to you that are not expired (partner tickets from other companies are hidden). Simpler map-focused UI. Can refresh tickets, acknowledge workflow steps, add notes, and add company data; can edit only data you created. Cannot create or renew tickets, import tickets, or delete data.':
            '— Rol de campo: ve solo los tickets asignados a usted que no estén vencidos (los tickets de socios de otras empresas se ocultan). Interfaz más simple centrada en el mapa. Puede actualizar tickets, confirmar pasos del flujo, agregar notas y datos de la empresa; solo puede editar datos que creó. No puede crear ni renovar tickets, importar tickets ni eliminar datos.',
        'Ask a company admin or your supervisor if you need a different role.':
            'Pida a un administrador de la empresa o a su supervisor si necesita un rol diferente.',
        'Last updated: July 26, 2026': 'Última actualización: 26 de julio de 2026',
        'Bulk actions': 'Acciones masivas',
        '— Select rows to update selected tickets from external services, clear the selection, or (when available) renew or delete.':
            '— Seleccione filas para actualizar tickets desde servicios externos, borrar la selección o (cuando esté disponible) renovar o eliminar.',
        '— Assign tickets to crew members from the list or detail view when you have permission.':
            '— Asigne tickets a miembros del equipo desde la lista o la vista de detalle cuando tenga permiso.',
        'Projects live in Ticket Hub (not in the map popup). They group tickets that share a USAN job name, including blank projects you create before tickets arrive.':
            'Los proyectos están en el Centro de tickets (no en el popup del mapa). Agrupan tickets que comparten un nombre de trabajo USAN, incluidos proyectos en blanco que cree antes de que lleguen tickets.',
        'New project': 'Proyecto nuevo',
        '— Reserves a job name. Later USAN imports with a matching job name join that project automatically.':
            '— Reserva un nombre de trabajo. Las importaciones USAN posteriores con el mismo nombre se unen a ese proyecto automáticamente.',
        'Project view': 'Vista de proyecto',
        '— See linked tickets and edit shared compliance fields when you own the org. Shared/partner tickets are view-only for compliance.':
            '— Vea tickets vinculados y edite campos de cumplimiento compartidos cuando sea dueño de la organización. Los tickets compartidos/de socios son solo lectura para cumplimiento.',
        'Needs attention': 'Requiere atención',
        '— A project is flagged when compliance dates are missing or due, or when any linked ticket is Not Ready, Review Required, or Expiring Soon.':
            '— Un proyecto se marca cuando faltan fechas de cumplimiento o están vencidas, o cuando algún ticket vinculado está No listo, Revisión requerida o Por vencer.',
        'Jump to ticket': 'Ir al ticket',
        '— Click a ticket in the project view to open it on the Tickets tab.':
            '— Haga clic en un ticket en la vista de proyecto para abrirlo en la pestaña Tickets.',
        'The map popup and Ticket Hub detail pane share the same four tabs. A yellow status dot appears on a tab when that area needs follow-up.':
            'El popup del mapa y el panel de detalle del Centro de tickets comparten las mismas cuatro pestañas. Un punto amarillo aparece en una pestaña cuando esa área requiere seguimiento.',
        '— Core fields, assignment, dates, and related ticket info.':
            '— Campos principales, asignación, fechas e información relacionada del ticket.',
        '— Operator / utility response rows. Dot when a response is not ready or needs review.':
            '— Filas de respuesta de operador / servicio. Punto cuando una respuesta no está lista o requiere revisión.',
        'Photos & Events': 'Fotos y eventos',
        '— Ticket-area photos and related events. Dot when the required photo count for the current revision is not met (and no override).':
            '— Fotos del área del ticket y eventos relacionados. Punto cuando no se cumple el número de fotos requerido para la revisión actual (y no hay anulación).',
        '— Org team notes. Opening the tab loads notes and marks them read. Owner-org members can add notes; shared/partner tickets are read-only. Dot when you have unread notes.':
            '— Notas del equipo de la organización. Al abrir la pestaña se cargan y se marcan como leídas. Los miembros de la organización dueña pueden agregar notas; los tickets compartidos/de socios son solo lectura. Punto cuando hay notas sin leer.',
        'Default which tab opens first can be changed under Settings → Tickets.':
            'La pestaña que se abre primero se puede cambiar en Configuración → Tickets.',
        'Statuses are calculated when tickets load or refresh. The polygon color matches the status badge in the ticket list.':
            'Los estados se calculan al cargar o actualizar tickets. El color del polígono coincide con la insignia de estado en la lista.',
        'Statuses are calculated when tickets load or refresh. The polygon color matches the status badge in the ticket list. Colors below match the map pins.':
            'Los estados se calculan al cargar o actualizar tickets. El color del polígono coincide con la insignia de estado en la lista. Los colores de abajo coinciden con los pines del mapa.',
        'Ready is green. The ticket is not expired, all known operator requirements are satisfied, and any required ticket-area photos are complete (or workflow is acknowledged).':
            'Listo es verde. El ticket no está vencido, se cumplen los requisitos de operadores conocidos y las fotos requeridas del área están completas (o el flujo está confirmado).',
        'The ticket is not expired, all known operator requirements are satisfied, and any required ticket-area photos are complete (or workflow is acknowledged).':
            'El ticket no está vencido, se cumplen los requisitos de operadores conocidos y las fotos requeridas del área están completas (o el flujo está confirmado).',
        'Not Ready is red. An operator response is still not ready, fewer responses were received than expected for the known station list, or the ticket is still waiting on operators in that sense.':
            'No listo es rojo. Una respuesta de operador aún no está lista, se recibieron menos respuestas de las esperadas para la lista de estaciones conocida, o el ticket sigue esperando operadores en ese sentido.',
        'An operator response is still not ready, fewer responses were received than expected for the known station list, or the ticket is still waiting on operators in that sense.':
            'Una respuesta de operador aún no está lista, se recibieron menos respuestas de las esperadas para la lista de estaciones conocida, o el ticket sigue esperando operadores en ese sentido.',
        'Expiring Soon is red. The ticket is not expired but its expiration calendar date is within the days your organization sets in Admin → Workflow (default 5). Not Ready takes priority over Expiring Soon.':
            'Por vencer es rojo. El ticket no está vencido pero su fecha de vencimiento está dentro de los días que su organización define en Admin → Flujo de trabajo (predeterminado 5). No listo tiene prioridad sobre Por vencer.',
        'The ticket is not expired but its expiration calendar date is within the days your organization sets in Admin → Workflow (default 5). Not Ready takes priority over Expiring Soon.':
            'El ticket no está vencido pero su fecha de vencimiento está dentro de los días que su organización define en Admin → Flujo de trabajo (predeterminado 5). No listo tiene prioridad sobre Por vencer.',
        'Review Required is yellow. User-side follow-up after operators have done their part—for example, an operator response that needs review, or the 2-photo requirement for the current ticket revision is not met. It is not used when the gap is simply missing response rows vs expected stations.':
            'Revisión requerida es amarillo. Seguimiento del usuario después de que los operadores cumplieron su parte; por ejemplo, una respuesta que requiere revisión, o no se cumple el requisito de 2 fotos para la revisión actual. No se usa cuando el hueco es simplemente filas de respuesta faltantes frente a estaciones esperadas.',
        'User-side follow-up after operators have done their part—for example, an operator response that needs review, or the 2-photo requirement for the current ticket revision is not met. It is not used when the gap is simply missing response rows vs expected stations.':
            'Seguimiento del usuario después de que los operadores cumplieron su parte; por ejemplo, una respuesta que requiere revisión, o no se cumple el requisito de 2 fotos para la revisión actual. No se usa cuando el hueco es simplemente filas de respuesta faltantes frente a estaciones esperadas.',
        'Expired is gray. The ticket expiration date has passed.':
            'Vencido es gris. La fecha de vencimiento del ticket ya pasó.',
        'The ticket expiration date has passed.':
            'La fecha de vencimiento del ticket ya pasó.',
        'Cancelled is gray. The upstream enquiry was cancelled, and the ticket is not yet expired.':
            'Cancelado es gris. La consulta upstream fue cancelada y el ticket aún no ha vencido.',
        'The upstream enquiry was cancelled, and the ticket is not yet expired.':
            'La consulta upstream fue cancelada y el ticket aún no ha vencido.',
        'When multiple rules apply, the app uses this order: Expired, Cancelled, Not Ready, Expiring Soon, Review Required, then Ready.':
            'Cuando aplican varias reglas, el orden es: Vencido, Cancelado, No listo, Por vencer, Revisión requerida y luego Listo.',
        'Important: Locus helps crews understand 811 responses more clearly, but it does not decide whether a crew is ready to dig. The field crew is responsible for reviewing the ticket, site conditions, utility responses, and applicable procedures before digging.':
            'Importante: Locus ayuda a los equipos a entender las respuestas 811 con más claridad, pero no decide si un equipo puede excavar. El equipo de campo es responsable de revisar el ticket, las condiciones del sitio, las respuestas de servicios y los procedimientos aplicables antes de excavar.',
        'Important': 'Importante',
        'Locus helps crews understand 811 responses more clearly, but it does not decide whether a crew is ready to dig. The field crew is responsible for reviewing the ticket, site conditions, utility responses, and applicable procedures before digging.':
            'Locus ayuda a los equipos a entender las respuestas 811 con más claridad, pero no decide si un equipo puede excavar. El equipo de campo es responsable de revisar el ticket, las condiciones del sitio, las respuestas de servicios y los procedimientos aplicables antes de excavar.',
        'Open Data Hub from the top-left button next to Ticket Hub. Use it to browse and manage field data that is not only the ticket list.':
            'Abra el Centro de datos desde el botón superior izquierdo junto al Centro de tickets. Úselo para explorar y gestionar datos de campo más allá de la lista de tickets.',
        'Annotations': 'Anotaciones',
        '— Map drawings and notes tied to locations.':
            '— Dibujos y notas del mapa vinculados a ubicaciones.',
        '— Data layers you can turn on for the map.':
            '— Capas de datos que puede activar en el mapa.',
        '— Org photos (also see Photos & Map Layers).':
            '— Fotos de la organización (vea también Fotos y capas del mapa).',
        'Documents': 'Documentos',
        '— Files attached for the org or job context.':
            '— Archivos adjuntos para la organización o el contexto del trabajo.',
        'Events': 'Eventos',
        '— Related field events tied to tickets or locations.':
            '— Eventos de campo relacionados vinculados a tickets o ubicaciones.',
        'Use search and filters in Data Hub to narrow results. Refresh reloads the current Data Hub view.':
            'Use búsqueda y filtros en el Centro de datos para acotar resultados. Actualizar recarga la vista actual.',
        'Ticket photos': 'Fotos del ticket',
        '— Add or review ticket-area photos from the Photos & Events tab. Most tickets expect two photos for the current revision unless an override is set.':
            '— Agregue o revise fotos del área desde la pestaña Fotos y eventos. La mayoría de tickets esperan dos fotos para la revisión actual salvo que haya una anulación.',
        'Capture': 'Captura',
        '— Prefer in-app camera when possible so GPS tagging is preserved. Choosing files from the device gallery may omit location.':
            '— Prefiera la cámara en la app cuando sea posible para conservar la etiqueta GPS. Elegir archivos de la galería puede omitir la ubicación.',
        'Map photo overlay': 'Superposición de fotos en el mapa',
        '— With Photos turned on in the layer panel, photos load for the current map view at zoom 16+. Zoom in before expecting photo pins.':
            '— Con Fotos activado en el panel de capas, las fotos se cargan para la vista actual a zoom 16+. Acerque antes de esperar pines de fotos.',
        'Drone / aerial overlays': 'Superposiciones de drones / aéreas',
        '— Toggle Drone Maps in the layer panel when imagery exists for the area and date range.':
            '— Active Mapas de drones en el panel de capas cuando exista imaginería para el área y el rango de fechas.',
        'Open Settings from the account menu. Changes apply to your signed-in user.':
            'Abra Configuración desde el menú de cuenta. Los cambios se aplican a su usuario conectado.',
        '— Name, phone (used as default contact mobile when creating USAN tickets), email, and language (English or Spanish).':
            '— Nombre, teléfono (usado como móvil de contacto predeterminado al crear tickets USAN), correo e idioma (inglés o español).',
        '— Theme and related display preferences.':
            '— Tema y preferencias de visualización relacionadas.',
        '— Default basemap, units, and default zoom.':
            '— Mapa base predeterminado, unidades y zoom predeterminado.',
        '— Default ticket list filter, which detail tab opens first, and Ticket Hub detail height on mobile.':
            '— Filtro predeterminado de la lista, qué pestaña de detalle se abre primero y altura del detalle del Centro de tickets en móvil.',
        'When you select the Public Data organization, the app focuses on discovering shared content in the current map view rather than a full private Ticket Hub workflow.':
            'Al seleccionar la organización Datos públicos, la app se centra en descubrir contenido compartido en la vista actual del mapa en lugar del flujo completo del Centro de tickets privado.',
        'Use Search to find shared tickets, photos, layers, and aerial imagery in the view.':
            'Use Buscar para encontrar tickets, fotos, capas e imágenes aéreas compartidas en la vista.',
        'Zoom to level 16+ before searching so results are tied to a useful map extent.':
            'Acerque al nivel 16+ antes de buscar para que los resultados cubran un área útil del mapa.',
        'Ticket Hub and some status filters may be hidden in this mode—use map search and overlays instead.':
            'El Centro de tickets y algunos filtros de estado pueden ocultarse en este modo; use la búsqueda del mapa y las superposiciones.',
        'Locus can keep recently loaded ticket data available when your connection drops. On desktop, the status indicator in the ticket stats bar shows offline (wifi-off), syncing, or USAN activity. On mobile, an offline indicator appears near the top-left map controls.':
            'Locus puede mantener disponibles tickets cargados recientemente si se pierde la conexión. En escritorio, el indicador de estado de la barra de estadísticas muestra sin conexión, sincronización o actividad USAN. En móvil, un indicador sin conexión aparece cerca de los controles superiores izquierdos.',
        'Tickets and polygons already loaded for the current org may remain viewable offline.':
            'Los tickets y polígonos ya cargados de la organización actual pueden seguir viéndose sin conexión.',
        'Assigned ticket packs may be prepared so field users can keep working without a live connection.':
            'Pueden prepararse paquetes de tickets asignados para que el personal de campo siga trabajando sin conexión en vivo.',
        'Actions that need the server (sync, import, create, renew, most uploads) stay disabled until you are back online.':
            'Las acciones que requieren el servidor (sincronizar, importar, crear, renovar, la mayoría de subidas) permanecen deshabilitadas hasta que vuelva a estar en línea.',
        'When connectivity returns, cached data can sync; if something looks wrong after reconnecting, refresh Ticket Hub or reload the page.':
            'Al recuperar la conexión, los datos en caché pueden sincronizarse; si algo se ve mal después de reconectar, actualice el Centro de tickets o recargue la página.',
        'Stale tickets': 'Tickets desactualizados',
        '— Run Ticket Hub sync, or open a ticket and update it from external services. Switching org and back also reloads that org’s list.':
            '— Ejecute la sincronización del Centro de tickets, o abra un ticket y actualícelo desde servicios externos. Cambiar de organización y volver también recarga la lista.',
        'Sync button busy': 'Botón de sincronización ocupado',
        '— Wait for the current sync to finish; then you can run sync again.':
            '— Espere a que termine la sincronización actual; luego puede sincronizar de nuevo.',
        'Missing photos on the map': 'Faltan fotos en el mapa',
        '— Zoom to 16+, turn on the Photos overlay, and confirm photos exist for that area.':
            '— Acerque a 16+, active la superposición Fotos y confirme que hay fotos para esa área.',
        'Aerial / drone imagery missing': 'Falta imaginería aérea / de drones',
        '— Zoom in far enough and check that imagery exists for the selected date range.':
            '— Acerque lo suficiente y compruebe que exista imaginería para el rango de fechas seleccionado.',
        'Wrong org’s tickets': 'Tickets de la organización incorrecta',
        '— Confirm the organization menu selection; switching orgs reloads data for that org only.':
            '— Confirme la selección del menú de organización; al cambiar se recargan solo los datos de esa organización.',
        'UI language': 'Idioma de la interfaz',
        '— Change language under Settings → Profile. Spanish copy is a first pass and may still be refined.':
            '— Cambie el idioma en Configuración → Perfil. El texto en español es una primera versión y puede refinarse.',
        'Last updated: July 17, 2026': 'Última actualización: 17 de julio de 2026',
        'Time Warp': 'Time Warp',
        'Feedback': 'Retroalimentación',
        'Admin Panel': 'Panel de administración',
        'Logout': 'Cerrar sesión',
        'Search Address': 'Buscar dirección',
        'Search for an address...': 'Buscar una dirección...',
        'Use current location': 'Usar ubicación actual',
        'Use Current Location': 'Usar la ubicación actual',
        'Getting current location…': 'Obteniendo ubicación actual...',
        'Select Photo Source': 'Seleccionar origen de foto',
        'Take Photo': 'Tomar foto',
        'Choose photo files (Files)': 'Elegir archivos de foto (Archivos)',
        'Using "Choose Photo Files" could result in photos not being tagged with their GPS location.': 'El uso de «Elegir archivos de fotos» podría provocar que las fotos no se etiqueten con su ubicación GPS.',
        'Take photos in app': 'Tomar fotos en la app',
        'In-app camera': 'Cámara en la app',
        'Stop': 'Detener',
        'Capture photo': 'Capturar foto',
        'Finish': 'Finalizar',
        'Switch camera': 'Cambiar cámara',
        'Match this shot': 'Igualar esta toma',
        'Match': 'Igualar',
        'Ghost opacity': 'Opacidad del fantasma',
        'Matching: {name}': 'Igualando: {name}',
        'reference photo': 'foto de referencia',
        'Switch to the rear camera to match this shot': 'Cambie a la cámara trasera para igualar esta toma',
        "Couldn't load the reference photo. Connect to the network or open the photo once while online, then try again.":
            'No se pudo cargar la foto de referencia. Conéctese a la red o abra la foto una vez en línea y vuelva a intentarlo.',
        'Choose from gallery': 'Elegir de la galería',
        'All nearby': 'Todas cercanas',
        'Restaked only': 'Solo re-igualadas',
        'Matched shot': 'Toma igualada',
        'of {name}': 'de {name}',
        'Attach selected': 'Adjuntar seleccionadas',
        'Loading nearby photos…': 'Cargando fotos cercanas…',
        'No photos found nearby': 'No se encontraron fotos cercanas',
        'Set report location on map or use a ticket with a dig site':
            'Establezca la ubicación del reporte en el mapa o use un ticket con sitio de excavación',
        'No matched shots nearby — try All nearby or use Match on an existing photo':
            'No hay tomas igualadas cercanas — pruebe Todas cercanas o use Igualar en una foto existente',
        'Compare': 'Comparar',
        'Compare with original': 'Comparar con original',
        'Notes and tags': 'Notas y etiquetas',
        'Original unavailable': 'Original no disponible',
        'Original': 'Original',
        'Restake': 'Re-igualada',
        '{nUploaded} uploaded / {nQueued} queued': '{nUploaded} subidas / {nQueued} en cola',
        'In-page camera requires a secure connection (HTTPS or localhost). Use Choose photo files instead.': 'La cámara en la página requiere una conexión segura (HTTPS o localhost). Use Elegir archivos de foto en su lugar.',
        'This browser does not support in-page camera access.': 'Este navegador no admite acceso a la cámara en la página.',
        'Camera failed: {detail}': 'Error de cámara: {detail}',
        'Discard unsent photos?': '¿Descartar fotos no enviadas?',
        'Photos still waiting to upload will be discarded. Photos already uploading will usually finish saving.': 'Las fotos que aún esperan subirse se descartarán. Las que ya se están subiendo normalmente terminarán de guardarse.',
        'Stay': 'Permanecer aquí',
        'Discard and close': 'Descartar y cerrar',
        'Update available': 'Actualización disponible',
        'A new update has been made. The page will reload for changes to take effect.':
            'Hay una actualización nueva. La página se recargará para aplicar los cambios.',
        'Name': 'Nombre',
        'Email': 'Correo electrónico',
        'User Type': 'Tipo de usuario',
        'Role in current organization': 'Rol en la organización actual',
        'User type cannot be changed': 'El tipo de usuario no se puede cambiar',
        'Enter your name': 'Ingrese su nombre',
        'Enter your email': 'Ingrese su correo electrónico',
        'Change Password': 'Cambiar contraseña',
        'Current Password': 'Contraseña actual',
        'New Password': 'Nueva contraseña',
        'Confirm New Password': 'Confirmar nueva contraseña',
        'Enter current password': 'Ingrese la contraseña actual',
        'Enter new password': 'Ingrese una nueva contraseña',
        'Confirm new password': 'Confirme la nueva contraseña',
        'Organization': 'Organización',
        'Organizations': 'Organizaciones',
        'Personalization': 'Personalización',
        'Language': 'Idioma',
        'English': 'Inglés',
        'Spanish': 'Español',
        'Applies to the map page. Spanish copy is pending native-speaker review.': 'Se aplica a la página del mapa. El texto en español está pendiente de revisión por un hablante nativo.',
        'Default Basemap': 'Mapa base predeterminado',
        'Default': 'Predeterminado',
        'Dark': 'Oscuro',
        'Light': 'Claro',
        'Text size': 'Tamaño de texto',
        'Compact': 'Compacto',
        'Large': 'Grande',
        'Max': 'Máximo',
        'Scales labels, ticket list, panels, and dialogs on the map page.':
            'Escala etiquetas, lista de tickets, paneles y diálogos en la página del mapa.',
        'UI design': 'Diseño de interfaz',
        'Standard': 'Estándar',
        'Frosted glass': 'Vidrio esmerilado',
        'Outline minimal': 'Contorno minimalista',
        'Ember (warm)': 'Brasa (cálido)',
        'Slate & cyan': 'Pizarra y cian',
        'Surveyor blueprint': 'Plano topográfico',
        'Contractor block': 'Bloque de contratista',
        'Map console': 'Consola de mapa',
        'Land office': 'Oficina de tierras',
        'Modern utility': 'Servicios modernos',
        'Applies to the map app only; the sign-in screen has its own look.': 'Se aplica solo a la app del mapa; la pantalla de inicio de sesión tiene su propio diseño.',
        'Show tooltips': 'Mostrar ayudas',
        'Map Settings': 'Configuración del mapa',
        'Default Map View': 'Vista de mapa predeterminada',
        'Street Map': 'Mapa de calles',
        'Satellite': 'Satélite',
        'OpenTopoMap': 'OpenTopoMap',
        'Units': 'Unidades',
        'Imperial (ft, mi)': 'Imperial (pies, millas)',
        'Metric (m, km)': 'Métrico (m, km)',
        'Default Zoom Level': 'Nivel de zoom predeterminado',
        'Zoom level when map first loads (0-24)': 'Nivel de zoom al cargar el mapa (0-24)',
        'Show Photos layer when map loads': 'Mostrar capa de fotos al cargar el mapa',
        'Show Annotations layer when map loads': 'Mostrar capa de anotaciones al cargar el mapa',
        'Tickets': 'Tickets',
        'Default ticket status': 'Estado predeterminado de tickets',
        'All Active': 'Todos activos',
        'All statuses': 'Todos los estados',
        'Assigned': 'Asignados',
        'Assigned to me': 'Asignados a mí',
        'Live': 'En vivo',
        'Complete': 'Completo',
        'Incomplete': 'Incompleto',
        'Expiring': 'Por vencer',
        'Ready': 'Listo',
        'READY': 'LISTO',
        'Not ready': 'No listo',
        'Not Ready': 'No listo',
        'Review required': 'Requiere revisión',
        'Review Required': 'Revisión requerida',
        'Expiring soon': 'Por vencer',
        'Expiring Soon': 'Por vencer',
        'Expired': 'Vencido',
        'Cancelled': 'Cancelado',
        'External': 'Externo',
        'Internal': 'Interno',
        'Ticket list filter when you first open the app': 'Filtro de lista de tickets al abrir la app',
        'While drawing a ticket': 'Al dibujar un ticket',
        'Keep photos and annotations on the map, but block taps': 'Mantener fotos y anotaciones en el mapa, pero bloquear toques',
        'Hide photos and annotations until drawing ends': 'Ocultar fotos y anotaciones hasta que termine el dibujo',
        'Photo pins and annotation shapes either ignore taps or leave the map until you finish or cancel the ticket shape.': 'Los pines de fotos y las formas de anotación ignoran los toques o salen del mapa hasta que termine o cancele la forma del ticket.',
        'Application Settings': 'Configuración de la aplicación',
        'Keep annotating': 'Seguir anotando',
        'Draw on the map to add more annotations with the same style. Click Stop when finished.': 'Dibuje en el mapa para añadir más anotaciones con el mismo estilo. Pulse Detener al terminar.',
        'Display helpful tooltips on hover': 'Mostrar ayudas al pasar el cursor',
        'Enable map animations': 'Activar animaciones del mapa',
        'Show measure display': 'Mostrar medición',
        'Display measurement information on the map': 'Mostrar información de medición en el mapa',
        'Export Options': 'Opciones de exportación',
        'Export Format': 'Formato de exportación',
        'Advanced Settings': 'Configuración avanzada',
        'File output': 'Salida de archivos',
        'Single file': 'Archivo único',
        'Individual files': 'Archivos individuales',
        'Reproject to EPSG': 'Reproyectar a EPSG',
        'Target EPSG': 'EPSG de destino',
        'Export': 'Exportar',
        'Invalid EPSG code. Please enter a valid code like EPSG:3857.': 'Código EPSG no válido. Ingrese un código válido como EPSG:3857.',
        'Reprojection helper not loaded. Please refresh the page.': 'El asistente de reproyección no está cargado. Actualice la página.',
        'SHP library not loaded. Please refresh the page.': 'La biblioteca SHP no está cargada. Actualice la página.',
        'ZIP library not loaded. Please refresh the page.': 'La biblioteca ZIP no está cargada. Actualice la página.',
        'No exportable features found.': 'No se encontraron elementos exportables.',
        'No exportable data found.': 'No se encontraron datos exportables.',
        'No annotations selected.': 'No hay anotaciones seleccionadas.',
        'No data layers selected.': 'No hay capas de datos seleccionadas.',
        'No items selected.': 'No hay elementos seleccionados.',
        'Export is only available for annotations and data layers.': 'La exportación solo está disponible para anotaciones y capas de datos.',
        'Export is only available for annotations, data layers, and photos.': 'La exportación solo está disponible para anotaciones, capas de datos y fotos.',
        'Export Photos': 'Exportar fotos',
        'Layout': 'Disposición',
        'All photos in one folder': 'Todas las fotos en una carpeta',
        'Group by upload batch': 'Agrupar por lote de carga',
        'Stamp date and GPS on photos': 'Marcar fecha y GPS en las fotos',
        'Stamp date and GPS on exported photos': 'Marcar fecha y GPS en las fotos exportadas',
        'Stamp position': 'Posición de la marca',
        'At the top': 'Arriba',
        'At the bottom': 'Abajo',
        'In the bottom left corner': 'En la esquina inferior izquierda',
        'In the bottom right corner': 'En la esquina inferior derecha',
        'At the bottom, not covering the photo': 'Abajo, sin cubrir la foto',
        'Location metadata': 'Metadatos de ubicación',
        'Processing export': 'Procesando exportación',
        'Downloading images… {current} of {total}': 'Descargando imágenes… {current} de {total}',
        'Creating ZIP file… {percent}%': 'Creando archivo ZIP… {percent}%',
        'Preparing export… {current} of {total}': 'Preparando exportación… {current} de {total}',
        'No photos selected.': 'No hay fotos seleccionadas.',
        'You can export up to {max} photos at a time. You selected {count}.\n\nPlease select fewer photos and try again.': 'Puede exportar hasta {max} fotos a la vez. Seleccionó {count}.\n\nSeleccione menos fotos e inténtelo de nuevo.',
        'No photos could be exported.': 'No se pudieron exportar fotos.',
        'Photo export helpers not loaded. Please refresh the page.': 'Los asistentes de exportación de fotos no están cargados. Actualice la página.',
        'Exported {ok} of {total} photos; {failed} failed.': 'Se exportaron {ok} de {total} fotos; {failed} fallaron.',
        'Photos exported; no GPS locations to include in metadata file.': 'Fotos exportadas; no hay ubicaciones GPS para incluir en el archivo de metadatos.',
        'Error creating export file. Please try again.': 'Error al crear el archivo de exportación. Inténtelo de nuevo.',
        'Export file size ({sizeMB} MB) exceeds the 25 MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.': 'El tamaño del archivo de exportación ({sizeMB} MB) supera el límite de 25 MB.\n\nSeleccione menos elementos o contáctenos para obtener ayuda con exportaciones más grandes.',
        'Export file size ({sizeMB} MB) exceeds the {limitMB} MB limit.\n\nPlease select fewer items or contact us for assistance with larger exports.': 'El tamaño del archivo de exportación ({sizeMB} MB) supera el límite de {limitMB} MB.\n\nSeleccione menos elementos o contáctenos para obtener ayuda con exportaciones más grandes.',
        'User Management': 'Administración de usuarios',
        'Manage users and permissions': 'Administrar usuarios y permisos',
        'Open User Management': 'Abrir administración de usuarios',
        'Toggle layers': 'Alternar capas',
        'Open Data Hub': 'Abrir Centro de datos',
        'Mapbox Hybrid': 'Híbrido Mapbox',
        'Overlays': 'Capas superpuestas',
        'Clear Layers': 'Limpiar capas',
        'Clear all overlay layers': 'Limpiar todas las capas superpuestas',
        'Save as Data Layer': 'Guardar como capa de datos',
        'Save current annotations as a data layer': 'Guardar las anotaciones actuales como capa de datos',
        'Unnamed Layer': 'Capa sin nombre',
        'Photos': 'Fotos',
        'Photos in Ticket Area': 'Fotos en el área del ticket',
        'Requirement met for this revision': 'Requisito cumplido para esta revisión',
        'Override': 'Anular',
        'Remove Override': 'Quitar anulación',
        'Override photo requirement': 'Anular requisito de fotos',
        'Remove photo override': 'Quitar anulación de fotos',
        'Ticket details': 'Información del ticket',
        'Select a ticket from the table to see full details.': 'Seleccione un ticket de la tabla para ver todos los detalles.',
        'No tickets match your filters.': 'Ningún ticket coincide con sus filtros.',
        'Clear selection': 'Limpiar selección',
        'Renew selected': 'Renovar seleccionados',
        'Remark selected': 'Comentario seleccionados',
        'Ticket Actions': 'Acciones del ticket',
        'Remark': 'Comentario',
        'Amendment': 'Enmienda',
        'New ticket': 'Nuevo ticket',
        'Follow Up': 'Seguimiento',
        'Dispute': 'Disputa',
        'Report Event': 'Reportar evento',
        'Request site capture': 'Solicitar captura del sitio',
        'Resize ticket list and details': 'Cambiar tamaño de lista y detalles de tickets',
        'Station Code': 'Código de estación',
        'Station Code Name': 'Nombre del código de estación',
        'Response Date': 'Fecha de respuesta',
        'Response Code': 'Código de respuesta',
        'Comments': 'Comentarios',
        'No operator responses available': 'No hay respuestas de operadores disponibles',
        'Ticket details and utility responses are not loaded in Locus for this import. Open USAN POSR to view them.':
            'Los detalles del ticket y las respuestas de las utilidades no se cargan en Locus para esta importación. Abra USAN POSR para verlos.',
        'Open USAN POSR': 'Abrir USAN POSR',
        'Operator responses': 'Respuestas de operadores',
        'Operator response': 'Respuesta del operador',
        'Operator response details': 'Detalles de respuesta del operador',
        'Operator directory': 'Directorio de operadores',
        'Response and directory': 'Respuesta y directorio',
        'Open': 'Abrir',
        'Open USAN': 'Abrir USAN',
        'Override to Ready': 'Anular a listo',
        'Remove override': 'Eliminar anulación',
        'Status': 'Estado',
        'Ticket': 'Ticket',
        'Ticket #': 'Ticket #',
        'Assignees': 'Personas asignadas',
        'Address': 'Dirección',
        'Map': 'Mapa',
        'Organization:': 'Organización:',
        'Job name:': 'Nombre del trabajo:',
        'Assigned to:': 'Asignado a:',
        'Reported Events': 'Eventos reportados',
        'Address:': 'Dirección:',
        'Job Start:': 'Inicio del trabajo:',
        'Work Expires:': 'Trabajo vence:',
        'Type of Work:': 'Tipo de trabajo:',
        'Work Activity:': 'Actividad de trabajo:',
        'Excavation Method:': 'Método de excavación:',
        'Created By:': 'Creado por:',
        'Profile saved successfully!': 'Perfil guardado correctamente.',
        'Password changed successfully!': 'Contraseña cambiada correctamente.',
        'Admin Panel - Organization & User Management': 'Panel de administración - Organización y usuarios',
        'Back to Map': 'Volver al mapa',
        'Users': 'Usuarios',
        'Role': 'Rol',
        'Actions': 'Acciones',
        'Edit User': 'Editar usuario',
        'Create User': 'Crear usuario',
        'Username': 'Nombre de usuario',
        'Username (optional)': 'Nombre de usuario (opcional)',
        'If not provided, username will be auto-generated from email': 'Si no se proporciona, el nombre de usuario se generará automáticamente desde el correo electrónico',
        'Email *': 'Correo electrónico *',
        'Password *': 'Contraseña *',
        'Role *': 'Rol *',
        'Create': 'Crear',
        'Full Name': 'Nombre completo',
        'New Password (leave blank to keep current)': 'Nueva contraseña (dejar en blanco para mantener la actual)',
        'Select organization to add...': 'Seleccione una organización para agregar...',
        'Add': 'Agregar',
        'None': 'Ninguna',
        'The organization this user will see by default': 'La organización que este usuario verá de forma predeterminada',
        'User updated successfully': 'Usuario actualizado correctamente',
        'User added to organization successfully': 'Usuario agregado a la organización correctamente',
        'User removed from organization successfully': 'Usuario quitado de la organización correctamente',
        'No Organizations': 'Sin organizaciones'
    };

    const en = {};
    Object.keys(es).forEach(function (key) {
        en[es[key]] = key;
    });

    function normalizeLanguage(value) {
        return value === 'es' ? 'es' : 'en';
    }

    function readStoredLanguage() {
        try {
            const userRaw = localStorage.getItem('currentUser');
            if (userRaw) {
                const user = JSON.parse(userRaw);
                if (user && user.preferredLanguage) return normalizeLanguage(user.preferredLanguage);
                if (user && user.preferred_language) return normalizeLanguage(user.preferred_language);
            }
        } catch (e) {
            /* ignore */
        }
        try {
            return normalizeLanguage(localStorage.getItem(STORAGE_KEY));
        } catch (e) {
            return 'en';
        }
    }

    let currentLanguage = readStoredLanguage();
    let observer = null;
    let localizing = false;

    function t(key, vars) {
        const source = String(key == null ? '' : key);
        const table = currentLanguage === 'es' ? es : {};
        let value = table[source] || source;
        if (vars && typeof vars === 'object') {
            Object.keys(vars).forEach(function (name) {
                value = value.replace(new RegExp('\\{' + name + '\\}', 'g'), String(vars[name]));
            });
        }
        return value;
    }

    function translateExact(value) {
        const text = String(value == null ? '' : value);
        const trimmed = text.trim();
        const table = currentLanguage === 'es' ? es : en;
        if (!trimmed || !table[trimmed]) return value;
        return text.replace(trimmed, table[trimmed]);
    }

    function shouldSkipElement(el) {
        if (!el || el.nodeType !== 1) return true;
        const tag = el.tagName;
        return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'PATH' || tag === 'CODE' || el.isContentEditable;
    }

    function localizeElement(el) {
        if (shouldSkipElement(el)) return;
        ['title', 'aria-label', 'placeholder'].forEach(function (attr) {
            if (!el.hasAttribute || !el.hasAttribute(attr)) return;
            const current = el.getAttribute(attr);
            const translated = translateExact(current);
            if (translated !== current) el.setAttribute(attr, translated);
        });
        if (el.dataset && el.dataset.i18n) {
            el.textContent = t(el.dataset.i18n);
        }
    }

    function localizeTree(root) {
        if (localizing || !root) return;
        localizing = true;
        try {
            if (root.nodeType === 1) localizeElement(root);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (node.nodeType === 1) {
                        return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                    }
                    const parent = node.parentElement;
                    if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
                    return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            });
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeType === 1) {
                    localizeElement(node);
                } else if (node.nodeType === 3) {
                    const translated = translateExact(node.nodeValue);
                    if (translated !== node.nodeValue) node.nodeValue = translated;
                }
            }
            document.documentElement.lang = currentLanguage;
            if (document.title) document.title = t(document.title);
            if (currentLanguage === 'en' && en[document.title]) document.title = en[document.title];
        } finally {
            localizing = false;
        }
    }

    function startObserver() {
        if (observer || !document.body) return;
        observer = new MutationObserver(function (mutations) {
            if (currentLanguage === 'en' || localizing) return;
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1 || node.nodeType === 3) {
                        localizeTree(node.nodeType === 3 ? node.parentElement : node);
                    }
                });
                if (mutation.type === 'attributes' && mutation.target) {
                    localizeElement(mutation.target);
                }
            });
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['title', 'aria-label', 'placeholder']
        });
    }

    function setLanguage(language) {
        currentLanguage = normalizeLanguage(language);
        try {
            localStorage.setItem(STORAGE_KEY, currentLanguage);
        } catch (e) {
            /* ignore */
        }
        document.documentElement.lang = currentLanguage;
        localizeTree(document.body || document.documentElement);
        startObserver();
    }

    function getLanguage() {
        return currentLanguage;
    }

    document.addEventListener('DOMContentLoaded', function () {
        setLanguage(readStoredLanguage());
        startObserver();
    });

    window.appI18n = {
        t,
        localizeTree,
        setLanguage,
        getLanguage,
        normalizeLanguage,
        supportedLanguages: SUPPORTED_LANGUAGES.slice()
    };
    window.t = t;
})();
