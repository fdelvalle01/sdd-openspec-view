import { lstat, open, stat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { countDiagrams, countTasks, deltaCounts, documentTitle, markdownReferences, markdownSections, renderDocument, renderMarkdown, searchableText, specStructure, tableIntents, tasksStructure } from './markdown.js';
export { countTasks } from './markdown.js';

const MAX_BYTES = 1024 * 1024;
const MAX_INDEX_FILES = 2000;
const MAX_DEPTH = 12;
const TITLE_BYTES = 16 * 1024;
const MAX_INTENTS = 12;
const MAX_INDEX_BYTES = 32 * MAX_BYTES;
const PAGE_SIZES = { changes: 50, archive: 50, specs: 100, context: 100, documents: 100 };
const CURRENT_SCOPES = ['changes', 'specs', 'context'];
const CORE_DOCUMENTS = { 'proposal.md': ['proposal', 'Propuesta'], 'design.md': ['design', 'Diseño'], 'tasks.md': ['tasks', 'Tareas'], 'revision.md': ['other', 'Revisión registrada'] };
const searchIndexes = new WeakMap();
const ROOT_MARKERS = [['openspec/config.yaml', 'file'], ['openspec/config.yml', 'file'], ['openspec/changes', 'directory'], ['openspec/specs', 'directory']];
const SUMMARY_SECTIONS = [
  ['why', 'Por qué', /^(por que|why)\b/],
  ['what', 'Qué cambia', /^(que cambi|what chang)/],
  ['capabilities', 'Capacidades', /^(capacidades|capabilities)\b/],
  ['impact', 'Impacto', /^(impacto|impact)\b/],
  ['outOfScope', 'Fuera de alcance', /^(fuera de alcance|out of scope|non[- ]?goals)\b/],
];
const CONTRACT_REFERENCE = /(contract|contrato|openapi|asyncapi|swagger|\.proto\b|\.avsc\b|\.graphql\b)/i;
const HU_GUIDE = /(^|\/)(guia|trabajar)[-_]?hu[^/]*\.md$/i;
const ignored = new Set(['.git', 'node_modules', '.local', '.obsidian', '.env', '.ssh', '.aws']);
const portable = value => value.split(path.sep).join('/');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const info = async file => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } };
async function safePath(root, relative, fileOnly = false, maxBytes = MAX_BYTES) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || /^[/\\]/.test(relative) || relative.includes(':')) throw new Error('Ruta de documento inválida.');
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.some(p => p === '..' || ignored.has(p.replace(/[ .]+$/, '').toLowerCase()) || /^\.env(?:\.|$)/i.test(p)
    || p !== '.' && (/[ .]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) throw new Error('El documento debe estar dentro de la carpeta S0 y fuera de rutas privadas o alias ambiguos.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const entry = await info(current);
    if (!entry) throw new Error('El documento ya no existe. Actualiza el visor.');
    if (entry.isSymbolicLink()) throw new Error('El visor no sigue enlaces simbólicos ni junctions.');
  }
  const resolved = await realpath(current);
  if (!inside(root, resolved)) throw new Error('El documento queda fuera de S0.');
  const entry = await stat(resolved);
  if (fileOnly && !entry.isFile()) throw new Error('La ruta no es un archivo.');
  if (entry.size > maxBytes) throw new Error('El documento supera el límite de lectura de 1 MiB de esta POC.');
  return { resolved, entry };
}

// Title from the first bytes only: listing context and specs must not read whole documents.
async function headTitle(root, relative, fallback) {
  try {
    const { resolved } = await safePath(root, relative, true);
    const handle = await open(resolved, 'r');
    try {
      const buffer = Buffer.alloc(TITLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, TITLE_BYTES, 0);
      return documentTitle(buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, ''), fallback);
    } finally { await handle.close(); }
  } catch { return fallback; }
}

const normalizeHeading = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[¿?¡!:.]/g, '').trim();
const firstSentence = value => {
  const text = value.trim();
  const match = /^(.+?[.!?])(?=\s|$)/su.exec(text);
  return (match ? match[1] : text).slice(0, 320);
};

// Resolves a relative Markdown link against the document that contains it; external links return null.
export function resolveLink(fromPath, href) {
  if (typeof href !== 'string' || !href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href) || /^[/\\]/.test(href)) return null;
  let file;
  try { file = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!file) return null;
  const parts = fromPath.split('/').slice(0, -1);
  for (const part of file.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/') || null;
}

