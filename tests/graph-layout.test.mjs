import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphScene } from '../src/graph-layout.js';
import { GRAPH_ZONES, graphZone, incidentRelations, primaryNodes, sourceTarget } from '../src/graph-model.js';

const doc = (id, scope = 'context', extra = {}) => ({ id, kind: 'document', label: id, scope, path: `docs/${id}.md`, ...extra });
const edge = (id, from, to, type = 'references', origin = 'explicit') => ({ id, from, to, type, origin, inferred: origin === 'inferred', evidence: [{ path: 'docs/source.md', line: 3 }] });
const structure = (id, from, to) => edge(id, from, to, 'contains', 'structural');
const fixture = () => ({
  rootPath: 'C:\\workspace\\sistema',
  nodes: [
    { id: 'hu', kind: 'change', scope: 'changes', label: 'Nueva consulta', path: 'openspec/changes/consulta', openPath: 'openspec/changes/consulta/proposal.md' },
    doc('proposal', 'changes', { owner: 'hu', subtype: 'proposal', path: 'openspec/changes/consulta/proposal.md' }),
    doc('delta', 'changes', { owner: 'hu', subtype: 'spec', path: 'openspec/changes/consulta/specs/search/spec.md' }),
    doc('tasks', 'changes', { owner: 'hu', subtype: 'tasks', path: 'openspec/changes/consulta/tasks.md' }),
    doc('revision', 'changes', { owner: 'hu', subtype: 'revision', path: 'openspec/changes/consulta/revision.md' }),
    { id: 'req', kind: 'requirement', scope: 'changes', owner: 'delta', label: 'Buscar', path: 'openspec/changes/consulta/specs/search/spec.md', anchor: 'requirement-buscar', line: 3 },
    { id: 'task', kind: 'task', scope: 'changes', owner: 'tasks', label: 'Implementar búsqueda', path: 'openspec/changes/consulta/tasks.md', line: 4 },
    { id: 'dec', kind: 'decision', scope: 'changes', owner: 'revision', label: 'DEC-001', path: 'openspec/changes/consulta/revision.md', line: 7 },
    { id: 'cap', kind: 'capability', scope: 'specs', label: 'search', path: 'openspec/changes/consulta/specs/search/spec.md', state: 'proposed' },
    { id: 'component', kind: 'component', scope: 'inventory', label: 'frontend', path: 'repositorios.json' },
    { id: 'area', kind: 'area', scope: 'inventory', label: 'search', path: 'repositorios.json' },
    doc('context'), doc('README', 'tools', { path: 'README.md' }),
  ],
  edges: [
    structure('sp', 'hu', 'proposal'), structure('sd', 'hu', 'delta'), structure('st', 'hu', 'tasks'), structure('sr', 'hu', 'revision'),
    structure('rq', 'delta', 'req'), structure('ts', 'tasks', 'task'), structure('dc', 'revision', 'dec'),
    edge('capability', 'delta', 'cap', 'delta-for', 'structural'), edge('affected', 'task', 'component'),
    edge('requirement', 'task', 'req'), edge('cited', 'req', 'context'), edge('cited-twice', 'proposal', 'context'),
    edge('back', 'context', 'proposal'), edge('infer', 'proposal', 'context', 'mentions', 'inferred'),
    edge('area', 'component', 'area', 'serves-area', 'structural'),
  ],
});

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}

test('layout is deterministic for shuffled index order and does not mutate source data or state', () => {
  const index = deepFreeze(fixture());
  for (const state of [deepFreeze({ level: 'map', includeInferred: true }), deepFreeze({ level: 'zone', zone: 'changes' }), deepFreeze({ level: 'local', focus: 'hu' })]) {
    const expected = buildGraphScene(index, state, 1040, 700);
    assert.deepEqual(buildGraphScene(index, state, 1040, 700), expected);
    assert.deepEqual(buildGraphScene({ ...index, nodes: [...index.nodes].reverse(), edges: [...index.edges].reverse() }, state, 1040, 700), expected);
  }
  const expected = buildGraphScene(index, {}, 1040, 700);
  assert.equal(expected.nodes.find(node => node.role === 'hub').label, 'sistema');
  assert.ok(expected.edges.filter(item => item.visual).every(item => !item.edgeIds));
});

