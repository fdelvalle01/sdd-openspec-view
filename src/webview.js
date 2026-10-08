import mermaid from 'mermaid';
import { createGraphView } from './graph-view.js';

const vscode = window.acquireVsCodeApi();
const saved = vscode.getState() || {};
const VIEWS = new Set(['home', 'changes', 'change', 'reader', 'context', 'specs', 'archived', 'graph']);
const ARTIFACTS = [['proposal', 'Propuesta', 'P'], ['specs', 'Specs', 'S'], ['design', 'Diseño', 'D'], ['tasks', 'Tareas', 'T']];
const COMPACT_WIDTH = 1040;
const TIGHT_WIDTH = 720;
const text = value => (typeof value === 'string' && value ? value : null);
const state = {
  view: VIEWS.has(saved.view) ? saved.view : 'home',
  selectedChange: text(saved.selectedChange),
  changeTab: text(saved.changeTab) || 'summary',
  selectedPath: text(saved.selectedPath),
  readerOrigin: text(saved.readerOrigin),
  lastRead: text(saved.lastRead),
  tocActive: text(saved.tocActive),
  readSize: [14, 15, 16].includes(saved.readSize) ? saved.readSize : 15,
  surfaceMode: saved.surfaceMode === 'personal' ? 'personal' : 'editor',
  specMode: saved.specMode === 'markdown' ? 'markdown' : 'structured',
  taskFilter: ['pending', 'done'].includes(saved.taskFilter) ? saved.taskFilter : 'all',
  scroll: Number.isFinite(saved.scroll) ? saved.scroll : 0,
  scrollKey: text(saved.scrollKey),
  rootPath: text(saved.rootPath),
  graph: { level: 'map', includeArchive: false, includeInferred: false, ...(saved.graph && typeof saved.graph === 'object' ? saved.graph : {}) },
};
// Presentation-only state: never persisted, reset on navigation.
const ui = { menuOpen: false, tocOpen: false, invalidRoot: null, searchOpen: false, searchQuery: '', searchScope: 'all', glossaryOpen: false, searchResults: [], searchIndex: 0, searchRequest: 0 };
let searchResultsNode;
let searchInput;
let searchTimer;
let snapshot = null;
let knowledgeIndex = null;
let graphRequest = 0;
let graphPending = false;
let graphError = null;
let pendingReveal = null;
let snapshotSignature = '';
let snapshotVersion = 0;
let index = new Map();
const documents = new Map();
const readErrors = new Map();
const transientIndex = new Map();
const pageRequests = new Map();
const changeRequests = new Map();
const loadErrors = new Map();
const retryPages = new Map();
const scrollMemory = new Map(state.scrollKey ? [[state.scrollKey, state.scroll]] : []);
let pendingPath = null;
let scroller = null;
let renderedKey = null;
let renderedSignature = null;
let renderedDocument = null;
let diagramGeneration = 0;
let diagramQueue = Promise.resolve();
let renderSequence = 0;
let saveFrame;
let inputVersion = 0;
let headingObserver = null;
let dialogCleanup = null;


const symbols = {
  mark: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/><path d="M3 9h18"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  archive: '<path d="M4 8h16v13H4V8ZM3 3h18v5H3V3Zm6 9h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  graph: '<circle cx="5" cy="7" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 6.9 16.5 6.1M6.2 9.2l4.6 6.6M17.8 8.2l-4.6 7.6"/>',
};

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function icon(name, className = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.6');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', `icon ${className}`.trim());
  node.innerHTML = symbols[name] || symbols.file;
  return node;
}

function viewerMark(className) {
  return icon('mark', className);
}

function button(label, className, callback, iconName, iconOnly = false) {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  if (!iconOnly) node.append(el('span', 'button-label', label));
  node.setAttribute('aria-label', label);
  node.title = label;
  node.addEventListener('click', callback);
  return node;
}

// Composite buttons keep their visible text as accessible name.
function action(className, callback, key) {
  const node = el('button', className);
  node.type = 'button';
  if (key) node.dataset.key = key;
  node.addEventListener('click', callback);
  return node;
}

function mono(content, className = '') {
  return el('span', `mono ${className}`.trim(), content);
}

function overline(content, className = '') {
  return el('span', `overline ${className}`.trim(), content);
}

function pill(content, className = '') {
  return el('span', `pill ${className}`.trim(), content);
}

