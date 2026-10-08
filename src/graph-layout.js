import { GRAPH_ZONES, graphZone, primaryNodes, visibleEdges } from './graph-model.js';

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const sorted = items => [...items].sort(compare);
const zoneLabel = id => GRAPH_ZONES.find(([key]) => id === key)?.[1] || (id === 'resources' ? 'Recursos citados' : id);
const zoneCaption = (id, compact) => ({ specs: 'Specs', inventory: 'Componentes', ...(compact ? { tools: 'Skills' } : {}) }[id] || zoneLabel(id));
const at = (cx, cy, radius, angle) => ({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, angle });
const radialLabel = (angle, offset = 14) => ({ x: Math.cos(angle) * offset, y: Math.sin(angle) * offset, anchor: Math.cos(angle) < -.2 ? 'end' : Math.cos(angle) > .2 ? 'start' : 'middle' });
const below = (y = 16) => ({ x: 0, y, anchor: 'middle' });
const spoke = (from, to) => ({ id: `visual:spoke:${from}:${to}`, from, to, type: 'layout', origin: 'visual', inferred: false, visual: true, curveFactor: 1 });
const partPriority = node => ({ proposal: 0, spec: 1, tasks: 3, revision: 8, design: 9 }[node.subtype] ?? 5);
const short = (text, limit = 24) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const hiddenDetail = node => ['heading', 'scenario'].includes(node?.kind);
function entryLabel(node) {
  if (node.kind === 'task') {
    const number = node.number || node.taskId || /^(\d+(?:\.\d+)*)(?:[.)]?\s)/.exec(node.label)?.[1];
    return number ? String(number) : node.line ? `Tarea · L${node.line}` : short(node.label, 18);
  }
  if (node.kind === 'decision') return node.decisionId || /\bDEC-\d+\b/.exec(node.label)?.[0] || short(node.label);
  return short(node.label, node.kind === 'requirement' ? 22 : 28);
}
function artifactLabel(node) {
  const file = node.path?.split('/').at(-1);
  return ({ 'proposal.md': 'Propuesta', 'tasks.md': 'Tareas', 'design.md': 'Diseño', 'revision.md': 'Decisiones', 'spec.md': node.scope === 'changes' || node.scope === 'archive' ? 'Delta de spec' : 'Spec' }[file]) || entryLabel(node);
}