test('map contains actual entries in weighted sectors and puts areas outside the entry rings', () => {
  const index = fixture();
  for (let i = 0; i < 20; i++) index.nodes.push(doc(`context-${i}`));
  const scene = buildGraphScene(index, {}, 1280, 850);
  const contexts = scene.sectors.find(item => item.id === 'visual:zone:context');
  const changes = scene.sectors.find(item => item.id === 'visual:zone:changes');
  assert.ok(contexts.end - contexts.start > changes.end - changes.start);
  assert.equal(scene.nodes.filter(node => node.role === 'zone').length, 7);
  const hu = scene.nodes.find(node => node.id === 'hu');
  assert.equal(hu.parentId, 'visual:zone:changes');
  assert.equal(hu.displayLabel, 'Nueva consulta');
  const distance = node => Math.hypot(node.x - scene.cx, node.y - scene.cy);
  assert.ok(Math.abs(distance(scene.nodes.find(node => node.id === 'area')) - scene.radius * .97) < 1e-8);
  assert.ok(distance(hu) > distance(scene.nodes.find(node => node.id === hu.parentId)));
  assert.equal(scene.nodes.some(node => node.id === 'task'), false);
});

test('projected relations retain every original id, direction, type and inferred filter', () => {
  const index = fixture();
  const scene = buildGraphScene(index);
  const forward = scene.edges.find(item => item.from === 'hu' && item.to === 'context' && item.type === 'references');
  assert.deepEqual(forward.edgeIds, ['cited', 'cited-twice']);
  assert.equal(forward.curveFactor, .24);
  assert.deepEqual(scene.edges.find(item => item.from === 'context' && item.to === 'hu').edgeIds, ['back']);
  assert.equal(scene.edges.some(item => item.inferred), false);
  const enabled = buildGraphScene(index, { includeInferred: true });
  assert.deepEqual(enabled.edges.find(item => item.inferred).edgeIds, ['infer']);
  assert.equal(enabled.stats.inferred, 1);
  assert.ok(buildGraphScene(index, { links: false }).edges.every(item => item.origin !== 'explicit'));
});

test('more than 2000 entries are visually bounded, still reported, and reachable by zone pagination', () => {
  const index = { nodes: Array.from({ length: 2053 }, (_, n) => doc(`context-${String(n).padStart(4, '0')}`)), edges: [] };
  index.nodes.push(doc('current-spec', 'specs'));
  const map = buildGraphScene(index);
  assert.equal(map.nodes.filter(node => node.role === 'entry').length, 31);
  assert.equal(map.stats.entries, 2054);
  assert.match(map.notice, /2054/);
  assert.ok(map.nodes.some(node => node.id === 'current-spec'));
  assert.ok(map.sectors.every(sector => sector.end - sector.start > .5), 'A large zone must not squeeze the remaining zones out of the map');
  const first = buildGraphScene(index, { level: 'zone', zone: 'context' });
  const last = buildGraphScene(index, { level: 'zone', zone: 'context', zonePage: 900 });
  assert.equal(first.list.length, 50);
  assert.deepEqual(last.pagination, { page: 41, pages: 42, count: 2053, key: 'zonePage' });
  assert.equal(last.list.length, 3);
  assert.equal(index.nodes.length, 2054);
});