function dot(tone) {
  const node = el('span', `dot dot-${tone}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function srText(content) {
  return el('span', 'sr-only', content);
}

function post(type, payload = {}) {
  const rooted = ['page', 'loadChange', 'read', 'search', 'openSource', 'link', 'graph'].includes(type) && snapshot?.rootPath;
  vscode.postMessage({ type, ...(rooted ? { rootPath: snapshot.rootPath } : {}), ...payload });
}

function persist() {
  vscode.setState({ ...state });
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatWhen(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(date);
  const day = candidate => new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `hoy, ${time}`;
  if (days === 1) return `ayer, ${time}`;
  const options = date.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${new Intl.DateTimeFormat('es', options).format(date).replace('.', '')}, ${time}`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/* ---------- Snapshot lookups ---------- */

function findChange(id) {
  return id ? snapshot?.changes.find(change => change.id === id) || null : null;
}

function activeChanges() {
  const ids = snapshot?.pagination?.changes?.ids;
  return snapshot?.changes.filter(change => !change.archived && (!ids || ids.includes(change.id))) || [];
}

function archivedChanges() {
  const ids = snapshot?.pagination?.archive?.ids;
  return snapshot?.changes.filter(change => change.archived && (!ids || ids.includes(change.id))) || [];
}

function buildIndex() {
  index = new Map();
  if (!snapshot) return;
  for (const change of snapshot.changes) for (const item of change.documents) index.set(item.path, { item, owner: change, group: 'change' });
  for (const item of snapshot.specs) index.set(item.path, { item, owner: null, group: 'spec' });
  for (const item of snapshot.docs) index.set(item.path, { item, owner: null, group: 'context' });
  for (const [path, entry] of transientIndex) if (!index.has(path)) index.set(path, { ...entry, owner: findChange(entry.owner?.id) || entry.owner });
}

function artifactPresent(change, kind) {
  const artifact = change.artifacts?.find(item => item.id === kind);
  if (artifact) return artifact.present === true ? true : artifact.present === false ? false : null;
  return change.loadState && change.loadState !== 'loaded' ? null : false;
}

function presentCount(change) {
  return ARTIFACTS.filter(([kind]) => artifactPresent(change, kind)).length;
}

function changeDocument(change, kind) {
  return change.documents.find(item => item.kind === kind) || null;
}

function deltaSpecs(change) {
  return change.documents.filter(item => item.kind === 'specs');
}

function tasksLabel(change, { long = false } = {}) {
  if (artifactPresent(change, 'tasks') === false) return 'Falta';
  if (!change.tasks) return 'Tareas sin lectura';
  if (!change.tasks.total) return 'Sin casillas';
  return `${change.tasks.done} de ${change.tasks.total} casillas${long ? ' marcadas' : ''}`;
}

function scopeItems(scope) {
  return scope === 'changes' ? activeChanges() : scope === 'archive' ? archivedChanges() : scope === 'specs' ? snapshot?.specs || [] : snapshot?.docs || [];
}

function scopeCount(scope) {
  const pagination = snapshot?.pagination?.[scope];
  if (!pagination) return String(scopeItems(scope).length);
  return Number.isInteger(pagination.total) ? String(pagination.total) : `${pagination.loaded} en página ${pagination.page + 1}`;
}

function requestPage(scope, page) {
  if (pageRequests.has(scope) || !Number.isInteger(page) || page < 0) return;
  pageRequests.set(scope, page);
  loadErrors.delete(`page:${scope}`);
  renderMain({ preserveScroll: true });
  post('page', { scope, page, rootPath: snapshot.rootPath });
}

function requestChange(id, page = 0) {
  // The host only publishes the latest selected HU; superseded requests have no reply.
  for (const pending of changeRequests.keys()) if (pending !== id) changeRequests.delete(pending);
  if (changeRequests.has(id)) return;
  changeRequests.set(id, page);
  loadErrors.delete(`change:${id}`);
  post('loadChange', { id, page, rootPath: snapshot.rootPath });
}

function paginationControls(scope, change = null) {
  const pagination = change ? change.documentPagination : snapshot?.pagination?.[scope];
  if (!pagination) return null;
  const key = change ? `change:${change.id}` : `page:${scope}`;
  const pending = change ? changeRequests.has(change.id) : pageRequests.has(scope);
  const error = loadErrors.get(key);
  if (!pending && !error && pagination.status === 'loaded' && pagination.page === 0
    && !pagination.hasMore && !pagination.hasPrevious) return null;
  const label = change ? 'Documentos de la HU' : ({ changes: 'HU en curso', archive: 'Archivo', specs: 'Specs', context: 'Contexto' })[scope];
  const load = page => { if (change) { requestChange(change.id, page); renderMain({ preserveScroll: true }); } else requestPage(scope, page); };
  const bar = el('nav', 'pagination');
  bar.dataset.scope = change ? 'documents' : scope;
  bar.setAttribute('aria-label', `Páginas de ${label}`);
  bar.setAttribute('aria-busy', String(pending));
  const controls = el('div', 'pagination-controls');
  const previous = button('Página anterior', 'btn btn-secondary', () => load(pagination.page - 1), 'back');
  const next = button('Página siguiente', 'btn btn-secondary', () => load(pagination.page + 1), 'arrow');
  previous.dataset.key = `${key}:previous`; next.dataset.key = `${key}:next`;
  previous.disabled = pending || !(pagination.hasPrevious ?? pagination.page > 0);
  next.disabled = pending || !pagination.hasMore;
  const status = el('span', 'pagination-status', pending ? 'Cargando página…' : `Página ${pagination.page + 1} · ${pagination.loaded} ${change ? 'documentos adicionales' : scope === 'changes' || scope === 'archive' ? 'HU' : 'documentos'} en esta página`);
  status.setAttribute('role', 'status');
  controls.append(previous, status, next); bar.append(controls);
  if (change) bar.append(el('span', 'footnote', 'Propuesta, diseño, tareas y revisión permanecen disponibles al cambiar de página.'));
  if (error || pagination.status === 'error' || pagination.status === 'partial') {
    const note = el('div', 'pagination-note');
    note.append(el('span', 'footnote', error || (pagination.status === 'error' ? 'No se pudo completar la lectura de esta sección.' : 'Lectura parcial: algunos datos no se pudieron comprobar. Consulta los avisos.')));
    const retry = button('Reintentar página', 'btn-text', () => load(retryPages.get(key) ?? pagination.page)); retry.disabled = pending;
    note.append(retry); bar.append(note);
  }
  return bar;
}

function appendPagination(container, scope, change = null) {
  const controls = paginationControls(scope, change);
  if (controls) container.append(controls);
}

function rememberDocument(path, metadata = {}) {
  if (index.has(path)) return index.get(path);
  if (typeof path !== 'string' || !/\.md$/i.test(path) || /(^|\/)\.\.(\/|$)|^[/\\]|:/.test(path)) return null;
  const match = path.match(/^openspec\/changes\/((?:archive\/)?[^/]+)\//);
  const id = metadata.changeId || match?.[1] || null;
  const owner = id ? findChange(id) || { id, title: id, archived: id.startsWith('archive/'), artifacts: [], tasks: null, loadState: 'unloaded' } : null;
  const group = owner ? 'change' : metadata.scope === 'specs' || path.startsWith('openspec/specs/') ? 'spec' : 'context';
  const basename = path.split('/').pop();
  const kind = metadata.kind || ({ 'proposal.md': 'proposal', 'design.md': 'design', 'tasks.md': 'tasks' })[basename] || (group === 'spec' ? 'spec' : /\/specs\//.test(path) ? 'specs' : 'other');
  const entry = { item: { ...metadata, path, kind, label: metadata.title || basename, title: metadata.title || basename }, owner, group };
  transientIndex.set(path, entry); index.set(path, entry);
  return entry;
}

function documentName(path) {
  const entry = index.get(path);
  if (!entry) return path.split('/').pop();
  const { item, group } = entry;
  if (group === 'change') {
    if (item.kind === 'specs') return `${item.label} · delta de spec`;
    return ({ proposal: 'Propuesta', design: 'Diseño', tasks: 'Tareas' })[item.kind] || item.label;
  }
  return item.title && item.title !== item.label ? item.title : item.label;
}

function kindLabel(path) {
  const entry = index.get(path);
  if (!entry) return 'Markdown';
  if (entry.group === 'spec') return 'Spec consolidada';
  if (entry.group === 'context') return 'Contexto';
  return ({ proposal: 'Propuesta', design: 'Diseño', tasks: 'Tareas', specs: 'Spec · delta del cambio' })[entry.item.kind] || 'Documento del cambio';
}

function huGuide() {
  return snapshot?.docs.find(item => /(^|\/)(guia|trabajar)[-_]?hu[^/]*\.md$/i.test(item.path)) || null;
}

function deltaText(delta) {
  if (!delta) return '';
  const parts = [];
  const forms = [['added', 'añadido'], ['modified', 'modificado'], ['removed', 'eliminado'], ['renamed', 'renombrado']];
  for (const [key, word] of forms) if (delta[key]) parts.push(`${delta[key]} requisito${delta[key] === 1 ? '' : 's'} ${word}${delta[key] === 1 ? '' : 's'}`);
  if (delta.scenarios) parts.push(plural(delta.scenarios, 'escenario'));
  return parts.join(' · ') || 'Sin requisitos reconocibles';
}

/* ---------- Document requests ---------- */

function tabPath(change, tab) {
  if (!change) return null;
  if (tab.startsWith('doc:')) return change.documents.some(item => item.path === tab.slice(4)) ? tab.slice(4) : null;
  if (['proposal', 'design', 'tasks'].includes(tab)) return changeDocument(change, tab)?.path || null;
  return null;
}

function wantedPath() {
  if (!snapshot?.rootPath || ui.invalidRoot) return null;
  if (state.view === 'reader') return state.selectedPath;
  if (state.view === 'change') return tabPath(findChange(state.selectedChange), state.changeTab);
  return null;
}

function requestDocument(path) {
  if (!path || pendingPath === path) return;
  pendingPath = path;
  post('read', { path });
}

function sameDocument(a, b) {
  return Boolean(a && b) && a.path === b.path && a.html === b.html && a.modifiedAt === b.modifiedAt && a.title === b.title;
}

/* ---------- Shell ---------- */

const app = document.getElementById('app') || document.body.appendChild(el('div'));
app.className = 'app-shell';
app.replaceChildren();

const titlebar = el('header', 'mobile-header');
const mobileName = button('Cambiar S0', 'mobile-root', () => toggleMenu());
titlebar.append(viewerMark('titlebar-mark'), mobileName, pill('S0'), button('Buscar en el S0', 'btn-icon', openSearch, 'search', true), button('Cómo leer este S0', 'btn-icon', openGlossary, 'info', true));
const workspace = el('div', 'workspace');
const explorer = el('aside', 'explorer');
explorer.setAttribute('aria-label', 'Explorar S0');
const brand = el('div', 'explorer-brand');
brand.append(viewerMark('titlebar-mark'), el('strong', '', 'OpenSpec'), pill('Solo lectura'));
const menuAnchor = el('div', 'menu-anchor');
const changeRootButton = action('s0-selector', () => toggleMenu(), 'root-selector');
changeRootButton.setAttribute('aria-label', 'Cambiar S0');
changeRootButton.setAttribute('aria-haspopup', 'menu');
changeRootButton.setAttribute('aria-expanded', 'false');
changeRootButton.setAttribute('aria-controls', 'root-menu');
const rootName = el('strong', 's0-name');
const rootPill = pill('S0');
const rootPath = mono('', 's0-path');
const demoPill = pill('ficticio', 'pill-dashed');
demoPill.hidden = true;
const selectorLine = el('span', 'selector-line');
selectorLine.append(rootName, rootPill, demoPill, icon('arrow', 'selector-arrow'));
changeRootButton.append(selectorLine, rootPath);
menuAnchor.append(changeRootButton);
const rootMenu = el('div', 'menu');
rootMenu.id = 'root-menu';
rootMenu.setAttribute('role', 'menu');
rootMenu.setAttribute('aria-label', 'Cambiar carpeta S0');
rootMenu.hidden = true;
for (const [label, type, iconName] of [['Elegir carpeta S0…', 'chooseRoot', 'folder'], ['Pegar ruta de S0…', 'enterRootPath', 'file'], ['Abrir demo local', 'demo', 'layers']]) {
  const item = button(label, 'menu-item', () => { closeMenu(true); post(type); }, iconName);
  item.setAttribute('role', 'menuitem'); item.tabIndex = -1; rootMenu.append(item);
}
const searchWrap = el('div', 'explorer-search');
const searchBox = button('Buscar en el S0', 'search-field', openSearch, 'search');
searchBox.append(el('kbd', '', /Mac/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'));
searchWrap.append(searchBox);
const explorerList = el('nav', 'explorer-list');
explorerList.setAttribute('aria-label', 'Secciones del S0');
const explorerFooter = el('div', 'explorer-footer');
const statusText = el('span', 'refresh-status', 'Leyendo el proyecto…');
const refreshButton = button('Actualizar archivos', 'btn-icon', () => {
  refreshButton.classList.add('is-refreshing'); refreshButton.disabled = true; post('refresh');
}, 'refresh', true);
const footerStatus = el('div', 'footer-status'); footerStatus.append(statusText, refreshButton);
explorerFooter.append(button('Cómo leer este S0', 'glossary-trigger', openGlossary, 'info'), footerStatus);
explorer.append(brand, menuAnchor, searchWrap, explorerList, explorerFooter);
const rail = el('nav', 'section-bar');
rail.setAttribute('aria-label', 'Secciones');
const railDefinitions = [
  ['home', 'Inicio', 'mark', goHome], ['changes', 'HU', 'layers', () => openView('changes')],
  ['graph', 'Grafo', 'graph', () => openView('graph')],
  ['specs', 'Specs', 'file', () => openView('specs')], ['context', 'Contexto', 'info', () => openView('context')],
  ['archived', 'Archivo', 'archive', () => openView('archived')],
];
const railButtons = new Map();
for (const [id, label, , callback] of railDefinitions) {
  const node = button(label, 'section-button', callback); node.dataset.key = `rail:${id}`;
  railButtons.set(id, node); rail.append(node);
}
const main = el('main', 'main'); main.id = 'main-content';
const alertRegion = el('div', 'alert-region');
const viewRoot = el('div', 'view-root');
main.append(alertRegion, viewRoot); workspace.append(explorer, main);
const announcer = el('div', 'sr-only'); announcer.setAttribute('role', 'status'); announcer.setAttribute('aria-live', 'polite');
const dialogLayer = el('div', 'dialog-layer');
app.append(titlebar, rail, workspace, rootMenu, announcer, dialogLayer);
applySettings({ readingSize: state.readSize, surfaces: state.surfaceMode });

function announce(message) {
  announcer.textContent = message;
}

function applyLayout(width) {
  if (!width) return;
  app.classList.toggle('is-compact', width < COMPACT_WIDTH);
  app.classList.toggle('is-tight', width < TIGHT_WIDTH);
}
applyLayout(app.getBoundingClientRect().width);
// The relevant width is the panel's, so layout classes follow the container instead of media queries.
new ResizeObserver(([entry]) => applyLayout(entry.contentRect.width)).observe(app);

/* ---------- Root menu ---------- */

function menuItems() {
  return [...rootMenu.querySelectorAll('.menu-item')];
}

function toggleMenu() {
  if (ui.menuOpen) closeMenu(true);
  else {
    ui.menuOpen = true;
    rootMenu.hidden = false;
    changeRootButton.setAttribute('aria-expanded', 'true');
    menuItems()[0]?.focus();
  }
}

function closeMenu(returnFocus = false) {
  if (!ui.menuOpen) return;
  ui.menuOpen = false;
  rootMenu.hidden = true;
  changeRootButton.setAttribute('aria-expanded', 'false');
  if (returnFocus) (app.classList.contains('is-tight') ? mobileName : changeRootButton).focus();
}

rootMenu.addEventListener('keydown', event => {
  const items = menuItems();
  const position = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(position + step + items.length) % items.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
  } else if (event.key === 'Tab') closeMenu(false);
});
document.addEventListener('pointerdown', event => {
  if (ui.menuOpen && !menuAnchor.contains(event.target) && !rootMenu.contains(event.target) && !mobileName.contains(event.target)) closeMenu(false);
});

/* ---------- Navigation ---------- */

function viewKey() {
  if (state.view === 'change') return `change|${state.selectedChange}|${state.changeTab}`;
  if (state.view === 'reader') return `reader|${state.selectedPath}`;
  return state.view;
}

function rememberScroll() {
  if (scroller && renderedSignature) scrollMemory.set(viewKey(), scroller.scrollTop);
}

function navigate(next) {
  closeDialog();
  rememberScroll();
  Object.assign(state, next);
  ui.tocOpen = false;
  persist();
  renderChrome();
  renderMain({ navigation: true });
}

function goHome() {
  ui.invalidRoot = null;
  navigate({ view: 'home' });
}

function openView(view) {
  navigate({ view });
}

function openActiveChanges() {
  const current = findChange(state.selectedChange);
  if (current && !current.archived && (state.view === 'change' || state.view === 'reader')) openChange(current.id);
  else openView('changes');
}

function openChange(id, tab) {
  const change = findChange(id);
  if (!id) return;
  const superseded = [...changeRequests.keys()].some(pending => pending !== id);
  for (const pending of changeRequests.keys()) if (pending !== id) changeRequests.delete(pending);
  const keepTab = state.selectedChange === id && !tab;
  if (superseded || snapshot.selectedChangeId !== id || change?.loadState === 'unloaded' || loadErrors.has(`change:${id}`)) requestChange(id);
  navigate({ view: 'change', selectedChange: id, changeTab: keepTab ? state.changeTab : tab || 'summary' });
  announce(`HU abierta: ${change?.title || id}`);
}

function currentOrigin() {
  if (state.view === 'change') return state.selectedChange;
  if (state.view === 'reader') return state.readerOrigin;
  return null;
}

function openDocument(path, { origin, metadata, anchor, line } = {}) {
  const entry = index.get(path) || rememberDocument(path, metadata);
  if (!entry) return;
  const readerOrigin = origin !== undefined ? origin : entry.owner ? entry.owner.id : currentOrigin();
  pendingReveal = anchor || line ? { path, anchor, line } : null;
  if (pendingReveal) state.specMode = 'markdown';
  navigate({ view: 'reader', selectedPath: path, readerOrigin, selectedChange: readerOrigin || state.selectedChange });
}

function setChangeTab(tab) {
  if (state.changeTab === tab) return;
  navigate({ changeTab: tab });
}

/* ---------- Chrome rendering ---------- */

function preserveFocus(container, update) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.key : null;
  update();
  if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function renderChrome() {
  renderTitlebar();
  renderExplorer();
  renderRail();
  renderStatus();
}

function renderTitlebar() {
  const hasRoot = Boolean(snapshot?.rootPath);
  rootName.textContent = hasRoot ? snapshot.rootName : snapshot?.loading || !snapshot ? 'Leyendo…' : 'Elegir S0';
  rootPill.hidden = !hasRoot; rootPath.hidden = !hasRoot;
  rootPath.textContent = hasRoot ? snapshot.rootPath : '';
  changeRootButton.title = hasRoot ? snapshot.rootPath : 'Cambiar carpeta S0';
  mobileName.querySelector('.button-label').textContent = hasRoot ? snapshot.rootName : 'Elegir S0';
  demoPill.hidden = !snapshot?.demo;
}

function navItem({ key, label, iconName, count, active, onClick, className = '' }) {
  const node = action(`nav-item ${className}${active ? ' is-active' : ''}`.trim(), onClick, key);
  if (active) node.setAttribute('aria-current', 'page');
  node.append(el('span', 'nav-rail'));
  if (iconName) {
    const graphic = iconName === 'mark' ? viewerMark('titlebar-mark') : icon(iconName);
    // The visible label names the action; the brand is decorative inside a button.
    graphic.setAttribute('aria-hidden', 'true');
    node.append(graphic);
  }
  node.append(el('span', 'nav-label', label));
  if (count !== undefined) node.append(mono(count, 'nav-count'));
  return node;
}

function groupHeading(label, count) {
  const node = el('div', 'nav-group');
  node.append(el('span', 'nav-group-label', label));
  if (count !== undefined) node.append(mono(count, 'nav-count'));
  return node;
}

function matches(values, query) {
  return values.join(' ').toLocaleLowerCase().includes(query);
}

function changeMatches(change, query) {
  return matches([change.id, change.title, ...change.documents.map(item => `${item.label} ${item.path}`)], query);
}

function isChangeActive(change) {
  return (state.view === 'change' && state.selectedChange === change.id) || (state.view === 'reader' && state.readerOrigin === change.id);
}

function readerGroup() {
  return state.view === 'reader' && !state.readerOrigin ? index.get(state.selectedPath)?.group : null;
}

function renderExplorer() {
  searchWrap.hidden = !snapshot?.rootPath;
  preserveFocus(explorerList, () => {
    const nodes = [navItem({ key: 'nav:home', label: 'Inicio del S0', iconName: 'mark', active: state.view === 'home' && !ui.invalidRoot, onClick: goHome })];
    if (!snapshot || snapshot.loading) nodes.push(el('p', 'explorer-note', 'Leyendo la carpeta…'));
    else if (!snapshot.rootPath) nodes.push(el('p', 'explorer-note', 'Elige una carpeta S0 para ver sus cambios y documentos.'));
    else {
      nodes.push(navItem({ key: 'nav:graph', label: 'Grafo del S0', iconName: 'graph', active: state.view === 'graph', onClick: () => openView('graph') }));
      nodes.push(groupHeading('HU en curso', scopeCount('changes')));
      if (!activeChanges().length) nodes.push(el('p', 'explorer-note', snapshot.pagination?.changes?.status === 'error' ? 'No se pudo leer la lista de HU.' : 'Sin HU en esta página.'));
      for (const change of activeChanges()) {
        const selected = isChangeActive(change);
        const node = action(`nav-item nav-change${selected ? ' is-active' : ''}`, () => openChange(change.id), `nav:change:${change.id}`);
        if (selected) node.setAttribute('aria-current', 'page');
        node.title = change.id;
        node.append(el('span', 'nav-rail'), el('span', 'nav-change-title', change.title || change.id), mono(change.id, 'nav-change-id'));
        if (artifactPresent(change, 'tasks') && change.tasks) node.append(el('span', 'nav-change-tasks', `Tareas ${change.tasks.done}/${change.tasks.total}`));
        else if (artifactPresent(change, 'tasks') === null || !change.tasks && artifactPresent(change, 'tasks')) node.append(el('span', 'nav-change-tasks', 'Tareas por comprobar'));
        nodes.push(node);
      }
      if (snapshot.pagination?.changes?.hasMore || snapshot.pagination?.changes?.page) nodes.push(navItem({ key: 'nav:changes', label: 'Ver páginas de HU', iconName: 'layers', onClick: () => openView('changes') }));
      nodes.push(groupHeading('Consultar'));
      nodes.push(navItem({ key: 'nav:specs', label: 'Specs · fuente de verdad', iconName: 'file', count: scopeCount('specs'), active: state.view === 'specs' || readerGroup() === 'spec', onClick: () => openView('specs') }));
      nodes.push(navItem({ key: 'nav:context', label: 'Contexto del sistema', iconName: 'info', count: scopeCount('context'), active: state.view === 'context' || readerGroup() === 'context', onClick: () => openView('context') }));
      nodes.push(navItem({ key: 'nav:archived', label: 'Archivo', iconName: 'archive', count: scopeCount('archive'), active: state.view === 'archived' || (state.view === 'change' && findChange(state.selectedChange)?.archived), onClick: () => openView('archived') }));
    }
    explorerList.replaceChildren(...nodes);
  });
}

function renderRail() {
  const current = findChange(state.selectedChange);
  const activeId = ui.invalidRoot ? null
    : state.view === 'home' ? 'home'
      : state.view === 'graph' ? 'graph'
      : state.view === 'changes' || (state.view === 'change' && !current?.archived) || (state.view === 'reader' && state.readerOrigin && !findChange(state.readerOrigin)?.archived) ? 'changes'
        : state.view === 'context' || readerGroup() === 'context' ? 'context'
          : state.view === 'specs' || readerGroup() === 'spec' ? 'specs'
            : state.view === 'archived' || current?.archived ? 'archived' : null;
  const disabled = !snapshot?.rootPath;
  for (const [id, node] of railButtons) {
    node.classList.toggle('is-active', id === activeId);
    if (id === activeId) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
    node.disabled = disabled && id !== 'home';
    const counts = { changes: scopeCount('changes'), specs: scopeCount('specs'), context: scopeCount('context'), archived: scopeCount('archive') };
    const name = railDefinitions.find(item => item[0] === id)[1];
    node.querySelector('.button-label').textContent = id === 'home' || id === 'graph' ? name : `${name} · ${counts[id]}`;
  }
}

function renderStatus() {
  if (!snapshot || snapshot.loading) statusText.textContent = 'Leyendo el proyecto…';
  else if (!snapshot.rootPath) statusText.textContent = 'Sin S0 seleccionado';
  else statusText.textContent = `Se actualiza al guardar${snapshot.readAt ? ` · ${formatTime(snapshot.readAt)}` : ''}`;
  statusText.title = snapshot?.rootPath || '';
}

/* ---------- Alerts ---------- */

function clearError() {
  alertRegion.querySelector('.error-banner')?.remove();
}

function showError(message) {
  clearError();
  const alert = el('div', 'error-banner');
  alert.setAttribute('role', 'alert');
  alert.append(icon('info'), el('span', '', message), button('Cerrar aviso', 'btn-icon', clearError, 'close', true));
  alertRegion.prepend(alert);
}

function renderWarnings() {
  alertRegion.querySelector('.warning-notice')?.remove();
  if (!snapshot?.warnings.length) return;
  const notice = el('details', 'warning-notice');
  notice.append(el('summary', '', plural(snapshot.warnings.length, 'aviso de lectura', 'avisos de lectura')));
  const list = el('ul');
  snapshot.warnings.forEach(warning => list.append(el('li', '', typeof warning === 'string' ? warning : warning.message || String(warning))));
  notice.append(list);
  alertRegion.append(notice);
}

/* ---------- Shared pieces ---------- */

function makeScroller(className = '') {
  const node = el('div', `scroller ${className}`.trim());
  node.tabIndex = -1;
  for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    node.addEventListener(eventName, () => { ++inputVersion; }, { passive: true });
  }
  node.addEventListener('scroll', () => {
    if (saveFrame) cancelAnimationFrame(saveFrame);
    saveFrame = requestAnimationFrame(() => {
      state.scroll = node.scrollTop;
      state.scrollKey = viewKey();
      scrollMemory.set(state.scrollKey, state.scroll);
      persist();
    });
  }, { passive: true });
  return node;
}

function heading(tag, className, content) {
  const node = el(tag, className, content);
  node.tabIndex = -1;
  node.dataset.autofocus = 'true';
  return node;
}

function btn(label, kind, onClick, iconName) {
  return button(label, `btn btn-${kind}`, onClick, iconName);
}

function stateCard({ iconName, tone = 'muted', title, body = [], code, actions = [], className = '' }) {
  const card = el('div', `state-card ${className}`.trim());
  if (iconName) card.append(icon(iconName, `state-icon tone-${tone}`));
  card.append(heading('h2', 'state-title', title));
  for (const paragraph of body) {
    const node = el('p', 'state-text');
    node.append(...(Array.isArray(paragraph) ? paragraph : [paragraph]));
    card.append(node);
  }
  if (code) card.append(el('pre', 'state-code', code));
  if (actions.length) {
    const row = el('div', 'state-actions');
    for (const { label, kind, onClick, iconName: actionIcon } of actions) row.append(btn(label, kind, onClick, actionIcon));
    card.append(row);
  }
  return card;
}

function centered(content) {
  const node = makeScroller();
  const wrap = el('div', 'state-page');
  wrap.append(content);
  node.append(wrap);
  return node;
}

function loadingBlock(message) {
  const loading = el('div', 'loading-state');
  loading.setAttribute('role', 'status');
  loading.append(el('div', 'loading-spinner'), el('p', '', message));
  return loading;
}

function markdownArticle(doc, className = '') {
  const article = el('article', `markdown-body ${className}`.trim());
  article.setAttribute('aria-label', doc.title || 'Documento Markdown');
  // Only the host's sanitized Markdown renderer may supply document HTML.
  article.innerHTML = doc.html || '';
  prepareMarkdown(article, doc.path);
  if (!article.textContent.trim() && !article.querySelector('table,pre')) article.append(el('p', 'empty-document', 'Este archivo Markdown está vacío.'));
  return article;
}

function prepareMarkdown(container, fromPath) {
  container.dataset.path = fromPath;
  container.querySelectorAll('input').forEach(input => { input.disabled = true; });
  container.addEventListener('click', event => handleMarkdownLink(event, fromPath));
}

function documentMeta(doc) {
  const meta = el('div', 'doc-meta');
  meta.append(pill(kindLabel(doc.path), 'pill-kind'), mono(doc.path, 'doc-meta-path'));
  const modified = formatWhen(doc.modifiedAt);
  if (modified) meta.append(el('span', 'doc-meta-date', `· Modificado ${modified}`));
  return meta;
}

function readErrorCard(path) {
  const owner = index.get(path)?.owner;
  const body = [readErrors.get(path)];
  if (owner) body.push('El resto del cambio sigue disponible.');
  return stateCard({
    iconName: 'info', tone: 'error', title: `No se pudo leer ${path.split('/').pop()}`, body,
    actions: [
      { label: 'Abrir en el editor', kind: 'primary', onClick: () => post('openSource', { path }) },
      { label: 'Reintentar', kind: 'secondary', onClick: () => { readErrors.delete(path); renderMain({ preserveScroll: true }); } },
    ],
  });
}

// Loaded document, loading indicator or read error for a path, requesting it when needed.
function documentSlot(path, build) {
  if (readErrors.has(path)) return readErrorCard(path);
  const doc = documents.get(path);
  if (!doc) {
    requestDocument(path);
    return loadingBlock('Leyendo documento…');
  }
  state.lastRead = path;
  return build(doc);
}

function artifactStrip(change) {
  const strip = el('span', 'artifact-flow');
  for (const [kind, label] of ARTIFACTS) {
    if (strip.childElementCount) strip.append(el('span', 'flow-connector'));
    const present = artifactPresent(change, kind);
    const chip = el('span', `flow-pill${present === null ? ' is-unknown' : present ? '' : ' is-absent'}`);
    if (present) chip.append(icon('check'));
    const value = kind === 'specs' && present ? `Specs · ${deltaSpecs(change).length} visibles` : kind === 'tasks' && present ? `Tareas · ${tasksLabel(change)}` : label;
    chip.append(value + (present === null ? ' · por comprobar' : present ? '' : ' · falta'));
    if (kind === 'tasks' && present && change.tasks) chip.append(progressBar(change.tasks.done, change.tasks.total, 'mini-progress'));
    strip.append(chip);
  }
  return strip;
}

function pageHeader(kicker, title, note) {
  const header = el('section', 'page-head');
  if (kicker) header.append(overline(kicker));
  header.append(heading('h1', 'page-title', title));
  if (note) {
    const paragraph = el('p', 'page-note');
    paragraph.append(...(Array.isArray(note) ? note : [note]));
    header.append(paragraph);
  }
  return header;
}

function sectionTitle(title, aside) {
  const row = el('div', 'section-title');
  row.append(el('h2', '', title));
  if (aside) row.append(el('span', 'section-aside', aside));
  return row;
}

/* ---------- Main rendering ---------- */

function mainSignature() {
  return `${viewKey()}|${state.readerOrigin || ''}|${ui.invalidRoot ? ui.invalidRoot.path : ''}|${snapshotVersion}`;
}

function renderMain({ preserveScroll = false, navigation = false } = {}) {
  viewRoot.querySelector('.graph-view')?.dispose?.();
  const key = viewKey();
  const previousTop = scroller ? scroller.scrollTop : 0;
  const target = preserveScroll && key === renderedKey ? previousTop : scrollMemory.get(key) || 0;
  const focusInMain = main.contains(document.activeElement);
  ++diagramGeneration;
  headingObserver?.disconnect();
  headingObserver = null;
  const version = inputVersion;
  renderedDocument = null;
  let content;
  if (!snapshot || snapshot.loading) content = centered(loadingBlock('Leyendo el proyecto…'));
  else if (ui.invalidRoot) content = invalidRootView();
  else if (!snapshot.rootPath) content = noRootView();
  else if (state.view === 'change' && findChange(state.selectedChange)) content = changeView(findChange(state.selectedChange));
  else if (state.view === 'change' && state.selectedChange) content = centered(changeLoadingState(state.selectedChange));
  else if (state.view === 'reader' && state.selectedPath && index.has(state.selectedPath)) content = readerView();
  else if (state.view === 'changes') content = changesView();
  else if (state.view === 'context') content = contextView();
  else if (state.view === 'specs') content = specsView();
  else if (state.view === 'archived') content = archivedView();
  else if (state.view === 'graph') content = graphView();
  else content = homeView();
  preserveFocus(viewRoot, () => viewRoot.replaceChildren(content));
  scroller = content.classList.contains('scroller') ? content : content.querySelector('.scroller');
  renderedKey = key;
  renderedSignature = mainSignature();
  persist();
  if (navigation && focusInMain && !main.contains(document.activeElement)) viewRoot.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  viewRoot.setAttribute('aria-busy', String(Boolean(pendingPath && pendingPath === wantedPath()) || changeRequests.has(state.selectedChange) || pageRequests.size > 0));
  for (const container of viewRoot.querySelectorAll('.markdown-body')) renderDiagrams(container, diagramGeneration, target, version);
  if (scroller) {
    scroller.scrollTop = target;
    requestAnimationFrame(() => { if (scroller && version === inputVersion) scroller.scrollTop = target; });
  }
  if (pendingReveal && renderedDocument?.path === pendingReveal.path) requestAnimationFrame(() => {
    if (!pendingReveal || renderedDocument?.path !== pendingReveal.path) return;
    const target = pendingReveal.anchor ? viewRoot.querySelector(`#${CSS.escape(pendingReveal.anchor)}`) : viewRoot.querySelector(`[data-source-line="${pendingReveal.line}"]`);
    if (target) { ++inputVersion; target.scrollIntoView({ block: 'start' }); target.tabIndex = -1; target.focus({ preventScroll: true }); }
    else announce('La sección solicitada no está presente en el documento leído. Puedes abrir su fuente.');
    pendingReveal = null;
  });
}

function requestGraph() {
  if (graphPending || !snapshot?.rootPath || snapshot.loading) return;
  graphPending = true; graphError = null;
  post('graph', { requestId: ++graphRequest, includeArchive: state.graph.includeArchive === true, includeInferred: state.graph.includeInferred === true });
}

function graphView() {
  if (graphError) return centered(stateCard({ iconName: 'info', title: 'No se pudo leer el grafo', body: [graphError], actions: [btn('Reintentar', 'secondary', () => { graphError = null; requestGraph(); renderMain(); })] }));
  if (!knowledgeIndex) { requestGraph(); return centered(loadingBlock('Construyendo relaciones desde las fuentes…')); }
  const reload = next => { Object.assign(state.graph, next); persist(); knowledgeIndex = null; graphPending = false; requestGraph(); renderMain(); };
  return createGraphView(knowledgeIndex, { state: state.graph, onState: persist, rootName: snapshot.rootName, mark: () => viewerMark(),
    onArchive: includeArchive => reload({ includeArchive }), onInferred: includeInferred => { state.graph.includeInferred = includeInferred; persist(); renderMain(); },
    onRead: ({ path, anchor, line }) => openDocument(path, { anchor, line, origin: null }),
    onSource: target => post('openSource', target),
  });
}

/* ---------- Special states ---------- */

function noRootView() {
  return centered(stateCard({
    iconName: 'folder', title: 'Elige un S0 para empezar',
    body: [['El visor lee una carpeta de planificación que contiene ', mono('openspec/'), '. Elegirla no configura el agente.']],
    actions: [
      { label: 'Elegir carpeta S0', kind: 'primary', onClick: () => post('chooseRoot') },
      { label: 'Pegar ruta', kind: 'secondary', onClick: () => post('enterRootPath') },
      { label: 'Abrir demo', kind: 'text', onClick: () => post('demo') },
    ],
  }));
}

function invalidRootView() {
  const { path, codeRepository } = ui.invalidRoot;
  const previous = snapshot?.rootPath ? snapshot.rootName : null;
  const reason = ['No hay ', mono('openspec/config.yaml'), ', ', mono('changes/'), ' ni ', mono('specs/'), '.'];
  if (codeRepository) reason.push(' Parece un repositorio de código, no el S0.');
  return centered(stateCard({
    iconName: 'info', tone: 'error', title: 'Esta carpeta no contiene OpenSpec', code: path, body: [reason],
    actions: [
      { label: 'Elegir otra carpeta', kind: 'primary', onClick: () => post('chooseRoot') },
      previous
        ? { label: `Volver a ${previous}`, kind: 'secondary', onClick: () => { ui.invalidRoot = null; renderChrome(); renderMain({ navigation: true }); } }
        : { label: 'Pegar ruta', kind: 'secondary', onClick: () => post('enterRootPath') },
    ],
  }));
}

/* ---------- A · Inicio ---------- */

function homeView() {
  const node = makeScroller(); const page = el('div', 'page');
  page.append(identitySection());
  const resume = continueReading(); if (resume) page.append(resume);
  const organization = el('section', 'page-section organization');
  organization.append(sectionTitle('Cómo está organizado este S0'), el('p', 'page-note', 'Cada HU propone cambios sobre las specs. Mientras está en curso vive en openspec/changes/; al archivarla, su delta se integra en la spec consolidada.'), statsGrid());
  const files = el('div', 'template-files'); files.append(el('strong', 'small-title', 'Archivos de la plantilla'));
  const chips = el('div', 'template-chips');
  for (const [key, label] of [['config', 'openspec/config.yaml'], ['indice', 'docs/INDICE.md'], ['repositorios', 'repositorios.json'], ['readme', 'README.md'], ['agents', 'AGENTS.md'], ['guide', 'Guía de HU']]) {
    const present = Boolean(snapshot.template?.[key]);
    const chip = el('span', `flow-pill${present ? '' : ' is-absent'}`);
    if (present) chip.append(icon('check')); chip.append(mono(label + (present ? '' : ' · falta'))); chips.append(chip);
  }
  files.append(chips, el('span', 'footnote', 'Lo que falta no impide leer el S0.')); organization.append(files); page.append(organization);
  const changes = el('section', 'page-section');
  const active = activeChanges().slice().sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  changes.append(sectionTitle('HU en curso', `${scopeCount('changes')} · página ordenada por modificación`), active.length ? changesTable(active) : snapshot.pagination?.changes?.status === 'error' || snapshot.pagination?.changes?.status === 'partial' ? inlineEmpty('Lectura incompleta', 'No se pudo comprobar si hay HU en esta sección.') : snapshot.pagination?.changes?.page ? inlineEmpty('Página sin HU', 'Vuelve a la página anterior para continuar.') : readyCard());
  appendPagination(changes, 'changes');
  page.append(changes); node.append(page); return node;
}

function identitySection() {
  const section = el('section', 'identity'); section.append(overline('S0 · sistema consultado'));
  const row = el('div', 'identity-row'); row.append(heading('h1', 'identity-name', snapshot.rootName));
  if (snapshot.demo) row.append(pill('Datos ficticios', 'pill-dashed'));
  section.append(row);
  section.append(el('p', 'identity-description', snapshot.description || 'Sin información'));
  if (snapshot.description) section.append(el('span', 'identity-source', 'Descripción tomada de openspec/config.yaml'));
  const pathRow = el('div', 'identity-path-row'); const location = el('span', 'identity-path');
  location.append(icon('folder'), mono(snapshot.rootPath)); const health = el('span', 'health');
  health.append(dot('ok'), 'S0 válido', mono(snapshot.rootMarker || 'openspec/', 'health-source'));
  pathRow.append(location, health, el('span', 'identity-meta', `${snapshot.repositories.length} componentes en repositorios.json`));
  section.append(pathRow); return section;
}

function statsGrid() {
  const grid = el('div', 'stats');
  const zones = [
    ['changes', 'HU en curso', scopeCount('changes'), 'activas', 'Propuestas de cambio: por qué, qué cambia, specs, diseño y tareas.', 'openspec/changes/', 'layers'],
    ['specs', 'Specs', scopeCount('specs'), 'capacidades', 'Fuente de verdad: cómo funciona hoy el sistema, requisito por requisito.', 'openspec/specs/', 'file'],
    ['context', 'Contexto', scopeCount('context'), 'documentos', 'Arquitectura, componentes y guías para entender el sistema.', 'docs/ · repositorios.json', 'info'],
    ['archived', 'Archivo', scopeCount('archive'), 'HU archivadas', 'HU cerradas en el flujo. Consulta sus documentos y fecha de archivo.', 'openspec/changes/archive/', 'archive'],
  ];
  for (const [key, label, count, unit, description, path, symbol] of zones) {
    const card = action('stat', () => openView(key), `stat:${key}`);
    const title = el('span', 'zone-title'); title.append(icon(symbol), label);
    const value = el('span', 'zone-value'); value.append(mono(count, 'stat-value'), el('span', '', unit));
    card.append(title, value, el('span', 'zone-description', description), mono(path, 'zone-path')); grid.append(card);
  } return grid;
}

function continueReading() {
  if (!state.lastRead || !index.has(state.lastRead)) return null;
  const owner = index.get(state.lastRead).owner;
  const row = action('resume', () => openDocument(state.lastRead, { origin: owner ? owner.id : null }), 'resume');
  const body = el('span', 'resume-body');
  const line = el('span', 'resume-line', documentName(state.lastRead));
  if (owner) line.append(el('span', 'resume-owner', ` — ${owner.title || owner.id}`));
  body.append(el('span', 'resume-label', 'Continuar donde lo dejaste'), line);
  row.title = state.lastRead;
  row.append(icon('file', 'resume-icon'), body, icon('arrow', 'resume-arrow'));
  return row;
}

function changesTable(changes) {
  const list = el('div', 'hu-cards');
  for (const change of changes) {
    const row = action('hu-row', () => openChange(change.id), `hu-row:${change.id}`);
    const head = el('span', 'hu-row-heading');
    head.append(el('strong', 'hu-row-title', change.title || change.id), el('span', 'hu-row-date', `Modificado ${formatWhen(change.updatedAt) || 'Sin información'}`));
    row.append(head, mono(change.id, 'hu-row-folder'));
    if (change.purpose) row.append(el('span', 'hu-row-purpose', change.purpose));
    const next = el('span', 'hu-row-next');
    next.append(dot('brand'), 'Siguiente paso sugerido: ', el('strong', '', change.next?.title || (change.loadState && change.loadState !== 'loaded' ? 'Pendiente de lectura' : 'Sin información')), pill('Inferido'));
    next.title = `Basado en ${(change.next?.basis || []).join('; ') || 'archivos presentes'}`;
    row.append(artifactStrip(change), next); list.append(row);
  } return list;
}

function readyCard() {
  const card = el('div', 'ready-card');
  const head = el('div', 'ready-head');
  head.append(dot('ok'), el('strong', '', 'Este S0 está listo para su primera HU'));
  const available = snapshot.docs.length && snapshot.specs.length ? 'El contexto y las specs consolidadas ya se pueden consultar. '
    : snapshot.docs.length ? 'El contexto ya se puede consultar. '
      : snapshot.specs.length ? 'Las specs consolidadas ya se pueden consultar. ' : '';
  const paragraph = el('p', 'ready-text');
  paragraph.append(`${available}Cuando la IA prepare un cambio con las skills de OpenSpec, aparecerá aquí al guardarse en `, mono('openspec/changes/'), '.');
  const guide = huGuide();
  const steps = el('ol', 'ready-steps');
  for (const step of [guide ? 'Revisa el contexto del sistema y la guía de HU.' : 'Revisa el contexto del sistema.', 'Genera la propuesta fuera del visor (Claude o Codex + skill de OpenSpec).', 'Vuelve aquí para leerla y revisar su alcance.']) steps.append(el('li', '', step));
  const actions = el('div', 'state-actions');
  if (guide) actions.append(btn('Leer guía para trabajar una HU', 'primary', () => openDocument(guide.path, { origin: null })), btn('Ver contexto del sistema', 'secondary', () => openView('context')));
  else actions.append(btn('Ver contexto del sistema', 'primary', () => openView('context')));
  card.append(head, paragraph, steps, actions);
  return card;
}

function shortcutsSection() {
  const picks = [];
  const readme = snapshot.docs.find(item => item.path === 'README.md');
  const guide = huGuide();
  if (readme) picks.push(readme);
  if (guide) picks.push(guide);
  for (const item of snapshot.docs) {
    if (picks.length >= 3) break;
    if (item.path.startsWith('docs/') && !picks.includes(item)) picks.push(item);
  }
  if (!picks.length && !snapshot.repositories.length) return null;
  const section = el('section', 'page-section');
  section.append(sectionTitle('Accesos útiles'));
  const grid = el('div', 'shortcut-grid');
  for (const item of picks) {
    const card = action('shortcut', () => openDocument(item.path, { origin: null }), `shortcut:${item.path}`);
    card.append(el('span', 'shortcut-title', item.title || item.label), mono(item.path, 'shortcut-path'));
    grid.append(card);
  }
  if (snapshot.repositories.length) {
    const card = action('shortcut', () => openView('context'), 'shortcut:repositories');
    card.append(el('span', 'shortcut-title', 'Componentes y repositorios'), mono(`repositorios.json · ${snapshot.repositories.length}`, 'shortcut-path'));
    grid.append(card);
  }
  section.append(grid);
  return section;
}

function changesView() {
  const node = makeScroller();
  const page = el('div', 'page');
  page.append(pageHeader('Consulta', 'HU en curso', 'Propuestas de cambio, sus documentos y el siguiente paso sugerido.'));
  const active = activeChanges();
  if (active.length) page.append(changesTable(active));
  else if (snapshot.pagination?.changes?.status === 'error' || snapshot.pagination?.changes?.status === 'partial') page.append(inlineEmpty('Lectura incompleta', 'No se pudo comprobar si hay HU en esta sección.'));
  else if (snapshot.pagination?.changes?.page) page.append(inlineEmpty('Página sin HU', 'Vuelve a la página anterior para continuar.'));
  else {
    page.append(stateCard({
      iconName: 'layers', tone: 'ok', title: 'Aún no hay HU en este S0',
      body: [[`Todo está en orden: contexto (${snapshot.docs.length}) y specs (${snapshot.specs.length}) están disponibles. Los cambios aparecerán al guardarse en `, mono('openspec/changes/'), '.']],
      actions: [
        { label: 'Ver inicio preparado', kind: 'primary', onClick: goHome },
        { label: 'Ver contexto', kind: 'secondary', onClick: () => openView('context') },
      ],
    }));
  }
  appendPagination(page, 'changes');
  node.append(page);
  return node;
}

/* ---------- B · Detalle de una HU ---------- */

function changeLoadingState(id, fallbackError) {
  if (changeRequests.has(id)) return loadingBlock('Leyendo documentos de la HU…');
  const error = loadErrors.get(`change:${id}`) || fallbackError;
  if (error) return stateCard({ iconName: 'info', tone: 'error', title: 'No se pudo cargar la HU', body: [error], actions: [{ label: 'Reintentar HU', kind: 'primary', onClick: () => { requestChange(id, retryPages.get(`change:${id}`) ?? 0); renderMain({ preserveScroll: true }); } }] });
  if (!changeRequests.has(id)) requestChange(id);
  return loadingBlock('Leyendo documentos de la HU…');
}

function changeView(change) {
  const node = makeScroller('view-change');
  const bar = el('div', 'crumbbar hu-crumbbar'); const nav = el('nav', 'crumbs'); nav.setAttribute('aria-label', 'Ubicación de la HU');
  nav.append(button(snapshot.rootName, 'crumb', goHome), icon('arrow'), button(change.archived ? 'Archivo' : 'HU en curso', 'crumb', () => openView(change.archived ? 'archived' : 'changes')), icon('arrow'), el('span', 'crumb is-current', change.title || change.id));
  bar.append(nav); const proposal = changeDocument(change, 'proposal');
  if (proposal) bar.append(button('Abrir proposal.md', 'btn btn-secondary btn-bar hu-open', () => post('openSource', {path:proposal.path}), 'external'));
  node.append(bar, changeHeader(change));
  if (change.loadState === 'unloaded' || loadErrors.has(`change:${change.id}`) || change.loadState === 'error' && !change.documents.length) { node.append(changeLoadingState(change.id, change.error)); return node; }
  node.append(changeTabs(change));
  appendPagination(node, null, change);
  const body = el('div', 'hu-body'); const content = el('div', 'hu-content');
  content.id = 'hu-tabpanel'; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', `hu-tab-${state.changeTab.replace(/[^a-z0-9]/gi, '-')}`); content.tabIndex = 0;
  content.append(tabContent(change)); body.append(content, changeAside(change)); node.append(body); return node;
}

function changeHeader(change) {
  const section = el('section', 'hu-head'); const kicker = el('div', 'hu-kicker');
  kicker.append(overline(change.archived ? 'HU · cambio archivado' : 'HU · cambio activo'), mono(change.folder || change.id, 'hu-folder'));
  section.append(kicker, heading('h1', 'hu-title', change.title || change.id));
  if (change.purpose) section.append(el('p', 'hu-purpose', change.purpose));
  const flowHeading = el('div', 'flow-heading');
  const note = el('p', 'flow-note'); note.append(icon('info'), 'Según los archivos presentes. Presente no significa aprobado.');
  flowHeading.append(el('strong', 'small-title', 'Documentos del cambio'), note); section.append(flowHeading);
  const steps = el('ol', 'change-steps');
  ARTIFACTS.forEach(([kind, label], position) => {
    const present = artifactPresent(change, kind); const li = el('li');
    const step = action(`change-step${present === null ? ' is-unknown' : present ? ' is-present' : ' is-absent'}`, () => setChangeTab(kind), `step:${kind}`);
    const head = el('span', 'step-title'); const circle = el('span', 'step-number'); circle.append(present ? icon('check') : String(position+1)); head.append(circle, label);
    const path = kind === 'specs' ? 'specs/' : `${kind}.md`;
    let detail = present === null ? 'Por comprobar' : !present ? 'Falta' : kind === 'tasks' ? tasksLabel(change) : kind === 'specs' ? deltaSpecs(change).map(item => deltaText(item.delta)).join(' · ') || 'Presente · contenido pendiente de lectura' : 'Presente';
    if (present && changeDocument(change, kind)?.loadState === 'error') detail = 'Presente · lectura fallida';
    else if (present && changeDocument(change, kind)?.loadState === 'unloaded') detail = 'Presente · contenido pendiente de lectura';
    const diagramCount = kind === 'design' ? changeDocument(change, kind)?.diagramCount : 0;
    if (present && Number.isInteger(diagramCount) && diagramCount > 0) detail += ` · ${diagramCount} ${plural(diagramCount, 'diagrama')}`;
    step.append(head, mono(path));
    const detailLine = el('span', kind === 'tasks' ? 'step-progress' : 'step-metadata');
    detailLine.append(el('span', 'step-detail', detail));
    if (kind === 'tasks' && present && change.tasks) detailLine.append(progressBar(change.tasks.done, change.tasks.total));
    step.append(detailLine); li.append(step); steps.append(li);
  });
  const archive = el('li', 'archive-step'); const ah = el('span', 'step-title'); ah.append(el('span', 'step-number', '5'), 'Archivo');
  archive.append(ah, mono('archive/'), el('span', 'step-detail', change.archived ? (change.archivedAt ? `Archivada el ${change.archivedAt}` : 'Archivada · fecha sin información') : 'Aún no archivada')); steps.append(archive);
  section.append(steps, nextStep(change)); return section;
}

function progressBar(done, total, className = '') {
  const bar = el('span', `progress-bar ${className}`.trim()); const fill = el('span');
  fill.style.width = `${total ? Math.min(100, Math.max(0, done / total * 100)) : 0}%`; bar.append(fill);
  bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `${done} de ${total} casillas marcadas`); return bar;
}

function nextStep(change) {
  const next = change.next || {title:change.loadState && change.loadState !== 'loaded' ? 'Pendiente de lectura' : 'Sin información', detail:'', basis:[]}; const card = el('div', 'next-card'); const body = el('div', 'next-body'); const head = el('div', 'next-head');
  head.append(dot('brand'), el('strong', '', 'Siguiente paso sugerido'), pill('Inferido'));
  const basis = el('details', 'next-basis');
  basis.append(el('summary', '', 'Fundamento'), el('p', '', `Basado en ${(next.basis || []).join('; ') || 'los archivos presentes'}; no es el estado oficial del workflow.`));
  head.append(basis);
  body.append(head, el('strong', 'next-title', next.title), el('p', 'next-detail', next.detail || '')); card.append(body);
  const command = change.continuation?.command;
  if (typeof command === 'string' && command && change.continuation.source) {
    const continuation = el('div', 'continuation'); continuation.append(el('span', '', 'Cómo continuar, fuera del visor'), el('code', '', command), button('Copiar', 'btn btn-secondary btn-bar', () => post('copyText', {text:command})), el('span', 'footnote', `Fuente: ${change.continuation.source}`)); card.append(continuation);
  } return card;
}

function changeTabs(change) {
  const tabs = el('nav', 'hu-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Documentos de la HU');
  const definitions = [['summary','Resumen',null], ['proposal','Propuesta','proposal'], ['specs',`Specs · ${deltaSpecs(change).length} visibles`,'specs'], ['design','Diseño','design'], ['tasks',artifactPresent(change,'tasks') && change.tasks ? `Tareas · ${change.tasks.done}/${change.tasks.total}` : 'Tareas','tasks'], ...change.documents.filter(item => item.kind === 'other').map(item => [`doc:${item.path}`,item.label,'other'])];
  definitions.forEach(([id,label,kind], position) => {
    const selected = state.changeTab === id; const tab = action(`hu-tab${selected ? ' is-active' : ''}`, () => setChangeTab(id), `tab:${id}`);
    tab.id = `hu-tab-${id.replace(/[^a-z0-9]/gi,'-')}`; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected',String(selected)); tab.setAttribute('aria-controls','hu-tabpanel'); tab.tabIndex = selected ? 0 : -1;
    tab.append(label); if (kind && kind !== 'other' && artifactPresent(change,kind) !== true) tab.append(el('span','tab-missing',artifactPresent(change,kind) === null ? ' · por comprobar' : ' · falta'));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? definitions.length-1 : (position + (event.key === 'ArrowRight' ? 1 : -1) + definitions.length) % definitions.length;
      setChangeTab(definitions[target][0]); viewRoot.querySelectorAll('[role="tab"]')[target]?.focus();
    }); tabs.append(tab);
  }); return tabs;
}

function tabContent(change) {
  const tab = state.changeTab;
  if (tab === 'summary') return summaryPanel(change);
  if (tab === 'specs') return specsPanel(change);
  if (['proposal', 'design', 'tasks'].includes(tab) && !artifactPresent(change, tab)) return absentPanel(change, tab);
  const path = tabPath(change, tab);
  if (!path) return summaryPanel(change);
  return documentSlot(path, doc => {
    const wrap = el('div', 'hu-doc');
    wrap.append(documentMeta(doc));
    wrap.append(index.get(path)?.item.kind === 'tasks' && doc.tasksStructure ? tasksPanel(doc) : markdownArticle(doc));
    renderedDocument = doc;
    return wrap;
  });
}

function summaryPanel(change) {
  const panel = el('div', 'summary');
  const proposal = changeDocument(change, 'proposal');
  if (!proposal) return absentPanel(change, 'proposal');
  const head = el('div', 'summary-head');
  const source = el('span', 'summary-source');
  source.append('Extracto de ', mono('proposal.md'));
  head.append(source, button('Leer la propuesta completa', 'btn-text summary-full', () => setChangeTab('proposal')));
  panel.append(head);
  if (proposal.loadState === 'error' || proposal.loadState === 'unloaded') {
    panel.append(inlineEmpty(proposal.loadState === 'error' ? 'No se pudo leer el resumen' : 'Resumen pendiente de lectura', 'La propuesta existe, pero su contenido no se pudo comprobar. Abre la propuesta completa para leerla o ver el error.'));
    return panel;
  }
  const sections = change.summary?.sections || [];
  if (!sections.length) {
    panel.append(inlineEmpty('Sin información', 'proposal.md no tiene las secciones Por qué, Qué cambia, Capacidades, Impacto ni Fuera de alcance.'));
    return panel;
  }
  const list = el('dl', 'summary-grid');
  for (const section of sections) {
    const body = el('dd', 'markdown-body summary-body');
    // Section HTML is produced by the host's sanitized Markdown renderer.
    body.innerHTML = section.html;
    prepareMarkdown(body, proposal.path);
    list.append(el('dt', 'summary-label', section.label), body);
  }
  panel.append(list);
  return panel;
}

function inlineEmpty(title, detail) {
  const box = el('div', 'inline-empty');
  box.append(el('strong', '', title), el('span', '', detail));
  return box;
}

function absentPanel(change, kind) {
  if (artifactPresent(change, kind) !== false) return inlineEmpty('Lectura pendiente', 'Este documento no está disponible en la lectura actual; no se ha comprobado que falte. Revisa los avisos o reintenta la página.');
  const guide = huGuide();
  const box = el('div', 'absent');
  const copy = {
    proposal: ['Propuesta todavía no existe', [[mono('proposal.md', 'is-strong'), ' no está en la carpeta del cambio.'], 'Se genera fuera del visor con la skill de OpenSpec. El visor no la crea ni la solicita.']],
    specs: ['Specs todavía no existen', [['No hay carpeta ', mono('specs/'), ' en este cambio. Puedes leer la propuesta; no bloquea la consulta.']]],
    design: ['Diseño todavía no existe', [[mono('design.md', 'is-strong'), ' no está en la carpeta del cambio. La propuesta y las specs se pueden leer igual.'], 'Se genera fuera del visor con la skill de OpenSpec. El visor no lo crea ni lo solicita.']],
    tasks: ['Tareas · falta', [[mono('tasks.md', 'is-strong'), ' no existe todavía. Normalmente se prepara después del diseño y antes de autorizar la implementación.'], ['Avance de tareas: ', el('strong', '', 'Sin información')]]],
  }[kind];
  box.append(heading('h2', 'absent-title', copy[0]));
  for (const paragraph of copy[1]) {
    const node = el('p', 'absent-text');
    node.append(...(Array.isArray(paragraph) ? paragraph : [paragraph]));
    box.append(node);
  }
  const actions = el('div', 'state-actions');
  if (kind === 'design') {
    if (guide) actions.append(btn('Qué contiene un diseño · guía', 'secondary', () => openDocument(guide.path, { origin: change.id })));
    else if (snapshot.docs.length) actions.append(btn('Ver contexto del sistema', 'secondary', () => openView('context')));
  }
  if (kind !== 'proposal' && artifactPresent(change, 'proposal')) actions.append(button('Leer la propuesta', 'btn btn-text', () => setChangeTab('proposal')));
  if (actions.childElementCount) box.append(actions);
  return box;
}

function specsPanel(change) {
  const specs = deltaSpecs(change);
  if (!specs.length) return absentPanel(change, 'specs');
  const panel = el('div', 'spec-list');
  const note = el('p', 'panel-note');
  note.append('Specs del cambio (delta). Al archivar, se consolidan en ', mono('openspec/specs/'), '.');
  panel.append(note);
  for (const spec of specs) {
    const row = el('div', 'spec-row');
    const name = el('span', 'spec-row-name');
    name.append(el('span', 'spec-row-title', spec.label), mono(spec.path, 'spec-row-path'));
    row.append(icon('file', 'spec-row-icon'), name, el('span', 'spec-row-delta', deltaText(spec.delta)));
    const actions = el('span', 'spec-row-actions');
    actions.append(btn('Leer delta', 'primary', () => openDocument(spec.path, { origin: change.id })));
    const canonical = `openspec/specs/${spec.label}/spec.md`;
    if (spec.canonical || index.has(canonical)) {
      const canon = btn('Ver consolidada', 'secondary', () => openDocument(canonical, { origin: change.id }));
      canon.title = canonical;
      actions.append(canon);
    }
    row.append(actions);
    panel.append(row);
  }
  return panel;
}

function asideSection(label, children) {
  const section = el('section', 'aside-section'); section.append(el('strong','small-title',label),...children); return section;
}

function linkButton(path, origin) {
  const node = button(path, 'aside-link', () => openDocument(path, { origin }), 'file');
  node.dataset.key = `aside:${path}`;
  node.querySelector('.button-label').classList.add('mono');
  return node;
}

function changeAside(change) {
  const aside = el('aside', 'hu-aside'); aside.setAttribute('aria-label','Relacionado con esta HU'); aside.append(el('h2','aside-title','Relacionado con esta HU'));
  if (change.loadState === 'partial' || change.loadState === 'error') aside.append(el('p', 'aside-note', 'Relaciones de los documentos leídos. La lectura incompleta no demuestra que no existan otras referencias.'));
  const missing=[];
  if (change.related.length) {
    const rows=change.related.map(component => {const row=el('div','component-row');row.append(mono(component.id),el('span','component-role',component.role || 'Sin información'));return row;});
    rows.push(el('span','aside-note','Detectados en «Impacto» de proposal.md.'),pill('Inferido'));
    aside.append(asideSection(`Componentes que menciona ${change.related.length}`,rows));
  } else missing.push('componentes');
  if (deltaSpecs(change).length) {
    const rows=deltaSpecs(change).map(spec => {const row=el('div','related-spec');row.append(el('strong','',spec.label),el('span','aside-note',deltaText(spec.delta)),button('Leer delta','btn-text',()=>openDocument(spec.path,{origin:change.id})));
      const canonical=spec.canonical || `openspec/specs/${spec.label}/spec.md`;if(spec.canonical || index.has(canonical))row.append(button('Ver consolidada','btn-text',()=>openDocument(canonical,{origin:change.id})));return row;});
    aside.append(asideSection('Specs que modifica',rows));
  } else missing.push('specs');
  if(change.contracts.length)aside.append(asideSection('Contratos',change.contracts.map(reference=>mono(reference,'aside-reference'))));else missing.push('contratos');
  if(change.context.length)aside.append(asideSection('Contexto citado',change.context.map(path=>{const row=el('div','context-citation');row.append(button(documentName(path),'btn-text',()=>openDocument(path,{origin:change.id})),mono(path));return row;})));else missing.push('contexto');
  if(missing.length)aside.append(el('p','aside-note',`Sin datos en esta lectura: ${missing.join(', ')}.`));return aside;
}

function crumbs(path) {
  const entry = index.get(path);
  const items = [[snapshot.rootName, goHome]];
  if (entry.group === 'change') {
    const owner = entry.owner;
    items.push(owner.archived ? ['Archivados', () => openView('archived')] : ['HU en curso', () => openView('changes')]);
    items.push([owner.title || owner.id, () => openChange(owner.id)]);
    if (entry.item.kind === 'specs') items.push(['Specs', () => openChange(owner.id, 'specs')], [entry.item.label, null]);
    else items.push([documentName(path), null]);
  } else if (entry.group === 'spec') items.push(['Specs consolidadas', () => openView('specs')], [entry.item.label, null]);
  else items.push(['Contexto', () => openView('context')], [entry.item.title || entry.item.label, null]);
  const nav = el('nav', 'crumbs');
  nav.setAttribute('aria-label', 'Ubicación del documento');
  items.forEach(([label, onClick], position) => {
    if (position) nav.append(icon('arrow', 'crumb-separator'));
    const last = position === items.length - 1;
    const crumb = last ? el('span', 'crumb is-current', label) : button(label, 'crumb', onClick);
    if (!last) crumb.dataset.key = `crumb:${position}`;
    else crumb.setAttribute('aria-current', 'page');
    nav.append(crumb);
  });
  return nav;
}

function pinnedBar(origin) {
  const bar = el('div', 'pinned-hu');
  const back = button('Volver a la HU', 'btn-ghost pinned-back', () => openChange(origin.id), 'back');
  back.dataset.key = 'pinned-back';
  const tasks = origin.tasks ? `${origin.tasks.done}/${origin.tasks.total}` : artifactPresent(origin, 'tasks') === false ? 'falta' : 'por comprobar';
  bar.append(back, el('span', 'separator'), el('span', 'pinned-title', origin.title || origin.id), el('span', 'pinned-meta', index.get(state.selectedPath)?.item.kind === 'specs' ? 'Paso 2 de 4 · Specs' : `Tareas: ${tasks}`));
  return bar;
}

function readerView() {
  const path = state.selectedPath;
  const view = el('div', 'view-reader');
  const origin = findChange(state.readerOrigin) || (state.readerOrigin ? index.get(path)?.owner : null);
  if (origin) view.append(pinnedBar(origin));
  const bar = el('div', 'crumbbar');
  const actions = el('div', 'crumbbar-actions');
  const doc = documents.get(path);
  const isSpec = ['specs','spec'].includes(index.get(path)?.item.kind) || index.get(path)?.group === 'spec';
  const structured = isSpec && state.specMode === 'structured' && doc?.specStructure;
  const headings = structured ? structureHeadings(doc.specStructure) : (doc?.headings || []).filter(item => item.level >= 2 && item.level <= 4);
  if (isSpec) actions.append(segmented('Modo de lectura de spec', [['structured','Estructurada'],['markdown','Markdown']],state.specMode,value=>{state.specMode=value;persist();renderMain({preserveScroll:false});},'spec-mode'));
  const tocDrop = el('div', 'toc-drop');
  tocDrop.id = 'toc-drop';
  tocDrop.hidden = !ui.tocOpen;
  if (doc && headings.length) {
    const tocButton = action('btn btn-secondary btn-bar toc-button', () => {
      ui.tocOpen = !ui.tocOpen;
      tocDrop.hidden = !ui.tocOpen;
      tocButton.setAttribute('aria-expanded', String(ui.tocOpen));
    }, 'toc-button');
    tocButton.append('Índice');
    tocButton.setAttribute('aria-expanded', String(ui.tocOpen));
    tocButton.setAttribute('aria-controls', tocDrop.id);
    actions.append(tocButton);
  }
  const open = btn('Abrir Markdown', 'secondary', () => post('openSource', { path }), 'external');
  open.classList.add('btn-bar');
  open.dataset.key = 'open-source';
  open.disabled = !doc;
  actions.append(open);
  bar.append(crumbs(path), actions);
  view.append(bar);
  const node = makeScroller('reader-scroller');
  if (!doc || readErrors.has(path)) {
    const holder = el('div', 'reader-state');
    holder.append(documentSlot(path, () => el('div')));
    node.append(holder);
    view.append(node);
    return view;
  }
  state.lastRead = path;
  renderedDocument = doc;
  const grid = el('div', `reader-grid${headings.length ? ' has-toc' : ''}`);
  const column = el('div', 'reader-main');
  const article = structured ? structuredSpec(doc) : doc.tasksStructure ? tasksPanel(doc) : markdownArticle(doc, 'reader-article');
  if (!structured) column.append(documentMeta(doc));
  column.append(article);
  grid.append(column);
  if (headings.length) {
    const toc = el('nav', 'toc');
    toc.setAttribute('aria-label', isSpec ? 'En esta spec' : 'En este documento');
    toc.append(el('strong','toc-label',isSpec ? 'En esta spec' : 'En este documento'));
    tocDrop.setAttribute('aria-label', 'Índice del documento');
    for (const item of headings) {
      toc.append(tocEntry(item, node, 'toc-item'));
      tocDrop.append(tocEntry(item, node, 'toc-drop-item'));
    }
    const canonical=index.get(path)?.item.canonical;
    if(canonical){const info=el('div','toc-canonical'); info.append(el('strong','','Spec consolidada'),button(documentName(canonical),'btn-text',()=>openDocument(canonical,{origin:state.readerOrigin})),el('span','footnote','Así funciona hoy, antes de esta HU.'));toc.append(info);}
    grid.append(toc);
    view.append(tocDrop);
    requestAnimationFrame(() => observeHeadings(node, article));
  }
  node.append(grid);
  view.append(node);
  return view;
}

function tocEntry(item, scrollNode, className) {
  const entry = action(`${className} level-${item.level}${state.tocActive === item.id ? ' is-active' : ''}`, () => {
    const target = scrollNode.querySelector(`#${CSS.escape(item.id)}`);
    ++inputVersion;
    target?.scrollIntoView({ block: 'start' });
    setTocActive(item.id);
    if (className === 'toc-drop-item') {
      ui.tocOpen = false;
      document.getElementById('toc-drop')?.setAttribute('hidden', '');
      viewRoot.querySelector('.toc-button')?.setAttribute('aria-expanded', 'false');
    }
  });
  entry.dataset.tocId = item.id;
  entry.append(el('span', 'toc-rail'), el('span', 'toc-text', item.text));
  return entry;
}

function setTocActive(id) {
  if (!id || state.tocActive === id) return;
  state.tocActive = id;
  for (const node of viewRoot.querySelectorAll('[data-toc-id]')) {
    const active = node.dataset.tocId === id;
    node.classList.toggle('is-active', active);
    if (active) node.setAttribute('aria-current', 'location');
    else node.removeAttribute('aria-current');
  }
  persist();
}

function observeHeadings(scrollNode, article) {
  if (!scrollNode.isConnected || !('IntersectionObserver' in window)) return;
  const nodes = [...article.querySelectorAll('h2[id], h3[id], h4[id]')];
  if (!nodes.length) return;
  const visible = new Set();
  headingObserver?.disconnect();
  headingObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    let active = nodes.find(node => visible.has(node));
    if (!active) {
      const top = scrollNode.getBoundingClientRect().top;
      active = [...nodes].reverse().find(node => node.getBoundingClientRect().top < top) || nodes[0];
    }
    setTocActive(active.id);
  }, { root: scrollNode, rootMargin: '0px 0px -60% 0px', threshold: 0 });
  nodes.forEach(node => headingObserver.observe(node));
}