// Extract of the proposal sections shown in the change summary, plus the first sentence used as purpose.
export function proposalSummary(source) {
  const found = new Map();
  for (const section of markdownSections(source)) {
    if (section.level !== 2) continue;
    const match = SUMMARY_SECTIONS.find(([, , pattern]) => pattern.test(normalizeHeading(section.title)));
    if (!match || found.has(match[0])) continue;
    found.set(match[0], { key: match[0], label: match[1], html: renderMarkdown(section.body), text: section.text, firstParagraph: section.firstParagraph });
  }
  const sections = SUMMARY_SECTIONS.map(([key]) => found.get(key)).filter(Boolean);
  const origin = found.get('what') || found.get('why');
  return { sections, purpose: origin ? firstSentence(origin.firstParagraph || origin.text) : '' };
}

// Contracts are listed only when the proposal links or names a contract file explicitly.
export function contractReferences(source) {
  const { links, code } = markdownReferences(source);
  return [...new Set([...links, ...code].map(value => value.trim()).filter(value => value && CONTRACT_REFERENCE.test(value)))].slice(0, 12);
}

// Repository ids from repositorios.json that appear as whole words in the impact text.
export function relatedComponents(impactText, repositories) {
  if (!impactText) return [];
  return repositories.filter(repository => {
    const escaped = repository.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, 'i').test(impactText);
  }).map(({ id, role }) => ({ id, role }));
}

// Deterministic suggestion derived only from the files present; never an official workflow state.
export function nextStep(change) {
  const has = kind => change.artifacts.some(artifact => artifact.id === kind && artifact.present);
  const review = change.revision ? ['revision.md presente; contenido no verificado'] : [];
  if (change.archived) {
    return { title: 'Consultar las specs consolidadas', detail: 'La carpeta está en el archivo. Consulta openspec/specs/ para comprobar los requisitos vigentes; la ubicación no acredita consolidación ni despliegue.', basis: ['La carpeta del cambio está en openspec/changes/archive/'] };
  }
  if (change.loadState === 'unloaded' || change.loadState === 'error' || change.artifacts.some(artifact => artifact.present === null) || change.tasks === null || change.documents?.some(document => ['proposal', 'design', 'tasks'].includes(document.kind) && document.loadState && document.loadState !== 'loaded')) {
    return { title: 'Completar la lectura de la HU', detail: 'Hay información sin cargar o no legible. No se puede inferir qué documentos faltan ni el siguiente paso.', basis: ['Lectura incompleta; consulta las advertencias y abre la HU'] };
  }
  const { done, total } = change.tasks;
  if (!has('proposal')) {
    return { title: 'Generar la propuesta', detail: 'La carpeta del cambio no tiene proposal.md. Se genera fuera del visor con las skills de OpenSpec.', basis: ['proposal.md no existe en la carpeta del cambio'] };
  }
  if (!has('specs')) {
    const missing = ['design', 'tasks'].filter(kind => !has(kind)).map(kind => `${kind}.md`);
    return {
      title: 'Generar specs',
      detail: missing.length === 2 ? 'La propuesta existe; faltan especificaciones, diseño y tareas. Se generan fuera del visor.' : 'La propuesta existe; faltan especificaciones. Se generan fuera del visor.',
      basis: ['Sin carpeta specs/ en el cambio', ...(missing.length ? [`${missing.join(' y ')} no existe${missing.length > 1 ? 'n' : ''}`] : [])],
    };
  }
  if (!has('tasks')) {
    const design = has('design');
    return {
      title: design ? 'Generar tareas' : 'Generar diseño y tareas',
      detail: 'Se preparan con las skills de OpenSpec (Claude o Codex), fuera del visor. Después, el equipo revisa alcance funcional y técnico antes de autorizar la implementación.',
      basis: [...(design ? [] : ['design.md no existe en la carpeta del cambio']), 'tasks.md no existe en la carpeta del cambio'],
    };
  }
  if (!total) return { title: 'Revisar tasks.md', detail: 'tasks.md existe, pero no contiene casillas de tarea reconocibles.', basis: ['tasks.md: sin casillas', ...review] };
  if (done < total) {
    const pending = total - done;
    return { title: 'Continuar tareas pendientes', detail: `Quedan ${pending} casilla${pending === 1 ? '' : 's'} sin marcar en tasks.md. Las casillas no acreditan pruebas ni aceptación.`, basis: [`tasks.md: ${done} de ${total} casillas marcadas`, ...review] };
  }
  return { title: 'Revisar antes de archivar', detail: 'Todas las casillas de tasks.md están marcadas. Las casillas no acreditan pruebas ejecutadas ni aceptación.', basis: [`tasks.md: ${total} de ${total} casillas marcadas`, ...review] };
}