test('zone displays a bounded connected external arc while preserving source navigation', () => {
  const index = fixture();
  for (let i = 0; i < 36; i++) {
    index.nodes.push(doc(`external-${String(i).padStart(2, '0')}`));
    index.edges.push(edge(`connect-${i}`, 'req', `external-${String(i).padStart(2, '0')}`));
  }
  const scene = buildGraphScene(index, { level: 'zone', zone: 'changes' }, 1040, 740);
  const entries = scene.nodes.filter(node => node.role === 'entry'), external = scene.nodes.filter(node => node.role === 'external');
  assert.equal(entries.length, 1);
  assert.equal(external.length, 24);
  assert.match(scene.notice, /24 de 39/);
  assert.ok(external.every(node => node.y > entries[0].y));
  assert.deepEqual(sourceTarget(external.find(node => node.id === 'cap')), { path: 'openspec/changes/consulta/specs/search/spec.md' });
  const selected = new Set(scene.nodes.map(node => node.id));
  assert.ok(scene.edges.every(item => selected.has(item.from) && selected.has(item.to)));
});

test('HU neighbourhood expands artefacts and their tasks, requirements and decisions with actual cross links', () => {
  const index = fixture();
  const scene = buildGraphScene(index, { level: 'local', focus: 'hu' }, 1280, 850);
  assert.equal(scene.nodes.find(node => node.id === 'hu').role, 'center');
  assert.equal(scene.nodes.find(node => node.id === 'tasks').role, 'art');
  assert.equal(scene.nodes.find(node => node.id === 'task').parentId, 'tasks');
  assert.equal(scene.nodes.find(node => node.id === 'req').parentId, 'delta');
  assert.equal(scene.nodes.find(node => node.id === 'dec').parentId, 'revision');
  assert.ok(scene.nodes.find(node => node.id === 'component').parentId.startsWith('visual:group:'));
  assert.ok(scene.edges.some(item => item.id === 'requirement' && item.from === 'task' && item.to === 'req'));
  assert.deepEqual(sourceTarget(scene.nodes.find(node => node.id === 'req')), { path: 'openspec/changes/consulta/specs/search/spec.md', anchor: 'requirement-buscar', line: 3 });
});

test('a referenced section from another HU is grouped by its real owning HU', () => {
  const index = fixture();
  index.nodes.push({ id: 'other-hu', kind: 'change', scope: 'changes', label: 'Otra HU' }, doc('other-doc', 'changes', { owner: 'other-hu' }),
    { id: 'other-req', kind: 'requirement', scope: 'changes', label: 'Otro requisito', owner: 'other-doc' });
  index.edges.push(edge('cross-hu', 'task', 'other-req'));
  const scene = buildGraphScene(index, { level: 'local', focus: 'hu' });
  const section = scene.nodes.find(node => node.id === 'other-req');
  const group = scene.nodes.find(node => node.id === section.parentId);
  assert.equal(group.targetFocus, 'other-hu');
  assert.equal(group.label, 'Otra HU');
});

test('neighbourhood pages never exceed 100 noncentral real nodes and retain all subsequent sections', () => {
  const center = doc('tasks', 'changes', { subtype: 'tasks' });
  const nodes = [center, ...Array.from({ length: 205 }, (_, n) => ({ id: `task-${String(n).padStart(3, '0')}`, kind: 'task', owner: 'tasks', scope: 'changes', label: `Tarea ${n}`, line: n + 1 }))];
  const index = { nodes, edges: nodes.slice(1).map(node => structure(`edge-${node.id}`, 'tasks', node.id)) };
  const seen = new Set();
  for (let neighbourPage = 0; neighbourPage < 3; neighbourPage++) {
    const scene = buildGraphScene(index, { level: 'local', focus: 'tasks', neighbourPage });
    const real = scene.nodes.filter(node => !node.id.startsWith('visual:') && node.id !== 'tasks');
    assert.ok(real.length <= 100);
    assert.equal(scene.nodes.filter(node => node.role === 'group').length, 1);
    for (const node of real) seen.add(node.id);
    assert.equal(scene.pagination.count, 205);
    assert.equal(new Set(scene.nodes.map(node => node.id)).size, scene.nodes.length);
  }
  assert.equal(seen.size, 205);
});