/* ---------- C · Contexto, specs y archivados ---------- */

function contextView() {
  const node = makeScroller();
  const page = el('div', 'page');
  const intents = snapshot.intents?.length ? snapshot.intents : null;
  const note = intents ? 'Intenciones definidas en docs/INDICE.md. Cada una indica por qué documento empezar.' : null;
  page.append(pageHeader(`Contexto del sistema · ${snapshot.rootName}`, intents ? '¿Qué necesitas entender?' : 'Contexto del sistema', note));
  if (intents) {
    const grid = el('div', 'intent-grid');
    for (const intent of intents) {
      const card = intent.path ? action('intent', () => openDocument(intent.path, { origin: null }), `intent:${intent.title}`) : el('div', 'intent is-static');
      const start = el('span', 'intent-start');
      if (intent.path) start.append(el('span','footnote','Empieza por'), el('strong','intent-document',documentName(intent.path)), mono(intent.path,'intent-path'),icon('arrow'));
      else start.append(el('strong','intent-missing','Sin documento enlazado'),el('span','footnote',`Para completarlo, añade un enlace en la sección «${intent.title}» de docs/INDICE.md.`));
      card.append(el('span', 'intent-title', intent.title), el('span', 'intent-description', intent.description || 'Sin descripción en docs/INDICE.md.'), start);
      grid.append(card);
    }
    page.append(grid);
  }
  const docsSection = el('section', 'page-section');
  docsSection.append(sectionTitle('Documentos de contexto', scopeCount('context')));
  if (snapshot.docs.length) docsSection.append(documentRows(snapshot.docs));
  else docsSection.append(inlineEmpty('Sin documentos en esta página', snapshot.pagination?.context?.status === 'error' || snapshot.pagination?.context?.status === 'partial' ? 'No se pudo completar la lectura del contexto.' : 'No se encontraron documentos en esta página de contexto.'));
  appendPagination(docsSection, 'context');
  page.append(docsSection);
  const components = el('section', 'page-section');
  components.append(sectionTitle('Componentes · repositorios.json', snapshot.repositories.length ? plural(snapshot.repositories.length, 'referencia') : null));
  if (snapshot.repositories.length) {
    const wrap=el('div','component-table'); const table=el('table'); const head=el('thead'); const header=el('tr');
    for(const title of ['Componente','Rol','HU leídas que lo mencionan']){const th=el('th','',title);th.scope='col';header.append(th);}head.append(header);table.append(head);const body=el('tbody');
    for(const repository of snapshot.repositories){const row=el('tr');const id=el('td');id.append(mono(repository.id));const role=el('td','',repository.role||'Sin información');const related=el('td');
      const changes=snapshot.changes.filter(change=>change.related.some(item=>item.id===repository.id));
      if(!changes.length)related.textContent='Sin información';else for(const change of changes)related.append(button(change.title||change.id,'btn-text',()=>openChange(change.id)));
      row.append(id,role,related);body.append(row);}table.append(body);wrap.append(table);
    components.append(wrap);
  } else components.append(inlineEmpty('Sin información', 'El S0 no tiene repositorios.json.'));
  page.append(components);
  node.append(page);
  return node;
}