// docs/INDICE.md format: each H2 is an intention, its first paragraph the description and its first link the starting document.
export function parseIntents(source, fromPath = 'docs/INDICE.md') {
  const tables = tableIntents(source);
  if (tables.length) return tables.slice(0, MAX_INTENTS).map(item => ({ ...item, path: item.href ? resolveLink(fromPath, item.href) : null }));
  return markdownSections(source).filter(section => section.level === 2 && section.title).slice(0, MAX_INTENTS).map(section => {
    const href = section.links[0] || null;
    return { title: section.title, description: section.firstParagraph, href, path: href ? resolveLink(fromPath, href) : null };
  });
}

async function textAt(root, relative) {
  const { resolved } = await safePath(root, relative, true);
  const handle = await open(resolved, 'r');
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > MAX_BYTES) throw new Error('El documento supera el límite de lectura de 1 MiB de esta POC.');
    // Read at most the limit plus one byte even if the file grows after stat.
    const content = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('El documento supera el límite de lectura de 1 MiB de esta POC.');
    return { source: content.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''), entry };
  } finally { await handle.close(); }
}

export function contextDescription(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex(line => /^context:\s*\|[+-]?\s*(?:#.*)?$/.test(line));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (!/^ +\S/.test(line)) return null;
    return line.trim().slice(0, 600);
  }
  return null;
}

export function archiveDate(folder) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-|$)/.exec(folder);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

const countsOfSpec = structure => ({
  requirements: structure.groups.reduce((total, group) => total + group.requirements.length, 0),
  scenarios: structure.groups.reduce((total, group) => total + group.requirements.reduce((count, requirement) => count + requirement.scenarios.length, 0), 0),
});

export async function isOpenSpecRoot(candidate) {
  try {
    const root = await realpath(candidate);
    const directory = await info(path.join(root, 'openspec'));
    if (!directory?.isDirectory() || directory.isSymbolicLink()) return false;
    for (const name of ['config.yaml', 'config.yml', 'changes', 'specs']) {
      const entry = await info(path.join(root, 'openspec', name));
      if (entry && !entry.isSymbolicLink() && (name.startsWith('config.') ? entry.isFile() : entry.isDirectory())) return true;
    }
    return false;
  } catch { return false; }
}

export async function readDocument(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || !/\.md$/i.test(relativePath)) throw new Error('El visor sólo abre documentos Markdown.');
  const root = await realpath(rootPath);
  const { source, entry } = await textAt(root, relativePath);
  const { html, headings } = renderDocument(source);
  const file = portable(path.relative(root, path.resolve(root, relativePath.replaceAll('\\', '/'))));
  const isSpec = /^openspec\/(?:specs\/|changes\/[^]+\/specs\/)/.test(file) && /\/spec\.md$/i.test(file);
  const structure = isSpec ? specStructure(source) : null;
  return { path: file, title: documentTitle(source, path.basename(relativePath, '.md')), html, headings, modifiedAt: entry.mtime.toISOString(), diagramCount: countDiagrams(source), specStructure: structure?.groups.length ? structure : null, tasksStructure: /\/tasks\.md$/i.test(file) ? tasksStructure(source) : null, ...(isSpec ? { specCounts: countsOfSpec(structure), delta: deltaCounts(source) } : {}) };
}

// Same containment rules as readDocument, without the reading limit: the editor opens the file itself.
export async function locateDocument(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || !(/\.md$/i.test(relativePath) || /^(?:repositorios\.json|openspec\/config\.ya?ml)$/i.test(relativePath))) throw new Error('El visor sólo abre Markdown y la configuración permitida de S0.');
  const root = await realpath(rootPath);
  return (await safePath(root, relativePath, true, Infinity)).resolved;
}