// Approximate the fixed SVG font conservatively. This only chooses which short
// captions fit; full names remain in node.label, tooltips, details and the list.
function readableLabels(scene) {
  const placed = [];
  const priorities = { zone: 0, treeTop: 0, hub: 1, center: 1, art: 2, group: 3, entry: 4, external: 5, area: 6 };
  const ordered = [...scene.nodes].sort((a, b) => (priorities[a.role] ?? 6) - (priorities[b.role] ?? 6) || compare(a, b));
  const intersects = (a, b) => {
    if (!(a.left < b.right + 4 && a.right + 4 > b.left && a.top < b.bottom + 4 && a.bottom + 4 > b.top)) return false;
    if (!a.rotated && !b.rotated) return true;
    const corners = box => box.corners || [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }];
    const ac = corners(a), bc = corners(b);
    // Rotated area labels can share their axis-aligned bounding boxes while
    // the actual text rectangles remain separate along the outer orbit.
    for (const points of [ac, bc]) for (let i = 0; i < 2; i++) {
      const dx = points[i + 1].x - points[i].x, dy = points[i + 1].y - points[i].y;
      const length = Math.hypot(dx, dy) || 1, axis = { x: -dy / length, y: dx / length };
      const ap = ac.map(point => point.x * axis.x + point.y * axis.y), bp = bc.map(point => point.x * axis.x + point.y * axis.y);
      if (Math.max(...ap) + 4 <= Math.min(...bp) || Math.max(...bp) + 4 <= Math.min(...ap)) return false;
    }
    return true;
  };
  const bounds = (node, pos) => {
    const width = Math.max(node.displayLabel.length, node.subtitle?.length || 0) * 7.2;
    const height = node.subtitle ? 31 : 14;
    const x = node.x + pos.x, y = node.y + pos.y;
    const left = pos.anchor === 'end' ? -width : pos.anchor === 'middle' ? -width / 2 : 0;
    const angle = (pos.rotation || 0) * Math.PI / 180;
    const corners = [[left, -11], [left + width, -11], [left + width, height - 11], [left, height - 11]]
      .map(([dx, dy]) => ({ x: x + dx * Math.cos(angle) - dy * Math.sin(angle), y: y + dx * Math.sin(angle) + dy * Math.cos(angle) }));
    return { corners, rotated: Boolean(pos.rotation), left: Math.min(...corners.map(point => point.x)), right: Math.max(...corners.map(point => point.x)), top: Math.min(...corners.map(point => point.y)), bottom: Math.max(...corners.map(point => point.y)) };
  };
  for (const node of ordered) {
    if (!node.displayLabel) continue;
    const original = node.labelPosition || below(node.radius + 18);
    const options = [original];
    // Entries around twelve/six o'clock get staggered radial labels, then a
    // deterministic alternate baseline before suppressing a colliding caption.
    if (Number.isFinite(node.angle) && node.role !== 'area') for (const offset of [14, 28, 42]) {
      options.push({ ...original, x: original.x + Math.cos(node.angle) * offset, y: original.y + Math.sin(node.angle) * offset });
    }
    if (['zone', 'art', 'group'].includes(node.role)) {
      options.push({ ...original, y: original.y - 24 }, { ...original, y: original.y + 24 },
        { x: 0, y: -node.radius - 28, anchor: 'middle' }, { x: 0, y: node.radius + 20, anchor: 'middle' });
    }
    if (['entry', 'external'].includes(node.role)) options.push({ ...original, y: original.y + 18 }, { ...original, y: original.y - 18 });
    let choice;
    for (const pos of options) {
      const box = bounds(node, pos);
      if (box.left < 8 || box.right > scene.width - 8 || box.top < 8 || box.bottom > scene.height - 64) continue;
      if (placed.some(other => intersects(box, other))) continue;
      if (scene.nodes.some(other => other.id !== node.id && intersects(box, { left: other.x - other.radius, right: other.x + other.radius, top: other.y - other.radius, bottom: other.y + other.radius }))) continue;
      choice = { pos, box }; break;
    }
    if (!choice && ['zone', 'treeTop'].includes(node.role)) {
      // Zone names are the navigation map, not optional entry captions. Prefer
      // a compact name without a subtitle and keep it even on a dense corpus.
      node.displayLabel = zoneCaption(node.zone, true); node.subtitle = '';
      const navigationGlyphs = scene.nodes.filter(other => ['zone', 'treeTop', 'hub'].includes(other.role) && other.id !== node.id);
      for (const pos of [...options, { x: 0, y: -node.radius - 12, anchor: 'middle' }, { x: 0, y: node.radius + 14, anchor: 'middle' }]) {
        const box = bounds(node, pos);
        if (box.left < 8 || box.right > scene.width - 8 || box.top < 8 || box.bottom > scene.height - 64 || placed.some(other => intersects(box, other))) continue;
        if (navigationGlyphs.some(other => intersects(box, { left: other.x - other.radius, right: other.x + other.radius, top: other.y - other.radius, bottom: other.y + other.radius }))) continue;
        choice = { pos, box }; break;
      }
      choice ||= { pos: original, box: bounds(node, original) };
    }
    if (choice) { node.labelPosition = choice.pos; placed.push(choice.box); }
    else { node.displayLabel = ''; node.subtitle = ''; }
  }
}

function pageOf(items, requested, size, key) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = clamp(Number.isFinite(requested) ? Math.floor(requested) : 0, 0, pages - 1);
  return { items: items.slice(page * size, (page + 1) * size), pagination: { page, pages, count: items.length, key } };
}

function geometry(width, height) {
  const w = Number.isFinite(width) ? Math.max(200, width) : 900;
  const h = Number.isFinite(height) ? Math.max(240, height) : 620;
  const usableHeight = h - 64;
  const radius = Math.max(40, Math.min(w / 2 - clamp(w * .13, 70, 150), usableHeight / 2 - 34));
  return { width: w, height: h, cx: w / 2, cy: usableHeight / 2 + 4, radius, compact: radius < 240 };
}