function documentRows(items) {
  const list = el('div', 'doc-rows');
  for (const item of items) {
    const row = action('doc-row', () => openDocument(item.path, { origin: null }), `doc-row:${item.path}`);
    row.title = item.path;
    row.append(icon('file', 'doc-row-icon'), el('span', 'doc-row-title', item.title || item.label), mono(item.path, 'doc-row-path'));
    list.append(row);
  }
  return list;
}

function specsView() {
  const node=makeScroller();const page=el('div','page');page.append(pageHeader('Consulta','Specs · fuente de verdad','Capacidades documentadas en openspec/specs/.'));
  if(!snapshot.specs.length)page.append(inlineEmpty('Sin specs en esta página', snapshot.pagination?.specs?.status === 'error' || snapshot.pagination?.specs?.status === 'partial' ? 'No se pudo completar la lectura de las specs.' : 'No se encontraron especificaciones en esta página.'));
  for(const spec of snapshot.specs){const card=el('section','capability');card.append(button(spec.label,'capability-title btn-text',()=>openDocument(spec.path,{origin:null})),mono(spec.path,'footnote'));
    const counts=spec.specCounts;card.append(el('span','footnote',counts?`${counts.requirements} requisitos · ${counts.scenarios} escenarios`:'Sin información'));
    const changes=(spec.relatedChanges||[]).filter(change=>!change.archived);if(changes.length){card.append(el('strong','small-title','HU que la modifican'));for(const change of changes)card.append(button(change.title||change.id,'btn-text',()=>openChange(change.id)));}page.append(card);
  }appendPagination(page, 'specs');node.append(page);return node;
}