// Enumeration is independent from content loading. Each area owns its page and budget.
function explorer(root, warn) {
  const state = { issues: 0 };
  const issue = message => { state.issues++; warn(message); };
  async function directory(relative) {
    try {
      const entry = await info(path.join(root, relative));
      if (entry?.isSymbolicLink()) { issue(`No se explora ${portable(relative)}: el visor no sigue enlaces simbólicos ni junctions.`); return []; }
      if (!entry?.isDirectory()) return [];
      const { resolved } = await safePath(root, relative, false, Infinity);
      return (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch { issue(`No se pudo explorar ${portable(relative)}; su contenido no se considera ausente.`); return []; }
  }
  async function* walk(relative, depth = 0) {
    if (depth > MAX_DEPTH) { issue(`Exploración parcial de ${portable(relative)}: profundidad máxima ${MAX_DEPTH}.`); return; }
    for (const entry of await directory(relative)) {
      if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
      const child = portable(path.join(relative, entry.name));
      if (entry.isDirectory()) yield* walk(child, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) yield child;
    }
  }
  async function probe(relative, type = 'file') {
    try {
      const entry = await info(path.join(root, relative));
      if (!entry) return false;
      await safePath(root, relative, type === 'file', Infinity);
      return type === 'file' ? entry.isFile() : entry.isDirectory();
    } catch { issue(`No se pudo comprobar ${portable(relative)}; su presencia es desconocida.`); return null; }
  }
  return { directory, walk, probe, state, issue };
}

function pageNumber(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error('Página inválida.');
  return value;
}

function changeIdentity(id) {
  if (typeof id !== 'string') throw new Error('Identificador de HU inválido.');
  const parts = id.split('/');
  if (!(parts.length === 1 || (parts.length === 2 && parts[0] === 'archive')) || (parts.length === 1 && parts[0] === 'archive') || parts.some(part => !part || part.startsWith('.') || /[\\:\0]/.test(part))) throw new Error('Identificador de HU inválido.');
  return { id, archived: parts.length === 2, folder: `openspec/changes/${id}` };
}

async function collectPage(iterable, page, pageSize, state) {
  const items = [];
  let visited = 0, hasMore = false;
  const offset = page * pageSize;
  for await (const item of iterable) {
    if (visited++ < offset) continue;
    if (items.length === pageSize) { hasMore = true; break; }
    items.push(item);
  }
  return { items, pagination: { page, pageSize, loaded: items.length, hasMore, hasPrevious: page > 0, total: hasMore || state.issues ? null : visited, status: state.issues ? (items.length ? 'partial' : 'error') : 'loaded' } };
}

async function* changeFolders(scan, archived) {
  const relative = archived ? 'openspec/changes/archive' : 'openspec/changes';
  for (const entry of await scan.directory(relative)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || (!archived && entry.name === 'archive')) continue;
    yield { id: archived ? `archive/${entry.name}` : entry.name, folder: `${relative}/${entry.name}`, archived };
  }
}

async function* scopeFiles(scan, scope) {
  if (scope === 'changes' || scope === 'archive') {
    for await (const change of changeFolders(scan, scope === 'archive')) yield* scan.walk(change.folder);
  } else if (scope === 'specs') yield* scan.walk('openspec/specs');
  else {
    for (const file of ['AGENTS.md', 'README.md']) if (await scan.probe(file)) yield file;
    yield* scan.walk('docs');
  }
}

function documentDescriptor(file, scope, folder) {
  if (folder) {
    const relative = file.slice(folder.length + 1);
    if (CORE_DOCUMENTS[relative]) return { path: file, kind: CORE_DOCUMENTS[relative][0], label: CORE_DOCUMENTS[relative][1] };
    return relative.startsWith('specs/') ? { path: file, kind: 'specs', label: relative.slice(6).replace(/\/spec\.md$/, '') } : { path: file, kind: 'other', label: relative };
  }
  return { path: file, kind: scope === 'specs' ? 'spec' : 'context', label: scope === 'specs' ? file.slice('openspec/specs/'.length).replace(/\/spec\.md$/, '') : file };
}

const artifactNames = [['proposal', 'Propuesta'], ['specs', 'Especificación'], ['design', 'Diseño'], ['tasks', 'Tareas']];
function changeStub(identity) {
  return { ...identity, title: identity.id.replace(/^archive\//, ''), archivedAt: identity.archived ? archiveDate(path.basename(identity.folder)) : null,
    loadState: 'unloaded', documents: [], documentPagination: null, artifacts: artifactNames.map(([id, label]) => ({ id, label, present: null, count: null })),
    tasks: null, updatedAt: null, revision: null, summary: { sections: [], hasImpact: false }, purpose: '', capabilities: [], contracts: [], related: [], canonical: [], context: [], next: null };
}

function contentBudget(label, warn) {
  let bytes = 0, warned = false;
  return async (root, file) => {
    const { entry } = await safePath(root, file, true);
    if (bytes + entry.size > MAX_INDEX_BYTES) {
      if (!warned) warn(`${label}: lectura parcial; límite de 32 MiB. Los documentos sin leer no se consideran ausentes.`);
      warned = true; return null;
    }
    const result = await textAt(root, file);
    bytes += Buffer.byteLength(result.source, 'utf8');
    if (bytes > MAX_INDEX_BYTES) { if (!warned) warn(`${label}: lectura parcial; límite de 32 MiB.`); warned = true; return null; }
    return result;
  };
}

async function hydrateChange(root, identity, scan, page, readContent) {
  const change = changeStub(identity);
  const before = scan.state.issues;
  if (await scan.probe(identity.folder, 'directory') !== true) return { ...change, loadState: 'error', error: 'No se pudo cargar la carpeta de esta HU.' };
  const core = {};
  for (const name of Object.keys(CORE_DOCUMENTS)) core[name] = await scan.probe(`${identity.folder}/${name}`);
  async function* variableFiles() {
    for await (const file of scan.walk(identity.folder)) if (!Object.hasOwn(CORE_DOCUMENTS, file.slice(identity.folder.length + 1))) yield file;
  }
  const selected = await collectPage(variableFiles(), page, PAGE_SIZES.documents, scan.state);
  const pinned = Object.keys(core).filter(name => core[name] === true).map(name => `${identity.folder}/${name}`);
  change.documents = [...pinned, ...selected.items].map(file => documentDescriptor(file, null, identity.folder));
  const order = ['proposal', 'specs', 'design', 'tasks', 'other'];
  change.documents.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path));
  change.documentPagination = { ...selected.pagination, pinned: pinned.length };
  const beforeSpecs = scan.state.issues;
  let hasSpecs = false;
  for await (const file of scan.walk(`${identity.folder}/specs`)) { hasSpecs = true; break; }
  if (!hasSpecs && scan.state.issues > beforeSpecs) hasSpecs = null;
  change.artifacts = artifactNames.map(([id, label]) => ({ id, label, present: id === 'specs' ? hasSpecs : core[`${id}.md`],
    count: id === 'specs' ? (page === 0 && !selected.pagination.hasMore && scan.state.issues === before ? change.documents.filter(doc => doc.kind === 'specs').length : null) : core[`${id}.md`] === null ? null : Number(core[`${id}.md`]) }));
  change.tasks = core['tasks.md'] === false ? { total: 0, done: 0 } : null;
  change.revision = core['revision.md'];
  let summary = { sections: [], purpose: '' };
  let incomplete = selected.pagination.hasMore || page > 0;
  let failures = 0;
  const coreDocument = document => Object.hasOwn(CORE_DOCUMENTS, document.path.slice(identity.folder.length + 1));
  // Pinned planning artifacts get first access to this HU's remaining read budget.
  for (const document of [...change.documents.filter(coreDocument), ...change.documents.filter(document => !coreDocument(document))]) {
    document.loadState = 'unloaded';
    try {
      const value = await readContent(root, document.path);
      if (!value) { incomplete = true; continue; }
      const { source, entry } = value;
      document.loadState = 'loaded';
      if (document.kind === 'proposal') { change.title = documentTitle(source, change.title); summary = proposalSummary(source); change.contracts = contractReferences(source); change.proposalLinks = markdownReferences(source).links.map(href => resolveLink(document.path, href)).filter(Boolean); }
      if (document.kind === 'tasks') change.tasks = countTasks(source);
      if (document.kind === 'design') document.diagramCount = countDiagrams(source);
      if (document.kind === 'specs') { document.delta = deltaCounts(source); document.specCounts = countsOfSpec(specStructure(source)); Object.assign(document, document.specCounts); }
      if (!change.updatedAt || entry.mtime.toISOString() > change.updatedAt) change.updatedAt = entry.mtime.toISOString();
    } catch (error) { failures++; incomplete = true; document.loadState = 'error'; document.error = error.message; scan.issue(`${document.path}: ${error.message}`); }
  }
  change.capabilities = change.documents.filter(doc => doc.kind === 'specs' && /\/spec\.md$/.test(doc.path)).map(doc => doc.label);
  change.purpose = summary.purpose;
  change.summary = summary;
  change.loadState = failures && failures === change.documents.length ? 'error' : incomplete || scan.state.issues > before ? 'partial' : 'loaded';
  if (scan.state.issues > before || incomplete) change.documentPagination.status = 'partial';
  return change;
}