// Geometry only: a virtual spoke/group never becomes a documentary relation.
function radial(scene, rings, center, { base = 26, per = 3.2, min = 38, spacing = 24 } = {}) {
  const { cx, cy, radius, compact } = scene;
  const weights = rings.map(ring => Math.max(min, base + per * (ring.count ?? ring.members.length)));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const spans = weights.map(weight => weight / total * TAU);
  let start = -Math.PI / 2 - (spans[0] || 0) / 2;
  const groupRadius = Math.min(radius * .48, Math.max(50, radius * (compact ? .31 : .34)));
  const radii = (compact ? [.66, .79, .92] : [.58, .71, .84]).map(value => radius * value);
  scene.nodes.push({ ...center, x: cx, y: cy });
  for (const [position, ring] of rings.entries()) {
    const end = start + spans[position], angle = (start + end) / 2;
    scene.sectors.push({ start, end, id: ring.node.id });
    scene.nodes.push({ ...ring.node, ...at(cx, cy, groupRadius, angle), parentId: center.id,
      labelPosition: radialLabel(angle, compact ? 22 : 28) });
    scene.edges.push(spoke(center.id, ring.node.id));
    const usable = spans[position] - 2 * Math.min(.1, spans[position] * .1);
    const capacities = radii.map(r => Math.max(1, Math.floor(usable * r / spacing)));
    const size = ring.members.length;
    let rows = size <= 3 ? 1 : size <= 8 ? 2 : 3;
    while (rows < 3 && capacities.slice(0, rows).reduce((sum, count) => sum + count, 0) < size) rows++;
    const capacity = capacities.slice(0, rows).reduce((sum, count) => sum + count, 0);
    const counts = capacities.slice(0, rows).map(value => Math.floor(size * value / capacity));
    for (let remaining = size - counts.reduce((sum, count) => sum + count, 0), i = 0; remaining; remaining--, i++) counts[i % rows]++;
    let itemIndex = 0;
    counts.forEach((count, row) => {
      const r = radii[row];
      const step = count > 1 ? Math.min(usable / (count - 1), spacing * 1.2 / r) : 0;
      for (let i = 0; i < count; i++) {
        const item = ring.members[itemIndex++], itemAngle = angle + (i - (count - 1) / 2) * step;
        const labelPosition = radialLabel(itemAngle, 14 + (size <= 3 ? i % 2 * 16 : 0));
        if (size > 1 && size <= 3 && Math.abs(Math.sin(itemAngle)) > .75) {
          const side = Math.cos(itemAngle) < 0 ? -1 : 1;
          labelPosition.anchor = side < 0 ? 'end' : 'start';
          labelPosition.x += side * 8;
        }
        scene.nodes.push({ ...item, ...at(cx, cy, r, itemAngle), parentId: ring.node.id, labelPosition });
        scene.edges.push(spoke(ring.node.id, item.id));
      }
    });
    start = end;
  }
}

function ancestry(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const parents = new Map(nodes.filter(node => byId.has(node.owner)).map(node => [node.id, node.owner]));
  for (const edge of sorted(edges)) if (edge.type === 'contains' && edge.origin === 'structural' && byId.has(edge.from) && byId.has(edge.to) && !parents.has(edge.to)) parents.set(edge.to, edge.from);
  const chain = id => {
    const result = [], seen = new Set([id]);
    while (parents.has(id)) { id = parents.get(id); if (seen.has(id)) break; seen.add(id); result.push(id); }
    return result;
  };
  return { byId, parents, chain };
}

function representative(id, shown, chain) {
  if (shown.has(id)) return id;
  return chain(id).find(parent => shown.has(parent));
}