test('all three scene levels have finite positions within 600, 1040 and 1280 pixel canvases', () => {
  for (const width of [600, 1040, 1280]) for (const state of [{ level: 'map' }, { level: 'zone', zone: 'changes' }, { level: 'local', focus: 'hu' }]) {
    const scene = buildGraphScene(fixture(), state, width, 640);
    for (const node of scene.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
      assert.ok(node.x >= 0 && node.x <= width, `${node.id}: ${node.x} at ${width}`);
      assert.ok(node.y >= 0 && node.y <= 640, `${node.id}: ${node.y}`);
      assert.ok(Number.isFinite(node.radius));
    }
  }
});

test('zero HDU and empty inventory remain seven navigable zones without fabricated entries', () => {
  const index = { nodes: [], edges: [] };
  const map = buildGraphScene(index);
  assert.equal(map.nodes.length, 8);
  assert.equal(map.list.length, 0);
  assert.equal(map.stats.entries, 0);
  const empty = buildGraphScene(index, { level: 'zone', zone: 'archive' });
  assert.equal(empty.nodes.length, 1);
  assert.deepEqual(empty.pagination, { page: 0, pages: 1, count: 0, key: 'zonePage' });
});

test('neighbourhood hides generic headings and scenarios but preserves their document references', () => {
  const index = fixture();
  index.nodes.push({ id: 'title', kind: 'heading', owner: 'proposal', scope: 'changes', label: 'Por qué' },
    { id: 'scenario', kind: 'heading', owner: 'delta', scope: 'changes', label: 'Scenario: respuesta' }, doc('extra-context'));
  index.edges.push(structure('title-part', 'proposal', 'title'), structure('scenario-part', 'delta', 'scenario'), edge('title-citation', 'title', 'extra-context'));
  const scene = buildGraphScene(index, { level: 'local', focus: 'hu' }, 1280, 850);
  assert.equal(scene.nodes.some(node => ['heading', 'scenario'].includes(node.kind)), false);
  assert.ok(scene.nodes.some(node => node.id === 'extra-context'));
  assert.ok(scene.edges.some(item => item.from === 'proposal' && item.to === 'extra-context' && item.edgeIds.includes('title-citation')));
  assert.ok(index.nodes.some(node => node.id === 'title'));
  assert.equal(scene.list.some(node => node.id === 'scenario'), false);
});

test('artefacts and numbered tasks use short captions without changing their original names or states', () => {
  const index = fixture();
  const tasks = index.nodes.find(node => node.id === 'tasks');
  tasks.label = 'Una cabecera muy extensa con todas las tareas y dependencias de implementación';
  const task = index.nodes.find(node => node.id === 'task');
  task.number = '2.3'; task.done = true;
  const scene = buildGraphScene(index, { level: 'local', focus: 'hu' }, 1280, 850);
  const renderedTasks = scene.nodes.find(node => node.id === 'tasks');
  assert.equal(renderedTasks.displayLabel, 'Tareas');
  assert.equal(renderedTasks.radius, 17);
  assert.match(renderedTasks.subtitle, /^tasks\.md/);
  assert.equal(renderedTasks.label, tasks.label);
  const renderedTask = scene.nodes.find(node => node.id === 'task');
  assert.equal(renderedTask.displayLabel, '2.3');
  assert.equal(renderedTask.label, task.label);
  assert.equal(renderedTask.done, true);
  assert.equal(scene.nodes.find(node => node.id === 'delta').displayLabel, 'Delta de spec');
  assert.equal(scene.nodes.find(node => node.id === 'revision').displayLabel, 'Decisiones');
});

test('two HU at the top of the map use different anchors and staggered label baselines', () => {
  const index = { nodes: [{ id: 'a', kind: 'change', scope: 'changes', label: 'catalog-search' }, { id: 'b', kind: 'change', scope: 'changes', label: 'export-summary' }], edges: [] };
  const scene = buildGraphScene(index, { level: 'map' }, 1040, 850);
  const a = scene.nodes.find(node => node.id === 'a'), b = scene.nodes.find(node => node.id === 'b');
  assert.equal(a.displayLabel, 'catalog-search');
  assert.equal(b.displayLabel, 'export-summary');
  assert.equal(a.labelPosition.anchor, 'end');
  assert.equal(b.labelPosition.anchor, 'start');
  assert.notEqual(a.labelPosition.y, b.labelPosition.y);
});