function archivedView() {
  const node = makeScroller();
  const page = el('div', 'page');
  page.append(pageHeader(null, 'Cambios archivados', ['Archivar consolida las specs en ', mono('openspec/specs/'), '. Un cambio archivado no demuestra despliegue.']));
  const archived = archivedChanges();
  if (archived.length) {
    const list = el('div', 'doc-rows');
    for (const change of archived) {
      const row = action('archive-row', () => openChange(change.id), `archive-row:${change.id}`);
      const name = el('span', 'archive-row-name');
      name.append(el('span', 'archive-row-title', change.title || change.id), mono(change.id, 'archive-row-id'), el('span','footnote',change.archivedAt ? `Archivado el ${change.archivedAt} · según el nombre de la carpeta` : 'Fecha de archivo: Sin información'));
      row.append(name, el('span', 'archive-row-tasks', change.loadState === 'unloaded' ? 'Documentos sin cargar · abrir para leer' : tasksLabel(change, { long: true })));
      list.append(row);
    }
    page.append(list);
  } else page.append(inlineEmpty('Sin HU archivadas en esta página', snapshot.pagination?.archive?.status === 'error' || snapshot.pagination?.archive?.status === 'partial' ? 'No se pudo completar la lectura del archivo.' : 'No se encontraron cambios archivados en esta página.'));
  appendPagination(page, 'archive');
  node.append(page);
  return node;
}

