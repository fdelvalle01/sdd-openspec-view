import { realpath } from 'node:fs/promises';
import { createMarkdownParser } from './markdown.mjs';
import { LIMITS, SCOPES, portable, readSource, resolveReference, safeResolve, scopeFiles, scopeForPath, sha256 } from './filesystem.mjs';
export { assignHeadingAnchors, headingSlug, markdownOptions } from './markdown.mjs';

const sortById = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const normalizeText = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function changeIdentity(file) {
  const match = /^(openspec\/changes\/(?:archive\/)?([^/]+))\//.exec(file);
  return match ? { id: `change:${match[1]}`, path: match[1], label: match[2], archived: match[1].startsWith('openspec/changes/archive/') } : null;
}
function documentSubtype(file, scope) {
  const leaf = file.split('/').at(-1);
  if (['proposal.md', 'design.md', 'tasks.md', 'revision.md'].includes(leaf) && ['changes', 'archive'].includes(scope)) return leaf.slice(0, -3);
  return scope === 'specs' || /\/specs\/.+\/spec\.md$/.test(file) ? 'spec' : scope === 'tools' ? 'tool' : 'context';
}
const documentId = file => `doc:${file}`;
const sectionId = (file, anchor) => `section:${file}#${anchor}`;
function finiteLimit(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback; }