// Project hidden sections onto their visible documents/HU. Preserve direction,
// relation type and all edge ids; details still read evidence from the index.
function projectRelations(edges, shown, tree) {
  const groups = new Map();
  for (const edge of sorted(edges)) {
    const from = representative(edge.from, shown, tree.chain), to = representative(edge.to, shown, tree.chain);
    if (!from || !to || from === to) continue;
    const key = JSON.stringify([from, to, edge.type, edge.origin, Boolean(edge.inferred)]);
    if (!groups.has(key)) {
      const a = tree.byId.get(from), b = tree.byId.get(to);
      const sameZone = graphZone(a) === graphZone(b);
      groups.set(key, { id: `visual:relation:${key}`, from, to, type: edge.type, origin: edge.origin, inferred: Boolean(edge.inferred),
        sameZone, curveFactor: a.kind === 'area' || b.kind === 'area' ? 1 : sameZone ? .62 : .24, edgeIds: [] });
    }
    groups.get(key).edgeIds.push(edge.id);
  }
  return [...groups.values()];
}

function realNode(item, role = 'entry', extra = {}) {
  return { ...item, role, displayLabel: item.label, radius: item.kind === 'area' ? 3 : item.kind === 'change' ? 7.5 : item.kind === 'component' ? 5.5 : 5, ...extra };
}