/* ---------- Links ---------- */

function resolveRelative(fromPath, href) {
  let file;
  try { file = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!file) return null;
  const parts = fromPath.split('/').slice(0, -1);
  for (const part of file.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function handleMarkdownLink(event, fromPath) {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href');
  if (!href || href === '#') return;
  if (href.startsWith('#')) {
    ++inputVersion;
    let id;
    try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
    const target = id ? event.currentTarget.querySelector(`#${CSS.escape(id)}`) : null;
    target?.scrollIntoView({ block: 'start' });
    return;
  }
  if (/^https?:\/\//i.test(href)) { post('link', { href }); return; }
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || /^[/\\]/.test(href)) return;
  const target = resolveRelative(fromPath, href);
  let fragment;
  try { fragment = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : undefined; } catch { fragment = undefined; }
  if (target && rememberDocument(target)) openDocument(target, { anchor: fragment });
  else if (/^(?:repositorios\.json|openspec\/config\.ya?ml)$/i.test(target || '')) post('openSource', { path: target });
  else showError(`El enlace apunta a ${target || href}, que no es una ruta Markdown relativa de este S0.`);
}

/* ---------- Diagrams ---------- */

function isDarkTheme() {
  const classes = document.body.classList;
  if (classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')) return false;
  return true;
}

const colorProbe = document.createElement('canvas').getContext('2d');
function hexColor(value) {
  if (!value || !colorProbe) return null;
  colorProbe.fillStyle = '#010203';
  colorProbe.fillStyle = value;
  const result = colorProbe.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(result) && (result !== '#010203' || /#010203/i.test(value)) ? result : null;
}

// Mermaid's base theme with the personal tokens; unparseable colors fall back to the built-in themes.
function mermaidConfig() {
  const computed = getComputedStyle(document.body);
  const dark = isDarkTheme();
  const read = name => hexColor(computed.getPropertyValue(name).trim());
  const colors = {
    background: read('--os-paper'), mainBkg: read('--os-band'), primaryColor: read('--os-band'), primaryTextColor: read('--os-text'),
    primaryBorderColor: read('--os-outline'), nodeBorder: read('--os-outline'), lineColor: read('--os-text2'), textColor: read('--os-text'),
    secondaryColor: read('--os-c2'), tertiaryColor: read('--os-head'), clusterBkg: read('--os-head'), clusterBorder: read('--os-divider'),
    edgeLabelBackground: read('--os-paper'), titleColor: read('--os-text'),
  };
  const base = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, flowchart: { htmlLabels: false }, fontFamily: computed.fontFamily || 'sans-serif' };
  if (Object.values(colors).some(value => !value)) return { ...base, theme: dark ? 'dark' : 'default' };
  return { ...base, theme: 'base', themeVariables: { ...colors, darkMode: dark, fontFamily: computed.fontFamily || 'sans-serif', fontSize: '13px' } };
}

function diagramKind(source) {
  const line = source.split(/\r?\n/).map(item => item.trim()).find(item => item && !item.startsWith('%%') && item !== '---');
  return (line || 'mermaid').split(/[\s;]/)[0] || 'mermaid';
}

function renderDiagrams(container, generation, scrollTarget, version) {
  const sources = [...container.querySelectorAll('pre.mermaid-source')];
  if (!sources.length) return;
  const docPath = container.dataset.path || wantedPath();
  const docTitle = documents.get(docPath)?.title || documentName(docPath);
  const diagrams = sources.map((source, position) => {
    const code = source.querySelector('code')?.textContent || source.textContent || '';
    const figure = el('figure', 'diagram');
    const bar = el('div', 'diagram-bar');
    const zoom = button('Ampliar', 'btn-ghost diagram-zoom', () => {});
    zoom.disabled = true;
    const codeId = `diagram-code-${generation}-${position}`;
    const toggle = button('Ver código', 'btn-ghost btn-muted diagram-toggle', () => {
      codeBlock.hidden = !codeBlock.hidden;
      toggle.setAttribute('aria-expanded', String(!codeBlock.hidden));
      toggle.querySelector('.button-label').textContent = codeBlock.hidden ? 'Ver código' : 'Ocultar código';
    });
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', codeId);
    bar.append(overline(`Diagrama · ${diagramKind(code)}`), zoom, toggle);
    const visual = el('div', 'diagram-visual');
    visual.setAttribute('role', 'img');
    visual.setAttribute('aria-label', 'Diagrama Mermaid');
    visual.append(el('span', 'diagram-loading', 'Dibujando diagrama…'));
    const codeBlock = el('pre', 'diagram-code');
    codeBlock.id = codeId;
    codeBlock.hidden = true;
    codeBlock.append(el('code', '', code));
    figure.append(bar, visual, codeBlock);
    source.replaceWith(figure);
    return { code, figure, visual, zoom, toggle, codeBlock };
  });
  diagramQueue = diagramQueue.catch(() => {}).then(async () => {
    if (generation !== diagramGeneration) return;
    try { await document.fonts?.ready; } catch { /* fonts are optional for layout */ }
    if (generation !== diagramGeneration) return;
    mermaid.initialize(mermaidConfig());
    for (const { code, figure, visual, zoom, toggle, codeBlock } of diagrams) {
      if (generation !== diagramGeneration || !figure.isConnected) return;
      const staging = el('div', 'diagram-staging');
      staging.setAttribute('aria-hidden', 'true');
      document.body.append(staging);
      try {
        const { svg } = await mermaid.render(`openspec-diagram-${++renderSequence}`, code, staging);
        if (generation !== diagramGeneration || !figure.isConnected) return;
        visual.innerHTML = svg;
        const svgNode = visual.querySelector('svg');
        if (svgNode) {
          svgNode.removeAttribute('height');
          svgNode.setAttribute('role', 'img');
          svgNode.setAttribute('aria-label', 'Diagrama Mermaid del documento');
          zoom.disabled = false;
          zoom.onclick = () => openDiagramDialog(svgNode, `Diagrama · ${docTitle}`, zoom);
        }
      } catch (error) {
        if (generation !== diagramGeneration || !figure.isConnected) return;
        const detail = String(error?.message || error).split('\n').slice(0, 3).join('\n');
        figure.classList.add('is-error');
        zoom.hidden = true;
        visual.removeAttribute('role');
        visual.removeAttribute('aria-label');
        const actions = el('div', 'state-actions');
        actions.append(btn('Abrir Markdown', 'primary', () => post('openSource', { path: docPath })), btn('Copiar error', 'secondary', () => {
          post('copyText', { text: detail });
          announce('Error del diagrama copiado.');
        }));
        visual.replaceChildren(el('strong', 'diagram-error-title', 'No se pudo dibujar este diagrama'), el('p', 'diagram-error-text', 'El texto del documento sigue legible. Puedes revisar el código original:'), el('pre', 'diagram-error-detail', detail), actions);
        codeBlock.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        toggle.querySelector('.button-label').textContent = 'Ocultar código';
      } finally {
        staging.remove();
        if (generation === diagramGeneration && version === inputVersion && scroller) scroller.scrollTop = scrollTarget;
      }
    }
  });
}

/* ---------- Structured reading, selection and local dialogs ---------- */

function applySettings(settings) {
  if ([14, 15, 16].includes(settings.readingSize)) state.readSize = settings.readingSize;
  if (['personal', 'editor'].includes(settings.surfaces)) state.surfaceMode = settings.surfaces;
  document.body.dataset.read = String(state.readSize);
  document.body.classList.toggle('os-surface-editor', state.surfaceMode === 'editor');
  persist();
}

function segmented(label, choices, selected, onSelect, className) {
  const group = el('div', `segmented ${className || ''}`.trim());
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  for (const [value, title] of choices) {
    const option = button(title, 'segment', () => onSelect(value));
    option.dataset.key = `segment:${label}:${value}`;
    option.setAttribute('aria-pressed', String(value === selected)); group.append(option);
  }
  return group;
}

function documentNote(note) {
  const box = el('div', 'document-note');
  box.append(el('strong', '', 'Nota del documento · '), note); return box;
}

function safeFragment(html, path, className = 'markdown-body') {
  const node = el('div', className);
  // Only sanitized fragments returned by the host parser are inserted as HTML.
  node.innerHTML = html || ''; prepareMarkdown(node, path); return node;
}

const OPERATIONS = { added: ['Requisitos añadidos', '+ Añadido'], modified: ['Requisitos modificados', 'Modificado'], removed: ['Requisitos eliminados', '− Eliminado'], renamed: ['Requisitos renombrados', 'Renombrado'] };

function structureHeadings(structure) {
  const headings = [];
  for (const group of structure.groups) {
    headings.push({ id: group.id, level: 2, text: `${OPERATIONS[group.op]?.[0] || 'Requisitos'} · ${group.requirements.length}` });
    for (const requirement of group.requirements) {
      headings.push({ id: requirement.id, level: 3, text: requirement.title });
      for (const scenario of requirement.scenarios) headings.push({ id: scenario.id, level: 4, text: scenario.title });
    }
  }
  return headings;
}

function structuredSpec(doc) {
  const article = el('article', 'reader-article structured-spec');
  const entry = index.get(doc.path); const delta = entry?.group === 'change';
  const meta = documentMeta(doc);
  if (entry?.item.label) meta.prepend(mono(entry.item.label, 'pill pill-kind spec-capability'));
  article.append(overline(delta ? 'Spec · delta de la HU' : 'Spec consolidada'), heading('h1', 'spec-title', doc.title || entry?.item.label), meta);
  if (delta && doc.delta) {
    const counts = el('div', 'delta-counts');
    for (const [key, label] of [['added','Añadidos'],['modified','Modificados'],['removed','Eliminados'],['renamed','Renombrados']]) {
      const cell = el('div', `delta-cell delta-${key}`); const caption = el('span', 'delta-caption'); caption.append(el('span','delta-square'),label);
      cell.append(caption,mono(doc.delta[key] || 0,`delta-value${doc.delta[key] ? '' : ' is-muted'}`)); counts.append(cell);
    } article.append(counts);
  }
  if (doc.specStructure.note) article.append(documentNote(doc.specStructure.note));
  for (const group of doc.specStructure.groups) {
    const headingNode = el('h2', 'spec-group-title', OPERATIONS[group.op]?.[0] || 'Requisitos'); headingNode.id = group.id;
    headingNode.append(mono(group.requirements.length)); article.append(headingNode);
    for (const requirement of group.requirements) {
      const card = el('section', 'requirement-card'); const head = el('div', 'requirement-head'); const meta = el('div', 'requirement-meta');
      if (delta && group.op) meta.append(pill(OPERATIONS[group.op][1],`delta-label delta-${group.op}`));
      meta.append(el('span','','Requisito'),el('span','scenario-count',`${requirement.scenarios.length} escenarios`));
      const title = el('h3','requirement-title',requirement.title);title.id=requirement.id;head.append(meta,title);card.append(head,safeFragment(requirement.statementHtml,doc.path,'markdown-body requirement-statement'));
      const canonical = entry?.item.canonical;
      if (delta && group.op === 'added') card.append(el('p','requirement-relation','Nuevo requisito propuesto en esta HU.'));
      if (delta && canonical) card.append(button(group.op === 'modified' ? 'Comparar con la consolidada' : 'Ver spec consolidada','btn-text requirement-link',()=>openDocument(canonical,{origin:entry.owner?.id})));
      requirement.scenarios.forEach((scenario, position) => {
        const section = el('section','scenario'); const head = el('div','scenario-head'); const title = el('h4','scenario-title',scenario.title);title.id=scenario.id;
        head.append(mono(`Escenario ${position+1}`),title);section.append(head);
        if(scenario.bodyHtml)section.append(safeFragment(scenario.bodyHtml,doc.path,'markdown-body scenario-body'));
        const steps=el('dl','scenario-steps');
        for(const step of scenario.steps){const term=el('dt','overline',({WHEN:'Cuando',THEN:'Entonces',AND:'Y',GIVEN:'Dado'})[step.keyword]||step.keyword);term.title=step.keyword;const detail=el('dd');detail.append(safeFragment(step.html,doc.path));steps.append(term,detail);}
        section.append(steps);card.append(section);
      });article.append(card);
    }
  }
  return article;
}

function tasksPanel(doc) {
  const data=doc.tasksStructure; const panel=el('section','tasks-panel');
  const summary=el('div','tasks-summary');summary.append(el('strong','',`${data.done} de ${data.total} casillas marcadas`),progressBar(data.done,data.total),el('span','footnote','Leído de tasks.md. Una casilla marcada no acredita pruebas ni aceptación.'));
  panel.append(summary,segmented('Filtrar tareas',[['all',`Todas · ${data.total}`],['pending',`Pendientes · ${data.total-data.done}`],['done',`Marcadas · ${data.done}`]],state.taskFilter,value=>{state.taskFilter=value;persist();renderMain({preserveScroll:true});},'task-filter'));
  if(data.note)panel.append(documentNote(data.note));
  let shown=0;
  for(const section of data.sections){const items=section.items.filter(item=>state.taskFilter==='all'||(state.taskFilter==='done'?item.done:!item.done));if(!items.length)continue;shown+=items.length;
    const box=el('section','task-section'); const header=el('div','task-section-head');header.append(el('h2','',section.title||'Tareas'),mono(`${section.done} de ${section.total}`),progressBar(section.done,section.total,'mini-progress'));box.append(header);
    for(const item of items){const row=el('div','task-row');const mark=el('span',`task-mark${item.done?' is-done':''}`);mark.setAttribute('aria-hidden','true');if(item.done)mark.append(icon('check'));
      row.append(mark,item.html?safeFragment(item.html,doc.path,'markdown-body task-text'):el('span','task-text',item.text),el('span','task-state',item.done?'Marcada':'Pendiente'));box.append(row);}
    panel.append(box);
  }
  if(!shown)panel.append(inlineEmpty('Sin tareas en este filtro','Prueba otra opción para consultar las casillas del documento.'));
  return panel;
}

function mountModal(dialog, scrimClass, opener, initialFocus, onClose) {
  closeDialog();closeMenu();
  const scrim=el('div',`dialog-scrim ${scrimClass}`);scrim.append(dialog);
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
  const targets=[titlebar,rail,workspace];targets.forEach(node=>{node.inert=true;});dialogLayer.append(scrim);
  dialogCleanup=()=>{dialogCleanup=null;scrim.remove();targets.forEach(node=>{node.inert=false;});onClose?.();if(opener?.isConnected)opener.focus();else viewRoot.querySelector('[data-autofocus]')?.focus({preventScroll:true});};
  scrim.addEventListener('pointerdown',event=>{if(event.target===scrim)closeDialog();});
  scrim.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDialog();return;}
    if(event.key!=='Tab')return;
    const focusable=[...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(node=>!node.hidden);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });requestAnimationFrame(()=>initialFocus?.focus());
}

function openGlossary() {
  const opener=document.activeElement;const dialog=el('aside','glossary-dialog');dialog.setAttribute('aria-label','Cómo leer este S0');
  const bar=el('div','glossary-bar');const close=button('Cerrar glosario (Esc)','btn-icon',closeDialog,'close',true);bar.append(el('h2','','Cómo leer este S0'),close);dialog.append(bar);
  const content=el('div','glossary-content');
  const groups=[['La plantilla',[
    ['S0','Carpeta de planificación del sistema. Reúne openspec/, el contexto en docs/ y repositorios.json.'],
    ['HU · cambio','Una historia de usuario. En OpenSpec se llama «cambio»: una carpeta con propuesta, specs, diseño y tareas.'],
    ['Spec consolidada','Cómo funciona hoy el sistema. Es la fuente de verdad, en openspec/specs/.'],
    ['Delta','Lo que una HU propone cambiar en una spec: requisitos añadidos, modificados, eliminados o renombrados.'],
    ['Archivo','HU archivadas. Al archivar, el delta se integra en la spec consolidada.']
  ]],['Dentro de una spec',[
    ['Requisito','Una regla del sistema. SHALL o MUST indican que es obligatoria.'],
    ['Escenario','Un ejemplo comprobable: cuando (WHEN) ocurre algo, entonces (THEN) el sistema responde así.']
  ]]];
  for(const [name,entries] of groups){const section=el('section');section.append(overline(name));for(const [title,description]of entries){const item=el('div');item.append(el('h3','',title),el('p','',description));section.append(item);}content.append(section);}
  const rules=el('section');rules.append(overline('Lo que este visor no afirma'));const list=el('ul');
  for(const rule of ['Un documento presente no significa que esté aprobado.','Una casilla marcada no acredita pruebas ni aceptación.','Archivado no significa desplegado.','Lo marcado como «Inferido» se deduce de los archivos; no es el estado oficial del workflow.'])list.append(el('li','',rule));
  rules.append(list);content.append(rules);dialog.append(content);
  mountModal(dialog,'glossary-scrim',opener,close,()=>{ui.glossaryOpen=false;});ui.glossaryOpen=true;
}

function openSearch() {
  if(ui.searchOpen){searchInput?.focus();return;}
  const opener=document.activeElement;const dialog=el('div','search-dialog');dialog.setAttribute('aria-label','Buscar en el S0');
  const field=el('div','search-dialog-field');searchInput=el('input','search-input');searchInput.type='search';searchInput.maxLength=200;searchInput.placeholder='Buscar en títulos y contenido…';searchInput.setAttribute('aria-label','Buscar en el S0');searchInput.value=ui.searchQuery;searchInput.autocomplete='off';
  const close=button('Cerrar búsqueda (Esc)','btn-icon',closeDialog,'close',true);field.append(icon('search'),searchInput,el('kbd','','Esc'),close);dialog.append(field);
  const scopeHolder=el('div','search-scopes');
  function scopes(){preserveFocus(scopeHolder,()=>scopeHolder.replaceChildren(segmented('Ámbito de búsqueda',[['all','Todo vigente'],['changes','HU en curso'],['specs','Specs'],['context','Contexto'],['archive','Archivo']],ui.searchScope,value=>{ui.searchScope=value;scopes();requestSearch();},'search-scope'),el('span','footnote',ui.searchScope === 'archive' ? 'Busca sólo en HU archivadas, incluidas las que aún no se abrieron.' : 'Busca más allá de la página visible. El archivo histórico tiene un filtro propio.')));}
  scopes();dialog.append(scopeHolder);searchResultsNode=el('div','search-results');searchResultsNode.setAttribute('role','listbox');searchResultsNode.setAttribute('aria-label','Resultados de búsqueda');searchInput.setAttribute('role','combobox');searchInput.setAttribute('aria-controls','search-results');searchInput.setAttribute('aria-expanded','true');searchResultsNode.id='search-results';dialog.append(searchResultsNode);
  const footer=el('div','search-footer');for(const [keys,label]of [['↑ ↓','moverse'],['Enter','abrir'],['Esc','cerrar']])footer.append(el('kbd','',keys),el('span','',label));dialog.append(footer);
  searchInput.addEventListener('input',()=>{ui.searchQuery=searchInput.value;clearTimeout(searchTimer);searchTimer=setTimeout(requestSearch,100);});
  searchInput.addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(ui.searchResults.length){ui.searchIndex=(ui.searchIndex+(event.key==='ArrowDown'?1:-1)+ui.searchResults.length)%ui.searchResults.length;highlightSearch();}}
    else if(event.key==='Enter'){event.preventDefault();selectSearch(ui.searchIndex);}
  });
  mountModal(dialog,'search-scrim',opener,searchInput,()=>{ui.searchOpen=false;clearTimeout(searchTimer);searchResultsNode=null;searchInput=null;});ui.searchOpen=true;requestSearch();
}