export function createKnowledgeEngine(MarkdownIt) {
  const parseMarkdown = createMarkdownParser(MarkdownIt);
  async function buildIndex(rootPath, options = {}) {
    const root = await realpath(rootPath);
    const limits = Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [key, finiteLimit(options.limits?.[key], value)]));
    const coverage = Object.fromEntries(SCOPES.map(scope => [scope, { status: scope === 'archive' && !options.includeArchive ? 'excluded' : 'complete', files: 0, read: 0, bytes: 0, reasons: [] }]));
    const nodes = new Map();
    const edges = new Map();
    const documents = new Map();
    const diagnostics = [];
    const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
    const diagnose = (code, severity, message, extra = {}) => diagnostics.push({ code, severity, message, ...extra });
    function addEdge(from, to, type, origin, evidence, resolution = 'resolved', extra = {}) {
      // Evidence participates in identity: multiple declarations are retained, not overwritten.
      const value = { from, ...(to ? { to } : {}), type, origin, inferred: origin === 'inferred', evidence: Array.isArray(evidence) ? evidence : [evidence], resolution, ...extra };
      const id = `edge:${sha256(JSON.stringify(value)).slice(0, 24)}`;
      if (!edges.has(id)) edges.set(id, { id, ...value });
    }
    function issue(scope, message, file) {
      const state = coverage[scope];
      state.status = 'partial';
      if (!state.reasons.includes(message)) state.reasons.push(message);
      diagnose('partial-read', 'warning', message, { scope, ...(file ? { path: file } : {}) });
    }
    for (const scope of SCOPES) {
      if (coverage[scope].status === 'excluded') continue;
      for await (const file of scopeFiles(root, scope, limits, (message, path) => issue(scope, message, path))) {
        const state = coverage[scope];
        if (state.files === limits.maxFiles) { issue(scope, `Límite de ${limits.maxFiles} documentos en ${scope}.`, file.path); break; }
        state.files++;
        const node = addNode({ id: documentId(file.path), kind: 'document', subtype: documentSubtype(file.path, scope), path: file.path, label: file.path.split('/').at(-1), scope, readState: 'partial', bytes: file.size });
        const change = changeIdentity(file.path);
        if (change) {
          const owner = addNode({ ...change, kind: 'change', scope });
          node.owner = owner.id;
          if (node.subtype === 'proposal') owner.openPath = file.path;
          addEdge(owner.id, node.id, 'contains', 'structural', { path: file.path, line: 1 });
        }
        if (file.size > limits.maxDocumentBytes) { issue(scope, `Documento mayor que ${limits.maxDocumentBytes} bytes; contenido no leído.`, file.path); continue; }
        if (state.bytes + file.size > limits.maxBytes) { issue(scope, `Límite de ${limits.maxBytes} bytes en ${scope}.`, file.path); break; }
        try {
          const read = await readSource(root, file.path, limits.maxDocumentBytes);
          if (state.bytes + read.bytes > limits.maxBytes) { issue(scope, `Límite de ${limits.maxBytes} bytes en ${scope}.`, file.path); break; }
          state.bytes += read.bytes;
          state.read++;
          node.hash = read.hash;
          node.bytes = read.bytes;
          const parsed = parseMarkdown(read.source);
          node.readState = 'loaded';
          node.label = parsed.headings.find(heading => heading.level === 1)?.label || node.label;
          documents.set(file.path, { node, parsed, source: read.source, sections: [] });
        } catch (error) { node.readState = 'error'; issue(scope, error.message, file.path); }
      }
    }

    const components = [];
    try {
      const inventory = await readSource(root, 'repositorios.json', limits.maxDocumentBytes);
      const parsed = JSON.parse(inventory.source.replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed.repositories)) throw new Error('repositorios.json no tiene una lista repositories.');
      const inventoryNode = addNode({ id: documentId('repositorios.json'), kind: 'inventory', path: 'repositorios.json', label: 'Inventario de componentes', scope: 'inventory', readState: 'loaded', hash: inventory.hash, bytes: inventory.bytes });
      const ids = new Set();
      for (const item of parsed.repositories) {
        if (!item || typeof item.id !== 'string' || !item.id.trim()) { diagnose('invalid-component', 'error', 'Componente sin identificador válido.', { path: 'repositorios.json' }); continue; }
        if (ids.has(item.id)) { diagnose('ambiguous-component', 'error', `Identificador de componente duplicado: ${item.id}.`, { path: 'repositorios.json' }); continue; }
        ids.add(item.id);
        const component = addNode({ id: `component:${item.id}`, kind: 'component', label: item.id, role: typeof item.role === 'string' ? item.role : '', ...(typeof item.url === 'string' ? { url: item.url } : {}), path: 'repositorios.json', scope: 'inventory' });
        components.push(component);
        addEdge(inventoryNode.id, component.id, 'contains', 'structural', { path: 'repositorios.json', line: 1 });
        for (const area of Array.isArray(item.requiredFor) ? item.requiredFor : []) {
          if (typeof area !== 'string' || !area.trim()) continue;
          const areaNode = addNode({ id: `area:${area}`, kind: 'area', label: area, path: 'repositorios.json', scope: 'inventory' });
          addEdge(component.id, areaNode.id, 'serves-area', 'structural', { path: 'repositorios.json', line: 1 });
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
        diagnose('invalid-inventory', 'error', error.message, { path: 'repositorios.json' });
        coverage.inventory = { status: 'partial', files: 1, read: 0, bytes: 0, reasons: [error.message] };
      }
    }

    const targets = new Map();
    const decisionsByOwner = new Map();
    for (const [file, document] of documents) {
      const { node, parsed, source } = document;
      const capabilityPath = file.startsWith('openspec/specs/') ? /^openspec\/specs\/(.+)\/spec\.md$/.exec(file)?.[1]
        : /^openspec\/changes\/(?:archive\/)?[^/]+\/specs\/(.+)\/spec\.md$/.exec(file)?.[1];
      if (capabilityPath) {
        const consolidated = node.scope === 'specs';
        const capability = addNode({ id: `capability:${capabilityPath}`, kind: 'capability', label: capabilityPath, path: file, scope: 'specs', state: consolidated ? 'consolidated' : 'proposed' });
        if (consolidated) { capability.path = file; capability.state = 'consolidated'; }
        addEdge(node.id, capability.id, consolidated ? 'defines-capability' : 'delta-for', 'structural', { path: file, line: 1 });
        if (node.owner) addEdge(node.owner, capability.id, 'changes-capability', 'structural', { path: file, line: 1 });
      }
      const decisionOwner = node.owner || file;
      if (!decisionsByOwner.has(decisionOwner)) decisionsByOwner.set(decisionOwner, new Set());
      const seenDecisions = decisionsByOwner.get(decisionOwner);
      for (const heading of parsed.headings) {
        const requirement = heading.topLevel && /^Requirement:\s*(.+)/i.exec(heading.label);
        const decision = node.subtype === 'revision' && heading.topLevel && /^(DEC-\d+)\b/.exec(heading.label);
        let id = sectionId(file, heading.anchor);
        if (decision) {
          if (seenDecisions.has(decision[1])) diagnose('ambiguous-decision', 'error', `La decisión ${decision[1]} está duplicada en la HDU.`, { path: file, line: heading.line });
          else id = `decision:${node.owner || file}:${decision[1]}`;
          seenDecisions.add(decision[1]);
        }
        const section = { id, kind: decision ? 'decision' : requirement ? 'requirement' : 'heading', label: requirement?.[1] || heading.label, path: file, anchor: heading.anchor, line: heading.line, endLine: heading.endLine, scope: node.scope, owner: node.id };
        if (decision) {
          section.decisionId = decision[1];
          const body = normalizeText(source.split(/\r\n|\n|\r/).slice(heading.line, heading.endLine - 1).join('\n').replaceAll('*', ''));
          section.state = /(?:^|\n)\s*(?:[-+]\s*)?(?:estado\s*:\s*)?sustituid[ao](?:\s|\.|$)/m.test(body) ? 'superseded' : 'recorded';
          section.incorporation = /(?:^|\n)\s*(?:[-+]\s*)?incorporacion\s*:\s*(incorporada|ya cubierta)/m.test(body) ? 'incorporated' : 'pending';
          section.verification = /(?:^|\n)\s*(?:[-+]\s*)?verificacion\s*:\s*verificada/m.test(body) ? 'verified' : 'pending';
        }
        addNode(section);
        document.sections.push(section);
        targets.set(`${file}#${heading.anchor}`, id);
        addEdge(node.id, id, 'contains', 'structural', { path: file, line: heading.line });
      }
      const taskNumbers = new Set();
      for (const task of parsed.tasks) {
        let suffix = task.number ? `task-${task.number}` : task.anchor;
        if (task.number && taskNumbers.has(task.number)) { diagnose('ambiguous-task', 'warning', `Numeración de tarea repetida: ${task.number}.`, { path: file, line: task.line }); suffix = task.anchor; }
        if (task.number) taskNumbers.add(task.number);
        const item = addNode({ ...task, id: `task:${file}#${suffix}`, kind: 'task', path: file, scope: node.scope, owner: node.id, ephemeral: suffix === task.anchor });
        document.sections.push(item);
        targets.set(`${file}#${task.anchor}`, item.id);
        addEdge(node.id, item.id, 'contains', 'structural', { path: file, line: task.line });
      }
    }

    const resourceChecks = new Map();
    const canonicalPaths = new Map([...nodes.values()].filter(node => node.path && ['document', 'inventory'].includes(node.kind)).map(node => [process.platform === 'win32' ? node.path.toLowerCase() : node.path, node.path]));
    async function targetFor(reference) {
      if (reference.blocked) return { resolution: 'blocked' };
      if (reference.external) {
        const repo = components.find(component => component.url?.replace(/\.git\/?$/, '').replace(/\/$/, '') === reference.href.replace(/\.git\/?$/, '').replace(/\/$/, ''));
        if (repo) return { to: repo.id, resolution: 'resolved' };
        const external = addNode({ id: `external:${reference.href}`, kind: 'external', label: reference.href, url: reference.href, scope: 'external' });
        return { to: external.id, resolution: 'external' };
      }
      const file = canonicalPaths.get(process.platform === 'win32' ? reference.path.toLowerCase() : reference.path) || reference.path;
      const known = nodes.get(documentId(file));
      if (known?.kind === 'inventory' && reference.anchor) {
        const component = components.find(component => component.label === reference.anchor);
        if (component) return { to: component.id, resolution: 'resolved' };
      }
      if (known && known.readState === 'loaded') {
        if (!reference.anchor) return { to: known.id, resolution: 'resolved' };
        if (targets.has(`${file}#${reference.anchor}`)) return { to: targets.get(`${file}#${reference.anchor}`), resolution: 'resolved' };
        if (known.kind === 'document') return { to: known.id, resolution: 'missing-anchor' };
        return { to: known.id, resolution: 'unindexed' };
      }
      if (!resourceChecks.has(file)) {
        try {
          const resolved = await safeResolve(root, file);
          if (known) resourceChecks.set(file, { to: known.id, resolution: 'unindexed' });
          else {
            const resource = addNode({ id: `resource:${file}`, kind: 'resource', label: file.split('/').at(-1), path: file, scope: scopeForPath(file) || 'resources', resourceType: resolved.entry.isDirectory() ? 'directory' : 'file', readState: 'unindexed' });
            resourceChecks.set(file, { to: resource.id, resolution: /\.md$/i.test(file) ? 'unindexed' : 'resolved' });
          }
        } catch (error) { resourceChecks.set(file, { resolution: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'blocked', reason: error.message }); }
      }
      const result = resourceChecks.get(file);
      return reference.anchor && result.resolution === 'resolved' ? { ...result, resolution: 'unindexed' } : result;
    }
    function sourceAt(document, line) {
      const containing = document.sections.filter(section => section.line <= line && section.endLine > line);
      const semantic = containing.filter(section => ['task', 'requirement', 'decision'].includes(section.kind));
      return semantic.sort((a, b) => b.line - a.line || a.endLine - b.endLine)[0]?.id || document.node.id;
    }
    for (const [file, document] of documents) {
      for (const link of document.parsed.links) {
        const reference = resolveReference(file, link.href);
        const target = await targetFor(reference);
        const evidence = { path: file, line: link.line, href: link.href, destinationStart: link.destinationStart, destinationEnd: link.destinationEnd, ...(reference.path ? { targetPath: reference.path, anchor: reference.anchor } : {}), ...(link.uses?.length ? { uses: link.uses } : {}) };
        const useLines = link.uses?.length ? [...new Set(link.uses.map(use => use.line))] : [link.line];
        const targetNode = nodes.get(target.to);
        // The document backlink exists even when a declaration lives in a decision/task section.
        addEdge(document.node.id, target.to, 'references', 'explicit', evidence, target.resolution);
        if (target.resolution === 'resolved' && targetNode?.anchor && targetNode.owner) addEdge(document.node.id, targetNode.owner, 'references-document', 'explicit', evidence, target.resolution);
        for (const line of useLines) {
          if (targetNode?.kind === 'component' && reference.path === 'repositorios.json' && reference.anchor === targetNode.label) {
            const section = document.parsed.headings.filter(heading => heading.line <= line && heading.endLine > line).sort((a, b) => b.line - a.line).find(heading => /^componentes (consultados|afectados)$/.test(normalizeText(heading.label).trim()));
            if (section) addEdge(document.node.owner || document.node.id, target.to, normalizeText(section.label).includes('consultados') ? 'consults-component' : 'affects-component', 'explicit', { ...evidence, line, heading: section.label }, target.resolution);
          }
          const from = sourceAt(document, line);
          if (from === document.node.id) continue;
          const sourceLine = normalizeText(document.source.split(/\r\n|\n|\r/)[line - 1] || '');
          const decision = nodes.get(from)?.kind === 'decision';
          const type = decision && /sustituye\b/.test(sourceLine) ? 'supersedes' : decision && /sustituid[ao]\s+por/.test(sourceLine) ? 'superseded-by' : 'references';
          addEdge(from, target.to, type, 'explicit', { ...evidence, line, definitionLine: link.line }, target.resolution);
        }
        if (!['resolved', 'external'].includes(target.resolution)) {
          const severity = target.resolution === 'unindexed' ? 'warning' : 'error';
          const labels = { missing: 'No existe el destino', 'missing-anchor': 'No existe el ancla', unindexed: 'Destino existente sin contenido indexado', blocked: 'Destino bloqueado' };
          diagnose(target.resolution, severity, `${labels[target.resolution]}: ${link.href}.`, { path: file, line: link.line, href: link.href, ...(reference.path ? { targetPath: reference.path } : {}), ...(target.reason || reference.reason ? { reason: target.reason || reference.reason } : {}) });
        }
      }
      // Exact component identifiers are hints, never acceptance or functional dependencies.
      // Retain candidates so toggling the UI does not require rereading the entire corpus.
      for (const component of components) {
        const escaped = component.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'u');
        const matches = document.parsed.textLines.filter(line => pattern.test(line.text));
        if (matches.length) addEdge(document.node.id, component.id, 'mentions-component', 'inferred', matches.map(line => ({ path: file, line: line.line })), 'resolved');
      }
    }
    const nodeList = [...nodes.values()].sort(sortById);
    const edgeList = [...edges.values()].sort(sortById);
    diagnostics.sort((a, b) => sortById({ id: `${a.path || ''}:${String(a.line || 0).padStart(8, '0')}:${a.code}` }, { id: `${b.path || ''}:${String(b.line || 0).padStart(8, '0')}:${b.code}` }));
    for (const state of Object.values(coverage)) state.reasons.sort();
    const revision = sha256(JSON.stringify({ nodes: nodeList, edges: edgeList, diagnostics, coverage }));
    return { schemaVersion: 1, rootPath: root, revision, nodes: nodeList, edges: edgeList, diagnostics, coverage };
  }
  return { buildIndex, query, parseMarkdown };
}