function mapScene(index, state, scene, tree, edges) {
  const all = sorted(primaryNodes(index));
  const areas = all.filter(node => node.kind === 'area');
  const rings = GRAPH_ZONES.map(([zone, label]) => {
    const members = all.filter(node => graphZone(node) === zone && node.kind !== 'area');
    return { node: { id: `visual:zone:${zone}`, kind: 'zone', role: 'zone', label, displayLabel: zoneCaption(zone, scene.compact), zone, targetZone: zone,
      count: members.length, radius: scene.compact ? 15 : 20,
      subtitle: scene.compact ? '' : zone === 'archive' && !state.includeArchive ? 'Sin indexar · optativo' : `${members.length} entradas` },
    // Weight the preview rather than letting thousands of historical entries
    // compress every current zone into an unreadable sliver. Counts stay exact.
    count: Math.min(members.length, 30), members: members.slice(0, 30).map(item => realNode(item, 'entry', { displayLabel: !scene.compact && ['change', 'capability'].includes(item.kind) ? item.label : '' })) };
  });
  radial(scene, rings, { id: 'visual:hub', kind: 'hub', role: 'hub', label: (index.rootPath || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || 'S0',
    displayLabel: 'S0', radius: 27, subtitle: 'S0', labelPosition: below(40) });
  const positions = new Map(scene.nodes.map(node => [node.id, node]));
  const outerRadius = scene.radius * .97;
  const areaAngles = areas.slice(0, 30).map((area, position) => {
    const components = edges.filter(edge => edge.type === 'serves-area' && edge.to === area.id).map(edge => positions.get(edge.from)).filter(Boolean);
    return { area, angle: components.length ? Math.atan2(components.reduce((sum, n) => sum + Math.sin(n.angle), 0), components.reduce((sum, n) => sum + Math.cos(n.angle), 0)) : -Math.PI / 2 + position * TAU / Math.max(1, areas.length) };
  }).sort((a, b) => a.angle - b.angle || compare(a.area, b.area));
  const separation = Math.min(TAU / Math.max(1, areaAngles.length), Math.max(.115, 17 / outerRadius));
  for (let pass = 0; pass < 80; pass++) for (let i = 1; i < areaAngles.length; i++) {
    const delta = separation - (areaAngles[i].angle - areaAngles[i - 1].angle);
    if (delta > 0) { areaAngles[i].angle += delta / 2; areaAngles[i - 1].angle -= delta / 2; }
  }
  for (const { area, angle } of areaAngles) {
    const point = at(scene.cx, scene.cy, outerRadius, angle), label = radialLabel(angle, 9);
    const dx = Math.cos(angle), dy = Math.sin(angle), x = point.x + label.x, y = point.y + label.y;
    const horizontalRoom = Math.abs(dx) < .001 ? Infinity : (dx > 0 ? scene.width - 16 - x : x - 16) / Math.abs(dx);
    const verticalRoom = Math.abs(dy) < .001 ? Infinity : (dy > 0 ? scene.height - 80 - y : y - 16) / Math.abs(dy);
    const letters = Math.min(30, Math.floor(Math.min(horizontalRoom, verticalRoom) / 7.2));
    scene.nodes.push(realNode(area, 'area', { ...point, displayLabel: letters >= 3 ? short(area.label, letters) : '',
      labelPosition: { ...label, rotation: angle * 180 / Math.PI + (dx < 0 ? 180 : 0) } }));
  }
  const shown = new Set(scene.nodes.filter(node => !node.id.startsWith('visual:')).map(node => node.id));
  scene.edges.push(...projectRelations(edges, shown, tree));
  scene.list = all.filter(node => shown.has(node.id));
  scene.stats = { entries: all.length, relations: edges.length, inferred: edges.filter(edge => edge.inferred).length };
  if (all.length > shown.size) scene.notice = `Vista general: ${shown.size} de ${all.length} entradas. Abre una zona para recorrerlas todas; el índice conserva sus relaciones.`;
}

function zoneScene(index, state, scene, tree, edges) {
  const all = sorted(primaryNodes(index, state.zone));
  const page = pageOf(all, state.zonePage, 50, 'zonePage');
  scene.pagination = page.pagination;
  const top = { id: `visual:zone:${state.zone}`, kind: 'zone', role: 'treeTop', label: zoneLabel(state.zone), displayLabel: zoneLabel(state.zone), zone: state.zone,
    targetZone: state.zone, count: all.length, subtitle: `${all.length} entradas`, x: scene.cx, y: clamp(scene.height * .2, 90, 150), radius: 25, labelPosition: below(-38) };
  scene.nodes.push(top);
  const allPrimary = new Set(primaryNodes(index).map(node => node.id));
  for (const node of index.nodes) if (node.kind === 'external') allPrimary.add(node.id);
  const projected = projectRelations(edges, allPrimary, tree);
  const shown = new Set(page.items.map(node => node.id));
  const external = new Map();
  for (const edge of projected) {
    const fromInside = shown.has(edge.from), toInside = shown.has(edge.to);
    if (fromInside === toInside) continue;
    const id = fromInside ? edge.to : edge.from;
    if (!external.has(id)) external.set(id, new Set());
    external.get(id).add(fromInside ? edge.from : edge.to);
  }
  const selectedExternal = [...external].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, 24);
  const available = Math.max(100, scene.width - 100), firstY = top.y + 80;
  const bottom = Math.max(firstY, scene.height - 90 - (selectedExternal.length ? 80 : 0));
  const maxRows = Math.max(1, Math.floor((bottom - firstY) / 56) + 1);
  const perRow = Math.max(clamp(Math.floor(available / 116), 3, 7), Math.ceil(page.items.length / maxRows));
  const rows = Math.max(1, Math.ceil(page.items.length / perRow));
  const gap = rows > 1 ? Math.min(96, (bottom - firstY) / (rows - 1)) : 0;
  let offset = 0;
  for (let row = 0; row < rows; row++) {
    const count = Math.ceil((page.items.length - offset) / (rows - row));
    const step = Math.min(140, available / Math.max(1, count));
    for (let col = 0; col < count; col++) {
      const item = page.items[offset++];
      scene.nodes.push(realNode(item, 'entry', { x: scene.cx + (col - (count - 1) / 2) * step + (rows > 1 ? (row % 2 ? step / 4 : -step / 4) : 0),
        y: firstY + row * gap, parentId: top.id, labelPosition: below(16 + col % 2 * 16) }));
      scene.edges.push(spoke(top.id, item.id));
    }
  }
  const positions = new Map(scene.nodes.map(node => [node.id, node]));
  const orderedExternal = selectedExternal.map(([id, connected]) => ({ id, meanX: [...connected].reduce((sum, member) => sum + positions.get(member).x, 0) / connected.size }))
    .sort((a, b) => a.meanX - b.meanX || compare(a, b));
  const arcWidth = Math.min(scene.width / 2 - 50, Math.max(60, orderedExternal.length * 18));
  const extY = Math.min(firstY + (rows - 1) * gap + 78, scene.height - 104);
  orderedExternal.forEach(({ id }, position) => {
    const t = orderedExternal.length < 2 ? 0 : position / (orderedExternal.length - 1) * 2 - 1;
    const item = tree.byId.get(id);
    scene.nodes.push(realNode(item, 'external', { x: scene.cx + t * arcWidth, y: extY + 22 * (1 - t * t),
      displayLabel: orderedExternal.length <= 16 ? item.label : '', labelPosition: below(15 + position % 2 * 15) }));
    shown.add(id);
  });
  scene.edges.push(...projected.filter(edge => shown.has(edge.from) && shown.has(edge.to)));
  scene.list = scene.nodes.filter(node => tree.byId.has(node.id));
  const allIds = new Set(all.map(node => node.id));
  const related = projected.filter(edge => allIds.has(edge.from) || allIds.has(edge.to));
  scene.stats = { entries: all.length, relations: related.reduce((sum, edge) => sum + edge.edgeIds.length, 0), inferred: related.filter(edge => edge.inferred).reduce((sum, edge) => sum + edge.edgeIds.length, 0), connected: external.size };
  if (external.size > selectedExternal.length) scene.notice = `Se muestran ${selectedExternal.length} de ${external.size} conexiones externas. La ficha conserva todas las relaciones y sus fuentes.`;
}