function requestSearch() {
  if(!ui.searchOpen)return;ui.searchResults=[];ui.searchIndex=0;searchInput?.removeAttribute('aria-activedescendant');
  searchResultsNode?.replaceChildren(el('p','search-empty',ui.searchQuery.trim()?'Buscando…':'Escribe para buscar documentos del S0.'));
  post('search',{query:ui.searchQuery,scope:ui.searchScope,requestId:++ui.searchRequest});
}

function highlightedSnippet(snippet,query) {
  const node=el('span','search-snippet');const value=String(snippet||'');const needle=query.trim().toLocaleLowerCase();if(!needle){node.textContent=value;return node;}
  let offset=0;const normalized=value.toLocaleLowerCase();let found;
  while((found=normalized.indexOf(needle,offset))!==-1){node.append(value.slice(offset,found),el('mark','',value.slice(found,found+needle.length)));offset=found+needle.length;}
  node.append(value.slice(offset));return node;
}

function receiveSearch(message) {
  if(!ui.searchOpen||message.requestId!==ui.searchRequest||message.query!==ui.searchQuery||message.scope!==ui.searchScope)return;
  ui.searchResults=(message.results||[]).filter(item=>typeof item.path === 'string');ui.searchIndex=0;searchResultsNode.replaceChildren();
  if(message.warnings?.length){const warning=el('div','search-warnings');warning.setAttribute('role','status');for(const text of message.warnings)warning.append(el('p','footnote',text));searchResultsNode.append(warning);}
  if(message.error){searchResultsNode.append(el('p','search-empty',message.error));return;}
  if(!ui.searchResults.length){searchResultsNode.append(el('p','search-empty',ui.searchQuery.trim()?'Sin coincidencias. Prueba otra palabra.':'Escribe para buscar documentos del S0.'));return;}
  let previousGroup=null;
  ui.searchResults.forEach((item,position)=>{
    const group=searchGroup(item);const groupLabel=({changes:'HU en curso',archive:'Archivo',specs:'Specs',context:'Contexto'})[group];
    if(group!==previousGroup){const count=ui.searchResults.filter(result=>searchGroup(result)===group).length;searchResultsNode.append(el('div','search-group',`${groupLabel} · ${count} documentos`));previousGroup=group;}
    const row=action('search-result',()=>selectSearch(position));row.id=`search-result-${position}`;row.setAttribute('role','option');row.tabIndex=-1;
    const label=({proposal:'Propuesta',design:'Diseño',tasks:'Tareas',spec:'Spec consolidada',specs:'Spec · delta',context:'Contexto'})[item.kind] || 'Markdown';
    const line=el('span','search-result-line');line.append(el('strong','',`${label} · ${item.title}`),mono(item.path.split('/').pop()),el('span','',`${item.count} coincidencias`));row.append(line,highlightedSnippet(item.snippet,ui.searchQuery));searchResultsNode.append(row);
  });highlightSearch();announce(`${ui.searchResults.length} documentos encontrados.`);
}