test('crowded captions can be suppressed without removing sources, while area groups navigate to inventory', () => {
  const index = fixture();
  index.edges.push(edge('context-area', 'proposal', 'area'));
  for (let i = 0; i < 100; i++) index.nodes.push({ id: `req-${i}`, kind: 'requirement', owner: 'delta', scope: 'changes', label: `Requisito largo número ${i} con toda su descripción` });
  const scene = buildGraphScene(index, { level: 'local', focus: 'hu' }, 600, 640);
  assert.ok(scene.nodes.some(node => node.kind === 'requirement' && !node.displayLabel));
  assert.ok(scene.list.some(node => node.kind === 'requirement' && node.label.includes('descripción')));
  const withoutCrowding = buildGraphScene(fixtureWithArea(), { level: 'local', focus: 'hu' }, 1280, 850);
  assert.equal(withoutCrowding.nodes.find(node => node.id === 'visual:group:areas').targetZone, 'inventory');
  const document = buildGraphScene(index, { level: 'local', focus: 'delta' }, 1280, 850);
  assert.ok(document.nodes.filter(node => node.id.startsWith('visual:parts:')).every(node => !node.targetFocus || node.targetFocus === 'delta'));
  function fixtureWithArea() { const corpus = fixture(); corpus.edges.push(edge('context-area', 'proposal', 'area')); return corpus; }
});

test('cited packages, scripts, JSON and unindexed files never count as primary context', () => {
  const index = fixture();
  const resources = ['openspec-viewer-local-0.3.1.vsix', 'scripts/check.mjs', 'docs/evidence/report.json', 'View-OpenSpec/README.md'].map(path => ({
    id: `resource:${path}`, kind: 'resource', label: path.split('/').at(-1), path, scope: path.startsWith('docs/') ? 'context' : 'resources', readState: 'unindexed', resourceType: 'file',
  }));
  index.nodes.push(...resources, doc('configuration', 'tools', { path: 'openspec/config.yaml' }));
  index.edges.push(...resources.map((item, i) => edge(`resource-edge-${i}`, 'context', item.id)));
  deepFreeze(index);
  const entries = primaryNodes(index);
  assert.equal(entries.some(node => node.kind === 'resource'), false);
  assert.equal(primaryNodes(index, 'context').some(node => node.path.endsWith('.json')), false);
  assert.ok(entries.some(node => node.id === 'configuration'), 'A read configuration document remains part of the template');
  assert.ok(resources.every(node => graphZone(node) === 'resources'));
  assert.equal(GRAPH_ZONES.length, 7);
  const map = buildGraphScene(index, { level: 'map' }, 1040, 850);
  const zone = buildGraphScene(index, { level: 'zone', zone: 'context' }, 1040, 850);
  assert.ok([map, zone].every(scene => scene.nodes.every(node => node.kind !== 'resource')));
  assert.equal(map.stats.entries, entries.length);
  assert.equal(map.stats.relations, index.edges.filter(item => !item.inferred).length);
  const relations = incidentRelations(index, 'context');
  assert.deepEqual(relations.filter(item => item.neighbour?.kind === 'resource').map(item => item.neighbour.id).sort(), resources.map(item => item.id).sort());
  assert.ok(resources.every(node => sourceTarget(node) === null), 'Removing visual primaries does not broaden file-opening permissions');
});