function localScene(index, state, scene, tree, edges) {
  const focus = tree.byId.get(state.focus);
  const allDescendants = sorted(index.nodes.filter(node => node.id !== focus.id && tree.chain(node.id).includes(focus.id)));
  const descendants = allDescendants.filter(node => !hiddenDetail(node));
  const inside = new Set([focus.id, ...allDescendants.map(node => node.id)]);
  const candidates = new Set(descendants.map(node => node.id));
  for (const edge of edges) {
    if (inside.has(edge.from) && tree.byId.has(edge.to) && !hiddenDetail(tree.byId.get(edge.to)) && edge.to !== focus.id) candidates.add(edge.to);
    if (inside.has(edge.to) && tree.byId.has(edge.from) && !hiddenDetail(tree.byId.get(edge.from)) && edge.from !== focus.id) candidates.add(edge.from);
  }
  const partOf = id => tree.chain(id).find(ancestor => tree.parents.get(ancestor) === focus.id) || id;
  const items = [...candidates].map(id => tree.byId.get(id)).sort((a, b) => {
    const aInside = inside.has(a.id), bInside = inside.has(b.id);
    if (aInside !== bInside) return aInside ? -1 : 1;
    const aDirect = tree.parents.get(a.id) === focus.id, bDirect = tree.parents.get(b.id) === focus.id;
    if (aDirect !== bDirect) return aDirect ? -1 : 1;
    const ap = tree.byId.get(partOf(a.id)), bp = tree.byId.get(partOf(b.id));
    return partPriority(ap) - partPriority(bp) || compare(ap, bp) || (a.line || 0) - (b.line || 0) || compare(a, b);
  });
  const page = pageOf(items, state.neighbourPage, 100, 'neighbourPage');
  scene.pagination = page.pagination;
  const selected = new Set(page.items.map(node => node.id));
  const rings = new Map();
  const addGroup = (key, node, priority) => { if (!rings.has(key)) rings.set(key, { node, members: [], priority }); return rings.get(key); };
  for (const item of page.items) {
    if (inside.has(item.id)) {
      const part = tree.byId.get(partOf(item.id));
      if (part.kind !== 'document') {
        const key = `kind:${part.kind}`;
        const label = { requirement: 'Requisitos', task: 'Tareas', decision: 'Decisiones', heading: 'Secciones' }[part.kind] || 'Partes';
        addGroup(key, { id: `visual:parts:${focus.id}:${part.kind}`, kind: 'group', role: 'group', label, displayLabel: label, radius: 16 }, partPriority(part))
          .members.push(realNode(item, 'entry', { displayLabel: scene.compact ? '' : entryLabel(item) }));
        continue;
      }
      const key = `part:${part.id}`;
      const ring = addGroup(key, selected.has(part.id) ? realNode(part, part.kind === 'document' ? 'art' : 'entry', { radius: 17, displayLabel: artifactLabel(part), subtitle: part.path?.split('/').at(-1) || '' })
        : { id: `visual:part:${part.id}`, kind: 'group', role: 'group', label: part.label, displayLabel: artifactLabel(part), targetFocus: part.id, radius: 17 }, partPriority(part));
      if (item.id !== part.id) ring.members.push(realNode(item, 'entry', { displayLabel: scene.compact ? '' : entryLabel(item) }));
    } else {
      const owner = [item.id, ...tree.chain(item.id)].map(id => tree.byId.get(id)).find(node => node.kind === 'change');
      const zone = graphZone(item), isArea = item.kind === 'area';
      const navigationZone = isArea ? 'inventory' : GRAPH_ZONES.some(([id]) => id === zone) ? zone : null;
      const key = owner ? `owner:${owner.id}` : isArea ? 'areas' : `zone:${zone}`;
      const label = owner?.label || (isArea ? 'Áreas' : zoneLabel(zone));
      const ring = addGroup(key, { id: `visual:group:${key}`, kind: 'group', role: 'group', label, displayLabel: label, radius: 16,
        ...(owner ? { targetFocus: owner.id } : navigationZone ? { targetZone: navigationZone, zone: navigationZone } : {}) }, owner ? 1.5 : isArea ? 4.5 : ({ changes: 1.2, specs: 2, inventory: 4, archive: 5, context: 6, template: 7, tools: 8 }[zone] ?? 8));
      ring.members.push(realNode(item, 'entry', { displayLabel: scene.compact ? '' : entryLabel(item) }));
    }
  }
  const ordered = [...rings.values()].sort((a, b) => a.priority - b.priority || compare(a.node, b.node));
  for (const ring of ordered) {
    ring.node.count = ring.members.length;
    ring.node.subtitle = ring.node.role === 'art' ? `${ring.node.subtitle}${ring.members.length ? ` · ${ring.members.length}` : ''}` : ring.members.length ? `${ring.members.length} entradas` : '';
    // Compact neighbourhoods label groups without members; tooltips and list keep all names.
    if (scene.compact && ring.members.length) ring.node.displayLabel = '';
  }
  radial(scene, ordered, realNode(focus, 'center', { radius: 14, labelPosition: below(34), displayLabel: scene.compact ? '' : focus.label }), { base: 30, per: 6, min: 46, spacing: 30 });
  selected.add(focus.id);
  scene.edges.push(...edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)).map(edge => ({ ...edge, edgeIds: [edge.id], curveFactor: .72 })));
  scene.edges.push(...projectRelations(edges.filter(edge => hiddenDetail(tree.byId.get(edge.from)) || hiddenDetail(tree.byId.get(edge.to))), selected, tree));
  scene.list = [focus, ...page.items];
  const related = edges.filter(edge => inside.has(edge.from) || inside.has(edge.to));
  scene.stats = { entries: candidates.size, relations: related.length, inferred: related.filter(edge => edge.inferred).length };
  if (page.pagination.pages > 1) scene.notice = `Vecindario: hasta 100 entradas por página. ${candidates.size} entradas disponibles; el índice conserva todas las relaciones.`;
}

/** Build deterministic, disposable geometry. Never mutate or trim the knowledge index. */
export function buildGraphScene(index, state = {}, width = 900, height = 620) {
  const scene = { ...geometry(width, height), nodes: [], edges: [], sectors: [], list: [], pagination: null, stats: { entries: 0, relations: 0, inferred: 0 } };
  const tree = ancestry(index.nodes, index.edges), edges = sorted(visibleEdges(index, state));
  if (state.level === 'zone' && GRAPH_ZONES.some(([id]) => id === state.zone)) zoneScene(index, state, scene, tree, edges);
  else if (state.level === 'local' && tree.byId.has(state.focus)) localScene(index, state, scene, tree, edges);
  else mapScene(index, state, scene, tree, edges);
  // Backlinks influence ordinary document size without becoming an approval score.
  const inbound = new Map();
  for (const edge of edges) if (edge.origin === 'explicit' && edge.to) inbound.set(edge.to, (inbound.get(edge.to) || 0) + 1);
  for (const node of scene.nodes) if (node.kind === 'document' && !['center', 'art'].includes(node.role)) node.radius = Math.min(8.5, 3.4 + 1.15 * Math.sqrt(inbound.get(node.id) || 0));
  readableLabels(scene);
  return scene;
}