export async function scanRoot(rootPath, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Opciones de exploración inválidas.');
  if (Object.keys(options).some(key => !['pages', 'selectedChange', 'changePage'].includes(key))) throw new Error('Opciones de exploración inválidas.');
  if (options.pages !== undefined && (!options.pages || typeof options.pages !== 'object' || Array.isArray(options.pages))) throw new Error('Páginas inválidas.');
  if (Object.keys(options.pages || {}).some(key => ![...CURRENT_SCOPES, 'archive'].includes(key))) throw new Error('Ámbito de página inválido.');
  const pages = Object.fromEntries([...CURRENT_SCOPES, 'archive'].map(scope => [scope, pageNumber(options.pages?.[scope])]));
  const selectedIdentity = options.selectedChange == null ? null : changeIdentity(options.selectedChange);
  const changePage = pageNumber(options.changePage);
  if (!await isOpenSpecRoot(rootPath)) throw new Error('Elige la raíz del proyecto que contiene openspec/config.yaml, openspec/changes o openspec/specs.');
  const root = await realpath(rootPath);
  const warnings = [];
  const warn = message => { if (warnings.length < 40 && !warnings.includes(message)) warnings.push(message); };
  const scans = Object.fromEntries([...CURRENT_SCOPES, 'archive'].map(scope => [scope, explorer(root, warn)]));
  const pagination = {};
  const changes = [];
  const readActive = contentBudget('HU activas', warn);
  const readSelected = contentBudget('HU seleccionada', warn);
  for (const scope of ['changes', 'archive']) {
    const page = await collectPage(changeFolders(scans[scope], scope === 'archive'), pages[scope], PAGE_SIZES[scope], scans[scope].state);
    pagination[scope] = { ...page.pagination, ids: page.items.map(change => change.id) };
    for (const identity of page.items) {
      const selected = selectedIdentity?.id === identity.id;
      changes.push(scope === 'archive' && !selected ? changeStub(identity) : await hydrateChange(root, identity, scans[scope], selected ? changePage : 0, selected ? readSelected : readActive));
    }
    if (pagination[scope].status !== 'error' && (scans[scope].state.issues || changes.some(change => change.archived === (scope === 'archive') && ['partial', 'error'].includes(change.loadState)))) pagination[scope].status = 'partial';
  }
  if (selectedIdentity && !changes.some(change => change.id === selectedIdentity.id)) changes.push(await hydrateChange(root, selectedIdentity, scans[selectedIdentity.archived ? 'archive' : 'changes'], changePage, readSelected));
  const specsPage = await collectPage(scopeFiles(scans.specs, 'specs'), pages.specs, PAGE_SIZES.specs, scans.specs.state);
  const docsPage = await collectPage(scopeFiles(scans.context, 'context'), pages.context, PAGE_SIZES.context, scans.context.state);
  pagination.specs = specsPage.pagination;
  pagination.context = docsPage.pagination;
  const specs = specsPage.items.map(file => documentDescriptor(file, 'specs'));
  const docs = docsPage.items.map(file => documentDescriptor(file, 'context'));
  const readSpecs = contentBudget('Specs', warn);
  for (const document of [...specs, ...docs]) document.title = await headTitle(root, document.path, document.label);
  for (const document of docs) {
    try { await safePath(root, document.path, true); document.loadState = 'loaded'; }
    catch (error) { document.loadState = 'error'; document.error = error.message; warn(`${document.path}: ${error.message}`); pagination.context.status = 'partial'; }
  }
  for (const document of specs) {
    try {
      const value = await readSpecs(root, document.path);
      document.loadState = value ? 'loaded' : 'unloaded';
      document.specCounts = value ? countsOfSpec(specStructure(value.source)) : null;
      if (document.specCounts) Object.assign(document, document.specCounts);
      else pagination.specs.status = 'partial';
    } catch (error) { warn(`${document.path}: ${error.message}`); document.loadState = 'error'; document.specCounts = null; pagination.specs.status = 'partial'; }
  }
  const metadata = explorer(root, warn);
  let rootMarker = null;
  for (const [marker, type] of ROOT_MARKERS) if (await metadata.probe(marker, type)) { rootMarker = marker; break; }
  const indice = await metadata.probe('docs/INDICE.md');
  let intents = null;
  if (indice) { try { intents = parseIntents((await textAt(root, 'docs/INDICE.md')).source); } catch (error) { warn(`docs/INDICE.md: ${error.message}`); } }
  let rootName = path.basename(root), repositories = [];
  const inventory = await metadata.probe('repositorios.json');
  if (inventory) {
    try {
      const data = JSON.parse((await textAt(root, 'repositorios.json')).source);
      if (!data || !Array.isArray(data.repositories)) throw new Error('Se esperaba un objeto con repositories[].');
      if (typeof data.system === 'string' && data.system.trim()) rootName = data.system.trim();
      repositories = data.repositories.slice(0, 200).filter(r => r && typeof r.id === 'string').map(r => ({ id: r.id, role: typeof r.role === 'string' ? r.role : '', url: typeof r.url === 'string' ? r.url : '' }));
    } catch (error) { warn(`repositorios.json: ${error.message}`); }
  }
  const guides = docs.filter(doc => HU_GUIDE.test(doc.path)).map(doc => doc.path);
  for (const guide of ['docs/trabajar-hu.md', 'docs/guia-hu.md', 'docs/nxt/guia-hu.md', 'docs/proyecto/guia-hu.md']) if (!guides.includes(guide) && await metadata.probe(guide)) guides.push(guide);
  for (const change of changes) {
    if (change.loadState === 'unloaded') continue;
    const impact = change.summary.sections.find(section => section.key === 'impact');
    change.related = relatedComponents(impact?.text || '', repositories);
    change.canonical = [];
    for (const capability of change.capabilities) {
      const file = `openspec/specs/${capability}/spec.md`;
      if (await metadata.probe(file)) change.canonical.push(file);
    }
    for (const document of change.documents.filter(doc => doc.kind === 'specs')) {
      const file = `openspec/specs/${document.label}/spec.md`;
      document.canonical = change.canonical.includes(file) ? file : null;
    }
    const links = [];
    for (const file of change.proposalLinks || []) if (/^(docs\/|README\.md$|AGENTS\.md$)/.test(file) && /\.md$/i.test(file) && await metadata.probe(file)) links.push(file);
    change.context = [...new Set([...links, ...guides])].slice(0, 8);
    change.next = nextStep(change);
    change.summary = { sections: change.summary.sections.map(({ key, label, html }) => ({ key, label, html })), hasImpact: Boolean(impact) };
    delete change.proposalLinks;
  }
  const relationsPartial = pagination.changes.hasMore || pagination.changes.page > 0 || pagination.changes.status !== 'loaded' || pagination.archive.status !== 'loaded' || changes.some(change => change.loadState !== 'loaded');
  for (const spec of specs) {
    spec.relatedChanges = changes.filter(change => change.canonical.includes(spec.path)).map(({ id, title, archived }) => ({ id, title, archived }));
    spec.relationsPartial = relationsPartial;
  }
  if (intents) {
    for (const intent of intents) {
      const candidates = intent.path ? [intent.path, `${intent.path.replace(/\/$/, '')}/spec.md`] : [];
      intent.path = null;
      for (const file of candidates) if (/^(docs\/|openspec\/specs\/|README\.md$|AGENTS\.md$)/.test(file) && /\.md$/i.test(file) && await metadata.probe(file)) { intent.path = file; break; }
    }
  }
  const configPath = await metadata.probe('openspec/config.yaml') ? 'openspec/config.yaml' : await metadata.probe('openspec/config.yml') ? 'openspec/config.yml' : null;
  let description = null;
  if (configPath) { try { description = contextDescription((await textAt(root, configPath)).source); } catch (error) { warn(`${configPath}: ${error.message}`); } }
  const template = { config: Boolean(configPath), indice, repositorios: inventory, readme: await metadata.probe('README.md'), agents: await metadata.probe('AGENTS.md'), guide: guides.length > 0 ? true : pagination.context.hasMore || pagination.context.page > 0 ? null : false };
  return { rootName, rootPath: root, rootMarker, description, template, readAt: new Date().toISOString(), changes, specs, docs, repositories, intents, warnings, pagination, selectedChangeId: selectedIdentity?.id || null, relationsPartial };
}