test('resources remain selectable in local relationships without a fictitious navigable zone', () => {
  const resource = { id: 'resource:release', kind: 'resource', label: 'openspec-viewer-local-0.3.1.vsix', path: 'openspec-viewer-local-0.3.1.vsix', scope: 'resources', readState: 'unindexed' };
  const index = deepFreeze({ nodes: [doc('release-notes'), resource], edges: [edge('download', 'release-notes', resource.id)] });
  const scene = buildGraphScene(index, { level: 'local', focus: 'release-notes' }, 1040, 850);
  const rendered = scene.nodes.find(node => node.id === resource.id);
  assert.equal(rendered.label, resource.label);
  const group = scene.nodes.find(node => node.id === rendered.parentId);
  assert.equal(group.label, 'Recursos citados');
  assert.equal(group.targetZone, undefined);
  assert.equal(group.zone, undefined);
  assert.equal(group.targetFocus, undefined);
  assert.ok(scene.list.some(node => node.id === resource.id));
  assert.deepEqual(scene.edges.find(item => item.id === 'download').edgeIds, ['download']);
  const focused = buildGraphScene(index, { level: 'local', focus: resource.id }, 1040, 850);
  assert.equal(focused.nodes.find(node => node.role === 'center').id, resource.id);
  assert.ok(focused.nodes.some(node => node.id === 'release-notes'));
  assert.deepEqual(incidentRelations(index, resource.id)[0].edge.evidence, [{ path: 'docs/source.md', line: 3 }]);
});

test('all seven navigation zones retain their names when dense entry captions cannot fit', () => {
  const index = fixture();
  for (const scope of ['context', 'tools']) for (let i = 0; i < 45; i++) index.nodes.push(doc(`${scope}-${i}`, scope));
  for (let i = 0; i < 18; i++) index.nodes.push({ id: `component-${i}`, kind: 'component', scope: 'inventory', label: `component-${i}`, path: 'repositorios.json' });
  for (const width of [600, 800, 1040, 1280]) {
    const map = buildGraphScene(index, {}, width, 850);
    const zones = map.nodes.filter(node => node.role === 'zone');
    assert.equal(zones.length, 7);
    assert.ok(zones.every(node => node.displayLabel), `All navigation names must remain visible at ${width}px`);
    assert.equal(zones.find(node => node.zone === 'specs').displayLabel, 'Specs');
    assert.equal(zones.find(node => node.zone === 'inventory').displayLabel, 'Componentes');
    assert.equal(zones.find(node => node.zone === 'specs').label, 'Capacidades y specs');
    if (map.compact) assert.ok(zones.every(node => !node.subtitle));
  }
});

test('outer area captions remain radial and abbreviate long names to available canvas space', () => {
  const component = { id: 'component', kind: 'component', scope: 'inventory', label: 'api', path: 'repositorios.json' };
  const names = ['launcher', 'administracion', 'terminal', 'acceso', 'catalogos', 'mercado', 'persistencia-ordenes-con-un-nombre-extenso', 'ordenes', 'conectividad', 'bibliotecas-go', 'contratos'];
  const areas = names.map((label, i) => ({ id: `area:${i}`, kind: 'area', scope: 'inventory', label, path: 'repositorios.json' }));
  const index = deepFreeze({ nodes: [component, ...areas], edges: areas.map(node => edge(`serves:${node.id}`, component.id, node.id, 'serves-area', 'structural')) });
  for (const width of [600, 1040, 1280]) {
    const map = buildGraphScene(index, {}, width, 850);
    const captions = map.nodes.filter(node => node.role === 'area');
    assert.equal(captions.length, areas.length);
    assert.ok(captions.filter(node => node.displayLabel).length >= 9, 'Oriented labels should not be culled as overlapping axis-aligned boxes');
    for (const node of captions) {
      const expectedRotation = node.angle * 180 / Math.PI + (Math.cos(node.angle) < 0 ? 180 : 0);
      assert.equal(node.labelPosition.rotation, expectedRotation);
      assert.equal(node.label, areas.find(area => area.id === node.id).label);
      assert.ok(node.displayLabel.length <= node.label.length);
    }
    assert.ok(captions.some(node => node.displayLabel.endsWith('…')), 'A long area name is shortened instead of clipping at the canvas edge');
  }
});
