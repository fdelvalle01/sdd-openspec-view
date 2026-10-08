export const GRAPH_ZONES = [
  ['changes', 'HU en curso'], ['specs', 'Capacidades y specs'], ['inventory', 'Componentes y áreas'],
  ['archive', 'Archivo'], ['template', 'Plantilla'], ['tools', 'Skills y comandos'], ['context', 'Contexto'],
];
const detailKinds = new Set(['heading', 'requirement', 'task', 'decision']);

export function graphZone(node) {
  // A linked script, package or unindexed file is a cited resource, not a
  // document read as project context. This key is only a local grouping.
  if (node.kind === 'resource') return 'resources';
  if (node.scope === 'archive') return 'archive';
  if (node.kind === 'capability') return 'specs';
  if (node.kind === 'component' || node.kind === 'area') return 'inventory';
  if (node.path && (/^(?:README|AGENTS|CLAUDE)\.md$/i.test(node.path) || /^(?:repositorios\.json|openspec\/config\.ya?ml)$/i.test(node.path))) return 'template';
  return GRAPH_ZONES.some(([id]) => id === node.scope) ? node.scope : 'context';
}

export function primaryNodes(index, zone) {
  return index.nodes.filter(node => !detailKinds.has(node.kind) && !['external', 'resource'].includes(node.kind)
    && (!zone || graphZone(node) === zone)
    && !(node.kind === 'document' && ['changes', 'archive'].includes(node.scope)));
}

export function visibleEdges(index, options = {}) {
  return index.edges.filter(edge => (!edge.inferred || options.includeInferred)
    && (options.areas !== false || edge.type !== 'serves-area')
    && (options.structure !== false || edge.origin !== 'structural')
    && (options.links !== false || edge.origin !== 'explicit'));
}

// Preserve every direction, type and evidence. A shared neighbour is not a shared edge.
export function incidentRelations(index, id, options = {}) {
  const nodes = new Map(index.nodes.map(node => [node.id, node]));
  return visibleEdges(index, options).filter(edge => edge.from === id || edge.to === id).map(edge => ({
    edge, direction: edge.from === id ? 'out' : 'in',
    neighbour: nodes.get(edge.from === id ? edge.to : edge.from) || null,
  }));
}

export function neighbourhood(index, id, options = {}) {
  const relations = incidentRelations(index, id, options);
  const ids = [...new Set(relations.map(item => item.neighbour?.id).filter(value => value && value !== id))].sort();
  const page = Math.max(0, Math.min(Math.floor(options.page || 0), Math.max(0, Math.ceil(ids.length / 100) - 1)));
  const selected = new Set([id, ...ids.slice(page * 100, (page + 1) * 100)]);
  return { nodes: index.nodes.filter(node => selected.has(node.id)), edges: visibleEdges(index, options).filter(edge => selected.has(edge.from) && selected.has(edge.to)),
    total: ids.length, page, hasMore: (page + 1) * 100 < ids.length };
}

export function sourceTarget(node) {
  const path = node?.openPath || node?.path;
  const permitted = typeof path === 'string' && /^(?:(?:README|AGENTS|CLAUDE)\.md|docs\/.+\.md|openspec\/(?:changes|specs|schemas)\/.+\.md|\.(?:agents|claude)\/(?:skills|commands|agents)\/.+\.md|repositorios\.json|openspec\/config\.ya?ml)$/i.test(path)
    && !path.includes(':') && !path.split('/').some(part => !part || ['.', '..', '.git', '.local', '.obsidian', 'node_modules', '.env', '.aws', '.ssh'].includes(part.toLowerCase())
      || /[ .]$/.test(part) || /^\.env(?:\.|$)/i.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  return permitted ? { path, ...(node.anchor ? { anchor: node.anchor } : {}), ...(node.line ? { line: node.line } : {}) } : null;
}