export function query(index, options = {}) {
  const depth = options.depth ?? 1;
  if (![1, 2].includes(depth)) throw new Error('La profundidad debe ser 1 o 2.');
  const limit = Math.min(100, Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 100);
  const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const eligible = index.edges.filter(edge => options.includeInferred || !edge.inferred);
  const selector = typeof options.path === 'string' ? portable(options.path) : null;
  const seed = options.id ? index.nodes.find(node => node.id === options.id)
    : index.nodes.find(node => node.id === documentId(selector)) || index.nodes.find(node => `${node.path || ''}#${node.anchor || ''}` === selector) || index.nodes.find(node => node.path === selector);
  if (!seed) return { schemaVersion: 1, rootPath: index.rootPath, revision: index.revision, nodes: [], edges: [], total: 0, hasMore: false, coverage: index.coverage, diagnostics: [{ code: 'unknown-node', severity: 'warning', message: 'El documento o nodo no forma parte del alcance indexado.' }] };
  const visited = new Set([seed.id]);
  let frontier = new Set([seed.id]);
  for (let step = 0; step < depth; step++) {
    const next = new Set();
    for (const edge of eligible) {
      if (frontier.has(edge.from) && edge.to && !visited.has(edge.to)) next.add(edge.to);
      if (edge.to && frontier.has(edge.to) && !visited.has(edge.from)) next.add(edge.from);
    }
    for (const id of next) visited.add(id);
    frontier = next;
  }
  const related = index.nodes.filter(node => visited.has(node.id) && node.id !== seed.id).sort(sortById);
  const page = [seed, ...related.slice(offset, offset + limit)];
  const visible = new Set(page.map(node => node.id));
  return { schemaVersion: 1, rootPath: index.rootPath, revision: index.revision, nodes: page, edges: eligible.filter(edge => visible.has(edge.from) && (!edge.to || visible.has(edge.to))), total: related.length, offset, limit, hasMore: offset + limit < related.length, coverage: index.coverage, diagnostics: index.diagnostics.filter(issue => page.some(node => node.path === issue.path)) };
}