// A scope owns its index and in-flight build. Files come from the filesystem,
// not the visible catalog page. "all" never allocates the archive index.
export async function searchDocuments(rootPath, snapshot, query, scope = 'all') {
  if (!snapshot || typeof snapshot !== 'object' || typeof query !== 'string') return [];
  if (query.trim().length > 200) throw new Error('La búsqueda admite hasta 200 caracteres.');
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const scopes = scope === 'all' ? CURRENT_SCOPES : [scope];
  if (scopes.some(value => ![...CURRENT_SCOPES, 'archive'].includes(value))) throw new Error('Ámbito de búsqueda inválido.');
  const root = await realpath(rootPath);
  if (!await isOpenSpecRoot(root) || typeof snapshot.rootPath !== 'string' || await realpath(snapshot.rootPath) !== root) throw new Error('El índice de búsqueda no corresponde al S0 seleccionado.');
  let cache = searchIndexes.get(snapshot);
  if (!cache) { cache = new Map(); searchIndexes.set(snapshot, cache); }
  async function indexFor(area) {
    let index = cache.get(area);
    if (!index) {
      index = { documents: [], warnings: [], ready: null };
      cache.set(area, index);
      index.ready = (async () => {
        const warn = message => { if (index.warnings.length < 20 && !index.warnings.includes(message)) index.warnings.push(message); };
        const scan = explorer(root, warn);
        let files = 0, bytes = 0, unreadable = 0;
        for await (const file of scopeFiles(scan, area)) {
          if (files === MAX_INDEX_FILES) { warn(`Búsqueda parcial (${area}): límite de ${MAX_INDEX_FILES} documentos; puede haber más coincidencias.`); break; }
          files++;
          try {
            const { source } = await textAt(root, file);
            const size = Buffer.byteLength(source, 'utf8');
            if (bytes + size > MAX_INDEX_BYTES) { warn(`Búsqueda parcial (${area}): límite de 32 MiB del índice local; puede haber más coincidencias.`); break; }
            bytes += size;
            const match = /^openspec\/changes\/(archive\/[^/]+|[^/]+)\//.exec(file);
            const owner = match ? `openspec/changes/${match[1]}` : null;
            const document = documentDescriptor(file, area, owner);
            index.documents.push({ path: file, title: documentTitle(source, document.label || path.basename(file)), kind: document.kind, scope: area, ...(match ? { changeId: match[1] } : {}), text: searchableText(source) });
          } catch { unreadable++; }
        }
        if (unreadable) warn(`Búsqueda parcial (${area}): ${unreadable} documento${unreadable === 1 ? '' : 's'} no se pudieron leer o superan el límite de 1 MiB por archivo.`);
      })();
    }
    try { await index.ready; }
    catch (error) { if (cache.get(area) === index) cache.delete(area); throw error; }
    return index;
  }
  const indexes = await Promise.all(scopes.map(indexFor));
  const results = [];
  for (const document of indexes.flatMap(index => index.documents)) {
    const text = document.text.toLocaleLowerCase();
    let first = -1, count = 0, from = 0;
    while (from < text.length) {
      const hit = text.indexOf(needle, from);
      if (hit < 0) break;
      if (first < 0) first = hit;
      count++; from = hit + needle.length;
    }
    if (!count) continue;
    const start = Math.max(0, first - 60), end = Math.min(document.text.length, first + needle.length + 60);
    results.push({ path: document.path, kind: document.kind, title: document.title, scope: document.scope, ...(document.changeId ? { changeId: document.changeId } : {}), count, snippet: `${start ? '…' : ''}${document.text.slice(start, end).replace(/\s+/g, ' ')}${end < document.text.length ? '…' : ''}` });
  }
  return results;
}

export function searchWarnings(snapshot, scope = 'all') {
  const scopes = scope === 'all' ? CURRENT_SCOPES : [scope];
  return scopes.flatMap(area => searchIndexes.get(snapshot)?.get(area)?.warnings || []);
}
