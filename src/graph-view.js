import { GRAPH_ZONES, graphZone, primaryNodes, visibleEdges, incidentRelations, sourceTarget } from './graph-model.js';
import { buildGraphScene } from './graph-layout.js';
import { createGraphCanvas } from './graph-canvas.js';

const kindNames = { change: 'HDU', document: 'Documento', capability: 'Capacidad', component: 'Componente', area: 'Área', requirement: 'Requisito', task: 'Tarea', decision: 'Decisión', heading: 'Sección', inventory: 'Inventario', resource: 'Recurso', external: 'Referencia externa' };
const originNames = { structural: 'Estructura', explicit: 'Enlace explícito', inferred: 'Inferido' };
const relationNames = { contains: 'Contiene', references: 'Cita', 'references-document': 'Cita documento', 'defines-capability': 'Define capacidad', 'delta-for': 'Delta de capacidad', 'changes-capability': 'Cambia capacidad', declares: 'Declara', 'serves-area': 'Área', 'mentions-component': 'Menciona componente', 'consults-component': 'Consulta componente', 'affects-component': 'Afecta componente', supersedes: 'Sustituye', 'superseded-by': 'Sustituida por' };
const statusNames = { resolved: 'Resuelta', missing: 'Destino ausente', unindexed: 'Destino sin indexar', external: 'Referencia externa', blocked: 'Destino restringido', 'missing-anchor': 'Sección ausente' };
const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
function control(label, action, key, className = 'btn btn-secondary btn-bar') {
  const button = node('button', className, label); button.type = 'button'; button.addEventListener('click', action);
  if (key) button.dataset.graphKey = key;
  return button;
}
const zoneName = id => GRAPH_ZONES.find(([key]) => key === id)?.[1] || id;
const zonePaths = { changes: 'openspec/changes/', specs: 'openspec/specs/ · deltas', inventory: 'repositorios.json', archive: 'openspec/changes/archive/', template: 'Raíz del S0', tools: '.claude/ · .agents/', context: 'docs/' };
const zoneDescriptions = { changes: 'Las HDU reúnen propuestas, specs, diseño, tareas y decisiones. Explora sus fuentes y conexiones.', specs: 'Capacidades propuestas y specs existentes, con sus requisitos y fuentes.', inventory: 'Componentes del inventario y las áreas que declaran atender.', archive: 'Cambios históricos incluidos expresamente en el índice.', template: 'Instrucciones y configuración compartidas por el S0.', tools: 'Skills y comandos disponibles en las fuentes del proyecto.', context: 'Documentos del sistema y su contexto previo a las HDU.' };

