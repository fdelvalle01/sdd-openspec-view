const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const names = { change: 'HDU', document: 'Documento', capability: 'Capacidad', component: 'Componente', area: 'Área', requirement: 'Requisito', task: 'Tarea', decision: 'Decisión', zone: 'Zona', group: 'Grupo', hub: 'S0', resource: 'Recurso', external: 'Referencia externa', inventory: 'Inventario' };
const brief = (text, length = 34) => text.length > length ? text.slice(0, length - 1) + '…' : text;

// One SVG survives selection, filtering and navigation. Only the positions of
// keyed nodes change; no simulation or animation loop runs after settling.
export function createGraphCanvas({ onSelect, onActivate, mark, camera }) {
  const element = document.createElement('div'); element.className = 'graph-stage';
  const canvas = svg('svg', { class: 'graph-canvas', role: 'group', 'aria-label': 'Relaciones del S0' });
  const drawing = svg('g', { class: 'graph-drawing' });
  const background = svg('g'), lines = svg('g'), dots = svg('g');
  drawing.append(background, lines, dots); canvas.append(drawing);
  const tooltip = document.createElement('div'); tooltip.className = 'graph-tooltip'; tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip');
  element.append(canvas, tooltip);
  const nodeElements = new Map(), edgeElements = new Map();
  let scene, positions = new Map(), visible = new Map(), frame = 0, disposed = false;
  let zoom = Number.isFinite(camera?.zoom) ? clamp(camera.zoom, .5, 2.5) : 1;
  let panX = Number.isFinite(camera?.panX) ? camera.panX : 0, panY = Number.isFinite(camera?.panY) ? camera.panY : 0;
  let selected = null, hovered = null, drag = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function transform() {
    const cx = scene?.cx || 0, cy = scene?.cy || 0;
    drawing.setAttribute('transform', `translate(${panX} ${panY}) translate(${cx} ${cy}) scale(${zoom}) translate(${-cx} ${-cy})`);
    const root = element.closest('.graph-view');
    if (root) { root.dataset.zoom = String(zoom); root.dataset.panX = String(panX); root.dataset.panY = String(panY); }
    element.dispatchEvent(new CustomEvent('graphcamera', { detail: { zoom, panX, panY } }));
  }
  function reset() { zoom = 1; panX = 0; panY = 0; transform(); }
  function setZoom(value, point) {
    const next = clamp(value, .5, 2.5);
    if (point && scene) {
      panX = point.x - scene.cx - (point.x - scene.cx - panX) * next / zoom;
      panY = point.y - scene.cy - (point.y - scene.cy - panY) * next / zoom;
    }
    zoom = next; tooltip.hidden = true; transform();
  }
  function edgeClass(edge) {
    return `graph-edge graph-edge-${edge.origin || 'structural'}${edge.visual ? ' graph-spoke' : ''}${edge.type === 'serves-area' ? ' graph-edge-area' : ''}`;
  }
  function highlight() {
    const active = hovered || selected, adjacent = new Set(active ? [active] : []);
    for (const edge of scene?.edges || []) if (edge.from === active || edge.to === active) { adjacent.add(edge.from); adjacent.add(edge.to); }
    for (const [id, group] of nodeElements) {
      group.classList.toggle('is-hot', id === active);
      group.classList.toggle('is-selected', id === selected);
      group.classList.toggle('is-muted', Boolean(active && !adjacent.has(id)));
    }
    for (const edge of scene?.edges || []) {
      const line = edgeElements.get(edge.id); if (!line) continue;
      const hot = Boolean(active && (edge.from === active || edge.to === active));
      line.classList.toggle('is-hot', hot); line.classList.toggle('is-muted', Boolean(active && !hot));
      line.style.visibility = edge.sameZone && scene.level === 'map' && !hot ? 'hidden' : '';
    }
  }
  function showTooltip(id) {
    const item = visible.get(id), at = positions.get(id); if (!item || !at || !scene) return;
    hovered = id; highlight();
    const title = document.createElement('strong'); title.textContent = `${names[item.kind] || 'Documento'} · ${item.label}`;
    const source = document.createElement('span'); source.textContent = item.path || item.subtitle || '';
    const count = document.createElement('span');
    const relations = scene.edges.filter(edge => !edge.visual && (edge.from === id || edge.to === id));
    count.textContent = `${relations.reduce((sum, edge) => sum + (edge.edgeIds?.length || 1), 0)} relaciones representadas${relations.some(edge => edge.inferred) ? ' · Incluye inferidas' : ''}`;
    tooltip.replaceChildren(title, source, count); tooltip.hidden = false;
    const x = scene.cx + (at.x - scene.cx) * zoom + panX, y = scene.cy + (at.y - scene.cy) * zoom + panY;
    tooltip.style.left = `${clamp(x + 16, 8, Math.max(8, element.clientWidth - 300))}px`;
    tooltip.style.top = `${clamp(y + 18, 8, Math.max(8, element.clientHeight - 110))}px`;
  }
  function clearHover() { hovered = null; tooltip.hidden = true; highlight(); }

  function glyph(item) {
    const group = svg('g', { class: 'graph-node', tabindex: '0', role: 'button', 'data-graph-key': item.id });
    group.append(svg('circle', { class: 'graph-hit', r: 16 }), svg('circle', { class: 'graph-halo', r: 17 }), svg('g', { class: 'graph-shape' }), svg('text', { class: 'graph-node-label' }), svg('text', { class: 'graph-node-subtitle' }));
    group.addEventListener('click', event => { event.stopPropagation(); onSelect(visible.get(item.id), event); });
    group.addEventListener('dblclick', event => { event.stopPropagation(); onActivate(visible.get(item.id)); });
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (event.shiftKey) onActivate(visible.get(item.id)); else onSelect(visible.get(item.id)); }
    });
    group.addEventListener('pointerenter', () => showTooltip(item.id));
    group.addEventListener('pointerleave', clearHover);
    group.addEventListener('focus', () => showTooltip(item.id));
    group.addEventListener('blur', clearHover);
    return group;
  }
  function updateGlyph(group, item) {
    group.setAttribute('class', `graph-node graph-kind-${item.kind} graph-role-${item.role || 'entry'}`);
    const toolKind = /\/skills\//.test(item.path || '') ? 'skill' : /\/commands\//.test(item.path || '') ? 'command' : /\/agents\//.test(item.path || '') ? 'agent' : null;
    if (toolKind && item.kind === 'document') group.classList.add(`graph-tool-${toolKind}`);
    group.classList.toggle('is-complete', item.kind === 'task' && item.done === true);
    group.classList.toggle('is-empty-zone', item.kind === 'zone' && item.count === 0);
    const interactive = item.kind !== 'group' || Boolean(item.targetFocus || item.targetZone || item.zone);
    group.setAttribute('role', interactive ? 'button' : 'img'); group.setAttribute('tabindex', interactive ? '0' : '-1');
    group.setAttribute('aria-label', `${item.label} ${names[item.kind] || 'Documento'}`);
    group.dataset.kind = item.kind;
    const large = ['hub', 'zone', 'treeTop', 'group', 'art'].includes(item.role);
    const radius = item.radius || (large ? 19 : item.role === 'center' ? 13 : 5);
    group.querySelector('.graph-hit').setAttribute('r', Math.max(radius + 7, 14));
    group.querySelector('.graph-halo').setAttribute('r', radius + 5);
    const shape = group.querySelector('.graph-shape');
    const shapeKey = [item.kind, item.role, item.state, item.done, item.path, radius, item.count, item.letter].join('|');
    if (shape.dataset.shape !== shapeKey) {
      shape.dataset.shape = shapeKey;
      let form;
      const attrs = { class: `graph-mark${item.state === 'proposed' ? ' is-proposed' : ''}` };
      if (large) form = svg('circle', { ...attrs, r: radius });
      else if (['change', 'decision'].includes(item.kind)) form = svg('path', { ...attrs, d: `M0 ${-radius}L${radius} 0L0 ${radius}L${-radius} 0Z` });
      else if (['requirement', 'capability', 'task'].includes(item.kind)) form = svg('rect', { ...attrs, x: -radius, y: -radius, width: radius * 2, height: radius * 2, rx: item.kind === 'task' ? 2 : 0 });
      else if (item.kind === 'component' || item.kind === 'area') form = svg('circle', { ...attrs, r: radius });
      else if (/\/(?:skills|commands|agents)\//.test(item.path || '')) form = svg('path', { ...attrs, d: `M0 ${-radius - 1}L${radius} ${radius * .7}L${-radius} ${radius * .7}Z` });
      else if (item.kind === 'inventory' || /(?:\.json|\.ya?ml)$/.test(item.path || '')) form = svg('path', { ...attrs, d: `M0 ${-radius}L${radius * .87} ${-radius / 2}L${radius * .87} ${radius / 2}L0 ${radius}L${-radius * .87} ${radius / 2}L${-radius * .87} ${-radius / 2}Z` });
      else form = svg('circle', { ...attrs, r: radius });
      shape.replaceChildren(form);
      if (item.kind === 'task' && item.done) shape.append(svg('path', { class: 'graph-task-check', d: `M${-radius * .55} 0L${-radius * .1} ${radius * .45}L${radius * .6} ${-radius * .45}`, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
      if (item.role === 'hub') {
        if (mark) { const symbol = mark(); symbol.setAttribute('x', '-11'); symbol.setAttribute('y', '-11'); symbol.setAttribute('width', '22'); symbol.setAttribute('height', '22'); symbol.setAttribute('class', 'graph-brand-mark'); shape.append(symbol); }
        else shape.append(svg('text', { class: 'graph-zone-count', 'text-anchor': 'middle', y: 4 }, 'S0'));
      } else if (large) {
        const letter = item.letter || (item.role === 'art' ? /proposal\.md$/.test(item.path || '') ? 'P' : /tasks\.md$/.test(item.path || '') ? 'T' : /design\.md$/.test(item.path || '') ? 'D' : /revision\.md$/.test(item.path || '') ? 'R' : 'S' : String(item.count ?? ''));
        shape.append(svg('text', { class: 'graph-zone-count', 'text-anchor': 'middle', y: 4 }, letter));
      }
    }
    const label = group.querySelector('.graph-node-label'), sub = group.querySelector('.graph-node-subtitle');
    const pos = item.labelPosition || { x: 0, y: radius + 18, anchor: 'middle' };
    const labelText = item.displayLabel === undefined ? item.label : item.displayLabel;
    label.textContent = brief(labelText || '', item.kind === 'area' ? 30 : 36);
    sub.textContent = labelText ? item.subtitle || '' : '';
    for (const [entry, dy] of [[label, 0], [sub, 17]]) {
      entry.setAttribute('x', pos.x); entry.setAttribute('y', pos.y + dy); entry.setAttribute('text-anchor', pos.anchor || 'middle');
      if (pos.rotation) entry.setAttribute('transform', `rotate(${pos.rotation} ${pos.x} ${pos.y})`); else entry.removeAttribute('transform');
    }
  }

  function pathFor(edge) {
    const a = positions.get(edge.from), b = positions.get(edge.to); if (!a || !b) return '';
    if (edge.visual || edge.type === 'serves-area' || edge.curveFactor === 1) return `M${a.x} ${a.y}L${b.x} ${b.y}`;
    const k = edge.curveFactor ?? edge.k ?? .24;
    const x = scene.cx + ((a.x + b.x) / 2 - scene.cx) * k, y = scene.cy + ((a.y + b.y) / 2 - scene.cy) * k;
    return `M${a.x} ${a.y}Q${x} ${y} ${b.x} ${b.y}`;
  }
  function paint() {
    for (const [id, at] of positions) {
      const group = nodeElements.get(id); if (!group) continue;
      group.setAttribute('transform', `translate(${at.x} ${at.y})`); group.style.setProperty('--graph-layout-opacity', String(at.opacity ?? 1));
      group.style.pointerEvents = at.opacity < .25 ? 'none' : '';
    }
    for (const edge of scene.edges) { const line = edgeElements.get(edge.id); if (line) line.setAttribute('d', pathFor(edge)); }
  }
  function update(next, { selected: nextSelected, animate = true, resetCamera = false } = {}) {
    if (disposed) return;
    cancelAnimationFrame(frame); frame = 0; hovered = null; tooltip.hidden = true;
    const previous = positions, oldVisible = visible;
    scene = next; selected = nextSelected || null; visible = new Map(next.nodes.map(item => [item.id, item]));
    canvas.setAttribute('viewBox', `0 0 ${Math.max(1, element.clientWidth)} ${Math.max(1, element.clientHeight)}`);
    background.replaceChildren();
    if (next.radius > 0 && next.level !== 'zone') {
      background.append(svg('circle', { cx: next.cx, cy: next.cy, r: next.radius, class: 'graph-orbit' }), svg('circle', { cx: next.cx, cy: next.cy, r: next.radius * .46, class: 'graph-orbit' }));
      for (const sector of next.sectors || []) background.append(svg('path', { class: 'graph-sector', d: `M${next.cx} ${next.cy}L${next.cx + Math.cos(sector.start) * next.radius} ${next.cy + Math.sin(sector.start) * next.radius}` }));
    }
    for (const item of next.nodes) {
      let group = nodeElements.get(item.id);
      if (!group) { group = glyph(item); nodeElements.set(item.id, group); dots.append(group); }
      updateGlyph(group, item);
    }
    const ids = new Set(next.edges.map(edge => edge.id));
    for (const [id, line] of edgeElements) if (!ids.has(id)) { line.remove(); edgeElements.delete(id); }
    for (const edge of next.edges) {
      let line = edgeElements.get(edge.id);
      if (!line) { line = svg('path'); edgeElements.set(edge.id, line); lines.append(line); }
      line.setAttribute('class', edgeClass(edge));
    }
    const targets = new Map(next.nodes.map(item => [item.id, { x: item.x, y: item.y, opacity: 1 }]));
    const from = new Map(), to = new Map(targets);
    for (const item of next.nodes) from.set(item.id, previous.get(item.id) || { ...(previous.get(item.parentId) || targets.get(item.parentId) || { x: next.cx, y: next.cy }), opacity: previous.size ? 0 : 1 });
    for (const [id, position] of previous) if (!targets.has(id)) {
      from.set(id, position); const old = oldVisible.get(id);
      to.set(id, { ...(targets.get(old?.parentId) || { x: next.cx, y: next.cy }), opacity: 0 });
    }
    const finish = () => {
      positions = targets;
      for (const [id, group] of nodeElements) if (!visible.has(id)) { group.remove(); nodeElements.delete(id); }
      paint(); frame = 0; element.dataset.animating = 'false';
    };
    if (resetCamera) reset(); else transform();
    highlight();
    const changes = [...to].some(([id, end]) => { const start = from.get(id); return !start || Math.abs(start.x - end.x) > .5 || Math.abs(start.y - end.y) > .5 || start.opacity !== end.opacity; });
    if (!animate || reducedMotion.matches || !previous.size || !changes) { finish(); return; }
    element.dataset.animating = 'true';
    const started = performance.now();
    const tick = now => {
      if (disposed || !element.isConnected) { frame = 0; return; }
      const progress = clamp((now - started) / 520, 0, 1), t = ease(progress);
      positions = new Map([...to].map(([id, end]) => { const start = from.get(id) || end; return [id, { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, opacity: (start.opacity ?? 1) + ((end.opacity ?? 1) - (start.opacity ?? 1)) * t }]; }));
      paint();
      if (progress < 1) frame = requestAnimationFrame(tick); else finish();
    };
    frame = requestAnimationFrame(tick);
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.target.closest('.graph-node') || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, panX, panY, moved: false }; canvas.setPointerCapture(event.pointerId); clearHover();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { panX = drag.panX + dx; panY = drag.panY + dy; transform(); }
  });
  canvas.addEventListener('pointerup', () => { if (drag && !drag.moved) onSelect(null); drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault(); const box = canvas.getBoundingClientRect();
    setZoom(zoom * Math.exp(-event.deltaY * .0015), { x: event.clientX - box.left, y: event.clientY - box.top });
  }, { passive: false });
  return { element, update, reset, zoomBy: amount => setZoom(zoom + amount), getZoom: () => zoom,
    dispose: () => { disposed = true; cancelAnimationFrame(frame); frame = 0; positions.clear(); nodeElements.clear(); edgeElements.clear(); } };
}