function searchGroup(item) {
  if (['changes', 'archive', 'specs', 'context'].includes(item.scope)) return item.scope;
  return item.path.startsWith('openspec/changes/archive/') ? 'archive' : item.path.startsWith('openspec/changes/') ? 'changes' : item.path.startsWith('openspec/specs/') ? 'specs' : 'context';
}

function highlightSearch() {
  for(const [position,row]of [...searchResultsNode.querySelectorAll('.search-result')].entries()){row.classList.toggle('is-active',position===ui.searchIndex);row.setAttribute('aria-selected',String(position===ui.searchIndex));}
  const row=searchResultsNode.querySelector(`#search-result-${ui.searchIndex}`);searchInput?.setAttribute('aria-activedescendant',row?.id||'');row?.scrollIntoView({block:'nearest'});
}

function selectSearch(position) {
  const result=ui.searchResults[position];if(!result)return;closeDialog();const entry=rememberDocument(result.path,result);openDocument(result.path,{origin:result.changeId||entry?.owner?.id||null,metadata:result});
}

document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}
  else if(event.key==='Escape'&&dialogCleanup){event.preventDefault();closeDialog();}
});

function closeDialog() {
  dialogCleanup?.();
}

function openDiagramDialog(source, title, opener) {
  closeDialog();
  const scrim = el('div', 'dialog-scrim');
  const dialog = el('div', 'dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'diagram-dialog-title');
  const bar = el('div', 'dialog-bar');
  const heading = el('span', 'dialog-title', title);
  heading.id = 'diagram-dialog-title';
  const zoomOut = button('Reducir', 'btn-square', () => setScale(scale - 0.25));
  zoomOut.querySelector('.button-label').textContent = '−';
  const value = mono('100 %', 'dialog-zoom');
  value.setAttribute('aria-live', 'polite');
  const zoomIn = button('Ampliar', 'btn-square', () => setScale(scale + 0.25));
  zoomIn.querySelector('.button-label').textContent = '+';
  const fit = button('Ajustar', 'btn btn-secondary btn-bar dialog-fit', () => setScale(fitScale()));
  const close = button('Cerrar (Esc)', 'btn-icon', () => dialogCleanup?.(), 'close', true);
  bar.append(heading, zoomOut, value, zoomIn, fit, close);
  const canvas = el('div', 'dialog-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Diagrama ampliado');
  // Mermaid scopes its styles and markers to the SVG id, so the copy gets its own consistent id.
  // The markup is the SVG Mermaid already produced in strict mode and the document already shows.
  canvas.innerHTML = source.id ? source.outerHTML.replaceAll(source.id, `${source.id}-ampliado`) : source.outerHTML;
  const svg = canvas.querySelector('svg');
  svg.style.maxWidth = 'none';
  dialog.append(bar, canvas, el('div', 'dialog-foot', 'Arrastra para desplazar · Ctrl + rueda para zoom · Esc para cerrar'));
  scrim.append(dialog);
  const box = source.viewBox?.baseVal;
  const rect = source.getBoundingClientRect();
  const base = { width: box?.width || rect.width || 600, height: box?.height || rect.height || 400 };
  let scale = 1;
  function setScale(next) {
    scale = Math.min(4, Math.max(0.25, Math.round(next * 100) / 100));
    svg.style.width = `${base.width * scale}px`;
    svg.style.height = `${base.height * scale}px`;
    value.textContent = `${Math.round(scale * 100)} %`;
  }
  function fitScale() {
    return Math.min((canvas.clientWidth - 48) / base.width, (canvas.clientHeight - 48) / base.height);
  }
  canvas.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setScale(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    canvas.scrollLeft = drag.left - (event.clientX - drag.x);
    canvas.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const endDrag = () => { drag = null; canvas.classList.remove('is-dragging'); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  scrim.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dialogCleanup?.(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), [tabindex="0"]')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  scrim.addEventListener('pointerdown', event => { if (event.target === scrim) dialogCleanup?.(); });
  const inertTargets = [titlebar, rail, workspace];
  inertTargets.forEach(node => { node.inert = true; });
  dialogLayer.append(scrim);
  dialogCleanup = () => {
    dialogCleanup = null;
    scrim.remove();
    inertTargets.forEach(node => { node.inert = false; });
    if (opener?.isConnected) opener.focus();
    else viewRoot.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  };
  requestAnimationFrame(() => {
    setScale(fitScale());
    close.focus();
  });
}

/* ---------- Host messages ---------- */

function normalizeSnapshot(incoming) {
  return {
    ...incoming,
    changes: (incoming.changes || []).map(change => ({
      ...change,
      documents: change.documents || [],
      artifacts: change.artifacts || [],
      tasks: Object.hasOwn(change, 'tasks') ? change.tasks : { done: 0, total: 0 },
      summary: change.summary || { sections: [], hasImpact: false },
      related: change.related || [],
      canonical: change.canonical || [],
      contracts: change.contracts || [],
      context: change.context || [],
    })),
    specs: incoming.specs || [],
    docs: incoming.docs || [],
    repositories: incoming.repositories || [],
    intents: Array.isArray(incoming.intents) ? incoming.intents : null,
    warnings: incoming.warnings || [],
  };
}

function validateState() {
  const change = findChange(state.selectedChange);
  if (state.selectedPath && !rememberDocument(state.selectedPath)) state.selectedPath = null;
  if (state.lastRead && !rememberDocument(state.lastRead)) state.lastRead = null;
  if (state.view === 'reader' && !state.selectedPath) state.view = 'home';
  if (change && change.loadState !== 'unloaded' && state.changeTab.startsWith('doc:') && !change.documents.some(item => item.path === state.changeTab.slice(4))) state.changeTab = 'summary';
  if (!state.changeTab.startsWith('doc:') && !['summary', 'proposal', 'specs', 'design', 'tasks'].includes(state.changeTab)) state.changeTab = 'summary';
}

function applySnapshot(message) {
  const incoming = message.snapshot;
  if (!incoming) return;
  const rootChanged = Boolean(incoming.rootPath && state.rootPath && state.rootPath !== incoming.rootPath);
  if (rootChanged) {
    Object.assign(state, { view: 'home', selectedChange: null, changeTab: 'summary', selectedPath: null, readerOrigin: null, lastRead: null, tocActive: null, scroll: 0, scrollKey: null });
    scrollMemory.clear();
    transientIndex.clear();
    pageRequests.clear(); changeRequests.clear(); loadErrors.clear(); retryPages.clear();
    pendingPath = null;
    pendingReveal = null; knowledgeIndex = null; graphPending = false; graphError = null; ++graphRequest;
    state.graph = { level: 'map', includeArchive: false, includeInferred: false };
    closeDialog();
  }
  if (!rootChanged && scroller && renderedSignature) scrollMemory.set(viewKey(), scroller.scrollTop);
  snapshot = normalizeSnapshot(incoming);
  const hadRequests = pageRequests.size || changeRequests.size;
  for (const [scope, page] of pageRequests) if (snapshot.pagination?.[scope]?.page === page) { pageRequests.delete(scope); loadErrors.delete(`page:${scope}`); retryPages.delete(`page:${scope}`); }
  for (const [id, page] of changeRequests) {
    const change = findChange(id);
    if (snapshot.selectedChangeId === id && change?.loadState !== 'unloaded' && (change?.documentPagination?.page ?? 0) === page) { changeRequests.delete(id); loadErrors.delete(`change:${id}`); retryPages.delete(`change:${id}`); }
  }
  const signature = JSON.stringify({ ...snapshot, readAt: null });
  if (signature !== snapshotSignature || hadRequests) {
    snapshotSignature = signature;
    ++snapshotVersion;
  }
  if (snapshot.rootPath) state.rootPath = snapshot.rootPath;
  if (ui.invalidRoot && snapshot.rootPath !== ui.invalidRoot.previousRoot) ui.invalidRoot = null;
  buildIndex();
  documents.clear();
  readErrors.clear();
  if (message.document?.path && rememberDocument(message.document.path)) documents.set(message.document.path, message.document);
  validateState();
  if (!snapshot.loading && snapshot.rootPath && state.view === 'change' && state.selectedChange && snapshot.selectedChangeId !== state.selectedChange && !loadErrors.has(`change:${state.selectedChange}`)) requestChange(state.selectedChange);
  refreshButton.classList.remove('is-refreshing');
  refreshButton.disabled = false;
  renderWarnings();
  renderChrome();
  const wanted = wantedPath();
  // A save elsewhere must not reset the document being read: keep it on screen and re-request it.
  if (wanted && !documents.has(wanted) && renderedDocument?.path === wanted) {
    documents.set(wanted, renderedDocument);
    pendingPath = null;
    requestDocument(wanted);
  }
  if (renderedSignature === mainSignature() && (!wanted || sameDocument(documents.get(wanted), renderedDocument))) return;
  renderMain({ preserveScroll: !rootChanged });
}

function applyDocument(doc) {
  if (!doc?.path || !rememberDocument(doc.path)) return;
  const wanted = wantedPath();
  if (pendingPath === doc.path) pendingPath = null;
  else if (doc.path !== wanted) return;
  documents.set(doc.path, doc);
  readErrors.delete(doc.path);
  if (doc.path !== wanted) return;
  if (sameDocument(doc, renderedDocument)) return;
  const refreshed = renderedDocument?.path === doc.path;
  clearError();
  renderMain({ preserveScroll: refreshed });
  if (!refreshed) announce(`Documento abierto: ${doc.title || documentName(doc.path)}`);
}

window.addEventListener('message', event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'snapshot') applySnapshot(message);
  else if (message.type === 'document') applyDocument(message.document);
  else if (message.type === 'settings') applySettings(message);
  else if (message.type === 'graphInvalidated') {
    if (message.rootPath !== snapshot?.rootPath) return;
    knowledgeIndex = null; graphPending = false; graphError = null; ++graphRequest;
    if (state.view === 'graph') { requestGraph(); renderMain(); }
  }
  else if (message.type === 'graph') {
    if (message.rootPath !== snapshot?.rootPath || message.requestId !== graphRequest) return;
    graphPending = false; graphError = message.error || null;
    if (!graphError && message.index?.schemaVersion === 1) knowledgeIndex = message.index;
    else if (!graphError) graphError = 'El índice recibido tiene un formato desconocido.';
    if (state.view === 'graph') renderMain();
  }
  else if (message.type === 'results') receiveSearch(message);
  else if (message.type === 'copyResult') announce(message.message || (message.ok ? 'Texto copiado.' : 'No se pudo copiar.'));
  else if (message.type === 'loadError') {
    if (message.scope) { retryPages.set(`page:${message.scope}`, pageRequests.get(message.scope)); pageRequests.delete(message.scope); loadErrors.set(`page:${message.scope}`, message.message || 'No se pudo cargar la página.'); }
    if (message.id) { retryPages.set(`change:${message.id}`, changeRequests.get(message.id)); changeRequests.delete(message.id); loadErrors.set(`change:${message.id}`, message.message || 'No se pudo cargar la HU.'); }
    ++snapshotVersion;
    renderChrome(); renderMain({ preserveScroll: true });
    announce(message.message || 'No se pudo completar la lectura.');
  }
  else if (message.type === 'invalidRoot') {
    refreshButton.classList.remove('is-refreshing');
    refreshButton.disabled = false;
    ui.invalidRoot = { path: String(message.path || ''), codeRepository: Boolean(message.codeRepository), previousRoot: snapshot?.rootPath || '' };
    closeDialog();
    renderChrome();
    renderMain({ navigation: true });
    announce('La carpeta elegida no contiene OpenSpec.');
  } else if (message.type === 'error') {
    refreshButton.classList.remove('is-refreshing');
    refreshButton.disabled = false;
    const failed = typeof message.path === 'string' ? message.path : null;
    if (failed && failed === pendingPath) {
      pendingPath = null;
      readErrors.set(failed, message.message || 'No se pudo leer el archivo.');
      if (failed === wantedPath()) renderMain();
      announce(`No se pudo leer ${failed.split('/').pop()}.`);
    } else {
      showError(message.message || 'No se pudo leer el archivo. Actualiza para volver a intentarlo.');
      announce('Ocurrió un error al leer los archivos.');
    }
  }
});

let themeSignature = `${document.body.className}|${document.body.dataset.vscodeThemeId || ''}`;
new MutationObserver(() => {
  const next = `${document.body.className}|${document.body.dataset.vscodeThemeId || ''}`;
  if (next === themeSignature) return;
  themeSignature = next;
  // Diagrams take their colors from the active theme, so they are drawn again.
  if (viewRoot.querySelector('.diagram')) renderMain({ preserveScroll: true });
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id', 'data-vscode-theme-kind'] });

renderChrome();
renderMain();
post('ready');