export function createGraphView(index, options) {
  const state = options.state;
  state.level ||= 'map'; state.zonePage ||= 0; state.neighbourPage ||= 0;
  const byId = new Map(index.nodes.map(item => [item.id, item]));
  if (state.focus && !byId.has(state.focus)) { state.level = 'map'; state.focus = null; state.camera = null; }
  if (state.selected && !byId.has(state.selected)) state.selected = null;
  const root = node('section', 'graph-view'); root.setAttribute('aria-label', 'Grafo del S0');
  const header = node('header', 'graph-header'), body = node('div', 'graph-body'), exploration = node('div', 'graph-exploration');
  const intro = node('div', 'graph-intro'), stats = node('div', 'graph-stats'), back = node('div', 'graph-back');
  const toolbar = node('div', 'graph-toolbar'), help = node('p', 'graph-help'); toolbar.setAttribute('aria-label', 'Filtros del grafo');
  const listPanel = node('details', 'graph-list-panel'), coverage = node('details', 'graph-coverage');
  const pagination = node('div', 'graph-pagination'), legend = node('div', 'graph-shape-legend'); legend.hidden = true;
  const evidencePages = new Map();
  const stack = (Array.isArray(state.history) ? state.history : []).filter(item => item && (
    item.level === 'map' || item.level === 'zone' && GRAPH_ZONES.some(([id]) => id === item.zone)
    || item.level === 'local' && byId.has(item.focus)));
  state.history = stack;
  let scene, disposed = false, resizeFrame = 0, lastSize = '', detailId = null, pointerSelection = null;
  const change = next => { Object.assign(state, next); options.onState(); render(); };
  const navigate = next => {
    const sameLocation = state.level === next.level && (next.level === 'map'
      || next.level === 'zone' && state.zone === next.zone
      || next.level === 'local' && state.focus === next.focus);
    if (!sameLocation) stack.push({ level: state.level, zone: state.zone, focus: state.focus, selected: state.selected, zonePage: state.zonePage, neighbourPage: state.neighbourPage });
    Object.assign(state, next, { relationPage: 0 }); options.onState(); render({ resetCamera: !sameLocation });
  };
  const select = id => change({ selected: id, relationPage: 0 });
  const local = id => navigate({ level: 'local', focus: id, selected: id, neighbourPage: 0 });
  const map = () => navigate({ level: 'map', selected: null, focus: null });
  const zone = id => navigate({ level: 'zone', zone: id, selected: null, focus: null, zonePage: 0 });
  const previous = () => {
    const prior = stack.pop();
    Object.assign(state, prior || { level: 'map', selected: null, focus: null }); options.onState(); render({ resetCamera: true });
  };
  function pick(item, neighbourhood = false) {
    if (!item) { select(null); return; }
    if (item.kind === 'hub') map();
    else if (item.kind === 'zone' || item.kind === 'group') {
      if (item.targetFocus) local(item.targetFocus); else if (item.targetZone || item.zone) zone(item.targetZone || item.zone);
    } else if (neighbourhood) local(item.id); else select(item.id);
  }
  const graphic = createGraphCanvas({ onSelect: (item, event) => {
    if (item && byId.has(item.id) && event?.detail === 1) pointerSelection = { id: item.id, x: event.clientX, y: event.clientY };
    pick(item);
  }, onActivate: item => pick(item, true), mark: options.mark, camera: state.camera });
  // Opening the sheet can move a glyph between physical clicks. The browser
  // still recognizes click #2 on their common ancestor; retain its first target
  // without delaying the first selection or activating a newly displaced node.
  body.addEventListener('click', event => {
    if (event.detail === 1) { pointerSelection = null; return; }
    if (event.detail !== 2 || !pointerSelection
      || Math.hypot(event.clientX - pointerSelection.x, event.clientY - pointerSelection.y) > 8) return;
    const first = pointerSelection; pointerSelection = null;
    event.preventDefault(); event.stopPropagation(); local(first.id);
  }, true);
  exploration.append(graphic.element, intro, stats, back, help, pagination, toolbar, legend, listPanel, coverage);
  body.append(exploration); root.append(header, body);
  const filterDefinitions = [
    ['structure', 'Estructura', () => state.structure !== false, () => change({ structure: state.structure === false })],
    ['links', 'Enlaces', () => state.links !== false, () => change({ links: state.links === false })],
    ['inferred', 'Inferidas', () => Boolean(state.includeInferred), () => change({ includeInferred: !state.includeInferred })],
    ['areas', 'Áreas', () => state.areas !== false, () => change({ areas: state.areas === false })],
    ['archive', 'Incluir archivo', () => Boolean(state.includeArchive), () => {
      state.restoreFocus = 'filter:archive'; options.onArchive(!state.includeArchive);
    }],
  ];
  const filterButtons = new Map();
  for (const [key, label, active, action] of filterDefinitions) {
    const button = control(label, action, `filter:${key}`, `graph-filter graph-filter-${key}`);
    if (key !== 'archive') {
      const sample = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), line = document.createElementNS(sample.namespaceURI, 'line');
      sample.setAttribute('viewBox', '0 0 18 6'); sample.setAttribute('aria-hidden', 'true');
      for (const [name, value] of Object.entries({ x1: 1, y1: 3, x2: 17, y2: 3, 'stroke-width': key === 'structure' ? 2 : 1.2, 'stroke-dasharray': key === 'inferred' ? '3 3' : key === 'areas' ? '1 3' : 'none' })) line.setAttribute(name, value);
      sample.append(line); button.prepend(sample);
    }
    button.setAttribute('aria-pressed', String(active())); filterButtons.set(key, button); toolbar.append(button);
  }
  const shapes = control('Formas', () => { legend.hidden = !legend.hidden; shapes.setAttribute('aria-expanded', String(!legend.hidden)); }, 'shapes', 'graph-tool'); shapes.setAttribute('aria-expanded', 'false');
  const zoomLabel = node('span', 'graph-zoom-value', '100 %'); zoomLabel.setAttribute('aria-live', 'polite');
  const zoomOut = control('−', () => graphic.zoomBy(-.2), 'zoom-out', 'graph-tool'); zoomOut.setAttribute('aria-label', 'Reducir zoom');
  const zoomIn = control('+', () => graphic.zoomBy(.2), 'zoom-in', 'graph-tool'); zoomIn.setAttribute('aria-label', 'Ampliar zoom');
  toolbar.append(shapes, zoomOut, zoomLabel, zoomIn, control('Encuadrar', () => graphic.reset(), 'zoom-reset', 'graph-tool'));
  graphic.element.addEventListener('graphcamera', event => {
    zoomLabel.textContent = `${Math.round(event.detail.zoom * 100)} %`;
    state.camera = { ...event.detail }; options.onState();
  });
  legend.append(node('strong', '', 'Formas del grafo'));
  for (const [glyph, label] of [['◇', 'HDU y decisión'], ['●', 'Documento · tamaño por backlinks'], ['□', 'Capacidad o requisito'], ['▢', 'Tarea'], ['○', 'Componente'], ['△', 'Skill o comando'], ['⬡', 'Configuración'], ['·', 'Área']]) legend.append(node('p', '', `${glyph}  ${label}`));
  legend.append(node('p', 'graph-note', 'Trazo discontinuo: capacidad propuesta o relación inferida, según la forma.'));

  function renderHeader() {
    const crumbs = node('div', 'graph-crumbs');
    crumbs.append(node('span', '', options.rootName || 'S0'), node('span', 'graph-crumb-separator', '›'), control('Mapa del S0', map, 'map', 'graph-breadcrumb'));
    if (state.level !== 'map') {
      const id = state.level === 'zone' ? state.zone : graphZone(byId.get(state.focus));
      const knownZone = GRAPH_ZONES.some(([key]) => key === id);
      crumbs.append(node('span', 'graph-crumb-separator', '›'), knownZone
        ? control(zoneName(id), () => zone(id), 'crumb-zone', 'graph-breadcrumb')
        : node('span', '', id === 'resources' ? 'Recursos citados' : 'Relaciones'));
    }
    if (state.level === 'local') crumbs.append(node('span', 'graph-crumb-separator', '›'), node('span', 'mono', byId.get(state.focus)?.label || ''));
    const readAt = node('span', 'graph-read-at', 'Índice derivado del árbol de trabajo');
    readAt.prepend(node('span', 'dot dot-ok')); header.replaceChildren(crumbs, readAt);
    back.replaceChildren();
    if (state.level !== 'map') back.append(control('‹ Volver', previous, 'back', 'graph-back-button'));
    if (state.level === 'zone') {
      const current = GRAPH_ZONES.findIndex(([id]) => id === state.zone), navigation = node('div', 'graph-zone-nav');
      const prev = control('‹', () => zone(GRAPH_ZONES[(current + 6) % 7][0]), 'zone-previous', 'graph-tool'); prev.setAttribute('aria-label', 'Zona anterior');
      const next = control('›', () => zone(GRAPH_ZONES[(current + 1) % 7][0]), 'zone-next', 'graph-tool'); next.setAttribute('aria-label', 'Zona siguiente');
      navigation.append(prev, next); back.append(navigation);
    }
    const title = state.level === 'map' ? 'Cómo se relaciona el S0' : state.level === 'zone' ? zoneName(state.zone) : 'Vecindario documental';
    intro.replaceChildren(node('span', 'overline', state.level === 'map' ? 'Grafo del S0 · vista derivada' : state.level === 'zone' ? `Zona · ${zonePaths[state.zone]}` : 'Fuentes y relaciones'));
    if (state.level !== 'local') intro.append(node('h1', 'graph-title', title), node('p', 'graph-description', state.level === 'map' ? 'Cada zona organiza sus documentos y cada conexión conserva su fuente. Explora una zona o selecciona una entrada.' : zoneDescriptions[state.zone]));
    else { const h1 = node('h1', 'sr-only', title); intro.append(h1); }
    help.textContent = 'Pasa por una entrada para ver sus conexiones. Clic: ficha · Doble clic: vecindario · Arrastra: desplazar · Esc: volver';
  }
  function renderCoverage() {
    const wasOpen = coverage.open, statuses = Object.entries(index.coverage || {});
    coverage.replaceChildren(node('summary', '', `${statuses.some(([, value]) => value.status === 'partial') ? 'Lectura parcial' : 'Cobertura del índice'} · ${index.nodes.length} nodos`));
    for (const [scope, value] of statuses) coverage.append(node('p', '', `${zoneName(scope)}: ${value.status === 'complete' ? 'leído' : value.status === 'excluded' ? 'excluido' : 'parcial'} · ${value.read ?? value.files ?? 0} archivos${value.reasons?.length ? ` · ${value.reasons.join('; ')}` : ''}`));
    const diagnostics = index.diagnostics || [], page = Math.max(0, state.diagnosticPage || 0);
    for (const diagnostic of diagnostics.slice(page * 100, (page + 1) * 100)) coverage.append(node('p', 'graph-diagnostic', `${diagnostic.path ? `${diagnostic.path}: ` : ''}${diagnostic.message}`));
    if (diagnostics.length > 100) {
      coverage.append(node('p', '', `Diagnósticos ${page * 100 + 1}–${Math.min((page + 1) * 100, diagnostics.length)} de ${diagnostics.length}`));
      if (page) coverage.append(control('Diagnósticos anteriores', () => change({ diagnosticPage: page - 1 }), 'diagnostics-previous'));
      if ((page + 1) * 100 < diagnostics.length) coverage.append(control('Más diagnósticos', () => change({ diagnosticPage: page + 1 }), 'diagnostics-next'));
    }
    coverage.open = wasOpen;
  }
  function renderList() {
    const wasOpen = listPanel.open, list = node('ul', 'graph-equivalent-list');
    if (state.level === 'map') {
      for (const [id, label] of GRAPH_ZONES) { const li = node('li'); li.append(control(`${label} · ${primaryNodes(index, id).length}`, () => zone(id), `list-zone:${id}`, 'graph-list-entry')); list.append(li); }
    } else for (const item of scene.list) {
      const li = node('li'), entry = control(item.label, () => select(item.id), `list:${item.id}`, 'graph-list-entry');
      entry.append(node('span', 'graph-list-kind', kindNames[item.kind] || item.kind)); li.append(entry); list.append(li);
    }
    listPanel.replaceChildren(node('summary', '', 'Lista accesible'), list);
    if (scene.notice) listPanel.append(node('p', 'graph-note', scene.notice));
    if (!list.children.length) listPanel.append(node('p', 'graph-note', state.zone === 'archive' && !state.includeArchive ? 'El archivo está excluido. Activa Incluir archivo para consultarlo.' : 'Sin entradas en el alcance leído.'));
    listPanel.open = wasOpen;
  }
  function renderScene({ resetCamera = false } = {}) {
    if (disposed || !root.isConnected) return;
    const width = graphic.element.clientWidth, height = graphic.element.clientHeight;
    if (!width || !height) return;
    scene = buildGraphScene(index, state, width, height); scene.level = state.level;
    for (const item of scene.nodes) if (item.kind === 'hub') { item.label = options.rootName || item.label; item.displayLabel = options.rootName || item.label; item.subtitle = 'S0'; }
    graphic.update(scene, { selected: state.selected, resetCamera });
    stats.replaceChildren();
    for (const [label, count] of [['Entradas', scene.stats.entries], ['Relaciones', scene.stats.relations], ['Inferidas', scene.stats.inferred]]) { const item = node('div'); item.append(node('strong', '', String(count)), node('span', '', label)); stats.append(item); }
    pagination.replaceChildren();
    const page = scene.pagination;
    if (page && page.pages > 1) {
      const prev = control('Página anterior', () => change({ [page.key]: page.page - 1 }), 'previous'); prev.disabled = page.page === 0;
      const next = control('Página siguiente', () => change({ [page.key]: page.page + 1 }), 'next'); next.disabled = page.page + 1 >= page.pages;
      pagination.append(prev, node('span', '', `${page.page + 1} / ${page.pages} · ${page.count} entradas`), next);
    }
    if (scene.notice) pagination.append(node('span', 'graph-limit-note', scene.notice));
    renderList(); lastSize = `${width}|${height}`;
    if (state.restoreFocus) {
      const focusKey = state.restoreFocus; delete state.restoreFocus;
      if (document.activeElement === document.body || root.contains(document.activeElement)) {
        root.querySelector(`[data-graph-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
      }
      options.onState();
    }
  }
  function render({ resetCamera = false } = {}) {
    const focusKey = root.contains(document.activeElement) ? document.activeElement?.dataset.graphKey : null;
    root.dataset.level = state.level; body.classList.toggle('has-detail', Boolean(state.selected));
    body.classList.toggle('is-overlay', body.clientWidth < 940);
    renderHeader(); for (const [key, , active] of filterDefinitions) filterButtons.get(key).setAttribute('aria-pressed', String(active()));
    const oldPane = body.querySelector('.graph-details'), scroll = oldPane?.querySelector('.graph-detail-content')?.scrollTop || 0;
    oldPane?.remove();
    if (state.selected && byId.has(state.selected)) {
      const pane = details(byId.get(state.selected));
      // Keep a compact fixed heading and a separately scrollable body.
      const heading = pane.firstElementChild, content = node('div', 'graph-detail-content');
      while (pane.children.length > 1) content.append(pane.children[1]);
      pane.replaceChildren(heading, content); body.append(pane);
      if (detailId === state.selected) content.scrollTop = scroll;
      detailId = state.selected;
    }
    renderCoverage(); renderScene({ resetCamera });
    if (focusKey) (root.querySelector(`[data-graph-key="${CSS.escape(focusKey)}"]`) || root.querySelector('[data-graph-key="map"]'))?.focus({ preventScroll: true });
  }
  const observer = new ResizeObserver(() => {
    if (disposed) return;
    body.classList.toggle('is-overlay', body.clientWidth < 940);
    const size = `${graphic.element.clientWidth}|${graphic.element.clientHeight}`;
    if (size === lastSize) return;
    cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; renderScene(); });
  });
  observer.observe(body); observer.observe(graphic.element);
  root.dispose = () => { disposed = true; observer.disconnect(); cancelAnimationFrame(resizeFrame); graphic.dispose(); };
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation();
    if (!legend.hidden) { legend.hidden = true; shapes.setAttribute('aria-expanded', 'false'); shapes.focus(); }
    else if (state.selected) { change({ selected: null }); root.querySelector('[data-graph-key="map"]')?.focus({ preventScroll: true }); }
    else if (listPanel.open || coverage.open) { listPanel.open = false; coverage.open = false; root.querySelector('[data-graph-key="map"]')?.focus(); }
    else previous();
  });
  render();
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; renderScene(); });

  function sourceActions(item) {
    const box = node('div', 'graph-source-actions'), target = sourceTarget(item);
    if (!target) return box;
    box.append(control(`Abrir ${target.path.split('/').at(-1)}`, () => options.onSource(target), `source:${item.id}`));
    if (/\.md$/i.test(target.path)) box.append(control('Abrir en el lector', () => options.onRead(target), `read:${item.id}`));
    return box;
  }

  function details(item) {
    const pane = node('aside', 'graph-details'); pane.setAttribute('aria-label', 'Ficha del documento');
    const top = node('div', 'graph-detail-heading'); top.append(node('span', 'overline', kindNames[item.kind] || item.kind), control('Cerrar ficha', () => change({ selected: null }), 'close-detail'));
    pane.append(top, node('h2', 'graph-detail-title', item.label), node('p', 'mono graph-path', item.path || 'Entrada derivada del inventario'));
    if (item.state) pane.append(node('p', 'graph-note', item.state === 'proposed' ? 'Capacidad propuesta · se abre su delta existente.' : item.state === 'superseded' ? 'Decisión sustituida · consulta su registro.' : item.state === 'consolidated' ? 'Spec consolidada existente · presencia no acredita aceptación.' : item.state === 'recorded' ? 'Decisión registrada · registro no equivale a aceptación.' : `Estado documental: ${item.state}`));
    if (item.kind === 'decision') pane.append(node('p', 'graph-note', `Incorporación: ${item.incorporation === 'incorporated' ? 'declarada como incorporada' : 'pendiente'}. Comprobación: ${item.verification === 'verified' ? 'declarada como verificada' : 'pendiente'}. Consulta las evidencias del registro.`));
    if (item.scope === 'archive') pane.append(node('p', 'graph-note', 'La ubicación en el archivo no acredita consolidación, aceptación ni despliegue.'));
    if (item.kind === 'task') pane.append(node('p', 'graph-note', 'Una casilla marcada no acredita pruebas ni aceptación.'));
    const relations = incidentRelations(index, item.id, state).sort((a, b) => `${a.edge.type}|${a.direction}`.localeCompare(`${b.edge.type}|${b.direction}`));
    if (item.kind === 'change') {
      const flow = node('div', 'graph-artifact-flow');
      for (const relation of relations.filter(value => value.direction === 'out' && value.edge.type === 'contains' && value.neighbour?.kind === 'document')) {
        const part = relation.neighbour, file = part.path.split('/').at(-1);
        const label = ({ 'proposal.md': 'Propuesta', 'design.md': 'Diseño', 'tasks.md': 'Tareas', 'revision.md': 'Decisiones', 'spec.md': 'Specs' })[file] || file;
        const button = control(label, () => select(part.id), `artifact:${part.id}`, 'graph-artifact-pill'); button.title = part.path; flow.append(button);
      }
      pane.append(flow);
    }
    const facts = node('dl', 'graph-facts');
    for (const [label, value] of [['Entrantes', relations.filter(value => value.direction === 'in').length], ['Salientes', relations.filter(value => value.direction === 'out').length]]) facts.append(node('dt', '', label), node('dd', '', String(value)));
    pane.append(facts, sourceActions(item), control('Ver vecindario', () => local(item.id), `local:${item.id}`));
    pane.append(node('h3', 'graph-relations-title', `Relaciones · ${relations.length}`));
    if (!relations.length) pane.append(node('p', 'graph-note', 'No se encontraron relaciones en el alcance leído y con los filtros activos. El archivo excluido o una lectura parcial pueden contener más referencias.'));
    const list = node('ul', 'graph-relations');
    const relationPage = Math.max(0, Math.min(state.relationPage || 0, Math.max(0, Math.ceil(relations.length / 100) - 1)));
    for (const { edge, direction, neighbour } of relations.slice(relationPage * 100, (relationPage + 1) * 100)) {
      const row = node('li', 'graph-relation');
      row.append(node('span', 'graph-relation-type', `${direction === 'out' ? 'Saliente →' : 'Entrante ←'} ${relationNames[edge.type] || edge.type}`));
      if (neighbour) row.append(control(neighbour.label, () => select(neighbour.id), `relation:${edge.id}`, 'graph-relation-link'));
      else row.append(node('span', 'graph-unresolved', edge.evidence?.[0]?.href || 'Destino sin resolver'));
      row.append(node('span', 'graph-relation-origin', `${originNames[edge.origin] || edge.origin} · ${statusNames[edge.resolution] || edge.resolution}`));
      const evidence = edge.evidence || [], evidencePage = evidencePages.get(edge.id) || 0;
      for (const [position, source] of evidence.slice(evidencePage * 20, (evidencePage + 1) * 20).entries()) {
        if (!source.path) continue;
        const button = control(`${source.path.split('/').at(-1)}${source.line ? ` · línea ${source.line}` : ''}`, () => options.onSource({ path: source.path, line: source.line }), `evidence:${edge.id}:${evidencePage * 20 + position}`, 'graph-evidence');
        button.title = source.path; button.setAttribute('aria-label', `${source.path}${source.line ? ` · línea ${source.line}` : ''}`); row.append(button);
      }
      if (evidence.length > 20) {
        row.append(node('span', 'graph-note', `Evidencias ${evidencePage * 20 + 1}–${Math.min((evidencePage + 1) * 20, evidence.length)} de ${evidence.length}`));
        if (evidencePage) row.append(control('Evidencias anteriores', () => { evidencePages.set(edge.id, evidencePage - 1); render(); }, `evidence-prev:${edge.id}`));
        if ((evidencePage + 1) * 20 < evidence.length) row.append(control('Más evidencias', () => { evidencePages.set(edge.id, evidencePage + 1); render(); }, `evidence-next:${edge.id}`));
      }
      list.append(row);
    }
    pane.append(list);
    if (relations.length > 100) {
      const pager = node('div', 'graph-pagination');
      const previous = control('Relaciones anteriores', () => change({ relationPage: relationPage - 1 }), 'relations-previous'); previous.disabled = relationPage === 0;
      const next = control('Más relaciones', () => change({ relationPage: relationPage + 1 }), 'relations-next'); next.disabled = (relationPage + 1) * 100 >= relations.length;
      pager.append(previous, node('span', '', `Relaciones ${relationPage * 100 + 1}–${Math.min((relationPage + 1) * 100, relations.length)} de ${relations.length}`), next); pane.append(pager);
    }
    pane.append(node('p', 'graph-note', 'Una relación documental no implica dependencia funcional, aprobación ni despliegue. Inferido significa detectado en el texto, no declarado como enlace.'));
    return pane;
  }

  return root;
}
